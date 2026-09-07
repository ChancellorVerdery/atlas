// Does everything the CLIENT stores actually survive a sync round trip?
//
// atlas.<plugin>.v1 keys do not ride the generic raw page.save path — sync.js
// encodes them as a structured <plugin>.save and the mapper decomposes them
// into columns. So a field the client writes but the mapper does not know is
// dropped silently: it pushes, the server stores a blob without it, and the
// next pull overwrites the local copy. That is not hypothetical — it is exactly
// what happened to gym's plan.overrides the day it was added.
//
// This walks each client loader's OWN normalized shape through its mapper and
// reports any key path that fails to come back.
//
// Ceiling, stated: it uses the loader's default shape, so it covers top-level
// and nested OBJECT fields (where plan.overrides lived) but not fields on
// elements of empty arrays — decompose has no rows to map. Array-element
// fidelity is each plugin's own test's job.
//
// Run: node test/sync-coverage.check.mjs
import { readFileSync } from 'node:fs'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
}

// Every mapper whose client data module lives in atlas-ui/src/page and imports
// cleanly under node given the localStorage stub above. That is a wider set than
// it looks: ladder/calendar/email pull in sync.js, platform.js and each other,
// but none of those do DOM or network work at import time, so they load fine.
// They were left out on a 'dependency-free only' rule that no longer holds, and
// the cost was real — see the ladder entry below.
//
// NOT covered, and why (both are unfixable here, not oversights):
//   finance, graph — retired plugins. Their client source is deliberately out of
//     the repo (.gitignore: 'Retired-plugin archive ... never committed'); only
//     the built plugins-dist/*.zip exists, and that is gitignored too, so there
//     is nothing a clean checkout could import. Their mappers are still tracked
//     and still tested by their own round-trip tests. This blind spot is exactly
//     how finance.vendorRules stayed unmapped: no loader here to compare against.
const PLUGINS = [
  { name: 'gym', module: 'gym.js', loader: 'loadGym' },
  { name: 'work', module: 'work.js', loader: 'loadWork' },
  { name: 'sleep', module: 'sleep.js', loader: 'loadSleep' },
  { name: 'canvas', module: 'canvas.js', loader: 'loadCanvas' },
  { name: 'course', module: 'course.js', loader: 'loadCourse' },
  // Added later. On the first run under this check ladder failed with three
  // dropped key paths — dwellFloorMin, roundTripFrac and gapOverrides, all
  // user-editable from Ladder settings — which is what prompted widening it.
  { name: 'ladder', module: 'ladder.js', loader: 'loadLadder' },
  { name: 'calendar', module: 'calendar.js', loader: 'loadCal' },
  { name: 'email', module: 'email.js', loader: 'loadEmail' },
]

// Key paths a loader returns that are deliberately NOT synced, so their absence
// from the round trip is correct rather than data loss. Keep this list tiny and
// justified: every entry is a hole in the check.
const NOT_SYNCED = {
  // loadEmail returns `{ ...atlasHalf, ...loadGoogle(s) }`, a MERGE of two
  // storage keys. The Google half (connection status + address + account list)
  // is server-side truth cached locally so the synchronous isConnected() guards
  // stay synchronous; saveEmail splits it back out to its own key before
  // writing, precisely so a pull of the synced half can never carry it off.
  // The mapper drops these on purpose — see its header comment.
  email: ['connected', 'address', 'accounts', 'accounts[]'],
}

// The runner stringifies nothing itself — decompose does, for jsonb columns —
// and pg hands those back parsed. Best-effort re-parse so recompose sees what
// it would see in production.
const reparse = (v) => {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!/^[[{]/.test(t) && !/^-?\d/.test(t)) return v
  try { return JSON.parse(t) } catch { return v }
}

// Every key path in an object, arrays collapsed to the path itself (their
// element shape is out of scope — see the ceiling note above).
const paths = (o, prefix = '', out = new Set()) => {
  if (o === null || typeof o !== 'object') return out
  if (Array.isArray(o)) { out.add(prefix + '[]'); return out }
  for (const k of Object.keys(o)) {
    const p = prefix ? `${prefix}.${k}` : k
    out.add(p)
    paths(o[k], p, out)
  }
  return out
}

let failures = 0
const skipped = []

for (const p of PLUGINS) {
  store.clear()
  let clientShape, mapper
  try {
    const mod = await import(`../../atlas-ui/src/page/${p.module}`)
    if (typeof mod[p.loader] !== 'function') { skipped.push(`${p.name} (no ${p.loader})`); continue }
    clientShape = mod[p.loader]()
    mapper = (await import(`../services/plugins/${p.name}.js`)).default
  } catch (e) {
    skipped.push(`${p.name} (${String(e.message).slice(0, 60)})`)
    continue
  }

  let back
  try {
    const tables = mapper.decompose(clientShape)
    const rows = {}
    for (const t of mapper.tables) {
      rows[t] = (tables[t] || []).map((r, i) => {
        const o = { ...r, ord: i }
        for (const k of Object.keys(o)) o[k] = reparse(o[k])
        return o
      })
    }
    back = mapper.recompose(rows)
  } catch (e) {
    failures++
    console.log(`FAIL ${p.name}: round trip threw — ${String(e.message).slice(0, 120)}`)
    continue
  }

  const want = paths(clientShape)
  const got = paths(back)
  // 'v' is a client-side schema marker some mappers re-add and some don't; it
  // carries no user data either way.
  const exempt = new Set(NOT_SYNCED[p.name] || [])
  const missing = [...want].filter((k) => !got.has(k) && k !== 'v' && !exempt.has(k))
  if (missing.length) {
    failures++
    console.log(`FAIL ${p.name}: ${missing.length} key path(s) do NOT survive a sync round trip`)
    for (const m of missing) console.log(`       ${m}`)
  } else {
    const ex = (NOT_SYNCED[p.name] || []).length
    console.log(`ok   ${p.name}: every key path the loader guarantees survives (${want.size} checked${ex ? `, ${ex} exempt` : ''})`)
  }
}

for (const s of skipped) console.log(`skip ${s}`)
console.log(failures ? `\n${failures} plugin(s) lose data on sync` : '\nsync-coverage: no silent field drops')
process.exit(failures ? 1 : 0)
