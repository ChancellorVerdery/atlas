// Round-trip test for the ladder mapper: recompose(pg(decompose(S))) === S
// for states the plugin's own loader (atlas-ui/src/page/ladder.js loadLadder)
// can produce. Plain node script — exits nonzero if any assert throws.
import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/ladder.js'

// Columns declared jsonb in the mapper's DDL. node-pg sends the stringified
// value and returns it JSON.parse'd on SELECT; simulate exactly that.
const JSONB = {
  ladder_settings: ['buffer', 'cal_ids'],
  ladder_meals: ['meal'],
  ladder_flex: ['minutes', 'weekday'],
  ladder_geo_cache: ['result'],
  ladder_drive_cache: ['minutes'],
  ladder_aliases: ['alias'],
  ladder_pushed_events: ['events'],
}

// Deep-clone the decomposed rows, parse jsonb columns, and stamp the columns
// the runner adds (user_id, ord) so recompose provably ignores them.
function simulatePg(byTable) {
  const out = {}
  for (const [table, rows] of Object.entries(byTable)) {
    out[table] = rows.map((r, i) => {
      const row = structuredClone(r)
      for (const col of JSONB[table] || []) {
        if (row[col] !== null && row[col] !== undefined) row[col] = JSON.parse(row[col])
      }
      // runner: undefined → SQL NULL
      for (const k of Object.keys(row)) if (row[k] === undefined) row[k] = null
      return { user_id: '00000000-0000-0000-0000-000000000001', ord: i, ...row }
    })
  }
  return out
}

const roundTrip = (S, label) => {
  deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(S))), S, label)
}

// ---- sample 1: the exact default state loadLadder() builds from empty storage
// (meal ids are uid('lm')-shaped; fixed here since uid is random)
const defaults = {
  home: '',
  wake: '07:00',
  windowDays: 7,
  buffer: 5,
  meals: [
    { id: 'lm-mdefault1', name: 'Breakfast', pref: '08:00', duration: 30, enabled: true },
    { id: 'lm-mdefault2', name: 'Lunch', pref: '12:30', duration: 45, enabled: true },
    { id: 'lm-mdefault3', name: 'Dinner', pref: '18:30', duration: 45, enabled: true },
  ],
  flex: [],
  geo: {},
  drives: {},
  aliases: [],
  calIds: { gym: '', drives: '', ladder: '' },
  pushed: {},
}
roundTrip(defaults, 'default state')

// ---- sample 2: every field + edge cases the loader tolerates
// (empty strings, absent optional keys, unicode, cached-null geo, empty pushed
// day, partial calIds, all five flex kinds incl. the three anchor variants)
const rich = {
  home: '123 Åsgård väg, München 🏠',
  wake: '06:15',
  windowDays: 31,
  buffer: 0,
  meals: [
    // settings oninput can yield a non-integer duration (Math.max(5, 7.5))
    { id: 'lm-full', name: 'Brunch ☕', pref: '10:30', duration: 7.5, enabled: false },
    // cleared inputs: empty name/pref are legitimate
    { id: 'lm-blank', name: '', pref: '', duration: 30, enabled: true },
  ],
  flex: [
    { id: 'lf-w', title: 'Deep work', minutes: 120, kind: 'week' },
    { id: 'lf-d', title: 'Errands 🛒', minutes: 45, kind: 'day', date: '2026-07-10' },
    { id: 'lf-r', title: 'Piano', minutes: 30, kind: 'recur', weekday: 0 },
    { id: 'lf-s', title: 'Dentist', minutes: 90, kind: 'set', date: '2026-07-12', start: '09:30', end: '11:00' },
    // attached, tag anchor: NO anchorLabel key at all
    { id: 'lf-at', title: 'Shake', minutes: 15, kind: 'attached', side: 'after', place: 'none', anchorTag: 'gym' },
    // attached, series anchor: anchorLabel present but EMPTY — '' ≠ absent
    { id: 'lf-as', title: 'Review notes', minutes: 20, kind: 'attached', side: 'before', place: 'same', anchorSeries: 'evt_series_1', anchorLabel: '' },
    // attached, id anchor (window-relative plan id — may dangle, still kept)
    { id: 'lf-ai', title: 'Pack bag', minutes: 10, kind: 'attached', side: 'before', place: 'home', anchorId: 'shift-s9x', anchorLabel: 'Work · Mon 7/13' },
    // loadLadder's filter only demands {id, title, minutes>0} — a kindless
    // row from old/hand-edited storage survives load and must survive us
    { id: 'lf-x', title: 'Mystery', minutes: 5 },
  ],
  geo: {
    '123 åsgård väg, münchen 🏠': { lat: 48.1351, lon: 11.582 },
    'fretwell 306': null, // cached geocode FAILURE — must round-trip as null
    'nan coords somewhere': { lat: null, lon: null }, // NaN flattened by JSON — distinct from null
  },
  drives: {
    '48.1351,11.5820>48.1000,11.6000': 25,
    '48.1000,11.6000>48.1351,11.5820': 5,
  },
  aliases: [
    { id: 'la-1', match: 'Fretwell', address: '9201 University City Blvd, Charlotte' },
    { id: 'la-2', match: '', address: '' }, // half-typed row, kept on purpose
    { id: 'la-3' }, // id-only row also survives the loader's lenient filter
  ],
  calIds: { gym: 'cal_gym_abc' }, // loader keeps ANY object — drives/ladder absent
  pushed: {
    '2026-07-10': [{ calId: 'c1', id: 'e1' }, { calId: 'c2', id: 'e2' }, { calId: 'c1', id: 'e3' }],
    '2026-07-11': [], // a pushed day whose blocks were all unpushable — kept
  },
}
roundTrip(rich, 'rich state')

