// Reconciler self-check (node tests/notes-sync.check.mjs).
//
// Drives the REAL reconcile() against a fake disk and a fake server that
// implements the same rules as services/uiapi/notes.js: a per-user monotonic
// rev, deletes as tombstones, uploads that resurrect a tombstone, and a 30-day
// archive sweep. Two devices share one server so "the other device" is a real
// second reconciler, not a mock.
//
// Ceiling worth naming: this proves the ALGORITHM. The SQL that implements the
// same rules server-side is exercised by applying the migration and by the live
// deploy, not by this file.
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { reconcile, conflictPath } from '../src/page/notessync.js'

const hash = async (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const DAY = 86400e3

// ---- fake server (mirrors services/uiapi/notes.js) --------------------------
function makeServer(clock) {
  const rows = new Map() // path -> {content, sha256, size, mtime, rev, deletedAt}
  let rev = 0
  const ARCHIVE_DAYS = 30
  return {
    rows,
    get rev() { return rev },
    gc() {
      for (const [p, r] of rows) {
        if (r.deletedAt != null && r.deletedAt < clock() - ARCHIVE_DAYS * DAY) rows.delete(p)
      }
    },
    async changes(since) {
      this.gc()
      const files = [...rows.entries()]
        .filter(([, r]) => r.rev > since)
        .sort((a, b) => a[1].rev - b[1].rev)
        .map(([path, r]) => ({ path, sha256: r.sha256, size: r.size, mtime: r.mtime, rev: r.rev, deleted: r.deletedAt != null }))
      return { rev, files }
    },
    async get(path) {
      const r = rows.get(path)
      if (!r) throw new Error(`404 ${path}`)
      return { content: r.content, sha256: r.sha256, mtime: r.mtime }
    },
    async put(path, content, mtime) {
      const sha = await hash(content)
      rows.set(path, { content, sha256: sha, size: content.length, mtime: mtime ?? clock(), rev: ++rev, deletedAt: null })
      return { sha256: sha, rev }
    },
    async del(path) {
      const r = rows.get(path)
      if (!r || r.deletedAt != null) return { alreadyDeleted: true }
      r.deletedAt = clock(); r.rev = ++rev
      return { rev }
    },
    async restore(path) {
      const r = rows.get(path)
      if (!r || r.deletedAt == null) throw new Error('not archived')
      r.deletedAt = null; r.rev = ++rev
      return { rev }
    },
    archive() {
      this.gc()
      return [...rows.entries()].filter(([, r]) => r.deletedAt != null)
        .map(([path, r]) => ({ path, deletedAt: r.deletedAt, expiresAt: r.deletedAt + ARCHIVE_DAYS * DAY }))
    },
  }
}

// ---- fake device ------------------------------------------------------------
function makeDevice(server, label, clock) {
  const disk = new Map() // path -> {content, mtime}
  let snapshot = { rev: 0, files: {} }
  const local = {
    async list() { return [...disk.entries()].map(([path, f]) => ({ path, mtime: f.mtime })) },
    async read(path) { return disk.get(path)?.content ?? null },
    async write(path, content) { disk.set(path, { content, mtime: clock() }) },
    async remove(path) { disk.delete(path) },
  }
  return {
    label, disk,
    get snapshot() { return snapshot },
    put(path, content) { disk.set(path, { content, mtime: clock() }) },   // user drops a file in
    rm(path) { disk.delete(path) },                                        // user deletes it
    files() { return Object.fromEntries([...disk.entries()].map(([p, f]) => [p, f.content])) },
    async sync() {
      const r = await reconcile({ local, remote: server, snapshot, hash, now: clock, label })
      snapshot = r.snapshot
      return r
    },
  }
}

let t = 1_700_000_000_000
const clock = () => (t += 1000)
let passed = 0
const ok = (cond, name) => { assert.ok(cond, name); passed++; }

// =============================================================================
console.log('1. a file dropped on one device reaches the other')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock)
  const phone = makeDevice(s, 'iPhone', clock)
  mac.put('Classes/thermo.md', '# Entropy')
  await mac.sync()
  await phone.sync()
  ok(phone.files()['Classes/thermo.md'] === '# Entropy', 'the note arrived on the second device')
  // ...and a second pass is a genuine no-op, not a re-upload loop.
  const again = await phone.sync()
  ok(again.pulled.length === 0 && again.pushed.length === 0, 'steady state does nothing')
  const macAgain = await mac.sync()
  ok(macAgain.pushed.length === 0, 'the origin device does not re-upload its own file')
}

