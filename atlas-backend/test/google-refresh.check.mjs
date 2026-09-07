// The Google token-refresh path, executed — not read.
//
// THE BUG THIS EXISTS FOR (Pass 9). refreshToken() de-duplicates concurrent
// refreshes through a module-level `refreshing` Map, and used to clean the
// entry up from a `finally` INSIDE the async body:
//
//     refreshing.set(key, (async () => {
//       try {
//         if (!row.refresh_token) throw authErr('Not connected to Google.')
//         ...await tokenPost...
//       } finally { refreshing.delete(key) }
//     })())
//
// That first line throws with NO await in front of it. An async function runs
// synchronously up to its first await, so on that one path the entire body —
// `finally` included — completed BEFORE `refreshing.set()` was reached. The
// delete hit a key that did not exist yet; the set then parked the
// already-rejected promise in the map, where nothing would ever remove it.
//
// Consequence: one refresh attempt on an account with no refresh token poisons
// that (user, account) key for the life of the process. Every later Gmail or
// Calendar call replays 'auth: Not connected to Google.' out of the cache
// without touching Google or the database — INCLUDING after the user does the
// exact thing the message tells them to do and reconnects the account. Only a
// container restart cleared it.
//
// Every other failure path in that function has an await ahead of it and so
// cleaned up correctly. That asymmetry is why it hid, and it is why arm 1 below
// deliberately fails FIRST and then succeeds: a test that only checks the
// error message passes against the broken code.
//
// These arms import the real services/google.js. That is possible as of Pass 9,
// which put its `await applyDdl()` behind an entrypoint guard; before that the
// file could not be loaded at all without a Postgres (there is none on a dev
// box here — `pg_isready` fails, standing since Pass 2).
//
// Run: node test/google-refresh.check.mjs
import { strictEqual, ok } from 'node:assert'
import { pool } from '../lib/db.js'
import { refreshToken, accessTokenFor, googleApi } from '../services/google.js'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}
const rejects = async (p) => {
  try { await p } catch (e) { return e }
  throw new Error('expected a rejection, got a resolved value')
}

// ---- models -----------------------------------------------------------------
// google.tokens, plus a recorder for everything that leaves the box. Both are
// deliberately loud: an unrecognised query or an unstubbed fetch throws rather
// than answering, so a future edit cannot route around them and stay green.
let rows = []
const sql = []
pool.query = async (q, params = []) => {
  const s = String(q).replace(/\s+/g, ' ').trim()
  sql.push(s)
  if (s.startsWith('SELECT * FROM google.tokens WHERE user_id = $1 ORDER BY added_at'))
    return { rows: rows.filter(r => r.user_id === params[0]).sort((a, b) => a.added_at - b.added_at) }
  if (s.startsWith('SELECT * FROM google.tokens WHERE user_id = $1 AND address = $2'))
    return { rows: rows.filter(r => r.user_id === params[0] && r.address === params[1]) }
  if (s.startsWith('DELETE FROM google.tokens WHERE user_id = $1 AND address = $2')) {
    rows = rows.filter(r => !(r.user_id === params[0] && r.address === params[1]))
    return { rows: [] }
  }
  if (s.startsWith('INSERT INTO google.tokens')) {
    // upsert() builds its column list from Object.keys(fields); replay it.
    const cols = s.slice(s.indexOf('(') + 1, s.indexOf(')')).split(',').map(x => x.trim())
    const rec = Object.fromEntries(cols.map((c, i) => [c, params[i]]))
    const hit = rows.find(r => r.user_id === rec.user_id && r.address === rec.address)
    if (hit) Object.assign(hit, rec); else rows.push(rec)
    return { rows: [] }
  }
  throw new Error(`the google pool model does not recognise: ${s.slice(0, 80)}`)
}

let net = []
let nextResponses = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init = {}) => {
  net.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {} })
  const r = nextResponses.shift()
  if (!r) throw new Error(`unstubbed fetch to ${url}`)
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.body ?? {},
    text: async () => JSON.stringify(r.body ?? {}),
  }
}
const reset = (...responses) => { rows = []; sql.length = 0; net = []; nextResponses = responses }
const tokenOk = (t = 'access-new') => ({ status: 200, body: { access_token: t, expires_in: 3600 } })

