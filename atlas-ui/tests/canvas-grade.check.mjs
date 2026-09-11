// Local grade model self-check (node tests/canvas-grade.check.mjs).
// The gradebook's ▲/▼ show how far each assignment moved the overall course
// grade, which means re-deriving Canvas's current score locally. These pin the
// model to Canvas's rules; set CANVAS_FIXTURE=<path to a cached canvas.data
// payload> to also compare every course against Canvas's own computed score.
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { localScore, keptAssignments, courseEffects, fmtEffect } from '../src/page/canvas.js'

let nextId = 1
const A = (score, possible, extra = {}) => ({ id: nextId++, name: `a${nextId}`, points_possible: possible, submission: score === 'EX' ? { excused: true } : score == null ? {} : { score }, ...extra })
const G = (weight, assignments, rules = {}) => ({ id: nextId++, group_weight: weight, rules, assignments })
const C = (weighted, canvasPct = undefined) => ({ id: nextId++, apply_assignment_group_weights: weighted, enrollments: [{ type: 'student', computed_current_score: canvasPct }] })
const r2 = (n) => Math.round(n * 100) / 100

// ---- unweighted: one pool of points ------------------------------------------
{
  const gs = [G(0, [A(9, 10), A(4, 5)]), G(0, [A(15, 20)])]
  assert.equal(r2(localScore(C(false), gs)), r2((28 / 35) * 100))
  assert.equal(localScore(C(false), [G(0, [A(null, 10), A('EX', 10)])]), null) // nothing graded → no grade
  assert.equal(localScore(C(false), [G(0, [A(10, 10), A('EX', 10), A(null, 10)])]), 100) // excused and ungraded don't count
  assert.equal(localScore(C(false), [G(0, [A(5, 10), A(10, 10, { omit_from_final_grade: true })])]), 50)
  assert.equal(localScore(C(false), [G(0, [A(5, 10), A(3, 0)])]), 80) // 0-point assignment is pure extra credit
}

// ---- weighted: groups without a grade yet are left out and the rest renormalised
{
  const c = C(true)
  assert.equal(localScore(c, [G(40, [A(8, 10)]), G(60, [A(5, 10)])]), 80 * 0.4 + 50 * 0.6)
  assert.equal(r2(localScore(c, [G(40, [A(8, 10)]), G(60, [A(null, 10)])])), 80) // only the 40% group counts, scaled to 100
  assert.equal(r2(localScore(c, [G(30, [A(9, 10)]), G(30, [A(6, 10)]), G(40, [])])), 75)
  assert.equal(localScore(c, [G(60, [A(10, 10)]), G(60, [A(10, 10)])]), 120) // weights past 100 can exceed 100, as in Canvas
  assert.equal(localScore(c, [G(0, [A(10, 10)])]), null) // a weightless group alone is no grade
}

// ---- drop rules --------------------------------------------------------------
{
  // equal points: plain lowest goes
  const g = G(0, [A(10, 10), A(2, 10), A(7, 10)], { drop_lowest: 1 })
  assert.deepEqual(keptAssignments(g).map((a) => a.submission.score), [10, 7])
  assert.equal(localScore(C(false), [g]), 85)
  // unequal points: the drop that most helps the ratio, not the lowest percentage.
  // 1/2 is 50% and 30/60 is 50%, but dropping the 60-pointer leaves 91/92 vs 120/150.
  const g2 = G(0, [A(90, 90), A(1, 2), A(30, 60)], { drop_lowest: 1 })
  assert.deepEqual(keptAssignments(g2).map((a) => a.points_possible), [90, 2])
  // drop_highest, and both together
  assert.deepEqual(keptAssignments(G(0, [A(10, 10), A(2, 10), A(7, 10)], { drop_highest: 1 })).map((a) => a.submission.score), [2, 7])
  assert.deepEqual(keptAssignments(G(0, [A(10, 10), A(2, 10), A(7, 10), A(5, 10)], { drop_lowest: 1, drop_highest: 1 })).map((a) => a.submission.score).sort(), [5, 7])
  // never_drop pins an assignment even when it is the lowest
  const pinned = A(0, 10)
  assert.deepEqual(keptAssignments(G(0, [A(10, 10), pinned, A(7, 10)], { drop_lowest: 1, never_drop: [pinned.id] })).map((a) => a.submission.score), [0, 10])
  // too few graded to satisfy the rule: Canvas keeps at least one
  assert.deepEqual(keptAssignments(G(0, [A(3, 10)], { drop_lowest: 2 })).map((a) => a.submission.score), [3])
  assert.deepEqual(keptAssignments(G(0, [A(3, 10), A(9, 10)], { drop_lowest: 3 })).map((a) => a.submission.score), [9])
  // ungraded ones are not in the pool, so they are never "the lowest"
  assert.deepEqual(keptAssignments(G(0, [A(10, 10), A(null, 10), A(7, 10)], { drop_lowest: 1 })).map((a) => a.submission.score), [10])
}

