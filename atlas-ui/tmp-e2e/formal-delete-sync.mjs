// The offline probe (formal-delete-widget.mjs) proves the delete reaches
// localStorage. This one asks the next question: does it reach the SERVER?
//
// The server currently holds a 5-widget formal board for the real user while
// the app shows fewer, which means a push is being lost — and on the next
// launch the stale server copy is applied over the good local one, so the
// widget reappears. This runs the authenticated boot path (NOT offline mode,
// which skips sync entirely) behind a fake WebSocket that records every frame.
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
const KEY = 'atlas.page.formal.v1'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const widget = (n) => ({ id: `w-t${n}`, kind: 'fmhouses', house: { name: `House ${n}`, rooms: [] } })
const row = (n) => ({ id: `r-t${n}`, cols: [{ id: `c-t${n}`, sections: [{ id: `s-t${n}`, lines: [{ id: `l-t${n}`, widgets: [widget(n)] }] }] }] })
const BOARD = { v: 1, rows: [row(1), row(2), row(3)] }

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()

await page.addInitScript((board) => {
  const USER = 'user-1'
  const seed = (k, v) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v) }
  // A real signed-in session, so the sync hook is installed and pushes happen.
  seed('atlas.auth.v1', JSON.stringify({ token: 't', userId: USER, email: 'x@y.z' }))
  seed('atlasLastUser', USER)
  seed('atlas.plugins.v1', JSON.stringify({ enabled: { formal: true }, installed: {} }))
  seed('atlas.formal.v1', JSON.stringify({ brothers: 0 }))
  seed('atlas.page.formal.v1', JSON.stringify(board))
  seed('atlas.page.v1', JSON.stringify({ v: 1, rows: [] })) // warm-cache path

  window.__sent = []
  const out = { sock: null, acked: false }
  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    constructor(url) {
      this.url = url
      this.isInbox = !/outbox/.test(url)
      this.readyState = 0
      if (!this.isInbox) out.sock = this
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen() }, this.isInbox ? 60 : 120)
    }
    deliver(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }) }
    reply(o) { if (out.sock && out.acked) out.sock.deliver(o) }
    send(raw) {
      let m; try { m = JSON.parse(raw) } catch { return }
      if (m.type === 'hello') {
        if (!this.isInbox) out.acked = true
        return this.deliver({ type: 'hello', ok: true, userId: USER, email: 'x@y.z' })
      }
      if (!m.reqId) return
      window.__sent.push({ code: m.code, payload: m.payload })
      // Server answers with an EMPTY state map: nothing here may depend on the
      // server echoing the board back.
      const data = m.code === 'sync.pull.all' ? { states: {} } : {}
      setTimeout(() => this.reply({ reqId: m.reqId, ok: true, data }), 5)
    }
    close() { this.readyState = 3; if (!this.isInbox) out.acked = false; this.onclose && this.onclose() }
  }
  window.WebSocket = FakeWS
}, BOARD)

const boardWidgets = () => page.evaluate((k) => {
  try {
    const p = JSON.parse(localStorage.getItem(k)); const out = []
    for (const r of p.rows || []) for (const c of r.cols || []) for (const s of c.sections || []) for (const l of s.lines || []) for (const w of l.widgets || []) out.push(w.id)
    return out
  } catch { return null }
}, KEY)
const pushesFor = () => page.evaluate((k) =>
  (window.__sent || []).filter((s) => s.code === 'page.save' && s.payload?.storageKey === k), KEY)

await page.goto(`${BASE}/#/formal`)
await page.waitForSelector('.pwidget', { timeout: 15000 })
await page.waitForTimeout(1200) // let the socket come up and hydration settle

console.log('1. signed in, socket up, three widgets')
ok((await boardWidgets() || []).length === 3, 'three widgets in storage')
ok(await page.evaluate(() => window.__sent.some((s) => s.code === 'sync.pull.all')), 'the app really did sync (not offline mode)')

console.log('2. delete one and watch the wire')
await page.click('#customize')
await page.waitForTimeout(300)
await page.click('.pwidget[data-widget-id="w-t2"] [data-act="delete-widget"]')
await page.waitForSelector('.confirm-overlay .btn-danger', { timeout: 5000 })
await page.click('.confirm-overlay .btn-danger')
await page.waitForTimeout(1500) // well past PUSH_DEBOUNCE (400ms)

const local = await boardWidgets() || []
ok(!local.includes('w-t2'), 'gone from localStorage')

const pushes = await pushesFor()
ok(pushes.length > 0, `the board was pushed to the server (${pushes.length} page.save frame(s))`)
const last = pushes[pushes.length - 1]
const pushedIds = []
for (const r of last?.payload?.value?.rows || []) for (const c of r.cols || []) for (const s of c.sections || []) for (const l of s.lines || []) for (const w of l.widgets || []) pushedIds.push(w.id)
ok(pushedIds.length === 2, `the pushed board has 2 widgets (got ${pushedIds.length})`)
ok(!pushedIds.includes('w-t2'), 'and the deleted one is not in it')

console.log('3. the push must survive an immediate quit (beforeunload flush)')
await page.evaluate(() => { window.__sent.length = 0 })
// Already in customize mode — #customize is a TOGGLE, so clicking it again
// would leave it and the delete controls would not exist.
await page.waitForSelector('.pwidget[data-widget-id="w-t3"] [data-act="delete-widget"]', { timeout: 5000 })
await page.click('.pwidget[data-widget-id="w-t3"] [data-act="delete-widget"]')
await page.waitForSelector('.confirm-overlay .btn-danger', { timeout: 5000 })
await page.click('.confirm-overlay .btn-danger')
// Reload almost immediately — inside the 400ms debounce window, which is what
// quitting right after a delete looks like.
await page.waitForTimeout(80)
const beforeReload = await pushesFor()
await page.reload()
await page.waitForSelector('.pwidget', { timeout: 15000 })
await page.waitForTimeout(600)
const survived = (await boardWidgets() || [])
ok(!survived.includes('w-t3'), 'a delete followed immediately by a reload still stuck locally')
console.log(`     (frames sent before the reload: ${beforeReload.length})`)

await ctx.close()
await browser.close()
console.log(`\nformal-delete-sync: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
