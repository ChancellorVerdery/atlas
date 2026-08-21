// Gym plugin data + scoring. Pure data/localStorage — no DOM (UI in gymui.js).
//
// Model: a WORKOUT is a session type ("Chest & Back") owning EXERCISES; the
// PLAN schedules workouts either weekly (fixed weekday assignments) or as a
// cycle (ordered list; completing one advances to the next). Logging is per
// exercise per day: a list of sets (weight × reps), one entry per side for
// unilateral exercises.
//
// Scoring: an exercise's session score = best estimated 1RM that day
// (Epley: weight × (1 + reps/30); bodyweight fallback: reps). The general
// strength score is a PROGRESS INDEX: each exercise is normalized to 100 at
// its first logged session and the general score averages those indexes, so
// equal % gains on light and heavy lifts move it equally.

const KEY = 'atlas.gym.v1'
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const isObj = (o) => o !== null && typeof o === 'object'

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
export const DAY_LABELS = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }

// A day can deviate from the plan two ways: not training at all (SKIP), or
// training a workout the plan didn't pick. Both are per-date, so neither
// disturbs the plan itself — a skipped cycle day leaves the position where it
// was, which is the whole point: you skipped the DAY, not the workout.
export const SKIP = 'skip'
const OVERRIDE_KEEP_DAYS = 90

export const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayOf = (d = new Date()) => DAYS[(d.getDay() + 6) % 7] // JS sunday=0 → our mon-first keys

export function loadGym() {
  let g
  try { g = JSON.parse(localStorage.getItem(KEY)) } catch { /* fresh */ }
  if (!isObj(g)) g = {}
  g.v = 1
  g.workouts = (Array.isArray(g.workouts) ? g.workouts : []).filter((w) => isObj(w) && w.id && typeof w.name === 'string')
  g.exercises = (Array.isArray(g.exercises) ? g.exercises : []).filter((e) => isObj(e) && e.id && typeof e.name === 'string')
  g.logs = (Array.isArray(g.logs) ? g.logs : []).filter((l) => isObj(l) && l.exerciseId && Array.isArray(l.sets))
  g.completions = (Array.isArray(g.completions) ? g.completions : []).filter(isObj)
  if (!isObj(g.plan)) g.plan = {}
  g.plan.type = g.plan.type === 'cycle' ? 'cycle' : 'weekly'
  if (!isObj(g.plan.weekly)) g.plan.weekly = {}
  for (const d of DAYS) g.plan.weekly[d] ??= null
  if (!isObj(g.plan.cycle)) g.plan.cycle = {}
  g.plan.cycle.order = Array.isArray(g.plan.cycle.order) ? g.plan.cycle.order : []
  g.plan.cycle.position = Number.isInteger(g.plan.cycle.position) ? g.plan.cycle.position : 0
  // One-day deviations from the plan, keyed by date so they expire on their own
  // instead of needing to be cleared the next morning. Entries pointing at a
  // deleted workout are dropped here rather than guarded at every read site,
  // and dates drop out after OVERRIDE_KEEP_DAYS so this can't grow forever —
  // it rides the synced atlas.* blob. YYYY-MM-DD compares correctly as a string.
  if (!isObj(g.plan.overrides)) g.plan.overrides = {}
  const cutoff = todayKey(new Date(Date.now() - OVERRIDE_KEEP_DAYS * 86400000))
  for (const [date, v] of Object.entries(g.plan.overrides)) {
    const known = v === SKIP || g.workouts.some((w) => w.id === v)
    if (typeof v !== 'string' || !known || date < cutoff) delete g.plan.overrides[date]
  }
  // Exercises pulled into a single day's session that the workout doesn't own —
  // the machine was busy, so something else got done instead. Same date-keyed,
  // self-pruning shape as overrides.
  if (!isObj(g.plan.extras)) g.plan.extras = {}
  for (const [date, list] of Object.entries(g.plan.extras)) {
    const kept = (Array.isArray(list) ? list : [])
      .filter((id) => typeof id === 'string' && g.exercises.some((e) => e.id === id))
    if (!kept.length || date < cutoff) delete g.plan.extras[date]
    else g.plan.extras[date] = [...new Set(kept)]
  }
  g.unit = g.unit === 'lbs' ? 'lbs' : 'kg'
  if (typeof g.address !== 'string') g.address = '' // gym location, used by the Ladder planner
  // Per-weekday open/close — the gym's actual hours, not a preferred window.
  // Migrates the old single {start,end} pair (applied to every day) if present.
  if (!isObj(g.hours)) g.hours = {}
  const legacy = typeof g.hours.start === 'string' || typeof g.hours.end === 'string' ? g.hours : null
  for (const d of DAYS) {
    if (!isObj(g.hours[d])) g.hours[d] = { open: legacy?.start || '', close: legacy?.end || '' }
    if (typeof g.hours[d].open !== 'string') g.hours[d].open = ''
    if (typeof g.hours[d].close !== 'string') g.hours[d].close = ''
  }
  delete g.hours.start
  delete g.hours.end
  if (!Number.isFinite(Number(g.defaultDuration)) || Number(g.defaultDuration) <= 0) g.defaultDuration = 75
  return g
}

