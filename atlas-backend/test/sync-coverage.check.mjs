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

// Only plugins whose client data module is dependency-free (no sync.js /
// platform.js / DOM), so it can be imported straight into node.
const PLUGINS = [
  { name: 'gym', module: 'gym.js', loader: 'loadGym' },
  { name: 'work', module: 'work.js', loader: 'loadWork' },
  { name: 'sleep', module: 'sleep.js', loader: 'loadSleep' },
  { name: 'canvas', module: 'canvas.js', loader: 'loadCanvas' },
  { name: 'course', module: 'course.js', loader: 'loadCourse' },
]

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
  const missing = [...want].filter((k) => !got.has(k) && k !== 'v')
  if (missing.length) {
    failures++
    console.log(`FAIL ${p.name}: ${missing.length} key path(s) do NOT survive a sync round trip`)
    for (const m of missing) console.log(`       ${m}`)
  } else {
    console.log(`ok   ${p.name}: every key path the loader guarantees survives (${want.size} checked)`)
  }
}

for (const s of skipped) console.log(`skip ${s}`)
console.log(failures ? `\n${failures} plugin(s) lose data on sync` : '\nsync-coverage: no silent field drops')
process.exit(failures ? 1 : 0)
