// sync.js's half of the per-key compare-and-swap.
//
// Every push carries the revision this device believed it was editing, and the
// server takes the write only if that is still the stored one. Before this,
// sync was "last ARRIVAL wins" — and an arrival can be arbitrarily old, because
// the push queue is persisted across launches. A phone that queued a board a
// week ago still overwrote everything on reconnect, and the fanout then pushed
// that stale copy to every other device. Getting the bookkeeping wrong here
// brings that back, so: what is sent, what is recorded, and what a refusal does.
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
  constructor(url) { this.url = url; this.readyState = FakeWS.OPEN; this.sent = []; sockets.push(this); setTimeout(() => this.onopen?.(), 0) }
  send(s) { this.sent.push(JSON.parse(s)) }
  close() {}
  reply(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
}
globalThis.WebSocket = FakeWS

const { sync } = await import('../src/sync.js')
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms))
const inbox = () => sockets[0]
const lastSave = (key) => inbox().sent.findLast((m) => m.code === 'page.save' && m.payload.storageKey === key)

const seen = []
sync.onUpdate((key, value) => seen.push({ key, value }))

sync.connect({ token: 'tok' })
await tick(5)
inbox().reply({ type: 'hello', ok: true, userId: 'u1' })
sockets[1]?.reply({ type: 'hello', ok: true })
await tick(5)

// 1. A key this device has never seen is pushed at revision 0 — which is also
//    what every row predating the rev column reads as, so the very first push
//    after the upgrade matches rather than being refused forever.
const K1 = 'atlas.page.equations.v1'
sync.pushKey(K1, '{"v":1,"rows":[]}')
await tick(450)
const p1 = lastSave(K1)
assert.equal(p1.payload.baseRev, 0, 'a never-seen key is pushed at baseRev 0')
assert.equal(sync.revFor(K1), 0)

// 2. The ack's revision is recorded, and the NEXT push builds on it.
inbox().reply({ reqId: p1.reqId, ok: true, data: { saved: K1, rev: 1, stale: false } })
await tick(5)
assert.equal(sync.revFor(K1), 1, 'the acked revision is recorded')
assert.equal(sync.hasPendingWrite(K1), false, 'an accepted push leaves the queue')
sync.pushKey(K1, '{"v":1,"rows":[{"id":"r1"}]}')
await tick(450)
assert.equal(lastSave(K1).payload.baseRev, 1, 'the next push bases itself on it')

// 3. A REFUSAL: the store moved on, so this device's value is the old one.
//    It must be dropped, not retried — retrying is exactly how a week-old queue
//    used to win — and the server's value handed to the update listeners so the
//    page follows instead of silently disagreeing with the store.
const before = seen.length
inbox().reply({ reqId: lastSave(K1).reqId, ok: true, data: { saved: K1, rev: 9, stale: true, value: { v: 1, rows: [{ id: 'theirs' }] } } })
await tick(5)
assert.equal(sync.revFor(K1), 9, 'the store’s revision is adopted')
assert.equal(sync.hasPendingWrite(K1), false, 'the refused value is dropped, not requeued')
assert.equal(seen.length, before + 1, 'the adopted value reaches the update listeners')
assert.deepEqual(seen.at(-1), { key: K1, value: { v: 1, rows: [{ id: 'theirs' }] } })
sync.pushKey(K1, '{"v":1,"rows":[{"id":"mine again"}]}')
await tick(450)
assert.equal(lastSave(K1).payload.baseRev, 9, 'and the next real edit builds on the adopted revision')

// 4. A live broadcast carries the revision its value came from. Recording it is
//    what stops the very next local edit from being refused as stale.
const K2 = 'atlas.theme.v1'
inbox().reply({ type: 'sync.update', key: K2, value: '{"preset":"brass"}', rev: 4 })
await tick(5)
assert.equal(sync.revFor(K2), 4, 'a broadcast records its revision')
sync.pushKey(K2, '{"preset":"cobalt"}')
await tick(450)
assert.equal(lastSave(K2).payload.baseRev, 4, 'an edit on top of a broadcast is not stale')

// 5. Revisions only move forward. A reply that overtakes an older one in flight
//    must not walk the map back, or every later push bases itself on a
//    superseded revision and is refused for good.
inbox().reply({ type: 'sync.update', key: K2, value: '{"preset":"rose"}', rev: 2 })
await tick(5)
assert.equal(sync.revFor(K2), 4, 'an older revision never rewinds the map')

// 6. The revisions are persisted, so a relaunch does not start from 0 and get
//    everything refused.
assert.ok(store.get('atlasRevs'), 'the revision map is persisted')
assert.equal(JSON.parse(store.get('atlasRevs'))[K2], 4)
// ...and it is NOT an atlas.* key, so it can never sync itself or land in a backup
assert.ok(!'atlasRevs'.startsWith('atlas.'), 'the bookkeeping key never syncs itself')

// 7. A server too old to know about revisions omits them entirely. The map must
//    be left alone rather than poisoned, so those pushes keep working.
const K3 = 'atlas.page.work.v1'
sync.pushKey(K3, '{"v":1,"rows":[]}')
await tick(450)
inbox().reply({ reqId: lastSave(K3).reqId, ok: true, data: { saved: K3 } }) // no rev
await tick(5)
assert.equal(sync.revFor(K3), 0, 'a reply with no revision leaves the map at 0')
assert.equal(sync.hasPendingWrite(K3), false, 'and the push still counts as acked')

// 8. The boot pull is where a fresh launch learns every revision. Without this
//    the first edit after each launch would be based on 0 and refused.
const pull = sync.pullAll()
await tick(5)
const pullReq = inbox().sent.findLast((m) => m.code === 'sync.pull.all')
inbox().reply({ reqId: pullReq.reqId, ok: true, data: {
  states: { 'atlas.page.sleep.v1': { v: 1 }, 'atlas.gym.v1': { logs: [] } },
  revs: { 'atlas.page.sleep.v1': 12, 'atlas.gym.v1': 3 },
} })
const states = await pull
assert.deepEqual(Object.keys(states).sort(), ['atlas.gym.v1', 'atlas.page.sleep.v1'], 'pullAll still returns the states')
assert.equal(sync.revFor('atlas.page.sleep.v1'), 12, 'the boot pull records revisions')
assert.equal(sync.revFor('atlas.gym.v1'), 3)

// ...and a pull from a server that sends no revs at all must not throw.
const pull2 = sync.pullAll()
await tick(5)
const pullReq2 = inbox().sent.findLast((m) => m.code === 'sync.pull.all')
inbox().reply({ reqId: pullReq2.reqId, ok: true, data: { states: { 'atlas.theme.v1': 'x' } } })
await pull2
assert.equal(sync.revFor('atlas.page.sleep.v1'), 12, 'a rev-less pull leaves the map alone')

console.log('sync-revision.check: ok')
process.exit(0) // the 15s push-retry timer would otherwise hold node open
