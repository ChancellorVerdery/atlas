// Synced notes folder — the server half.
//
// The model is a per-user revision log, not a file tree: every write bumps a
// monotonic counter and stamps the row, so a device syncs by asking "what
// changed since rev N". That is the only shape that survives a device being
// offline for a week, because it never has to diff whole trees to find out.
//
// A delete is a TOMBSTONE, not a row removal. Three things depend on that:
//   - a device that missed the delete learns about it (an absent row is
//     indistinguishable from a file it has never seen, and it would helpfully
//     re-upload the thing the user just deleted);
//   - the content is still there for the 30-day archive;
//   - restoring is a flag flip that propagates like any other change.
// After ARCHIVE_DAYS the row is really gone (see gc()).
//
// Text only, deliberately: both device ends write files through JSON/UTF-8
// routes today (iOS `/icloud/notes/save` takes a Swift String), so binary
// attachments under 'note uploads/' are NOT synced yet. Upgrade path is a
// bytea column plus raw-body PUT on both shells.
import { pool, tx } from '../../lib/db.js'
import crypto from 'node:crypto'

const ARCHIVE_DAYS = 30
const MAX_BYTES = 4 * 1024 * 1024 // per note; a markdown vault is nowhere near this
const MAX_BODY = MAX_BYTES + 1024

export const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

