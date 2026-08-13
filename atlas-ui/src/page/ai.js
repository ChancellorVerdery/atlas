// AI provider connections: which of Claude / OpenAI this device holds
// credentials for, a primary + secondary preference between them, and a
// per-capability override (Studying, Notes) that falls back to primary, then
// secondary. Storage + pure resolution helpers, plus credsForCapability
// below, which is what study.js/notes.js attach to every /study-api and
// /notes-api request — the server (server/llm.js callLLM) never falls back
// to the machine owner's own `claude` CLI/subscription; it only ever uses
// what this file resolves.
//
// Stored in atlas.ai.v1. Unlike every other atlas.* key this one holds
// secrets (API keys), so it must NEVER ride the sync path — see the
// SKIP_KEYS entry in main.js and the NEVER_PUSH entry in sync.js, which
// mirror how atlas.backend/atlas.devMode stay device-local.

const KEY = 'atlas.ai.v1'

export const PROVIDERS = ['claude', 'openai']
export const CAPABILITIES = ['study', 'notes']

const emptyState = () => ({
  providers: { claude: {}, openai: {} },
  primary: null,
  secondary: null,
  perCapability: { study: null, notes: null },
})

// A stored value that isn't a real, currently-known provider id is treated as
// unset — half-written or stale localStorage must not crash Settings.
const cleanProvider = (v) => (PROVIDERS.includes(v) ? v : null)

export function loadAI() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  const base = emptyState()
  return {
    providers: {
      claude: { ...base.providers.claude, ...(s.providers?.claude || {}) },
      openai: { ...base.providers.openai, ...(s.providers?.openai || {}) },
    },
    primary: cleanProvider(s.primary),
    secondary: cleanProvider(s.secondary),
    perCapability: {
      study: cleanProvider(s.perCapability?.study),
      notes: cleanProvider(s.perCapability?.notes),
    },
  }
}

export function saveAI(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

// "Connected" means a credential is on file — an API key for either
// provider, or Claude's OAuth token once that path exists.
export function isProviderConnected(id, s = loadAI()) {
  const p = s.providers[id]
  return !!(p && (p.apiKey || p.oauth))
}

export const connectedProviders = (s = loadAI()) => PROVIDERS.filter((id) => isProviderConnected(id, s))

// perCapability override wins; falls back to primary, then secondary; null
// if nothing usable is connected. A provider picked for a slot that has since
// been disconnected doesn't count — the stored id survives (so reconnecting
// restores the choice) but resolution skips it.
export function providerForCapability(cap, s = loadAI()) {
  const connected = connectedProviders(s)
  for (const candidate of [s.perCapability?.[cap], s.primary, s.secondary]) {
    if (candidate && connected.includes(candidate)) return candidate
  }
  return null
}

export const isAIConfigured = (s = loadAI()) => connectedProviders(s).length > 0

// Settings never reflects a stored key back into an input — only this masked
// form, so the value on screen can't leak the secret via view-source/copy.
export const maskKey = (key) => (key && key.length > 4 ? `••••${key.slice(-4)}` : key ? '••••' : '')

// ---- request routing ---------------------------------------------------------
// Mirrors server/llm.js's own defaults — kept here too so the client and the
// server agree on what a "connected" provider actually costs.
export const MODELS = { claude: 'claude-sonnet-5', openai: 'gpt-5' }

// The ordered credential list a server-side callLLM() call tries in turn:
// the capability's own override first, then primary, then secondary —
// skipping any slot with no API key on file and de-duping repeats (e.g. the
// override and primary pointing at the same provider). Empty when nothing
// usable is connected — server/middlewares.js treats that as `no_ai_provider`
// rather than ever falling back to the dev machine's own claude CLI.
export function credsForCapability(cap, s = loadAI()) {
  const order = [s.perCapability?.[cap], s.primary, s.secondary]
  const seen = new Set()
  const creds = []
  for (const id of order) {
    if (!id || seen.has(id) || !PROVIDERS.includes(id)) continue
    seen.add(id)
    const apiKey = s.providers[id]?.apiKey
    if (!apiKey) continue
    creds.push({ provider: id, apiKey, model: MODELS[id] })
  }
  return creds
}

// Alternate transport for credsForCapability's list — a base64'd JSON
// header (x-atlas-ai) for callers that would rather not put keys in a POST
// body. atob/btoa work on Latin1 only, hence the UTF-8 escape hatch.
export const credsHeader = (creds) => btoa(unescape(encodeURIComponent(JSON.stringify(creds))))
