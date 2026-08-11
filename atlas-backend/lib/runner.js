// Generic runtime shared by every Atlas plugin service.
//
// A plugin service is a pure "mapper" module:
//   export default {
//     name: 'gym',                      // code prefix ('gym.get' / 'gym.save')
//     schema: 'gym',                    // Postgres schema owning its tables
//     storageKey: 'atlas.gym.v1',       // the localStorage key it mirrors
//     ddl: 'CREATE SCHEMA ... CREATE TABLE ...',  // its own tables, idempotent
//     tables: ['settings', ...],        // parents before children (FK order)
//     decompose(state) -> { table: [row, ...] },   // row keys = column names
//     recompose({ table: [row, ...] }) -> state,   // exact localStorage shape
//   }
// Every plugin owns a Postgres SCHEMA named after it, so a table's full
// identity is `<schema>.<table>` — gym.workouts, finance.networth_history.
// `tables` holds the bare names (which are also the decompose/recompose row-map
// keys); qualify() is the single place they become SQL.
// The runner owns HTTP, transactions, row ordering, and outbox delivery, so
// mappers stay pure and testable without a database.
//
// Every table must have user_id and an `ord integer NOT NULL DEFAULT 0`
// column; the runner stamps ord with the row's array index on insert and
// selects ORDER BY ord, so array order survives normalization.

import http from 'node:http'
import { pool, tx } from './db.js'

const OUTBOX = process.env.OUTBOX_URL || 'http://atlas-outbox/deliver'

// Bare table name -> schema-qualified SQL identity. Both halves come from the
// mapper (never from a request), so this is not an injection surface.
const qualify = (mapper, t) => `${mapper.schema}.${t}`

export async function deliver(msg) {
  try {
    await fetch(OUTBOX, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(msg),
    })
  } catch (e) {
    console.error('outbox unreachable:', e.message)
  }
}

// Retry until Postgres is up and auth.users (owned by the auth service,
// referenced by every plugin FK) exists. Only plausibly-transient errors are
// retried: connection failures, undefined_table (42P01) and invalid_schema_name
// (3F000) — a plugin whose DDL runs before the auth service has created its
// schema hits the latter. Permanent DDL problems (syntax errors, schema drift —
// SQLSTATE class 42 other than 42P01) exit immediately so a bad DDL is visible
// to the orchestrator instead of hiding behind an infinite retry loop;
// everything else is retried but capped at ~2 minutes before exiting.
const DDL_MAX_ATTEMPTS = 40
const DDL_RETRY_MS = 3000

export async function applyDdl(ddl) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(ddl)
      return
    } catch (e) {
      const code = e && e.code
      // Class 42 = syntax_error_or_access_rule_violation: a broken DDL or
      // schema drift never fixes itself. 42P01 is the one exception — the
      // users table simply hasn't been created by the auth service yet.
      if (typeof code === 'string' && code.startsWith('42') && code !== '42P01') {
        console.error(`ddl failed permanently (${code}):`, e.message)
        process.exit(1)
      }
      if (attempt >= DDL_MAX_ATTEMPTS) {
        console.error(`ddl failed after ${attempt} attempts:`, e.message)
        process.exit(1)
      }
      console.error('ddl retry:', e.message)
      await new Promise(r => setTimeout(r, DDL_RETRY_MS))
    }
  }
}

export function serveHttp(routes, port = 80) {
  http
    .createServer((req, res) => {
      let body = ''
      req.on('data', c => (body += c))
      req.on('end', async () => {
        try {
          const handler = routes[req.url]
          if (req.method !== 'POST' || !handler) {
            res.writeHead(404).end()
            return
          }
          const out = await handler(JSON.parse(body || '{}'))
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(out ?? {}))
        } catch (e) {
          console.error(e)
          res
            .writeHead(500, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: String((e && e.message) || e) }))
        }
      })
    })
    .listen(port)
}

export async function load(mapper, userId) {
  // All SELECTs run in one transaction so a store() committing mid-read can't
  // produce a mixed-generation snapshot (old settings + new child rows).
  const { rows, total } = await tx(async c => {
    // Plain BEGIN is READ COMMITTED (per-statement snapshots); REPEATABLE
    // READ pins one snapshot for every SELECT below. Read-only, so it can
    // never hit a serialization failure.
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    const rows = {}
    let total = 0
    for (const t of mapper.tables) {
      const r = await c.query(
        `SELECT * FROM ${qualify(mapper, t)} WHERE user_id = $1 ORDER BY ord, ctid`,
        [userId],
      )
      rows[t] = r.rows
      total += r.rows.length
    }
    return { rows, total }
  })
  // No rows at all = user has never saved this plugin; null tells the client
  // to keep whatever it has locally instead of clobbering it with defaults.
  return total === 0 ? null : mapper.recompose(rows)
}

export async function store(mapper, userId, value) {
  if (!value || typeof value !== 'object') throw new Error('value must be an object')
  const byTable = mapper.decompose(value)
  await tx(async c => {
    for (const t of [...mapper.tables].reverse())
      await c.query(`DELETE FROM ${qualify(mapper, t)} WHERE user_id = $1`, [userId])
    for (const t of mapper.tables) {
      const rows = byTable[t] || []
      for (let i = 0; i < rows.length; i++) {
        const row = { ...rows[i], user_id: userId, ord: i }
        const cols = Object.keys(row)
        await c.query(
          `INSERT INTO ${qualify(mapper, t)} (${cols.join(',')}) VALUES (${cols.map((_, j) => `$${j + 1}`).join(',')})`,
          cols.map(k => (row[k] === undefined ? null : row[k])),
        )
      }
    }
  })
}

export async function runPlugin(mapper) {
  await applyDdl(mapper.ddl)
  serveHttp({
    // Inbox-routed user requests; results flow to the client via the outbox.
    '/handle': async ({ userId, sessionId, reqId, code, payload }) => {
      try {
        if (code === `${mapper.name}.get`) {
          const state = await load(mapper, userId)
          await deliver({ userId, sessionId, reqId, ok: true, data: { key: mapper.storageKey, value: state } })
        } else if (code === `${mapper.name}.save`) {
          await store(mapper, userId, payload && payload.value)
          await deliver({ userId, sessionId, reqId, ok: true, data: { saved: mapper.storageKey } })
          await deliver({
            type: 'sync.update',
            userId,
            excludeSession: sessionId,
            data: { key: mapper.storageKey, value: payload.value },
          })
        } else {
          throw new Error(`unhandled code ${code}`)
        }
      } catch (e) {
        console.error(`${mapper.name} ${code}:`, e)
        await deliver({ userId, sessionId, reqId, ok: false, error: String((e && e.message) || e) })
      }
      return {}
    },
    // Internal service-to-service state access (profile's pull.all / import).
    '/state': async ({ userId }) => ({ key: mapper.storageKey, value: await load(mapper, userId) }),
    '/state/save': async ({ userId, value }) => {
      await store(mapper, userId, value)
      return {}
    },
    // Import is replace-not-merge: keys absent from a backup get cleared.
    '/state/clear': async ({ userId }) => {
      await tx(async c => {
        for (const t of [...mapper.tables].reverse())
          await c.query(`DELETE FROM ${qualify(mapper, t)} WHERE user_id = $1`, [userId])
      })
      return {}
    },
  })
  console.log(`${mapper.name} service up`)
}
