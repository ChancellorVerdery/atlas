// The desktop shell's port is part of its origin, and Google only issues an
// auth code to an origin registered on the OAuth client — so a fixed port is a
// correctness requirement, not a preference. Run: node tests/electron-host.check.mjs
import assert from 'node:assert/strict'
import { startHost } from '../electron/host.js'

const FIXED = 5180

// --- the port is fixed, and the app is actually served from it ---
const a = await startHost()
assert.equal(a.port, FIXED)
assert.equal(a.origin, `http://127.0.0.1:${FIXED}`)

const res = await fetch(a.origin + '/')
assert.equal(res.status, 200)
assert.match(res.headers.get('content-type'), /text\/html/)

// --- a second instance still runs, on some other port ---
const b = await startHost()
assert.notEqual(b.port, FIXED)
assert.ok(b.port > 0)
assert.equal((await fetch(b.origin + '/')).status, 200)

a.server.close()
b.server.close()

console.log('electron-host.check: all assertions passed')
