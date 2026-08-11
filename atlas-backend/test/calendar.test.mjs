// Round-trip tests for the calendar mapper: recompose(pg(decompose(S))) === S.
import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/calendar.js'

// No jsonb columns in this plugin, so pg hands rows back structurally
// unchanged; still deep-clone to prove recompose doesn't rely on the exact
// objects decompose produced.
const JSONB = { prefs: [], hidden_cals: [] }
function simulatePg(byTable) {
  const out = {}
  for (const [table, rows] of Object.entries(byTable)) {
    out[table] = rows.map(row => {
      const r = structuredClone(row)
      for (const col of JSONB[table]) r[col] = JSON.parse(r[col])
      return r
    })
  }
  return out
}

const roundTrip = S => deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(S))), S)

// 1. Exact default state loadCal() produces from empty storage:
//    JSON.parse(null) -> null -> {} -> hiddenCals normalized to [], view to
//    'month'; navHidden NOT added.
roundTrip({ hiddenCals: [], view: 'month' })

// 2. Rich state: every field, edge cases — empty-string cal id, unicode ids,
//    explicit navHidden:false (toggled twice; distinct from absent).
roundTrip({
  hiddenCals: [
    '',
    'family06@group.v.calendar.google.com',
    'ünïcode-📅@example.com',
    'en.usa#holiday@group.v.calendar.google.com',
  ],
  view: 'week',
  navHidden: false,
})

// 2b. navHidden true, day view.
roundTrip({ hiddenCals: ['primary'], view: 'day', navHidden: true })

// 3. Real usage: several hidden calendars, order matters (append order from
//    successive un-checks in the sidebar), navHidden absent.
roundTrip({
  hiddenCals: [
    'alex.morgan@example.com',
    'addressbook#contacts@group.v.calendar.google.com',
    'c_188b1a2d4bee@resource.calendar.google.com',
  ],
  view: 'month',
})

// Absent navHidden must stay absent (not become null/false).
{
  const back = mapper.recompose(simulatePg(mapper.decompose({ hiddenCals: [], view: 'month' })))
  deepStrictEqual('navHidden' in back, false)
}

// 4. Regression: duplicate hiddenCals entries are loader-valid (loadCal only
//    checks Array.isArray; the UI tolerates copies — .includes() for
//    visibility, .filter() removes all on un-hide) but would violate the
//    (user_id, cal_id) PRIMARY KEY. decompose dedupes first-wins, order
//    preserved; recompose returns the deduped list (behavior-identical).
deepStrictEqual(
  mapper.recompose(simulatePg(mapper.decompose({
    hiddenCals: [
      'a@group.calendar.google.com',
      'a@group.calendar.google.com',   // double-fired toggle / merged backup
      'b@group.calendar.google.com',
      'a@group.calendar.google.com',
    ],
    view: 'week',
  }))),
  { hiddenCals: ['a@group.calendar.google.com', 'b@group.calendar.google.com'], view: 'week' },
)

// 5. Regression: dud (non-string) hiddenCals entries are loader-valid but
//    would 500 on cal_id NOT NULL / text coercion — decompose skips them.
deepStrictEqual(
  mapper.recompose(simulatePg(mapper.decompose({
    hiddenCals: [null, 'keep@x.com', 42, undefined, { id: 'nope' }, 'keep2@x.com'],
    view: 'day',
  }))),
  { hiddenCals: ['keep@x.com', 'keep2@x.com'], view: 'day' },
)

// 6. Regression: raw blobs bypass loadCal (importAll / backup restore), so
//    decompose applies the loader's own normalization — non-array hiddenCals
//    → [], foreign view → 'month' (would otherwise violate the view CHECK).
deepStrictEqual(
  mapper.recompose(simulatePg(mapper.decompose({ hiddenCals: 'oops', view: 'agenda' }))),
  { hiddenCals: [], view: 'month' },
)
deepStrictEqual(
  mapper.recompose(simulatePg(mapper.decompose({}))),
  { hiddenCals: [], view: 'month' },
)

console.log('OK calendar')
