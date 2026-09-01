// Checks sync.js's un-acked-write tracking: hasPendingWrite must be true from
// the moment an edit is debounced until the server acks it — through failed
// (rate-limited) pushes and reconnect flushes — because main.js uses it to
// decide whether a sync.update broadcast may overwrite the local value. A
// false negative here is "deleted widgets reappear": a stale broadcast lands
// on top of an edit still waiting to be sent.
import assert from 'node:assert/strict'

// ---- browser shims (before the import — sync.js touches these at load) ----
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
const sockets = []
class FakeWS {
  static OPEN = 1
  constructor(url) {
    this.url = url
    this.readyState = FakeWS.OPEN
    this.sent = []
    sockets.push(this)
    setTimeout(() => this.onopen?.(), 0)
  }
  send(s) { this.sent.push(JSON.parse(s)) }
  close() {}
  // test-side: server replies
  reply(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}
globalThis.WebSocket = FakeWS

const { sync } = await import('../src/sync.js')
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const KEY = 'atlas.page.formal.v1'
const inbox = () => sockets[0]

sync.connect({ token: 'tok' })
await tick(5)
inbox().reply({ type: 'hello', ok: true, userId: 'u1' })
sockets[1]?.reply({ type: 'hello', ok: true }) // outbox
await tick(5)

// 1. A debounced edit is pending immediately, and still pending once the
//    debounce fires it onto the wire (queued until acked).
sync.pushKey(KEY, '{"v":1,"rows":[]}')
assert.equal(sync.hasPendingWrite(KEY), true, 'pending while debounced')
await tick(450)
const req = inbox().sent.findLast((m) => m.code === 'page.save')
assert.ok(req, 'debounce sent the push')
assert.equal(sync.hasPendingWrite(KEY), true, 'pending while in flight')
assert.ok(store.get('atlasPendingPushes')?.includes(KEY), 'queue persisted')

// 2. A rejected push (rate limited) stays pending — the exact window where a
//    broadcast used to resurrect the old value.
inbox().reply({ reqId: req.reqId, ok: false, error: 'rate limited — try again later' })
await tick(5)
assert.equal(sync.hasPendingWrite(KEY), true, 'still pending after reject')

// 3. A newer edit replaces the queued value; the reconnect flush re-reads the
//    queue at fire time, so it must send the NEW value, and the old push's
//    late ack must not unqueue it.
sync.pushKey(KEY, '{"v":1,"rows":[{"id":"r1"}]}')
await tick(450)
const req2 = inbox().sent.findLast((m) => m.code === 'page.save')
inbox().reply({ reqId: req2.reqId, ok: false, error: 'rate limited — try again later' })
await tick(5)
inbox().reply({ type: 'hello', ok: true, userId: 'u1' }) // reconnect → flush
await tick(20)
const req3 = inbox().sent.findLast((m) => m.code === 'page.save')
assert.notEqual(req3.reqId, req2.reqId, 'flush re-sent')
assert.deepEqual(req3.payload.value, { v: 1, rows: [{ id: 'r1' }] }, 'flush sends the newest value')

// 4. The ack finally lands → no longer pending → broadcasts may apply again.
inbox().reply({ reqId: req3.reqId, ok: true, data: { saved: KEY } })
await tick(5)
assert.equal(sync.hasPendingWrite(KEY), false, 'ack clears pending')
assert.equal(store.get('atlasPendingPushes'), undefined, 'queue drained')

console.log('sync-pending.check: ok')
process.exit(0) // the 15s push-retry timer would otherwise hold node open