// Weights are stored canonically in KG (scores and history survive unit
// toggles unharmed); the unit preference converts only at the UI edges.
export const KG_PER_LB = 0.45359237
export const toDisplayWeight = (kg, unit) => Math.round((unit === 'lbs' ? kg / KG_PER_LB : kg) * 10) / 10
export const toKgWeight = (value, unit) => {
  const v = Number(value) || 0
  return Math.round((unit === 'lbs' ? v * KG_PER_LB : v) * 1000) / 1000
}

export function saveGym(g) {
  localStorage.setItem(KEY, JSON.stringify(g))
}

// ---- workouts & exercises --------------------------------------------------

export function addWorkout(g, name) {
  const w = { id: uid('gw'), name }
  g.workouts.push(w)
  saveGym(g)
  return w
}
export function removeWorkout(g, id) {
  g.workouts = g.workouts.filter((w) => w.id !== id)
  g.exercises = g.exercises.filter((e) => e.workoutId !== id)
  for (const d of DAYS) if (g.plan.weekly[d] === id) g.plan.weekly[d] = null
  g.plan.cycle.order = g.plan.cycle.order.filter((x) => x !== id)
  g.plan.cycle.position = Math.min(g.plan.cycle.position, Math.max(0, g.plan.cycle.order.length - 1))
  saveGym(g)
}
export function addExercise(g, workoutId, name, unilateral = false) {
  const e = { id: uid('ge'), workoutId, name, unilateral }
  g.exercises.push(e)
  saveGym(g)
  return e
}
export function removeExercise(g, id) {
  g.exercises = g.exercises.filter((e) => e.id !== id)
  g.logs = g.logs.filter((l) => l.exerciseId !== id)
  saveGym(g)
}
export const workoutById = (g, id) => g.workouts.find((w) => w.id === id)
export const exerciseById = (g, id) => g.exercises.find((e) => e.id === id)
export const exercisesOf = (g, workoutId) => g.exercises.filter((e) => e.workoutId === workoutId)

// ---- one-day extra exercises -------------------------------------------------
// A session is the workout's own exercises PLUS anything added for that date.
// Extras are appended in the order they were added, after the planned ones, and
// an exercise already in the workout is never duplicated.
export const dayExtras = (g, date = todayKey()) => g.plan.extras?.[date] ?? []

export function exercisesForDay(g, workoutId, date = todayKey()) {
  const planned = exercisesOf(g, workoutId)
  const have = new Set(planned.map((e) => e.id))
  const extra = dayExtras(g, date)
    .filter((id) => !have.has(id))
    .map((id) => exerciseById(g, id))
    .filter(Boolean)
  return [...planned, ...extra]
}

export function addDayExercise(g, exerciseId, date = todayKey()) {
  if (!exerciseById(g, exerciseId)) return g
  const list = g.plan.extras[date] ?? []
  if (!list.includes(exerciseId)) g.plan.extras[date] = [...list, exerciseId]
  saveGym(g)
  return g
}

export function removeDayExercise(g, exerciseId, date = todayKey()) {
  const list = (g.plan.extras[date] ?? []).filter((id) => id !== exerciseId)
  if (list.length) g.plan.extras[date] = list
  else delete g.plan.extras[date]
  saveGym(g)
  return g
}

// ---- logging ----------------------------------------------------------------

