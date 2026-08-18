// Round-trip tests for the canvas mapper: recompose(pg(decompose(S))) === S.
import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/canvas.js'

// Columns declared jsonb in the DDL (none for canvas — everything is text/bool).
const JSONB = {
  settings: [],
  course_prefs: [],
  dismissed: [],
  semesters: [],
  semester_classes: [],
}

// Mimic the DB round trip: deep-clone rows and parse jsonb columns the way
// pg hands them back (already-parsed objects/arrays).
function simulatePg(byTable) {
  const out = {}
  for (const [table, rows] of Object.entries(byTable)) {
    out[table] = rows.map(row => {
      const r = structuredClone(row)
      for (const col of JSONB[table] || []) {
        if (r[col] !== undefined && r[col] !== null) r[col] = JSON.parse(r[col])
      }
      // runner adds these on insert; SELECT * returns them.
      r.user_id = '00000000-0000-0000-0000-000000000000'
      return r
    })
    out[table].forEach((r, i) => { r.ord = i })
  }
  return out
}

const roundTrip = (S, label) => {
  try {
    deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(S))), S)
  } catch (e) {
    console.error(`FAIL ${label}`)
    throw e
  }
}

// 1. Exact default state loadCanvas() produces from empty storage.
const defaults = {
  host: '',
  token: '',
  scale: 'plusminus',
  credits: {},
  semesters: [],
  dismissed: [],
  hiddenCourses: [],
  labels: {},
  scales: {},
}
roundTrip(defaults, 'defaults')

// 2. Rich state exercising every field and edge case.
const rich = {
  host: 'école.instructure.com',
  token: 'tok-1234~秘密トークン',
  scale: 'letters',
  credits: {
    '101': '3',        // normal
    '202': '',         // key kept with cleared field — must stay '', not vanish
    '303': '4.5abc',   // raw garbage string — stored verbatim, never coerced
    '404': '０.５',    // unicode digits
  },
  semesters: [
    // GPA entered directly, no classes key at all (pre-add-class row)
    { id: 's0aaaaa', name: 'Fall 2023 — 秋', gpa: '3.85', credits: '15' },
    // classes: [] — every class removed; MUST stay an empty array, not go absent
    { id: 's0bbbbb', name: '', gpa: '', credits: '', classes: [] },
    // computed from classes, incl. empty-string fields
    {
      id: 's0ccccc',
      name: 'Spring \'24 "honors"',
      gpa: '',
      credits: '',
      classes: [
        { id: 's0ddddd', name: 'Calc II ∫∂', grade: 'A-', credits: '4' },
        { id: 's0eeeee', name: '', grade: 'F', credits: '' },
      ],
    },
    // legacy/corrupt row the loader passes through: only id present
    { id: 's0fffff' },
  ],
  dismissed: [
    '101:9001',
    '202:9002',
    'no-colon-raw-entry',      // odd legacy string — must survive unsplit
    '303:90:03',               // extra colon — raw storage keeps it intact
  ],
  hiddenCourses: ['404', '101', '999'], // order matters; 999 has no credits entry
  labels: {
    '101': { nick: 'Statics' },                  // nick only — code key absent, not ''
    '202': { code: 'MATH-2241' },                // code only
    '303': { nick: '', code: 'MEGR' },           // '' survives beside a non-empty sibling
    '999': { nick: 'Hidden but named' },         // hidden course still carries its label
    '505': { nick: 'Label-only course' },        // no credits, not hidden → row exists only for this
  },
  scales: {
    '101': 'A 90, B 80, C 70, D 60',
    '505': 'A 93, A- 90',
    '606': 'unparseable but stored verbatim',    // scale-only course → its own row
  },
}
roundTrip(rich, 'rich')

// 3. Realistic usage: connected account, several courses and semesters.
const realistic = {
  host: 'myschool.instructure.com',
  token: '11224~AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  scale: 'plusminus',
  credits: { '38214': '3', '38215': '4', '38216': '3', '38217': '1.5' },
  semesters: [
    { id: 's1k2j3h', name: 'Fall 2024', gpa: '3.6', credits: '16' },
    {
      id: 's9x8y7z',
      name: 'Spring 2025',
      gpa: '',
      credits: '',
      classes: [
        { id: 'sqwerty', name: 'Organic Chemistry', grade: 'B+', credits: '4' },
        { id: 'sasdfgh', name: 'Linear Algebra', grade: 'A', credits: '3' },
        { id: 'szxcvbn', name: 'World History', grade: 'A-', credits: '3' },
      ],
    },
  ],
  dismissed: ['38214:441210', '38216:441377'],
  hiddenCourses: ['38217'],
  labels: { '38214': { nick: 'Ochem' }, '38215': { nick: 'Lin Alg', code: 'MATH-2164' } },
  scales: { '38214': 'A 90, B 80, C 70, D 60' },
}
roundTrip(realistic, 'realistic')

