// Round-trip test for the course mapper: recompose(pg(decompose(S))) === S.
import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/course.js'

// Columns declared jsonb in the DDL — pg returns them parsed.
const JSONB = { settings: ['max_credits', 'summer_max'] }

// Mimic the DB round trip: deep-clone rows, then JSON.parse jsonb columns
// (decompose stringified them; SELECT returns the parsed value). text[],
// numeric and booleans round-trip as-is (db.js sets the numeric parser).
function simulatePg(byTable) {
  const out = {}
  for (const [table, rows] of Object.entries(byTable)) {
    out[table] = rows.map(row => {
      const r = structuredClone(row)
      for (const col of JSONB[table] || []) r[col] = JSON.parse(r[col])
      return r
    })
  }
  return out
}

const roundTrip = (name, S) => {
  deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(S))), S, name)
  console.log(`  ok: ${name}`)
}

// 1. Exactly what loadCourse() produces from empty localStorage.
roundTrip('default state', {
  courses: [],
  terms: [],
  disabledTerms: [],
  settings: { maxCredits: 15, summerMax: 9, strategy: 'soonest-summer' },
})

// 2. Rich state exercising every field and the edge cases the loader permits:
//    empty strings, null term, empty ref arrays, unicode, fractional
//    credits/year, numeric-STRING settings (loadCourse keeps them), and
//    disabledTerms entries with no matching terms[] row.
roundTrip('rich edge-case state', {
  courses: [
    {
      id: 'c-abc123',
      code: '', // code may be empty (title-only class)
      title: '数学 · Análisis 𝕀 — "quotes" & <tags>',
      credits: 0,
      prereqs: [],
      coreqs: [],
      preOrCo: [],
      summerOk: false,
      term: null,
    },
    {
      id: 'c-def456',
      code: 'MATH 201',
      title: '',
      credits: 1.5,
      prereqs: ['MATH 101', 'φυσική-100'],
      coreqs: ['MATH 201L'],
      preOrCo: ['STAT 200'],
      summerOk: true,
      term: 'fall-2025',
    },
  ],
  terms: [
    // loader order: sorted by termRank (spring-2025.5 = 6076.5 < fall-2025 = 6077);
    // loader allows fractional years
    { key: 'spring-2025.5', season: 'spring', year: 2025.5, current: true },
    { key: 'fall-2025', season: 'fall', year: 2025, current: false },
  ],
  // orphan keys: no matching terms[] row (future summers toggled off early)
  disabledTerms: ['summer-2026', 'summer-2028', ''],
  // loadCourse keeps numeric strings found in storage — must survive verbatim
  settings: { maxCredits: '18', summerMax: '6', strategy: 'even' },
})

// 3. Realistic usage: several terms, classes spread across them, a disabled
//    summer, settings touched via the Settings page (always numbers there).
roundTrip('realistic state', {
  courses: [
    { id: 'c-m1a2b3c4d', code: 'CS 101', title: 'Intro to Programming', credits: 3, prereqs: [], coreqs: [], preOrCo: [], summerOk: true, term: 'fall-2024' },
    { id: 'c-m1a2b3c4e', code: 'CS 201', title: 'Data Structures', credits: 4, prereqs: ['CS 101'], coreqs: [], preOrCo: [], summerOk: false, term: 'spring-2025' },
    { id: 'c-m1a2b3c4f', code: 'CS 301', title: 'Algorithms', credits: 3, prereqs: ['CS 201'], coreqs: [], preOrCo: [], summerOk: false, term: null },
    { id: 'c-m1a2b3c4g', code: 'CS 301L', title: 'Algorithms Lab', credits: 1, prereqs: [], coreqs: ['CS 301'], preOrCo: [], summerOk: false, term: null },
    { id: 'c-m1a2b3c4h', code: 'PHYS 150', title: 'Mechanics', credits: 4, prereqs: [], coreqs: [], preOrCo: ['MATH 140'], summerOk: true, term: null },
    { id: 'c-m1a2b3c4i', code: 'MATH 140', title: 'Calculus I', credits: 4, prereqs: [], coreqs: [], preOrCo: [], summerOk: true, term: 'fall-2024' },
  ],
  terms: [
    { key: 'fall-2024', season: 'fall', year: 2024, current: false },
    { key: 'spring-2025', season: 'spring', year: 2025, current: false },
    { key: 'fall-2025', season: 'fall', year: 2025, current: true },
  ],
  disabledTerms: ['summer-2026'],
  settings: { maxCredits: 16, summerMax: 7, strategy: 'soonest-optional-summer' },
})

