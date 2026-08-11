// The UI API service is the only thing in this stack that faces arbitrary
// internet callers, so its two guards get a real check: which Canvas hosts it
// will forward to, and that prefixes only match on a path boundary.
//
// Imports the actual functions rather than scraping source — uiapi.js only
// binds a port when run as the entry point, so importing it here is inert.
// Run: node test/uiapi.check.mjs
import { allowedHost } from '../services/uiapi/canvas.js'
import { mount, ROUTES } from '../services/uiapi.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { strictEqual, ok } from 'node:assert'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---- Canvas host allowlist ---------------------------------------------------
check('the REAL configured Canvas host is reachable', () => {
  // instructure.charlotte.edu is the live setting — self-hosted, not SaaS. The
  // obvious *.instructure.com-only rule rejects it and silently kills every
  // Canvas widget. This case exists so that mistake cannot recur.
  ok(allowedHost('instructure.charlotte.edu'))
})
check('Canvas SaaS hosts are reachable', () => {
  ok(allowedHost('uncc.instructure.com'))
  ok(allowedHost('canvas.instructure.com'))
  ok(allowedHost('INSTRUCTURE.CHARLOTTE.EDU'), 'host match must be case-insensitive')
})
check('internal and LAN targets are refused', () => {
  // Unrestricted this is an open HTTPS forwarder sitting on stack_default with
  // a caller-chosen Authorization header.
  for (const bad of [
    'localhost', 'stack-postgres-1', 'atlas-inbox', 'atlas-auth', 'adminer', 'portainer',
    '127.0.0.1', '192.0.2.10', '10.0.0.1', '169.254.169.254', '[::1]',
  ]) ok(!allowedHost(bad), `${bad} was allowed`)
})
check('suffix and prefix smuggling are refused', () => {
  for (const bad of [
    'uncc.instructure.com.attacker.net',
    'instructure.charlotte.edu.evil.test',
    'notinstructure.com',
    'instructure.com.evil.io',
    'uncc.instructure.com.',
    'evil.net/uncc.instructure.com',
  ]) ok(!allowedHost(bad), `${bad} was allowed`)
})

// ---- prefix mounting ---------------------------------------------------------
const mounted = (url) => {
  const req = { url }
  const h = mount(req)
  return h ? req.url : null
}
check('prefixes match only on a path boundary', () => {
  strictEqual(mounted('/canvas-proxy/x.instructure.com/api'), '/x.instructure.com/api')
  strictEqual(mounted('/finance-api/sync'), '/sync')
  strictEqual(mounted('/canvas-proxy'), '/')
  strictEqual(mounted('/canvas-proxyfoo/x'), null, 'prefix matched past a path boundary')
  strictEqual(mounted('/finance-apix'), null)
  strictEqual(mounted('/study-api/jobs'), null, 'study-api must NOT be served here — it is still local')
  strictEqual(mounted('/notes-api/tree'), null, 'notes-api must never be served here')
  strictEqual(mounted('/graph-api/file'), null, 'graph-api must never be served here')
})
check('only the two moved prefixes are routed', () => {
  strictEqual(ROUTES.map((r) => r.prefix).sort().join(','), '/canvas-proxy,/finance-api')
})

// ---- auth and body handling --------------------------------------------------
const SRC = readFileSync(fileURLToPath(new URL('../services/uiapi.js', import.meta.url)), 'utf8')
check('every request is authenticated before the body is read', () => {
  const authIdx = SRC.indexOf('userForToken')
  const mountIdx = SRC.indexOf('mount(req)')
  ok(authIdx > 0 && mountIdx > authIdx, 'a handler can run before the token is checked')
  ok(/res\.writeHead\(401\)\.end\(\)/.test(SRC), '401 must carry an empty body')
})
check('no CORS headers are ever emitted', () => {
  ok(!/access-control-allow/i.test(SRC), 'a hostile page must not be able to call this')
})
check('the session token uses its own header, not Authorization', () => {
  // canvas.js forwards Authorization verbatim to Canvas; reusing it for the
  // Atlas session token would ship that token to instructure.com.
  ok(/x-atlas-token/i.test(SRC))
  ok(!/headers\['authorization'\]/i.test(SRC))
})
const PLAID = readFileSync(fileURLToPath(new URL('../services/uiapi/plaid.js', import.meta.url)), 'utf8')
check('the plaid body reader is capped', () => {
  ok(/BODY_CAP\s*=\s*1e6/.test(PLAID), 'cap is gone')
  ok(/size > BODY_CAP/.test(PLAID), 'cap is declared but never enforced')
})

console.log(failures ? `\n${failures} failed` : '\nuiapi.check: all good')
process.exit(failures ? 1 : 0)
