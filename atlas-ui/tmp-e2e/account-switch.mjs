// The server owns a profile; the browser only caches it. Two properties:
//   1. Opening a DIFFERENT account in a browser must not inherit the previous
//      account's cached data (and must not offer to upload it, either).
//   2. Opening the SAME account in a clean browser must pull everything back.
// Real signups against the live backend. The per-IP limit is 10 auth calls /
// 10 min; this suite spends 4 (signup A, logout, signup B, login A).
// Run: node tmp-e2e/account-switch.mjs [base-url]
import { chromium } from 'playwright'
import { strictEqual, ok } from 'node:assert'

const BASE = process.env.ATLAS_BASE || process.argv[2] || 'http://localhost:5173'
const stamp = Date.now()
const emailA = `acctA-${stamp}@test.local`
const emailB = `acctB-${stamp}@test.local`
const PASSWORD = 'correct-horse-9'
const MARKER = `only-account-A-${stamp}`
let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message.split('\n')[0]) }
}

const browser = await chromium.launch()
const navLabels = (page) => page.$$eval('#nav .nav__item .nav__label', (n) => n.map((x) => x.textContent))
const enabledPlugins = (page) => page.evaluate(() => {
  const r = JSON.parse(localStorage.getItem('atlas.plugins.v1') || '{"enabled":{}}')
  return Object.entries(r.enabled || {}).filter(([, v]) => v).map(([k]) => k).sort()
})
const gate = async (ctx) => {
  const page = await ctx.newPage()
  await page.goto(BASE + '/')
  await page.waitForSelector('.auth-card', { timeout: 15000 })
  return page
}
const auth = async (page, email, mode) => {
  if (mode === 'signup') await page.click('.auth-toggle')
  await page.fill('.auth-input[name="email"]', email)
  await page.fill('.auth-input[name="password"]', PASSWORD)
  await page.click('.auth-submit')
}

// ---- account A: sign up on a clean browser, turn on two plugins -------------
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
let page = await gate(ctx)

await check('A: clean-browser signup boots with no plugins', async () => {
  await auth(page, emailA, 'signup')
  await page.waitForSelector('#nav a', { timeout: 25000 })
  strictEqual((await navLabels(page)).join(','), 'Dashboard,Settings')
})

await check('A: enabling plugins syncs to the server', async () => {
  // Through the hooked setItem, exactly as the Settings toggles write it.
  // MARKER is a value only account A can have: boot-time code legitimately
  // recreates some atlas.* keys for whoever is logged in (email.js's
  // refreshGoogleStatus caches the Google status under atlas.email.v1), so
  // "did A's data survive?" has to be asked about content, not key presence.
  await page.evaluate((marker) => {
    localStorage.setItem('atlas.plugins.v1',
      JSON.stringify({ enabled: { gym: true, work: true }, installed: {} }))
    localStorage.setItem('atlas.study.v1', JSON.stringify({ marker }))
  }, MARKER)
  await page.waitForTimeout(1800) // 400ms debounce + round trip
  await page.reload()
  await page.waitForSelector('#nav a', { timeout: 25000 })
  const labels = await navLabels(page)
  ok(labels.includes('Gym') && labels.includes('Work'), `nav: ${labels.join(',')}`)
})

// ---- switch accounts in the SAME browser ------------------------------------
await check('B: signing up a second account drops A\'s cache', async () => {
  await page.evaluate(() => window.atlasLogout())
  await page.waitForSelector('.auth-card', { timeout: 20000 })
  await auth(page, emailB, 'signup')
  // Straight into the app: A's data is not B's to import, so no import card.
  await page.waitForSelector('#nav a', { timeout: 25000 })
  strictEqual((await navLabels(page)).join(','), 'Dashboard,Settings')
})

await check('B: none of A\'s data survives in the browser', async () => {
  strictEqual((await enabledPlugins(page)).join(','), '')
  const hit = await page.evaluate((marker) =>
    Object.keys(localStorage).filter((k) => k.startsWith('atlas.')
      && (localStorage.getItem(k) || '').includes(marker)), MARKER)
  strictEqual(hit.join(','), '', `A's data survived in: ${hit.join(',')}`)
})

await check('B: a reload stays clean (nothing re-migrates)', async () => {
  await page.reload()
  await page.waitForSelector('#nav a', { timeout: 25000 })
  strictEqual((await navLabels(page)).join(','), 'Dashboard,Settings')
})
await ctx.close()

// ---- account A from a clean browser: everything comes back from the server --
await check('A: a different browser pulls A\'s profile from the server', async () => {
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const p2 = await gate(ctx2)
  await auth(p2, emailA, 'login')
  await p2.waitForSelector('#nav a', { timeout: 25000 })
  const labels = await navLabels(p2)
  ok(labels.includes('Gym') && labels.includes('Work'),
    `A's profile did not come back from the server — nav: ${labels.join(',')}`)
  strictEqual((await enabledPlugins(p2)).join(','), 'gym,work')
  // This browser never wrote the marker; the only place it can come from is
  // the server. That is the whole claim: the browser is a cache, not the truth.
  const study = await p2.evaluate(() => localStorage.getItem('atlas.study.v1'))
  ok((study || '').includes(MARKER), `marker did not come back from the server: ${study}`)
  await ctx2.close()
})

await browser.close()
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
