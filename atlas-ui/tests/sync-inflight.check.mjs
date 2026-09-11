// Two edits to one key, the second sent before the first's ack has landed.
//
// The compare-and-swap bases every push on the last revision the SERVER told
// us. A push sent while an earlier push for the same key is still on the wire
// carries a revision that earlier push is about to supersede — so the server
// refuses it, and a refusal means "drop the value, adopt the store's". The
// user's second edit reverts in front of them. Customize live-saves on every
// drop, resize and keystroke, and a round trip through cloudflared is not
// always under the 400ms debounce, so this is an ordinary afternoon, not an
// edge case. One push per key on the wire at a time; the newest value goes out
// on the ack, on the revision the ack just taught us.
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
const sockets = []
class FakeWS {
  static OPEN = 1
  constructor(url) { this.url = url; this.readyState = FakeWS.OPEN; this.sent = []; sockets.push(this); setTimeout(() => this.onopen?.(), 0) }
  send(s) { this.sent.push(JSON.parse(s)) }
  close() {}
  reply(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}
globalThis.WebSocket = FakeWS

const { sync } = await import('../src/sync.js')
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const inbox = () => sockets[0]
const saves = (key) => inbox().sent.filter((m) => m.code === 'page.save' && m.payload.storageKey === key)

const adopted = []
sync.onUpdate((key, value) => adopted.push({ key, value }))

sync.connect({ token: 'tok' })
await tick(5)
inbox().reply({ type: 'hello', ok: true, userId: 'u1' })
sockets[1]?.reply({ type: 'hello', ok: true })
await tick(5)

const KEY = 'atlas.page.gym.v1'

// edit A goes out; the server is slow to answer
sync.pushKey(KEY, '{"v":1,"rows":["a"]}')
await tick(450)
assert.equal(saves(KEY).length, 1, 'edit A is on the wire')
const a = saves(KEY)[0]
assert.equal(a.payload.baseRev, 0)

// edit B lands more than a debounce later, while A is STILL unanswered
await tick(100)
sync.pushKey(KEY, '{"v":1,"rows":["a","b"]}')
await tick(450)
assert.equal(saves(KEY).length, 1, 'edit B must NOT be sent while A is on the wire')
assert.equal(sync.hasPendingWrite(KEY), true, 'B is held, not dropped')

// A's ack finally arrives at revision 1 — B goes out now, based on it
inbox().reply({ reqId: a.reqId, ok: true, data: { saved: KEY, rev: 1, stale: false } })
await tick(10)
assert.equal(saves(KEY).length, 2, 'B is sent on A’s ack')
const b = saves(KEY)[1]
assert.equal(b.payload.baseRev, 1, 'B is based on the revision A’s ack taught us')
assert.deepEqual(b.payload.value, { v: 1, rows: ['a', 'b'] }, 'and it is the NEWEST value')
inbox().reply({ reqId: b.reqId, ok: true, data: { saved: KEY, rev: 2, stale: false } })
await tick(10)
assert.equal(sync.hasPendingWrite(KEY), false, 'both edits acked, nothing pending')
assert.equal(adopted.length, 0, 'nothing was refused, so nothing was adopted')

// Three edits, each after the debounce, none acked until the end: exactly one
// push on the wire, and the one sent afterwards carries the last value only.
const K2 = 'atlas.page.work.v1'
sync.pushKey(K2, '{"n":1}'); await tick(450)
sync.pushKey(K2, '{"n":2}'); await tick(450)
sync.pushKey(K2, '{"n":3}'); await tick(450)
assert.equal(saves(K2).length, 1, 'only the first edit is on the wire')
inbox().reply({ reqId: saves(K2)[0].reqId, ok: true, data: { saved: K2, rev: 1, stale: false } })
await tick(10)
assert.equal(saves(K2).length, 2, 'one follow-up, not two')
assert.deepEqual(saves(K2)[1].payload.value, { n: 3 }, 'carrying the newest value')
assert.equal(saves(K2)[1].payload.baseRev, 1)
inbox().reply({ reqId: saves(K2)[1].reqId, ok: true, data: { saved: K2, rev: 2, stale: false } })
await tick(10)
assert.equal(sync.hasPendingWrite(K2), false, 'K2 fully drained')

// A transport failure releases the key so the retry timer can resend it.
const K3 = 'atlas.page.sleep.v1'
sync.pushKey(K3, '{"s":1}'); await tick(450)
inbox().reply({ reqId: saves(K3)[0].reqId, ok: false, error: 'rate limited — try again later' })
await tick(10)
assert.equal(sync.hasPendingWrite(K3), true, 'still queued after a transport failure')
inbox().reply({ type: 'hello', ok: true, userId: 'u1' }) // reconnect → flush
await tick(300) // flushPushes paces keys 250ms apart; don't race its slot
assert.equal(saves(K3).length, 2, 'the flush could resend it (the key was released)')

console.log('sync-inflight.check: ok')
process.exit(0)
