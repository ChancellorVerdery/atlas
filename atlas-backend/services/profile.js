// Atlas profile service.
//
// Owns the data that is *about* the app rather than any one plugin:
//   - page-board layouts (the per-page widget grids, stored as jsonb)
//   - misc user flags (theme, tab order, ... — opaque strings)
// and the two cross-service sync operations:
//   - sync.pull.all  — gather every board, flag, and plugin state in one map
//   - sync.import    — replace-not-merge restore of a full app backup
//
// Same conventions as lib/runner.js runPlugin(): inbox-routed requests hit
// POST /handle, every result (success or error) flows back through the outbox.

import { applyDdl, serveHttp, deliver } from '../lib/runner.js'
import { pool, tx } from '../lib/db.js'

const DDL = `
CREATE TABLE IF NOT EXISTS page_boards (
  user_id     uuid  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  storage_key text  NOT NULL,
  board       jsonb NOT NULL,
  PRIMARY KEY (user_id, storage_key)
);
CREATE TABLE IF NOT EXISTS user_flags (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  flag    text NOT NULL,
  value   text NOT NULL,
  PRIMARY KEY (user_id, flag)
);
`

// Page-board layout keys — jsonb documents, everything else is a flag.
const BOARD_KEYS = [
  'atlas.page.v1',
  'atlas.page.gym.v1',
  'atlas.page.canvas.v1',
  'atlas.page.work.v1',
  'atlas.page.finance.v1',
  'atlas.page.sleep.v1',
  'atlas.page.equations.v1',
]

// storageKey -> docker-compose service name that owns it.
const PLUGINS = {
  'atlas.gym.v1': 'atlas-gym',
  'atlas.course.v1': 'atlas-course',
  'atlas.finance.v1': 'atlas-finance',
  'atlas.calendar.v1': 'atlas-calendar',
  'atlas.canvas.v1': 'atlas-canvas',
  'atlas.email.v1': 'atlas-email',
  'atlas.graph.v1': 'atlas-graph',
  'atlas.ladder.v1': 'atlas-ladder',
  'atlas.sleep.v1': 'atlas-sleep',
  'atlas.work.v1': 'atlas-work',
}

// Never persisted server-side: credentials, the backend endpoint itself, and
// the per-device dev-mode toggle. Must match the client's NEVER_PUSH/SKIP_KEYS
// (sync.js / main.js) so a foreign backup can't smuggle one in and have
// pull.all fan it out to every device.
const NEVER_STORE = new Set(['atlas.auth.v1', 'atlas.backend', 'atlas.devMode'])

