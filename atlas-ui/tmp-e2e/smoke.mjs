import { chromium } from 'playwright'
const b = await chromium.launch({ headless: true })
const ctx0 = await b.newContext();
await ctx0.addInitScript(() => localStorage.setItem('atlas.devMode', '1'));
const pg = await ctx0.newPage()
const errors = []
pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
pg.on('pageerror', (e) => errors.push(String(e)))
await pg.goto('http://localhost:5173', { waitUntil: 'networkidle' })
const createBtn = await pg.$('#create-widget')
const emptyState = await pg.$('.empty')
await pg.click('#customize')
const bodyCz = await pg.evaluate(() => document.body.classList.contains('customizing'))
const paletteItems = await pg.$$eval('.palette__item', (els) => els.map((e) => e.dataset.kind))
const btnLabel = await pg.$eval('#customize span', (e) => e.textContent)
const emptyDrop = await pg.$('.page-empty-drop')
// synthetic palette->empty drop
await pg.evaluate(() => {
  const dt = new DataTransfer()
  const item = document.querySelector('.palette__item[data-kind="card"]')
  const drop = document.querySelector('.page-empty-drop')
  const r = drop.getBoundingClientRect()
  const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
  item.dispatchEvent(new DragEvent('dragstart', opts))
  drop.dispatchEvent(new DragEvent('dragover', opts))
  drop.dispatchEvent(new DragEvent('drop', opts))
  item.dispatchEvent(new DragEvent('dragend', opts))
})
await pg.waitForTimeout(200)
const stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')))
const widgetCount = await pg.$$eval('.pwidget', (els) => els.length)
console.log(JSON.stringify({
  errors, createBtnGone: !createBtn, emptyStateShown: !!emptyState, bodyCz, paletteItems, btnLabel,
  emptyDropShown: !!emptyDrop, storedRows: stored?.rows?.length, widgetCount,
  firstWidget: stored?.rows?.[0]?.cols?.[0]?.lines?.[0]?.widgets?.[0],
}, null, 1))
await b.close()
