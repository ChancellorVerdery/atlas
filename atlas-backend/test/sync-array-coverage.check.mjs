// Do fields on ARRAY ELEMENTS survive a sync round trip?
//
// sync-coverage.check.mjs states its own ceiling: it feeds each mapper the
// loader's DEFAULT shape, so every array is empty and `paths()` collapses it to
// a bare `foo[]`. Element fields are therefore invisible to it — and Pass 1's
// notes call that "the gap most likely to hide a live bug", because it is the
// same silent-drop class as gym's plan.overrides and ladder's dwellFloorMin,
// just one level down.
//
// This file closes it. Each plugin gets a SEEDED localStorage payload with at
// least one element in every array, run through the plugin's own loader (so the
// loader — not this file — decides the normalized truth), then decomposed and
// recomposed. Any key path that fails to come back is a dropped field.
//
// Fixture provenance: every element field below is copied from the UI writer
// that creates it, cited inline. They are not invented, and a field the UI never
// writes is deliberately absent — a fixture richer than reality would report
// drops that cannot happen.
//
// It also answers the NEXT question down: a field can survive as a key path and
// still come back with a different VALUE. So the round trip is deep-compared,
// and any changed value fails too.
//
// Run: node test/sync-array-coverage.check.mjs

// Fixtures, the localStorage stub, the retired list and the sync exemptions all
// live in plugin-seeds.mjs, shared with ddl-columns.check.mjs so neither check
// can drift behind the other as UI writers gain fields.
import { PLUGINS, NOT_SYNCED, ALSO_ADDED, RETIRED, RETIRED_FIXTURES, seedFor } from './plugin-seeds.mjs'




// Which columns pg hands back already-parsed. ONLY jsonb: decompose stringifies
// those and pg parses them, so the harness must re-parse to match. text and
// numeric columns come back as-is, and re-parsing them is how a harness invents
// a bug that cannot happen — a first cut of this file reported canvas
// semesters.gpa '3.8' -> 3.8 as a silent corruption. It is a text column
// (canvas.js:89) holding a deliberately RAW input string; the only thing that
// turned it into a number was the reparse below. Scope it, or it lies.
const jsonbColumns = (ddl) => {
  const out = new Set()
  let tbl = null
  for (const raw of String(ddl).split('\n')) {
    const line = raw.trim()
    const ct = line.match(/^CREATE TABLE (?:IF NOT EXISTS )?([\w.]+)/i)
    if (ct) { tbl = ct[1].split('.').pop(); continue }
    const al = line.match(/^ALTER TABLE ([\w.]+)/i)
    if (al) { tbl = al[1].split('.').pop(); continue }
    const col = line.match(/^(?:ADD COLUMN (?:IF NOT EXISTS )?)?(\w+)\s+jsonb\b/i)
    if (col && tbl) out.add(tbl + '.' + col[1])
  }
  return out
}