// Sanity: hidden-course ordering and credits merge survive exactly.
const merged = mapper.recompose(simulatePg(mapper.decompose(rich)))
deepStrictEqual(merged.hiddenCourses, ['404', '101', '999'])
deepStrictEqual(merged.credits['202'], '')

// ---- regression: decompose must tolerate RAW (non-loadCanvas'd) blobs ------
// The wire carries raw localStorage (legacy blobs, importAll); loadCanvas
// only fixes these in memory and never writes back. decompose mirrors it, so
// recompose returns the loader-normalized shape.

// 4. Legacy blob missing host/token/scale entirely (pre-token/scale versions):
//    undefined must become the loader defaults, not SQL NULL into NOT NULLs.
{
  const back = mapper.recompose(simulatePg(mapper.decompose({ dismissed: ['1:2'] })))
  deepStrictEqual(back, {
    host: '', token: '', scale: 'plusminus',
    credits: {}, semesters: [], dismissed: ['1:2'], hiddenCourses: [], labels: {}, scales: {},
  }, 'legacy blob gets loader defaults')
}
{ // host-only blob; legacy scale value outside the CHECK coerces like loadCanvas
  const back = mapper.recompose(simulatePg(mapper.decompose({ host: 'x.instructure.com', scale: 'letter' })))
  deepStrictEqual(back.host, 'x.instructure.com')
  deepStrictEqual(back.scale, 'plusminus')
}
{ // fully empty blob round-trips as the loader's default state
  const back = mapper.recompose(simulatePg(mapper.decompose({})))
  deepStrictEqual(back, defaults, 'empty blob → loader defaults')
}

// 5. hiddenCourses with a legacy numeric id and its string twin: both
//    stringify to the same course_id — decompose must dedupe (first wins) or
//    the (user_id, course_id) PK aborts the whole save. Credits still merge.
{
  const rows = mapper.decompose({ ...defaults, hiddenCourses: [123, '123', 456], credits: { 123: '3' } })
  deepStrictEqual(rows.course_prefs.map(r => r.course_id), ['123', '456'], 'prefs deduped')
  const back = mapper.recompose(simulatePg(rows))
  deepStrictEqual(back.hiddenCourses, ['123', '456'])
  deepStrictEqual(back.credits, { 123: '3' })
}

// 6. Duplicate dismissed keys (loader keeps them; UI reads via .includes())
//    must collapse or the (user_id, key) PK aborts the save.
{
  const rows = mapper.decompose({ ...defaults, dismissed: ['1:2', '1:2', '3:4'] })
  deepStrictEqual(rows.dismissed.map(r => r.key), ['1:2', '3:4'])
  deepStrictEqual(mapper.recompose(simulatePg(rows)).dismissed, ['1:2', '3:4'])
}

// 7. The regression this table grew for: course nicknames and per-course grade
//    scales used to have NO column at all, so every save dropped them and the
//    next pull overwrote the local store with a copy that had never held them.
//    The user saw a nickname appear, then revert to the raw Canvas name.
{
  const S = {
    ...defaults,
    labels: { '77': { nick: 'Statics', code: 'MEGR-2141' } },
    scales: { '77': 'A 90, B 80' },
  }
  const back = mapper.recompose(simulatePg(mapper.decompose(S)))
  deepStrictEqual(back.labels, { '77': { nick: 'Statics', code: 'MEGR-2141' } }, 'nickname survives the round trip')
  deepStrictEqual(back.scales, { '77': 'A 90, B 80' }, 'custom grade scale survives the round trip')
}
{ // a course with ONLY a label still needs a row — nothing else would create one
  const rows = mapper.decompose({ ...defaults, labels: { '88': { nick: 'Orphan' } } })
  deepStrictEqual(rows.course_prefs.map(r => r.course_id), ['88'])
  deepStrictEqual(rows.course_prefs[0].credits, null, 'label-only row invents no credits')
  deepStrictEqual(rows.course_prefs[0].hidden, false)
  deepStrictEqual(mapper.recompose(simulatePg(rows)).labels, { '88': { nick: 'Orphan' } })
}
{ // every row spells out all value columns, so SELECT * and simulatePg agree
  const rows = mapper.decompose({ ...defaults, hiddenCourses: ['1'], credits: { '2': '3' } })
  for (const r of rows.course_prefs) {
    deepStrictEqual(Object.keys(r).sort(), ['code', 'course_id', 'credits', 'hidden', 'nick', 'scale_cuts'])
  }
}
{ // a course whose label lost both fields must not come back as an empty object
  const back = mapper.recompose(simulatePg(mapper.decompose({ ...defaults, credits: { '9': '3' } })))
  deepStrictEqual(back.labels, {}, 'a credits-only course invents no labels entry')
}
{ // garbage import: a non-object label is skipped, not thrown on
  const back = mapper.recompose(simulatePg(mapper.decompose({ ...defaults, labels: { '1': null, '2': 'nope' } })))
  deepStrictEqual(back.labels, {})
}

console.log('OK canvas')
