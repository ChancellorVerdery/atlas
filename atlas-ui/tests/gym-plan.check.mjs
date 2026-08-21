// Gym plan overrides: skipping a day and doing a different workout than the
// plan picked. The cycle position is the thing that can silently corrupt a
// plan — skipping must leave it alone, and completing an override must resume
// after the workout ACTUALLY done — so that is what this pins down.
// Run: node tests/gym-plan.check.mjs
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
}

const {
  loadGym, saveGym, addWorkout, currentWorkout, completeWorkout,
  plannedWorkoutFor, setDayOverride, dayOverride, todayKey, SKIP,
} = await import('../src/page/gym.js')

const NOW = new Date(2026, 7, 21) // a Friday
const cycleGym = () => {
  store.clear()
  const g = loadGym()
  const push = addWorkout(g, 'Push')
  const pull = addWorkout(g, 'Pull')
  const legs = addWorkout(g, 'Legs')
  g.plan.type = 'cycle'
  g.plan.cycle.order = [push.id, pull.id, legs.id]
  g.plan.cycle.position = 0
  saveGym(g)
  return { g, push, pull, legs }
}

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

check('with no override the cycle behaves exactly as before', () => {
  const { g, push, pull } = cycleGym()
  assert.equal(currentWorkout(g, NOW).id, push.id)
  completeWorkout(g, NOW)
  assert.equal(g.plan.cycle.position, 1)
  assert.equal(currentWorkout(g, NOW).id, pull.id)
})

check('skipping a day shows nothing on and leaves the cycle where it was', () => {
  const { g, push } = cycleGym()
  setDayOverride(g, SKIP, todayKey(NOW))
  assert.equal(currentWorkout(g, NOW), null, 'a skipped day has no workout')
  assert.equal(dayOverride(g, todayKey(NOW)), SKIP)
  assert.equal(g.plan.cycle.position, 0, 'skipping the DAY must not consume the workout')
  // Undoing it puts the same workout back.
  setDayOverride(g, null, todayKey(NOW))
  assert.equal(currentWorkout(g, NOW).id, push.id)
})

check('a skipped day is not scheduled by the planner', () => {
  const { g } = cycleGym()
  assert.notEqual(plannedWorkoutFor(g, NOW, NOW), null)
  setDayOverride(g, SKIP, todayKey(NOW))
  assert.equal(plannedWorkoutFor(g, NOW, NOW), null)
})

check('choosing a specific workout overrides the plan for that day only', () => {
  const { g, legs } = cycleGym()
  setDayOverride(g, legs.id, todayKey(NOW))
  assert.equal(currentWorkout(g, NOW).id, legs.id)
  assert.equal(plannedWorkoutFor(g, NOW, NOW).id, legs.id, 'the planner schedules what was chosen')
  const tomorrow = new Date(2026, 7, 22)
  assert.equal(dayOverride(g, todayKey(tomorrow)), null, 'the override is that day only')
})

check('completing an overridden day resumes after the workout actually done', () => {
  const { g, push, legs } = cycleGym()
  assert.equal(currentWorkout(g, NOW).id, push.id) // cycle points at Push
  setDayOverride(g, legs.id, todayKey(NOW))        // ...but Legs got done
  completeWorkout(g, NOW)
  // Legs is index 2, so the cycle resumes at 0 (Push) — NOT at 1, which would
  // have quietly eaten Push without it ever being trained.
  assert.equal(g.plan.cycle.position, 0)
  assert.equal(g.completions.at(-1).workoutId, legs.id)
})

check('a weekly plan takes the override too', () => {
  store.clear()
  const g = loadGym()
  const a = addWorkout(g, 'Upper')
  const b = addWorkout(g, 'Lower')
  g.plan.type = 'weekly'
  g.plan.weekly.fri = a.id
  saveGym(g)
  assert.equal(currentWorkout(g, NOW).id, a.id)
  setDayOverride(g, b.id, todayKey(NOW))
  assert.equal(currentWorkout(g, NOW).id, b.id)
  setDayOverride(g, SKIP, todayKey(NOW))
  assert.equal(currentWorkout(g, NOW), null)
})

check('an override pointing at a deleted workout is dropped on load', () => {
  const { g, legs } = cycleGym()
  setDayOverride(g, legs.id, todayKey(NOW))
  g.workouts = g.workouts.filter((w) => w.id !== legs.id) // deleted behind its back
  saveGym(g)
  const reloaded = loadGym()
  assert.equal(dayOverride(reloaded, todayKey(NOW)), null, 'a dangling override must not survive')
  assert.notEqual(currentWorkout(reloaded, NOW), null, 'and the plan takes over again')
})

check('overrides older than the keep window are pruned', () => {
  const { g, legs } = cycleGym()
  const old = todayKey(new Date(Date.now() - 200 * 86400000))
  const recent = todayKey(new Date(Date.now() - 3 * 86400000))
  setDayOverride(g, legs.id, old)
  setDayOverride(g, legs.id, recent)
  const reloaded = loadGym()
  assert.equal(dayOverride(reloaded, old), null, 'an ancient override should be gone')
  assert.equal(dayOverride(reloaded, recent), legs.id, 'a recent one should survive')
})

console.log(failures ? `\n${failures} failed` : '\ngym-plan.check: all good')
process.exit(failures ? 1 : 0)
