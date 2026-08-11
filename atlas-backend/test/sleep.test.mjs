// Round-trip test for the sleep mapper: recompose(simulatePg(decompose(S))) === S
// for states the plugin's own loader (atlas-ui/src/page/sleep.js loadSleep) produces.

import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/sleep.js'

// Columns declared jsonb in the DDL — pg returns them parsed.
const JSONB = { logs: ['quality'] }

// Mimic the runner + pg: deep-clone rows, stamp user_id/ord (recompose must
// ignore them), map undefined → NULL, parse jsonb columns.
function simulatePg(byTable) {
  const out = {}
  for (const t of mapper.tables) {
    out[t] = (byTable[t] || []).map((r, i) => {
      const row = structuredClone(r)
      for (const k of Object.keys(row)) if (row[k] === undefined) row[k] = null
      for (const col of JSONB[t] || []) row[col] = JSON.parse(row[col])
      return { ...row, user_id: '00000000-0000-0000-0000-000000000001', ord: i }
    })
  }
  return out
}

const roundTrip = (name, S) => {
  deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(S))), S, name)
  console.log(`  pass: ${name}`)
}

// ---- 1. exact default state loadSleep() produces from empty storage ---------

const defaults = {
  prefMin: 480,
  bedtime: '23:00',
  windowDays: 7,
  ratio: 1.2,
  napCredit: 50,
  recoverNights: 3,
  logs: [],
}
roundTrip('default empty-storage state', defaults)

// ---- 2. rich state exercising every field and edge case ---------------------

const rich = {
  prefMin: 412.5,                 // loader only requires finite > 0 (imported non-integer)
  bedtime: '9:30',                // hmToMin accepts unpadded hours — loader keeps it as-is
  windowDays: 30,
  ratio: 1.75,
  napCredit: 37.5,                // settings UI accepts non-integer percentages
  recoverNights: 1,
  logs: [
    // night, cross-midnight, rated 5
    { id: 'sl-a1b2c', type: 'night', date: '2026-07-01', start: '23:30', end: '07:00', minutes: 450, quality: 5 },
    // night, unrated (quality key ABSENT), zero-length-avoiding same-day span
    { id: 'sl-d3e4f', type: 'night', date: '2026-07-01', start: '01:15', end: '03:00', minutes: 105 },
    // second+third log on the SAME date as above — multiple logs per date are legal
    { id: 'sl-g5h6i', type: 'nap', date: '2026-07-01', minutes: 20, quality: 1 },
    // nap, unrated, fractional minutes (loader-valid imported data)
    { id: 'sl-j7k8l', type: 'nap', date: '2026-07-02', minutes: 12.5 },
    // imported log with NO type key at all — loader filter never checks type
    { id: 'sl-ünïcode-鍵', date: '2026-07-03', minutes: 480 },
    // night whose bed/wake are the midnight edges minToHM canonicalizes
    { id: 'sl-m9n0o', type: 'night', date: '2026-07-04', start: '00:00', end: '23:59', minutes: 1439, quality: 3 },
  ],
}
roundTrip('rich edge-case state', rich)

// ---- 3. realistic multi-row usage state --------------------------------------

const real = {
  prefMin: 480,
  bedtime: '23:00',
  windowDays: 7,
  ratio: 1.2,
  napCredit: 50,
  recoverNights: 3,
  logs: [
    { id: 'sl-mc1aa', type: 'night', date: '2026-06-30', start: '23:10', end: '06:45', minutes: 455, quality: 4 },
    { id: 'sl-mc2bb', type: 'night', date: '2026-07-01', start: '00:30', end: '07:00', minutes: 390, quality: 2 },
    { id: 'sl-mc3cc', type: 'nap', date: '2026-07-01', minutes: 35 },
    { id: 'sl-mc4dd', type: 'night', date: '2026-07-02', start: '23:00', end: '07:30', minutes: 510, quality: 5 },
    { id: 'sl-mc5ee', type: 'night', date: '2026-07-03', start: '23:45', end: '06:15', minutes: 390 },
    { id: 'sl-mc6ff', type: 'nap', date: '2026-07-03', minutes: 90, quality: 3 },
    { id: 'sl-mc7gg', type: 'night', date: '2026-07-04', start: '22:50', end: '07:05', minutes: 495, quality: 4 },
    { id: 'sl-mc8hh', type: 'night', date: '2026-07-05', start: '23:30', end: '06:30', minutes: 420 },
  ],
}
roundTrip('realistic usage state', real)

