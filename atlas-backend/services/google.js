// Atlas Google service — owns the OAuth secret and every user's tokens.
//
// The client secret and refresh token NEVER reach the browser. The frontend
// runs Google Identity Services with only the (non-secret) client id to obtain
// an auth CODE, hands the code here, and this service exchanges it for tokens
// using the secret, stores them, and proxies every Gmail/Calendar call so the
// access token also stays server-side.
//
// MULTIPLE ACCOUNTS: a user can connect several Google addresses. Each is one
// row in google_tokens, keyed by (user_id, address); the earliest-added is the
// "primary" used when a call doesn't name an account. Every google.api call
// carries `account` (the address) so it routes to the right token.
//
// Codes (all reply via the outbox, like a plugin service):
//   google.config           -> { clientId, scopes, configured }   (for GIS init)
//   google.auth.exchange    { code } -> { connected, address, accounts }
//   google.auth.status      -> { connected, address, accounts }
//   google.auth.disconnect  { account? } -> { connected, accounts }   (account omitted = all)
//   google.api  { method, url, body, account? } -> the Google JSON (or null on 204)
//
// google.api errors are delivered as ok:false with a KIND-prefixed message the
// client maps to its AuthError: 'auth: …' (reconnect) / 'scope: …' (re-consent).

import { applyDdl, serveHttp, deliver } from '../lib/runner.js'
import { pool } from '../lib/db.js'
import { fetchRetry } from '../lib/http.js'

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || ''
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || ''
const SCOPES = process.env.GOOGLE_SCOPES ||
  // gmail.settings.basic lets us create per-sender filters (auto-file rules).
  'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/calendar'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke'
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
const configured = !!(CLIENT_ID && CLIENT_SECRET)

// Fresh installs create the composite-key table directly. Existing single-
// account installs (user_id PRIMARY KEY) are migrated in place: drop any
// address-less rows (an unusable connection → clean reconnect), then swap the
// primary key to (user_id, address). The DO block is idempotent — it only acts
// while the pkey is still single-column.
const ddl = `
CREATE SCHEMA IF NOT EXISTS google;

CREATE TABLE IF NOT EXISTS google.tokens (
  user_id       uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  address       text,          -- connected Gmail address (part of the key)
  access_token  text,          -- ponytail: plaintext at rest, encrypt with pgcrypto when this leaves the tunnel
  refresh_token text,          -- ponytail: plaintext at rest, encrypt with pgcrypto when this leaves the tunnel
  expires_at    bigint,        -- ms epoch
  added_at      bigint,        -- ms epoch the account was connected (primary = earliest)
  scope         text,
  PRIMARY KEY (user_id, address)
);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'google.tokens'::regclass AND contype = 'p'
      AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE google.tokens ADD COLUMN IF NOT EXISTS added_at bigint;
    DELETE FROM google.tokens WHERE address IS NULL;
    UPDATE google.tokens SET added_at = 0 WHERE added_at IS NULL;
    ALTER TABLE google.tokens DROP CONSTRAINT google_tokens_pkey;
    ALTER TABLE google.tokens ADD CONSTRAINT google_tokens_pkey PRIMARY KEY (user_id, address);
  END IF;
END $$;`

// Kind-tagged error the client turns into an AuthError.
class AuthErr extends Error {}
const authErr = (m) => new AuthErr('auth: ' + m)

async function tokenPost(params) {
  const r = await fetchRetry(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  const t = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, t }
}

// All accounts for a user, primary (earliest added) first.
async function getAccounts(userId) {
  const r = await pool.query(
    'SELECT * FROM google.tokens WHERE user_id = $1 ORDER BY added_at ASC, address ASC', [userId])
  return r.rows
}
// The row for one account; when address is omitted, the primary.
async function getRow(userId, address) {
  if (address) {
    const r = await pool.query('SELECT * FROM google.tokens WHERE user_id = $1 AND address = $2', [userId, address])
    return r.rows[0] || null
  }
  return (await getAccounts(userId))[0] || null
}

async function upsert(userId, address, fields) {
  const cols = Object.keys(fields)
  const set = cols.map((c, i) => `${c} = $${i + 3}`).join(', ')
  const ins = ['user_id', 'address', ...cols].join(', ')
  const ph = ['$1', '$2', ...cols.map((_, i) => `$${i + 3}`)].join(', ')
  await pool.query(
    `INSERT INTO google.tokens (${ins}) VALUES (${ph})
     ON CONFLICT (user_id, address) DO UPDATE SET ${set}`,
    [userId, address, ...cols.map((c) => fields[c])],
  )
}

// One refresh in flight per (user, account); concurrent google.api calls share it.
const refreshing = new Map()
function refreshToken(userId, address, row) {
  const key = `${userId}::${address}`
  if (!refreshing.has(key)) {
    refreshing.set(key, (async () => {
      try {
        if (!row.refresh_token) throw authErr('Not connected to Google.')
        const { ok, t, status } = await tokenPost({
          client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
          refresh_token: row.refresh_token, grant_type: 'refresh_token',
        })
        if (!ok || !t.access_token) {
          // invalid_grant is the ONLY answer that means the grant itself is
          // dead (revoked, expired, password changed): drop just this account
          // so the user is cleanly prompted to reconnect it.
          if (t.error === 'invalid_grant') {
            await pool.query('DELETE FROM google.tokens WHERE user_id = $1 AND address = $2', [userId, address])
            throw authErr('Google session expired — reconnect.')
          }
          // Anything else — a bad client config, a garbled body, Google having
          // a moment — is not evidence the connection is gone. Reporting it as
          // an auth failure would drop a working account.
          throw new Error(`Google refused the token refresh (${status}${t.error ? ': ' + t.error : ''}).`)
        }
        const expires_at = Date.now() + (Number(t.expires_in) || 3600) * 1000
        await upsert(userId, address, { access_token: t.access_token, expires_at })
        return t.access_token
      } finally {
        refreshing.delete(key)
      }
    })())
  }
  return refreshing.get(key)
}

