// Work plugin service — mirrors atlas.work.v1.
//
// State shape (src/page/work.js loadWork):
//   { wage, tips, openEnded, shifts[], ranges{}, upcoming[], address, calId }
// Shifts are entered EITHER as clock times (start/end strings, hours: null)
// OR as a duration (start/end: '', hours: number). An open shift has a start,
// end: '' and hours: null. wage on each shift is a snapshot at entry.
// Upcoming shifts written by addUpcoming always carry a concrete end; endMode
// records whether the user typed it ('est') or it was projected from history
// ('auto'); gcalId is '' until the Google Calendar push succeeds.
//
// Leniency notes — loadWork validates ONLY the top level (arrays are arrays,
// ranges is an object, address/calId are strings, tips/openEnded booleanized,
// wage finite-after-Number) and does ZERO per-item validation on
// shifts/upcoming/ranges. Raw blobs reach the mapper without going through
// the loader (first-login importAll, backup restore, verbatim re-pushes), so
// decompose mirrors the loader's top-level rules and treats every per-item
// key exactly the way the UI reads it. A save must never 500 on a state the
// loader tolerates:
// - shifts: missing keys coalesce the way the UI reads them (start/end → ''
//   as in isOpen/shiftHours; tips/wage → Number(v) || 0 as in shiftEarned;
//   hours → shiftHours' null fallback). date is free text — the loader never
//   guarantees ISO. id is nullable (the loader keeps id-less rows) and NOT a
//   primary key (duplicate ids are loader-valid; the runner's ord is row
//   identity). Recompose returns the coalesced shape.
// - upcoming: NULL = key absent on every column — legacy/imported records
//   lack endMode/gcalId (loadWork's own shape comment predates endMode) and
//   workui reads sh.endMode/sh.gcalId defensively. No PK for the same reason
//   as shifts.
// - ranges: a null period is loader-valid (rangeFor only falls back to
//   'week' at read time), so period is nullable and round-trips as null.
//   widget ids are object keys — unique by construction, so the PK stays.
// - Deviation from spec DDL: CHECK constraints on end_mode/period dropped —
//   the loader passes unknown values through untouched.

import { runPlugin } from '../../lib/runner.js'

// undefined (key absent) → SQL NULL; everything else passes through.
const opt = v => (v === undefined ? null : v)
const put = (obj, key, v) => { if (v !== null) obj[key] = v }
const isObj = o => o !== null && typeof o === 'object'

