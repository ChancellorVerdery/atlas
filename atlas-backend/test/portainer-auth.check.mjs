// The Portainer session-signing proxy, executed - not read.
//
// WHY THIS FILE EXISTS. `services/portainer-auth.js` is 134 lines of auth
// surface with, until this file, no behavioural coverage of any kind. It mints
// a Portainer session server-side and attaches it to every proxied request, so
// the browser never holds Portainer credentials. Everything it does - cookie
// stripping, Set-Cookie suppression, single-flight minting, the 401 replay -
// is a rule nothing was checking.
//
// Pass 17 found a real bug in the 401 replay while writing these arms: the
// replay re-piped a request body stream the first attempt had already
// consumed, so any request WITH a body hung until a socket timeout instead of
// recovering. Arms 6 and 7 are that bug and its fix; arm 5 holds the replay
// that always did work, so a fix in one direction cannot silently kill the
// other.
//
// No real Portainer is involved. Each arm stands up its own fake upstream and
// its own proxy on port 0, because the proxy caches a token in closure state
// and a shared instance would let one arm's token decide another arm's result.
//
// Run: node test/portainer-auth.check.mjs
import { strictEqual, ok, match } from 'node:assert'
import http from 'node:http'
import { startPortainerAuth } from '../services/portainer-auth.js'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---- harness ----------------------------------------------------------------
// `handler` sees every non-/api/auth request. `mints` counts tokens actually
// issued, which is how the single-flight arm measures itself. Tokens are named
// jwt-1, jwt-2, ... so an arm can assert WHICH token was used, not merely that
// one was.
async function stack ({ handler, authStatus = 200, authBody = null } = {}) {
  let mints = 0
  const upstream = http.createServer((req, res) => {
    if (req.url === '/api/auth') {
      req.resume()
      return req.on('end', () => {
        if (authStatus !== 200) { res.writeHead(authStatus); return res.end('nope') }
        mints++
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(authBody === null ? JSON.stringify({ jwt: `jwt-${mints}` }) : authBody)
      })
    }
    handler(req, res)
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))

  const proxy = startPortainerAuth({
    port: 0,
    upstream: { host: '127.0.0.1', port: upstream.address().port },
    username: 'u',
    password: 'p',
  })
  await new Promise((r) => proxy.once('listening', r))
  const port = proxy.address().port

  // A hung request is the defect arm 6 exists to catch, so the harness must
  // resolve rather than hang with it - a test that hangs reports nothing.
  const ask = (opts = {}) => new Promise((resolve) => {
    const { method = 'GET', path = '/api/endpoints', headers = {}, body = null } = opts
    const h = { ...headers }
    if (body !== null) h['content-length'] = Buffer.byteLength(body)
    const timer = setTimeout(() => resolve({ status: 'HUNG', body: '', headers: {} }), 2500)
    const rq = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (r) => {
      let d = ''
      r.setEncoding('utf8')
      r.on('data', (c) => { d += c })
      r.on('end', () => { clearTimeout(timer); resolve({ status: r.statusCode, body: d, headers: r.headers }) })
    })
    rq.on('error', (e) => { clearTimeout(timer); resolve({ status: 'ERR', body: e.message, headers: {} }) })
    if (body !== null) rq.write(body)
    rq.end()
  })

  return { ask, mints: () => mints, close: () => { proxy.close(); upstream.close() } }
}

// Echoes back what the upstream actually received, so arms assert on the real
// forwarded request rather than on the proxy's intentions.
const echo = (req, res) => {
  let body = ''
  req.setEncoding('utf8')
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ cookie: req.headers.cookie || '', body, method: req.method }))
  })
}

// ---- arms -------------------------------------------------------------------

await check('a proxied request carries the server-minted session cookie', async () => {
  const s = await stack({ handler: echo })
  try {
    const r = await s.ask()
    strictEqual(r.status, 200)
    strictEqual(JSON.parse(r.body).cookie, 'portainer_api_key=jwt-1')
  } finally { s.close() }
})

await check('a burst of parallel requests mints exactly one token', async () => {
  const s = await stack({ handler: echo })
  try {
    const rs = await Promise.all(Array.from({ length: 8 }, () => s.ask()))
    ok(rs.every((r) => r.status === 200), 'not every parallel request succeeded')
    // Single-flight: the point is a cold start behind an iframe firing a burst.
    strictEqual(s.mints(), 1, `minted ${s.mints()} times for 8 parallel requests`)
    ok(rs.every((r) => JSON.parse(r.body).cookie === 'portainer_api_key=jwt-1'),
      'the burst did not all share one token')
  } finally { s.close() }
})

await check("a stale portainer cookie from the browser is dropped, others kept", async () => {
  const s = await stack({ handler: echo })
  try {
    const r = await s.ask({ headers: { cookie: 'a=1; portainer_api_key=STALE; b=2' } })
    const { cookie } = JSON.parse(r.body)
    ok(!cookie.includes('STALE'), `the stale token survived: ${cookie}`)
    ok(cookie.includes('a=1') && cookie.includes('b=2'), `unrelated cookies were lost: ${cookie}`)
    strictEqual(cookie.match(/portainer_api_key=/g).length, 1, `two portainer cookies sent: ${cookie}`)
  } finally { s.close() }
})

await check("Portainer's own Set-Cookie never reaches the browser", async () => {
  const s = await stack({
    handler: (req, res) => {
      res.writeHead(200, { 'set-cookie': 'portainer_api_key=LEAKED; Path=/', 'content-type': 'text/plain' })
      res.end('hi')
    },
  })
  try {
    const r = await s.ask()
    strictEqual(r.status, 200)
    strictEqual(r.headers['set-cookie'], undefined, 'a Set-Cookie leaked to the browser')
  } finally { s.close() }
})