const U = 'user-1'
const A = 'a@gmail.com'

// ---- 1. THE BUG -------------------------------------------------------------
await check('a failed refresh does not poison the account for the life of the process', async () => {
  reset(tokenOk('access-after-reconnect'))
  rows.push({ user_id: U, address: A, refresh_token: null, added_at: 1 })

  // The user's account has no refresh token — this attempt must fail.
  const e = await rejects(refreshToken(U, A, { refresh_token: null }))
  strictEqual(e.message, 'auth: Not connected to Google.')
  strictEqual(net.length, 0, 'a row with no refresh token should never reach Google')

  // The user now reconnects: the row has a real refresh token. This MUST work.
  // Against the pre-Pass-9 code it does not — the rejected promise is still
  // sitting in the map under this key and is handed straight back.
  const tok = await refreshToken(U, A, { refresh_token: 'rt-good' })
  strictEqual(tok, 'access-after-reconnect',
    'the refresh after a reconnect was answered from a cached failure')
  strictEqual(net.length, 1, 'the retry never actually called Google — it replayed a cached rejection')
})

// ---- 2. the de-duplication the map exists for still works --------------------
await check('concurrent refreshes for one account share a single token call', async () => {
  reset(tokenOk('access-shared'))
  const row = { refresh_token: 'rt-good' }
  const [a, b, c] = await Promise.all([
    refreshToken(U, A, row), refreshToken(U, A, row), refreshToken(U, A, row),
  ])
  strictEqual(a, 'access-shared'); strictEqual(b, 'access-shared'); strictEqual(c, 'access-shared')
  strictEqual(net.filter(n => n.url.includes('oauth2.googleapis.com/token')).length, 1,
    'the in-flight map stopped de-duplicating — three concurrent calls hit Google three times')
})

// ---- 3. and the entry is released after a SUCCESS too ------------------------
await check('a successful refresh is not cached either — a later call refreshes again', async () => {
  reset(tokenOk('access-1'), tokenOk('access-2'))
  const row = { refresh_token: 'rt-good' }
  strictEqual(await refreshToken(U, A, row), 'access-1')
  strictEqual(await refreshToken(U, A, row), 'access-2',
    'the second refresh replayed the first one — the map entry was never released')
})

// ---- 4. failures that DO have an await ahead of them --------------------------
await check('invalid_grant drops just that account, and does not wedge the key', async () => {
  reset({ status: 400, body: { error: 'invalid_grant' } }, tokenOk('access-later'))
  rows.push({ user_id: U, address: A, refresh_token: 'rt-dead', added_at: 1 })
  rows.push({ user_id: U, address: 'b@gmail.com', refresh_token: 'rt-other', added_at: 2 })

  const e = await rejects(refreshToken(U, A, { refresh_token: 'rt-dead' }))
  ok(/reconnect/i.test(e.message), `unexpected message: ${e.message}`)
  strictEqual(rows.filter(r => r.address === A).length, 0, 'the dead account was not dropped')
  strictEqual(rows.filter(r => r.address === 'b@gmail.com').length, 1,
    'a sibling account was dropped along with the dead one')

  // Reconnecting that same address must work immediately.
  strictEqual(await refreshToken(U, A, { refresh_token: 'rt-new' }), 'access-later')
})

await check('a transient refusal keeps the account and is retryable', async () => {
  // Not evidence the grant is gone — a bad client config or a garbled body.
  // Reporting it as an auth failure would drop a working connection.
  reset({ status: 400, body: { error: 'temporarily_unavailable' } }, tokenOk('access-ok'))
  rows.push({ user_id: U, address: A, refresh_token: 'rt-good', added_at: 1 })
  const e = await rejects(refreshToken(U, A, { refresh_token: 'rt-good' }))
  ok(/refused the token refresh/.test(e.message), `unexpected message: ${e.message}`)
  ok(!/^auth:/.test(e.message), 'a transient refusal was reported as an auth failure — that logs the user out of a good connection')
  strictEqual(rows.filter(r => r.address === A).length, 1, 'a transient refusal deleted the account')
  strictEqual(await refreshToken(U, A, { refresh_token: 'rt-good' }), 'access-ok')
})