console.log('2. an edit on either end propagates')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock), phone = makeDevice(s, 'iPhone', clock)
  mac.put('a.md', 'v1'); await mac.sync(); await phone.sync()
  phone.put('a.md', 'v2'); await phone.sync(); await mac.sync()
  ok(mac.files()['a.md'] === 'v2', 'edit made on the phone landed on the Mac')
  mac.put('a.md', 'v3'); await mac.sync(); await phone.sync()
  ok(phone.files()['a.md'] === 'v3', 'and back the other way')
}

console.log('3. a delete on one device deletes on the other')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock), phone = makeDevice(s, 'iPhone', clock)
  mac.put('gone.md', 'bye'); await mac.sync(); await phone.sync()
  ok(phone.files()['gone.md'] === 'bye', 'present on both to begin with')
  mac.rm('gone.md')
  const r = await mac.sync()
  ok(r.deletedRemote.includes('gone.md'), 'the delete was reported to the server')
  const r2 = await phone.sync()
  ok(r2.deletedLocal.includes('gone.md'), 'the other device removed its copy')
  ok(phone.files()['gone.md'] === undefined, 'and it is really gone')
  // The regression this guards: a tombstone the device has already applied must
  // not come back as an "add" on the next pass.
  const r3 = await phone.sync()
  ok(r3.pulled.length === 0 && r3.pushed.length === 0, 'the deleted note does not resurrect')
}

console.log('4. the deleted file is archived on the server for 30 days')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock)
  mac.put('temp.md', 'draft'); await mac.sync()
  mac.rm('temp.md'); await mac.sync()
  const arch = s.archive()
  ok(arch.length === 1 && arch[0].path === 'temp.md', 'it is in the archive')
  ok(arch[0].expiresAt - arch[0].deletedAt === 30 * DAY, 'it expires 30 days after deletion')
  ok((await s.get('temp.md')).content === 'draft', 'its content is still readable while archived')
}

console.log('5. restoring from the archive brings it back everywhere')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock), phone = makeDevice(s, 'iPhone', clock)
  mac.put('oops.md', 'important'); await mac.sync(); await phone.sync()
  mac.rm('oops.md'); await mac.sync(); await phone.sync()
  ok(phone.files()['oops.md'] === undefined, 'gone from the phone first')
  await s.restore('oops.md')
  await mac.sync(); await phone.sync()
  ok(mac.files()['oops.md'] === 'important', 'restored on the Mac')
  ok(phone.files()['oops.md'] === 'important', 'and on the phone')
}

console.log('6. after 30 days the archived file is really gone')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock)
  mac.put('old.md', 'stale'); await mac.sync()
  mac.rm('old.md'); await mac.sync()
  ok(s.archive().length === 1, 'archived to begin with')
  t += 29 * DAY
  ok(s.archive().length === 1, 'still there at 29 days')
  t += 2 * DAY
  ok(s.archive().length === 0, 'swept at 31 days')
  ok(!s.rows.has('old.md'), 'the row is gone, not just hidden')
  // And a device that had already applied the delete stays quiet afterwards.
  const r = await mac.sync()
  ok(r.pushed.length === 0 && r.pulled.length === 0, 'expiry does not disturb a synced device')
}

console.log('7. simultaneous edits keep BOTH versions')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock), phone = makeDevice(s, 'iPhone', clock)
  mac.put('notes.md', 'base'); await mac.sync(); await phone.sync()
  mac.put('notes.md', 'mac version')
  phone.put('notes.md', 'phone version')
  await mac.sync()    // Mac wins the path (it synced first)
  const r = await phone.sync()
  ok(r.conflicts.length === 1, 'the phone detected a conflict')
  const kept = r.conflicts[0].kept
  ok(phone.files()['notes.md'] === 'mac version', "the server's version holds the original path")
  ok(phone.files()[kept] === 'phone version', 'the local version survived under a new name')
  ok(/conflict from iPhone/.test(kept), 'the copy names the device that made it')
  await mac.sync()
  ok(mac.files()[kept] === 'phone version', 'and the conflict copy syncs to the other device too')
  const settle = await phone.sync()
  ok(settle.conflicts.length === 0, 'the conflict resolves once and does not repeat')
}

