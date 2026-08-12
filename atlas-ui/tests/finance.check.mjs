// Subscription cadence + large-transaction threshold. Both are pure functions
// over an explicit state object, so this runs in plain node.
// Run: node tests/finance.check.mjs
import assert from 'node:assert/strict'
import {
  detectSubscriptions, largeTransactions, largeThresholdOf, DEFAULT_LARGE_THRESHOLD, LARGE_WINDOW_DAYS,
} from '../src/page/finance.js'

let seq = 0
// distinct accounts + all-positive amounts keep transfer pairing out of the way
const txn = (name, date, amount) => ({
  transaction_id: `t${seq++}`, account_id: `acct-${name}`, date, amount,
  name, merchant_name: name, personal_finance_category: { primary: 'GENERAL_MERCHANDISE' },
})
const state = (transactions, extra = {}) => ({
  transactions, overrides: {}, vendorRules: {}, customCategories: {},
  dismissedAnomalies: [], dismissedSubscriptions: [], ...extra,
})
const keys = (s) => detectSubscriptions(s).map((x) => x.key)

// ---- monthly: same date each month, ±1 day ---------------------------------

const exact = state([
  txn('netflix', '2026-03-15', 15.99), txn('netflix', '2026-04-15', 15.99), txn('netflix', '2026-05-15', 15.99),
])
assert.deepEqual(keys(exact), ['netflix'], 'same date every month is a subscription')
assert.equal(detectSubscriptions(exact)[0].cadence, 'monthly')
assert.equal(detectSubscriptions(exact)[0].nextDate, '2026-06-15', 'next charge is the following month, same day')

// ±1 day is allowed (weekend/holiday settlement drift)
assert.deepEqual(keys(state([
  txn('spotify', '2026-03-10', 11.99), txn('spotify', '2026-04-11', 11.99), txn('spotify', '2026-05-09', 11.99),
])), ['spotify'], 'one day either side still counts')

// ±2 days does not
assert.deepEqual(keys(state([
  txn('gym', '2026-03-10', 40), txn('gym', '2026-04-12', 40), txn('gym', '2026-05-10', 40),
])), [], 'two days off is not a fixed billing date')

// the old rule accepted any 20-40 day average gap — the exact false positive
// this change exists to kill
assert.deepEqual(keys(state([
  txn('corner diner', '2026-03-03', 24), txn('corner diner', '2026-04-01', 24), txn('corner diner', '2026-05-06', 24),
])), [], 'a place you happen to visit about monthly is not a subscription')

// a month-end anchor bills on the last day of a short month, which is not a miss
assert.deepEqual(keys(state([
  txn('icloud', '2026-01-31', 2.99), txn('icloud', '2026-02-28', 2.99), txn('icloud', '2026-03-31', 2.99),
])), ['icloud'], 'the 31st clamps to the last day in February')

// same day-of-month but a year apart is not monthly
assert.deepEqual(keys(state([
  txn('annual', '2025-05-15', 99), txn('annual', '2026-05-15', 99),
])), [], 'twelve months apart is not a monthly cadence')

// ---- weekly: same weekday, seven days apart --------------------------------

// 2026-03-02, -09, -16 are all Mondays
const weekly = state([
  txn('laundry', '2026-03-02', 12), txn('laundry', '2026-03-09', 12), txn('laundry', '2026-03-16', 12),
])
assert.deepEqual(keys(weekly), ['laundry'], 'same weekday every week is a subscription')
assert.equal(detectSubscriptions(weekly)[0].cadence, 'weekly')
assert.equal(detectSubscriptions(weekly)[0].nextDate, '2026-03-23', 'next charge is seven days on')

// a skipped week breaks "every week"
assert.deepEqual(keys(state([
  txn('biweekly', '2026-03-02', 12), txn('biweekly', '2026-03-16', 12), txn('biweekly', '2026-03-30', 12),
])), [], 'fortnightly is not weekly, even on the same weekday')

// ---- amount similarity still gates -----------------------------------------

assert.deepEqual(keys(state([
  txn('varies', '2026-03-15', 10), txn('varies', '2026-04-15', 95), txn('varies', '2026-05-15', 40),
])), [], 'a fixed date with wildly different amounts is not a subscription')

// ---- dismissal -------------------------------------------------------------

assert.deepEqual(keys(state([
  txn('netflix', '2026-03-15', 15.99), txn('netflix', '2026-04-15', 15.99),
], { dismissedSubscriptions: ['netflix'] })), [], 'a dismissed merchant stays dismissed')

// ---- large transactions ----------------------------------------------------

const iso = (d) => d.toISOString().slice(0, 10)
const NOW = new Date('2026-05-20T12:00:00')
const ago = (days) => iso(new Date(NOW - days * 86400000))

const big = state([
  txn('tuition', ago(2), 900),
  txn('tires', ago(5), 420),
  txn('coffee', ago(1), 6),
  txn('rent', ago(120), 1400), // outside the window
])
assert.equal(largeThresholdOf(big), DEFAULT_LARGE_THRESHOLD, 'falls back to the default when unset')
assert.deepEqual(largeTransactions(big, NOW).map((t) => t.name), ['tuition', 'tires'],
  'only charges at or above the threshold, within the window, biggest first')

// the threshold is what actually drives it
assert.deepEqual(largeTransactions({ ...big, largeThreshold: 500 }, NOW).map((t) => t.name), ['tuition'])
assert.deepEqual(largeTransactions({ ...big, largeThreshold: 5 }, NOW).map((t) => t.name),
  ['tuition', 'tires', 'coffee'])

// boundary: "at or above", not "above"
const edge = state([txn('exact', ago(1), 200)])
assert.deepEqual(largeTransactions(edge, NOW).map((t) => t.name), ['exact'], 'a charge exactly at the threshold counts')

// the window edge
assert.equal(largeTransactions(state([txn('old', ago(LARGE_WINDOW_DAYS + 2), 900)]), NOW).length, 0)

// dismissal hides it
const dis = state([txn('hidden', ago(1), 900)])
dis.dismissedAnomalies = [dis.transactions[0].transaction_id]
assert.deepEqual(largeTransactions(dis, NOW), [], 'a dismissed transaction stops being flagged')

// a bad threshold falls back rather than flagging everything
assert.equal(largeThresholdOf({ largeThreshold: 0 }), DEFAULT_LARGE_THRESHOLD)
assert.equal(largeThresholdOf({ largeThreshold: -5 }), DEFAULT_LARGE_THRESHOLD)
assert.equal(largeThresholdOf({ largeThreshold: 'abc' }), DEFAULT_LARGE_THRESHOLD)

console.log('finance.check: all assertions passed')
