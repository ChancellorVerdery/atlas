// Grade-scale self-check for the Canvas plugin (node tests/canvas.check.mjs).
// Pure-function imports only — nothing here touches localStorage.
import assert from 'node:assert/strict'
import { parseScale, cutsToLetter, courseLetter, pctToLetter, letterPoints, semesterGPA } from '../src/page/canvas.js'

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

console.log('canvas grade-scale checks passed')
