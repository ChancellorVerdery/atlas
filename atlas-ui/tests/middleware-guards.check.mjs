// Guards on the handlers that are STILL LOCAL. The Canvas and Plaid guards moved
// to the server with their code — see atlas-backend/test/uiapi.check.mjs, which
// imports the real functions instead of scraping source. What remains here is
// study-api, which still runs on this machine because the server's claude CLI is
// not logged in.
//
// The handlers are built inside closures in server/middlewares.js, so rather
// than importing them (which would start the study job queue), this reads the
// source. Coarse, but it pins the thing that matters: the Claude call sites are
// not running with the CLI's default tool set while user documents are in
// context.
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

// ---- claude tool surface -----------------------------------------------------
check('chat and judge pin a read-only tool set', () => {
  ok(/const READ_ONLY_TOOLS = \['--allowedTools', 'Read'\]/.test(SRC), 'READ_ONLY_TOOLS is gone')
  const calls = [...SRC.matchAll(/askClaude\(([^;]*?)\)\)/g)].map((m) => m[0])
  const chat = calls.find((c) => c.includes('SCHEMAS.chat'))
  const judge = calls.find((c) => c.includes('SCHEMAS.judge'))
  ok(chat && chat.includes('READ_ONLY_TOOLS'), '/chat runs with the CLI default tool set')
  ok(judge && judge.includes('READ_ONLY_TOOLS'), '/judge runs with the CLI default tool set')
})

console.log(failures ? `\n${failures} failed` : '\nmiddleware-guards: all good')
process.exit(failures ? 1 : 0)
