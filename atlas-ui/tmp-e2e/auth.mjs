// Headless e2e for the login gate: signup + import, re-login hydration, offline.
// Requires: vite dev on 5173, SSH tunnel to the backend on 8100/8101.
import { chromium } from 'playwright'
import { deepStrictEqual } from 'node:assert'

const URL = (process.env.ATLAS_BASE || 'http://localhost:5173') + '/'
const email = `ui-${Date.now()}@test.local`
const password = 'correct-horse-9'
const sleepState = {
  prefMin: 480, bedtime: '23:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3,
  logs: [{ id: 'sl-ui1', type: 'night', date: '2026-07-05', minutes: 450, start: '23:30', end: '07:00' }],
}

const browser = await chromium.launch()
const results = []
const check = async (name, fn) => {
  try { await fn(); results.push('PASS ' + name); console.log('PASS', name) }
  catch (e) { results.push('FAIL ' + name); console.log('FAIL', name, '-', e.message) }
}

await check('signup + import existing data', async () => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(URL)
  await page.waitForSelector('.auth-card', { timeout: 8000 })
  // seed "existing" local data, then create an account
  await page.evaluate((s) => localStorage.setItem('atlas.sleep.v1', JSON.stringify(s)), sleepState)
  await page.click('.auth-toggle')
  await page.fill('.auth-input[name="email"]', email)
  await page.fill('.auth-input[name="password"]', password)
  await page.click('.auth-submit')
  await page.waitForSelector('[data-act="import"]', { timeout: 10000 })
  await page.click('[data-act="import"]')
  await page.waitForSelector('#auth-gate', { state: 'detached', timeout: 15000 })
  await page.waitForSelector('#nav a', { timeout: 8000 })
  await ctx.close()
})

await check('re-login hydrates imported data', async () => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(URL)
  await page.waitForSelector('.auth-card', { timeout: 8000 })
  await page.fill('.auth-input[name="email"]', email)
  await page.fill('.auth-input[name="password"]', password)
  await page.click('.auth-submit')
  await page.waitForSelector('#auth-gate', { state: 'detached', timeout: 15000 })
  const got = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.sleep.v1')))
  deepStrictEqual(got, sleepState)
  const auth = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.auth.v1')))
  if (!auth?.token) throw new Error('no token stored')
  await ctx.close()
})

await check('continue offline boots the app', async () => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(URL)
  await page.waitForSelector('.auth-offline', { timeout: 8000 })
  await page.click('.auth-offline')
  await page.waitForSelector('#auth-gate', { state: 'detached', timeout: 15000 })
  await page.waitForSelector('#nav a', { timeout: 8000 })
  await ctx.close()
})

await check('live save reaches the server (write hook)', async () => {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(URL)
  await page.waitForSelector('.auth-card', { timeout: 8000 })
  await page.fill('.auth-input[name="email"]', email)
  await page.fill('.auth-input[name="password"]', password)
  await page.click('.auth-submit')
  await page.waitForSelector('#auth-gate', { state: 'detached', timeout: 15000 })
  // mutate a synced key through the hooked setItem, as a plugin would
  await page.evaluate(() => localStorage.setItem('atlas.graph.v1',
    JSON.stringify({ dir: '/tmp/e2e-dir', mode: '3d', mdOnly: true, maxNodes: 500 })))
  await page.waitForTimeout(1500) // debounce 400ms + round trip
  await ctx.close()
  // verify on a fresh session that the server persisted it
  const ctx2 = await browser.newContext()
  const page2 = await ctx2.newPage()
  await page2.goto(URL)
  await page2.waitForSelector('.auth-card', { timeout: 8000 })
  await page2.fill('.auth-input[name="email"]', email)
  await page2.fill('.auth-input[name="password"]', password)
  await page2.click('.auth-submit')
  await page2.waitForSelector('#auth-gate', { state: 'detached', timeout: 15000 })
  const got = await page2.evaluate(() => JSON.parse(localStorage.getItem('atlas.graph.v1')))
  deepStrictEqual(got, { dir: '/tmp/e2e-dir', mode: '3d', mdOnly: true, maxNodes: 500 })
  await ctx2.close()
})

await browser.close()
console.log('---')
const fails = results.filter(r => r.startsWith('FAIL')).length
console.log(`${fails} failures of ${results.length}`)
process.exit(fails ? 1 : 0)
