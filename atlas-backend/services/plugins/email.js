// Email plugin service — mirrors atlas.email.v1, which now holds ONLY Atlas-side
// UI state. Google credentials (client id/secret, tokens, connected address)
// moved to the dedicated google service (google_tokens) and are never synced,
// so this mapper deliberately drops them: an older blob that still carries
// clientId/clientSecret/token/address is accepted, but those keys are not
// persisted and do not come back (they live server-side now).
//
// loadEmail() (atlas-ui/src/page/email.js) guarantees only two keys:
//   pinned:   string[] of Gmail thread ids, index 0 = most recently pinned
//   splitPct: number (default 42; parseFloat of a flex-basis, may be fractional)
// ...but only in MEMORY: an older-version blob may lack either (loadEmail never
// writes its defaults back), so decompose() re-applies them.
//   navHidden — boolean, key only exists once the nav has been toggled

import { runPlugin } from '../../lib/runner.js'

const ddl = `
CREATE TABLE IF NOT EXISTS email_prefs (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  split_pct  double precision NOT NULL,  -- loader always supplies it (default 42)
  nav_hidden boolean,                    -- NULL = navHidden key absent (never toggled)
  ord        integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS email_pins (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  thread_id text NOT NULL,               -- Gmail thread id; may dangle (tolerated)
  ord       integer NOT NULL DEFAULT 0,  -- 0 = most recently pinned (unshift order)
  PRIMARY KEY (user_id, thread_id)
);
`

const mapper = {
  name: 'email',
  storageKey: 'atlas.email.v1',
  ddl,
  tables: ['email_prefs', 'email_pins'],

  decompose(state) {
    const pinned = Array.isArray(state.pinned) ? state.pinned : []
    const splitPct = typeof state.splitPct === 'number' ? state.splitPct : 42
    // Duplicate pin ids are loader-tolerated; dedupe (first wins) or the
    // (user_id, thread_id) PK aborts the save.
    const pins = []
    const seen = new Set()
    for (const id of pinned) {
      if (seen.has(id)) continue
      seen.add(id)
      pins.push({ thread_id: id })
    }
    return {
      email_prefs: [{ split_pct: splitPct, nav_hidden: state.navHidden === undefined ? null : state.navHidden }],
      email_pins: pins,
    }
  },

  recompose(rows) {
    const s = {}
    const p = (rows.email_prefs || [])[0]
    s.pinned = (rows.email_pins || []).map((r) => r.thread_id)
    s.splitPct = p ? p.split_pct : 42
    if (p && p.nav_hidden !== null) s.navHidden = p.nav_hidden
    return s
  },
}

export default mapper
if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
