// Settings → Accounts asks the server for Google status on every visit (the
// flag is a device-local cache, so a second device would otherwise show "not
// connected" until relaunched). The risk that buys is a render loop: refresh →
// render → refresh. This probe proves the page renders and then SETTLES.
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()
await page.addInitScript(() => {
  localStorage.setItem('atlas.auth.v1', '{"offline":true}')
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { email: true }, installed: {} }))
})

// Count re-renders by watching the content root swap its children.
await page.goto(`${BASE}/#/settings/accounts`)
await page.waitForSelector('.page')
await page.evaluate(() => {
  window.__renders = 0
  const root = document.querySelector('#content') || document.querySelector('.page').parentElement
  new MutationObserver(() => { window.__renders++ }).observe(root, { childList: true })
})

console.log('1. the page renders')
ok(await page.locator('.page').count() > 0, 'accounts page rendered')
const text = await page.locator('.page').innerText()
ok(/google|gmail/i.test(text), 'the Google connection row is present')

console.log('2. it settles instead of looping')
await page.waitForTimeout(2500)
const renders = await page.evaluate(() => window.__renders)
ok(renders <= 2, `content re-rendered ${renders} time(s) in 2.5s — no refresh→render loop`)

console.log('3. revisiting the tab is still stable')
await page.goto(`${BASE}/#/settings/appearance`)
await page.waitForTimeout(200)
await page.goto(`${BASE}/#/settings/accounts`)
await page.waitForSelector('.page')
await page.waitForTimeout(1500)
ok(await page.locator('.page').count() > 0, 'accounts page still renders after navigating back')

await ctx.close()
await browser.close()
console.log(`\naccounts-refresh: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
