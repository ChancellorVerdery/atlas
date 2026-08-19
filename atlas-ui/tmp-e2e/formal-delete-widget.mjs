// Reported: deleting a widget on the Formal page does not stick — after a
// relaunch the widget is back. This drives the real Customize flow (enter,
// delete, confirm) and then RELOADS, which is the part a same-session check
// would miss: the delete looks right on screen either way, and the question is
// only whether the board that comes back off disk agrees.
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
const KEY = 'atlas.page.formal.v1'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const widget = (n) => ({ id: `w-t${n}`, kind: 'fmhouses', house: { name: `House ${n}`, rooms: [] } })
const row = (n) => ({
  id: `r-t${n}`,
  cols: [{ id: `c-t${n}`, sections: [{ id: `s-t${n}`, lines: [{ id: `l-t${n}`, widgets: [widget(n)] }] }] }],
})
const BOARD = { v: 1, rows: [row(1), row(2), row(3)] }

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()

await page.addInitScript((board) => {
  const seed = (k, v) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v) }
  seed('atlas.auth.v1', '{"offline":true}')
  seed('atlas.plugins.v1', JSON.stringify({ enabled: { formal: true }, installed: {} }))
  seed('atlas.formal.v1', JSON.stringify({ brothers: 0 }))
  seed('atlas.page.formal.v1', JSON.stringify(board))
}, BOARD)

const widgetIds = () => page.evaluate((k) => {
  try {
    const p = JSON.parse(localStorage.getItem(k))
    const out = []
    for (const r of p.rows || []) for (const c of r.cols || []) for (const s of c.sections || []) for (const l of s.lines || [])
      for (const w of l.widgets || []) out.push(w.id)
    return out
  } catch { return null }
}, KEY)

await page.goto(`${BASE}/#/formal`)
await page.waitForSelector('.pwidget', { timeout: 15000 })

console.log('1. the board starts with three widgets')
ok((await widgetIds() || []).length === 3, `stored board has ${(await widgetIds() || []).length} widgets`)
ok(await page.locator('.pwidget').count() === 3, 'and three are on screen')

console.log('2. delete one through the real Customize flow')
await page.click('#customize')
await page.waitForTimeout(300)
const target = page.locator('.pwidget[data-widget-id="w-t2"] [data-act="delete-widget"]')
ok(await target.count() > 0, 'the delete control is present in customize mode')
await target.first().click()
await page.waitForSelector('.confirm-overlay .btn-danger', { timeout: 5000 })
await page.click('.confirm-overlay .btn-danger')
await page.waitForTimeout(500)

const afterIds = await widgetIds() || []
ok(!afterIds.includes('w-t2'), 'the widget is gone from the STORED board')
ok(afterIds.length === 2, `two widgets remain in storage (got ${afterIds.length})`)
ok(await page.locator('.pwidget').count() === 2, 'and two on screen')

console.log('3. it survives a relaunch — the actual complaint')
await page.reload()
await page.waitForSelector('.pwidget', { timeout: 15000 })
await page.waitForTimeout(800) // let seeds/migrations/hydration settle
const reloaded = await widgetIds() || []
ok(!reloaded.includes('w-t2'), 'still deleted after reload')
ok(reloaded.length === 2, `still two widgets after reload (got ${reloaded.length})`)
ok(await page.locator('.pwidget').count() === 2, 'and the page renders two')

console.log('4. deleting the last widgets leaves an empty board, not a re-seed')
await page.click('#customize')
await page.waitForTimeout(300)
for (const id of ['w-t1', 'w-t3']) {
  const b = page.locator(`.pwidget[data-widget-id="${id}"] [data-act="delete-widget"]`)
  if (!(await b.count())) continue
  await b.first().click()
  await page.waitForSelector('.confirm-overlay .btn-danger', { timeout: 5000 })
  await page.click('.confirm-overlay .btn-danger')
  await page.waitForTimeout(400)
}
ok((await widgetIds() || []).length === 0, 'board is empty in storage')
await page.reload()
await page.waitForTimeout(1000)
const finalIds = await widgetIds()
ok(finalIds !== null && finalIds.length === 0, `an emptied board stays empty after reload (got ${finalIds === null ? 'missing key' : finalIds.length})`)

await ctx.close()
await browser.close()
console.log(`\nformal-delete-widget: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
