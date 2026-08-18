// Grade-scale self-check for the Canvas plugin (node tests/canvas.check.mjs).
// Pure-function imports only — nothing here touches localStorage.
import assert from 'node:assert/strict'
import { parseScale, cutsToLetter, courseLetter, pctToLetter, letterPoints, semesterGPA, courseNick, courseCodeOf, courseLabel } from '../src/page/canvas.js'

// ---- parseScale -------------------------------------------------------------
const ten = parseScale('A 90, B 80, C 70, D 60')
assert.deepEqual(ten, [[90, 'A'], [80, 'B'], [70, 'C'], [60, 'D'], [0, 'F']]) // F floor appended
assert.deepEqual(parseScale('a 90, b 80, c 70, d 60'), ten) // case-insensitive
assert.deepEqual(parseScale('D 60, A 90, C 70, B 80'), ten) // any order
assert.deepEqual(parseScale('A: 90  B: 80  C: 70  D: 60'), ten) // colons/whitespace
assert.deepEqual(parseScale('A 88, A- 85, B+ 82').slice(0, 3), [[88, 'A'], [85, 'A-'], [82, 'B+']]) // ± cutoffs
assert.equal(parseScale('A 89.5')[0][0], 89.5) // decimals survive
assert.equal(parseScale('')?.[0], undefined) // blank → no override
assert.equal(parseScale(null), null)
assert.equal(parseScale('whatever'), null) // unparseable → fall back to the global scale
assert.equal(parseScale('E 90'), null) // E isn't a grade
assert.deepEqual(parseScale('A 90, F 0'), [[90, 'A'], [0, 'F']]) // explicit F, no duplicate floor

// ---- cutsToLetter -----------------------------------------------------------
assert.equal(cutsToLetter(90, ten), 'A') // boundary is inclusive
assert.equal(cutsToLetter(89.9, ten), 'B')
assert.equal(cutsToLetter(100, ten), 'A')
assert.equal(cutsToLetter(0, ten), 'F')
assert.equal(cutsToLetter(-5, ten), 'F') // below every cutoff still resolves

// The whole point: 90 is a B- on the default ± scale, an A on his class's scale.
assert.equal(pctToLetter(90, 'plusminus'), 'A-')
assert.equal(cutsToLetter(90, ten), 'A')
assert.equal(pctToLetter(80, 'plusminus'), 'B-')
assert.equal(cutsToLetter(80, ten), 'B')

// ---- courseLetter: per-course override beats global scale and Canvas ---------
const course = (id, pct, letter = null) => ({ id, enrollments: [{ type: 'student', computed_current_score: pct, computed_current_grade: letter }] })
const store = (scales = {}, scale = 'plusminus') => ({ scale, scales, credits: {}, semesters: [] })

assert.equal(courseLetter(course(1, 90), store()), 'A-') // no override → global
assert.equal(courseLetter(course(1, 90), store({ 1: 'A 90, B 80, C 70, D 60' })), 'A')
assert.equal(courseLetter(course(2, 90), store({ 1: 'A 90, B 80' })), 'A-') // override is per course
assert.equal(courseLetter(course(1, 90), store({ 1: 'nonsense' })), 'A-') // junk falls back
assert.equal(courseLetter(course(1, null), store()), null)
// letter-only course (no percentage): Canvas's own letter is all there is
assert.equal(courseLetter(course(1, null, 'B+'), store()), 'B+')
assert.equal(courseLetter(course(1, null, 'B+'), store({}, 'letters')), 'B') // global 'letters' strips
assert.equal(courseLetter(course(1, null, 'B+'), store({ 1: 'A 90' }, 'letters')), 'B+') // custom scale keeps it

// ---- GPA uses the override --------------------------------------------------
const s = store({ 1: 'A 90, B 80, C 70, D 60' })
s.credits = { 1: 3, 2: 3 }
const gpa = semesterGPA([course(1, 90), course(2, 90)], s)
assert.equal(gpa.credits, 6)
// course 1 = A (4.0) under its own scale, course 2 = A- (3.7) under the global one
assert.equal(gpa.gpa.toFixed(2), ((4 + 3.7) / 2).toFixed(2))
assert.equal(letterPoints('A'), 4)