// One log entry per exercise+day+side. side: null | 'L' | 'R'.
export function logSet(g, exerciseId, side, weight, reps, date = todayKey()) {
  let entry = g.logs.find((l) => l.exerciseId === exerciseId && l.date === date && (l.side ?? null) === (side ?? null))
  if (!entry) g.logs.push(entry = { id: uid('gl'), exerciseId, date, side: side ?? null, sets: [] })
  entry.sets.push({ weight: Number(weight) || 0, reps: Math.max(1, Number(reps) || 1) })
  saveGym(g)
  return entry
}
export function removeLastSet(g, exerciseId, side, date = todayKey()) {
  const entry = g.logs.find((l) => l.exerciseId === exerciseId && l.date === date && (l.side ?? null) === (side ?? null))
  if (!entry) return
  entry.sets.pop()
  if (!entry.sets.length) g.logs = g.logs.filter((l) => l !== entry)
  saveGym(g)
}
// Drop one set by index; empties the day's entry away when its last set goes.
export function removeSetAt(g, exerciseId, side, date, idx) {
  const entry = g.logs.find((l) => l.exerciseId === exerciseId && l.date === date && (l.side ?? null) === (side ?? null))
  if (!entry) return
  entry.sets.splice(idx, 1)
  if (!entry.sets.length) g.logs = g.logs.filter((l) => l !== entry)
  saveGym(g)
}
// Delete a whole logged day for an exercise (all sides) — for accidental logs.
export function removeLogsForDate(g, exerciseId, date) {
  g.logs = g.logs.filter((l) => !(l.exerciseId === exerciseId && l.date === date))
  saveGym(g)
}
export const logsFor = (g, exerciseId, date, side = null) =>
  g.logs.find((l) => l.exerciseId === exerciseId && l.date === date && (l.side ?? null) === side)

// ---- scoring ----------------------------------------------------------------

export const est1RM = (s) => (s.weight > 0 ? s.weight * (1 + s.reps / 30) : s.reps)
const bestOf = (sets) => Math.max(...sets.map(est1RM), 0)

