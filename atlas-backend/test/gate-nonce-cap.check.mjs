// The gate's outstanding-challenge ceiling, executed - not read.
//
// WHY THIS FILE EXISTS. Pass 13 found, and Passes 13 and 14 carried as a lead,
// that gate.js's nonce Map is unbounded and is fed by UNAUTHENTICATED requests:
// every GET to a gated host that arrives without a valid cookie is answered
// with a challenge page, and every challenge page mints a nonce with a ONE HOUR
// TTL. The periodic sweep only reclaims entries that have already expired, so a
// client that simply asks for the page in a loop grows the map for a full hour
// before anything at all is returned. That is an unauthenticated memory-growth
// path in the single process standing between the internet and /docker, /db and
// /shell - the same process Pass 14 stopped from dying on an upgrade throw.
//
// Pass 15 caps it: MAX_NONCES (env GATE_MAX_NONCES, default 10_000) with
// oldest-first eviction at issuance. Every nonce carries the same TTL, so
// insertion order IS expiry order - the evicted key is always the one the sweep
// would have reclaimed soonest.
//
// THE CAP IS OBSERVED BEHAVIORALLY, not by reading a counter: the map is module
// private and stays that way. An evicted nonce is indistinguishable from an
// expired one to a caller, which is exactly the property being pinned - the
// gate degrades into "re-run the command", never into a dead process.
//
// GATE_MAX_NONCES is set to 4 here so the arms are four requests long instead
// of ten thousand. That the env var is read at all is itself part of the
// contract this file pins.
//
// Run: node test/gate-nonce-cap.check.mjs
import { strictEqual, ok } from 'node:assert'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---- real keys, real signatures ---------------------------------------------
// Same posture as gate-auth.check.mjs: the happy-path arm below has to prove a
// surviving nonce still VERIFIES, and a hand-rolled blob would share any
// construction mistake with lib/sshsig.js.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-cap-'))
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'cap', '-f', path.join(dir, 'trusted')])
const KEYS = path.join(dir, 'authorized_keys')
fs.writeFileSync(KEYS, fs.readFileSync(path.join(dir, 'trusted.pub'), 'utf8'))
const sign = (message) =>
  execFileSync('ssh-keygen', ['-Y', 'sign', '-f', path.join(dir, 'trusted'), '-n', 'atlas-gate', '-'],
    { input: message }).toString()

// Read at module scope, so all three must be set before the import.
const CAP = 4
process.env.GATE_KEYS = KEYS
process.env.GATE_SECRET = 'test-secret-not-a-real-one'
process.env.GATE_MAX_NONCES = String(CAP)
const { handleRequest } = await import('../services/gate.js')

const gate = http.createServer(handleRequest)
await new Promise((r) => gate.listen(0, '127.0.0.1', r))
const PORT = gate.address().port

const DEV = 'dev.myatlasapp.net'
const req = (opts = {}, body) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path: '/', ...opts,
    headers: { host: DEV, ...(opts.headers || {}) } }, (r2) => {
    let b = ''
    r2.setEncoding('utf8')
    r2.on('data', (c) => { b += c })
    r2.on('end', () => res({ status: r2.statusCode, headers: r2.headers, body: b }))
  })
  r.on('error', rej)
  if (body != null) r.write(body)
  r.end()
})
const post = (form) => {
  const b = new URLSearchParams(form).toString()
  return req({ method: 'POST', path: '/_gate/verify',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(b) } }, b)
}
const nonceFrom = (html) => {
  const m = html.match(/name="nonce" value="([^"]*)"/)
  ok(m, 'challenge page carried no nonce')
  return m[1]
}
// One unauthenticated GET = one minted nonce. This IS the flood, one call at a
// time; nothing here ever presents a cookie.
const flood = async (n) => {
  const out = []
  for (let i = 0; i < n; i++) out.push(nonceFrom((await req()).body))
  return out
}
// A nonce still in the map is consumed by POSTing it; "already used" is the
// gate's single message for used, expired AND evicted.
const stillLive = async (nonce) => !(await post({ nonce, sig: 'not-a-signature' })).body.includes('already used')

try {
  await check('an unauthenticated flood does not grow the map past the cap', async () => {
    // 5x the cap, so a leak of even one-in-five would show.
    const ns = await flood(CAP * 5)
    let live = 0
    for (const n of ns) if (await stillLive(n)) live++
    ok(live <= CAP, `${ns.length} unauthenticated requests left ${live} nonces outstanding, cap is ${CAP}`)
  })

  await check('eviction is oldest-first: the newest challenge survives the flood', async () => {
    const ns = await flood(CAP * 3)
    ok(await stillLive(ns[ns.length - 1]),
      'the nonce the caller is actually holding was evicted - the page would never be completable under load')
  })

  await check('the oldest challenge is the one discarded', async () => {
    const ns = await flood(CAP * 3)
    strictEqual(await stillLive(ns[0]), false, 'the first nonce survived a flood of 3x the cap')
  })

  await check('under the cap nothing is evicted at all', async () => {
    // A fresh gate would be needed to prove "nothing evicted from empty", so
    // this proves the weaker, sufficient thing: CAP consecutive nonces are all
    // simultaneously live. Eviction one-too-eager would break this.
    const ns = await flood(CAP)
    for (const [i, n] of ns.entries()) ok(await stillLive(n), `nonce ${i} of ${CAP} was evicted while under the cap`)
  })

  await check('a surviving nonce still completes the real signature flow', async () => {
    const ns = await flood(CAP * 3)
    const nonce = ns[ns.length - 1]
    const r = await post({ nonce, sig: sign(nonce) })
    strictEqual(r.status, 302, 'the cap broke the happy path: a live nonce no longer verifies')
    ok(/^atlas_gate=/.test(String(r.headers['set-cookie'][0])))
  })

  await check('eviction has not replaced one-shot consumption', async () => {
    const [nonce] = await flood(1)
    const sig = sign(nonce)
    strictEqual((await post({ nonce, sig })).status, 302)
    strictEqual((await post({ nonce, sig })).status, 401, 'a captured signature was accepted twice')
  })

  await check('the cap is configurable and this run is not silently using the default', async () => {
    // If GATE_MAX_NONCES were ignored, the default 10_000 would keep every one
    // of these live and the arm fails - which is what makes every arm above
    // mean what it says.
    const ns = await flood(CAP * 5)
    let live = 0
    for (const n of ns) if (await stillLive(n)) live++
    ok(live < ns.length, `GATE_MAX_NONCES=${CAP} had no effect: all ${ns.length} nonces stayed live`)
  })
} finally {
  gate.close()
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} failing` : '\nall gate nonce-cap checks passed')
process.exit(failures ? 1 : 0)
