// The bug: Atlas talks over TWO sockets — a request goes OUT on the inbox but
// its result comes BACK on the outbox — and they hello-ack independently. sync
// flipped status to 'online' on the INBOX ack alone, so the boot-time
// refreshGoogleStatus() fired while the outbox was still unregistered, the
// server dropped the reply, and the request sat there until its 30s timeout.
// Email/Calendar showed "Connect Google" until something re-asked later (the
// Settings → Accounts visit), even though the server held a live connection.
//
// No backend needed: window.WebSocket is replaced with a fake that models the
// real split — the outbox opens LATER than the inbox, request results are
// delivered ONLY on the outbox, and a result produced before the outbox has
// hello-acked is DROPPED, exactly as the server drops it.
//
// This is what the previous version of this probe missed: it answered every
// request on whichever socket sent it, so the outbox gap could not exist.
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

  const INBOX_OPEN = 500   // paint first, connect later — the real launch order
  const OUTBOX_LAG = 650   // ...and the outbox trails the inbox, as it does live
  const out = { sock: null, acked: false }
  window.__dropped = 0     // replies the "server" had nowhere to send

  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    constructor(url) {
      this.url = url
      this.isInbox = !/outbox/.test(url)
      this.readyState = 0
      if (!this.isInbox) out.sock = this
      setTimeout(() => {
        this.readyState = 1
        this.onopen && this.onopen()
      }, this.isInbox ? INBOX_OPEN : INBOX_OPEN + OUTBOX_LAG)
    }
    deliver(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }) }
    // A result can only reach the app down a REGISTERED outbox. Anything else
    // is dropped on the floor server-side — no queue, no retry.
    reply(obj) {
      if (out.sock && out.acked && out.sock.readyState === 1) out.sock.deliver(obj)
      else window.__dropped++
    }
    send(raw) {
      let m; try { m = JSON.parse(raw) } catch { return }
      if (m.type === 'hello') {
        if (!this.isInbox) out.acked = true
        return this.deliver({ type: 'hello', ok: true, userId: USER, email: addr })
      }
      if (!m.reqId) return
      const data =
        m.code === 'sync.pull.all' ? { states: {
          // The server's copy of the email store has NO `connected` field (the
          // mapper drops it), so applying it must not clobber a fresh refresh.
          'atlas.email.v1': JSON.stringify({ pinned: [], splitPct: 42 }),
        } }
        : m.code === 'google.auth.status' ? { connected: true, address: addr, accounts: [addr] }
        : m.code === 'google.config' ? { clientId: 'x.apps.googleusercontent.com', scopes: 's', configured: true }
        : m.code === 'google.api' ? { items: [] }
        : {}
      setTimeout(() => this.reply({ reqId: m.reqId, ok: true, data }), 5)
    }
    close() { this.readyState = 3; if (!this.isInbox) out.acked = false; this.onclose && this.onclose() }
  }
  window.WebSocket = FakeWS
}, ADDR)

// The connection cache is device-local and lives outside the synced namespace
// (see GOOGLE_KEY in src/page/email.js) precisely so the pull below cannot
// overwrite it.
const connectedFlag = () => page.evaluate(() => {
  try { return !!JSON.parse(localStorage.getItem('atlasGoogle')).connected } catch { return null }
})

await page.goto(`${BASE}/#/calendar`)
await page.waitForSelector('.mail-connect__title, .cal-grid, .page', { timeout: 15000 })

console.log('1. the launch state this reproduces (no socket up yet)')
ok(await connectedFlag() === false, 'cache still says NOT connected while the sockets are down')
ok(await page.locator('.mail-connect__title').count() > 0, 'Calendar shows its "Connect Google" gate — the wrong screen')

// 6s window on purpose: the fix lands ~1.2s in, while a request fired into the
// outbox gap cannot recover before its 30s timeout. No overlap, no flake.
console.log('2. both sockets come up — the app must correct itself, unprompted')
await page.waitForFunction(() => {
  try { return !!JSON.parse(localStorage.getItem('atlasGoogle')).connected } catch { return false }
}, null, { timeout: 6000 }).catch(() => {})
ok(await connectedFlag() === true, 'status refreshed from the server once BOTH sockets were ready')
await page.waitForTimeout(600) // let the re-render land
ok(await page.locator('.mail-connect__title').count() === 0, 'the "Connect Google" gate is gone without any user action')

console.log('3. nothing was fired into the void, and it settles')
ok(await page.evaluate(() => window.__dropped) === 0, 'no reply was dropped for an unregistered outbox')
const before = await page.evaluate(() => document.body.innerHTML.length)
await page.waitForTimeout(2000)
ok(await connectedFlag() === true, 'still connected 2s later (the pull did not clobber it)')
ok(Math.abs((await page.evaluate(() => document.body.innerHTML.length)) - before) < 5000, 'DOM is stable, not thrashing')

await ctx.close()
await browser.close()
console.log(`\ngoogle-boot-race: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
