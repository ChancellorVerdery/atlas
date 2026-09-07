// The outbox's registration, fan-out and isolation rules, executed - not read.
//
// WHY THIS FILE EXISTS. Two open items from earlier passes meet here:
//
//   1. Pass 7 changed this service's /deliver body reader from `body += chunk`
//      to Buffer.concat on a MECHANISM ARGUMENT with no reproduction, and
//      flagged that as the weakest thing it did that night ("correctness-by-
//      consistency, not a demonstrated live bug"). Pass 9 and Pass 10 both said
//      a socket-level test would settle it either way. Arm 1 is that test, and
//      it settles it: the corruption IS reachable through the real /deliver.
//
//   2. The outbox was the last service with no behavioral test at all. Every
//      arm below covers a rule this file has always had and nothing checked -
//      most importantly that one user's sync.update cannot reach another user's
//      socket, which is the worst thing this service could get wrong.
//
// Importing services/outbox.js is possible as of Pass 11, which put
// server.listen(80) and the heartbeat interval behind an entrypoint guard.
// Before that, importing bound a port and left a timer holding the process
// open forever.
//
// Run: node test/outbox-delivery.check.mjs
import { strictEqual, ok } from 'node:assert'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { pool } from '../lib/db.js'
import { deliver, httpHandler, onConnection } from '../services/outbox.js'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---- model of auth.sessions -------------------------------------------------
// Deliberately loud: any SQL this does not recognise is a hard throw, never a
// silent {rows:[]}. A future edit to outbox.js that looked up a session some
// other way would otherwise route around the model and leave every arm green.
const sessions = new Map()
pool.query = async (q, params = []) => {
  const s = String(q).replace(/\s+/g, ' ').trim()
  if (s.startsWith('SELECT user_id FROM auth.sessions WHERE token =')) {
    const row = sessions.get(params[0])
    return { rows: row ? [{ user_id: row.userId }] : [] }
  }
  throw new Error('unmodelled SQL: ' + s)
}
const seed = (token, userId) => sessions.set(token, { userId })

// ---- harness ----------------------------------------------------------------
// Each socket gets its own IP. The outbox's limiters are module-level and keyed
// by IP (30 new sockets/min, 30 hellos/min, 10 concurrent), so sharing one
// across arms would let an early arm throttle a later one and produce failures
// with nothing to do with the behaviour under test.
let ipSeq = 0
function conn() {
  const sent = [], closed = []
  const ws = new EventEmitter()
  ws.OPEN = 1
  ws.readyState = 1
  ws.send = m => sent.push(JSON.parse(m))
  ws.close = (code, reason) => { closed.push({ code, reason }); ws.readyState = 3 }
  ws.terminate = () => { closed.push({ code: 'terminate' }); ws.readyState = 3 }
  ws.ping = () => {}
  const ip = `10.1.0.${++ipSeq}`
  onConnection(ws, { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } })
  // The message handler is async (session lookup); a frame is only fully
  // processed once its microtasks have drained.
  const msg = async o => {
    ws.emit('message', typeof o === 'string' ? o : JSON.stringify(o))
    await new Promise(r => setTimeout(r, 15))
  }
  return { ws, msg, sent, closed, ip, last: () => sent.at(-1) }
}

// A socket registered under `userId` with `sessionId`, ready to receive.
async function joined(userId, sessionId) {
  const token = `tok-${userId}-${sessionId}`
  seed(token, userId)
  const c = conn()
  await c.msg({ type: 'hello', token, sessionId })
  if (!c.last() || c.last().ok !== true) throw new Error('hello did not register: ' + JSON.stringify(c.last()))
  c.sent.length = 0 // drop the hello ack so arms read only pushes
  return c
}

