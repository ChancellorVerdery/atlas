// Recurrence-rule self-check for the Calendar plugin (node tests/calendar.check.mjs).
// Pure helpers only — nothing here calls the Google API.
import assert from 'node:assert/strict'
import { rruleSetUntil, buildRRule, describeRRule } from '../src/page/calendar.js'

// all-day: UNTIL is a bare date
assert.equal(
  rruleSetUntil('RRULE:FREQ=DAILY', new Date(2026, 8, 14), true),
  'RRULE:FREQ=DAILY;UNTIL=20260914')

// timed: UNTIL is end-of-day local, UTC-encoded (matches buildRRule's convention)
const timed = rruleSetUntil('RRULE:FREQ=WEEKLY;BYDAY=MO,WE', new Date(2026, 8, 14), false)
assert.match(timed, /^RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=202609\d{2}T\d{6}Z$/)

// an existing UNTIL is replaced, not doubled
assert.equal(
  rruleSetUntil('RRULE:FREQ=DAILY;UNTIL=20261225', new Date(2026, 8, 14), true),
  'RRULE:FREQ=DAILY;UNTIL=20260914')

// COUNT is stripped — Google rejects a rule carrying both COUNT and UNTIL
assert.equal(
  rruleSetUntil('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=10', new Date(2026, 8, 14), true),
  'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20260914')

// buildRRule regression: still produces the same rules through the shared helper
assert.equal(buildRRule({ freq: 'daily', start: new Date(2026, 8, 1) }), 'RRULE:FREQ=DAILY')
assert.equal(
  buildRRule({ freq: 'weekly', byDays: ['TU'], start: new Date(2026, 8, 1), untilDate: new Date(2026, 11, 1), allDay: true }),
  'RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261201')
assert.equal(describeRRule('RRULE:FREQ=DAILY;UNTIL=20260914'), 'Daily until 2026-09-14')

console.log('calendar.check: all assertions passed')
