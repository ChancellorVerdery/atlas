import { chromium } from 'playwright'

const OUT = process.env.OUT
const ROUTES = [
  ['dashboard', '#/dashboard'],
  ['gym', '#/gym'],
  ['gym-settings', '#/gym/settings'],
  ['email', '#/email'],
  ['calendar', '#/calendar'],
  ['canvas', '#/canvas'],
  ['canvas-settings', '#/canvas/settings'],
  ['graph', '#/graph'],
  ['work', '#/work'],
  ['work-settings', '#/work/settings'],
  ['ladder', '#/ladder'],
  ['ladder-settings', '#/ladder/settings'],
  ['sleep', '#/sleep'],
  ['sleep-settings', '#/sleep/settings'],
  ['finance', '#/finance'],
  ['finance-explore', '#/finance/explore'],
  ['finance-settings', '#/finance/settings'],
  ['equations', '#/equations'],
  ['course', '#/course'],
  ['course-explore', '#/course/explore'],
  ['course-settings', '#/course/settings'],
]

const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
await ctx.addInitScript(() => {
  localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
  localStorage.setItem('atlas.devMode', '1')
})
const page = await ctx.newPage()
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))

for (const [name, hash] of ROUTES) {
  await page.goto('http://localhost:5173/' + hash, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  process.stdout.write(`shot ${name}\n`)
}
await b.close()
if (errs.length) { console.log('\n=== console/page errors ===\n' + [...new Set(errs)].join('\n')) }
else console.log('\nno console errors')
