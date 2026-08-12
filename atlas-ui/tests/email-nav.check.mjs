// The mail nav lists every connected account with its own folders beneath it,
// so what belongs under which heading is now logic worth pinning down — above
// all "All inboxes", which may only show labels every account actually has.
// Run: node tests/email-nav.check.mjs
import assert from 'node:assert/strict'

// minimal localStorage + globals email.js/datacache.js touch at import
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
}
if (!globalThis.crypto) globalThis.crypto = (await import('node:crypto')).webcrypto

const { foldersFor, navHTML } = await import('../src/page/emailui.js')

const A = 'a@x.com', B = 'b@y.com'
const labels = {
  [A]: [{ id: 'Label_1', name: 'Receipts' }, { id: 'Label_2', name: 'School' }, { id: 'Label_3', name: 'Only A' }],
  [B]: [{ id: 'Label_9', name: 'School' }, { id: 'Label_8', name: 'Receipts' }, { id: 'Label_7', name: 'Only B' }],
}
const names = (fs) => fs.map((f) => f.name)
const SYSTEM = ['Inbox', 'Pinned', 'Important', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash']

// --- one account: its own labels, addressed by their real ids ---
const a = foldersFor(A, labels, [A, B])
assert.deepEqual(names(a), [...SYSTEM, 'Receipts', 'School', 'Only A'])
assert.equal(a.find((f) => f.name === 'Receipts').labelIds, 'Label_1')
assert.equal(a.find((f) => f.name === 'Receipts').id, 'Label_1')
assert.deepEqual(names(foldersFor(B, labels, [A, B])).slice(SYSTEM.length), ['School', 'Receipts', 'Only B'])

// --- all inboxes: only the labels BOTH have, and matched by name, not by id ---
const all = foldersFor('all', labels, [A, B])
assert.deepEqual(names(all), [...SYSTEM, 'Receipts', 'School']) // sorted; 'Only A'/'Only B' excluded
const shared = all.find((f) => f.name === 'Receipts')
assert.equal(shared.id, 'shared:Receipts')
assert.equal(shared.q, 'label:"Receipts"') // a label id means nothing in the other mailbox
assert.equal(shared.labelIds, undefined)

// --- system folders are the same ids everywhere, so switching account keeps the folder ---
assert.deepEqual(all.slice(0, SYSTEM.length).map((f) => f.id), a.slice(0, SYSTEM.length).map((f) => f.id))

// --- labels arrive per account and asynchronously: a half-loaded nav shows no
//     shared labels rather than one account's private ones ---
assert.deepEqual(names(foldersFor('all', { [A]: labels[A] }, [A, B])), SYSTEM)
assert.deepEqual(names(foldersFor('all', {}, [A, B])), SYSTEM)
assert.deepEqual(names(foldersFor('all', labels, [])), SYSTEM) // no accounts yet
assert.deepEqual(names(foldersFor('nobody@z.com', labels, [A, B])), SYSTEM) // account with no labels cached

// --- a quote in a label name must not break out of the search query ---
assert.equal(
  foldersFor('all', { [A]: [{ id: 'L1', name: 'He said "hi"' }], [B]: [{ id: 'L2', name: 'He said "hi"' }] }, [A, B])
    .find((f) => f.icon === 'label').q,
  'label:"He said hi"',
)

// --- the rendered nav: an account heading, then that account's folders ------
const nav = navHTML([A, B], 'all', 'INBOX', labels)
const headings = [...nav.matchAll(/class="mail-nav__acct[^"]*"[^>]*>([^<]+)</g)].map((m) => m[1])
assert.deepEqual(headings, ['All inboxes', A, B]) // All inboxes leads

// Each heading is followed by its own folder block, and every folder in it
// carries the account it belongs to — that pairing is what makes one click
// switch mailbox and folder together.
const blocks = [...nav.matchAll(/class="mail-nav__sub">([\s\S]*?)<\/div>/g)].map((m) => m[1])
assert.equal(blocks.length, 3)
for (const [i, acct] of ['all', A, B].entries()) {
  const accounts = new Set([...blocks[i].matchAll(/data-mail-account="([^"]+)"/g)].map((m) => m[1]))
  assert.deepEqual([...accounts], [acct])
  for (const f of SYSTEM) assert.ok(blocks[i].includes(`>${f}<`), `${f} missing under ${acct}`)
}
assert.ok(blocks[0].includes('data-mail-folder="shared:Receipts"'), 'shared label missing from All inboxes')
assert.ok(blocks[1].includes('data-mail-folder="Label_3"'), "A's own label missing from its section")
assert.ok(!blocks[0].includes('Only A'), 'a one-account label leaked into All inboxes')

// The active row is the folder in the ACTIVE account's section, not the same
// folder id everywhere — every section has an Inbox.
const activeCount = (html) => (html.match(/mail-folder is-active/g) || []).length
assert.equal(activeCount(nav), 1)
assert.ok(blocks[0].includes('mail-folder is-active'), 'All inboxes / Inbox should be the active row')
assert.ok(navHTML([A, B], B, 'INBOX', labels).split('mail-nav__sub')[3].includes('mail-folder is-active'))
assert.equal((navHTML([A, B], B, 'INBOX', labels).match(/mail-nav__acct is-active/g) || []).length, 1)

// --- collapsing hides a section's folders without losing the active row -----
const open3 = [...nav.matchAll(/<details[^>]*\sopen[^>]*>/g)].length
assert.equal(open3, 3) // nothing collapsed by default

const shut = navHTML([A, B], 'all', 'INBOX', labels, [A])
const grp = (html, acct) => html.match(new RegExp(`<details[^>]*data-mail-group="${acct}"[^>]*>`))[0]
assert.ok(!/\sopen/.test(grp(shut, A)), 'collapsed account should render closed')
assert.ok(/\sopen/.test(grp(shut, 'all')) && /\sopen/.test(grp(shut, B)), 'other sections stay open')
assert.equal(activeCount(shut), 1) // the active row still exists, just hidden
assert.equal([...shut.matchAll(/<details/g)].length, 3)

// An address in the collapsed list that is no longer connected is simply not
// rendered — no stale <details>, and it must not close anything else.
const gone = navHTML([A, B], 'all', 'INBOX', labels, ['c@z.com'])
assert.equal([...gone.matchAll(/<details[^>]*\sopen/g)].length, 3)

// --- one account: the plain folder list it always had, no headings ----------
const solo = navHTML([A], A, 'INBOX', labels)
assert.equal([...solo.matchAll(/mail-nav__acct/g)].length, 0)
assert.ok(solo.includes('>Only A<') && solo.includes('<p class="mail-nav__head">Labels</p>'))

console.log('email-nav.check: all assertions passed')
