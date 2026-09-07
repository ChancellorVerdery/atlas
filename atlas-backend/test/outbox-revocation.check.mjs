// The outbox's session-revocation sweep, executed - not read.
//
// WHY THIS FILE EXISTS. Pass 11 measured the gap this covers: an outbox socket
// authenticates once, at hello, and was then trusted for its entire life. When
// a user logs out, auth.logout() DELETEs the session row - but nothing ever
// asked the outbox to re-check, so the socket kept receiving that user's
// request results and sync.update fanouts. Passes 11, 12 and 13 all named it
// the only known live authorization gap left in the backend and left it as a
// design decision. Pass 14 made the call (periodic re-validation inside the
// outbox, rather than a logout broadcast from auth.js) and these arms hold it.
//
// The arms below deliberately push AFTER forcing the socket's readyState back
// to OPEN. That is the whole point: it proves the socket stops receiving
// because it was unregistered, not merely because send() saw a closed socket.
//
// Run: node test/outbox-revocation.check.mjs
import { strictEqual, ok } from 'node:assert'
import { EventEmitter } from 'node:events'
import { pool } from '../lib/db.js'
import { deliver, onConnection, revokeSweep } from '../services/outbox.js'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---- model of auth.sessions -------------------------------------------------
// Loud: unmodelled SQL is a hard throw, never a silent {rows:[]}. Two shapes are
// modelled because the service uses two - the single-token hello lookup and the
// sweep's batched ANY(). `expiresAt` is honoured rather than ignored, so an
// expired row is invisible to both, exactly as `expires_at > now()` makes it.
const sessions = new Map()
let queries = 0
let failNextQuery = null
pool.query = async (q, params = []) => {
  queries++
  if (failNextQuery) { const e = failNextQuery; failNextQuery = null; throw new Error(e) }
  const s = String(q).replace(/\s+/g, ' ').trim()
  const alive = t => {
    const row = sessions.get(t)
    return row && row.expiresAt > Date.now() ? row : null
  }
  if (s.startsWith('SELECT user_id FROM auth.sessions WHERE token =')) {
    const row = alive(params[0])
    return { rows: row ? [{ user_id: row.userId }] : [] }
  }
  if (s.startsWith('SELECT token, user_id FROM auth.sessions WHERE token = ANY(')) {
    const rows = []
    for (const t of params[0]) { const row = alive(t); if (row) rows.push({ token: t, user_id: row.userId }) }
    return { rows }
  }
  throw new Error('unmodelled SQL: ' + s)
}
const HOUR = 3600_000
const seed = (token, userId, ttl = HOUR) => sessions.set(token, { userId, expiresAt: Date.now() + ttl })

// ---- harness ----------------------------------------------------------------
// Each socket gets its own IP: the outbox's limiters are module-level and keyed
// by IP, so a shared one would let an early arm throttle a later one.
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
  const ip = `10.14.0.${++ipSeq}`
  onConnection(ws, { headers: { 'x-forwarded-for': ip }, socket: { remoteAddress: ip } })
  const hello = async (token, sessionId) => {
    ws.emit('message', JSON.stringify({ type: 'hello', token, sessionId }))
    await new Promise(r => setTimeout(r, 15))
  }
  // Force the socket back OPEN so a later push failing proves unregistration.
  const reopen = () => { ws.readyState = 1 }
  return { ws, hello, sent, closed, reopen, pushes: () => sent.filter(m => m.reqId).length }
}

const push = (userId, reqId) => deliver({ userId, sessionId: 's', reqId, ok: true, data: {} })

await check('a live session receives pushes, and survives a sweep', async () => {
  seed('t-live', 'u-live')
  const c = conn()
  await c.hello('t-live', 's1')
  strictEqual(c.sent[0].ok, true, 'hello was not accepted')
  push('u-live', 'r1')
  strictEqual(c.pushes(), 1, 'a live socket did not receive its push')
  strictEqual(await revokeSweep(), 0, 'the sweep dropped a still-valid session')
  push('u-live', 'r2')
  strictEqual(c.pushes(), 2, 'a swept-but-valid socket stopped receiving pushes')
})