async function accessTokenFor(userId, address, { force = false } = {}) {
  const row = await getRow(userId, address)
  if (!row) throw authErr('Not connected to Google.')
  if (!force && row.access_token && Number(row.expires_at) > Date.now() + 60_000) return row.access_token
  return refreshToken(userId, row.address, row)
}

// Proxy a Google REST call with a valid server-held token; refresh + retry once
// on 401. Returns parsed JSON (null on 204). Throws AuthErr on auth/scope loss.
async function googleApi(userId, address, { method = 'GET', url, body }, retried = false) {
  const token = await accessTokenFor(userId, address, { force: retried })
  const r = await fetchRetry(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    // Reads retry; writes get one shot. A send that Google accepted but whose
    // response we lost would go out twice on a retry.
  }, { tries: method === 'GET' ? 2 : 1 })
  if (r.status === 401) {
    if (!retried) return googleApi(userId, address, { method, url, body }, true)
    throw authErr('Google session expired — reconnect.')
  }
  if (!r.ok) {
    const txt = (await r.text()).slice(0, 300)
    if (r.status === 403 && /insufficient|scope/i.test(txt)) {
      throw new AuthErr('scope: Reconnect to grant the new permissions.')
    }
    throw new Error(`Google error ${r.status}: ${txt}`)
  }
  return r.status === 204 ? null : r.json()
}

// Fetch the address a fresh access token belongs to (direct call — the token
// isn't in the DB yet during exchange, and it identifies which row to write).
async function addressForToken(accessToken) {
  const r = await fetch(PROFILE_URL, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!r.ok) return null
  const j = await r.json().catch(() => ({}))
  return j.emailAddress || null
}

async function exchange(userId, code) {
  if (!configured) throw new Error('Google is not configured on the server.')
  const { ok, t } = await tokenPost({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: 'postmessage', grant_type: 'authorization_code',
  })
  if (!ok || !t.access_token) throw new Error(t.error_description || t.error || 'Google rejected the sign-in.')
  const expires_at = Date.now() + (Number(t.expires_in) || 3600) * 1000
  // Which account is this? Resolve the address from the fresh token so we key
  // the right row (adding a new account vs. re-consenting an existing one).
  const address = await addressForToken(t.access_token)
  if (!address) throw new Error('Could not read the Google account address.')
  const prev = await getRow(userId, address)
  // Google only returns a refresh token on first consent — keep the old one
  // for this same address if it re-consents without a fresh grant.
  const refresh_token = t.refresh_token || (prev && prev.refresh_token) || null
  const added_at = prev?.added_at ?? Date.now()
  await upsert(userId, address, { access_token: t.access_token, refresh_token, expires_at, added_at, scope: t.scope || SCOPES })
  const accounts = (await getAccounts(userId)).map((r) => r.address)
  return { connected: true, address, accounts }
}

async function disconnect(userId, address) {
  if (address) {
    const row = await getRow(userId, address)
    const tok = row && (row.refresh_token || row.access_token)
    if (tok) fetch(`${REVOKE_URL}?token=${encodeURIComponent(tok)}`, { method: 'POST' }).catch(() => {})
    await pool.query('DELETE FROM google.tokens WHERE user_id = $1 AND address = $2', [userId, address])
  } else {
    for (const row of await getAccounts(userId)) {
      const tok = row.refresh_token || row.access_token
      if (tok) fetch(`${REVOKE_URL}?token=${encodeURIComponent(tok)}`, { method: 'POST' }).catch(() => {})
    }
    await pool.query('DELETE FROM google.tokens WHERE user_id = $1', [userId])
  }
  const accounts = (await getAccounts(userId)).map((r) => r.address)
  return { connected: accounts.length > 0, accounts }
}

await applyDdl(ddl)

serveHttp({
  '/handle': async ({ userId, sessionId, reqId, code, payload }) => {
    const p = payload || {}
    try {
      let data
      if (code === 'google.config') data = { clientId: CLIENT_ID, scopes: SCOPES, configured }
      else if (code === 'google.auth.exchange') data = await exchange(userId, p.code)
      else if (code === 'google.auth.status') {
        const accounts = (await getAccounts(userId)).map((r) => r.address)
        data = { connected: accounts.length > 0, address: accounts[0] || '', accounts }
      } else if (code === 'google.auth.disconnect') data = await disconnect(userId, p.account || null)
      else if (code === 'google.api') data = await googleApi(userId, p.account || null, { method: p.method, url: p.url, body: p.body })
      else throw new Error(`unhandled code ${code}`)
      await deliver({ userId, sessionId, reqId, ok: true, data })
    } catch (e) {
      // AuthErr messages already carry their 'auth:'/'scope:' kind prefix.
      const msg = String((e && e.message) || e)
      if (!(e instanceof AuthErr)) console.error(`google ${code}:`, msg)
      await deliver({ userId, sessionId, reqId, ok: false, error: msg })
    }
    return {}
  },
})

console.log(`google service up${configured ? '' : ' (NOT configured — set GOOGLE_CLIENT_ID/SECRET)'}`)
