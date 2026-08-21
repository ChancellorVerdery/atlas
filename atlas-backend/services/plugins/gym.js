// Gym plugin service — mirrors atlas.gym.v1.
//
// Blob shape (see atlas-ui/src/page/gym.js loadGym()):
//   { v:1, workouts[], exercises[], logs[], completions[],
//     plan:{type:'weekly'|'cycle', weekly:{day→workoutId|null},
//           cycle:{order:[workoutId,...], position:int},
//           overrides:{'YYYY-MM-DD'→workoutId|'skip'},
//           extras:{'YYYY-MM-DD'→[exerciseId,...]}},
//     unit:'kg'|'lbs', address:'', hours:{day→{open,close}}, defaultDuration }
//
// IMPORTANT: the wire carries RAW localStorage — backup imports (renderer.js
// importData, main.js importAll at first login) push blobs loadGym() has never
// touched, including legacy shapes like hours:{start,end}. decompose therefore
// runs the loader's EXACT normalization first (normalizeGym below); a save must
// never fail on a state the app's own loader tolerates. recompose consequently
// returns the loader-normalized shape — the same thing the client would see
// after its next loadGym().
//
// Fidelity notes (all derived from the actual loader/mutators, not the spec):
// - workouts: rest/flex keys are ABSENT on rows made by addWorkout and only
//   appear (as booleans) once the settings checkboxes are touched. NULL = key
//   absent; a present non-boolean (foreign blob) is coerced with !! so the
//   boolean column can never reject it.
// - exercises: loadGym() only requires id+name, so unilateral/workoutId/target
//   may be absent on imported data. All three nullable: NULL = key absent.
// - logs: loadGym keeps any {exerciseId, sets:[]} row — id and date are NOT
//   required, ids may duplicate, side is unvalidated free text, and duplicate
//   (exercise,date,side) triples render fine (logsFor picks the first). So:
//   no PK, no unique index, no CHECK on side, date as text. Identity = array
//   position (ord), like completions. exercise_id is a soft ref: removeWorkout
//   cascades exercises but NOT their logs, so orphans are normal.
// - completions: append-only, no client id; loader only requires isObj. date
//   is text (never validated), ts numeric (loader never checks it; a
//   non-number ts is dropped rather than 500ing the save).
// - plan.weekly/hours: normalizeGym guarantees all 7 day keys but PRESERVES
//   extra keys the loader keeps; hours values are normalized to string
//   open/close exactly like the loader does for day keys. Both maps are
//   rebuilt with Object.fromEntries on recompose so a '__proto__' key stays a
//   plain own property instead of mutating the prototype.
// - plan.cycle.order entries are unvalidated by the loader → workout_id is
//   nullable (a null entry must survive).
// - defaultDuration is jsonb, not numeric: the loader keeps numeric STRINGS
//   ('75') verbatim (Number('75') > 0), and a numeric column would silently
//   retype them — same reasoning as ladder's settings.buffer.

import { runPlugin } from '../../lib/runner.js'

const ddl = `
CREATE SCHEMA IF NOT EXISTS gym;

CREATE TABLE IF NOT EXISTS gym.settings (
  user_id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  unit             text NOT NULL DEFAULT 'kg' CHECK (unit IN ('kg','lbs')),
  address          text NOT NULL DEFAULT '',
  default_duration jsonb NOT NULL DEFAULT '75',
  plan_type        text NOT NULL DEFAULT 'weekly' CHECK (plan_type IN ('weekly','cycle')),
  cycle_position   integer NOT NULL DEFAULT 0,
  ord              integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS gym.hours (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day     text NOT NULL,                 -- 'mon'..'sun' plus any extra keys the loader keeps
  open    text NOT NULL DEFAULT '',      -- 'HH:MM' or '' = unconstrained
  close   text NOT NULL DEFAULT '',
  ord     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS gym.workouts (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id      text NOT NULL,                 -- 'gw-...'
  name    text NOT NULL,
  rest    boolean,                       -- NULL = key absent (never toggled)
  flex    boolean,                       -- NULL = key absent
  ord     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS gym.exercises (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id         text NOT NULL,              -- 'ge-...'
  workout_id text,                       -- soft ref; NULL = key absent (loader tolerates it)
  name       text NOT NULL,
  unilateral boolean,                    -- NULL = key absent (loader does not backfill)
  target     text,                       -- free text '3×8'; NULL = key absent, '' = cleared
  ord        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS gym.logs (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id          text,                      -- 'gl-...'; NULL = key absent (loader keeps id-less logs)
  exercise_id text NOT NULL,             -- soft ref: workout removal orphans logs by design
  date        text,                      -- 'YYYY-MM-DD'; text + nullable: loader never validates it
  side        text,                      -- null|'L'|'R' from the app; no CHECK — loader keeps any value
  sets        jsonb NOT NULL,            -- ordered [{weight (kg), reps}] — append/pop
  ord         integer NOT NULL DEFAULT 0 -- array position IS the identity (no PK: dup ids and
);                                       -- dup exercise+date+side triples are loader-valid)

CREATE TABLE IF NOT EXISTS gym.completions (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workout_id text,                       -- soft ref: never cleaned on workout delete
  date       text,
  ts         numeric,                    -- epoch ms (numeric: loader never validates it)
  start_time text,                       -- 'HH:MM' or '' (always written by completeWorkout)
  end_time   text,
  ord        integer NOT NULL DEFAULT 0  -- array position IS the identity (append-only)
);

CREATE TABLE IF NOT EXISTS gym.plan_weekly (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day        text NOT NULL,              -- 'mon'..'sun' plus any extra keys the loader keeps
  workout_id text,                       -- NULL = rest day
  ord        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS gym.plan_overrides (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date       text NOT NULL,              -- 'YYYY-MM-DD'
  workout_id text NOT NULL,              -- a workout id, or the literal 'skip'
  ord        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)            -- one deviation per day, last write wins
);

CREATE TABLE IF NOT EXISTS gym.plan_extras (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        text NOT NULL,             -- 'YYYY-MM-DD'
  exercise_id text NOT NULL,             -- soft ref, like gym.logs
  ord         integer NOT NULL DEFAULT 0 -- add order within the day
);

CREATE TABLE IF NOT EXISTS gym.plan_cycle (
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  position   integer NOT NULL,           -- array index; duplicate workout_ids allowed
  workout_id text,                       -- nullable: loader keeps null/absent order entries
  ord        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, position)
);
`

