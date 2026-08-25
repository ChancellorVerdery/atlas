// Round-trip test for the gym mapper: recompose(simulatePg(decompose(S))) === S
// for states the plugin's own loader (atlas-ui/src/page/gym.js loadGym) produces.

import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/gym.js'

// Columns declared jsonb in the DDL — pg returns them parsed.
const JSONB = { settings: ['default_duration'], logs: ['sets'] }

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

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const allDays = make => Object.fromEntries(DAYS.map(d => [d, make(d)]))

// ---- 1. exact default state loadGym() produces from empty storage -----------

const defaults = {
  v: 1,
  workouts: [],
  exercises: [],
  logs: [],
  completions: [],
  plan: {
    type: 'weekly',
    weekly: allDays(() => null),
    cycle: { order: [], position: 0 },
    overrides: {},
    extras: {},
  },
  unit: 'kg',
  address: '',
  hours: allDays(() => ({ open: '', close: '' })),
  defaultDuration: 75,
}
roundTrip('default empty-storage state', defaults)

// ---- 2. rich state exercising every field and edge case ---------------------

const rich = {
  v: 1,
  workouts: [
    { id: 'gw-aaa11', name: 'Chest & Back' },                          // rest/flex keys ABSENT
    { id: 'gw-bbb22', name: 'Rest — Wüste 休息 🛌', rest: true, flex: true },
    { id: 'gw-ccc33', name: '', rest: false, flex: false },            // empty name, explicit falses
    { id: 'gw-ddd44', name: 'Legs', rest: false },                     // flex absent, rest false
  ],
  exercises: [
    { id: 'ge-e1', workoutId: 'gw-aaa11', name: 'Bench Press', unilateral: false, target: '3×8' },
    { id: 'ge-e2', workoutId: 'gw-aaa11', name: 'Übung: 引体向上 💪', unilateral: true, target: '' }, // target cleared to ''
    { id: 'ge-e3', workoutId: 'gw-ddd44', name: 'Squat', unilateral: false },  // target key absent
    { id: 'ge-e4', name: 'Imported orphan' },                          // workoutId + unilateral absent (loader tolerates)
  ],
  logs: [
    { id: 'gl-l1', exerciseId: 'ge-e1', date: '2026-07-01', side: null, sets: [{ weight: 60, reps: 8 }, { weight: 62.5, reps: 6 }] },
    { id: 'gl-l2', exerciseId: 'ge-e2', date: '2026-07-01', side: 'L', sets: [{ weight: 0, reps: 12 }] },   // bodyweight
    { id: 'gl-l3', exerciseId: 'ge-e2', date: '2026-07-01', side: 'R', sets: [{ weight: 0, reps: 11 }] },
    { id: 'gl-l4', exerciseId: 'ge-gone', date: '2026-06-15', side: null, sets: [{ weight: 45.359, reps: 5 }] }, // orphan (exercise deleted), 3dp kg
  ],
  completions: [
    { workoutId: 'gw-aaa11', date: '2026-07-01', ts: 1783017600123, start: '18:05', end: '19:22' },
    { workoutId: 'gw-gone', date: '2026-06-15', ts: 1781635200000, start: '', end: '' },  // deleted workout, untimed
  ],
  plan: {
    type: 'cycle',
    weekly: { mon: 'gw-aaa11', tue: null, wed: 'gw-ddd44', thu: null, fri: 'gw-aaa11', sat: null, sun: null },
    cycle: { order: ['gw-aaa11', 'gw-ddd44', 'gw-bbb22', 'gw-aaa11'], position: 2 },  // duplicate entry allowed
    overrides: {},
    extras: {},
  },
  unit: 'lbs',
  address: '123 Straße Ω, Kraków 🏋️',
  hours: {
    mon: { open: '06:00', close: '22:00' },
    tue: { open: '06:00', close: '22:00' },
    wed: { open: '', close: '' },
    thu: { open: '06:00', close: '' },      // half-set pair
    fri: { open: '', close: '23:59' },
    sat: { open: '08:00', close: '20:00' },
    sun: { open: '08:00', close: '20:00' },
  },
  defaultDuration: 62.5,                     // UI allows non-integer minutes
}
roundTrip('rich edge-case state', rich)

// ---- 3. realistic multi-row usage state --------------------------------------