// ---- effects: grade with the assignment minus grade without it -------------
{
  const low = A(1, 2), full = A(3, 3)
  const gs = [G(0, [full, low, A(2, 2), A(4, 4)])]
  const c = C(false)
  const eff = courseEffects(c, gs)
  assert.equal(r2(localScore(c, gs)), 90.91) // 10/11
  assert.equal(r2(eff.get(low.id)), r2((10 / 11 - 9 / 9) * 100)) // pulled it down from 100
  assert.equal(r2(eff.get(full.id)), r2((10 / 11 - 7 / 8) * 100)) // pulled it up
  assert.equal(eff.size, 4)
  // a dropped assignment moved the grade nowhere: null, not 0, so the UI can say "dropped"
  const dropped = A(0, 10)
  const eff2 = courseEffects(C(false), [G(0, [A(10, 10), dropped], { drop_lowest: 1 })])
  assert.equal(eff2.get(dropped.id), null)
  assert.equal(eff2.size, 2)
  // ungraded and excused never get an entry at all
  const ex = A('EX', 10), un = A(null, 10)
  assert.deepEqual([...courseEffects(C(false), [G(0, [A(5, 10), ex, un])]).keys()].length, 1)
  // nothing graded → nothing to show
  assert.equal(courseEffects(C(false), [G(0, [un])]).size, 0)
  // the model disagreeing with Canvas's own number (a rule we don't know) hides the arrows
  assert.equal(courseEffects(C(false, 42), [G(0, [A(5, 10)])]).size, 0)
  assert.equal(courseEffects(C(false, 50), [G(0, [A(5, 10)])]).size, 1)
  assert.equal(courseEffects(C(false, 50.004), [G(0, [A(5, 10)])]).size, 1) // Canvas rounds to 2dp; tolerate that
}

// ---- fmtEffect: ≥10 to one decimal, under 10 to two -------------------------
assert.equal(fmtEffect(12.345), '12.3')
assert.equal(fmtEffect(-12.345), '12.3') // sign is the arrow's job
assert.equal(fmtEffect(10), '10.0')
assert.equal(fmtEffect(9.999), '10.00') // under 10 rounds on two decimals even when that lands on 10
assert.equal(fmtEffect(0.346), '0.35')
assert.equal(fmtEffect(-0.004), '0.00') // → hidden by the UI

// ---- optional: every course in a real cached payload matches Canvas ---------
const fixture = process.env.CANVAS_FIXTURE
if (fixture && existsSync(fixture)) {
  const d = JSON.parse(readFileSync(fixture, 'utf8'))
  let compared = 0
  for (const c of d.courses) {
    const canvas = c.enrollments?.find((e) => e.type === 'student')?.computed_current_score
    if (canvas == null) continue
    const local = localScore(c, d.groups[c.id] || [])
    assert.ok(local != null && Math.abs(local - canvas) <= 0.01, `${c.name}: Canvas ${canvas} vs local ${local}`)
    compared++
  }
  console.log(`canvas-grade: matched Canvas on ${compared} course(s) from ${fixture}`)
}

console.log('canvas-grade: ok')
