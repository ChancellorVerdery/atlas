// Bulk labelling across mailboxes: a selection can span accounts, and a Gmail
// label id only means something inside the mailbox that owns it — so the label
// is resolved per account, BY NAME, and created where it's missing.
// Run: node tests/email-select.check.mjs
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
}
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto

const { selNames, labelPlan } = await import('../src/page/emailui.js')

const A = 'a@x.com', B = 'b@y.com'
const labels = {
  [A]: [{ id: 'Label_1', name: 'Receipts' }, { id: 'Label_2', name: 'School' }],
  [B]: [{ id: 'Label_9', name: 'School' }, { id: 'Label_7', name: 'Only B' }],
}
const sel = (...pairs) => new Map(pairs)

// --- the menu offers the labels of the accounts actually selected -----------
assert.deepEqual(selNames(sel(['t1', A]), labels), ['Receipts', 'School'])
assert.deepEqual(selNames(sel(['t1', B]), labels), ['Only B', 'School'])
// union across a mixed selection, deduped by name and sorted
assert.deepEqual(selNames(sel(['t1', A], ['t2', B]), labels), ['Only B', 'Receipts', 'School'])
assert.deepEqual(selNames(sel(), labels), [])
assert.deepEqual(selNames(sel(['t1', 'c@z.com']), labels), []) // labels not loaded yet

// --- one name resolves to a DIFFERENT id in each mailbox -------------------
const both = labelPlan(sel(['t1', A], ['t2', B]), labels, 'School')
assert.equal(both.found.get(A), 'Label_2')
assert.equal(both.found.get(B), 'Label_9') // not Label_2 — ids don't cross mailboxes
assert.deepEqual(both.missing, [])

// --- an account lacking the label is reported for creation, not skipped ----
const half = labelPlan(sel(['t1', A], ['t2', B]), labels, 'Receipts')
assert.deepEqual([...half.found], [[A, 'Label_1']])
assert.deepEqual(half.missing, [B]) // B has no "Receipts" yet

// two threads in the same mailbox produce ONE plan entry, not two creates
const dupe = labelPlan(sel(['t1', B], ['t2', B], ['t3', B]), labels, 'Receipts')
assert.deepEqual(dupe.missing, [B])
assert.equal(dupe.found.size, 0)

// --- name matching is case- and whitespace-insensitive, like Gmail's --------
assert.equal(labelPlan(sel(['t1', A]), labels, '  rEcEiPtS ').found.get(A), 'Label_1')

// --- a brand-new name is missing everywhere --------------------------------
const fresh = labelPlan(sel(['t1', A], ['t2', B]), labels, 'Formal')
assert.equal(fresh.found.size, 0)
assert.deepEqual(fresh.missing.sort(), [A, B])

// --- single-account view: rows carry '' and still resolve ------------------
assert.deepEqual(labelPlan(sel(['t1', '']), { '': labels[A] }, 'School').found.get(''), 'Label_2')

console.log('email-select.check: all assertions passed')