const mapper = {
  name: 'work',
  schema: 'work',
  storageKey: 'atlas.work.v1',

  ddl: `
CREATE SCHEMA IF NOT EXISTS work;

    CREATE TABLE IF NOT EXISTS work.settings (
      user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
      wage       numeric NOT NULL DEFAULT 0,
      tips       boolean NOT NULL DEFAULT false,
      open_ended boolean NOT NULL DEFAULT false,
      address    text NOT NULL DEFAULT '',
      cal_id     text NOT NULL DEFAULT '',
      job_type   text NOT NULL DEFAULT 'shift',  -- 'shift' | 'salary' (mapper normalizes)
      ord        integer NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS work.shifts (
      user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      id         text,                -- NULL = key absent (loader keeps id-less rows); NOT unique
      date       text,                -- free text (loader never validates); NULL = key absent
      start_time text NOT NULL DEFAULT '',
      end_time   text NOT NULL DEFAULT '',
      hours      numeric,
      tips       numeric NOT NULL DEFAULT 0,
      wage       numeric NOT NULL DEFAULT 0,
      ord        integer NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS work_shifts_user ON work.shifts (user_id);
    CREATE TABLE IF NOT EXISTS work.upcoming (
      user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      id         text,                -- NULL = key absent on every column below
      date       text,
      start_time text,
      end_time   text,
      end_mode   text,                -- 'est'|'auto' when app-written, unenforced
      gcal_id    text,
      ord        integer NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS work_upcoming_user ON work.upcoming (user_id);
    CREATE TABLE IF NOT EXISTS work.widget_ranges (
      user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      widget_id text NOT NULL,
      period    text,                 -- nullable: a null period is loader-valid
      ord       integer NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, widget_id)
    );
    -- shifts-per-page in each history widget (state.histPer: widgetId → number).
    -- Same per-widget shape as widget_ranges; numeric because the loader only
    -- ever reads it through Number().
    CREATE TABLE IF NOT EXISTS work.widget_hist_per (
      user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      widget_id text NOT NULL,
      per       numeric,
      ord       integer NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, widget_id)
    );
    -- CREATE TABLE IF NOT EXISTS is a NO-OP on a table that already exists, so
    -- a column added to an existing schema needs its own idempotent ALTER or it
    -- silently never appears and every save fails on checkInsertTargets.
    ALTER TABLE work.settings
      ADD COLUMN IF NOT EXISTS job_type text NOT NULL DEFAULT 'shift';
  `,

  // No FKs between these tables; settings first for readability.
  tables: ['settings', 'shifts', 'upcoming', 'widget_ranges', 'widget_hist_per'],

  decompose(state) {
    const wage = Number(state.wage) // loader keeps numeric strings; the column coerces anyway
    const shifts = (Array.isArray(state.shifts) ? state.shifts : []).filter(isObj)
    const upcoming = (Array.isArray(state.upcoming) ? state.upcoming : []).filter(isObj)
    const ranges = isObj(state.ranges) && !Array.isArray(state.ranges) ? state.ranges : {}
    const histPer = isObj(state.histPer) && !Array.isArray(state.histPer) ? state.histPer : {}
    return {
      settings: [{
        wage: Number.isFinite(wage) ? wage : 0,
        tips: !!state.tips,
        open_ended: !!state.openEnded,
        address: typeof state.address === 'string' ? state.address : '',
        cal_id: typeof state.calId === 'string' ? state.calId : '',
        // loader's own gate: anything but 'salary' normalizes to 'shift'
        job_type: state.jobType === 'salary' ? 'salary' : 'shift',
      }],
      shifts: shifts.map(sh => ({
        id: opt(sh.id),
        date: opt(sh.date),
        start_time: sh.start ?? '',   // '' when logged as a duration (or key absent)
        end_time: sh.end ?? '',       // '' while an open shift is on the clock (or key absent)
        // shiftHours' own gate: anything it wouldn't read as a number stores as null
        hours: Number.isFinite(Number(sh.hours)) && sh.hours !== null && sh.hours !== '' ? Number(sh.hours) : null,
        tips: Number(sh.tips) || 0,   // shiftEarned's read
        wage: Number(sh.wage) || 0,   // snapshot at entry — never the current wage
      })),
      upcoming: upcoming.map(sh => ({
        id: opt(sh.id),
        date: opt(sh.date),
        start_time: opt(sh.start),
        end_time: opt(sh.end),
        end_mode: opt(sh.endMode),
        gcal_id: opt(sh.gcalId),
      })),
      widget_hist_per: Object.entries(histPer).map(([widget_id, per]) => ({
        widget_id,
        per: Number.isFinite(Number(per)) ? Number(per) : null,
      })),
      widget_ranges: Object.entries(ranges).map(([widget_id, period]) => ({
        widget_id,
        period: opt(period),
      })),
    }
  },

  recompose(rows) {
    const st = rows.settings[0]
    return {
      wage: st.wage,
      tips: st.tips,
      openEnded: st.open_ended,
      jobType: st.job_type,
      shifts: rows.shifts.map(r => {
        const sh = {}
        put(sh, 'id', r.id)
        put(sh, 'date', r.date)
        sh.start = r.start_time
        sh.end = r.end_time
        sh.hours = r.hours
        sh.tips = r.tips
        sh.wage = r.wage
        return sh
      }),
      ranges: Object.fromEntries(rows.widget_ranges.map(r => [r.widget_id, r.period])),
      histPer: Object.fromEntries(rows.widget_hist_per.map(r => [r.widget_id, r.per])),
      upcoming: rows.upcoming.map(r => {
        const sh = {}
        put(sh, 'id', r.id)
        put(sh, 'date', r.date)
        put(sh, 'start', r.start_time)
        put(sh, 'end', r.end_time)
        put(sh, 'endMode', r.end_mode)
        put(sh, 'gcalId', r.gcal_id)
        return sh
      }),
      address: st.address,
      calId: st.cal_id,
    }
  },
}

export default mapper
if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