const real = {
  v: 1,
  workouts: [
    { id: 'gw-push1', name: 'Push' },
    { id: 'gw-pull1', name: 'Pull' },
    { id: 'gw-legs1', name: 'Legs' },
    { id: 'gw-rest1', name: 'Rest', rest: true },
  ],
  exercises: [
    { id: 'ge-bp', workoutId: 'gw-push1', name: 'Bench Press', unilateral: false, target: '4×6' },
    { id: 'ge-op', workoutId: 'gw-push1', name: 'Overhead Press', unilateral: false },
    { id: 'ge-row', workoutId: 'gw-pull1', name: 'Barbell Row', unilateral: false },
    { id: 'ge-curl', workoutId: 'gw-pull1', name: 'DB Curl', unilateral: true, target: '3×10' },
    { id: 'ge-sq', workoutId: 'gw-legs1', name: 'Squat', unilateral: false },
    { id: 'ge-lu', workoutId: 'gw-legs1', name: 'Lunge', unilateral: true },
  ],
  logs: [
    { id: 'gl-1', exerciseId: 'ge-bp', date: '2026-06-29', side: null, sets: [{ weight: 80, reps: 6 }, { weight: 80, reps: 6 }, { weight: 82.5, reps: 4 }] },
    { id: 'gl-2', exerciseId: 'ge-op', date: '2026-06-29', side: null, sets: [{ weight: 45, reps: 8 }] },
    { id: 'gl-3', exerciseId: 'ge-curl', date: '2026-06-30', side: 'L', sets: [{ weight: 14, reps: 10 }, { weight: 14, reps: 9 }] },
    { id: 'gl-4', exerciseId: 'ge-curl', date: '2026-06-30', side: 'R', sets: [{ weight: 14, reps: 10 }, { weight: 14, reps: 10 }] },
    { id: 'gl-5', exerciseId: 'ge-row', date: '2026-06-30', side: null, sets: [{ weight: 70, reps: 8 }] },
    { id: 'gl-6', exerciseId: 'ge-sq', date: '2026-07-02', side: null, sets: [{ weight: 100, reps: 5 }, { weight: 100, reps: 5 }] },
    { id: 'gl-7', exerciseId: 'ge-bp', date: '2026-07-03', side: null, sets: [{ weight: 82.5, reps: 6 }] },
  ],
  completions: [
    { workoutId: 'gw-push1', date: '2026-06-29', ts: 1782841532000, start: '17:30', end: '18:45' },
    { workoutId: 'gw-pull1', date: '2026-06-30', ts: 1782927941000, start: '17:35', end: '18:40' },
    { workoutId: 'gw-legs1', date: '2026-07-02', ts: 1783100712000, start: '', end: '' },
    { workoutId: 'gw-push1', date: '2026-07-03', ts: 1783187123000, start: '18:00', end: '19:10' },
  ],
  plan: {
    type: 'weekly',
    weekly: { mon: 'gw-push1', tue: 'gw-pull1', wed: null, thu: 'gw-legs1', fri: 'gw-push1', sat: 'gw-rest1', sun: null },
    cycle: { order: ['gw-push1', 'gw-pull1', 'gw-legs1'], position: 1 },  // kept even while type=weekly
    overrides: {},
    extras: {},
  },
  unit: 'kg',
  address: '400 Gym St, Springfield',
  hours: {
    mon: { open: '05:00', close: '23:00' },
    tue: { open: '05:00', close: '23:00' },
    wed: { open: '05:00', close: '23:00' },
    thu: { open: '05:00', close: '23:00' },
    fri: { open: '05:00', close: '23:00' },
    sat: { open: '07:00', close: '21:00' },
    sun: { open: '07:00', close: '21:00' },
  },
  defaultDuration: 75,
}
roundTrip('realistic usage state', real)

// ---- 4. regression: raw (never-loaded) blobs must save without failing ------
// The wire carries raw localStorage: backup imports and first-login importAll
// skip loadGym entirely, so decompose must apply the loader's normalization
// itself. recompose then returns the loader-normalized shape.

const normTrip = (name, input, expected) => {
  deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(input))), expected, name)
  console.log(`  pass: ${name}`)
}

// 4a. legacy backup: hours is the old single {start,end} pair and plan/most
// keys are missing entirely (pre-migration app version). Previously: TypeError
// at g.plan.type + NOT NULL violation on hours.open.
normTrip(
  'legacy hours {start,end} + missing plan (raw backup import)',
  { hours: { start: '06:00', end: '22:00' } },
  {
    ...defaults,
    hours: allDays(() => ({ open: '06:00', close: '22:00' })),
  },
)