// [{date, score}] ascending; unilateral days average the sides logged.
export function exerciseSeries(g, exerciseId) {
  const byDate = new Map()
  for (const l of g.logs) {
    if (l.exerciseId !== exerciseId || !l.sets.length) continue
    if (!byDate.has(l.date)) byDate.set(l.date, [])
    byDate.get(l.date).push(bestOf(l.sets))
  }
  return [...byDate.entries()]
    .map(([date, scores]) => ({ date, score: scores.reduce((a, b) => a + b, 0) / scores.length }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
}

// Progress index for one exercise at (or before) a date: 100 at first log.
function indexAt(series, date) {
  if (!series.length || series[0].date > date) return null
  let last = series[0]
  for (const p of series) { if (p.date > date) break; last = p }
  return series[0].score > 0 ? (100 * last.score) / series[0].score : 100
}

// Latest general score (average progress index across logged exercises).
export function generalScore(g) {
  const today = todayKey()
  const idx = g.exercises.map((e) => indexAt(exerciseSeries(g, e.id), today)).filter((x) => x != null)
  return idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : null
}

// [{date, score}] — the general score recomputed at every date a log exists.
export function generalSeries(g) {
  const series = new Map(g.exercises.map((e) => [e.id, exerciseSeries(g, e.id)]))
  const dates = [...new Set(g.logs.map((l) => l.date))].sort()
  return dates.map((date) => {
    const idx = [...series.values()].map((s) => indexAt(s, date)).filter((x) => x != null)
    return { date, score: idx.length ? idx.reduce((a, b) => a + b, 0) / idx.length : null }
  }).filter((p) => p.score != null)
}

// ---- plan -------------------------------------------------------------------

// null when nothing is on: no plan, or the day was skipped. Callers that need
// to tell those apart ask dayOverride() — the widget says "skipped", not
// "set up your plan".
export const dayOverride = (g, date = todayKey()) => g.plan.overrides?.[date] ?? null

// Today's override, if any, wins over the plan; 'skip' means nothing is on.
export function setDayOverride(g, value, date = todayKey()) {
  if (value) g.plan.overrides[date] = value
  else delete g.plan.overrides[date]
  saveGym(g)
  return g
}

export function currentWorkout(g, now = new Date()) {
  const ov = dayOverride(g, todayKey(now))
  if (ov === SKIP) return null
  if (ov) return workoutById(g, ov) ?? null
  if (g.plan.type === 'weekly') return workoutById(g, g.plan.weekly[dayOf(now)])
  const o = g.plan.cycle.order
  return o.length ? workoutById(g, o[g.plan.cycle.position % o.length]) : null
}

// Next n workouts after the current one. Weekly: walks the coming days
// (skipping rest days, labeled by day); cycle: walks the order, wrapping.
export function upcomingWorkouts(g, n, now = new Date()) {
  const out = []
  if (g.plan.type === 'weekly') {
    for (let i = 1; out.length < n && i <= 28; i++) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
      const w = workoutById(g, g.plan.weekly[dayOf(d)])
      if (w) out.push({ workout: w, label: DAY_LABELS[dayOf(d)] })
    }
  } else {
    const o = g.plan.cycle.order
    for (let i = 1; o.length && out.length < n; i++) {
      const w = workoutById(g, o[(g.plan.cycle.position + i) % o.length])
      if (w) out.push({ workout: w, label: `Up next ${out.length + 1}` })
    }
  }
  return out
}

// times: optional {start, end} "HH:MM" strings — sessions with times feed the
// per-workout historic duration average the Ladder planner schedules with.
export function completeWorkout(g, now = new Date(), times = {}) {
  const w = currentWorkout(g, now)
  if (!w) return null
  g.completions.push({ workoutId: w.id, date: todayKey(now), ts: now.getTime(), start: times.start || '', end: times.end || '' })
  if (g.plan.type === 'cycle' && g.plan.cycle.order.length) {
    // Normally the cycle was already pointing at what was just done, so advance
    // from the position. But if today was overridden to a different workout,
    // resume after the one ACTUALLY done — advancing from the position would
    // silently consume the workout that was passed over.
    // ponytail: indexOf, so an order listing the same workout twice resumes at
    // its first occurrence. Store the chosen index on the override if that ever
    // matters; it doesn't for a plan you'd hand-build.
    const ov = dayOverride(g, todayKey(now))
    const chosen = ov && ov !== SKIP ? g.plan.cycle.order.indexOf(w.id) : -1
    const from = chosen >= 0 ? chosen : g.plan.cycle.position
    g.plan.cycle.position = (from + 1) % g.plan.cycle.order.length
  }
  saveGym(g)
  return w
}

// ---- planner integration ------------------------------------------------------

const hmToMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

// Average session length (minutes) for a workout from timed completions;
// overnight sessions wrap. Falls back to the gym-wide default duration.
export function workoutDuration(g, workoutId) {
  const spans = g.completions
    .filter((c) => c.workoutId === workoutId && hmToMin(c.start) != null && hmToMin(c.end) != null)
    .map((c) => ((hmToMin(c.end) - hmToMin(c.start) + 1440) % 1440))
    .filter((m) => m > 0)
  if (!spans.length) return Number(g.defaultDuration)
  return Math.round(spans.reduce((a, b) => a + b, 0) / spans.length)
}

// The workout planned for a future date. Weekly plans map weekday → workout
// directly. Cycle plans only truly know "what's next" — completion timing is
// user-driven, not calendar-driven — so future dates are PROJECTED assuming
// one cycle-workout happens per day from the CURRENT position onward (the
// natural reading of "a cycle": a repeating daily sequence). That's a real
// assumption, not a guarantee, but it beats never showing cycle-plan gym
// blocks at all.
const localDayMs = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

export function plannedWorkoutFor(g, date, now = new Date()) {
  if (g.completions.some((c) => c.date === todayKey(date))) return null // already done that day
  // A skipped day has nothing to schedule, and an overridden one schedules the
  // workout actually chosen — so the Ladder plans the real day, not the plan's.
  const ov = dayOverride(g, todayKey(date))
  if (ov === SKIP) return null
  if (ov) { const w = workoutById(g, ov); return w && !w.rest ? w : null }
  if (g.plan.type === 'weekly') {
    const w = workoutById(g, g.plan.weekly[dayOf(date)])
    return w && !w.rest ? w : null
  }
  const o = g.plan.cycle.order
  if (!o.length) return null
  const daysAhead = Math.round((localDayMs(date) - localDayMs(now)) / 86400000)
  if (daysAhead < 0) return null
  // Completing today's workout already advanced cycle.position PAST it, so the
  // position now points at the workout you're currently ON. Projecting forward
  // with a plain days-from-now offset would then count today a second time and
  // skip that current workout — the next gym day would show the one AFTER it.
  // When today is already logged, shift the projection back by one so the first
  // remaining day lands on the current position.
  const doneToday = g.completions.some((c) => c.date === todayKey(now)) ? 1 : 0
  const idx = ((g.plan.cycle.position + daysAhead - doneToday) % o.length + o.length) % o.length
  const w = workoutById(g, o[idx])
  return w && !w.rest ? w : null
}
