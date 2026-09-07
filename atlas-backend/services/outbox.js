// Atlas outbox: the push channel back to clients. Services POST /deliver
// with either a request result ({userId, sessionId, reqId, ...}) or a
// sync.update fanout; the outbox pushes it to the matching user WebSocket(s).
// Delivery is best-effort — /deliver always answers 200 {}.

import http from 'node:http'
import { WebSocketServer } from 'ws'
import { pool } from '../lib/db.js'
import { limiter, ipOf } from '../lib/ratelimit.js'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Rate limits: same posture as the inbox. /deliver is exempt — it is internal
// (unreachable through Caddy) and legitimately high-volume.
const allowConn = limiter({ windowMs: 60_000, max: 30 })   // new sockets / IP / min
const allowHello = limiter({ windowMs: 60_000, max: 30 })  // token lookups / IP / min
const allowHttp = limiter({ windowMs: 60_000, max: 60 })   // plain HTTP / IP / min
const MAX_CONNS_PER_IP = 10
const liveConns = new Map() // ip -> currently open sockets

// userId -> Set of ws conns; each conn is tagged with its sessionId.
const registry = new Map()

function register(userId, ws) {
  let set = registry.get(userId)
  if (!set) registry.set(userId, (set = new Set()))
  set.add(ws)
}

