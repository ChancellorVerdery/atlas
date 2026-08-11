// Ladder plugin service — mirrors atlas.ladder.v1.
// Truth source: atlas-ui/src/page/ladder.js (loadLadder/saveLadder/addFlex) and
// atlas-ui/src/page/ladderui.js (settings editors, calendar push bookkeeping).
//
// IMPORTANT: the wire carries RAW localStorage — backup imports (renderer.js
// importData, main.js importAll at first login) and the settings oninput paths
// push blobs loadLadder() has never touched (un-rounded drive minutes, decimal
// windowDays, missing keys). decompose therefore runs the loader's EXACT
// normalization first (normalizeLadder below); a save must never fail on a
// state the app's own loader tolerates. recompose consequently returns the
// loader-normalized shape.
//
// Fidelity notes (where this deviates from the spec's sketch DDL):
// - settings.buffer is jsonb: loadLadder tolerates numeric strings ("10" passes
//   `Number.isFinite(Number(s.buffer))` and is kept verbatim), so a numeric
//   column would silently retype it. jsonb round-trips number vs string exactly.
// - settings.window_days stays integer because normalizeLadder applies the
//   loader's own rule (integer 1..31 or reset to 7) BEFORE the insert — a
//   decimal typed into the Planning-window field becomes 7, exactly what the
//   client's next loadLadder would do.
// - settings.cal_ids is jsonb: loadLadder passes ANY object through untouched
//   (missing or extra keys survive), so three fixed columns would invent keys.
// - meals/aliases are ONE jsonb column per row: the loader keeps rows verbatim
//   (meals: isObj only — ids are NOT required; aliases: isObj + id, half-typed
//   rows kept on purpose) and ladderui mints their ids from Date.now() alone,
//   so duplicate ids are real. No PK, no per-field columns: identity is the
//   array position (ord) and every key — including ones this service has never
//   heard of — round-trips exactly.
// - geo_cache.result is jsonb: values are {lat,lon}, null (cached
//   geocode failure — must be kept!), or even {lat:null,lon:null} (NaN coords
//   flattened by JSON). One jsonb column preserves all three distinctly.
// - drive_cache.minutes is jsonb: normalizeLadder re-applies the
//   loader's ceil-to-5 rounding to finite values, but non-finite leftovers
//   (null, foreign junk) are loader-kept and must not fail an integer column.
// - pushed_events is one row per DAY with a jsonb events array: pushing
//   a day with no pushable blocks stores `pushed[day] = []`, which per-event
//   rows would lose; the array also preserves creation order exactly.
// - flex: no CHECK constraints and nullable kind-specific columns —
//   loadLadder only requires {id, title, minutes>0}; which other fields exist
//   depends on the kind, and absent-vs-present matters (e.g. anchorLabel is
//   set — possibly '' — for series:/id: anchors but never for tag: anchors).
//   The app never stores null in a flex field, so SQL NULL ⇔ absent key.
//   minutes and weekday are jsonb: the loader keeps numeric strings ('45')
//   and fractional weekdays (1.5) verbatim, which numeric/integer columns
//   would retype or reject.
// - flex.date / pushed.day are text, not date: the loader never validates
//   them, and a date column would normalize (or reject) odd-but-kept strings.
// - recompose rebuilds geo/drives/pushed with Object.fromEntries so a
//   '__proto__' key (geo keys are lowercased free-text addresses!) stays a
//   plain own property instead of silently mutating the prototype.
// No secrets live in this plugin (calendar ids are not credentials).

import { runPlugin } from '../../lib/runner.js'

const ddl = `
CREATE SCHEMA IF NOT EXISTS ladder;

CREATE TABLE IF NOT EXISTS ladder.settings (
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  home        text NOT NULL DEFAULT '',
  wake        text NOT NULL DEFAULT '07:00',
  window_days integer NOT NULL DEFAULT 7,
  buffer      jsonb NOT NULL DEFAULT '5',
  cal_ids     jsonb NOT NULL DEFAULT '{"gym":"","drives":"","ladder":""}',
  ord         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id)
);

CREATE TABLE IF NOT EXISTS ladder.meals (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  meal    jsonb NOT NULL,   -- the meal object verbatim; ord is the identity
  ord     integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ladder.flex (
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  id            text NOT NULL,
  title         text NOT NULL,
  minutes       jsonb NOT NULL,  -- number OR numeric string, verbatim
  kind          text,
  date          text,
  weekday       jsonb,           -- loader never validates: 1.5 / '3' survive
  start_time    text,
  end_time      text,
  side          text,
  place         text,
  anchor_tag    text,
  anchor_series text,
  anchor_id     text,
  anchor_label  text,
  ord           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS ladder.geo_cache (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  address text NOT NULL,
  result  jsonb NOT NULL,
  ord     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, address)
);

CREATE TABLE IF NOT EXISTS ladder.drive_cache (
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  route_key text NOT NULL,
  minutes   jsonb NOT NULL,  -- multiple of 5, or null (non-finite flattened by JSON)
  ord       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, route_key)
);

CREATE TABLE IF NOT EXISTS ladder.aliases (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  alias   jsonb NOT NULL,   -- the alias object verbatim; ord is the identity
  ord     integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ladder.pushed_events (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day     text NOT NULL,
  events  jsonb NOT NULL,
  ord     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`

// SQL NULL ⇔ key absent from the app object (the app never stores null in
// these optional fields, so the mapping is unambiguous).
const opt = v => (v === undefined ? null : v)
const put = (obj, key, v) => { if (v !== null) obj[key] = v }
const isObj = o => o !== null && typeof o === 'object'
const uid = p => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