await check('a 401 on a bodyless request is replayed on a fresh token and succeeds', async () => {
  let dead = true
  const s = await stack({
    handler: (req, res) => {
      // The token minted first is "dead" - a Portainer restart. Anything newer works.
      if (dead && String(req.headers.cookie).includes('jwt-1')) {
        dead = true; req.resume(); res.writeHead(401); return res.end('token died')
      }
      echo(req, res)
    },
  })
  try {
    const r = await s.ask()
    strictEqual(r.status, 200, 'the replay did not recover the request')
    strictEqual(JSON.parse(r.body).cookie, 'portainer_api_key=jwt-2', 'the replay reused the dead token')
    strictEqual(s.mints(), 2, 'the replay did not force a fresh mint')
  } finally { s.close() }
})

await check('a 401 on a request WITH a body answers instead of hanging', async () => {
  // THE BUG. The replay re-piped a body stream the first attempt had already
  // consumed: nothing was written and the stream was never ended, so upstream
  // waited for bytes that could not arrive. Every mutating Docker action
  // (container create, exec, image load) carries a body, and this branch fires
  // exactly when Portainer has restarted - so the tab hung at the one moment
  // the retry existed to rescue. Asserting "not HUNG" is the whole arm.
  const s = await stack({
    handler: (req, res) => {
      if (String(req.headers.cookie).includes('jwt-1')) {
        req.resume(); res.writeHead(401); return res.end('token died')
      }
      echo(req, res)
    },
  })
  try {
    const r = await s.ask({ method: 'POST', path: '/api/containers/create', body: '{"Image":"nginx"}' })
    ok(r.status !== 'HUNG', 'a POST that hit the 401 replay hung with no response')
    strictEqual(r.status, 401, `expected Portainer's own 401 to surface, got ${r.status}`)
  } finally { s.close() }
})

await check('after that 401, the very next request is on a fresh token', async () => {
  // The body request cannot be replayed, but it must not leave the proxy stuck
  // on a token it just watched die. Recovery lands on the NEXT request, with no
  // wait - not "eventually, once a refresh happens to finish".
  const s = await stack({
    handler: (req, res) => {
      if (String(req.headers.cookie).includes('jwt-1')) {
        req.resume(); res.writeHead(401); return res.end('token died')
      }
      echo(req, res)
    },
  })
  try {
    strictEqual((await s.ask({ method: 'POST', body: 'x' })).status, 401)
    const r = await s.ask()                       // deliberately no delay
    strictEqual(r.status, 200, 'the next request was still using the dead token')
    strictEqual(JSON.parse(r.body).cookie, 'portainer_api_key=jwt-2')
  } finally { s.close() }
})

await check('a request body is forwarded intact on the normal path', async () => {
  const s = await stack({ handler: echo })
  try {
    const r = await s.ask({ method: 'POST', body: '{"Image":"nginx"}' })
    strictEqual(r.status, 200)
    const got = JSON.parse(r.body)
    strictEqual(got.body, '{"Image":"nginx"}', 'the body was mangled in transit')
    strictEqual(got.method, 'POST')
  } finally { s.close() }
})

await check('a mint failure proxies unauthenticated rather than breaking the tab', async () => {
  // Documented behaviour: Portainer shows its own login, which is the
  // pre-existing experience. What must NOT happen is a 502 or a hang.
  const s = await stack({ handler: echo, authStatus: 500 })
  try {
    const r = await s.ask({ headers: { cookie: 'a=1' } })
    strictEqual(r.status, 200, 'a mint failure broke the proxy instead of passing through')
    const { cookie } = JSON.parse(r.body)
    ok(!cookie.includes('portainer_api_key'), `a session cookie was attached without a token: ${cookie}`)
    strictEqual(cookie, 'a=1', 'the browser request was not passed through as-is')
  } finally { s.close() }
})

await check('an auth response with no jwt is treated as a failure, not as a token', async () => {
  const s = await stack({ handler: echo, authBody: JSON.stringify({ jwt: '' }) })
  try {
    const r = await s.ask()
    strictEqual(r.status, 200)
    ok(!JSON.parse(r.body).cookie.includes('portainer_api_key='),
      'an empty jwt was attached as a session cookie')
  } finally { s.close() }
})

await check('an upstream that is not running answers 502, not a hang', async () => {
  const s = await stack({ handler: echo })
  s.close()                                        // Portainer is down; the proxy is not
  const proxy = startPortainerAuth({
    port: 0, upstream: { host: '127.0.0.1', port: 1 }, username: 'u', password: 'p',
  })
  await new Promise((r) => proxy.once('listening', r))
  try {
    const r = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'HUNG', body: '' }), 2500)
      const rq = http.request({ host: '127.0.0.1', port: proxy.address().port, path: '/api/endpoints' }, (x) => {
        let d = ''; x.on('data', (c) => { d += c })
        x.on('end', () => { clearTimeout(timer); resolve({ status: x.statusCode, body: d }) })
      })
      rq.on('error', (e) => { clearTimeout(timer); resolve({ status: 'ERR', body: e.message }) })
      rq.end()
    })
    strictEqual(r.status, 502, `expected 502 when Portainer is down, got ${r.status}`)
    match(r.body, /not running/)
  } finally { proxy.close() }
})

console.log(failures ? `portainer-auth.check: ${failures} FAILURES` : 'portainer-auth.check: all good')
process.exit(failures ? 1 : 0)