await check('after logout the socket is dropped and receives nothing more', async () => {
  seed('t-out', 'u-out')
  const c = conn()
  await c.hello('t-out', 's1')
  push('u-out', 'r1')
  strictEqual(c.pushes(), 1)
  sessions.delete('t-out')                       // exactly what auth.logout() does
  strictEqual(await revokeSweep(), 1, 'the sweep did not drop a logged-out socket')
  c.reopen()
  push('u-out', 'r2')
  strictEqual(c.pushes(), 1, 'a logged-out socket still received a push')
})

await check('a logged-out socket is closed with a distinguishable code', async () => {
  seed('t-code', 'u-code')
  const c = conn()
  await c.hello('t-code', 's1')
  sessions.delete('t-code')
  await revokeSweep()
  strictEqual(c.closed.length, 1, 'the revoked socket was never closed')
  strictEqual(c.closed[0].code, 4001, 'close code was not the revocation code')
})

await check('an expired session is dropped by the same sweep', async () => {
  seed('t-exp', 'u-exp', HOUR)
  const c = conn()
  await c.hello('t-exp', 's1')
  sessions.get('t-exp').expiresAt = Date.now() - 1  // now past expires_at
  strictEqual(await revokeSweep(), 1, 'an expired session survived the sweep')
  c.reopen()
  push('u-exp', 'r1')
  strictEqual(c.pushes(), 0, 'an expired session still received a push')
})

await check('a recycled token cannot leave a socket wired to the previous owner', async () => {
  seed('t-recycle', 'u-first')
  const c = conn()
  await c.hello('t-recycle', 's1')
  sessions.set('t-recycle', { userId: 'u-second', expiresAt: Date.now() + HOUR })
  strictEqual(await revokeSweep(), 1, 'a token now belonging to another user was kept')
  c.reopen()
  push('u-first', 'r1')
  strictEqual(c.pushes(), 0, 'the old owner still reached the socket')
})

await check('one user\'s revocation does not disturb another user\'s socket', async () => {
  seed('t-a', 'u-a'); seed('t-b', 'u-b')
  const a = conn(), b = conn()
  await a.hello('t-a', 's1'); await b.hello('t-b', 's1')
  sessions.delete('t-a')
  strictEqual(await revokeSweep(), 1, 'the sweep dropped more than the revoked socket')
  push('u-b', 'r1')
  strictEqual(b.pushes(), 1, 'an unrelated user\'s socket stopped receiving pushes')
  strictEqual(b.closed.length, 0, 'an unrelated user\'s socket was closed')
})

await check('the sweep fails open: a query error disconnects nobody', async () => {
  seed('t-blip', 'u-blip')
  const c = conn()
  await c.hello('t-blip', 's1')
  failNextQuery = 'connection terminated unexpectedly'
  strictEqual(await revokeSweep(), 0, 'a database error dropped sockets')
  strictEqual(c.closed.length, 0, 'a database error closed a socket')
  push('u-blip', 'r1')
  strictEqual(c.pushes(), 1, 'a database error cost a live user their pushes')
})

await check('the sweep is one query for many sockets, and none for zero', async () => {
  // Registry state carries over between arms, so measure the delta, not a total.
  const before = queries
  strictEqual(await revokeSweep(), 0)
  const withSockets = queries - before
  strictEqual(withSockets, 1, `sweep issued ${withSockets} queries, not 1`)

  // Drop every socket still registered, then confirm an empty sweep is free.
  for (const t of [...sessions.keys()]) sessions.delete(t)
  await revokeSweep()
  const idle = queries
  strictEqual(await revokeSweep(), 0, 'an empty registry still reported drops')
  strictEqual(queries, idle, 'an empty sweep still hit the database')
})

await check('a socket that never said hello is left alone', async () => {
  const c = conn()                                 // no hello: no token, no registry entry
  strictEqual(await revokeSweep(), 0, 'the sweep touched an unauthenticated socket')
  strictEqual(c.closed.length, 0, 'an unauthenticated socket was closed by the sweep')
})

console.log(failures ? `outbox-revocation.check: ${failures} FAILURES` : 'outbox-revocation.check: all good')
process.exit(failures ? 1 : 0)
