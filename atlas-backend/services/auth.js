// Atlas auth service. Owns the users table (every plugin FK references it)
// and sessions. Unlike plugin services, replies go back synchronously as the
// HTTP response body — the inbox relays them to the client socket directly,
// so the outbox is never involved.

import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import { applyDdl, serveHttp } from '../lib/runner.js'
import { pool } from '../lib/db.js'

const DDL = `
  CREATE TABLE IF NOT EXISTS users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text UNIQUE NOT NULL,
    password_hash text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
`

const SESSION_DAYS = 30

async function mintSession(userId) {
  const token = crypto.randomBytes(32).toString('hex')
  await pool.query(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [token, userId],
  )
  return token
}

async function signup(payload) {
  const email = String((payload && payload.email) || '').trim()
  const password = String((payload && payload.password) || '')
  if (!email || !email.includes('@')) return { ok: false, error: 'Enter a valid email address' }
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters' }
  const hash = bcrypt.hashSync(password, 10)
  let row
  try {
    const r = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
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

async function login(payload) {
  // Opportunistic cleanup of expired sessions.
  await pool.query('DELETE FROM sessions WHERE expires_at < now()')
  const email = String((payload && payload.email) || '').trim()
  const password = String((payload && payload.password) || '')
  const r = await pool.query(
    'SELECT id, email, password_hash FROM users WHERE lower(email) = lower($1)',
    [email],
  )
  const row = r.rows[0]
  if (!row || !bcrypt.compareSync(password, row.password_hash))
    return { ok: false, error: 'Invalid email or password' }
  const token = await mintSession(row.id)
  return { ok: true, data: { userId: row.id, email: row.email, token } }
}

async function logout(token) {
  if (token) await pool.query('DELETE FROM sessions WHERE token = $1', [token])
  return { ok: true, data: {} }
}

async function whoami(token) {
  if (!token) return { ok: false, error: 'Not signed in' }
  const r = await pool.query(
    `SELECT u.id, u.email FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  )
  const row = r.rows[0]
  if (!row) return { ok: false, error: 'Not signed in' }
  return { ok: true, data: { userId: row.id, email: row.email } }
}

await applyDdl(DDL)

serveHttp({
  '/handle': async ({ reqId, code, payload, token }) => {
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
  },
})

console.log('auth service up')