console.log('8. identical edits on both ends are not a conflict')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock), phone = makeDevice(s, 'iPhone', clock)
  mac.put('same.md', 'base'); await mac.sync(); await phone.sync()
  mac.put('same.md', 'identical'); phone.put('same.md', 'identical')
  await mac.sync()
  const r = await phone.sync()
  ok(r.conflicts.length === 0, 'same bytes, no conflict copy')
  ok(Object.keys(phone.files()).length === 1, 'no stray file was created')
}

console.log('9. edit-vs-delete never destroys the edit')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock), phone = makeDevice(s, 'iPhone', clock)
  mac.put('keep.md', 'base'); await mac.sync(); await phone.sync()
  mac.rm('keep.md'); await mac.sync()          // deleted on the Mac
  phone.put('keep.md', 'edited later')          // meanwhile edited on the phone
  await phone.sync()
  ok(phone.files()['keep.md'] === 'edited later', 'the edit survived the remote delete')
  await mac.sync()
  ok(mac.files()['keep.md'] === 'edited later', 'and came back to the device that deleted it')
}
{
  // The mirror image: deleted here, edited there.
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock), phone = makeDevice(s, 'iPhone', clock)
  mac.put('m.md', 'base'); await mac.sync(); await phone.sync()
  phone.put('m.md', 'phone edit'); await phone.sync()
  mac.rm('m.md')
  await mac.sync()
  ok(mac.files()['m.md'] === 'phone edit', 'a local delete yields to a remote edit')
}

console.log('10. a device offline for a week catches up in one pass')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock), phone = makeDevice(s, 'iPhone', clock)
  mac.put('a.md', '1'); await mac.sync(); await phone.sync()
  mac.put('b.md', '2'); mac.put('c.md', '3'); mac.put('a.md', '1 edited'); await mac.sync()
  mac.rm('b.md'); await mac.sync()
  t += 7 * DAY
  const r = await phone.sync()
  ok(r.pulled.includes('c.md') && r.pulled.includes('a.md'), 'picked up the adds and the edit')
  ok(phone.files()['b.md'] === undefined, 'and never materialised the file that was created then deleted')
  ok(phone.files()['a.md'] === '1 edited' && phone.files()['c.md'] === '3', 'contents are current')
}

console.log('11. nested paths and a broken file do not derail a pass')
{
  const s = makeServer(clock)
  const mac = makeDevice(s, 'Mac', clock), phone = makeDevice(s, 'iPhone', clock)
  mac.put('deep/nested/folder/note.md', 'x'); mac.put('top.md', 'y')
  await mac.sync(); await phone.sync()
  ok(phone.files()['deep/nested/folder/note.md'] === 'x', 'nested path round-tripped')

  // One unreadable file must not stop the others, and must not be recorded as
  // agreed — otherwise it is silently never synced again.
  const s2 = makeServer(clock)
  const dev = makeDevice(s2, 'Mac', clock)
  dev.put('good.md', 'fine'); dev.put('bad.md', 'boom')
  const realPut = s2.put.bind(s2)
  s2.put = async (p, c, m) => { if (p === 'bad.md') throw new Error('server said no'); return realPut(p, c, m) }
  const r = await dev.sync()
  ok(r.errors.length === 1 && r.errors[0].path === 'bad.md', 'the failure was reported, not swallowed')
  ok(r.pushed.includes('good.md'), 'the healthy file still synced')
  s2.put = realPut
  const r2 = await dev.sync()
  ok(r2.pushed.includes('bad.md'), 'and the failed file is retried on the next pass')
}

console.log('12. conflictPath naming')
{
  ok(conflictPath('a/b/note.md', 'Mac', Date.UTC(2026, 7, 19)) === 'a/b/note (conflict from Mac, 2026-08-19).md', 'nested')
  ok(conflictPath('note.md', 'iPhone', Date.UTC(2026, 7, 19)) === 'note (conflict from iPhone, 2026-08-19).md', 'root')
  ok(conflictPath('README', 'Mac', Date.UTC(2026, 7, 19)) === 'README (conflict from Mac, 2026-08-19)', 'no extension')
}

console.log(`\nnotes-sync.check: ${passed} assertions passed`)
