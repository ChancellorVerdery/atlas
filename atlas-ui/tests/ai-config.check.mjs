// AI provider connections (page/ai.js) — storage round-trip and the pure
// resolution logic: per-capability override wins, then primary, then
// secondary, and a provider only counts once it's actually connected.
// Run: node tests/ai-config.check.mjs
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
}

const {
  loadAI, saveAI, connectedProviders, isProviderConnected,
  providerForCapability, isAIConfigured, maskKey, PROVIDERS, CAPABILITIES,
} = await import('../src/page/ai.js')

// --- a fresh store yields a complete, empty shape ---------------------------
store.clear()
const fresh = loadAI()
assert.deepEqual(fresh.providers, { claude: {}, openai: {} })
assert.equal(fresh.primary, null)
assert.equal(fresh.secondary, null)
assert.deepEqual(fresh.perCapability, { study: null, notes: null })
assert.equal(connectedProviders(fresh).length, 0)
assert.equal(isAIConfigured(fresh), false)
assert.equal(providerForCapability('study', fresh), null)

// a corrupt store must not throw — same discipline as theme.js's loadTheme
store.set('atlas.ai.v1', '{ not json')
assert.doesNotThrow(() => loadAI())
assert.deepEqual(loadAI().providers, { claude: {}, openai: {} })

// --- connectedProviders reflects who actually holds a credential -----------
store.clear()
saveAI({ providers: { claude: { apiKey: 'sk-ant-1234' }, openai: {} }, primary: null, secondary: null, perCapability: { study: null, notes: null } })
let s = loadAI()
assert.equal(isProviderConnected('claude', s), true)
assert.equal(isProviderConnected('openai', s), false)
assert.deepEqual(connectedProviders(s), ['claude'])
assert.equal(isAIConfigured(s), true)

// Claude's stub OAuth token also counts as connected, same as an API key.
s.providers.claude = {}
s.providers.claude.oauth = { token: 'stub' }
assert.equal(isProviderConnected('claude', s), true)

// --- load/save round-trips ---------------------------------------------------
saveAI({
  providers: { claude: { apiKey: 'sk-ant-abcd' }, openai: { apiKey: 'sk-oai-wxyz' } },
  primary: 'openai', secondary: 'claude', perCapability: { study: 'claude', notes: null },
})
s = loadAI()
assert.equal(s.providers.claude.apiKey, 'sk-ant-abcd')
assert.equal(s.providers.openai.apiKey, 'sk-oai-wxyz')
assert.equal(s.primary, 'openai')
assert.equal(s.secondary, 'claude')
assert.equal(s.perCapability.study, 'claude')
assert.equal(s.perCapability.notes, null)
assert.deepEqual(connectedProviders(s).sort(), ['claude', 'openai'])

// unknown/garbage provider ids stored under primary/secondary/perCapability
// resolve to unset rather than surviving as a bogus value
store.set('atlas.ai.v1', JSON.stringify({ primary: 'gemini', perCapability: { study: 'bogus' } }))
s = loadAI()
assert.equal(s.primary, null)
assert.equal(s.perCapability.study, null)

// --- resolution order: perCapability > primary > secondary ------------------
saveAI({
  providers: { claude: { apiKey: 'k1' }, openai: { apiKey: 'k2' } },
  primary: 'claude', secondary: 'openai', perCapability: { study: 'openai', notes: null },
})
s = loadAI()
assert.equal(providerForCapability('study', s), 'openai', 'perCapability override wins')
assert.equal(providerForCapability('notes', s), 'claude', 'unset capability falls back to primary')

// primary set but not connected -> falls through to secondary
saveAI({
  providers: { claude: {}, openai: { apiKey: 'k2' } },
  primary: 'claude', secondary: 'openai', perCapability: { study: null, notes: null },
})
s = loadAI()
assert.equal(providerForCapability('study', s), 'openai', 'a disconnected primary is skipped in favour of secondary')

// perCapability override points at a provider that's since been disconnected
// -> the stored choice survives (reconnecting restores it) but resolution
// skips it, falling back the same as an unset capability would
saveAI({
  providers: { claude: {}, openai: { apiKey: 'k2' } },
  primary: 'openai', secondary: null, perCapability: { study: 'claude', notes: null },
})
s = loadAI()
assert.equal(s.perCapability.study, 'claude', 'the choice itself is not silently cleared')
assert.equal(providerForCapability('study', s), 'openai', 'but resolution skips the disconnected override')

// nothing connected at all -> null, not a crash
saveAI({ providers: { claude: {}, openai: {} }, primary: 'claude', secondary: 'openai', perCapability: { study: 'claude', notes: null } })
assert.equal(providerForCapability('study'), null)
assert.equal(providerForCapability('notes'), null)
assert.equal(isAIConfigured(), false)

// --- masking: a stored key never comes back whole ---------------------------
assert.equal(maskKey('sk-ant-api03-verylongsecret1234'), '••••1234')
assert.equal(maskKey('abcd'), '••••')
assert.equal(maskKey(''), '')
assert.equal(maskKey(undefined), '')
assert.ok(!maskKey('sk-ant-api03-verylongsecret1234').includes('verylongsecret'))

// --- shape sanity -------------------------------------------------------------
assert.deepEqual(PROVIDERS, ['claude', 'openai'])
assert.deepEqual(CAPABILITIES, ['study', 'notes'])

console.log('ai-config.check: all assertions passed')
