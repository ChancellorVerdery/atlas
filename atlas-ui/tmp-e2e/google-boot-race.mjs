// The bug: on the WARM-CACHE launch path (main.js — `await bootApp()` runs
// BEFORE hydrateInBackground even starts connecting) renderer.js called
// refreshGoogleStatus() while sockets.inbox was still null. sync.request
// rejects outright when the socket isn't OPEN, refreshGoogleStatus swallows it,
// and every Google page showed "Connect Google" for the rest of the session
// even though the server held a live connection.
//
// No backend needed: window.WebSocket is replaced with a fake that opens LATE
// (after the app has painted), so the boot-time call is guaranteed to lose —
// exactly the launch this reproduces. Then the fake goes online and the app
// must correct itself.
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
const ADDR = 'alex.morgan@example.com'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()

await page.addInitScript((addr) => {
  const USER = 'user-1'
  // Warm-cache launch: a token session, this account's cache already present.
  localStorage.setItem('atlas.auth.v1', JSON.stringify({ token: 't', userId: USER, email: addr }))
  localStorage.setItem('atlasLastUser', USER)
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { email: true, calendar: true }, installed: {} }))
  localStorage.setItem('atlas.page.v1', JSON.stringify({ v: 1, rows: [] }))
  // The stale cache that causes the wrong screen: server says connected, this says no.
  localStorage.setItem('atlas.email.v1', JSON.stringify({ pinned: [], splitPct: 42, accounts: [], connected: false }))

  const OPEN_DELAY = 700 // paint first, connect later — the real launch order
  const sockets = []
  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    constructor(url) {
      this.url = url; this.readyState = 0
      sockets.push(this)
      setTimeout(() => {
        this.readyState = 1
        window.__wsOpenedAt = performance.now()
        this.onopen && this.onopen()
      }, OPEN_DELAY)
    }
    deliver(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }) }
    send(raw) {
      let m; try { m = JSON.parse(raw) } catch { return }
      if (m.type === 'hello') return this.deliver({ type: 'hello', ok: true, userId: USER, email: addr })
      if (!m.reqId) return
      const data =
        m.code === 'sync.pull.all' ? { states: {} }
        : m.code === 'google.auth.status' ? { connected: true, address: addr, accounts: [addr] }
        : m.code === 'google.config' ? { clientId: 'x.apps.googleusercontent.com', scopes: 's', configured: true }
        : m.code === 'google.api' ? { items: [] }
        : {}
      setTimeout(() => this.deliver({ reqId: m.reqId, ok: true, data }), 5)
    }
    close() { this.readyState = 3; this.onclose && this.onclose() }
  }
  window.WebSocket = FakeWS
}, ADDR)

const connectedFlag = () => page.evaluate(() => {
  try { return !!JSON.parse(localStorage.getItem('atlas.email.v1')).connected } catch { return null }
})

await page.goto(`${BASE}/#/calendar`)
await page.waitForSelector('.mail-connect__title, .cal-grid, .page', { timeout: 15000 })

console.log('1. the launch state this reproduces (socket not up yet)')
ok(await connectedFlag() === false, 'cache still says NOT connected while the socket is down')
ok(await page.locator('.mail-connect__title').count() > 0, 'Calendar shows its "Connect Google" gate — the wrong screen')

console.log('2. the socket comes online — the app must correct itself')
await page.waitForFunction(() => {
  try { return !!JSON.parse(localStorage.getItem('atlas.email.v1')).connected } catch { return false }
}, null, { timeout: 15000 }).catch(() => {})
ok(await connectedFlag() === true, 'status refreshed from the server once sync went online')
await page.waitForTimeout(600) // let the re-render land
ok(await page.locator('.mail-connect__title').count() === 0, 'the "Connect Google" gate is gone without any user action')

console.log('3. it settles (no refresh -> render -> refresh loop)')
const before = await page.evaluate(() => document.body.innerHTML.length)
await page.waitForTimeout(2000)
ok(await connectedFlag() === true, 'still connected 2s later')
ok(Math.abs((await page.evaluate(() => document.body.innerHTML.length)) - before) < 5000, 'DOM is stable, not thrashing')

await ctx.close()
await browser.close()
console.log(`\ngoogle-boot-race: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
