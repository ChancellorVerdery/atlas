// Guards on the local API handlers. These are cheap on loopback and load-bearing
// the moment any of them is reachable over a network, so they get a check that
// fails loudly rather than a comment.
//
// The handlers are built inside closures in server/middlewares.js, so rather
// than importing them (which would start the study job queue), this reads the
// source and exercises the rules it declares. Coarse, but it pins the two things
// that actually matter: which Canvas hosts are reachable, and that the Claude
// call sites are not running with the CLI's default tool set.
// Run: node tests/middleware-guards.check.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { strictEqual, ok } from 'node:assert'

const SRC = readFileSync(fileURLToPath(new URL('../server/middlewares.js', import.meta.url)), 'utf8')
let failures = 0
const check = (name, fn) => {
  try { fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---- Canvas host allowlist ---------------------------------------------------
// Mirrors the two patterns declared in canvasProxy; the assertions below are the
// point, and the extraction fails loudly if the source stops declaring them.
const patterns = [...SRC.matchAll(/^\s{4}(\/\^.*\$\/),$/gm)].map((m) => m[1])
const HOST_RES = patterns.filter((p) => p.includes('instructure'))
check('canvasProxy declares its host allowlist', () => {
  ok(HOST_RES.length >= 2, `found ${HOST_RES.length} instructure patterns, expected 2`)
})
const allowed = (h) => HOST_RES.some((src) => {
  const body = src.slice(1, src.lastIndexOf('/'))
  return new RegExp(body).test(String(h).toLowerCase())
})

check('the REAL configured host is reachable', () => {
  // instructure.charlotte.edu is the live setting. A bare *.instructure.com
  // allowlist rejects it and silently kills every Canvas widget, which is
  // exactly the mistake this case exists to prevent from recurring.
  ok(allowed('instructure.charlotte.edu'), 'self-hosted Canvas host was rejected')
})
check('Canvas SaaS hosts are reachable', () => {
  ok(allowed('uncc.instructure.com'))
  ok(allowed('canvas.instructure.com'))
})
check('internal and LAN targets are refused', () => {
  for (const bad of [
    'localhost', 'stack-postgres-1', 'atlas-inbox', 'adminer', 'portainer',
    '127.0.0.1', '192.0.2.10', '10.0.0.1', '169.254.169.254',
  ]) ok(!allowed(bad), `${bad} was allowed`)
})
check('suffix-smuggling is refused', () => {
  // The anchors are the whole point: without $ these all pass.
  for (const bad of [
    'uncc.instructure.com.attacker.net',
    'instructure.charlotte.edu.evil.test',
    'notinstructure.com',
    'instructure.com.evil.io',
    'uncc.instructure.com.',
  ]) ok(!allowed(bad), `${bad} was allowed`)
})

// ---- request body cap --------------------------------------------------------
check('plaid no longer has a private uncapped readBody', () => {
  const defs = [...SRC.matchAll(/^\s*(?:const|function)\s+readBody\b/gm)]
  strictEqual(defs.length, 1, `found ${defs.length} readBody definitions, expected exactly 1`)
})
check('plaid reads its body with an explicit cap', () => {
  ok(/readBody\(req,\s*PLAID_BODY_CAP\)/.test(SRC), 'plaid body read is uncapped')
})

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
