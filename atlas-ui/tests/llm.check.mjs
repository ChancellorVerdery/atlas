// callLLM (server/llm.js) provider selection + fallback — pure logic, no
// real network calls. Stubs globalThis.fetch per-case since llm.js calls the
// ambient fetch directly (same pattern the rest of the dev-server code uses,
// e.g. middlewares.js fetchPageText).
// Run: node tests/llm.check.mjs
import assert from 'node:assert/strict'

const { callLLM } = await import('../server/llm.js')

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})

// ---- empty creds → clear error, no network call ----------------------------
{
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(() => callLLM({ creds: [], prompt: 'hi' }), /no_ai_provider/)
  assert.equal(called, false, 'empty creds must not touch the network')
}

// ---- exhaustion on provider A falls forward to provider B ------------------
{
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (url.includes('anthropic.com')) {
      // Claude: 429 rate_limit_error — exhaustion
      return jsonRes(429, { error: { type: 'rate_limit_error', message: 'rate limited' } })
    }
    // OpenAI: success
    return jsonRes(200, { choices: [{ message: { content: '{"ok":true}' } }] })
  }
  const creds = [
    { provider: 'claude', apiKey: 'sk-ant-a', model: 'claude-sonnet-5' },
    { provider: 'openai', apiKey: 'sk-oai-b', model: 'gpt-5' },
  ]
  const out = await callLLM({ creds, prompt: 'hi' })
  assert.equal(out.usedProvider, 'openai')
  assert.equal(out.switched, true)
  assert.equal(out.text, '{"ok":true}')
  assert.equal(calls.length, 2, 'both providers were tried')
}

// ---- no fallback needed → switched:false, only one call --------------------
{
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return jsonRes(200, { content: [{ type: 'text', text: '{"ok":true}' }] })
  }
  const creds = [{ provider: 'claude', apiKey: 'sk-ant-a', model: 'claude-sonnet-5' }]
  const out = await callLLM({ creds, prompt: 'hi' })
  assert.equal(out.usedProvider, 'claude')
  assert.equal(out.switched, false)
  assert.equal(calls.length, 1)
}

// ---- a non-exhaustion error propagates WITHOUT falling back ----------------
{
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (url.includes('anthropic.com')) {
      // 400 invalid_request_error — not exhaustion, must not retry
      return jsonRes(400, { error: { type: 'invalid_request_error', message: 'bad schema' } })
    }
    throw new Error('provider B must never be called')
  }
  const creds = [
    { provider: 'claude', apiKey: 'sk-ant-a', model: 'claude-sonnet-5' },
    { provider: 'openai', apiKey: 'sk-oai-b', model: 'gpt-5' },
  ]
  await assert.rejects(() => callLLM({ creds, prompt: 'hi' }), /bad schema/)
  assert.equal(calls.length, 1, 'must stop after the first, non-exhaustion failure')
}

// ---- authentication_error (401) also counts as exhaustion -------------------
{
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (calls.length === 1) return jsonRes(401, { error: { type: 'authentication_error', message: 'bad key' } })
    return jsonRes(200, { content: [{ type: 'text', text: '{"ok":true}' }] })
  }
  const creds = [
    { provider: 'claude', apiKey: 'sk-ant-bad', model: 'claude-sonnet-5' },
    { provider: 'claude', apiKey: 'sk-ant-good', model: 'claude-sonnet-5' },
  ]
  const out = await callLLM({ creds, prompt: 'hi' })
  assert.equal(out.switched, true)
  assert.equal(calls.length, 2)
}

// ---- exhaustion on the LAST entry still throws (nothing left to try) -------
{
  globalThis.fetch = async () => jsonRes(429, { error: { type: 'rate_limit_error', message: 'still limited' } })
  const creds = [{ provider: 'openai', apiKey: 'sk-oai-a', model: 'gpt-5' }]
  await assert.rejects(() => callLLM({ creds, prompt: 'hi' }), /still limited/)
}

console.log('llm.check: all assertions passed')