// ---- regression: decompose must tolerate RAW (non-loadCourse'd) blobs ------
// The wire carries raw localStorage: the renderer seed writes
// {courses:[...course-import.json entries]} with NO settings/terms/
// disabledTerms keys, and importAll ships legacy backups verbatim.
// decompose must normalize exactly like loadCourse; recompose then returns
// the loader-normalized shape (what the app's next load would produce).

// 4. BLOCKER: renderer-seed blob — courses only, entries verbatim from a
//    hand-written checksheet import (missing fields, id-less row, dup ids).
{
  const seeded = { courses: [
    { id: 'c-x', code: 'CS 101' },                    // every other field absent
    { code: 'NO-ID', title: 'dropped by loader' },    // id-less: loader drops it
    { id: 'c-x', code: 'CS 101' },                    // duplicate id: loader keeps both
    { id: 'c-y', code: ' MATH 2 ', title: 42, credits: '4', prereqs: ['CS 101', '', 3], summerOk: 1, term: '' },
  ] }
  const back = mapper.recompose(simulatePg(mapper.decompose(seeded)))
  deepStrictEqual(back, {
    courses: [
      { id: 'c-x', code: 'CS 101', title: '', credits: 3, prereqs: [], coreqs: [], preOrCo: [], summerOk: false, term: null },
      { id: 'c-x', code: 'CS 101', title: '', credits: 3, prereqs: [], coreqs: [], preOrCo: [], summerOk: false, term: null },
      { id: 'c-y', code: 'MATH 2', title: '42', credits: 4, prereqs: ['CS 101', '3'], coreqs: [], preOrCo: [], summerOk: true, term: null },
    ],
    terms: [],
    disabledTerms: [],
    settings: { maxCredits: 15, summerMax: 9, strategy: 'soonest-summer' },
  }, 'renderer-seed blob normalizes like loadCourse')
  console.log('  ok: renderer-seed blob (missing keys, raw course entries)')
}

// 5. Totally empty blob (importAll of '{}') → loadCourse's default state.
{
  const back = mapper.recompose(simulatePg(mapper.decompose({})))
  deepStrictEqual(back, {
    courses: [],
    terms: [],
    disabledTerms: [],
    settings: { maxCredits: 15, summerMax: 9, strategy: 'soonest-summer' },
  }, 'empty blob → loader defaults')
  console.log('  ok: empty blob')
}

// 6. Legacy terms: duplicate keys, several current flags, invalid entries,
//    stale key fields, non-string disabledTerms. loadCourse dedupes/demotes
//    in memory but never writes the fix back — decompose must, or the
//    (user_id, key) PK / course_terms_one_current index aborts the save.
{
  const legacy = {
    courses: [],
    terms: [
      { season: 'fall', year: 2025, current: true },
      { season: 'fall', year: '2025', current: true },  // dup key (numeric-string year): first wins
      { key: 'stale-key', season: 'spring', year: 2026, current: true }, // key recomputed; latest current wins
      { season: 'winter', year: 2026 },                 // invalid season: dropped
      { season: 'summer', year: 'soon' },               // non-finite year: dropped
      'garbage',                                        // non-object: dropped
    ],
    disabledTerms: ['summer-2026', 42, null],
    settings: { maxCredits: 16, summerMax: 6, strategy: 'even' },
  }
  const rows = mapper.decompose(legacy)
  deepStrictEqual(rows.terms.map(t => t.key), ['fall-2025', 'spring-2026'], 'unique term keys')
  deepStrictEqual(rows.terms.filter(t => t.current).length, 1, 'single current')
  const back = mapper.recompose(simulatePg(rows))
  deepStrictEqual(back.terms, [
    { key: 'fall-2025', season: 'fall', year: 2025, current: false }, // demoted: latest current wins
    { key: 'spring-2026', season: 'spring', year: 2026, current: true },
  ], 'terms deduped/sorted/single-current like loadCourse')
  deepStrictEqual(back.disabledTerms, ['summer-2026'], 'non-string disabledTerms dropped')
  console.log('  ok: legacy terms dedupe + single current')
}

// 7. Unsorted loader-valid terms come back in termRank order (loadCourse sorts).
{
  const back = mapper.recompose(simulatePg(mapper.decompose({
    courses: [],
    terms: [
      { key: 'fall-2025', season: 'fall', year: 2025, current: true },
      { key: 'spring-2024', season: 'spring', year: 2024, current: false },
    ],
    disabledTerms: [],
    settings: { maxCredits: 15, summerMax: 9, strategy: 'soonest-summer' },
  })))
  deepStrictEqual(back.terms.map(t => t.key), ['spring-2024', 'fall-2025'])
  console.log('  ok: terms sorted by rank')
}

console.log('OK course')
