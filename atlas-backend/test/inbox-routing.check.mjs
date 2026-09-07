// The inbox's handshake, authorization and routing rules, executed — not read.
//
// THE BUG THIS EXISTS FOR (Pass 10). auth.logout deletes the session row, and
// the inbox relayed the reply back to the client without touching the socket's
// own auth state. But plugin routing trusts conn.userId and NEVER re-reads
// auth.sessions — the token is checked once, at hello. So the socket that just
// logged out kept full read/write access to the account for its entire
// lifetime: logout revoked the token everywhere except the one place it was
// actually being used.
//
// Reproduced before it was fixed, through the real onConnection:
//
//     3. auth.logout  -> {"reqId":2,"ok":true,"data":{}} | session row gone: true
//     4. finance.save AFTER LOGOUT -> routed to the plugin? true   <-- BUG
//
// The browser does reload and drop the socket after logout (main.js
// atlasLogout), which is why this never showed in normal use. That is the
// client choosing to close; a stolen token driving its own socket does not, and
// logout is the victim's only remedy. Arm 1 is that sequence.
//
// These arms import the real services/inbox.js. That is possible as of Pass 10,
// which put server.listen(80) and the heartbeat interval behind an entrypoint
// guard — before that, importing this file bound a port and left a timer
// holding the process open forever.
//
// Run: node test/inbox-routing.check.mjs
import { strictEqual, deepStrictEqual, ok } from 'node:assert'
import { EventEmitter } from 'node:events'
import { pool } from '../lib/db.js'
import { onConnection } from '../services/inbox.js'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---- model of auth.sessions -------------------------------------------------
// Deliberately loud: any SQL this does not recognise is a hard throw, never a
// silent {rows:[]}. A future edit to inbox.js that queried something else would
// otherwise route around the model and leave every arm green.
let sessions = new Map()
pool.query = async (q, params = []) => {
  const s = String(q).replace(/\s+/g, ' ').trim()
  if (s.startsWith('SELECT u.id AS user_id, u.email')) {
    const row = sessions.get(params[0])
    return { rows: row ? [{ user_id: row.userId, email: row.email }] : [] }
  }
  throw new Error('unmodelled SQL: ' + s)
}

// ---- harness ----------------------------------------------------------------
// Each arm gets its own IP. The inbox's limiters are module-level and keyed by
// IP, so sharing one across arms would let an early arm's socket churn or auth
// attempts throttle a later one and produce failures that have nothing to do
// with the behaviour under test.
let ipSeq = 0
function conn({ route } = {}) {
  const sent = [], routed = [], closed = []
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body)
    routed.push({ url, body })
    if (route) return route(url, body)
    if (url === 'http://atlas-auth/handle') {
      if (body.code === 'auth.logout') {
        if (body.token) sessions.delete(body.token)
        return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) }
      }
      throw new Error('unstubbed auth code: ' + body.code)
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }
  const ws = new EventEmitter()
  ws.OPEN = 1
  ws.readyState = 1
  ws.send = m => sent.push(JSON.parse(m))
  ws.close = (code, reason) => closed.push({ code, reason })
  ws.terminate = () => closed.push({ code: 'terminate' })
  const ip = `10.0.0.${++ipSeq}`
  onConnection(ws, { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } })
  // The handler is async (session lookup, service relay); a message is only
  // fully processed after its microtasks and the awaited fetch have drained.
  const msg = async o => {
    ws.emit('message', typeof o === 'string' ? o : JSON.stringify(o))
    await new Promise(r => setTimeout(r, 25))
  }
  return { ws, msg, sent, routed, closed, ip, last: () => sent.at(-1) }
}

const seed = (token, userId, email = `${userId}@example.com`) => {
  sessions.set(token, { userId, email })
  return token
}

// ---- arms -------------------------------------------------------------------

