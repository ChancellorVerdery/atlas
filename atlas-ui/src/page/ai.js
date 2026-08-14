// AI provider connection: Atlas talks to exactly ONE provider — the user's
// own Claude account, connected by SUBSCRIPTION OAuth (a browser login, no
// API key). This file is storage + the OAuth/PKCE dance + the pure resolution
// helpers study.js/notes.js attach to every /study-api and /notes-api request
// (as the x-atlas-ai header). The server (server/llm.js callLLM) never falls
// back to the machine owner's own `claude` CLI/subscription; it only ever uses
// what this file resolves.
//
// Stored in atlas.ai.v1. Unlike every other atlas.* key this one holds a
// secret (the OAuth tokens), so it must NEVER ride the sync path — see the
// SKIP_KEYS entry in main.js and the NEVER_PUSH entry in sync.js, which mirror
// how atlas.backend/atlas.devMode stay device-local.
//
// ponytail: subscription-OAuth-to-API is a GRAY AREA. These tokens are only
// accepted by the Messages API because the request presents as Claude Code —
// the Claude Code identity system block ("You are Claude Code…") plus the
// anthropic-beta:oauth-2025-04-20 header, both implemented in llm.js. That is
// the one first-party client Anthropic issues these tokens for; Anthropic can
// change or revoke this at any time. Upgrade path if they do: a settings-side
// API-key field again.

const KEY = 'atlas.ai.v1'
const PENDING_KEY = 'atlas.ai.oauth.pending'

export const PROVIDERS = ['claude']

// Claude Code's public OAuth client — the same identifiers the CLI uses.
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'
const SCOPE = 'org:create_api_key user:profile user:inference'
export const MODEL = 'claude-sonnet-5'

// typeof-guarded so `import`ing this module in Node (tests) never throws.
const ls = () => (typeof localStorage !== 'undefined' ? localStorage : null)

export function loadAI() {
  let s
  try { s = JSON.parse(ls()?.getItem(KEY)) || {} } catch { s = {} }
  const oauth = s?.providers?.claude?.oauth
  return { providers: { claude: oauth && typeof oauth === 'object' ? { oauth } : {} } }
}

export function saveAI(s) { ls()?.setItem(KEY, JSON.stringify(s)) }

// Connected == a usable OAuth access token is on file.
export const isClaudeConnected = (s = loadAI()) => !!(s.providers.claude.oauth && s.providers.claude.oauth.access)

// Compat surface for renderer.js — one provider now, so these collapse to the
// single Claude check.
export const isProviderConnected = (id, s = loadAI()) => id === 'claude' && isClaudeConnected(s)
export const connectedProviders = (s = loadAI()) => (isClaudeConnected(s) ? ['claude'] : [])
export const isAIConfigured = (s = loadAI()) => isClaudeConnected(s)

export function disconnectClaude() {
  const s = loadAI()
  s.providers.claude = {}
  saveAI(s)
}

// The single credential study.js/notes.js send to the server (via credsHeader).
// null when not connected — the server treats that as `no_ai_provider` rather
// than ever falling back to the dev machine's own claude CLI.
export function credsForClaude(s = loadAI()) {
  const oauth = s.providers.claude.oauth
  return oauth && oauth.access ? { provider: 'claude', oauth, model: MODEL } : null
}

// x-atlas-ai header: base64'd JSON of the single cred object. atob/btoa work
// on Latin1 only, hence the UTF-8 escape hatch.
export const credsHeader = (cred) => btoa(unescape(encodeURIComponent(JSON.stringify(cred))))

// Settings never reflects a stored secret back verbatim — only this masked
// form, so the value on screen can't leak via view-source/copy.
export const maskKey = (key) => (key && key.length > 4 ? `••••${key.slice(-4)}` : key ? '••••' : '')

// ---- OAuth (PKCE S256, browser-only) ----------------------------------------
// base64url of raw bytes (no padding, URL-safe alphabet).
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const randB64url = (n) => {
  const bytes = new Uint8Array(n)
  globalThis.crypto.getRandomValues(bytes)
  return b64url(bytes)
}

// Kick off the browser login: mint a PKCE verifier/challenge + state, stash
// the verifier+state locally, and return the authorize URL to open.
export async function beginClaudeOAuth() {
  const verifier = randB64url(32)
  const challenge = b64url(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  const state = randB64url(32)
  ls()?.setItem(PENDING_KEY, JSON.stringify({ verifier, state }))
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  }).toString()
  return { url: url.toString(), state }
}

// Finish the login. Anthropic's callback value is the pasted-back string
// "code#state"; exchange it (with the stashed verifier) via the server broker,
// then store the tokens. Throws on state mismatch or a failed exchange.
export async function completeClaudeOAuth(raw) {
  let pending = {}
  try { pending = JSON.parse(ls()?.getItem(PENDING_KEY)) || {} } catch { pending = {} }
  const [code, state] = String(raw || '').split('#')
  if (!code || !state) throw new Error('paste the full code Anthropic gave you')
  if (state !== pending.state) throw new Error('OAuth state mismatch — start the connection again')
  const r = await fetch('/ai-oauth/claude/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, state, verifier: pending.verifier }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `couldn't connect Claude (${r.status})`)
  const s = loadAI()
  s.providers.claude = { oauth: { access: j.access, refresh: j.refresh, expires: Date.now() + Number(j.expires) * 1000 } }
  saveAI(s)
  ls()?.removeItem(PENDING_KEY)
  return true
}

// Refresh the access token when it's within 60s of expiry (and a refresh token
// is on file). Returns the (possibly updated) state; a failed refresh returns
// the stale state and lets the real call surface the reconnect error.
export async function ensureFreshClaude(s = loadAI()) {
  const oauth = s.providers.claude.oauth
  if (!oauth || !oauth.access) return s
  if (oauth.expires - Date.now() >= 60000 || !oauth.refresh) return s
  const r = await fetch('/ai-oauth/claude/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh: oauth.refresh }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access) return s
  // Keep the existing refresh token if the provider didn't rotate one this time.
  s.providers.claude = { oauth: { access: j.access, refresh: j.refresh || oauth.refresh, expires: Date.now() + Number(j.expires) * 1000 } }
  saveAI(s)
  return s
}
