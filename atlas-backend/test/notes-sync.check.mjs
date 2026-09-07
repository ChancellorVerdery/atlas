// The synced-notes service's revision log, tombstone lifecycle and per-user
// isolation, executed - not read.
//
// WHY THIS FILE EXISTS. services/uiapi/notes.js is 237 lines that own the
// user's actual notes vault, and the only thing watching it was four arms in
// uiapi.check.mjs against the two PURE helpers (cleanPath, sha256). The
// handler itself - every rule about revisions, tombstones, resurrection,
// restore, purge and user isolation - had no behavioural coverage at all.
//
// Arm 2 is the reason this got written. `/changes` computed the cursor it
// hands back AFTER scanning for rows, so a write committing between those two
// unsnapshotted queries produced a response saying "you are caught up through
// rev N" without ever including rev N. The device stores N, next pull asks
// since=N, and that note is invisible to it forever. That is a silent
// permanent data loss in the one code path the whole revision-log design
// exists to make reliable, and it is the failure a device offline for a week
// is most likely to hit, because it is the pull that takes longest to run.
//
// Importing services/uiapi/notes.js is inert: it binds no port and touches no
// pool at import time.
//
// Run: node test/notes-sync.check.mjs
import { strictEqual, deepStrictEqual, ok } from 'node:assert'
import { EventEmitter } from 'node:events'
import { pool } from '../lib/db.js'
import { notesSync, _internals } from '../services/uiapi/notes.js'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

const A = 'aaaaaaaa-0000-0000-0000-000000000001'
const B = 'bbbbbbbb-0000-0000-0000-000000000002'
const DAY = 86400e3

// ---- model of notes_sync.files / notes_sync.cursor --------------------------
// Deliberately loud: any SQL this does not recognise is a hard throw, never a
// silent {rows:[]}. Twelve passes of this codebase's history say the way a
// suite like this goes green over the exact bug it exists to catch is a query
// quietly routing around the model.
let files, cursor
const reset = () => { files = new Map(); cursor = new Map() }
const k = (u, p) => `${u}|${p}`
reset()

// A write that commits out from under an in-flight read. Used by arm 2.
let onFirstSelect = null

