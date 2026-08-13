// Gap-travel heuristic self-check (node, no framework, no DOM): the pure
// decision function powering the Ladder's between-events drive pass —
// chooseGapTravel picks WAIT (stay at the previous location, one direct
// drive right before the next event), a there-and-back trip to `base`
// ('home' or 'office'), or STRAIGHT through when there's no slack at all.
// The shift-vs-salary / Work-not-configured routing itself lives in
// buildPlan (ladder.js) — this only proves the piece it delegates to:
// base=null must never resolve to 'home'/'office', however generous the
// other inputs are.
// Run from atlas-ui/: node tests/ladder-gap.check.mjs
import assert from 'node:assert/strict'
import { chooseGapTravel } from '../src/page/ladder.js'

const defaults = { dwellFloorMin: 45, roundTripFrac: 0.5 }

// 1. Short gap — a 20-minute errand between two events 30 minutes apart, only
// a 10-minute direct drive. There's slack (idle > 0) but nowhere near enough
// for a 45-min dwell floor once a round trip is subtracted, so it waits.
assert.equal(
  chooseGapTravel({ ...defaults, gapMinutes: 30, driveDirectMin: 10, driveToBaseMin: 12, driveBaseToNextMin: 12, base: 'home' }),
  'wait',
  'short gap with no room for a real dwell falls back to wait',
)

// 2. Long gap, cheap round trip, ample dwell — a 4-hour gap, only 10 minutes
// each way to base. Round trip (20) is well under half the gap (120), and
// dwell (240 - 20 = 220) clears the 45-min floor: worth the trip.
assert.equal(
  chooseGapTravel({ ...defaults, gapMinutes: 240, driveDirectMin: 15, driveToBaseMin: 10, driveBaseToNextMin: 10, base: 'home' }),
  'home',
  'long gap + cheap round trip + ample dwell routes home',
)
assert.equal(
  chooseGapTravel({ ...defaults, gapMinutes: 240, driveDirectMin: 15, driveToBaseMin: 10, driveBaseToNextMin: 10, base: 'office' }),
  'office',
  'same shape, base=office, echoes back office — the caller picks which base to test',
)

// 3. Shift job (or any case where the caller decides no base should be
// offered — mid-shift, Work unconfigured, etc): the caller passes base=null.
// However generous the round-trip numbers, chooseGapTravel must never invent
// a base it wasn't given — it can only ever land on wait/straight.
assert.equal(
  chooseGapTravel({ ...defaults, gapMinutes: 240, driveDirectMin: 15, driveToBaseMin: 1, driveBaseToNextMin: 1, base: null }),
  'wait',
  'base=null (mid-shift / no base available) never returns home or office',
)

// 4. Round trip exceeds the fraction cap — dwell alone would clear the floor,
// but the round trip (140) is more than half of the 200-minute gap.
assert.equal(
  chooseGapTravel({ ...defaults, gapMinutes: 200, driveDirectMin: 20, driveToBaseMin: 70, driveBaseToNextMin: 70, base: 'home' }),
  'wait',
  'round trip over the fraction cap falls back to wait even with dwell to spare',
)

// 5. Straight through — the gap barely covers the direct drive (no slack to
// plan around at all, waiting wouldn't mean anything).
assert.equal(
  chooseGapTravel({ ...defaults, gapMinutes: 12, driveDirectMin: 12, driveToBaseMin: 5, driveBaseToNextMin: 5, base: 'home' }),
  'straight',
  'gap no longer than the direct drive itself goes straight through',
)
assert.equal(
  chooseGapTravel({ ...defaults, gapMinutes: 8, driveDirectMin: 12, driveToBaseMin: 5, driveBaseToNextMin: 5, base: 'home' }),
  'straight',
  'gap shorter than the direct drive (running late) still goes straight through',
)

// 6. Boundary: dwell exactly at the floor qualifies (>=), one minute under
// does not. gapMinutes=115, round trip=20 → dwell=95 vs a 95-min floor.
assert.equal(
  chooseGapTravel({ gapMinutes: 115, driveDirectMin: 10, driveToBaseMin: 10, driveBaseToNextMin: 10, dwellFloorMin: 95, roundTripFrac: 0.5, base: 'home' }),
  'home',
  'dwell exactly at the floor qualifies',
)
assert.equal(
  chooseGapTravel({ gapMinutes: 114, driveDirectMin: 10, driveToBaseMin: 10, driveBaseToNextMin: 10, dwellFloorMin: 95, roundTripFrac: 0.5, base: 'home' }),
  'wait',
  'one minute under the dwell floor misses it',
)

// 7. Boundary: round trip exactly at the fraction cap qualifies (<=), one
// minute over does not. gapMinutes=100, cap 0.5 → round trip must be <= 50.
assert.equal(
  chooseGapTravel({ gapMinutes: 100, driveDirectMin: 5, driveToBaseMin: 25, driveBaseToNextMin: 25, dwellFloorMin: 45, roundTripFrac: 0.5, base: 'home' }),
  'home',
  'round trip exactly at the fraction cap qualifies (dwell 50 >= floor 45)',
)
assert.equal(
  chooseGapTravel({ gapMinutes: 100, driveDirectMin: 5, driveToBaseMin: 26, driveBaseToNextMin: 25, dwellFloorMin: 45, roundTripFrac: 0.5, base: 'home' }),
  'wait',
  'one minute over the fraction cap misses it',
)

// 8. No known direct route at all — nothing to plan a gap around.
assert.equal(
  chooseGapTravel({ ...defaults, gapMinutes: 240, driveDirectMin: null, driveToBaseMin: 10, driveBaseToNextMin: 10, base: 'home' }),
  'wait',
  'no direct route known falls back to wait, not a fabricated trip',
)

console.log('ladder-gap.check: all good')
