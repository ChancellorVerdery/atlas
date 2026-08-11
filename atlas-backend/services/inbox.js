// Atlas inbox: the single WebSocket gateway. Clients connect, say hello
// (optionally with a session token), then send {reqId, code, payload}
// envelopes. The inbox validates the code against a hard registry, routes it
// to the owning service over HTTP, and — for everything except auth.* —
// lets the service deliver its result back through the outbox.

import http from 'node:http'
import { WebSocketServer } from 'ws'
import { pool } from '../lib/db.js'
import { limiter, ipOf } from '../lib/ratelimit.js'

// Rate limits — the inbox is the app's only public request surface, so every
// class of abuse is throttled here: socket churn, token guessing, credential
// stuffing, message floods, plain-HTTP hammering. Ceilings are far above real
// client behavior (2 sockets, 400ms-debounced pushes, backoff reconnects).
const allowConn = limiter({ windowMs: 60_000, max: 30 })   // new sockets / IP / min
const allowHello = limiter({ windowMs: 60_000, max: 30 })  // token lookups / IP / min
const allowAuth = limiter({ windowMs: 600_000, max: 10 })  // login+signup / IP / 10 min
const allowMsg = limiter({ windowMs: 10_000, max: 60 })    // messages / connection / 10s
const allowHttp = limiter({ windowMs: 60_000, max: 60 })   // plain HTTP / IP / min
const MAX_CONNS_PER_IP = 10
const liveConns = new Map() // ip -> currently open sockets
let connSeq = 0

// The complete code registry; anything not listed here is rejected.
const REGISTRY = {
  'auth.signup': 'atlas-auth',
  'auth.login': 'atlas-auth',
  'auth.logout': 'atlas-auth',
  'auth.whoami': 'atlas-auth',
  'sync.pull.all': 'atlas-profile',
  'sync.import': 'atlas-profile',
  'page.get': 'atlas-profile',
  'page.save': 'atlas-profile',
  'google.config': 'atlas-google',
  'google.auth.exchange': 'atlas-google',
  'google.auth.status': 'atlas-google',
  'google.auth.disconnect': 'atlas-google',
  'google.api': 'atlas-google',
}
for (const p of ['gym', 'course', 'finance', 'calendar', 'canvas', 'email', 'graph', 'ladder', 'sleep', 'work']) {
  REGISTRY[`${p}.get`] = `atlas-${p}`
  REGISTRY[`${p}.save`] = `atlas-${p}`
}

// Codes an unauthenticated connection may send.
const PUBLIC = new Set(['auth.signup', 'auth.login'])