// Relative, forward-slashed, no traversal. Rejecting rather than sanitizing is
// deliberate: a silently rewritten path would sync to a different file than the
// caller believes it wrote, and the two devices would then fight over it.
export function cleanPath(p) {
  const s = String(p == null ? '' : p).replace(/\\/g, '/')
  if (!s || s.length > 1024 || s.includes('\0')) return null
  if (s.startsWith('/')) return null
  const segs = s.split('/')
  if (segs.some((seg) => seg === '' || seg === '.' || seg === '..')) return null
  return s
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > MAX_BODY) { reject(Object.assign(new Error('note too large'), { code: 413 })); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Opportunistic, and that is the whole design: it runs on the calls every
// client already makes, so there is no cron to own. ponytail: a user who never
// syncs never expires their own archive — harmless, it is their own data.
async function gc(userId) {
  await pool.query(
    `DELETE FROM notes_sync.files
      WHERE user_id = $1 AND deleted_at IS NOT NULL
        AND deleted_at < now() - ($2 || ' days')::interval`,
    [userId, String(ARCHIVE_DAYS)],
  )
}

// Allocate the next revision INSIDE the caller's transaction, so the cursor row
// lock serializes concurrent writers and the stamped row can never be visible
// with a rev the cursor has not reached.
async function nextRev(c, userId) {
  const r = await c.query(
    `INSERT INTO notes_sync.cursor (user_id, rev) VALUES ($1, 1)
       ON CONFLICT (user_id) DO UPDATE SET rev = notes_sync.cursor.rev + 1
     RETURNING rev`,
    [userId],
  )
  return Number(r.rows[0].rev)
}

const currentRev = async (userId) => {
  const r = await pool.query('SELECT rev FROM notes_sync.cursor WHERE user_id = $1', [userId])
  return r.rows.length ? Number(r.rows[0].rev) : 0
}

export async function notesSync(req, res) {
  const userId = req.atlasUser?.userId
  if (!userId) return json(res, 401, { error: 'no user' })
  const u = new URL(req.url || '/', 'http://x')
  const p = u.pathname

  // ---- delta pull ----------------------------------------------------------
  if (p === '/changes' && req.method === 'GET') {
    await gc(userId)
    const since = Math.max(0, Number(u.searchParams.get('since') || 0) || 0)
    const r = await pool.query(
      `SELECT path, sha256, size, mtime, rev, (deleted_at IS NOT NULL) AS deleted
         FROM notes_sync.files
        WHERE user_id = $1 AND rev > $2
        ORDER BY rev`,
      [userId, since],
    )
    return json(res, 200, {
      rev: await currentRev(userId),
      files: r.rows.map((x) => ({
        path: x.path, sha256: x.sha256, size: Number(x.size), mtime: Number(x.mtime),
        rev: Number(x.rev), deleted: x.deleted,
      })),
    })
  }

  // ---- one file's content --------------------------------------------------
  if (p === '/file' && req.method === 'GET') {
    const path_ = cleanPath(u.searchParams.get('path'))
    if (!path_) return json(res, 400, { error: 'bad path' })
    // Archived content is readable on purpose — that is what the 30-day
    // archive view previews and what restore re-uploads to the devices.
    const archived = u.searchParams.get('archived') === '1'
    const r = await pool.query(
      `SELECT content, sha256, mtime FROM notes_sync.files
        WHERE user_id = $1 AND path = $2 ${archived ? '' : 'AND deleted_at IS NULL'}`,
      [userId, path_],
    )
    if (!r.rows.length) return json(res, 404, { error: 'not found' })
    return json(res, 200, { path: path_, content: r.rows[0].content, sha256: r.rows[0].sha256, mtime: Number(r.rows[0].mtime) })
  }

  // ---- upload / overwrite --------------------------------------------------
  if (p === '/file' && (req.method === 'PUT' || req.method === 'POST')) {
    const path_ = cleanPath(u.searchParams.get('path'))
    if (!path_) return json(res, 400, { error: 'bad path' })
    let content
    try { content = await readBody(req) } catch (e) { return json(res, e.code === 413 ? 413 : 400, { error: e.message }) }
    if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) return json(res, 413, { error: 'note too large' })
    const mtime = Number(u.searchParams.get('mtime')) || Date.now()
    const hash = sha256(content)
    const out = await tx(async (c) => {
      // An upload to a tombstoned path RESURRECTS it (deleted_at cleared): the
      // user recreating a note they deleted must win over the tombstone, or the
      // next pass would dutifully delete their new file.
      const rev = await nextRev(c, userId)
      const r = await c.query(
        `INSERT INTO notes_sync.files (user_id, path, content, sha256, size, mtime, rev, deleted_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, NULL)
         ON CONFLICT (user_id, path) DO UPDATE
            SET content = EXCLUDED.content, sha256 = EXCLUDED.sha256, size = EXCLUDED.size,
                mtime = EXCLUDED.mtime, rev = EXCLUDED.rev, deleted_at = NULL
          RETURNING rev`,
        [userId, path_, content, hash, Buffer.byteLength(content, 'utf8'), mtime, rev],
      )
      return Number(r.rows[0].rev)
    })
    return json(res, 200, { path: path_, sha256: hash, rev: out })
  }

  // ---- delete (tombstone) --------------------------------------------------
  if (p === '/delete' && req.method === 'POST') {
    let body
    try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
    const path_ = cleanPath(body.path)
    if (!path_) return json(res, 400, { error: 'bad path' })
    const out = await tx(async (c) => {
      const rev = await nextRev(c, userId)
      const r = await c.query(
        `UPDATE notes_sync.files SET deleted_at = now(), rev = $3
          WHERE user_id = $1 AND path = $2 AND deleted_at IS NULL
        RETURNING rev`,
        [userId, path_, rev],
      )
      return r.rows.length ? Number(r.rows[0].rev) : null
    })
    // Already gone is success: two devices deleting the same note must both
    // finish cleanly rather than one of them erroring forever.
    return json(res, 200, { path: path_, rev: out, alreadyDeleted: out === null })
  }

  // ---- the 30-day archive --------------------------------------------------
  if (p === '/archive' && req.method === 'GET') {
    await gc(userId)
    const r = await pool.query(
      `SELECT path, size, mtime, sha256, deleted_at,
              deleted_at + ($2 || ' days')::interval AS expires_at
         FROM notes_sync.files
        WHERE user_id = $1 AND deleted_at IS NOT NULL
        ORDER BY deleted_at DESC`,
      [userId, String(ARCHIVE_DAYS)],
    )
    return json(res, 200, {
      days: ARCHIVE_DAYS,
      files: r.rows.map((x) => ({
        path: x.path, size: Number(x.size), mtime: Number(x.mtime), sha256: x.sha256,
        deletedAt: new Date(x.deleted_at).getTime(),
        expiresAt: new Date(x.expires_at).getTime(),
      })),
    })
  }

  if (p === '/restore' && req.method === 'POST') {
    let body
    try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
    const path_ = cleanPath(body.path)
    if (!path_) return json(res, 400, { error: 'bad path' })
    const out = await tx(async (c) => {
      const rev = await nextRev(c, userId)
      const r = await c.query(
        `UPDATE notes_sync.files SET deleted_at = NULL, rev = $3
          WHERE user_id = $1 AND path = $2 AND deleted_at IS NOT NULL
        RETURNING rev`,
        [userId, path_, rev],
      )
      return r.rows.length ? Number(r.rows[0].rev) : null
    })
    if (out === null) return json(res, 404, { error: 'not in the archive' })
    return json(res, 200, { path: path_, rev: out })
  }

  // Explicit "delete forever", so the user never has to wait out the 30 days.
  if (p === '/purge' && req.method === 'POST') {
    let body
    try { body = JSON.parse(await readBody(req) || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
    const path_ = cleanPath(body.path)
    if (!path_) return json(res, 400, { error: 'bad path' })
    await pool.query(
      'DELETE FROM notes_sync.files WHERE user_id = $1 AND path = $2 AND deleted_at IS NOT NULL',
      [userId, path_],
    )
    return json(res, 200, { path: path_, purged: true })
  }

  return json(res, 404, { error: 'unknown notes-sync route' })
}

export const _internals = { ARCHIVE_DAYS, MAX_BYTES }
