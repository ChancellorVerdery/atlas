// fetchRetry decides whether a failure is worth reporting as "your connection
// died". Getting this wrong logs the user out over a blip, so the classes are
// pinned here: 5xx/429/transport = transient, every real HTTP answer = returned
// as-is for the caller to judge. Run: node test/http.test.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import { fetchRetry, TransientError } from '../lib/http.js'

let hits = 0
let plan = []
const server = http.createServer((req, res) => {
  hits++
  const code = plan.shift() ?? 200
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ hit: hits }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/`
const reset = (...codes) => { hits = 0; plan = codes }

// --- a 5xx on the first try is retried, and the second answer is used -------
reset(503, 200)
let r = await fetchRetry(url, {}, { delay: 1 })
assert.equal(r.status, 200)
assert.equal(hits, 2)

// --- 429 counts as transient too -------------------------------------------
reset(429, 200)
assert.equal((await fetchRetry(url, {}, { delay: 1 })).status, 200)
assert.equal(hits, 2)

// --- still failing after the retry throws TransientError, not an auth error -
reset(500, 500)
await assert.rejects(
  () => fetchRetry(url, {}, { delay: 1 }),
  (e) => e instanceof TransientError && /unavailable \(500\)/.test(e.message),
)
assert.equal(hits, 2)

// --- 4xx is a real answer: returned, never retried -------------------------
// invalid_grant arrives as a 400, and only the caller can tell that apart from
// a bad request — so it must come back intact rather than as a throw.
reset(400)
r = await fetchRetry(url, {}, { delay: 1 })
assert.equal(r.status, 400)
assert.equal(hits, 1)
assert.deepEqual(await r.json(), { hit: 1 })

reset(401)
assert.equal((await fetchRetry(url, {}, { delay: 1 })).status, 401)
assert.equal(hits, 1)

// --- tries:1 (writes) never repeats the request ----------------------------
reset(503, 200)
await assert.rejects(() => fetchRetry(url, { method: 'POST' }, { tries: 1, delay: 1 }), TransientError)
assert.equal(hits, 1) // the POST was NOT sent twice

// --- an unreachable host is transient, and names the cause -----------------
await new Promise((r) => server.close(r))
await assert.rejects(
  () => fetchRetry(url, {}, { delay: 1 }),
  (e) => e instanceof TransientError && /could not reach 127\.0\.0\.1/.test(e.message) && /ECONNREFUSED/.test(e.message),
)

console.log('http.test: all assertions passed')
