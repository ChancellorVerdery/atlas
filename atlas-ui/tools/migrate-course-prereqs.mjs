#!/usr/bin/env node
// One-off migration: fold the retired `preOrCo` course-requirement bucket into
// `coreqs` (they were functionally identical — course.js's coOf() already
// unioned coreqs+preOrCo before this cleanup, so this just makes the stored
// data match the app's new two-bucket model). Pure Node, no dependencies,
// runs OUTSIDE the Atlas app on an exported `atlas.course.v1` JSON blob — the
// app itself carries no migration/normalization code for this.
//
// Usage:
//   1. Export the course-planner data, e.g. from the browser devtools console
//      on the Atlas app: copy(localStorage.getItem('atlas.course.v1'))
//      then paste into a file, e.g. course-export.json.
//   2. Run:
//        node tools/migrate-course-prereqs.mjs course-export.json course-migrated.json
//      (omit the input path to read stdin, omit the output path to write stdout)
//        cat course-export.json | node tools/migrate-course-prereqs.mjs > course-migrated.json
//   3. Paste course-migrated.json's contents back into localStorage under the
//      same key: localStorage.setItem('atlas.course.v1', JSON.stringify(<data>))
//
// Self-check (no file I/O, just asserts):
//   node tools/migrate-course-prereqs.mjs --self-check

import { readFileSync, writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'

// Combine coreqs + preOrCo into one list: original coreqs first, then any
// preOrCo entries not already present, deduped case/whitespace-insensitively
// (matching course.js's own `norm()` matching), order preserved.
function mergeCoreqs(coreqs, preOrCo) {
  const seen = new Set()
  const out = []
  for (const raw of [...(Array.isArray(coreqs) ? coreqs : []), ...(Array.isArray(preOrCo) ? preOrCo : [])]) {
    const v = String(raw ?? '').trim()
    const key = v.toLowerCase()
    if (!v || seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

// Drop `preOrCo`, fold it into `coreqs` in place (or add a `coreqs` key if the
// course only ever had `preOrCo`), leave every other field untouched.
function migrateCourse(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) return c
  const hadPreOrCo = 'preOrCo' in c
  if (!hadPreOrCo) return c // nothing to do — don't touch fields/order
  const out = {}
  let wroteCoreqs = false
  for (const key of Object.keys(c)) {
    if (key === 'preOrCo') continue
    if (key === 'coreqs') { out.coreqs = mergeCoreqs(c.coreqs, c.preOrCo); wroteCoreqs = true; continue }
    out[key] = c[key]
  }
  if (!wroteCoreqs) out.coreqs = mergeCoreqs(undefined, c.preOrCo)
  return out
}

function migrate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data
  const out = { ...data }
  if (Array.isArray(data.courses)) out.courses = data.courses.map(migrateCourse)
  return out
}

function readInput(path) {
  const raw = path ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8')
  return JSON.parse(raw)
}

function runSelfCheck() {
  // 1) preOrCo only (no coreqs key at all) → becomes coreqs
  assert.deepEqual(
    migrateCourse({ id: 'c1', code: 'MATH2', preOrCo: ['MATH1'] }),
    { id: 'c1', code: 'MATH2', coreqs: ['MATH1'] },
    'preOrCo-only course should move its refs into a new coreqs field',
  )

  // 2) a code present in both coreqs and preOrCo → deduped, coreqs order first
  assert.deepEqual(
    migrateCourse({ id: 'c2', coreqs: ['CS101', 'CS102'], preOrCo: ['cs102', 'CS103'] }),
    { id: 'c2', coreqs: ['CS101', 'CS102', 'CS103'] },
    'overlapping coreqs/preOrCo entries should be deduped (case/space-insensitive)',
  )

  // 3) no preOrCo field at all → course object returned untouched (same fields/order)
  const untouched = { id: 'c3', code: 'PHYS1', coreqs: ['MATH1'], prereqs: [] }
  assert.deepEqual(migrateCourse(untouched), untouched, 'course without preOrCo should be untouched')

  // 3b) empty preOrCo array (field present but empty) → coreqs unchanged, preOrCo dropped
  assert.deepEqual(
    migrateCourse({ id: 'c4', coreqs: ['A'], preOrCo: [] }),
    { id: 'c4', coreqs: ['A'] },
    'empty preOrCo should just be dropped, coreqs left as-is',
  )

  // 4) other fields (code, title, credits, prereqs, summerOk, term) preserved
  const full = {
    id: 'c5', code: 'ENGR301', title: 'Statics', credits: 3,
    prereqs: ['PHYS250'], coreqs: ['MATH241'], preOrCo: ['MATH241', 'MATH242'],
    summerOk: true, term: null,
  }
  assert.deepEqual(
    migrateCourse(full),
    { id: 'c5', code: 'ENGR301', title: 'Statics', credits: 3, prereqs: ['PHYS250'], coreqs: ['MATH241', 'MATH242'], summerOk: true, term: null },
    'unrelated fields must survive the migration untouched',
  )

  // top-level migrate() maps courses and leaves other top-level keys alone
  const doc = { courses: [{ id: 'c6', preOrCo: ['X'] }], terms: [{ key: 'fall-2026' }], settings: { maxCredits: 15 } }
  assert.deepEqual(
    migrate(doc),
    { courses: [{ id: 'c6', coreqs: ['X'] }], terms: [{ key: 'fall-2026' }], settings: { maxCredits: 15 } },
    'migrate() should only rewrite courses[], leaving terms/settings/etc. alone',
  )

  // non-course-shaped input passes through unchanged rather than throwing
  assert.deepEqual(migrate({ foo: 'bar' }), { foo: 'bar' }, 'input without a courses array should pass through')

  console.log('self-check: all assertions passed')
}

function main() {
  const [a2, a3] = process.argv.slice(2)
  if (a2 === '--self-check') { runSelfCheck(); return }
  const data = readInput(a2)
  const migrated = migrate(data)
  const json = JSON.stringify(migrated, null, 2) + '\n'
  if (a3) writeFileSync(a3, json)
  else process.stdout.write(json)
}

try {
  main()
} catch (err) {
  console.error(`migrate-course-prereqs failed: ${err.message}`)
  process.exit(1)
}
