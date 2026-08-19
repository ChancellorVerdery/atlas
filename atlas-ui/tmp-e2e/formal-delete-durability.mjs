// The reported bug, reproduced end to end: delete a widget while the push
// cannot reach the server, relaunch, and watch the server's older copy put it
// back.
//
// Boot 1: the socket NEVER opens. The delete lands in localStorage and the
//         push can only be queued.
// Boot 2: the socket opens and the server answers sync.pull.all with the
//         ORIGINAL three-widget board — a stale copy, because boot 1's push
//         never arrived.
//
// Before the fix the queue lived only in memory, so boot 2 started empty and
// applied the stale board straight over the delete. The widget came back and
// nothing anywhere reported an error.
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
  seed('atlas.auth.v1', JSON.stringify({ token: 't', userId: USER, email: 'x@y.z' }))
  seed('atlasLastUser', USER)
  seed('atlas.plugins.v1', JSON.stringify({ enabled: { formal: true }, installed: {} }))
  seed('atlas.formal.v1', JSON.stringify({ brothers: 0 }))
  seed('atlas.page.formal.v1', JSON.stringify(board))
  seed('atlas.page.v1', JSON.stringify({ v: 1, rows: [] }))

  const boot = Number(localStorage.getItem('__boot') || 0) + 1
  localStorage.setItem('__boot', String(boot))
  window.__boot = boot
  window.__sent = []

  const out = { sock: null, acked: false }
  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    constructor(url) {
      this.url = url
      this.isInbox = !/outbox/.test(url)
      this.readyState = 0
      if (!this.isInbox) out.sock = this
      if (boot === 1) return // boot 1: the socket never comes up at all
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
      // The stale server: still the ORIGINAL board, because boot 1's push
      // never got through.
      const data = m.code === 'sync.pull.all'
        ? { states: { 'atlas.page.formal.v1': board } }
        : {}
      setTimeout(() => this.reply({ reqId: m.reqId, ok: true, data }), 5)
    }
    close() { this.readyState = 3; if (!this.isInbox) out.acked = false; this.onclose && this.onclose() }
  }
  window.WebSocket = FakeWS
}, BOARD)

const ids = () => page.evaluate((k) => {
  try {
    const p = JSON.parse(localStorage.getItem(k)); const out = []
    for (const r of p.rows || []) for (const c of r.cols || []) for (const s of c.sections || []) for (const l of s.lines || []) for (const w of l.widgets || []) out.push(w.id)
    return out
  } catch { return null }
}, KEY)

// ---- boot 1: offline delete -------------------------------------------------
await page.goto(`${BASE}/#/formal`)
await page.waitForSelector('.pwidget', { timeout: 15000 })
console.log('1. boot 1, no socket: delete a widget')
ok(await page.evaluate(() => window.__boot) === 1, 'this is the first boot')
ok((await ids() || []).length === 3, 'three widgets to start')

await page.click('#customize')
await page.waitForTimeout(300)
await page.click('.pwidget[data-widget-id="w-t2"] [data-act="delete-widget"]')
await page.waitForSelector('.confirm-overlay .btn-danger', { timeout: 5000 })
await page.click('.confirm-overlay .btn-danger')
await page.waitForTimeout(900) // past the 400ms debounce

ok(!(await ids() || []).includes('w-t2'), 'deleted locally')
const queued = await page.evaluate(() => { try { return Object.keys(JSON.parse(localStorage.getItem('atlasPendingPushes')) || {}) } catch { return null } })
ok(Array.isArray(queued) && queued.includes(KEY), `the unsent push was written to disk (${JSON.stringify(queued)})`)

// ---- boot 2: socket up, server stale ---------------------------------------
console.log('2. boot 2, socket up, server still has the OLD board')
await page.reload()
await page.waitForSelector('.pwidget', { timeout: 15000 })
await page.waitForTimeout(1500) // connect + pull + flush

const after = await ids() || []
ok(!after.includes('w-t2'), 'the widget stayed deleted — the stale pull did not undo it')
ok(after.length === 2, `two widgets after the relaunch (got ${after.length})`)
ok(await page.locator('.pwidget').count() === 2, 'and the page shows two')

const saves = await page.evaluate((k) => (window.__sent || []).filter((s) => s.code === 'page.save' && s.payload?.storageKey === k), KEY)
ok(saves.length > 0, `the queued push was finally sent (${saves.length} frame(s))`)
const sentIds = []
for (const r of saves[saves.length - 1]?.payload?.value?.rows || []) for (const c of r.cols || []) for (const s of c.sections || []) for (const l of s.lines || []) for (const w of l.widgets || []) sentIds.push(w.id)
ok(sentIds.length === 2 && !sentIds.includes('w-t2'), 'and it carried the DELETED board, not the stale one')

const drained = await page.evaluate(() => localStorage.getItem('atlasPendingPushes'))
ok(drained === null, 'the queue drained once the server acked')

await ctx.close()
await browser.close()
console.log(`\nformal-delete-durability: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