function unregister(userId, ws) {
  const set = registry.get(userId)
  if (!set) return
  set.delete(ws)
  if (set.size === 0) registry.delete(userId)
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

export function deliver(msg) {
  const conns = registry.get(msg.userId)
  if (!conns || conns.size === 0) return

  if (msg.type === 'sync.update') {
    // Fan out to every socket of the user except the one that caused it.
    const out = { type: 'sync.update', key: msg.data && msg.data.key, value: msg.data && msg.data.value }
    for (const ws of conns)
      if (!msg.excludeSession || ws.sessionId !== msg.excludeSession) send(ws, out)
    return
  }

  // Request result: prefer the exact session; fall back to all of the
  // user's sockets (the client dedups by reqId).
  const out = { reqId: msg.reqId, ok: msg.ok, data: msg.data, error: msg.error }
  const matches = [...conns].filter(ws => ws.sessionId === msg.sessionId)
  for (const ws of matches.length ? matches : conns) send(ws, out)
}

// ---- session revocation -----------------------------------------------------
// A socket is authenticated once, at hello, and then trusted for its whole life.
// auth.logout() DELETEs the session row, so after a logout the token behind a
// live socket resolves to nothing - but nothing here ever asked again, and the
// socket kept receiving that user's request results and sync.update fanouts.
// Pass 11 measured that gap; this closes it.
//
// Re-validation rather than a logout broadcast from auth.js, deliberately: the
// same sweep also catches plain expiry and any out-of-band session deletion,
// needs no new endpoint and no coupling between the two services, and cannot
// miss an event because the outbox happened to be restarting. The cost is a
// window - a revoked socket lives until the next sweep - which the interval
// below sets.
//
// Fails OPEN on a query error: a database blip must not disconnect every
// logged-in user. A revoked socket surviving one more sweep is the cheaper
// failure of the two.
export async function revokeSweep() {
  const live = []
  for (const set of registry.values()) for (const ws of set) if (ws.token) live.push(ws)
  if (live.length === 0) return 0

  let rows
  try {
    const r = await pool.query(
      `SELECT token, user_id FROM auth.sessions WHERE token = ANY($1) AND expires_at > now()`,
      [[...new Set(live.map(ws => ws.token))]],
    )
    rows = r.rows
  } catch (e) {
    console.error('revoke sweep:', e.message)
    return 0
  }

  // token -> user_id, for the sessions that are still real.
  const valid = new Map(rows.map(r => [r.token, r.user_id]))
  let dropped = 0
  for (const ws of live) {
    // Both halves matter: the token must still exist AND still belong to the
    // user this socket was registered under, so a recycled token cannot leave a
    // socket wired to the previous owner's fanout.
    if (valid.get(ws.token) === ws.userId) continue
    unregister(ws.userId, ws)
    ws.userId = null
    ws.token = null
    try { ws.close(4001, 'session revoked') } catch {}
    dropped++
  }
  return dropped
}

async function lookupSession(token) {
  const r = await pool.query(
    `SELECT user_id FROM auth.sessions WHERE token = $1 AND expires_at > now()`,
    [token],
  )
  return r.rows[0] || null
}

export function httpHandler(req, res) {
  if (req.method === 'GET' && req.url === '/') {
    if (!allowHttp(ipOf(req))) {
      res.writeHead(429).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('atlas-outbox')
    return
  }
  if (req.method === 'POST' && req.url === '/deliver') {
    // Decode once, not per chunk — see the note in lib/runner.js serveHttp.
    // Delivery payloads echo the same user text a plugin save carried.
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      try {
        deliver(JSON.parse(body || '{}'))
      } catch (e) {
        console.error('deliver:', e.message)
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
    return
  }
  res.writeHead(404).end()
}

const server = http.createServer(httpHandler)

// Clients only ever send the tiny hello frame on this channel.
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 })

export function onConnection(ws, req) {
  const ip = ipOf(req)
  const live = liveConns.get(ip) || 0
  if (!allowConn(ip) || live >= MAX_CONNS_PER_IP) {
    ws.close(1013, 'rate limited')
    return
  }
  liveConns.set(ip, live + 1)
  ws.on('close', () => {
    const n = (liveConns.get(ip) || 1) - 1
    n > 0 ? liveConns.set(ip, n) : liveConns.delete(ip)
  })

  ws.isAlive = true
  ws.frames = 0
  ws.on('pong', () => (ws.isAlive = true))

  ws.on('message', async raw => {
    // Only the hello handshake is meaningful; this is a push-only channel.
    if (ws.userId) return
    // A connection that hasn't authenticated gets a handful of frames, not a firehose.
    if (++ws.frames > 20) {
      ws.terminate()
      return
    }
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!msg || msg.type !== 'hello') return
    if (!allowHello(ip)) {
      send(ws, { type: 'hello', ok: false, error: 'rate limited' })
      return
    }
    let row = null
    try {
      row = await lookupSession(msg.token)
    } catch (e) {
      console.error('hello session lookup:', e.message)
    }
    if (!row) {
      send(ws, { type: 'hello', ok: false, error: 'Invalid or expired session' })
      setTimeout(() => ws.close(), 100)
      return
    }
    ws.userId = row.user_id
    ws.sessionId = msg.sessionId
    // Retained so revokeSweep() can re-ask whether this session is still real.
    // The socket authenticated once, at hello; without this it would keep
    // receiving pushes for as long as it stayed open, logout or not.
    ws.token = msg.token
    register(ws.userId, ws)
    send(ws, { type: 'hello', ok: true })
  })

  const cleanup = () => {
    if (ws.userId) unregister(ws.userId, ws)
  }
  ws.on('close', cleanup)
  ws.on('error', e => {
    console.error('ws error:', e.message)
    cleanup()
  })
}

wss.on('connection', onConnection)

// Bootstrap only when run as the entrypoint (`node services/outbox.js`, per
// docker-compose). At module scope, server.listen(80) and the heartbeat timer
// made this file unimportable: the listen fails or steals a port, and the
// interval - unref'd nowhere - keeps any importing process alive forever.
// Behind the guard, importing this file starts nothing. Same shape as inbox.js.
const entrypoint = (() => {
  try { return pathToFileURL(realpathSync(path.resolve(process.argv[1] || '.'))).href }
  catch { return pathToFileURL(path.resolve(process.argv[1] || '.')).href }
})()
if (import.meta.url === entrypoint) {
  // Heartbeat: terminate connections that missed a ping round.
  setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate()
        continue
      }
      ws.isAlive = false
      ws.ping()
    }
  }, 30000)

  // Revocation window. 60s is a judgement call: short enough that a logout is
  // not meaningfully durable, long enough that the query is one small indexed
  // lookup per minute per outbox rather than per push.
  setInterval(() => { revokeSweep().catch(e => console.error('revoke sweep:', e.message)) }, 60_000)

  server.listen(80, () => console.log('outbox up on :80'))
}