const runSql = async (q, params = []) => {
  const s = String(q).replace(/\s+/g, ' ').trim()
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] }

  if (s.startsWith('DELETE FROM notes_sync.files WHERE user_id = $1 AND deleted_at IS NOT NULL AND deleted_at <')) {
    const cutoff = Date.now() - Number(params[1]) * DAY
    for (const [key, r] of files) if (r.user === params[0] && r.deleted_at != null && r.deleted_at < cutoff) files.delete(key)
    return { rows: [] }
  }

  if (s.startsWith('SELECT path, sha256, size, mtime, rev, (deleted_at IS NOT NULL) AS deleted')) {
    // Both the bounded and unbounded forms are recognised ON PURPOSE: NC1
    // reverts the fix, and a model that threw on the old SQL would fail the
    // negative control in the harness rather than in the arm.
    const bounded = s.includes('rev > $2 AND rev <= $3')
    if (!bounded && !s.includes('rev > $2 ORDER BY rev')) throw new Error('unmodelled changes SQL: ' + s)
    const rows = [...files.values()]
      .filter((r) => r.user === params[0] && r.rev > Number(params[1]) && (!bounded || r.rev <= Number(params[2])))
      .sort((a, b) => a.rev - b.rev)
      .map((r) => ({ path: r.path, sha256: r.sha256, size: r.size, mtime: r.mtime, rev: r.rev, deleted: r.deleted_at != null }))
    return { rows }
  }

  if (s.startsWith('SELECT rev FROM notes_sync.cursor WHERE user_id = $1'))
    return { rows: cursor.has(params[0]) ? [{ rev: cursor.get(params[0]) }] : [] }

  if (s.startsWith('SELECT content, sha256, mtime FROM notes_sync.files WHERE user_id = $1 AND path = $2')) {
    const liveOnly = s.includes('AND deleted_at IS NULL')
    const r = files.get(k(params[0], params[1]))
    if (!r || (liveOnly && r.deleted_at != null)) return { rows: [] }
    return { rows: [{ content: r.content, sha256: r.sha256, mtime: r.mtime }] }
  }

  if (s.startsWith('INSERT INTO notes_sync.cursor (user_id, rev)')) {
    const next = (cursor.get(params[0]) || 0) + 1
    cursor.set(params[0], next)
    return { rows: [{ rev: next }] }
  }

  if (s.startsWith('INSERT INTO notes_sync.files (user_id, path, content, sha256, size, mtime, rev, deleted_at)')) {
    const [user, path, content, sha, size, mtime, rev] = params
    const row = { user, path, content, sha256: sha, size: Number(size), mtime: Number(mtime), rev: Number(rev), deleted_at: null }
    const prev = files.get(k(user, path))
    if (!prev) { files.set(k(user, path), row); return { rows: [{ rev: row.rev }] } }
    // On conflict, honour the DO UPDATE SET clause AS WRITTEN. An earlier draft
    // of this model just overwrote the row wholesale, which quietly made the
    // resurrection and rev-advance rules untestable: NC5 and NC6 both stayed
    // green with the product change applied.
    const set = s.slice(s.indexOf('DO UPDATE SET'))
    if (set.includes('content = EXCLUDED.content')) prev.content = row.content
    if (set.includes('sha256 = EXCLUDED.sha256')) prev.sha256 = row.sha256
    if (set.includes('size = EXCLUDED.size')) prev.size = row.size
    if (set.includes('mtime = EXCLUDED.mtime')) prev.mtime = row.mtime
    if (set.includes('rev = EXCLUDED.rev')) prev.rev = row.rev
    if (set.includes('deleted_at = NULL')) prev.deleted_at = null
    return { rows: [{ rev: prev.rev }] }
  }

  if (s.startsWith('UPDATE notes_sync.files SET deleted_at = now(), rev = $3')) {
    const r = files.get(k(params[0], params[1]))
    if (!r || r.deleted_at != null) return { rows: [] }
    r.deleted_at = Date.now(); r.rev = Number(params[2])
    return { rows: [{ rev: r.rev }] }
  }

  if (s.startsWith('UPDATE notes_sync.files SET deleted_at = NULL, rev = $3')) {
    const r = files.get(k(params[0], params[1]))
    if (!r || r.deleted_at == null) return { rows: [] }
    r.deleted_at = null; r.rev = Number(params[2])
    return { rows: [{ rev: r.rev }] }
  }

  if (s.startsWith('SELECT path, size, mtime, sha256, deleted_at')) {
    const days = Number(params[1])
    const rows = [...files.values()]
      .filter((r) => r.user === params[0] && r.deleted_at != null)
      .sort((a, b) => b.deleted_at - a.deleted_at)
      .map((r) => ({ path: r.path, size: r.size, mtime: r.mtime, sha256: r.sha256, deleted_at: r.deleted_at, expires_at: r.deleted_at + days * DAY }))
    return { rows }
  }

  if (s.startsWith('DELETE FROM notes_sync.files WHERE user_id = $1 AND path = $2 AND deleted_at IS NOT NULL')) {
    const r = files.get(k(params[0], params[1]))
    if (r && r.deleted_at != null) files.delete(k(params[0], params[1]))
    return { rows: [] }
  }

  throw new Error('unmodelled SQL: ' + s)
}

let selectsSeen = 0
const query = async (q, params) => {
  const r = await runSql(q, params)
  if (String(q).trim().startsWith('SELECT') && ++selectsSeen === 1 && onFirstSelect) onFirstSelect()
  return r
}
pool.query = query
// tx() calls pool.connect(); the model is one shared store, so a "client" is
// just the same query function plus a no-op release.
pool.connect = async () => ({ query, release() {} })

// ---- driving the handler ----------------------------------------------------
const call = (userId, method, url, body) => new Promise((resolve, reject) => {
  const req = new EventEmitter()
  req.url = url
  req.method = method
  req.atlasUser = userId ? { userId } : undefined
  req.destroy = () => { destroyed = true }
  let destroyed = false
  const res = {
    writeHead(code) { this.code = code; return this },
    end(b) { resolve({ code: this.code, body: b ? JSON.parse(b) : null, destroyed }) },
  }
  Promise.resolve(notesSync(req, res)).catch(reject)
  if (body !== undefined) {
    setImmediate(() => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
      req.emit('data', buf)
      if (!destroyed) req.emit('end')
    })
  }
})

const put = (u, path, content) => call(u, 'PUT', `/file?path=${encodeURIComponent(path)}&mtime=1000`, content)
const changes = (u, since) => call(u, 'GET', `/changes?since=${since}`)
const fresh = () => { reset(); selectsSeen = 0; onFirstSelect = null }

// ---- arm 1 ------------------------------------------------------------------
await check('a written note is delivered by /changes and readable by /file', async () => {
  fresh()
  const w = await put(A, 'ideas/a.md', 'hello')
  strictEqual(w.code, 200)
  strictEqual(w.body.rev, 1)
  const c = await changes(A, 0)
  strictEqual(c.body.rev, 1)
  deepStrictEqual(c.body.files.map((f) => [f.path, f.deleted, f.size]), [['ideas/a.md', false, 5]])
  const f = await call(A, 'GET', '/file?path=ideas%2Fa.md')
  strictEqual(f.body.content, 'hello')
  strictEqual(f.body.sha256, w.body.sha256)
})

