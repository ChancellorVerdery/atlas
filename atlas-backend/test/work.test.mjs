// Round-trip test for the work plugin mapper: recompose(pg(decompose(S))) === S.
import { deepStrictEqual, strictEqual } from 'node:assert'
import mapper from '../services/plugins/work.js'

// Columns declared jsonb per table (work has none — kept for parity with the
// shared test pattern; simulatePg still exercises the pg-side transforms).
const JSONB = {
  settings: [],
  shifts: [],
  upcoming: [],
  widget_ranges: [],
  widget_hist_per: [],
}

// Mimic what SELECT * returns for rows the runner inserted: deep-cloned
// values, jsonb strings parsed back to objects, plus the user_id/ord columns
// the runner stamps (recompose must ignore them).
function simulatePg(byTable) {
  const out = structuredClone(byTable)
  for (const [table, rows] of Object.entries(out)) {
    rows.forEach((row, i) => {
      for (const col of JSONB[table] || [])
        if (typeof row[col] === 'string') row[col] = JSON.parse(row[col])
      row.user_id = '00000000-0000-0000-0000-000000000001'
      row.ord = i
    })
  }
  return out
}

const roundTrip = (S) => deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(S))), S)

// 1. Exact default state loadWork() produces from empty storage. recompose
//    always emits jobType (settings.job_type) and histPer (widget_hist_per),
//    so the defaults fixture must carry loadWork's own defaults for both:
//    jobType 'shift' (work.js line 25) and histPer {} (work.js line 17).
const defaults = {
  wage: 0,
  tips: false,
  openEnded: false,
  jobType: 'shift',
  shifts: [],
  ranges: {},
  histPer: {},
  upcoming: [],
  address: '',
  calId: '',
}
roundTrip(defaults)

// 2. Rich state exercising every field and edge case, including the
//    'salary' jobType and a populated histPer.
const rich = {
  wage: 17.25,
  tips: true,
  openEnded: true,
  jobType: 'salary',
  shifts: [
    // clock-time shift with tips (hours is null when start is set)
    { id: 's1a2b3c4', date: '2026-06-29', start: '09:00', end: '17:30', hours: null, tips: 42.5, wage: 15 },
    // duration-entry shift: start/end are empty strings, hours is a number
    { id: 's5d6e7f8', date: '2026-06-30', start: '', end: '', hours: 6.5, tips: 0, wage: 17.25 },
    // open shift: on the clock, no end yet
    { id: 's9g0h1i2', date: '2026-07-06', start: '22:00', end: '', hours: null, tips: 0, wage: 17.25 },
    // zero-hour edge: duration 0
    { id: 'szerozer', date: '2026-01-01', start: '', end: '', hours: 0, tips: 0.01, wage: 0 },
  ],
  ranges: {
    'w-income-1': 'week',
    'w-income-2': 'all',
    'w~unicode·id': 'month',
  },
  histPer: {
    'w-income-1': 20,
    'w-income-2': 100,
  },
  upcoming: [
    { id: 'su1u1u1u', date: '2026-07-08', start: '09:00', end: '17:00', endMode: 'est', gcalId: '' },
    { id: 'su2u2u2u', date: '2026-07-09', start: '22:00', end: '04:15', endMode: 'auto', gcalId: 'abc123_def@google.com' },
  ],
  address: '123 Café Straße, Zürich — 日本語 🏢',
  calId: 'atlas-work-cal-id@group.calendar.google.com',
}
roundTrip(rich)

// 3. Realistic usage: several rows per table, tips off, no open-ended.
const real = {
  wage: 16,
  tips: false,
  openEnded: false,
  jobType: 'shift',
  shifts: [
    { id: 'saaaaaaa', date: '2026-06-01', start: '08:00', end: '16:00', hours: null, tips: 0, wage: 15.5 },
    { id: 'sbbbbbbb', date: '2026-06-03', start: '08:00', end: '14:30', hours: null, tips: 0, wage: 15.5 },
    { id: 'sccccccc', date: '2026-06-10', start: '', end: '', hours: 8, tips: 0, wage: 16 },
    { id: 'sddddddd', date: '2026-06-17', start: '09:15', end: '17:45', hours: null, tips: 0, wage: 16 },
    { id: 'seeeeeee', date: '2026-06-24', start: '', end: '', hours: 5.25, tips: 0, wage: 16 },
  ],
  ranges: { 'widget-income': 'month' },
  histPer: { 'widget-income': 10 },
  upcoming: [
    { id: 'sfffffff', date: '2026-07-10', start: '08:00', end: '16:00', endMode: 'est', gcalId: 'ev1@google.com' },
    { id: 'sggggggg', date: '2026-07-11', start: '08:00', end: '16:00', endMode: 'est', gcalId: 'ev2@google.com' },
    { id: 'shhhhhhh', date: '2026-07-12', start: '10:00', end: '18:00', endMode: 'est', gcalId: '' },
  ],
  address: '500 Main St, Springfield',
  calId: 'work-cal@group.calendar.google.com',
}
roundTrip(real)