// Arm 1 IS the bug. Its shape matters: it asserts the plugin call after logout
// is NOT routed. A test that only checked that logout replies ok:true passes
// against the broken code, because the broken code did reply ok:true.
await check('a revoked session cannot keep using its socket', async () => {
  seed('T1', 'u1')
  const c = conn()
  await c.msg({ type: 'hello', token: 'T1', sessionId: 's1' })
  strictEqual(c.last().ok, true, 'hello should authenticate')

  await c.msg({ reqId: 1, code: 'finance.save', payload: { a: 1 } })
  strictEqual(c.routed.at(-1).url, 'http://atlas-finance/handle', 'authenticated write should route')

  await c.msg({ reqId: 2, code: 'auth.logout', payload: {} })
  strictEqual(c.last().ok, true, 'logout should succeed')
  strictEqual(sessions.has('T1'), false, 'the session row should be gone')

  const before = c.routed.length
  await c.msg({ reqId: 3, code: 'finance.save', payload: { a: 2 } })
  strictEqual(c.routed.length, before, 'a logged-out socket must not reach the plugin')
  deepStrictEqual(c.last(), { reqId: 3, ok: false, error: 'not authenticated' })
})

// The complement. Clearing too much — conn.hello — would strand the socket:
// it could never log in again without reconnecting, and the client re-uses it.
await check('after logout the same socket can log in again', async () => {
  seed('T2', 'u2')
  const c = conn({
    route: async (url, body) => {
      if (body.code === 'auth.logout') { sessions.delete(body.token); return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) } }
      if (body.code === 'auth.login') return { ok: true, status: 200, json: async () => ({ ok: true, data: { token: 'T2b', userId: 'u2', email: 'u2@example.com' } }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })
  await c.msg({ type: 'hello', token: 'T2', sessionId: 's2' })
  await c.msg({ reqId: 1, code: 'auth.logout', payload: {} })
  await c.msg({ reqId: 2, code: 'auth.login', payload: { email: 'u2@example.com', password: 'x' } })
  strictEqual(c.last().ok, true, 'login should be accepted on the same socket')
  await c.msg({ reqId: 3, code: 'work.get', payload: {} })
  strictEqual(c.routed.at(-1).url, 'http://atlas-work/handle', 'the re-logged-in socket should route again')
  strictEqual(c.routed.at(-1).body.userId, 'u2')
})

// A failed logout must NOT drop auth — that would be a trivial way to log
// someone out of a working session by making the auth service answer ok:false.
await check('a failed logout leaves the socket authenticated', async () => {
  seed('T3', 'u3')
  const c = conn({
    route: async (url, body) =>
      body.code === 'auth.logout'
        ? { ok: true, status: 200, json: async () => ({ ok: false, error: 'nope' }) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) },
  })
  await c.msg({ type: 'hello', token: 'T3', sessionId: 's3' })
  await c.msg({ reqId: 1, code: 'auth.logout', payload: {} })
  strictEqual(c.last().ok, false)
  await c.msg({ reqId: 2, code: 'gym.get', payload: {} })
  strictEqual(c.routed.at(-1).url, 'http://atlas-gym/handle', 'auth should survive a failed logout')
})

await check('a plugin code before hello is refused', async () => {
  const c = conn()
  await c.msg({ reqId: 1, code: 'work.get', payload: {} })
  deepStrictEqual(c.last(), { reqId: 1, ok: false, error: 'expected hello as first message' })
  strictEqual(c.routed.length, 0)
})

await check('a bare hello does not authenticate', async () => {
  const c = conn()
  await c.msg({ type: 'hello', sessionId: 's4' })
  deepStrictEqual(c.last(), { type: 'hello', ok: true })
  await c.msg({ reqId: 1, code: 'work.get', payload: {} })
  deepStrictEqual(c.last(), { reqId: 1, ok: false, error: 'not authenticated' })
  strictEqual(c.routed.length, 0, 'an unauthenticated plugin call must not leave the box')
})

await check('signup is public, and its token authenticates the socket', async () => {
  const c = conn({
    route: async (url, body) =>
      body.code === 'auth.signup'
        ? { ok: true, status: 200, json: async () => ({ ok: true, data: { token: 'T5', userId: 'u5', email: 'u5@example.com' } }) }
        : { ok: true, status: 200, json: async () => ({ ok: true }) },
  })
  await c.msg({ type: 'hello', sessionId: 's5' })
  await c.msg({ reqId: 1, code: 'auth.signup', payload: { email: 'u5@example.com', password: 'x' } })
  strictEqual(c.last().ok, true)
  await c.msg({ reqId: 2, code: 'sleep.save', payload: {} })
  strictEqual(c.routed.at(-1).body.userId, 'u5', 'the socket should now carry the new user')
})

