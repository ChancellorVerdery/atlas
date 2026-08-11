import assert from 'node:assert'
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
const { rruleByDays, rruleSetByDay, firstWeekdayOnOrAfter, RRULE_DAYS } = await import('../src/page/calendar.js')

// parse BYDAY
assert.deepEqual(rruleByDays('RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'), ['MO', 'WE', 'FR'])
assert.deepEqual(rruleByDays('RRULE:FREQ=DAILY'), [])

// fork WE out of MO,WE,FR — new series is just WE, master keeps MO,FR; other params preserved
const master = 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20260701T235959Z'
assert.equal(rruleSetByDay(master, ['WE']), 'RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20260701T235959Z')
assert.equal(rruleSetByDay(master, rruleByDays(master).filter((d) => d !== 'WE')),
  'RRULE:FREQ=WEEKLY;BYDAY=MO,FR;UNTIL=20260701T235959Z')

// preserves INTERVAL and appends BYDAY when absent
assert.equal(rruleSetByDay('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH', ['TU']), 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU')
assert.equal(rruleSetByDay('RRULE:FREQ=WEEKLY', ['WE']), 'RRULE:FREQ=WEEKLY;BYDAY=WE')

// first Wednesday on/after a Monday start, and when the start already IS the weekday
const mon = new Date(2026, 0, 5)  // Mon Jan 5 2026
const firstWed = firstWeekdayOnOrAfter(mon, 'WE')
assert.equal(firstWed.getDay(), 3)
assert.equal(firstWed.getDate(), 7)  // Wed Jan 7
const wed = new Date(2026, 0, 7)
assert.equal(firstWeekdayOnOrAfter(wed, 'WE').getDate(), 7)  // same day, not +7
// wrap-around: first Monday on/after a Friday
const fri = new Date(2026, 0, 9)
assert.equal(firstWeekdayOnOrAfter(fri, 'MO').getDate(), 12)  // Mon Jan 12

console.log('OK cal-fork')
