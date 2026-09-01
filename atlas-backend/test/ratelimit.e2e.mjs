// Rate-limit e2e against the LIVE backend (run from any machine: node >= 22).
// Exercises each limit class once. NOTE: consumes this IP's auth allowance
// (10/10min) — real logins from this IP may be limited for up to 10 minutes.
const HOST = 'https://sync.myatlasapp.net'
const WSS = 'wss://sync.myatlasapp.net'
let pass = 0, fail = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`)
  ok ? pass++ : fail++
}

const openWS = (path) => new Promise((resolve, reject) => {
  const ws = new WebSocket(WSS + path)
  ws.closed = new Promise(r => ws.addEventListener('close', e => r(e.code)))
  ws.onopen = () => resolve(ws)
  ws.onerror = () => reject(new Error('ws error ' + path))
})
const nextMsg = (ws, ms = 10000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout waiting for message')), ms)
  ws.addEventListener('message', e => { clearTimeout(t); resolve(JSON.parse(e.data)) }, { once: true })
})
const rpc = async (ws, obj) => { const p = nextMsg(ws); ws.send(JSON.stringify(obj)); return p }

// 1. Internal /deliver must be unreachable through Caddy.
const st = (await fetch(HOST + '/outbox/deliver', { method: 'POST', body: '{}' })).status
check('outbox /deliver blocked externally', st === 404, `status ${st}`)

// 2. Normal flow untouched: hello + a (failed) login round-trip.
const ws1 = await openWS('/inbox')
const h1 = await rpc(ws1, { type: 'hello', sessionId: 't1' })
check('inbox hello ok', h1.type === 'hello' && h1.ok === true)
const login = await rpc(ws1, { reqId: 'r1', code: 'auth.login', payload: { email: 'nobody@example.com', password: 'wrong' } })
check('login round-trips normally', login.ok === false && /invalid email/i.test(login.error), login.error)

// 3. Token-hello guessing throttled (30/min/IP): 31 bad-token hellos.
let helloLimited = false
for (let i = 0; i < 31; i++) {
  const r = await rpc(ws1, { type: 'hello', sessionId: 't1', token: 'guess-' + i })
  if (r.error === 'rate limited') { helloLimited = true; break }
}
check('token-hello guessing rate limited', helloLimited)
ws1.close(); await ws1.closed

// 4. Message flood: one socket blasting junk gets rejected, then dropped.
const ws2 = await openWS('/inbox')
await rpc(ws2, { type: 'hello', sessionId: 't2' })
let malformed = 0, limited = 0
ws2.addEventListener('message', e => {
  const m = JSON.parse(e.data)
  if (m.error === 'malformed JSON') malformed++
  if (m.error === 'rate limited') limited++
})
// 400 clears the 240/10s allowance with enough overflow (>60 rejects) to
// also trip the persistent-flooder disconnect.
for (let i = 0; i < 400; i++) { try { ws2.send('junk') } catch { break } }
const floodClose = await Promise.race([ws2.closed, new Promise(r => setTimeout(() => r('no-close'), 20000))])
check('flood: over-limit messages rejected', limited > 0, `${limited} rejections, ${malformed} parsed`)
check('flood: persistent flooder disconnected', floodClose === 1008, `close ${floodClose}`)

// 5. Concurrent sockets per IP capped at 10: open 12, expect refusals.
const socks = await Promise.all(Array.from({ length: 12 }, () => openWS('/inbox').catch(() => null)))
const codes = await Promise.all(socks.map(ws => ws
  ? Promise.race([ws.closed, new Promise(r => setTimeout(() => r('open'), 3000))])
  : 'err'))
const refused = codes.filter(c => c === 1013).length
check('concurrent connections capped', refused >= 2, `${refused} refused of 12`)
for (const ws of socks) ws?.close()

// 6. Login hammering: attempts beyond 10/10min per IP are cut off.
const ws3 = await openWS('/inbox')
await rpc(ws3, { type: 'hello', sessionId: 't3' })
let authLimited = false
for (let i = 0; i < 11; i++) {
  const r = await rpc(ws3, { reqId: 'a' + i, code: 'auth.login', payload: { email: 'nobody@example.com', password: 'wrong' + i } })
  if (/rate limited/.test(r.error || '')) { authLimited = true; break }
}
check('login attempts rate limited', authLimited)
ws3.close()

console.log(`\n${pass} ok, ${fail} failed`)
process.exit(fail ? 1 : 0)
