// callLLM (server/llm.js) — Claude-only, subscription-OAuth path. Pure logic,
// no real network: stubs globalThis.fetch per-case since llm.js calls the
// ambient fetch directly. (The old multi-provider/openai fallback contract was
// removed — Atlas AI is single-provider Claude over OAuth now.)
// Run: node tests/llm.check.mjs
import assert from 'node:assert/strict'

const { callLLM, CLAUDE_MODEL } = await import('../server/llm.js')

const okRes = (body) => ({ ok: true, status: 200, json: async () => body })
const errRes = (status, body) => ({ ok: false, status, json: async () => body })
const claudeText = (t) => ({ content: [{ type: 'text', text: t }] })
const oauthCred = (over = {}) => ({ provider: 'claude', oauth: { access: 'tok-abc' }, model: 'claude-sonnet-5', ...over })

// ---- no cred → clear error, no network call --------------------------------
{
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(() => callLLM({ prompt: 'hi' }), /no_ai_provider/)
  assert.equal(called, false, 'missing cred must not touch the network')
}

// ---- cred without an oauth access token → reconnect error, no network ------
{
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('should not be called') }
  await assert.rejects(() => callLLM({ cred: { provider: 'claude', oauth: {} }, prompt: 'hi' }), /reconnect Claude/i)
  assert.equal(called, false, 'no access token must not touch the network')
}

// ---- happy path → OAuth bearer, no x-api-key, Claude Code identity leads ----
{
  let seen = null
  globalThis.fetch = async (url, opts) => { seen = { url, opts }; return okRes(claudeText('{"ok":true}')) }
  const out = await callLLM({ cred: oauthCred(), system: 'REAL INSTRUCTIONS', prompt: 'hi' })
  assert.equal(out.usedProvider, 'claude')
  assert.equal(out.text, '{"ok":true}')
  assert.match(seen.url, /api\.anthropic\.com/)
  const h = seen.opts.headers
  assert.equal(h.Authorization, 'Bearer tok-abc', 'must send the OAuth bearer token')
  assert.equal(h['anthropic-beta'], 'oauth-2025-04-20', 'must send the oauth beta header')
  assert.ok(!('x-api-key' in h), 'must NOT send x-api-key on the OAuth path')
  const body = JSON.parse(seen.opts.body)
  assert.ok(Array.isArray(body.system), 'system is an array of blocks')
  assert.match(body.system[0].text, /You are Claude Code/, 'identity block must lead')
  assert.equal(body.system[1].text, 'REAL INSTRUCTIONS', 'caller system follows as a second block')
  assert.equal(body.model, 'claude-sonnet-5')
}

// ---- default model when the cred omits one ---------------------------------
{
  let body = null
  globalThis.fetch = async (_u, opts) => { body = JSON.parse(opts.body); return okRes(claudeText('x')) }
  await callLLM({ cred: { provider: 'claude', oauth: { access: 't' } }, prompt: 'hi' })
  assert.equal(body.model, CLAUDE_MODEL, 'falls back to CLAUDE_MODEL')
}

// ---- schema → output_config.format.json_schema -----------------------------
{
  let body = null
  globalThis.fetch = async (_u, opts) => { body = JSON.parse(opts.body); return okRes(claudeText('{}')) }
  const schema = { type: 'object', properties: { a: { type: 'string' } } }
  await callLLM({ cred: oauthCred(), prompt: 'hi', schema })
  assert.equal(body.output_config.format.type, 'json_schema')
  assert.deepEqual(body.output_config.format.schema, schema)
}

// ---- attachments become labelled image/document blocks ---------------------
{
  let body = null
  globalThis.fetch = async (_u, opts) => { body = JSON.parse(opts.body); return okRes(claudeText('ok')) }
  await callLLM({
    cred: oauthCred(),
    prompt: 'describe',
    images: [
      { name: 'fig.png', media_type: 'image/png', data: 'AAAA' },
      { name: 'doc.pdf', media_type: 'application/pdf', data: 'BBBB' },
    ],
  })
  const content = body.messages[0].content
  assert.ok(Array.isArray(content), 'content is a block array when images are present')
  assert.ok(content.some((b) => b.type === 'image' && b.source.media_type === 'image/png'))
  assert.ok(content.some((b) => b.type === 'document' && b.source.media_type === 'application/pdf'))
  assert.ok(content.some((b) => b.type === 'text' && /fig\.png/.test(b.text)), 'each file is labelled by name')
}

// ---- 401 → reconnect error -------------------------------------------------
{
  globalThis.fetch = async () => errRes(401, { error: { type: 'authentication_error', message: 'bad token' } })
  await assert.rejects(() => callLLM({ cred: oauthCred(), prompt: 'hi' }), /reconnect Claude/i)
}

// ---- other non-ok statuses surface the API message -------------------------
{
  globalThis.fetch = async () => errRes(400, { error: { type: 'invalid_request_error', message: 'bad schema' } })
  await assert.rejects(() => callLLM({ cred: oauthCred(), prompt: 'hi' }), /bad schema/)
}

console.log('llm.check: all assertions passed')
