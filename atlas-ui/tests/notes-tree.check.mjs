// Apple Notes import: pure-logic self-check for the two transforms added to
// server/middlewares.js — parseAppleTree (osascript's \x1f-delimited walk
// output → the account/folders/notes tree shape), notePk (Core Data id URI →
// NoteStore Z_PK), and appleHtmlToMarkdown (AppleScript `body of note` HTML →
// displayable markdown). All three are synthetic-input only: nothing here
// touches Notes.app, NoteStore.sqlite, or osascript — see the report for what
// still needs a live Mac.
// Run: node tests/notes-tree.check.mjs
import assert from 'node:assert/strict'
import { parseAppleTree, notePk, appleHtmlToMarkdown } from '../server/middlewares.js'

const SEP = '\x1f'

// ---- parseAppleTree ----------------------------------------------------------

// Two accounts, a folder with two notes, an empty folder, and a second
// account with one folder/one note — mirrors exactly what appleTree()'s
// AppleScript emits (one line per folder even with zero notes).
const raw = [
  ['iCloud', 'Notes', 'fld-1', 'note-1', 'Groceries'].join(SEP),
  ['iCloud', 'Notes', 'fld-1', 'note-2', 'Groceries'].join(SEP), // duplicate title, distinct id
  ['iCloud', 'Work', 'fld-2', '', ''].join(SEP), // empty folder — still shows up
  ['On My Mac', 'Scratch', 'fld-3', 'note-3', 'Idea'].join(SEP),
].join('\n')

const tree = parseAppleTree(raw)
assert.equal(tree.length, 2, 'two accounts')
assert.equal(tree[0].account, 'iCloud')
assert.equal(tree[0].folders.length, 2, 'iCloud has two folders (Notes, Work)')
const notesFld = tree[0].folders.find((f) => f.name === 'Notes')
assert.equal(notesFld.notes.length, 2)
assert.deepEqual(notesFld.notes.map((n) => n.id), ['note-1', 'note-2'], 'distinct ids survive a duplicate title')
assert.deepEqual(notesFld.notes.map((n) => n.title), ['Groceries', 'Groceries'])
const workFld = tree[0].folders.find((f) => f.name === 'Work')
assert.deepEqual(workFld.notes, [], 'empty folder still appears, with no notes')
assert.equal(tree[1].account, 'On My Mac')
assert.equal(tree[1].folders[0].notes[0].title, 'Idea')

// blank/malformed lines and a line missing a folder id are dropped, not crashed on
assert.deepEqual(parseAppleTree('').length, 0)
assert.deepEqual(parseAppleTree('\n\n \n').length, 0)
assert.deepEqual(parseAppleTree(['no-account-name here'].join('\n')).length, 0)
assert.deepEqual(parseAppleTree([['Acc', 'Fld', '', '', ''].join(SEP)].join('\n')).length, 0, 'missing folder id is dropped')

// ---- notePk --------------------------------------------------------------------

assert.equal(notePk('x-coredata://54DD86A2-98B9-4818-B3AA-58715FF9F489/ICNote/p3453'), '3453')
assert.equal(notePk('x-coredata://ABC/ICFolder/p1'), '1')
assert.equal(notePk(''), null)
assert.equal(notePk(undefined), null)
assert.equal(notePk('not-a-coredata-id'), null, 'no trailing /p<digits> → no pk, caller falls back to title')

// ---- appleHtmlToMarkdown ---------------------------------------------------------

assert.equal(
  appleHtmlToMarkdown('<div><h1>Groceries</h1></div><div>Milk</div><div>Eggs</div>'),
  '# Groceries\n\nMilk\nEggs',
)
assert.match(appleHtmlToMarkdown('<div><b>Important:</b> call back</div>'), /\*\*Important:\*\* call back/)
assert.match(appleHtmlToMarkdown('<div><i>aside</i></div>'), /\*aside\*/)
assert.match(
  appleHtmlToMarkdown('<div><a href="https://example.com">a link</a></div>'),
  /\[a link\]\(https:\/\/example\.com\)/,
)
assert.match(appleHtmlToMarkdown('<div>line one<br>line two</div>'), /line one\nline two/)
assert.match(appleHtmlToMarkdown('<ul><li>eggs</li><li>milk</li></ul>'), /- eggs\n- milk/)
// entities unescape after tags are stripped
assert.equal(appleHtmlToMarkdown('<div>Fish &amp; chips &nbsp;&lt;3&gt;</div>'), 'Fish & chips  <3>')
// never throws on garbage input
assert.doesNotThrow(() => appleHtmlToMarkdown(''))
assert.doesNotThrow(() => appleHtmlToMarkdown(undefined))
assert.doesNotThrow(() => appleHtmlToMarkdown('<div><b>unclosed'))
assert.equal(appleHtmlToMarkdown(null), '')

console.log('notes-tree.check: all assertions passed')
