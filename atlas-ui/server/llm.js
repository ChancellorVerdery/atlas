// Provider-agnostic LLM caller for Atlas's AI features (study tutor chat,
// study extraction, notes conversion). Routes every request through the
// USER'S OWN connected Claude or OpenAI account — never the machine owner's
// local `claude` CLI / Claude Code subscription. Credentials are resolved
// client-side (src/page/ai.js credsForCapability) and carried on the
// request; server/middlewares.js reads them and hands them to callLLM here.
//
// callLLM({ creds, system, prompt, schema, images }) tries `creds` in order
// (primary first, then secondary) and falls forward to the next entry only
// on a TOKEN-EXHAUSTION error from the provider actually being called (rate
// limit, billing, or a dead/revoked key) — any other failure (bad request,
// network error, a 5xx that isn't exhaustion) propagates immediately rather
// than silently retrying on a different account. Returns
// { text, usedProvider, switched } — switched is true iff creds[0] wasn't
// the one that answered.
//
// This is a Node server-side call (native fetch), so there's no CORS
// concern and deliberately no request timeout here — extraction jobs are
// long-running by design (see middlewares.js askClaude/runJob) and must not
// race a clock.

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

// Pinned to what the CLI-era code used — it's the user's token cost to
// raise, not something this refactor should silently upgrade.
export const CLAUDE_MODEL = 'claude-sonnet-5'
export const OPENAI_MODEL = 'gpt-5'

const exhaustable = (msg, isExhausted) => Object.assign(new Error(msg), { exhausted: isExhausted })

const parseSchema = (schema) => (typeof schema === 'string' ? JSON.parse(schema) : schema)

// {media_type, data(b64), name?}[] → Claude content blocks. A text block
// naming each file precedes it — over the API (unlike the old CLI's Read
// tool) the model has no filesystem access, so a filename label is the only
// way it can later say which figure/file it's talking about.
function claudeContent(prompt, images) {
  if (!images?.length) return prompt
  const blocks = []
  for (const f of images) {
    if (f.name) blocks.push({ type: 'text', text: `File: ${f.name}` })
    blocks.push(f.media_type === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data } }
      : { type: 'image', source: { type: 'base64', media_type: f.media_type, data: f.data } })
  }
  blocks.push({ type: 'text', text: prompt })
  return blocks
}

const CLAUDE_EXHAUSTED_TYPES = new Set(['rate_limit_error', 'billing_error', 'billing', 'authentication_error'])
const claudeExhausted = (status, type) => status === 429 || status === 401 || CLAUDE_EXHAUSTED_TYPES.has(type)

async function callClaude({ apiKey, model, system, prompt, schema, images }) {
  const body = { model: model || CLAUDE_MODEL, max_tokens: 8192, messages: [{ role: 'user', content: claudeContent(prompt, images) }] }
  if (system) body.system = system
  if (schema) body.output_config = { format: { type: 'json_schema', schema: parseSchema(schema) } }
  let res
  try {
    res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) { throw exhaustable(`couldn't reach Claude — ${e.message}`, false) }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw exhaustable(data?.error?.message || `Claude request failed (${res.status})`, claudeExhausted(res.status, data?.error?.type))
  const text = (Array.isArray(data.content) ? data.content : []).find((b) => b?.type === 'text')?.text
  if (typeof text !== 'string') throw exhaustable('Claude returned no text content', false)
  return text
}

const OPENAI_EXHAUSTED_TYPES = new Set(['insufficient_quota'])
const openaiExhausted = (status, type) => status === 429 || status === 401 || OPENAI_EXHAUSTED_TYPES.has(type)

// ponytail: OpenAI's chat/completions has no inline PDF content block, so a
// PDF in `images` is dropped rather than attached (images ride fine as
// data: URLs). This only bites a job whose source is a PDF *and* whose
// primary Claude account is exhausted — upgrade path is OpenAI's Files API
// if that combination turns out to matter in practice.
function openaiContent(prompt, images) {
  const imgs = (images || []).filter((f) => f.media_type !== 'application/pdf')
  if (!imgs.length) return prompt
  const parts = [{ type: 'text', text: prompt }]
  for (const f of imgs) {
    if (f.name) parts.push({ type: 'text', text: `File: ${f.name}` })
    parts.push({ type: 'image_url', image_url: { url: `data:${f.media_type};base64,${f.data}` } })
  }
  return parts
}

async function callOpenAI({ apiKey, model, system, prompt, schema, images }) {
  const messages = []
  if (system) messages.push({ role: 'system', content: system })
  messages.push({ role: 'user', content: openaiContent(prompt, images) })
  const body = { model: model || OPENAI_MODEL, messages }
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'out', schema: parseSchema(schema), strict: true } }
  let res
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) { throw exhaustable(`couldn't reach OpenAI — ${e.message}`, false) }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw exhaustable(data?.error?.message || `OpenAI request failed (${res.status})`, openaiExhausted(res.status, data?.error?.type))
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string') throw exhaustable('OpenAI returned no text content', false)
  return text
}

async function callOne(cred, opts) {
  const provider = cred?.provider === 'openai' ? 'openai' : 'claude'
  const model = cred?.model || (provider === 'openai' ? OPENAI_MODEL : CLAUDE_MODEL)
  const call = provider === 'openai' ? callOpenAI : callClaude
  return call({ apiKey: cred?.apiKey, model, ...opts })
}

export async function callLLM({ creds, system, prompt, schema, images }) {
  if (!Array.isArray(creds) || !creds.length) throw new Error('no_ai_provider')
  let lastErr
  for (let i = 0; i < creds.length; i++) {
    try {
      const text = await callOne(creds[i], { system, prompt, schema, images })
      return { text, usedProvider: creds[i].provider, switched: i > 0 }
    } catch (e) {
      lastErr = e
      if (e.exhausted && i < creds.length - 1) continue // try the next credential
      throw e // not exhaustion, or nothing left to fall back to
    }
  }
  throw lastErr
}