// ---- 4. regression: loader-lenient type/quality/date must not fail the save --
// loadSleep's log filter is ONLY id + truthy date + finite minutes > 0; type,
// quality and the date FORMAT are never validated. The DDL therefore has no
// CHECK on type, stores quality as jsonb (0, 7, 2.5, strings are loader-valid)
// and date as text (non-ISO '07/01/2026' is loader-valid; '2026-7-1' must
// round-trip VERBATIM, not canonicalized to '2026-07-01' the way a `date`
// column would).

const lenient = {
  prefMin: 480, bedtime: '23:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3,
  logs: [
    { id: 'sl-t1', type: 'NAP', date: '2026-07-01', minutes: 30 },                    // case-mangled type
    { id: 'sl-t2', type: 'other', date: '2026-07-01', minutes: 45 },                  // foreign type
    { id: 'sl-q0', type: 'nap', date: '2026-07-02', minutes: 20, quality: 0 },        // below 1..5
    { id: 'sl-q7', type: 'night', date: '2026-07-02', minutes: 400, quality: 7 },     // above 1..5
    { id: 'sl-q25', type: 'night', date: '2026-07-03', minutes: 410, quality: 2.5 },  // non-integer
    { id: 'sl-qs', type: 'night', date: '2026-07-03', minutes: 420, quality: 'great' }, // string quality
    { id: 'sl-d1', type: 'night', date: '07/01/2026', minutes: 430 },                 // non-ISO date
    { id: 'sl-d2', type: 'night', date: '2026-7-1', minutes: 440 },                   // unpadded — verbatim
  ],
}
roundTrip('loader-lenient type/quality/date values', lenient)

// ---- 5. regression: duplicate log ids are loader-valid ----------------------
// loadSleep never dedupes (the UI tolerates copies: removeLog filters all,
// creditedFor sums both), so logs has NO primary key on id — both rows
// must be stored and round-trip. Deduping would change the app's debt math.

const dupIds = {
  prefMin: 480, bedtime: '23:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3,
  logs: [
    { id: 'sl-dup', type: 'night', date: '2026-07-04', start: '23:00', end: '07:00', minutes: 480, quality: 4 },
    { id: 'sl-dup', type: 'night', date: '2026-07-04', start: '23:00', end: '07:00', minutes: 480, quality: 4 },
    { id: 'sl-dup', type: 'nap', date: '2026-07-05', minutes: 25 },
  ],
}
roundTrip('duplicate log ids survive (no PK, no dedupe)', dupIds)
if (mapper.decompose(dupIds).logs.length !== 3) throw new Error('duplicate-id logs were dropped')
console.log('  pass: decompose keeps all duplicate-id rows')

// ---- 6. regression: raw legacy blob decomposes like loadSleep loads ---------
// Raw blobs bypass the loader (importAll / backup restore): missing settings
// keys take the loader defaults, and logs the loader would drop (no id,
// minutes <= 0, non-object) are dropped — recompose returns the
// loader-normalized shape, the same one the app sees after its next load.

deepStrictEqual(
  mapper.recompose(simulatePg(mapper.decompose({
    logs: [
      { id: 'sl-x', date: '2026-07-01', minutes: 0 },   // minutes not > 0 → dropped
      { date: '2026-07-01', minutes: 60 },              // no id → dropped
      'junk',                                           // non-object → dropped
      { id: 'sl-keep', date: '2026-07-01', minutes: 60 },
    ],
  }))),
  { ...defaults, logs: [{ id: 'sl-keep', date: '2026-07-01', minutes: 60 }] },
  'raw legacy blob normalizes like loadSleep',
)
console.log('  pass: raw legacy blob normalizes like loadSleep')

// Sanity: decompose leaves the runner room to stamp user_id/ord.
for (const [t, rowsArr] of Object.entries(mapper.decompose(rich))) {
  for (const r of rowsArr) {
    if ('user_id' in r || 'ord' in r) throw new Error(`${t} row leaks user_id/ord`)
  }
}
console.log('  pass: decompose never emits user_id/ord')

console.log('OK sleep')
