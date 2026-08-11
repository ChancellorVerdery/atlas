// Atlas outbox: the push channel back to clients. Services POST /deliver
// with either a request result ({userId, sessionId, reqId, ...}) or a
// sync.update fanout; the outbox pushes it to the matching user WebSocket(s).
// Delivery is best-effort — /deliver always answers 200 {}.

import http from 'node:http'
import { WebSocketServer } from 'ws'
import { pool } from '../lib/db.js'
import { limiter, ipOf } from '../lib/ratelimit.js'

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

function deliver(msg) {
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

async function lookupSession(token) {
  const r = await pool.query(
    `SELECT user_id FROM sessions WHERE token = $1 AND expires_at > now()`,
    [token],
  )
  return r.rows[0] || null
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    if (!allowHttp(ipOf(req))) {
      res.writeHead(429).end()
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('atlas-outbox')
    return
  }
  if (req.method === 'POST' && req.url === '/deliver') {
    let body = ''
    req.on('data', c => (body += c))
    req.on('end', () => {
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
})

// Clients only ever send the tiny hello frame on this channel.
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 })

wss.on('connection', (ws, req) => {
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
})

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

server.listen(80, () => console.log('outbox up on :80'))