await check('an unregistered code is refused and never routed', async () => {
  seed('T6', 'u6')
  const c = conn()
  await c.msg({ type: 'hello', token: 'T6', sessionId: 's6' })
  const before = c.routed.length
  await c.msg({ reqId: 1, code: 'admin.dropTables', payload: {} })
  deepStrictEqual(c.last(), { reqId: 1, ok: false, error: 'invalid code: admin.dropTables' })
  strictEqual(c.routed.length, before)
  // A non-string code must not be able to index the registry either.
  await c.msg({ reqId: 2, code: { toString: () => 'work.get' }, payload: {} })
  deepStrictEqual(c.last(), { reqId: 2, ok: false, error: 'missing code' })
  strictEqual(c.routed.length, before)
})

await check('a non-object payload is refused, undefined is allowed', async () => {
  seed('T7', 'u7')
  const c = conn()
  await c.msg({ type: 'hello', token: 'T7', sessionId: 's7' })
  await c.msg({ reqId: 1, code: 'work.save', payload: 'nope' })
  deepStrictEqual(c.last(), { reqId: 1, ok: false, error: 'payload must be an object' })
  await c.msg({ reqId: 2, code: 'work.save', payload: null })
  deepStrictEqual(c.last(), { reqId: 2, ok: false, error: 'payload must be an object' })
  const before = c.routed.length
  await c.msg({ reqId: 3, code: 'work.get' })
  strictEqual(c.routed.length, before + 1, 'an absent payload is legitimate (work.get)')
})

await check('malformed JSON is refused without a reqId', async () => {
  const c = conn()
  await c.msg('{not json')
  deepStrictEqual(c.last(), { ok: false, error: 'malformed JSON' })
})

// The identity a plugin acts on comes from the socket's validated session, not
// from the client's own message. If a client could name its userId, every
// plugin code would be an account-takeover primitive.
await check('the routed envelope uses the socket identity, not the client\'s', async () => {
  seed('T9', 'u9')
  const c = conn()
  await c.msg({ type: 'hello', token: 'T9', sessionId: 's9' })
  await c.msg({ reqId: 1, code: 'course.save', userId: 'VICTIM', sessionId: 'OTHER', payload: { x: 1 } })
  const env = c.routed.at(-1).body
  strictEqual(env.userId, 'u9', 'userId must come from the session')
  strictEqual(env.sessionId, 's9', 'sessionId must come from the hello')
  deepStrictEqual(env.payload, { x: 1 })
})

// Documented behaviour (inbox.js: "a failed re-validation leaves any existing
// auth untouched"), pinned so a later edit cannot quietly turn it into a
// downgrade — or into a way to inherit someone else's socket.
await check('a re-hello with a bad token leaves existing auth intact', async () => {
  seed('TA', 'ua')
  const c = conn()
  await c.msg({ type: 'hello', token: 'TA', sessionId: 'sa' })
  await c.msg({ type: 'hello', token: 'GARBAGE', sessionId: 'sa' })
  deepStrictEqual(c.last(), { type: 'hello', ok: false, error: 'Invalid or expired session' })
  await c.msg({ reqId: 1, code: 'canvas.get', payload: {} })
  strictEqual(c.routed.at(-1).body.userId, 'ua')
})

await check('an unreachable service becomes an error reply carrying the reqId', async () => {
  seed('TB', 'ub')
  const c = conn({
    route: async (url) => {
      if (url === 'http://atlas-graph/handle') throw new Error('ECONNREFUSED')
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    },
  })
  await c.msg({ type: 'hello', token: 'TB', sessionId: 'sb' })
  await c.msg({ reqId: 7, code: 'graph.get', payload: {} })
  deepStrictEqual(c.last(), { reqId: 7, ok: false, error: 'service unavailable: graph' })
})

await check('a non-2xx from a service is an error, not silence', async () => {
  seed('TC', 'uc')
  const c = conn({
    route: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  })
  await c.msg({ type: 'hello', token: 'TC', sessionId: 'sc' })
  await c.msg({ reqId: 8, code: 'email.get', payload: {} })
  deepStrictEqual(c.last(), { reqId: 8, ok: false, error: 'service unavailable: email' })
})

if (failures) {
  console.error(`\ninbox-routing.check: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\ninbox-routing.check: all good')
process.exit(0)
