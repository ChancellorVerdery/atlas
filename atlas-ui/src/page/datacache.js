// Device-local cache of data plugins fetch from remote services — Canvas
// grades, Gmail threads, Google Calendar events. These are re-derivable copies
// of somebody else's API, kept so opening a page paints instantly instead of
// showing a spinner while the network answers.
//
// The key prefix is deliberately NOT 'atlas.': sync.js pushes every atlas.* key
// to Postgres and the backup export bundles them, and none of this belongs in
// either — it is bulky, always re-fetchable, and specific to one device. Same
// convention as atlasLastUser in main.js.
//
// Entries are account-scoped in effect: main.js clears them alongside the
// atlas.* cache when the signed-in account changes, so one profile's grades or
// mail can never surface under another's.
const PREFIX = 'atlasCache.'

// localStorage is a ~5MB budget shared with the real data. Two separate limits
// keep this cache inside it: MAX_BYTES stops any ONE payload eating the budget,
// and evictOldest() below reclaims space when the store is genuinely full.
//
// The key set is NOT fixed, which is what the original version of this comment
// got wrong: evCacheKey (calendarui) mints an entry per calendar range ever
// opened and threadCacheKey one per account x folder, so the store grows for as
// long as Atlas is used. With no eviction it eventually filled, every write then
// threw, writeCache swallowed the error, and the whole cache froze at whatever
// it held that day — the app kept repainting weeks-old mail and events while the
// refresh behind them succeeded and was thrown away every single launch.
// ponytail: still localStorage. IndexedDB is the move if payloads outgrow this.
const MAX_BYTES = 1_500_000

// Captured before main.js wraps setItem. Cache keys are outside the synced
// namespace anyway, but going through the hook would still add them to
// writtenSinceBoot and wrongly shadow a real key of the same name.
//
// Falls back to a late lookup when localStorage does not exist yet at import
// time — node self-checks install theirs after importing, and this module is
// now pulled in transitively by email.js, so an eager bind made mere import
// order fatal. In a browser the eager capture always wins, which is the whole
// point; there is no hook to dodge anywhere else. (Same guard sync.js uses.)
const earlySet = typeof localStorage !== 'undefined' ? localStorage.setItem.bind(localStorage) : null
const rawSet = (k, v) => (earlySet || localStorage.setItem.bind(localStorage))(k, v)

// → { at, value } or null. `at` is when it was stored, so callers can decide
// whether a cached copy is fresh enough to skip the refetch entirely.
export function readCache(key) {
  let entry
  try { entry = JSON.parse(localStorage.getItem(PREFIX + key)) } catch { return null }
  if (!entry || typeof entry.at !== 'number' || !('value' in entry)) return null
  return entry
}

export const cachedValue = (key) => readCache(key)?.value ?? null
export const cacheAge = (key) => {
  const e = readCache(key)
  return e ? Date.now() - e.at : Infinity
}

// Oldest write wins the eviction, using the `at` each entry already carries.
// An entry that will not parse has no `at` and goes first — it is unreadable to
// readCache anyway. Returns false once there is nothing left to reclaim.
// ponytail: O(n) scan per eviction, n = cached keys (a few hundred at worst).
// Oldest-WRITTEN, not least-recently-used; `at` is the only timestamp stored,
// and it already sorts stale months ahead of the ranges in current use.
function evictOldest() {
  let victim = null
  let oldest = Infinity
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith(PREFIX)) continue
    let at
    try { at = JSON.parse(localStorage.getItem(k))?.at } catch { at = 0 }
    if (typeof at !== 'number') at = 0
    if (at < oldest) { oldest = at; victim = k }
  }
  if (victim) localStorage.removeItem(victim)
  return !!victim
}

// Store `raw` under `key`, reclaiming space from the cache until it fits.
// Shared with the Google connection flag in email.js, which is tiny but must
// not be the one write that loses to a cache full of last spring's calendar.
export function setWithEviction(key, raw) {
  for (;;) {
    try { rawSet(key, raw); return true } catch { /* full — reclaim and retry */ }
    if (!evictOldest()) return false
  }
}

// Best-effort by design: an unserializable value costs a spinner next launch,
// never a broken write path. A failure now DELETES any previous copy: showing
// last week's grades as if they were today's is worse than showing a spinner,
// and silently keeping them is exactly how this went unnoticed.
export function writeCache(key, value) {
  let raw
  try { raw = JSON.stringify({ at: Date.now(), value }) } catch { raw = null }
  // One rule for every failure — unserializable, oversized, or no room left.
  if (!raw || raw.length > MAX_BYTES || !setWithEviction(PREFIX + key, raw)) {
    localStorage.removeItem(PREFIX + key)
    return false
  }
  return true
}

export function clearCache() {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(PREFIX)) localStorage.removeItem(k)
  }
}
