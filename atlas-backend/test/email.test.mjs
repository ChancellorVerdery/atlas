// Round-trip tests for the email mapper: recompose(pg(decompose(S))) === S.
// The mapper now persists ONLY Atlas-side UI state (pinned, splitPct, navHidden).
// Google credentials moved to the google service; any clientId/clientSecret/
// token/address keys on an incoming blob are accepted but intentionally NOT
// round-tripped (they are not synced anymore).
import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/email.js'

// No jsonb columns; pg hands rows back structurally unchanged. Deep-clone anyway
// to prove recompose doesn't rely on the exact objects decompose produced.
function simulatePg(byTable) {
  const out = {}
  for (const [table, rows] of Object.entries(byTable)) out[table] = rows.map((r) => structuredClone(r))
  return out
}
const back = (S) => mapper.recompose(simulatePg(mapper.decompose(S)))
const roundTrip = (S) => deepStrictEqual(back(S), S)

// 1. Default state loadEmail() produces from empty storage.
roundTrip({ pinned: [], splitPct: 42 })

// 2. UI state with fractional split, navHidden false, unicode/empty pin ids.
roundTrip({
  pinned: ['198ab34cd56ef012', '', 'thrëad-📌-id'],
  splitPct: 37.482915,
  navHidden: false,
})

// 2b. navHidden true, several pins (index 0 = most recent).
roundTrip({
  pinned: ['19a0f1e2d3c4b5a6', '1990aabbccddeeff', '1980112233445566'],
  splitPct: 46.5,
  navHidden: true,
})

// 3. Google credential keys on an incoming blob are dropped (moved server-side):
//    the persisted/round-tripped state keeps only the UI keys.
deepStrictEqual(
  back({
    clientId: '1234567890-abc.apps.googleusercontent.com',
    clientSecret: 'GOCSPX-s3cr3t',
    token: { access_token: 'ya29.x', expires_at: 1783555200000, refresh_token: '1//0r' },
    address: 'alex.morgan@example.com',
    pinned: ['abc'],
    splitPct: 42,
    navHidden: true,
  }),
  { pinned: ['abc'], splitPct: 42, navHidden: true },
  'google credential keys are not persisted by the email mapper',
)

// Absent optional keys stay absent (navHidden not toggled).
{
  const b = back({ pinned: [], splitPct: 42 })
  for (const k of ['clientId', 'clientSecret', 'token', 'address', 'navHidden'])
    deepStrictEqual(k in b, false, `${k} should be absent`)
}

// Older blob lacking pinned/splitPct entirely → loader defaults, no crash.
deepStrictEqual(back({ clientId: 'x' }), { pinned: [], splitPct: 42 })
deepStrictEqual(back({}), { pinned: [], splitPct: 42 })
// Non-number splitPct (corrupt/foreign blob) → loader default 42.
deepStrictEqual(back({ pinned: [], splitPct: '42' }).splitPct, 42)

// Pin order survives; duplicate ids deduped (first wins) so the PK can't abort.
{
  const rows = mapper.decompose({ pinned: ['a', 'b', 'a'], splitPct: 42 })
  deepStrictEqual(rows.email_pins.map((r) => r.thread_id), ['a', 'b'])
  deepStrictEqual(mapper.recompose(simulatePg(rows)).pinned, ['a', 'b'])
}

console.log('OK email')