async function lookupSession(token) {
  const r = await pool.query(
    `SELECT u.id AS user_id, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  )
  return r.rows[0] || null
}

const server = http.createServer((req, res) => {
  if (!allowHttp(ipOf(req))) {
    res.writeHead(429).end()
    return
  }
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('atlas-inbox')
    return
  }
  res.writeHead(404).end()
})

// maxPayload: sync.import carries a whole exported data map; 8 MiB bounds it
// without letting a hostile frame buffer the default 100 MiB.
const wss = new WebSocketServer({ server, maxPayload: 8 * 1024 * 1024 })

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
  const connId = ++connSeq
  ws.isAlive = true
  ws.on('pong', () => (ws.isAlive = true))

  // Per-connection auth state, filled in by hello / login / signup.
  const conn = { hello: false, userId: null, email: null, token: null, sessionId: null, strikes: 0 }

  const send = msg => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }
  const reject = (reqId, error) => {
    console.log(`inbox reject${reqId != null ? ` [${reqId}]` : ''}: ${error}`)
    send(reqId != null ? { reqId, ok: false, error } : { ok: false, error })
  }

  ws.on('message', async raw => {
    // Flood check before any parsing. Over the limit: reject (the client
    // re-queues and retries with backoff); persistently over: drop the socket.
    if (!allowMsg(connId)) {
      reject(null, 'rate limited')
      if (++conn.strikes > 60) ws.close(1008, 'rate limited')
      return
    }
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      reject(null, 'malformed JSON')
      return
    }
    if (!msg || typeof msg !== 'object') {
      reject(null, 'malformed message')
      return
    }

    // Hello is accepted at ANY time, not only as the first message: the client's
    // connect() is documented as re-hello-able (it re-hellos on the same open
    // socket right after login with the fresh token). Re-validate and re-ack
    // idempotently; a failed re-validation leaves any existing auth untouched
    // (matching first-hello behavior, where auth simply stays null).
    if (msg.type === 'hello') {
      conn.hello = true
      conn.sessionId = msg.sessionId
      if (msg.token) {
        // Token hellos hit the sessions table — throttle guessing per IP.
        if (!allowHello(ip)) {
          send({ type: 'hello', ok: false, error: 'rate limited' })
          return
        }
        try {
          const row = await lookupSession(msg.token)
          if (row) {
            conn.userId = row.user_id
            conn.email = row.email
            conn.token = msg.token
            send({ type: 'hello', ok: true, userId: conn.userId, email: conn.email })
          } else {
            send({ type: 'hello', ok: false, error: 'Invalid or expired session' })
          }
        } catch (e) {
          console.error('hello session lookup:', e.message)
          send({ type: 'hello', ok: false, error: 'Invalid or expired session' })
        }
      } else {
        send({ type: 'hello', ok: true })
      }
      return
    }

    // A brand-new connection must still open with the hello handshake.
    if (!conn.hello) {
      reject(msg.reqId, 'expected hello as first message')
      return
    }

    const { reqId, code, payload } = msg
    if (typeof code !== 'string') {
      reject(reqId, 'missing code')
      return
    }
    const svc = REGISTRY[code]
    if (!svc) {
      reject(reqId, `invalid code: ${code}`)
      return
    }
    if (payload !== undefined && (payload === null || typeof payload !== 'object')) {
      reject(reqId, 'payload must be an object')
      return
    }
    if (!conn.userId && !PUBLIC.has(code)) {
      reject(reqId, 'not authenticated')
      return
    }
    // Credential stuffing / signup floods: the unauthenticated auth codes are
    // the only brute-forceable surface, so they get the harshest window.
    if (PUBLIC.has(code) && !allowAuth(ip)) {
      reject(reqId, 'rate limited — try again later')
      return
    }

    if (svc === 'atlas-auth') {
      // Auth replies synchronously on this socket, not via the outbox.
      try {
        const res = await fetch('http://atlas-auth/handle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reqId, code, payload, token: conn.token, userId: conn.userId }),
          signal: AbortSignal.timeout(30000),
        })
        const body = await res.json()
        if (body.ok && body.data && body.data.token) {
          // Fresh signup/login: authenticate this socket immediately.
          conn.token = body.data.token
          conn.userId = body.data.userId
          conn.email = body.data.email
        }
        send({ reqId, ...body })
      } catch (e) {
        console.error(`auth relay ${code}:`, e.message)
        send({ reqId, ok: false, error: 'service unavailable: atlas-auth' })
      }
      return
    }

    // Plugin/profile codes: fire-and-forget; the service answers via outbox.
    try {
      const res = await fetch(`http://${svc}/handle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: conn.userId, sessionId: conn.sessionId, reqId, code, payload }),
        signal: AbortSignal.timeout(30000),
      })
      if (!res.ok) throw new Error(`${svc} responded ${res.status}`)
    } catch (e) {
      console.error(`route ${code} -> ${svc}:`, e.message)
      send({ reqId, ok: false, error: `service unavailable: ${svc.replace('atlas-', '')}` })
    }
  })
})

// Heartbeat: terminate connections that missed a ping round. Also keeps idle
// sockets alive through Cloudflare's ~100s idle timeout (the outbox already
// had this; the inbox needed it once the tunnel replaced the direct door).
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

server.listen(80, () => console.log('inbox up on :80'))
