// Sleep plugin service — mirrors atlas.sleep.v1 (src/page/sleep.js).
//
// Blob shape (loadSleep()):
//   { prefMin, bedtime, windowDays, ratio, napCredit, recoverNights,
//     logs: [{ id, type: 'night'|'nap', date, start?, end?, minutes, quality? }] }
//
// Fidelity notes (derived from the actual loader/mutators, not the spec):
// - decompose() applies loadSleep()'s normalization rules EXACTLY, because
//   raw blobs reach the mapper without going through the loader (first-login
//   importAll, backup restore, verbatim re-pushes). A save must never fail
//   on a state the loader tolerates; recompose therefore returns the
//   loader-normalized shape — the same one the app sees after its next load.
// - Settings: loader backfills defaults; decompose does the same.
//   window_days / recover_nights are numeric, not integer: the loader only
//   requires Number.isInteger, which admits values beyond int4 range.
// - prefMin / ratio / napCredit: loader only requires finite numbers
//   (prefMin > 0, ratio >= 1, 0 <= napCredit <= 100) — the settings UI accepts
//   non-integers for all three, so numeric.
// - bedtime: loader accepts anything hmToMin parses, including '9:30'
//   (unpadded hour) — free text, no format CHECK, kept verbatim.
// - logs: the loader filter is ONLY id + truthy date + finite minutes > 0.
//   type, start, end, quality are NOT validated, so present-but-nonconforming
//   values must round-trip without failing the save:
//     - type: text with NO CHECK — 'NAP' / 'other' are loader-valid
//       (creditedFor/nightMinutesFor treat any non-'nap' as night).
//     - quality: jsonb — the loader never checks it, so 0, 7, 2.5 or even a
//       string are loader-valid (an integer + CHECK 1..5 would 500 the save).
//     - date: text, NOT `date` — the loader does not guarantee ISO
//       ('07/01/2026' is loader-valid), and a date column would reject it or
//       silently canonicalize '2026-7-1' to '2026-07-01' on round-trip.
//   NULL = key absent for the optional four (the app never stores null).
// - Duplicate log ids are loader-valid (the filter never dedupes; the UI
//   tolerates them — removeLog filters all copies, creditedFor sums both),
//   so id is NOT a primary key: plain non-unique index, row identity comes
//   from the runner's ord. Deduping would change the app's debt math.
// - minutes: addLog always produces integers, but the loader accepts any
//   finite number > 0 (imported data) — numeric, not integer.
// - date: LOCAL 'YYYY-MM-DD' (dateKey / <input type=date>) in app-written
//   logs — nights dated by the wake-up morning. Multiple logs per date are
//   legal (they sum), so the date index is NOT unique.

import { runPlugin } from '../../lib/runner.js'

const ddl = `
CREATE TABLE IF NOT EXISTS sleep_settings (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  pref_min       numeric NOT NULL DEFAULT 480 CHECK (pref_min > 0),
  bedtime        text NOT NULL DEFAULT '23:00',      -- 'HH:MM' (loader also allows 'H:MM')
  window_days    numeric NOT NULL DEFAULT 7 CHECK (window_days >= 1),
  ratio          numeric NOT NULL DEFAULT 1.2 CHECK (ratio >= 1),
  nap_credit     numeric NOT NULL DEFAULT 50 CHECK (nap_credit BETWEEN 0 AND 100),
  recover_nights numeric NOT NULL DEFAULT 3 CHECK (recover_nights >= 1),
  ord            integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sleep_logs (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id         text NOT NULL,      -- 'sl-...'; duplicates are loader-valid, so NOT unique
  type       text,               -- NULL = key absent; NO CHECK (loader never validates it)
  date       text NOT NULL,      -- verbatim; loader only requires truthy, not ISO
  minutes    numeric NOT NULL CHECK (minutes > 0),
  start_time text,               -- night only; NULL = key absent
  end_time   text,               -- night only; NULL = key absent
  quality    jsonb,              -- NULL = key absent (unrated); loader never validates the value
  ord        integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sleep_logs_id   ON sleep_logs (user_id, id);
CREATE INDEX IF NOT EXISTS sleep_logs_date ON sleep_logs (user_id, date);
`

// undefined (key absent) → SQL NULL; everything else passes through.
const opt = v => (v === undefined ? null : v)
const isObj = o => o !== null && typeof o === 'object'
// Replica of loadSleep's bedtime gate: hmToMin(s.bedtime) != null.
const hmOk = t => /^(\d{1,2}):(\d{2})$/.test(String(t || '').trim())

const mapper = {
  name: 'sleep',
  storageKey: 'atlas.sleep.v1',
  ddl,
  tables: ['sleep_settings', 'sleep_logs'],

  // Mirrors loadSleep() line for line so a save never fails on a state the
  // loader tolerates (raw imports bypass the loader entirely).
  decompose(s) {
    const logs = (Array.isArray(s.logs) ? s.logs : [])
      .filter(l => isObj(l) && l.id && l.date && Number.isFinite(l.minutes) && l.minutes > 0)
    return {
      sleep_settings: [{
        pref_min: Number.isFinite(s.prefMin) && s.prefMin > 0 ? s.prefMin : 480,
        bedtime: hmOk(s.bedtime) ? s.bedtime : '23:00',
        window_days: Number.isInteger(s.windowDays) && s.windowDays >= 1 ? s.windowDays : 7,
        ratio: Number.isFinite(s.ratio) && s.ratio >= 1 ? s.ratio : 1.2,
        nap_credit: Number.isFinite(s.napCredit) && s.napCredit >= 0 && s.napCredit <= 100 ? s.napCredit : 50,
        recover_nights: Number.isInteger(s.recoverNights) && s.recoverNights >= 1 ? s.recoverNights : 3,
      }],
      sleep_logs: logs.map(l => ({
        id: l.id,
        type: opt(l.type),
        date: l.date,
        minutes: l.minutes,
        start_time: opt(l.start),
        end_time: opt(l.end),
        quality: l.quality == null ? null : JSON.stringify(l.quality), // jsonb, any value verbatim
      })),
    }
  },

  recompose(rows) {
    const st = rows.sleep_settings[0]
    return {
      prefMin: st.pref_min,          // numeric parser returns a Number
      bedtime: st.bedtime,
      windowDays: st.window_days,
      ratio: st.ratio,
      napCredit: st.nap_credit,
      recoverNights: st.recover_nights,
      logs: rows.sleep_logs.map(r => {
        const l = { id: r.id }
        if (r.type !== null) l.type = r.type
        l.date = r.date                // text column — stored verbatim
        if (r.start_time !== null) l.start = r.start_time
        if (r.end_time !== null) l.end = r.end_time
        l.minutes = r.minutes
        if (r.quality !== null) l.quality = r.quality // jsonb: pg returns it parsed
        return l
      }),
    }
  },
}

export default mapper
if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
