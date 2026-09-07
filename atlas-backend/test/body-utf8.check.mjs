// Does a request body survive being split mid-character?
//
// Node delivers an HTTP body as a sequence of Buffers whose boundaries follow
// TCP segments, not character boundaries. `body += chunk` decodes each chunk on
// its own, so a multi-byte UTF-8 character straddling two chunks decodes as two
// U+FFFD replacement characters. The failure is silent in the worst way: the
// JSON stays well-formed, so nothing throws — the mojibake is simply stored and
// broadcast to the user's other sessions.
//
// This is not theoretical for Atlas. `serveHttp` carries every plugin save, and
// those bodies are arbitrary user text (gym notes, work shift notes, finance
// vendor rules) that routinely exceed one socket read.
//
// The check drives the REAL lib/runner.js serveHttp over a real socket and
// writes the body in two segments split inside a two-byte character, which is
// the only way to exercise the boundary — an ordinary fetch() hands the whole
// body over at once and passes even against the broken reader. (Measured: the
// same payload sent via fetch round-trips fine; only the deliberate split
// catches it.)
//
// Run: node test/body-utf8.check.mjs
import net from 'node:net'
import { serveHttp } from '../lib/runner.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// serveHttp() returns nothing, so a caller can neither close it nor ask which
// port it got. Probe for a free one first rather than hard-coding: a fixed port
// makes the check fail with EADDRINUSE (not a data verdict) whenever a previous
// run is still around, and this process exits without closing its server.
const PORT = await new Promise((resolve) => {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

let seen = null
serveHttp({ '/echo': async (payload) => { seen = payload; return { ok: true } } }, PORT)
await sleep(150)

// Both a 2-byte character and a 4-byte one (emoji), plus ASCII either side so a
// truncation at the wrong end is visible in the diff rather than silent.
const note = 'before-é-🏋️-after'
const payload = Buffer.from(JSON.stringify({ note }), 'utf8')

// Split inside the 'e-acute' (C3 A9): head ends on its lead byte.
const cut = payload.indexOf(0xc3) + 1
if (cut <= 0 || cut >= payload.length) {
  console.log('FAIL body-utf8: fixture has no multi-byte character to split on')
  process.exit(1)
}

await new Promise((resolve) => {
  // A check that hangs is worse than one that fails: it stalls the whole suite
  // with no output. Bound it.
  const watchdog = setTimeout(() => resolve(), 5000)
  const done = () => { clearTimeout(watchdog); resolve() }
  const s = net.connect(PORT, '127.0.0.1', async () => {
    s.write(
      'POST /echo HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n'
      + `Content-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
    )
    s.write(payload.subarray(0, cut))
    // The delay is load-bearing: without it the two writes coalesce into one
    // segment and arrive as a single chunk, which the broken reader handles.
    await sleep(60)
    s.write(payload.subarray(cut))
  })
  // Load-bearing: a net.Socket stays paused until something reads it, and a
  // socket that is never read never reaches 'end' or 'close'. Without this the
  // await below hangs forever instead of failing. (Cost me a while to find.)
  s.on('data', () => {})
  s.on('close', done)
  s.on('error', done)
})

let failures = 0
if (!seen || typeof seen.note !== 'string') {
  failures++
  console.log(`FAIL body-utf8: handler never saw a parsed body (got ${JSON.stringify(seen)})`)
} else if (seen.note !== note) {
  failures++
  console.log('FAIL body-utf8: a body split mid-character was corrupted on the way in')
  console.log(`       sent ${JSON.stringify(note)}`)
  console.log(`       got  ${JSON.stringify(seen.note)}`)
  console.log('       read the body as Buffers and decode once at end — not `body += chunk`')
} else {
  console.log(`ok   body-utf8: a body split inside a multi-byte character round-trips intact (${payload.length} bytes, split at ${cut})`)
}

console.log(failures ? '\nbody-utf8: request bodies corrupt user text' : '\nbody-utf8: no chunk-boundary corruption')
process.exit(failures ? 1 : 0)