// ---- arm 2: THE BUG ---------------------------------------------------------
await check('/changes never reports a rev it did not deliver the rows for', async () => {
  fresh()
  await put(A, 'a.md', 'one')
  selectsSeen = 0
  // A second device's upload commits the instant the pull's FIRST read returns.
  // Gated on the first SELECT rather than on a query index, so it means the
  // same thing whichever order the handler runs its two reads in.
  onFirstSelect = () => {
    onFirstSelect = null
    const rev = (cursor.get(A) || 0) + 1
    cursor.set(A, rev)
    files.set(k(A, 'b.md'), { user: A, path: 'b.md', content: 'two', sha256: 'bb', size: 3, mtime: 1000, rev, deleted_at: null })
  }
  const first = await changes(A, 0)
  onFirstSelect = null
  const second = await changes(A, first.body.rev)
  const delivered = new Set([...first.body.files, ...second.body.files].map((f) => f.path))
  ok(delivered.has('b.md'),
    `b.md was never delivered: pull1 rev=${first.body.rev} files=[${first.body.files.map((f) => f.path)}], ` +
    `pull2(since=${first.body.rev}) files=[${second.body.files.map((f) => f.path)}]`)
  // and the response must be internally consistent, not merely eventually right
  for (const f of first.body.files) ok(f.rev <= first.body.rev, `delivered rev ${f.rev} above reported rev ${first.body.rev}`)
})

// ---- arm 3 ------------------------------------------------------------------
await check('a delete is a tombstone /changes still reports, not an absent row', async () => {
  fresh()
  await put(A, 'a.md', 'one')
  const d = await call(A, 'POST', '/delete', JSON.stringify({ path: 'a.md' }))
  strictEqual(d.code, 200)
  strictEqual(d.body.alreadyDeleted, false)
  const c = await changes(A, 0)
  deepStrictEqual(c.body.files.map((f) => [f.path, f.deleted]), [['a.md', true]],
    'a device that missed the delete must be told about it, or it re-uploads the note')
  strictEqual((await call(A, 'GET', '/file?path=a.md')).code, 404, 'a tombstoned note must not read as live')
  strictEqual((await call(A, 'GET', '/file?path=a.md&archived=1')).body.content, 'one',
    'the archive preview and restore both need the content to survive')
})

// ---- arm 4 ------------------------------------------------------------------
await check('two devices deleting the same note both finish cleanly', async () => {
  fresh()
  await put(A, 'a.md', 'one')
  await call(A, 'POST', '/delete', JSON.stringify({ path: 'a.md' }))
  const again = await call(A, 'POST', '/delete', JSON.stringify({ path: 'a.md' }))
  strictEqual(again.code, 200)
  strictEqual(again.body.alreadyDeleted, true)
  strictEqual(again.body.rev, null)
})

// ---- arm 5 ------------------------------------------------------------------
await check('re-uploading a tombstoned path resurrects it', async () => {
  fresh()
  await put(A, 'a.md', 'one')
  await call(A, 'POST', '/delete', JSON.stringify({ path: 'a.md' }))
  const w = await put(A, 'a.md', 'again')
  const c = await changes(A, 0)
  deepStrictEqual(c.body.files.map((f) => [f.path, f.deleted]), [['a.md', false]],
    'the user recreating a note must win over the tombstone')
  strictEqual((await call(A, 'GET', '/file?path=a.md')).body.content, 'again')
  strictEqual(c.body.rev, w.body.rev)
})

// ---- arm 6 ------------------------------------------------------------------
await check('archive lists tombstones with an expiry, and restore flips them back', async () => {
  fresh()
  await put(A, 'a.md', 'one')
  await call(A, 'POST', '/delete', JSON.stringify({ path: 'a.md' }))
  const ar = await call(A, 'GET', '/archive')
  strictEqual(ar.body.days, _internals.ARCHIVE_DAYS)
  strictEqual(ar.body.files.length, 1)
  strictEqual(ar.body.files[0].path, 'a.md')
  strictEqual(ar.body.files[0].expiresAt - ar.body.files[0].deletedAt, _internals.ARCHIVE_DAYS * DAY)
  const r = await call(A, 'POST', '/restore', JSON.stringify({ path: 'a.md' }))
  strictEqual(r.code, 200)
  strictEqual((await call(A, 'GET', '/archive')).body.files.length, 0)
  const c = await changes(A, 0)
  deepStrictEqual(c.body.files.map((f) => [f.path, f.deleted, f.rev]), [['a.md', false, r.body.rev]],
    'a restore must propagate like any other change')
  strictEqual((await call(A, 'POST', '/restore', JSON.stringify({ path: 'a.md' }))).code, 404,
    'restoring something not in the archive is a 404, not a silent no-op 200')
})