// ---- arm 1: the Pass 7 question, settled ------------------------------------
// A body split INSIDE a two-byte character, written as two TCP segments through
// the real httpHandler into the real deliver() and out to a real registered
// socket. `body += chunk` decodes each chunk independently, so the character
// straddling the boundary becomes two U+FFFD replacements - and it stays valid
// JSON, so nothing throws and nothing logs. The mojibake is simply what the
// user's other devices receive and store.
//
// THE DELIBERATE SPLIT IS THE WHOLE POINT. Pass 7 measured that an ordinary
// fetch() round-trips this payload fine at every size it tried, because Node
// coalesces it into a single chunk. A test that just POSTs a big string with an
// accent in it passes against broken code. Do not "simplify" this to a fetch.
await check('a /deliver body split mid-character survives intact', async () => {
  const c = await joined('u-utf8', 's-utf8')
  const NOTE = 'before-é-🏋️-after'
  const payload = JSON.stringify({
    type: 'sync.update', userId: 'u-utf8', data: { key: 'gym', value: { note: NOTE } },
  })
  const buf = Buffer.from(payload, 'utf8')
  // Split between the two bytes of the accented character.
  const at = buf.indexOf(Buffer.from('é', 'utf8')) + 1
  ok(at > 1 && at < buf.length, 'split point must land inside the payload')

  const server = http.createServer(httpHandler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timed out talking to /deliver')), 5000)
      const s = net.connect(port, '127.0.0.1', () => {
        s.write(
          'POST /deliver HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n' +
          `Content-Length: ${buf.length}\r\nConnection: close\r\n\r\n`,
        )
        s.write(buf.subarray(0, at))
        // Force a second TCP segment: without the delay the two writes coalesce
        // and the payload arrives as one chunk, which is exactly the case that
        // passes against broken code.
        setTimeout(() => s.write(buf.subarray(at)), 60)
      })
      // A net.Socket stays paused until something reads it, and a socket nobody
      // reads never reaches 'end' or 'close' - the promise would hang silently.
      s.on('data', () => {})
      s.on('close', () => { clearTimeout(t); resolve() })
      s.on('error', e => { clearTimeout(t); reject(e) })
    })
  } finally {
    await new Promise(r => server.close(r))
  }

  const got = c.last()
  ok(got, 'the registered socket received nothing at all')
  strictEqual(got.type, 'sync.update')
  strictEqual(
    got.value.note, NOTE,
    `a body split mid-character was corrupted on the way in\n` +
    `       sent ${JSON.stringify(NOTE)}\n       got  ${JSON.stringify(got.value.note)}\n` +
    `       read the body as Buffers and decode once at end - not \`body += chunk\``,
  )
})

// ---- registration and isolation ---------------------------------------------
await check('a valid hello registers the socket and sync.update reaches it', async () => {
  const c = await joined('u1', 's1')
  deliver({ type: 'sync.update', userId: 'u1', data: { key: 'gym', value: { a: 1 } } })
  strictEqual(c.sent.length, 1)
  strictEqual(c.last().key, 'gym')
  strictEqual(c.last().value.a, 1)
})

// The worst thing this service could get wrong. registry is keyed by userId and
// every path reads it by key, but nothing asserted it until now.
await check('one user’s sync.update never reaches another user’s socket', async () => {
  const a = await joined('u-a', 's-a')
  const b = await joined('u-b', 's-b')
  deliver({ type: 'sync.update', userId: 'u-a', data: { key: 'finance', value: { secret: 1 } } })
  strictEqual(a.sent.length, 1, 'the owner should have received it')
  strictEqual(b.sent.length, 0, 'another account received a foreign sync.update')
})

await check('excludeSession suppresses the originating socket only', async () => {
  const one = await joined('u2', 's-origin')
  const two = await joined('u2', 's-other')
  deliver({
    type: 'sync.update', userId: 'u2', excludeSession: 's-origin',
    data: { key: 'work', value: { v: 2 } },
  })
  strictEqual(one.sent.length, 0, 'the socket that caused the update was echoed back to')
  strictEqual(two.sent.length, 1, 'the user’s other socket missed the update')
})

await check('a request result prefers the exact session', async () => {
  const mine = await joined('u3', 's-mine')
  const other = await joined('u3', 's-other')
  deliver({ userId: 'u3', sessionId: 's-mine', reqId: 'r1', ok: true, data: { x: 1 } })
  strictEqual(mine.sent.length, 1)
  strictEqual(mine.last().reqId, 'r1')
  strictEqual(other.sent.length, 0, 'a result went to a session that did not ask for it')
})