// 4b. duplicate (exercise, date, side) log entries are loader-valid (loadGym
// keeps both; logsFor picks the first). Previously: 23505 on gym_logs_key.
const dupLogs = {
  ...defaults,
  logs: [
    { id: 'gl-a', exerciseId: 'ge-1', date: '2026-07-06', side: null, sets: [{ weight: 50, reps: 5 }] },
    { id: 'gl-b', exerciseId: 'ge-1', date: '2026-07-06', side: null, sets: [{ weight: 55, reps: 3 }] },
  ],
}
roundTrip('duplicate exercise+date+side logs both survive', dupLogs)

// 4c. duplicate log IDS are also loader-valid (merged backups) — no PK.
roundTrip('duplicate log ids both survive', {
  ...defaults,
  logs: [
    { id: 'gl-same', exerciseId: 'ge-1', date: '2026-07-01', side: null, sets: [] },
    { id: 'gl-same', exerciseId: 'ge-2', date: '2026-07-02', side: null, sets: [] },
  ],
})

// 4d. loadGym's log filter only requires exerciseId + sets[]: no id, no date,
// free-text side. Previously: NOT NULL id/date + CHECK(side IN ('L','R')).
// Absent side comes back as side:null — logSet's own absent⇔null equivalence.
normTrip(
  'loader-lenient logs: missing id/date, side outside L/R',
  {
    ...defaults,
    logs: [
      { exerciseId: 'ge-1', sets: [{ weight: 50, reps: 5 }] },              // no id, no date, no side
      { id: 'gl-x', exerciseId: 'ge-1', date: '2026-07-06', side: 'left', sets: [] }, // side free text
      { id: 'gl-y', exerciseId: 'ge-1', date: '07/04/2026', side: 'R', sets: [] },    // non-ISO date (text col)
    ],
  },
  {
    ...defaults,
    logs: [
      { exerciseId: 'ge-1', side: null, sets: [{ weight: 50, reps: 5 }] },
      { id: 'gl-x', exerciseId: 'ge-1', date: '2026-07-06', side: 'left', sets: [] },
      { id: 'gl-y', exerciseId: 'ge-1', date: '07/04/2026', side: 'R', sets: [] },
    ],
  },
)

// 4e. defaultDuration numeric STRING is loader-valid (Number('75') > 0) and
// must round-trip as the same string — jsonb, like ladder's settings.buffer.
roundTrip('defaultDuration string fidelity', { ...defaults, defaultDuration: '75' })
normTrip('defaultDuration invalid → loader default 75', { ...defaults, defaultDuration: '' }, defaults)

// 4f. plan leniency: null cycle entries survive, a fractional/garbage position
// is reset to 0 (the loader's rule), unfiltered order entries don't 500.
normTrip(
  'plan cycle: null order entry + non-integer position',
  {
    ...defaults,
    plan: { type: 'cycle', weekly: allDays(() => null), cycle: { order: ['gw-1', null, 'gw-1'], position: 1.5 }, overrides: {}, extras: {} },
  },
  {
    ...defaults,
    plan: { type: 'cycle', weekly: allDays(() => null), cycle: { order: ['gw-1', null, 'gw-1'], position: 0 }, overrides: {}, extras: {} },
  },
)

// 4g. extra non-day keys in hours/weekly are kept by the loader; hours values
// missing open/close strings are normalized to '' instead of violating NOT NULL.
normTrip(
  'extra hours/weekly keys + non-string open/close',
  {
    ...defaults,
    hours: { ...allDays(() => ({ open: '', close: '' })), holiday: { open: '10:00' }, junk: 5 },
    plan: { ...defaults.plan, weekly: { ...defaults.plan.weekly, extra: 'gw-9' } },
  },
  {
    ...defaults,
    hours: { ...allDays(() => ({ open: '', close: '' })), holiday: { open: '10:00', close: '' }, junk: { open: '', close: '' } },
    plan: { ...defaults.plan, weekly: { ...defaults.plan.weekly, extra: 'gw-9' } },
  },
)