// pushed[] array order must survive, not just membership
{
  const back = mapper.recompose(simulatePg(mapper.decompose(rich)))
  deepStrictEqual(back.pushed['2026-07-10'].map(e => e.id), ['e1', 'e2', 'e3'], 'pushed order')
  deepStrictEqual(back.flex.map(f => f.id), rich.flex.map(f => f.id), 'flex order')
  deepStrictEqual(Object.keys(back.geo), Object.keys(rich.geo), 'geo key order')
}

// ---- sample 3: realistic daily usage — several rows per table, all calIds set
const real = {
  home: '600 E Trade St, Charlotte, NC',
  wake: '07:30',
  windowDays: 5,
  buffer: 10,
  meals: [
    { id: 'lm-b', name: 'Breakfast', pref: '08:00', duration: 30, enabled: true },
    { id: 'lm-l', name: 'Lunch', pref: '12:30', duration: 45, enabled: false },
    { id: 'lm-d', name: 'Dinner', pref: '18:30', duration: 45, enabled: true },
    { id: 'lm-s', name: 'Snack', pref: '15:00', duration: 15, enabled: true },
  ],
  flex: [
    { id: 'lf-1', title: 'Laundry', minutes: 60, kind: 'week' },
    { id: 'lf-2', title: 'Call mom', minutes: 30, kind: 'recur', weekday: 6 },
    { id: 'lf-3', title: 'Stretch', minutes: 15, kind: 'attached', side: 'after', place: 'home', anchorTag: 'gym' },
    { id: 'lf-4', title: 'Flight check-in', minutes: 10, kind: 'day', date: '2026-07-09' },
  ],
  geo: {
    '600 e trade st, charlotte, nc': { lat: 35.2251, lon: -80.8392 },
    '9201 university city blvd': { lat: 35.3071, lon: -80.7352 },
    'gold’s gym uptown': { lat: 35.2266, lon: -80.8433 },
  },
  drives: {
    '35.2251,-80.8392>35.3071,-80.7352': 25,
    '35.3071,-80.7352>35.2251,-80.8392': 30,
    '35.2251,-80.8392>35.2266,-80.8433': 5,
  },
  aliases: [{ id: 'la-camp', match: 'Fretwell', address: '9201 University City Blvd' }],
  calIds: { gym: 'gymcal@group.calendar.google.com', drives: 'drv@group.calendar.google.com', ladder: 'lad@group.calendar.google.com' },
  pushed: {
    '2026-07-07': [{ calId: 'gymcal@group.calendar.google.com', id: 'ev_a' }, { calId: 'lad@group.calendar.google.com', id: 'ev_b' }],
    '2026-07-08': [{ calId: 'drv@group.calendar.google.com', id: 'ev_c' }],
  },
}
roundTrip(real, 'realistic state')

// ---- regressions: raw (never-loaded) blobs must save without failing --------
// The wire carries raw localStorage (backup imports, settings oninput pushes),
// so decompose applies loadLadder's exact normalization; recompose returns the
// loader-normalized shape.

const normTrip = (input, expected, label) =>
  deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(input))), expected, label)

// window_days: typing '2.5' (or an out-of-range number) into Planning window
// stores it un-normalized; the loader's rule (integer 1..31 else 7) applies.
// Previously: 22P02 'invalid input syntax for type integer: "2.5"'.
normTrip({ ...defaults, windowDays: 2.5 }, defaults, 'decimal windowDays → 7')
normTrip({ ...defaults, windowDays: 12345678901 }, defaults, 'out-of-range windowDays → 7')

