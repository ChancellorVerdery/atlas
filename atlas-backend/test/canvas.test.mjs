// Round-trip tests for the canvas mapper: recompose(pg(decompose(S))) === S.
import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/canvas.js'

// Columns declared jsonb in the DDL (none for canvas — everything is text/bool).
const JSONB = {
  canvas_settings: [],
  canvas_course_prefs: [],
  canvas_dismissed: [],
  canvas_semesters: [],
  canvas_semester_classes: [],
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
    credits: {}, semesters: [], dismissed: ['1:2'], hiddenCourses: [],
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
  deepStrictEqual(rows.canvas_course_prefs.map(r => r.course_id), ['123', '456'], 'prefs deduped')
  const back = mapper.recompose(simulatePg(rows))
  deepStrictEqual(back.hiddenCourses, ['123', '456'])
  deepStrictEqual(back.credits, { 123: '3' })
}

// 6. Duplicate dismissed keys (loader keeps them; UI reads via .includes())
//    must collapse or the (user_id, key) PK aborts the save.
{
  const rows = mapper.decompose({ ...defaults, dismissed: ['1:2', '1:2', '3:4'] })
  deepStrictEqual(rows.canvas_dismissed.map(r => r.key), ['1:2', '3:4'])
  deepStrictEqual(mapper.recompose(simulatePg(rows)).dismissed, ['1:2', '3:4'])
}

console.log('OK canvas')