// 4h. '__proto__' keys in weekly/hours must stay plain own properties — no
// prototype pollution, no dropped entries.
{
  const evil = JSON.parse(
    '{"plan":{"type":"weekly","weekly":{"__proto__":"gw-evil"}},"hours":{"__proto__":{"open":"01:00","close":"02:00"}}}',
  )
  const back = mapper.recompose(simulatePg(mapper.decompose(evil)))
  if (Object.getPrototypeOf(back.hours) !== Object.prototype) throw new Error('hours prototype replaced')
  if (Object.getPrototypeOf(back.plan.weekly) !== Object.prototype) throw new Error('weekly prototype replaced')
  const hOwn = Object.getOwnPropertyDescriptor(back.hours, '__proto__')
  const wOwn = Object.getOwnPropertyDescriptor(back.plan.weekly, '__proto__')
  deepStrictEqual(hOwn && hOwn.value, { open: '01:00', close: '02:00' }, '__proto__ hours entry kept')
  deepStrictEqual(wOwn && wOwn.value, 'gw-evil', '__proto__ weekly entry kept')
  if (({}).open !== undefined) throw new Error('Object.prototype polluted')
  console.log('  pass: __proto__ keys stay own properties (weekly/hours)')
}

// 4i. present-but-non-boolean rest/flex/unilateral (foreign blob) are coerced
// with !! instead of failing the boolean column.
normTrip(
  'non-boolean rest/flex coerced',
  { ...defaults, workouts: [{ id: 'gw-1', name: 'W', rest: 'yes', flex: 0 }] },
  { ...defaults, workouts: [{ id: 'gw-1', name: 'W', rest: true, flex: false }] },
)

// 4j. completions: loader only requires isObj; a non-number ts is dropped
// rather than failing the numeric column, non-ISO dates survive as text.
normTrip(
  'lenient completions',
  { ...defaults, completions: [{ workoutId: 'gw-1', date: 'someday', ts: 'abc', start: '', end: '' }, {}] },
  { ...defaults, completions: [{ workoutId: 'gw-1', date: 'someday', start: '', end: '' }, {}] },
)

// ---- 5. per-date deviations from the plan ------------------------------------
// A day picked by hand instead of the one the rotation planned. There was NO
// coverage of this at all — the file's expected defaults predated the feature,
// so every assertion here stopped running the day it shipped.

roundTrip('plan overrides + extras survive the round trip', {
  ...defaults,
  workouts: [{ id: 'gw-push1', name: 'Push' }, { id: 'gw-legs1', name: 'Legs' }],
  exercises: [{ id: 'ge-sq', workoutId: 'gw-legs1', name: 'Squat' }],
  plan: {
    type: 'cycle',
    weekly: allDays(() => null),
    cycle: { order: ['gw-push1', 'gw-legs1'], position: 0 },
    // a swapped day, a skipped day, and one kept alongside them
    overrides: { '2026-08-25': 'gw-legs1', '2026-08-24': 'skip', '2026-08-23': 'gw-push1' },
    extras: { '2026-08-25': ['ge-sq'], '2026-08-23': ['ge-sq', 'ge-sq'] },
  },
})

// Server-side normalization is shape-only on purpose: pruning dangling ids and
// stale dates is the CLIENT's job, because it is time-based and the server's
// clock is not the user's. An unknown id must therefore come back untouched.
roundTrip('an override naming a deleted workout is NOT dropped server-side', {
  ...defaults,
  plan: { ...defaults.plan, overrides: { '2026-08-25': 'gw-deleted' } },
})

// A '__proto__' date key must stay an own property, like weekly/hours.
{
  const evil = JSON.parse('{"plan":{"overrides":{"__proto__":"gw-evil"},"extras":{"__proto__":["ge-evil"]}}}')
  const back = mapper.recompose(simulatePg(mapper.decompose(evil)))
  if (Object.getPrototypeOf(back.plan.overrides) !== Object.prototype) throw new Error('overrides prototype replaced')
  if (Object.getPrototypeOf(back.plan.extras) !== Object.prototype) throw new Error('extras prototype replaced')
  const oOwn = Object.getOwnPropertyDescriptor(back.plan.overrides, '__proto__')
  const eOwn = Object.getOwnPropertyDescriptor(back.plan.extras, '__proto__')
  deepStrictEqual(oOwn && oOwn.value, 'gw-evil', '__proto__ override entry kept')
  deepStrictEqual(eOwn && eOwn.value, ['ge-evil'], '__proto__ extras entry kept')
  console.log('  pass: __proto__ date keys stay own properties (overrides/extras)')
}

// Sanity: decompose leaves the runner room to stamp user_id/ord.
for (const [t, rowsArr] of Object.entries(mapper.decompose(rich))) {
  for (const r of rowsArr) {
    if ('user_id' in r || 'ord' in r) throw new Error(`${t} row leaks user_id/ord`)
  }
}
console.log('  pass: decompose never emits user_id/ord')

console.log('OK gym')