async function postSvc(svc, path, body) {
  const res = await fetch(`http://${svc}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`${svc}${path} -> HTTP ${res.status}`)
  return res.json()
}

async function pageGet(userId, storageKey) {
  if (BOARD_KEYS.includes(storageKey)) {
    const r = await pool.query(
      'SELECT board FROM page_boards WHERE user_id = $1 AND storage_key = $2',
      [userId, storageKey],
    )
    return r.rows.length ? r.rows[0].board : null
  }
  const r = await pool.query(
    'SELECT value FROM user_flags WHERE user_id = $1 AND flag = $2',
    [userId, storageKey],
  )
  return r.rows.length ? r.rows[0].value : null
}

// Returns the value as stored, so sync.update fans out exactly what other
// sessions would read back.
async function pageSave(userId, storageKey, value) {
  if (BOARD_KEYS.includes(storageKey)) {
    if (!value || typeof value !== 'object') throw new Error('board value must be an object')
    await pool.query(
      `INSERT INTO page_boards (user_id, storage_key, board) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, storage_key) DO UPDATE SET board = EXCLUDED.board`,
      [userId, storageKey, JSON.stringify(value)],
    )
    return value
  }
  if (!storageKey || !storageKey.startsWith('atlas.'))
    throw new Error(`refusing to store non-atlas key ${storageKey}`)
  // Flags are opaque strings on the wire (sync.js only parses plugin/board
  // keys), but guard against a structured value from an older or foreign
  // client: String({}) would persist '[object Object]' and destroy the data
  // on every device at the next pull.
  const str = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value)
  await pool.query(
    `INSERT INTO user_flags (user_id, flag, value) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, flag) DO UPDATE SET value = EXCLUDED.value`,
    [userId, storageKey, str],
  )
  return str
}

// One map of everything the user has server-side: boards, flags, and each
// plugin's recomposed state. Unreachable plugins become null + a warning so a
// partial backend never blocks a pull.
async function pullAll(userId) {
  const states = {}
  const warnings = []
  const boards = await pool.query(
    'SELECT storage_key, board FROM page_boards WHERE user_id = $1',
    [userId],
  )
  for (const row of boards.rows) states[row.storage_key] = row.board
  const flags = await pool.query(
    'SELECT flag, value FROM user_flags WHERE user_id = $1',
    [userId],
  )
  for (const row of flags.rows) states[row.flag] = row.value
  await Promise.all(
    Object.entries(PLUGINS).map(async ([key, svc]) => {
      try {
        const out = await postSvc(svc, '/state', { userId })
        states[key] = out.value
      } catch (e) {
        states[key] = null
        warnings.push(`${key}: ${String((e && e.message) || e)}`)
      }
    }),
  )
  return { states, warnings }
}

// Replace-not-merge: the backup becomes the complete server-side truth.
// data maps storageKey -> raw string (JSON blob from the app's backup format)
// or already-parsed object; flags are plain strings.
async function importAll(userId, data) {
  if (!data || typeof data !== 'object') throw new Error('data must be an object')
  const warnings = []
  let imported = 0

  const parse = (key, v) => {
    if (typeof v !== 'string') return v
    try {
      return JSON.parse(v)
    } catch {
      warnings.push(`${key}: unparseable JSON, skipped`)
      return undefined
    }
  }

  // Plugins: present keys overwrite, absent keys are cleared.
  for (const [key, svc] of Object.entries(PLUGINS)) {
    try {
      if (key in data) {
        const value = parse(key, data[key])
        if (value === undefined) {
          // Present but unparseable: replace semantics still demand the stale
          // server state go away — clear it, keeping parse()'s warning.
          await postSvc(svc, '/state/clear', { userId })
          continue
        }
        await postSvc(svc, '/state/save', { userId, value })
        imported++
      } else {
        await postSvc(svc, '/state/clear', { userId })
      }
    } catch (e) {
      warnings.push(`${key}: ${String((e && e.message) || e)}`)
    }
  }

  // Boards and flags in one transaction: wipe, then re-insert what's present.
  await tx(async c => {
    await c.query('DELETE FROM page_boards WHERE user_id = $1', [userId])
    for (const key of BOARD_KEYS) {
      if (!(key in data)) continue
      const board = parse(key, data[key])
      if (board === undefined) continue
      if (!board || typeof board !== 'object') {
        warnings.push(`${key}: board is not an object, skipped`)
        continue
      }
      await c.query(
        'INSERT INTO page_boards (user_id, storage_key, board) VALUES ($1, $2, $3)',
        [userId, key, JSON.stringify(board)],
      )
      imported++
    }
    await c.query('DELETE FROM user_flags WHERE user_id = $1', [userId])
    // Catch-all for every other atlas.* key so nothing in a backup is lost.
    for (const [key, v] of Object.entries(data)) {
      if (!key.startsWith('atlas.')) continue
      if (BOARD_KEYS.includes(key) || key in PLUGINS || NEVER_STORE.has(key)) continue
      await c.query(
        'INSERT INTO user_flags (user_id, flag, value) VALUES ($1, $2, $3)',
        [userId, key, typeof v === 'string' ? v : JSON.stringify(v)],
      )
      imported++
    }
  })

  return { imported, warnings }
}

await applyDdl(DDL)

serveHttp({
  '/handle': async ({ userId, sessionId, reqId, code, payload }) => {
    try {
      if (code === 'page.get') {
        const { storageKey } = payload || {}
        const value = await pageGet(userId, storageKey)
        await deliver({ userId, sessionId, reqId, ok: true, data: { key: storageKey, value } })
      } else if (code === 'page.save') {
        const { storageKey, value } = payload || {}
        const stored = await pageSave(userId, storageKey, value)
        await deliver({ userId, sessionId, reqId, ok: true, data: { saved: storageKey } })
        await deliver({
          type: 'sync.update',
          userId,
          excludeSession: sessionId,
          data: { key: storageKey, value: stored },
        })
      } else if (code === 'sync.pull.all') {
        const data = await pullAll(userId)
        await deliver({ userId, sessionId, reqId, ok: true, data })
      } else if (code === 'sync.import') {
        const data = await importAll(userId, payload && payload.data)
        await deliver({ userId, sessionId, reqId, ok: true, data })
      } else {
        throw new Error('unhandled code')
      }
    } catch (e) {
      console.error(`profile ${code}:`, e)
      await deliver({ userId, sessionId, reqId, ok: false, error: String((e && e.message) || e) })
    }
    return {}
  },
})

console.log('profile service up')
