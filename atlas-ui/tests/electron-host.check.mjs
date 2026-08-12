// The desktop shell's port is part of its origin, and Google only issues an
// auth code to an origin registered on the OAuth client — so a fixed port is a
// correctness requirement, not a preference. Run: node tests/electron-host.check.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { startHost } from '../electron/host.js'

const FIXED = 5180

// A running Atlas already owns 5180 — that's the product working, not a
// failure, so probe first and assert whichever half is observable.
const free = await new Promise((resolve) => {
  const probe = http.createServer()
  probe.once('error', () => resolve(false))
  probe.listen(FIXED, '127.0.0.1', () => probe.close(() => resolve(true)))
})

const hosts = []
if (free) {
  // --- the port is fixed, and the app is actually served from it ---
  const a = await startHost()
  hosts.push(a)
  assert.equal(a.port, FIXED)
  assert.equal(a.origin, `http://127.0.0.1:${FIXED}`)
  const res = await fetch(a.origin + '/')
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
} else {
  console.log(`note: ${FIXED} is already in use (Atlas is running) — checking the fallback only`)
}

// --- a second instance still runs, on some other port ---
const b = await startHost()
hosts.push(b)
assert.notEqual(b.port, FIXED)
assert.ok(b.port > 0)
assert.equal((await fetch(b.origin + '/')).status, 200)

hosts.forEach((h) => h.server.close())
console.log('electron-host.check: all assertions passed')
