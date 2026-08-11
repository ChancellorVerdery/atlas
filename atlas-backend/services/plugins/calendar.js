// Calendar plugin service — mirrors atlas.calendar.v1.
//
// The blob holds UI prefs only (no event data — events live in Google):
//   { hiddenCals: string[], view: 'month'|'week'|'day', navHidden?: bool }
// loadCal() guarantees hiddenCals is an array and view is one of the three
// values, but it NEVER adds navHidden — that key only appears after the user
// clicks toggle-nav (and is a plain boolean from then on, true or false).
// So nav_hidden must be nullable: NULL = key absent from the blob.
//
// Leniency notes — raw blobs reach the mapper without going through the
// loader (first-login importAll, backup restore, verbatim re-pushes), and a
// save must never fail on a state the loader tolerates:
// - hiddenCals: loadCal only checks Array.isArray, so duplicates and
//   non-string entries are loader-valid (the UI tolerates duplicates fine —
//   visibility uses .includes(), un-hiding .filter()s all copies). decompose
//   dedupes (first occurrence wins, order preserved) and skips non-strings so
//   the (user_id, cal_id) PRIMARY KEY holds; recompose therefore returns the
//   cleaned list — behavior-identical for the UI.
// - view: normalized to 'month' exactly like loadCal, so a raw blob with a
//   foreign view value can't violate the CHECK.
// - navHidden: the app only ever writes booleans (toggle-nav), and the UI
//   reads it truthily, so decompose booleanizes any present value.

import { runPlugin } from '../../lib/runner.js'

const ddl = `
CREATE SCHEMA IF NOT EXISTS calendar;

CREATE TABLE IF NOT EXISTS calendar.prefs (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  view       text NOT NULL DEFAULT 'month' CHECK (view IN ('month','week','day')),
  nav_hidden boolean,                     -- NULL = navHidden key absent (never toggled)
  ord        integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS calendar.hidden_cals (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cal_id  text NOT NULL,                  -- Google calendar id
  ord     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, cal_id)           -- safe: decompose dedupes + skips non-strings
);
`

const mapper = {
  name: 'calendar',
  schema: 'calendar',
  storageKey: 'atlas.calendar.v1',
  ddl,
  tables: ['prefs', 'hidden_cals'],

  decompose(state) {
    const hidden = Array.isArray(state.hiddenCals) ? state.hiddenCals : []
    return {
      prefs: [{
        view: ['month', 'week', 'day'].includes(state.view) ? state.view : 'month', // loadCal's rule
        nav_hidden: state.navHidden === undefined ? null : !!state.navHidden,
      }],
      // Dedupe (first wins, order preserved) and skip non-strings: duplicates
      // and dud entries are loader-valid but would violate the PK / NOT NULL.
      hidden_cals: [...new Set(hidden.filter(id => typeof id === 'string'))]
        .map(id => ({ cal_id: id })),
    }
  },

  recompose(rows) {
    const p = (rows.prefs || [])[0] || { view: 'month', nav_hidden: null }
    const s = {
      hiddenCals: (rows.hidden_cals || []).map(r => r.cal_id),
      view: p.view,
    }
    if (p.nav_hidden !== null) s.navHidden = p.nav_hidden
    return s
  },
}

export default mapper
if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