// undefined (key absent) → SQL NULL; everything else passes through.
const opt = v => (v === undefined ? null : v)
const isObj = o => o !== null && typeof o === 'object'

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

// Exact mirror of loadGym() (atlas-ui/src/page/gym.js), including the legacy
// hours:{start,end} → per-day migration. Builds a fresh object (never mutates
// the wire value) and uses Map/Object.fromEntries so hostile keys like
// '__proto__' become plain own properties.
function normalizeGym(raw) {
  const g = isObj(raw) ? raw : {}

  const plan = isObj(g.plan) ? g.plan : {}
  const weeklyIn = isObj(plan.weekly) ? plan.weekly : {}
  const weekly = new Map()
  for (const k of Object.keys(weeklyIn)) weekly.set(k, weeklyIn[k] ?? null)
  for (const d of DAYS) if (!weekly.has(d)) weekly.set(d, null)
  const cycle = isObj(plan.cycle) ? plan.cycle : {}

  const str = v => (typeof v === 'string' ? v : '')
  const hoursIn = isObj(g.hours) ? g.hours : {}
  const legacy = typeof hoursIn.start === 'string' || typeof hoursIn.end === 'string' ? hoursIn : null
  const hours = new Map()
  for (const k of Object.keys(hoursIn)) {
    if (k === 'start' || k === 'end') continue // consumed by the legacy migration
    hours.set(k, { open: str(hoursIn[k]?.open), close: str(hoursIn[k]?.close) })
  }
  for (const d of DAYS) {
    if (!isObj(hoursIn[d])) hours.set(d, { open: str(legacy?.start), close: str(legacy?.end) })
  }

  return {
    v: 1,
    workouts: (Array.isArray(g.workouts) ? g.workouts : [])
      .filter(w => isObj(w) && w.id && typeof w.name === 'string'),
    exercises: (Array.isArray(g.exercises) ? g.exercises : [])
      .filter(e => isObj(e) && e.id && typeof e.name === 'string'),
    logs: (Array.isArray(g.logs) ? g.logs : [])
      .filter(l => isObj(l) && l.exerciseId && Array.isArray(l.sets)),
    completions: (Array.isArray(g.completions) ? g.completions : []).filter(isObj),
    plan: {
      type: plan.type === 'cycle' ? 'cycle' : 'weekly',
      weekly: Object.fromEntries(weekly),
      cycle: {
        order: Array.isArray(cycle.order) ? cycle.order : [],
        position: Number.isInteger(cycle.position) ? cycle.position : 0,
      },
      // Per-date deviations: 'skip' or a workout id. Shape-validated only —
      // the CLIENT prunes dangling ids and stale dates on load, because that
      // pruning is time-based and the server's clock is not the user's.
      overrides: Object.fromEntries(
        Object.entries(isObj(plan.overrides) ? plan.overrides : {})
          .filter(([d, v]) => typeof d === 'string' && d && typeof v === 'string' && v),
      ),
      // date → [exerciseId]: exercises pulled into one day's session.
      extras: Object.fromEntries(
        Object.entries(isObj(plan.extras) ? plan.extras : {})
          .map(([d, list]) => [d, (Array.isArray(list) ? list : []).filter(x => typeof x === 'string' && x)])
          .filter(([d, list]) => typeof d === 'string' && d && list.length),
      ),
    },
    unit: g.unit === 'lbs' ? 'lbs' : 'kg',
    address: typeof g.address === 'string' ? g.address : '',
    hours: Object.fromEntries(hours),
    defaultDuration:
      Number.isFinite(Number(g.defaultDuration)) && Number(g.defaultDuration) > 0
        ? g.defaultDuration // kept verbatim — may be a numeric STRING (jsonb column)
        : 75,
  }
}