// Documented fallback: the asking socket may have dropped, so the result goes
// to every socket of that user and the client discards it by reqId (reqIds are
// crypto.randomUUID() client-side, so they cannot collide across sessions).
await check('a request result with no session match falls back to the user’s sockets', async () => {
  const one = await joined('u4', 's-x')
  const two = await joined('u4', 's-y')
  deliver({ userId: 'u4', sessionId: 's-gone', reqId: 'r2', ok: true, data: {} })
  strictEqual(one.sent.length, 1)
  strictEqual(two.sent.length, 1)
})

await check('a result for an unknown user is dropped, not broadcast', async () => {
  const c = await joined('u5', 's5')
  deliver({ userId: 'nobody', sessionId: 's5', reqId: 'r3', ok: true, data: {} })
  strictEqual(c.sent.length, 0)
})

// ---- the handshake ----------------------------------------------------------
await check('an invalid token is refused, closed, and never registered', async () => {
  const c = conn()
  await c.msg({ type: 'hello', token: 'not-a-token', sessionId: 's6' })
  strictEqual(c.last().ok, false)
  strictEqual(c.last().error, 'Invalid or expired session')
  c.sent.length = 0
  deliver({ type: 'sync.update', userId: 'u1', data: { key: 'gym', value: {} } })
  strictEqual(c.sent.length, 0, 'an unauthenticated socket received a push')
  await new Promise(r => setTimeout(r, 150))
  ok(c.closed.length > 0, 'a refused socket must be closed, not left open')
})

await check('a socket that never said hello receives nothing', async () => {
  const c = conn()
  deliver({ type: 'sync.update', userId: 'u1', data: { key: 'gym', value: {} } })
  deliver({ userId: 'u1', sessionId: 's1', reqId: 'r4', ok: true, data: {} })
  strictEqual(c.sent.length, 0)
})

await check('malformed JSON and non-hello frames are ignored without registering', async () => {
  const c = conn()
  await c.msg('{not json')
  await c.msg({ type: 'sync.update', userId: 'u1' })
  await c.msg({ nope: 1 })
  strictEqual(c.sent.length, 0, 'a junk frame drew a reply')
  strictEqual(c.ws.userId, undefined, 'a junk frame authenticated the socket')
})

await check('a pre-auth frame flood is terminated', async () => {
  const c = conn()
  for (let i = 0; i < 25; i++) c.ws.emit('message', '{"type":"nope"}')
  await new Promise(r => setTimeout(r, 15))
  ok(c.closed.some(x => x.code === 'terminate'), 'an unauthenticated firehose was not cut off')
})

// The socket is deliberately left readyState OPEN here. A first version
// flipped it to CLOSED first, and that arm passed even with unregister() taken
// out - send()'s own `readyState === OPEN` guard was doing all the work and the
// registry leak it exists to catch was invisible. Leaving it OPEN is what makes
// this arm about unregistration.
await check('closing a socket unregisters it', async () => {
  const c = await joined('u6', 's7')
  c.ws.emit('close')
  deliver({ type: 'sync.update', userId: 'u6', data: { key: 'gym', value: {} } })
  strictEqual(c.sent.length, 0, 'a closed socket is still in the registry')
})

// ---- the /deliver contract --------------------------------------------------
// "Delivery is best-effort - /deliver always answers 200 {}" is this file's own
// opening comment, and services depend on it: a non-200 would make a plugin
// treat a delivered result as a failed one.
await check('/deliver answers 200 {} even on a malformed body', async () => {
  const server = http.createServer(httpHandler)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const r = await fetch(`http://127.0.0.1:${port}/deliver`, { method: 'POST', body: '{not json' })
    strictEqual(r.status, 200)
    strictEqual(await r.text(), '{}')
    const g = await fetch(`http://127.0.0.1:${port}/`)
    strictEqual(await g.text(), 'atlas-outbox')
    const nf = await fetch(`http://127.0.0.1:${port}/nope`)
    strictEqual(nf.status, 404)
  } finally {
    await new Promise(r => server.close(r))
  }
})

console.log(failures ? `\noutbox-delivery: ${failures} failure(s)` : '\noutbox-delivery: all good')
process.exit(failures ? 1 : 0)
