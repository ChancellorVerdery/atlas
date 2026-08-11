// Session-token lookup, shared by anything that has to authenticate a request
// without going through the inbox. Same query the inbox already runs.
import { pool } from './db.js'

// token -> { userId, email } or null. Expiry is enforced in SQL so a clock skew
// on the caller cannot extend a session.
export async function userForToken(token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 200) return null
  const r = await pool.query(
    `SELECT u.id AS user_id, u.email
       FROM auth.sessions s
       JOIN auth.users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  )
  return r.rows.length ? { userId: r.rows[0].user_id, email: r.rows[0].email } : null
}
