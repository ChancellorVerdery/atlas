// Guards on the handlers that are STILL LOCAL. The Canvas and Plaid guards moved
// to the server with their code — see atlas-backend/test/uiapi.check.mjs, which
// imports the real functions instead of scraping source. What remains here is
// study-api and notes-api's AI paths.
//
// AI provider routing (2026-08): these endpoints no longer spawn a local
// `claude` CLI at all — every call goes through callLLM (server/llm.js) using
// the REQUESTER's own connected Claude/OpenAI account (never the dev
// machine's Claude Code subscription). That's a stronger version of the old
// "pin a read-only tool set" guard this file used to check: callLLM never
// declares tool access in the first place, so there's no ambient tool
// surface for attacker-influenceable content (course documents, chat
// transcripts) to reach, CLI-flag-restricted or otherwise.
//
// The handlers are built inside closures in server/middlewares.js, so rather
// than importing them (which would start the study job queue), this reads the
// source. Coarse, but it pins the things that matter.
// Run: node tests/middleware-guards.check.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ok } from 'node:assert'

const SRC = readFileSync(fileURLToPath(new URL('../server/middlewares.js', import.meta.url)), 'utf8')
let failures = 0
const check = (name, fn) => {
  try { fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---- no local claude CLI in the AI paths -------------------------------------
check('no spawn("claude", ...) remains anywhere in middlewares.js', () => {
  ok(!/spawn\(\s*['"]claude['"]/.test(SRC), "spawn('claude', ...) is gone")
  ok(!/--allowedTools|--add-dir|--json-schema/.test(SRC), 'CLI-only flags are gone')
  ok(/from '\.\/llm\.js'/.test(SRC), 'askClaude routes through llm.js callLLM')
})

// ---- every AI call requires the caller's own credentials --------------------
check('chat, judge, extract, and convert all gate on the caller\'s own AI creds', () => {
  const calls = [...SRC.matchAll(/askClaude\(([^;]*?)\)\)/g)].map((m) => m[0])
  const chat = calls.find((c) => c.includes('SCHEMAS.chat'))
  const judge = calls.find((c) => c.includes('SCHEMAS.judge'))
  ok(chat && chat.includes('credsFromRequest(req, body)'), '/chat reads creds from the request')
  ok(judge && judge.includes('credsFromRequest(req, body)'), '/judge reads creds from the request')
  ok(/'\/extract'.*credsFromRequest\(req, body\)/.test(SRC), '/extract reads creds from the request')
  ok(/'\/convert'.*credsFromRequest\(req, body\)/.test(SRC), '/convert reads creds from the request')
  ok(/no_ai_provider/.test(SRC), 'an empty credential list is a clear, explicit error — never a silent CLI fallback')
})

console.log(failures ? `\n${failures} failed` : '\nmiddleware-guards: all good')
process.exit(failures ? 1 : 0)