// Exact mirror of loadLadder() (atlas-ui/src/page/ladder.js). Builds a fresh
// object (never mutates the wire value); drives are rebuilt with
// Object.fromEntries so a '__proto__' route key stays an own property.
function normalizeLadder(raw) {
  const s = isObj(raw) ? raw : {}
  const drivesIn = isObj(s.drives) ? s.drives : {}
  return {
    home: typeof s.home === 'string' ? s.home : '',
    wake: /^\d{2}:\d{2}$/.test(s.wake || '') ? s.wake : '07:00',
    windowDays:
      Number.isInteger(s.windowDays) && s.windowDays >= 1 && s.windowDays <= 31
        ? s.windowDays
        : 7,
    buffer: Number.isFinite(Number(s.buffer)) && !(s.buffer < 0) ? s.buffer : 5,
    meals: (Array.isArray(s.meals) ? s.meals : [
      { id: uid('lm'), name: 'Breakfast', pref: '08:00', duration: 30, enabled: true },
      { id: uid('lm'), name: 'Lunch', pref: '12:30', duration: 45, enabled: true },
      { id: uid('lm'), name: 'Dinner', pref: '18:30', duration: 45, enabled: true },
    ]).filter(isObj),
    flex: (Array.isArray(s.flex) ? s.flex : [])
      .filter(f => isObj(f) && f.id && f.title && Number(f.minutes) > 0),
    geo: isObj(s.geo) ? s.geo : {},
    // the loader re-rounds finite drive minutes on EVERY load (ceil to 5);
    // non-finite values (cached null) are kept verbatim
    drives: Object.fromEntries(Object.keys(drivesIn).map(k =>
      [k, Number.isFinite(drivesIn[k]) ? Math.ceil(drivesIn[k] / 5) * 5 : drivesIn[k]])),
    aliases: (Array.isArray(s.aliases) ? s.aliases : []).filter(a => isObj(a) && a.id),
    calIds: isObj(s.calIds) ? s.calIds : { gym: '', drives: '', ladder: '' },
    pushed: isObj(s.pushed) ? s.pushed : {},
  }
}

const mapper = {
  name: 'ladder',
  schema: 'ladder',
  storageKey: 'atlas.ladder.v1',
  ddl,
  // No FKs between ladder tables; order is arbitrary but stable.
  tables: [
    'settings',
    'meals',
    'flex',
    'geo_cache',
    'drive_cache',
    'aliases',
    'pushed_events',
  ],

  decompose(raw) {
    const s = normalizeLadder(raw)
    return {
      settings: [{
        home: s.home,
        wake: s.wake,
        window_days: s.windowDays,
        buffer: JSON.stringify(s.buffer),
        cal_ids: JSON.stringify(s.calIds),
      }],
      meals: s.meals.map(m => ({ meal: JSON.stringify(m) })),
      flex: s.flex.map(f => ({
        id: f.id,
        title: f.title,
        minutes: JSON.stringify(f.minutes),
        kind: opt(f.kind),
        date: opt(f.date),
        weekday: f.weekday === undefined ? null : JSON.stringify(f.weekday),
        start_time: opt(f.start),
        end_time: opt(f.end),
        side: opt(f.side),
        place: opt(f.place),
        anchor_tag: opt(f.anchorTag),
        anchor_series: opt(f.anchorSeries),
        anchor_id: opt(f.anchorId),
        anchor_label: opt(f.anchorLabel),
      })),
      geo_cache: Object.keys(s.geo).map(k => ({
        address: k,
        result: JSON.stringify(s.geo[k] ?? null), // {lat,lon} | null | {lat:null,lon:null}
      })),
      drive_cache: Object.keys(s.drives).map(k => ({
        route_key: k, // 'lat,lon>lat,lon' at 4dp
        minutes: JSON.stringify(s.drives[k] ?? null), // multiple of 5, or null
      })),
      aliases: s.aliases.map(a => ({ alias: JSON.stringify(a) })),
      pushed_events: Object.keys(s.pushed).map(k => ({
        day: k, // 'YYYY-MM-DD'
        events: JSON.stringify(s.pushed[k] ?? null), // ordered [{calId, id}], possibly []
      })),
    }
  },

  recompose(rows) {
    const st = rows.settings[0]
    return {
      home: st.home,
      wake: st.wake,
      windowDays: st.window_days,
      buffer: st.buffer, // jsonb: number or numeric string, verbatim
      meals: rows.meals.map(r => r.meal),     // verbatim objects
      flex: rows.flex.map(r => {
        const f = { id: r.id, title: r.title, minutes: r.minutes }
        put(f, 'kind', r.kind)
        put(f, 'date', r.date)
        put(f, 'weekday', r.weekday) // jsonb: fractional / string weekdays verbatim
        put(f, 'start', r.start_time)
        put(f, 'end', r.end_time)
        put(f, 'side', r.side)
        put(f, 'place', r.place)
        put(f, 'anchorTag', r.anchor_tag)
        put(f, 'anchorSeries', r.anchor_series)
        put(f, 'anchorId', r.anchor_id)
        put(f, 'anchorLabel', r.anchor_label)
        return f
      }),
      // fromEntries: a '__proto__' key (free-text addresses!) stays an own
      // property instead of mutating the object's prototype.
      geo: Object.fromEntries(rows.geo_cache.map(r => [r.address, r.result])),
      drives: Object.fromEntries(rows.drive_cache.map(r => [r.route_key, r.minutes])),
      aliases: rows.aliases.map(r => r.alias), // verbatim objects
      calIds: st.cal_ids,
      pushed: Object.fromEntries(rows.pushed_events.map(r => [r.day, r.events])),
    }
  },
}

export default mapper
if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
