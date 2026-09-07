// Atlas auth service. Owns the `auth` schema: auth.users (every plugin FK
// references it) and auth.sessions. Unlike plugin services, replies go back synchronously as the
// HTTP response body — the inbox relays them to the client socket directly,
// so the outbox is never involved.

import crypto from 'node:crypto'
import path from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import bcrypt from 'bcryptjs'
import { applyDdl, serveHttp } from '../lib/runner.js'
import { pool } from '../lib/db.js'
import { normalizeEmail } from '../lib/email.js'

const DDL = `
  CREATE SCHEMA IF NOT EXISTS auth;

  CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS auth.sessions (
    token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
`

const SESSION_DAYS = 30

async function mintSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  await pool.query(
    `INSERT INTO auth.sessions (token, user_id, expires_at)
     VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [token, userId],
  )
  return token
}

export async function signup(payload) {
  // Store the case-folded address. login() has always matched on lower(email),
  // so storing the raw casing meant 'A@x.com' and 'a@x.com' were two distinct
  // rows under the UNIQUE(email) constraint but ONE match at login — see the
  // note on login() below.
  const email = normalizeEmail(payload && payload.email)
  const password = String((payload && payload.password) || '')
  if (!email || !email.includes('@')) return { ok: false, error: 'Enter a valid email address' }
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters' }
  // UNIQUE(email) only catches an exact-text collision, so it cannot see a
  // legacy mixed-case row written before this normalization existed. Check
  // case-insensitively too, or such a row would still admit a duplicate.
  const dup = await pool.query('SELECT 1 FROM auth.users WHERE lower(email) = $1 LIMIT 1', [email])
  if (dup.rows.length) return { ok: false, error: 'That email is already registered' }
  const hash = bcrypt.hashSync(password, 10)
  let row
  try {
    const r = await pool.query(
      'INSERT INTO auth.users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hash],
    )
    row = r.rows[0]
  } catch (e) {
    if (e.code === '23505') return { ok: false, error: 'That email is already registered' }
    throw e
  }
  const token = await mintSession(row.id)
  return { ok: true, data: { userId: row.id, email: row.email, token } }
}

export async function login(payload) {
  // Opportunistic cleanup of expired sessions.
  await pool.query('DELETE FROM auth.sessions WHERE expires_at < now()')
  const email = normalizeEmail(payload && payload.email)
  const password = String((payload && payload.password) || '')
  // ORDER BY is not cosmetic: a duplicate pair created before signup()
  // normalized (e.g. 'A@x.com' + 'a@x.com') makes this query return two rows,
  // and an unordered SELECT picks between them by physical row order — which
  // changes under UPDATE/VACUUM. That is a user who can sign in one day and
  // gets 'Invalid email or password' the next, with a correct password.
  // Oldest account wins, deterministically.
  const r = await pool.query(
    `SELECT id, email, password_hash FROM auth.users
      WHERE lower(email) = $1 ORDER BY created_at, id`,
    [email],
  )
  const row = r.rows[0]
  if (!row || !bcrypt.compareSync(password, row.password_hash))
    return { ok: false, error: 'Invalid email or password' }
  const token = await mintSession(row.id)
  return { ok: true, data: { userId: row.id, email: row.email, token } }
}

export async function logout(token) {
  if (token) await pool.query('DELETE FROM auth.sessions WHERE token = $1', [token])
  return { ok: true, data: {} }
}

export async function whoami(token) {
  if (!token) return { ok: false, error: 'Not signed in' }
  const r = await pool.query(
    `SELECT u.id, u.email FROM auth.sessions s
     JOIN auth.users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  )
  const row = r.rows[0]
  if (!row) return { ok: false, error: 'Not signed in' }
  return { ok: true, data: { userId: row.id, email: row.email } }
}

// Request dispatch, exported so it can be exercised without a server or a
// Postgres. Every branch below is reachable from one call with a `code`.
export async function handle({ reqId, code, payload, token }) {
  try {
    let reply
    if (code === 'auth.signup') reply = await signup(payload)
    else if (code === 'auth.login') reply = await login(payload)
    else if (code === 'auth.logout') reply = await logout(token)
    else if (code === 'auth.whoami') reply = await whoami(token)
    else reply = { ok: false, error: 'unhandled code' }
    return { reqId, ...reply }
  } catch (e) {
    console.error(`auth ${code}:`, e)
    return { reqId, ok: false, error: String((e && e.message) || e) }
  }
}

// Bootstrap only when run as the entrypoint (`node services/auth.js`, per
// docker-compose). applyDdl() opens a real connection and retries for two
// minutes before process.exit(1), so at module top level it made this file
// unimportable anywhere without a Postgres — which is why auth could only ever
// be tested by reading its source. Importing it now runs no I/O: lib/db.js's
// pg.Pool is lazy and connects on first query.
// realpathSync, not just resolve: Node resolves symlinks when it builds
// import.meta.url, so on a symlinked WORKDIR a bare path.resolve() of argv[1]
// would not match and this service would start nothing while exiting 0 —
// a silent outage, the worst failure mode an entrypoint guard can have.
const entrypoint = (() => {
  try { return pathToFileURL(realpathSync(path.resolve(process.argv[1] || '.'))).href }
  catch { return pathToFileURL(path.resolve(process.argv[1] || '.')).href }
})()
if (import.meta.url === entrypoint) {
  await applyDdl(DDL)
  serveHttp({ '/handle': handle })
  console.log('auth service up')
}
