// datacache eviction — pure-logic self-check (node tests/datacache.check.mjs).
//
// The bug this covers: the cache key space is unbounded (calendarui mints one
// entry per calendar range ever opened), so localStorage eventually fills. With
// no eviction every write then threw, writeCache swallowed it, and the cache
// froze at whatever it held that day — the app repainted weeks-old mail and
// events forever while the refresh behind them succeeded and was discarded.
import assert from 'node:assert/strict'

// A localStorage with a real size budget. Stored keys are own enumerable
// properties (as in a browser) so Object.keys() sees them and not the methods.
//
// ONE object for the whole file, emptied between cases rather than replaced:
// datacache.js binds rawSet to localStorage.setItem at import, so swapping in a
// fresh object would leave writes going to the old store and reads to the new.
const ls = {}
let used = 0
let budget = 4000
const def = (name, fn) => Object.defineProperty(ls, name, { value: fn, enumerable: false })
def('getItem', (k) => (Object.prototype.hasOwnProperty.call(ls, k) ? ls[k] : null))
def('setItem', (k, v) => {
  v = String(v)
  const next = used - (ls[k]?.length || 0) + v.length
  if (next > budget) {
    const e = new Error('exceeded the quota')
    e.name = 'QuotaExceededError'
    throw e
  }
  used = next
  ls[k] = v
})
def('removeItem', (k) => {
  if (Object.prototype.hasOwnProperty.call(ls, k)) { used -= ls[k].length; delete ls[k] }
})
globalThis.localStorage = ls

function resetStore(b) {
  for (const k of Object.keys(ls)) delete ls[k]
  used = 0
  budget = b
}

resetStore(4000)
// rawSet is bound at import time, so the store has to exist first.
const { writeCache, readCache, cachedValue, clearCache } = await import('../src/page/datacache.js')

const PREFIX = 'atlasCache.'
const seed = (key, at, size) => { ls[PREFIX + key] = JSON.stringify({ at, value: 'x'.repeat(size) }); used += ls[PREFIX + key].length }
const cacheKeys = () => Object.keys(ls).filter((k) => k.startsWith(PREFIX)).sort()

// --- a normal write round-trips ---
resetStore(4000)
assert.equal(writeCache('canvas.data', { courses: [1, 2] }), true)
assert.deepEqual(cachedValue('canvas.data'), { courses: [1, 2] })
assert.ok(readCache('canvas.data').at > 0)

// --- a full store evicts the OLDEST entry, not a random one ---
resetStore(3000)
seed('calendar.events.old', 1_000, 800)      // last spring
seed('calendar.events.mid', 5_000, 800)
seed('calendar.events.new', 9_000, 800)
assert.equal(cacheKeys().length, 3)
assert.equal(writeCache('email.threads.a.INBOX', { threads: 'y'.repeat(700) }), true)
assert.ok(!cacheKeys().includes(PREFIX + 'calendar.events.old'), 'the oldest range should have been evicted')
assert.ok(cacheKeys().includes(PREFIX + 'calendar.events.new'), 'the newest range must survive')
assert.equal(cachedValue('email.threads.a.INBOX').threads.length, 700)

// --- it evicts as many as it takes, oldest first, and STOPS once it fits ---
resetStore(3000)
seed('calendar.events.a', 1_000, 700)
seed('calendar.events.b', 2_000, 700)
seed('calendar.events.c', 3_000, 700)
assert.equal(writeCache('canvas.data', 'z'.repeat(2000)), true)
assert.deepEqual(cacheKeys(), [PREFIX + 'calendar.events.c', PREFIX + 'canvas.data'],
  'the two oldest ranges make way; the newest is kept because the write already fits')

// --- an unreadable entry is evicted before any valid one ---
// Sized so exactly ONE eviction makes room: if the corrupt entry were not
// chosen first, the valid range would go instead and this would fail.
resetStore(2000)
ls[PREFIX + 'corrupt'] = '{not json' + 'x'.repeat(900)
used += ls[PREFIX + 'corrupt'].length
seed('calendar.events.new', 9_000, 900)
assert.equal(writeCache('canvas.data', 'z'.repeat(760)), true)
assert.ok(!cacheKeys().includes(PREFIX + 'corrupt'), 'the unparseable entry goes first — readCache cannot use it anyway')
assert.ok(cacheKeys().includes(PREFIX + 'calendar.events.new'), 'the readable range survives')

// --- real Atlas data is NEVER evicted to make room for a cache ---
resetStore(1000)
ls['atlas.gym.v1'] = 'g'.repeat(950)
used += ls['atlas.gym.v1'].length
assert.equal(writeCache('canvas.data', 'z'.repeat(500)), false, 'no cache entry left to reclaim → give up')
assert.equal(ls['atlas.gym.v1'].length, 950, 'the gym log must survive; it is not re-fetchable')
assert.equal(readCache('canvas.data'), null)

// --- a failed write DROPS the previous copy rather than leaving a stale one ---
// Showing last week's grades as if they were today's is worse than a spinner,
// and keeping them silently is exactly how this went unnoticed for so long.
resetStore(2000)
assert.equal(writeCache('canvas.data', 'small'), true)
ls['atlas.gym.v1'] = 'g'.repeat(1900) // the store fills up around it
used += ls['atlas.gym.v1'].length
assert.equal(writeCache('canvas.data', 'z'.repeat(1500)), false)
assert.equal(readCache('canvas.data'), null, 'the stale copy must not survive a failed refresh')

// --- an unserializable value fails without throwing, and drops the old copy ---
resetStore(4000)
assert.equal(writeCache('canvas.data', 'fine'), true)
const cyclic = {}
cyclic.self = cyclic
assert.equal(writeCache('canvas.data', cyclic), false)
assert.equal(readCache('canvas.data'), null)

// --- clearCache only touches the cache namespace ---
resetStore(4000)
writeCache('canvas.data', 'a')
writeCache('calendar.cals', 'b')
ls['atlas.gym.v1'] = 'keep'
ls['atlasGoogle'] = 'keep'
clearCache()
assert.deepEqual(cacheKeys(), [])
assert.equal(ls['atlas.gym.v1'], 'keep')
assert.equal(ls['atlasGoogle'], 'keep', 'the Google connection is not part of this cache')

console.log('datacache.check: all assertions passed')