const reparse = (v) => {
  if (typeof v !== 'string') return v
  const t = v.trim()
  if (!/^[[{]/.test(t) && !/^-?\d/.test(t)) return v
  try { return JSON.parse(t) } catch { return v }
}

// Unlike sync-coverage's paths(), this DESCENDS into array elements, unioning
// every element's key paths under a single `foo[]` prefix. Union, not
// per-index: element shapes are legitimately heterogeneous (a sleep nap has no
// start/end; an 'attached' flex block has no date), and the question being asked
// is "can this field ever be dropped", not "does every element have it".
const paths = (o, prefix = '', out = new Set()) => {
  if (o === null || typeof o !== 'object') return out
  if (Array.isArray(o)) {
    out.add(prefix + '[]')
    for (const el of o) {
      if (el === null || typeof el !== 'object') continue
      paths(el, prefix + '[]', out)
    }
    return out
  }
  for (const k of Object.keys(o)) {
    const p = prefix ? `${prefix}.${k}` : k
    out.add(p)
    paths(o[k], p, out)
  }
  return out
}

// One simulated sync: decompose -> what pg would hand back -> recompose. jsonb
// columns are re-parsed (pg does that); nothing else is, per the scoping note
// above. Shared by the loader-driven arm below and the retired raw-fixture arm.
const roundTrip = (mapper, shape) => {
  const jsonb = jsonbColumns(mapper.ddl)
  const tables = mapper.decompose(shape)
  const rows = {}
  for (const t of mapper.tables) {
    rows[t] = (tables[t] || []).map((r, i) => {
      const o = { ...r, ord: i }
      for (const k of Object.keys(o)) if (jsonb.has(t + '.' + k)) o[k] = reparse(o[k])
      return o
    })
  }
  return mapper.recompose(rows)
}

// Value fidelity. Only keys present on BOTH sides are compared -- a key that
// vanished is the path check's job, and reporting it twice buries the signal.
// Type is part of the value: '45' and 45 are not interchangeable to a loader
// whose gate is a range test on the raw value.
const valueDiffs = (a0, b0) => {
  const diffs = []
  const walk = (a, b, path) => {
    if (Array.isArray(a)) {
      if (!Array.isArray(b)) { diffs.push(`${path}: array -> ${typeof b}`); return }
      if (a.length !== b.length) diffs.push(`${path}: length ${a.length} -> ${b.length}`)
      a.forEach((x, i) => { if (i < b.length) walk(x, b[i], `${path}[${i}]`) })
      return
    }
    if (a !== null && typeof a === 'object') {
      if (b === null || typeof b !== 'object') { diffs.push(`${path}: object -> ${b === null ? 'null' : typeof b}`); return }
      for (const k of Object.keys(a)) if (k in b) walk(a[k], b[k], path ? `${path}.${k}` : k)
      return
    }
    if (a !== b || typeof a !== typeof b) {
      diffs.push(`${path}: ${JSON.stringify(a)} (${typeof a}) -> ${JSON.stringify(b)} (${typeof b})`)
    }
  }
  walk(a0, b0, '')
  return diffs
}

// The ASYMMETRY the path check used to have: `missing` only ever asked whether
// an input path came back, so a mapper that INVENTS a path the loader never
// produced was invisible to it. That is not automatically a bug — a recompose
// filling in a default is ordinary — but it is how a shape drifts away from the
// loader's, and the localStorage blob the UI reads back is supposed to be the
// loader's shape, not the mapper's idea of it.
//
// Surveyed before being enforced: at the seeded-fixture depth all 10 mappers add
// exactly ZERO paths today. So this starts from a clean baseline and any addition
// is new, which is what makes failing on it the right severity rather than a note
// nobody reads. A deliberate default goes in ALSO_ADDED with its reason, the same
// way NOT_SYNCED holds email's deliberate drops.
const addedPaths = (name, want, got) => {
  const ok = new Set(ALSO_ADDED[name] || [])
  return [...got].filter((k) => !want.has(k) && !ok.has(k))
}

let failures = 0
const skipped = []

{
  const { readdirSync } = await import('node:fs')
  const onDisk = readdirSync(new URL('../services/plugins/', import.meta.url))
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.slice(0, -3))
    .sort()
  const accounted = new Set([...PLUGINS.map((p) => p.name), ...RETIRED])
  const unaccounted = onDisk.filter((n) => !accounted.has(n))
  if (unaccounted.length) {
    failures++
    console.log(`FAIL coverage drift: mapper(s) in services/plugins with no entry here — ${unaccounted.join(', ')}`)
    console.log('       add to PLUGINS (with a loader + seed) or to RETIRED with a reason')
  } else {
    console.log(`ok   coverage: ${onDisk.length} mappers on disk — ${PLUGINS.length} exercised, ${RETIRED.length} retired (${RETIRED.join(', ')})`)
  }
}

for (const p of PLUGINS) {
  seedFor(p)

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

  // A fixture the loader rejected tests nothing. Catching it here is what stops
  // this check from quietly degrading into the empty-array case it exists to fix.
  const emptied = Object.keys(p.seed).filter(
    (k) => Array.isArray(p.seed[k]) && p.seed[k].length && !(Array.isArray(clientShape[k]) && clientShape[k].length),
  )
  if (emptied.length) {
    failures++
    console.log(`FAIL ${p.name}: loader discarded fixture rows for ${emptied.join(', ')} — fixture is wrong, not the mapper`)
    continue
  }

  let back
  try {
    back = roundTrip(mapper, clientShape)
  } catch (e) {
    failures++
    console.log(`FAIL ${p.name}: round trip threw — ${String(e.message).slice(0, 160)}`)
    continue
  }

  const diffs = valueDiffs(clientShape, back)
  if (diffs.length) {
    failures++
    console.log(`FAIL ${p.name}: ${diffs.length} value(s) change across a sync round trip`)
    for (const x of diffs) console.log(`       ${x}`)
  }

  const want = paths(clientShape)
  const got = paths(back)
  const exempt = new Set(NOT_SYNCED[p.name] || [])
  const missing = [...want].filter((k) => !got.has(k) && k !== 'v' && !exempt.has(k))
  const added = addedPaths(p.name, want, got)
  const elem = [...want].filter((k) => k.includes('[].')).length
  if (missing.length) {
    failures++
    console.log(`FAIL ${p.name}: ${missing.length} key path(s) do NOT survive a sync round trip`)
    for (const m of missing) console.log(`       ${m}`)
  }
  if (added.length) {
    failures++
    console.log(`FAIL ${p.name}: ${added.length} key path(s) are ADDED by the round trip`)
    for (const a of added) console.log(`       ${a}`)
    console.log('       if this is a deliberate default, list it in ALSO_ADDED with a reason')
  }
  if (!missing.length && !added.length && !diffs.length) {
    console.log(`ok   ${p.name}: ${want.size} paths survive unchanged (${elem} on array elements)`)
  }
}

// --- Retired plugins -------------------------------------------------------
// No loader in tree, so the fixture IS the shape (see RETIRED_FIXTURES for its
// provenance and its limits). finance's 9 tables were the last in the repo that
// nothing reached, and finance is where vendorRules was silently dropped.
//
// Two things are asserted, in this order, because the first is what makes the
// second trustworthy:
//   1. IDEMPOTENCE -- a second round trip must equal the first. The fixture is
//      hand-written, so "the fixture was never normalized" is a live way for
//      this arm to lie. If the mapper is a fixed point on its own output but the
//      fixture differs from it, the fixture is the wrong one, and that is
//      reported as a FIXTURE fault, not a mapper fault.
//   2. Fields survive -- same path + value comparison as the loader-driven arm.
for (const name of RETIRED) {
  const fx = RETIRED_FIXTURES[name]
  if (!fx) { skipped.push(`${name} (retired, no raw fixture — tables unchecked)`); continue }

  let mapper, back, again
  try {
    mapper = (await import(`../services/plugins/${name}.js`)).default
    back = roundTrip(mapper, fx)
    again = roundTrip(mapper, back)
  } catch (e) {
    failures++
    console.log(`FAIL ${name} (retired): round trip threw — ${String(e.message).slice(0, 160)}`)
    continue
  }

  const unstable = valueDiffs(back, again)
  if (unstable.length) {
    failures++
    console.log(`FAIL ${name} (retired): round trip is not idempotent — ${unstable.length} value(s) still moving on the 2nd pass`)
    for (const x of unstable.slice(0, 10)) console.log(`       ${x}`)
    continue
  }

  const diffs = valueDiffs(fx, back)
  const want = paths(fx)
  const got = paths(back)
  const missing = [...want].filter((k) => !got.has(k))
  const added = addedPaths(name, want, got)
  if (diffs.length || missing.length || added.length) {
    failures++
    // The mapper is idempotent on its own output, so a difference here is
    // either a real drop or a fixture that was never in normalized form. Say
    // which is suspected instead of guessing: a MISSING top-level key is the
    // vendorRules class (mapper forgot a field); a changed value on a key both
    // sides have is more often the fixture holding a shape the loader would
    // have normalized away.
    console.log(`FAIL ${name} (retired): ${missing.length} path(s) lost, ${added.length} added, ${diffs.length} value(s) changed`)
    for (const m of missing) console.log(`       lost:    ${m}`)
    for (const a of added) console.log(`       added:   ${a}`)
    for (const x of diffs) console.log(`       changed: ${x}`)
    console.log('       mapper is idempotent on its own output, so check the fixture against')
    console.log(`       the "Blob shape" header in services/plugins/${name}.js before blaming the mapper`)
  } else {
    const elem = [...want].filter((k) => k.includes('[].')).length
    console.log(`ok   ${name} (retired): ${want.size} paths survive unchanged (${elem} on array elements), round trip idempotent`)
  }
}

for (const s of skipped) console.log(`skip ${s}`)
console.log(failures
  ? `\n${failures} plugin(s) lose or corrupt data on sync`
  : '\nsync-array-coverage: no silent element-field drops, no value changes')
process.exit(failures ? 1 : 0)