// ---- arm 7 ------------------------------------------------------------------
await check('purge drops the row, and gc drops tombstones past the archive window', async () => {
  fresh()
  await put(A, 'a.md', 'one')
  await put(A, 'b.md', 'two')
  await call(A, 'POST', '/delete', JSON.stringify({ path: 'a.md' }))
  await call(A, 'POST', '/delete', JSON.stringify({ path: 'b.md' }))
  strictEqual((await call(A, 'POST', '/purge', JSON.stringify({ path: 'a.md' }))).code, 200)
  deepStrictEqual((await call(A, 'GET', '/archive')).body.files.map((f) => f.path), ['b.md'])
  // age b.md past the window; the opportunistic gc on the next call must reap it
  files.get(k(A, 'b.md')).deleted_at = Date.now() - (_internals.ARCHIVE_DAYS + 1) * DAY
  deepStrictEqual((await call(A, 'GET', '/archive')).body.files.map((f) => f.path), [])
})

// ---- arm 8 ------------------------------------------------------------------
await check('one user\'s notes never appear in another user\'s sync', async () => {
  fresh()
  await put(A, 'secret.md', 'A only')
  await put(B, 'mine.md', 'B only')
  deepStrictEqual((await changes(B, 0)).body.files.map((f) => f.path), ['mine.md'])
  strictEqual((await call(B, 'GET', '/file?path=secret.md')).code, 404)
  strictEqual((await call(B, 'GET', '/file?path=secret.md&archived=1')).code, 404,
    'the archived read must be scoped too - it is the one that skips deleted_at')
  await call(B, 'POST', '/delete', JSON.stringify({ path: 'secret.md' }))
  strictEqual((await changes(A, 0)).body.files[0].deleted, false, 'B must not be able to tombstone A\'s note')
  strictEqual((await call(A, 'GET', '/file?path=secret.md')).body.content, 'A only')
  strictEqual((await call(null, 'GET', '/changes?since=0')).code, 401, 'no authenticated user is a 401')
})

// ---- arm 9 ------------------------------------------------------------------
await check('an oversized note is refused with 413 and is not stored', async () => {
  fresh()
  const big = Buffer.alloc(_internals.MAX_BYTES + 2048, 0x61)
  const w = await put(A, 'big.md', big)
  strictEqual(w.code, 413)
  ok(w.destroyed, 'the socket must be torn down, not drained')
  strictEqual((await changes(A, 0)).body.files.length, 0, 'a refused note must not be in the revision log')
  strictEqual((await changes(A, 0)).body.rev, 0, 'and must not have burned a revision')
})

// ---- arm 10 -----------------------------------------------------------------
await check('every path-taking route rejects a bad path with 400', async () => {
  fresh()
  const bad = ['../etc/passwd', '/abs.md', 'a/../../b.md', 'a//b.md', '', 'a/./b.md', 'x'.repeat(1100)]
  for (const p of bad) {
    strictEqual((await call(A, 'GET', `/file?path=${encodeURIComponent(p)}`)).code, 400, `GET /file took ${JSON.stringify(p)}`)
    strictEqual((await put(A, p, 'x')).code, 400, `PUT /file took ${JSON.stringify(p)}`)
    for (const route of ['/delete', '/restore', '/purge'])
      strictEqual((await call(A, 'POST', route, JSON.stringify({ path: p }))).code, 400, `${route} took ${JSON.stringify(p)}`)
  }
  strictEqual((await call(A, 'POST', '/delete', 'not json')).code, 400)
  strictEqual((await call(A, 'GET', '/nope')).code, 404)
  strictEqual((await changes(A, 0)).body.rev, 0, 'no rejected request may burn a revision')
})

// ---- arm 11 -----------------------------------------------------------------
await check('every accepted mutation takes a fresh, strictly increasing rev', async () => {
  fresh()
  const revs = []
  revs.push((await put(A, 'a.md', '1')).body.rev)
  revs.push((await put(A, 'a.md', '2')).body.rev)
  revs.push((await put(A, 'b.md', '3')).body.rev)
  revs.push((await call(A, 'POST', '/delete', JSON.stringify({ path: 'a.md' }))).body.rev)
  revs.push((await call(A, 'POST', '/restore', JSON.stringify({ path: 'a.md' }))).body.rev)
  deepStrictEqual(revs, [1, 2, 3, 4, 5])
  // an overwrite must MOVE the row's rev forward, not leave a stale one behind:
  // a device on since=4 must still be told a.md changed.
  deepStrictEqual((await changes(A, 4)).body.files.map((f) => f.path), ['a.md'])
})

console.log(failures ? `\nnotes-sync.check: ${failures} FAILED` : '\nnotes-sync.check: all good')
process.exit(failures ? 1 : 0)
