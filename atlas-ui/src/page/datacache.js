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

// localStorage is a ~5MB budget shared with the real data, so an oversized
// payload is simply not cached rather than being allowed to crowd it out.
// ponytail: no eviction policy — the key set is fixed and small (a handful,
// one per plugin view). Move to IndexedDB if payloads outgrow this.
const MAX_BYTES = 400_000

// Captured before main.js wraps setItem. Cache keys are outside the synced
// namespace anyway, but going through the hook would still add them to
// writtenSinceBoot and wrongly shadow a real key of the same name.
const rawSet = localStorage.setItem.bind(localStorage)

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

// Best-effort by design: a full quota or an unserializable value costs a
// spinner next launch, never a broken write path.
export function writeCache(key, value) {
  let raw
  try { raw = JSON.stringify({ at: Date.now(), value }) } catch { return false }
  if (raw.length > MAX_BYTES) return false
  try { rawSet(PREFIX + key, raw); return true } catch { return false }
}

export function clearCache() {
  for (const k of Object.keys(localStorage)) {
    if (k.startsWith(PREFIX)) localStorage.removeItem(k)
  }
}