// ---- 5. an unexpired token is used as-is -------------------------------------
await check('accessTokenFor reuses a live token and refreshes an expiring one', async () => {
  reset()
  rows.push({ user_id: U, address: A, access_token: 'live', refresh_token: 'rt', added_at: 1,
    expires_at: Date.now() + 600_000 })
  strictEqual(await accessTokenFor(U, A), 'live')
  strictEqual(net.length, 0, 'a token good for ten more minutes was refreshed anyway')

  // Inside the 60s skew window it must refresh rather than hand out a token
  // that will expire mid-flight.
  nextResponses = [tokenOk('access-renewed')]
  rows[0].expires_at = Date.now() + 30_000
  strictEqual(await accessTokenFor(U, A), 'access-renewed')
  strictEqual(rows[0].access_token, 'access-renewed', 'the renewed token was not written back')
})

// ---- 6. the url guard, behaviorally ------------------------------------------
await check('googleApi refuses a disallowed target without a token, a query or a packet', async () => {
  // google-apiurl.check.mjs asserts this by reading source, because google.js
  // could not be imported before Pass 9. This is the same claim, executed.
  reset()
  rows.push({ user_id: U, address: A, access_token: 'live', refresh_token: 'rt', added_at: 1,
    expires_at: Date.now() + 600_000 })
  for (const url of [
    'http://atlas-auth/handle',
    'http://169.254.169.254/latest/meta-data/',
    'https://evil.test/gmail/v1/users/me/messages',
    'https://gmail.googleapis.com@evil.test/gmail/v1/users/me',
    'https://www.googleapis.com/calendar/v3/../../drive/v3/files',
  ]) {
    const e = await rejects(googleApi(U, A, { url }))
    strictEqual(e.message, 'google.api: target not allowed', `not refused: ${url}`)
  }
  strictEqual(net.length, 0, 'a refused target still caused a network call')
  strictEqual(sql.length, 0, 'a refused target still hit the database — the guard runs after the token lookup')
})

await check('googleApi forwards an allowed target with the bearer token', async () => {
  // The complement of the arm above: a guard that refused everything would pass
  // it, and would also mean Gmail and Calendar are broken in the app.
  reset({ status: 200, body: { messages: [] } })
  rows.push({ user_id: U, address: A, access_token: 'live', refresh_token: 'rt', added_at: 1,
    expires_at: Date.now() + 600_000 })
  const out = await googleApi(U, A, { url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages' })
  ok(out && Array.isArray(out.messages))
  strictEqual(net.length, 1)
  strictEqual(net[0].headers.Authorization, 'Bearer live')
})

// ---- 7. the 401 path ---------------------------------------------------------
await check('a 401 forces one refresh and one retry, then gives up cleanly', async () => {
  reset(
    { status: 401, body: {} },              // first call: stale token
    tokenOk('access-forced'),                // forced refresh
    { status: 200, body: { ok: 1 } },        // retry succeeds
  )
  rows.push({ user_id: U, address: A, access_token: 'stale', refresh_token: 'rt', added_at: 1,
    expires_at: Date.now() + 600_000 })
  const out = await googleApi(U, A, { url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' })
  strictEqual(out.ok, 1)
  const api = net.filter(n => n.url.startsWith('https://gmail.googleapis.com'))
  strictEqual(api.length, 2, 'the 401 was not retried exactly once')
  strictEqual(api[1].headers.Authorization, 'Bearer access-forced', 'the retry reused the stale token')

  // A second 401 must NOT loop.
  reset({ status: 401, body: {} }, tokenOk('access-x'), { status: 401, body: {} })
  rows.push({ user_id: U, address: A, access_token: 'stale', refresh_token: 'rt', added_at: 1,
    expires_at: Date.now() + 600_000 })
  const e = await rejects(googleApi(U, A, { url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' }))
  ok(/^auth:/.test(e.message), `a repeated 401 should surface as an auth error, got: ${e.message}`)
})

globalThis.fetch = realFetch
console.log(failures ? `\ngoogle-refresh.check: ${failures} FAILED` : '\ngoogle-refresh.check: all good')
process.exit(failures ? 1 : 0)