// 4. Regression: legacy/imported upcoming rows missing endMode and/or gcalId.
//    loadWork does zero per-item validation (its own shape comment predates
//    endMode) and workui reads sh.endMode/sh.gcalId defensively, so these
//    columns are nullable (NULL = key absent) — the save must not 500 and the
//    absent keys must round-trip ABSENT, not become ''/null.
const legacyUpcoming = {
  wage: 0, tips: false, openEnded: false, jobType: 'shift', shifts: [], ranges: {}, histPer: {},
  upcoming: [
    { id: 'sulegacy', date: '2026-07-08', start: '09:00', end: '17:00' },   // no endMode, no gcalId
    { id: 'sulegac2', date: '2026-07-09', start: '10:00', end: '18:00', gcalId: 'x@google.com' }, // no endMode
    {},                                                                     // every key absent
  ],
  address: '', calId: '',
}
roundTrip(legacyUpcoming)
{
  const back = mapper.recompose(simulatePg(mapper.decompose(legacyUpcoming)))
  strictEqual('endMode' in back.upcoming[0], false)
  strictEqual('gcalId' in back.upcoming[0], false)
}

// 5. Regression: shifts missing start/end/tips/wage keys and non-ISO dates
//    are loader-valid (loadWork never looks inside a shift). decompose
//    coalesces exactly the way the UI reads them (isOpen/shiftHours → '',
//    shiftEarned → Number(v)||0), so recompose returns the COALESCED shape.
//    A null widget-range period is loader-valid too (rangeFor falls back to
//    'week' only at read time) and must round-trip as null.
const sparse = {
  wage: 16, tips: false, openEnded: false, jobType: 'shift',
  shifts: [
    { id: 'sxsparse', date: '2026-01-01', hours: 8 },  // duration-only row: no start/end/tips/wage
    { date: '01/01/2026', start: '9:00' },             // no id, non-ISO free-text date
  ],
  ranges: { 'w-null': null, 'w-ok': 'week' },
  histPer: {},
  upcoming: [], address: '', calId: '',
}
deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(sparse))), {
  wage: 16, tips: false, openEnded: false, jobType: 'shift',
  shifts: [
    { id: 'sxsparse', date: '2026-01-01', start: '', end: '', hours: 8, tips: 0, wage: 0 },
    { date: '01/01/2026', start: '9:00', end: '', hours: null, tips: 0, wage: 0 },
  ],
  ranges: { 'w-null': null, 'w-ok': 'week' },
  histPer: {},
  upcoming: [], address: '', calId: '',
})

// 6. Regression: jobType normalizes through decompose exactly like loadWork's
//    own gate at work.js line 25 — anything that isn't 'shift'/'salary'
//    becomes 'shift'. decompose must enforce this itself (not just trust the
//    loader) because raw blobs from first-login importAll/backup restore
//    reach the mapper without ever passing through loadWork.
strictEqual(mapper.decompose({ ...defaults, jobType: 'contractor' }).settings[0].job_type, 'shift')
strictEqual(mapper.decompose({ ...defaults, jobType: 5 }).settings[0].job_type, 'shift')
{
  const { jobType, ...noJobType } = defaults
  strictEqual(mapper.decompose(noJobType).settings[0].job_type, 'shift')
}

// 7. histPer decomposes exactly like historyPer's own read-time cast at
//    work.js line 39 (Number(s.histPer?.[widgetId])): a populated value
//    round-trips, and a null per COERCES TO 0 (Number(null) === 0) rather
//    than surviving as null — unlike widget_ranges.period, histPer is never
//    read raw by the UI, so there's no reason to keep a null distinguishable
//    from 0 (both fail HISTORY_PER_CHOICES.includes and fall back to
//    HISTORY_PER_DEFAULT the same way). A non-object histPer normalizes to
//    {} like loadWork's own gate at work.js line 17.
deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose({
  ...defaults,
  histPer: { 'widget-a': 20, 'widget-b': null, 'widget-c': 100 },
}))), {
  ...defaults,
  histPer: { 'widget-a': 20, 'widget-b': 0, 'widget-c': 100 },
})
strictEqual(mapper.decompose({ ...defaults, histPer: 'not-an-object' }).widget_hist_per.length, 0)

// Array order must survive via ord (runner selects ORDER BY ord).
const dec = mapper.decompose(real)
strictEqual(dec.shifts[0].id, 'saaaaaaa')
strictEqual(dec.shifts[4].id, 'seeeeeee')
strictEqual(dec.upcoming[2].gcal_id, '')

// decompose must never emit user_id or ord (the runner owns those).
for (const rows of Object.values(dec))
  for (const row of rows) {
    strictEqual('user_id' in row, false)
    strictEqual('ord' in row, false)
  }

console.log('OK work')