// duplicate meal/alias ids are real data (ladderui mints ids from Date.now()
// alone) and the loader keeps both. Previously: 23505 on the PK.
roundTrip({
  ...defaults,
  meals: [
    { id: 'lm-same', name: 'Lunch A', pref: '12:00', duration: 30, enabled: true },
    { id: 'lm-same', name: 'Lunch B', pref: '12:30', duration: 45, enabled: true },
  ],
  aliases: [
    { id: 'la-same', match: 'Fretwell', address: 'addr 1' },
    { id: 'la-same', match: 'Woodward', address: 'addr 2' },
  ],
}, 'duplicate meal/alias ids both survive')

// id-less meals are loader-valid (loadLadder filters meals by isObj only).
// Previously: 23502 on ladder_meals.id NOT NULL. Extra keys also survive now.
roundTrip({
  ...defaults,
  meals: [
    { name: 'Lunch', pref: '12:30', duration: 45, enabled: true },       // no id
    { id: 'lm-x', name: 'Dinner', pref: '18:30', duration: '45', note: 'extra key' }, // string duration + unknown key
  ],
}, 'id-less meal + string duration + extra meal keys')

// flex: numeric-string minutes ('45' passes Number(f.minutes) > 0) and
// fractional/string weekdays are loader-kept and must round-trip verbatim.
// Previously: minutes retyped to Number; weekday 1.5 → 22P02 on integer.
roundTrip({
  ...defaults,
  flex: [
    { id: 'lf-sm', title: 'Str minutes', minutes: '45', kind: 'week' },
    { id: 'lf-fw', title: 'Frac weekday', minutes: 30, kind: 'recur', weekday: 1.5 },
    { id: 'lf-sw', title: 'Str weekday', minutes: 30, kind: 'recur', weekday: '3' },
  ],
}, 'flex minutes/weekday fidelity')

// drives: an imported blob bypasses the loader's ceil-to-5 rounding; decompose
// re-applies it (7.2 → 10). Previously: 22P02 inserting 7.2 into integer.
normTrip(
  { ...defaults, drives: { 'a>b': 7.2, 'b>a': null } },
  { ...defaults, drives: { 'a>b': 10, 'b>a': null } },
  'un-rounded drive minutes re-rounded, cached null kept',
)

// '__proto__' as a geo/drives/pushed key (geo keys are lowercased free-text
// addresses) must stay an own property — not vanish into the prototype.
{
  const evil = JSON.parse(JSON.stringify({
    ...defaults,
    geo: {},
    drives: {},
    pushed: {},
  }).replace('"geo":{}', '"geo":{"__proto__":{"lat":1,"lon":2}}')
    .replace('"drives":{}', '"drives":{"__proto__":25}')
    .replace('"pushed":{}', '"pushed":{"__proto__":[{"calId":"c","id":"e"}]}'))
  const back = mapper.recompose(simulatePg(mapper.decompose(evil)))
  for (const [name, obj, want] of [
    ['geo', back.geo, { lat: 1, lon: 2 }],
    ['drives', back.drives, 25],
    ['pushed', back.pushed, [{ calId: 'c', id: 'e' }]],
  ]) {
    if (Object.getPrototypeOf(obj) !== Object.prototype) throw new Error(`${name} prototype replaced`)
    const own = Object.getOwnPropertyDescriptor(obj, '__proto__')
    deepStrictEqual(own && own.value, want, `${name} __proto__ entry kept as own key`)
  }
  if (({}).lat !== undefined) throw new Error('Object.prototype polluted')
}

// a raw legacy/foreign blob missing every key: normalized exactly like
// loadLadder (default meals get freshly minted lm- ids, so compare shape).
{
  const back = mapper.recompose(simulatePg(mapper.decompose({})))
  const ids = back.meals.map(m => m.id)
  if (ids.length !== 3 || !ids.every(id => /^lm-/.test(id))) throw new Error('default meals not minted')
  deepStrictEqual(
    { ...back, meals: back.meals.map(({ id, ...rest }) => rest) },
    { ...defaults, meals: defaults.meals.map(({ id, ...rest }) => rest) },
    'empty blob → loader defaults',
  )
}

// buffer string fidelity still holds alongside the normalization pass.
roundTrip({ ...defaults, buffer: '10' }, 'buffer numeric string verbatim')

console.log('OK ladder')