// ---- course labels ----------------------------------------------------------
// Fixtures are the REAL nine courses off instructure.charlotte.edu (fields as
// the API returns them), because the shape is the opposite of what it looks
// like on screen: Canvas's `name` is already the friendly title, and
// `course_code` is the raw SIS blob. Guessing that backwards is what put
// '202680-MEGR-2141-Engineering Mechanics I-005-006-XLS2112202680_Combined' in
// the widgets — it was the course CODE, never the "full name".
const REAL = [
  { id: 1, name: 'Calculus III', course_code: '202680-MATH-2241-003-10505', original_name: '202680-Fall 2026-MATH-2241-003-Calculus III' },
  { id: 2, name: 'Differential Equations', course_code: '202680-MATH-2171-005-10500', original_name: '202680-Fall 2026-MATH-2171-005-Differential Equations' },
  { id: 3, name: 'Engineering Mechanics I', course_code: '202680-MEGR-2141-Engineering Mechanics I-005-006-XLS2112202680_Combined', original_name: '202680-Fall 2026-MEGR-2141-Engineering Mechanics I-005-006_Combined' },
  { id: 4, name: 'First-Year New Student Modules, Lee College of Engineering - Spring 2026', course_code: 'FYNSM_LCOE_Spring2026' },
  { id: 5, name: 'Foundations of Math and Science for Engineering', course_code: '202680-ENGR-1301-005:ENGR-1301-006:ENGR-1301-007:ENGR-1301-010-XLS2060202680_Combined-Lattimore', original_name: '202680-Fall 2026-ENGR-1301-005:ENGR-1301-006:ENGR-1301-007:ENGR-1301-010_Combined-Lattimore' },
  { id: 6, name: 'Mechatronics I', course_code: '202680-ECGR-2161-L01:ECGR-2161-L03:ECGR-2161-L05:ECGR-2161-L07:MEGR-2173-001-XLS47202680_Combined', original_name: '202680-Fall 2026-ECGR-2161-L01:ECGR-2161-L03:ECGR-2161-L05:ECGR-2161-L07:MEGR-2173-001_Combined' },
  { id: 7, name: 'Mechatronics I Lab', course_code: '202680-Mechatronics I-XLS2062202680_Combined', original_name: '202680-Fall 2026-Mechatronics I_Combined' },
  { id: 8, name: 'Thermodynamics I', course_code: '202680-MEGR-3111-004-14239', original_name: '202680-Fall 2026-MEGR-3111-004-Thermodynamics I' },
  { id: 9, name: 'Training - LCOE MAPS Program - Spring 2026', course_code: 'Training - LCOE MAPS Program - Spring 2026' },
]
const byId = (n) => REAL.find((c) => c.id === n)

// A course nicknamed in Canvas shows that nickname in BOTH modes — code mode
// exists to shorten, and the SIS code is three times longer here.
for (const mode of ['nick', 'code']) {
  assert.equal(courseLabel(byId(1), mode, {}), 'Calculus III')
  assert.equal(courseLabel(byId(3), mode, {}), 'Engineering Mechanics I')
  assert.equal(courseLabel(byId(8), mode, {}), 'Thermodynamics I')
}
// The regression: no label, in either mode, may be one of those SIS strings.
for (const c of REAL) {
  for (const mode of ['nick', 'code']) {
    const out = courseLabel(c, mode, {})
    assert.ok(!/XLS\d|_Combined|^\d{6}-/.test(out), `${mode} mode leaked a SIS code: ${out}`)
    assert.ok(out.length <= c.name.length, `${mode} mode grew the label: ${out}`)
  }
}
// No nickname set in Canvas (no original_name) → the code, when it's shorter.
assert.equal(courseLabel(byId(4), 'nick', {}), 'FYNSM_LCOE_Spring2026')
assert.equal(courseLabel(byId(4), 'code', {}), 'FYNSM_LCOE_Spring2026')
// An Atlas nickname/code always wins outright.
assert.equal(courseLabel(byId(3), 'nick', { 3: { nick: 'Statics' } }), 'Statics')
assert.equal(courseLabel(byId(3), 'code', { 3: { code: 'MEGR' } }), 'MEGR')
// Neither a Canvas nickname nor a course_code → the name is the last resort.
assert.equal(courseNick({ id: 99, name: 'Intro to Whatever' }, {}), 'Intro to Whatever')
assert.equal(courseCodeOf({ id: 99, name: 'Intro to Whatever' }, {}), 'Intro to Whatever')
// A genuinely short course_code still wins code mode, which is the whole point.
const tidy = { id: 98, name: 'Organic Chemistry Laboratory II', course_code: 'CHEM-2132' }
assert.equal(courseLabel(tidy, 'nick', {}), 'CHEM-2132') // no Canvas nickname → code per the stated rule
assert.equal(courseLabel(tidy, 'code', {}), 'CHEM-2132')

console.log('canvas grade-scale + course-label checks passed')
