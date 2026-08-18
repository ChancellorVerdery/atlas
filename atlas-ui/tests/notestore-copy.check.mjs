// copyNoteStore is the first call that touches Apple's Notes database, and
// without Full Disk Access it fails with a bare EPERM naming two absolute
// paths — the error the user actually saw. This checks that a permission
// failure becomes an actionable message instead, using a chmod-000 file so it
// runs on a machine that DOES hold Full Disk Access (where the real store
// copies fine and the branch can never be reached).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { copyNoteStore } from '../server/middlewares.js'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nstore-check-'))
const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'nstore-dest-'))
const store = path.join(work, 'NoteStore.sqlite')

try {
  // ---- the happy path, including the -wal/-shm siblings ---------------------
  fs.writeFileSync(store, 'main')
  fs.writeFileSync(store + '-wal', 'wal')
  copyNoteStore(store, dest) // no -shm on disk: must not throw
  assert.equal(fs.readFileSync(path.join(dest, 'NoteStore.sqlite'), 'utf8'), 'main')
  assert.equal(fs.readFileSync(path.join(dest, 'NoteStore.sqlite-wal'), 'utf8'), 'wal')
  assert.equal(fs.existsSync(path.join(dest, 'NoteStore.sqlite-shm')), false, 'absent sibling is skipped, not invented')

  // ---- the permission path -------------------------------------------------
  fs.chmodSync(store, 0o000)
  // The premise of the whole fix: the entry is still visible, only the open fails.
  assert.equal(fs.existsSync(store), true, 'existsSync passes on an unreadable store')
  assert.throws(
    () => copyNoteStore(store, dest),
    (e) => {
      assert.equal(e.code, 500, 'surfaces as an HTTP error, not a raw errno')
      assert.match(e.message, /Full Disk Access/, 'names the actual remedy')
      assert.doesNotMatch(e.message, /EPERM|EACCES/, 'no raw errno leaks to the user')
      return true
    },
  )
  fs.chmodSync(store, 0o644)

  // ---- any other failure keeps its real reason -----------------------------
  assert.throws(
    () => copyNoteStore(store, path.join(dest, 'no-such-dir')),
    (e) => {
      assert.equal(e.code, 500)
      assert.doesNotMatch(e.message, /Full Disk Access/, 'a missing dir is not a permissions problem')
      return true
    },
  )
} finally {
  try { fs.chmodSync(store, 0o644) } catch { /* already gone */ }
  fs.rmSync(work, { recursive: true, force: true })
  fs.rmSync(dest, { recursive: true, force: true })
}

console.log('notestore-copy.check: permission failure surfaces as an actionable message')
