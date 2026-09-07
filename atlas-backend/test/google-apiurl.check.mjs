// google.api is a token-bearing forwarder: the client hands it a url, the
// service attaches the user's Google access token and returns the body through
// the outbox. Before this check existed the url was unvalidated, so any
// signed-in user could aim a server-held bearer token at any address the
// backend can reach — atlas-auth, postgres, adminer, portainer, the host
// metadata endpoint, the home LAN — and read the answer.
//
// This is the same hazard uiapi/canvas.js allowlists against, and uiapi.check
// already tests that one. Imports the real guard rather than scraping source:
// apiurl.js is split out of google.js precisely so it can be imported without a
// Postgres (google.js calls applyDdl() at module top level).
//
// Run: node test/google-apiurl.check.mjs
import { allowedApiUrl } from '../services/google/apiurl.js'
import { ok } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---- the real client traffic must still pass --------------------------------
check('the endpoints the app actually calls are allowed', () => {
  // Taken from the client, not invented: email.js builds
  // gmail.googleapis.com/gmail/v1/users/me/..., calendar.js builds
  // www.googleapis.com/calendar/v3/... . If this arm ever fails, Gmail and
  // Calendar are dead in the app — that is the cost of getting the list wrong,
  // and it is why the list was grepped rather than guessed.
  for (const good of [
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is%3Aunread',
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123',
    'https://gmail.googleapis.com/gmail/v1/users/me/settings/filters',
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    'https://www.googleapis.com/calendar/v3/calendars/primary/events',
    'https://www.googleapis.com/calendar/v3/users/me/calendarList',
  ]) ok(allowedApiUrl(good), `${good} was refused`)
})

// ---- internal and LAN targets ------------------------------------------------
check('internal services and the LAN are refused', () => {
  for (const bad of [
    'http://atlas-auth/handle',
    'http://atlas-inbox/',
    'http://stack-postgres-1:5432/',
    'http://adminer/',
    'http://portainer:9000/api/endpoints',
    'http://127.0.0.1/',
    'http://localhost/',
    'http://169.254.169.254/latest/meta-data/',
    'http://192.0.2.10/',
    'http://[::1]/',
    'file:///run/pgpass',
  ]) ok(!allowedApiUrl(bad), `${bad} was allowed`)
})

check('plaintext http to an allowed host is still refused', () => {
  // The token must never leave over a cleartext hop.
  ok(!allowedApiUrl('http://gmail.googleapis.com/gmail/v1/users/me/messages'))
})

// ---- host smuggling ----------------------------------------------------------
check('lookalike hosts are refused', () => {
  for (const bad of [
    'https://gmail.googleapis.com.attacker.net/gmail/v1/users/me/messages',
    'https://notgmail.googleapis.com/gmail/v1/users/me/messages',
    'https://googleapis.com/calendar/v3/x',
    'https://evil.test/gmail/v1/users/me/messages',
    'https://www.googleapis.com.evil.test/calendar/v3/x',
  ]) ok(!allowedApiUrl(bad), `${bad} was allowed`)
})
check('userinfo cannot disguise the real host', () => {
  // 'https://gmail.googleapis.com@evil.test/...' parses with host evil.test —
  // a raw string startsWith() check would have passed it.
  ok(!allowedApiUrl('https://gmail.googleapis.com@evil.test/gmail/v1/users/me/messages'))
  ok(!allowedApiUrl('https://gmail.googleapis.com:x@evil.test/gmail/v1/'))
})

// ---- path smuggling ----------------------------------------------------------
check('an allowed host does not open its whole API surface', () => {
  for (const bad of [
    'https://www.googleapis.com/oauth2/v1/tokeninfo',
    'https://www.googleapis.com/drive/v3/files',
    'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages',
    'https://gmail.googleapis.com/',
  ]) ok(!allowedApiUrl(bad), `${bad} was allowed`)
})
check('dot-segments cannot walk out of the allowed prefix', () => {
  // URL() normalizes '..' before the prefix test sees it, which is why the
  // guard compares the parsed pathname and not the raw string.
  ok(!allowedApiUrl('https://www.googleapis.com/calendar/v3/../../drive/v3/files'))
  ok(!allowedApiUrl('https://gmail.googleapis.com/gmail/v1/../oauth2/v1/tokeninfo'))
})

// ---- junk --------------------------------------------------------------------
check('non-URL input is refused rather than thrown on', () => {
  // payload.url comes straight off the wire; a throw here would be a 500 with
  // a stack in the log instead of a clean refusal.
  for (const bad of [undefined, null, '', 'not a url', '/gmail/v1/users/me', 42, {}, []])
    ok(!allowedApiUrl(bad), `${JSON.stringify(bad)} was allowed`)
})

// ---- the guard has to actually be wired in -----------------------------------
check('googleApi calls the guard before it fetches a token', () => {
  // Everything above tests a pure function. Without this arm, deleting the one
  // line that calls it leaves the whole check green.
  const src = readFileSync(fileURLToPath(new URL('../services/google.js', import.meta.url)), 'utf8')
  const i = src.indexOf('async function googleApi(')
  ok(i >= 0, 'googleApi() not found in google.js')
  const fn = src.slice(i, src.indexOf('\n}\n', i))
  ok(/allowedApiUrl\(/.test(fn), 'googleApi() does not call allowedApiUrl — the url is forwarded unvalidated')
  // Order matters: a refused target must not trigger a token refresh.
  ok(fn.indexOf('allowedApiUrl(') < fn.indexOf('accessTokenFor('),
    'the guard runs after the token is fetched — a rejected target should never cause a refresh')
})

console.log(failures ? `\ngoogle-apiurl.check: ${failures} FAILED` : '\ngoogle-apiurl.check: all good')
process.exit(failures ? 1 : 0)
