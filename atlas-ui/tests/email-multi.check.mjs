// Multi-account email — pure-logic self-check (node tests/email-multi.check.mjs).
// Covers the account-aware pin store, the accounts cache, and active-account
// resolution. No network: sync.js loads but we never call sync.request here.
import assert from 'node:assert/strict'

// minimal localStorage + globals email.js/sync.js touch at import
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
}
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto

const m = await import('../src/page/email.js')
const KEY = 'atlas.email.v1'
const setState = (o) => store.set(KEY, JSON.stringify(o))

// --- accounts cache + active account ---
setState({ connected: true, accounts: ['a@x.com', 'b@y.com'], address: 'a@x.com' })
assert.deepEqual(m.connectedAccounts(), ['a@x.com', 'b@y.com'])
m.setActiveAccount('all')
assert.equal(m.getActiveAccount(), null) // 'all' → no specific account (server primary)
m.setActiveAccount('b@y.com')
assert.equal(m.getActiveAccount(), 'b@y.com')
m.setActiveAccount(null)
assert.equal(m.getActiveAccount(), null)

// --- account-aware pins: same thread id in two mailboxes is two distinct pins ---
setState({ connected: true, accounts: ['a@x.com', 'b@y.com'] })
assert.equal(m.togglePin('t1', 'a@x.com'), true)  // pin in account a
assert.equal(m.togglePin('t1', 'b@y.com'), true)  // same id, account b — separate pin
assert.equal(m.isPinned('t1', 'a@x.com'), true)
assert.equal(m.isPinned('t1', 'b@y.com'), true)
assert.equal(m.isPinned('t1', 'c@z.com'), false)  // not pinned in a third account
assert.equal(m.pinnedIds().length, 2)
assert.equal(m.togglePin('t1', 'a@x.com'), false) // unpin a only
assert.equal(m.isPinned('t1', 'a@x.com'), false)
assert.equal(m.isPinned('t1', 'b@y.com'), true)   // b still pinned
assert.deepEqual(m.pinnedIds(), [{ id: 't1', account: 'b@y.com' }])

// --- legacy string pins read as belonging to the primary account ---
setState({ connected: true, accounts: ['primary@x.com', 'b@y.com'], pinned: ['oldThread'] })
assert.deepEqual(m.pinnedIds(), [{ id: 'oldThread', account: 'primary@x.com' }])
assert.equal(m.isPinned('oldThread'), true) // legacy pins match id regardless of account arg

// --- loadEmail defaults accounts to an array even on a bare store ---
store.delete(KEY)
assert.deepEqual(m.loadEmail().accounts, [])

console.log('email-multi.check: all assertions passed')