const mapper = {
  name: 'gym',
  schema: 'gym',
  storageKey: 'atlas.gym.v1',
  ddl,
  tables: [
    'settings',
    'hours',
    'workouts',
    'exercises',
    'logs',
    'completions',
    'plan_weekly',
    'plan_cycle',
    'plan_overrides',
    'plan_extras',
  ],

  decompose(raw) {
    const g = normalizeGym(raw)
    return {
      settings: [{
        unit: g.unit,
        address: g.address,
        default_duration: JSON.stringify(g.defaultDuration), // jsonb: '75' vs 75 round-trips
        plan_type: g.plan.type,
        cycle_position: g.plan.cycle.position,
      }],
      hours: Object.keys(g.hours).map(day => ({
        day,
        open: g.hours[day].open,
        close: g.hours[day].close,
      })),
      workouts: g.workouts.map(w => ({
        id: w.id,
        name: w.name,
        // present non-booleans (foreign blobs) are coerced so the boolean
        // column can never reject a loader-tolerated state
        rest: w.rest === undefined ? null : !!w.rest,
        flex: w.flex === undefined ? null : !!w.flex,
      })),
      exercises: g.exercises.map(e => ({
        id: e.id,
        workout_id: opt(e.workoutId),
        name: e.name,
        unilateral: e.unilateral === undefined ? null : !!e.unilateral,
        target: opt(e.target),
      })),
      logs: g.logs.map(l => ({
        id: opt(l.id),                       // loader keeps id-less logs
        exercise_id: l.exerciseId,
        date: opt(l.date),                   // loader keeps date-less logs
        side: l.side ?? null,
        sets: JSON.stringify(l.sets),        // jsonb — keep the array a JSON array
      })),
      completions: g.completions.map(c => ({
        workout_id: opt(c.workoutId),
        date: opt(c.date),
        // a non-number ts (foreign blob) is dropped rather than failing numeric
        ts: typeof c.ts === 'number' && Number.isFinite(c.ts) ? c.ts : null,
        start_time: opt(c.start),
        end_time: opt(c.end),
      })),
      plan_weekly: Object.keys(g.plan.weekly).map(day => ({
        day,
        workout_id: g.plan.weekly[day],      // workoutId or null
      })),
      plan_cycle: g.plan.cycle.order.map((workoutId, i) => ({
        position: i,
        workout_id: workoutId ?? null,       // null entries are loader-valid
      })),
      plan_overrides: Object.keys(g.plan.overrides).map(date => ({
        date,
        workout_id: g.plan.overrides[date],  // workout id or 'skip'
      })),
      // flattened; ord preserves add order, and recompose regroups by date
      plan_extras: Object.keys(g.plan.extras).flatMap(date =>
        g.plan.extras[date].map(exercise_id => ({ date, exercise_id }))),
    }
  },

  recompose(rows) {
    const s = rows.settings[0]
    return {
      v: 1,
      workouts: rows.workouts.map(r => {
        const w = { id: r.id, name: r.name }
        if (r.rest !== null) w.rest = r.rest
        if (r.flex !== null) w.flex = r.flex
        return w
      }),
      exercises: rows.exercises.map(r => {
        const e = { id: r.id }
        if (r.workout_id !== null) e.workoutId = r.workout_id
        e.name = r.name
        if (r.unilateral !== null) e.unilateral = r.unilateral
        if (r.target !== null) e.target = r.target
        return e
      }),
      logs: rows.logs.map(r => {
        const l = {}
        if (r.id !== null) l.id = r.id       // NULL = key absent
        l.exerciseId = r.exercise_id
        if (r.date !== null) l.date = r.date
        l.side = r.side                      // null | 'L' | 'R' (absent ⇔ null, logSet's rule)
        l.sets = r.sets                      // jsonb comes back parsed
        return l
      }),
      completions: rows.completions.map(r => {
        const c = {}
        if (r.workout_id !== null) c.workoutId = r.workout_id
        if (r.date !== null) c.date = r.date
        if (r.ts !== null) c.ts = r.ts       // numeric parser returns a Number
        if (r.start_time !== null) c.start = r.start_time
        if (r.end_time !== null) c.end = r.end_time
        return c
      }),
      plan: {
        type: s.plan_type,
        // fromEntries: a '__proto__' day stays an own key (no prototype writes)
        weekly: Object.fromEntries(rows.plan_weekly.map(r => [r.day, r.workout_id])),
        cycle: {
          order: rows.plan_cycle.map(r => r.workout_id),
          position: s.cycle_position,
        },
        // fromEntries so a hostile date key stays an own property
        overrides: Object.fromEntries(rows.plan_overrides.map(r => [r.date, r.workout_id])),
        extras: rows.plan_extras.reduce((acc, r) => {
          ;(acc[r.date] ||= []).push(r.exercise_id)
          return acc
        }, Object.create(null)),
      },
      unit: s.unit,
      address: s.address,
      hours: Object.fromEntries(rows.hours.map(r => [r.day, { open: r.open, close: r.close }])),
      defaultDuration: s.default_duration,   // jsonb: number or numeric string, verbatim
    }
  },
}

export default mapper
if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
