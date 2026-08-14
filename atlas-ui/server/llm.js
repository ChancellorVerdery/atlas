// Claude-only LLM caller for Atlas's AI features (study tutor chat, study
// extraction, notes conversion). Every request runs on the USER'S OWN Claude
// account, connected by subscription OAuth (src/page/ai.js) — never the
// machine owner's local `claude` CLI / Claude Code subscription. The single
// resolved credential is carried on the request; server/middlewares.js reads
// it and hands it to callLLM here.
//
// callLLM({ cred, system, prompt, schema, images }) takes ONE cred and returns
// { text, usedProvider:'claude' }.
//
// This is a Node server-side call (native fetch), so there's no CORS concern
// and deliberately no request timeout — extraction jobs are long-running by
// design (see middlewares.js askClaude/runJob) and must not race a clock.

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages'

// Pinned to what the CLI-era code used — it's the user's token cost to raise,
// not something this refactor should silently upgrade.
export const CLAUDE_MODEL = 'claude-sonnet-5'

// ponytail: subscription-OAuth tokens are only accepted by the Messages API
// when the request presents as Claude Code — hence the anthropic-beta oauth
// header AND this required leading system block. Gray area; Anthropic may
// change it. If OAuth stops working the fallback is an API key again.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

const parseSchema = (schema) => (typeof schema === 'string' ? JSON.parse(schema) : schema)

// {media_type, data(b64), name?}[] → Claude content blocks. A text block
// naming each file precedes it — over the API (unlike the old CLI's Read tool)
// the model has no filesystem access, so a filename label is the only way it
// can later say which figure/file it's talking about.
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

async function callClaude({ cred, system, prompt, schema, images }) {
  const oauth = cred?.oauth
  if (!oauth?.access) throw new Error('no Claude connection — reconnect Claude in Settings')
  // The Claude Code identity block MUST lead; the caller's real instructions
  // follow as a second block. system is always sent as an array of text blocks.
  const systemBlocks = [{ type: 'text', text: CLAUDE_CODE_SYSTEM }]
  if (system) systemBlocks.push({ type: 'text', text: system })
  const body = {
    model: cred.model || CLAUDE_MODEL,
    max_tokens: 8192,
    system: systemBlocks,
    messages: [{ role: 'user', content: claudeContent(prompt, images) }],
  }
  if (schema) body.output_config = { format: { type: 'json_schema', schema: parseSchema(schema) } }
  let res
  try {
    res = await fetch(CLAUDE_URL, {
      method: 'POST',
      headers: {
        // OAuth bearer, NOT x-api-key — the token is a Claude Code credential.
        Authorization: `Bearer ${oauth.access}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
  } catch (e) { throw new Error(`couldn't reach Claude — ${e.message}`) }
  const data = await res.json().catch(() => ({}))
  if (res.status === 401) throw new Error('Claude rejected the connection — reconnect Claude in Settings')
  if (!res.ok) throw new Error(data?.error?.message || `Claude request failed (${res.status})`)
  const text = (Array.isArray(data.content) ? data.content : []).find((b) => b?.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('Claude returned no text content')
  return text
}

export async function callLLM({ cred, system, prompt, schema, images }) {
  if (!cred) throw new Error('no_ai_provider')
  const text = await callClaude({ cred, system, prompt, schema, images })
  return { text, usedProvider: 'claude' }
}
