import pg from 'pg'

// Return dates/numerics as plain JS values so recompose() round-trips the
// exact shapes the frontend stored ('YYYY-MM-DD' strings, numbers).
pg.types.setTypeParser(1082, v => v)                                  // date
pg.types.setTypeParser(1700, v => (v === null ? null : Number(v)))   // numeric
pg.types.setTypeParser(20, v => (v === null ? null : Number(v)))     // int8

// The password is bind-mounted as a raw file: compose interpolates ${...} (and
// mangles $) in both the yml and env_file values, so no parser may touch it.
// Host/user/database still come from plain PGHOST/PGUSER/PGDATABASE env vars.
import { readFileSync } from 'node:fs'
let password
try { password = readFileSync(process.env.PGPASS_FILE || '/run/pgpass', 'utf8').replace(/\r?\n+$/, '') } catch {}
export const pool = new pg.Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : password !== undefined ? { password } : {},
)

// pg emits 'error' on the pool for idle clients (e.g. Postgres restarts);
// without a listener that is a fatal uncaught exception for the process.
pool.on('error', e => console.error('idle client error:', e.message))

export async function tx(fn) {
  const c = await pool.connect()
  try {
    await c.query('BEGIN')
    const r = await fn(c)
    await c.query('COMMIT')
    return r
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    c.release()
  }
}
