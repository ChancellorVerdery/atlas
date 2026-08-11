// The desktop app must not open on a blank window while it waits for the sync
// server. When this device already holds THIS account's layout, Atlas paints
// from that cache and reconciles behind the app.
//
// Every case here points atlas.backend at a dead endpoint, so "did it render?"
// isolates the boot path with no network in play — and spends zero auth calls.
// Run: node tmp-e2e/warm-boot.mjs [base-url]
import { chromium } from 'playwright'
import { strictEqual, ok } from 'node:assert'

const BASE = process.env.ATLAS_BASE || process.argv[2] || 'http://localhost:5173'
let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message.split('\n')[0]) }
}

const browser = await chromium.launch()
// ws://127.0.0.1:9 is the discard port: refused immediately, never listening.
const DEAD = { inbox: 'ws://127.0.0.1:9/inbox', outbox: 'ws://127.0.0.1:9/outbox' }

const boot = async (seed) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript((s) => {
    localStorage.setItem('atlas.backend', JSON.stringify(s.dead))
    localStorage.setItem('atlas.auth.v1', JSON.stringify({ token: 't-fake', userId: s.user, email: 'warm@test.local' }))
    if (s.lastUser) localStorage.setItem('atlasLastUser', s.lastUser)
    if (s.layout) {
      localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { gym: true, work: true }, installed: {} }))
      localStorage.setItem('atlas.page.v1', JSON.stringify({ v: 1, rows: [] }))
    }
  }, { ...seed, dead: DEAD })
  const page = await ctx.newPage()
  await page.goto(BASE + '/')
  return { ctx, page }
}
const navLabels = (page) => page.$$eval('#nav .nav__item .nav__label', (n) => n.map((x) => x.textContent))

// ---- 1. warm cache + unreachable server -> the app still opens ---------------
await check('warm cache boots the app with the server unreachable', async () => {
  const { ctx, page } = await boot({ user: 'u-warm', lastUser: 'u-warm', layout: true })
  // Well under main.js's 6s connect deadline: if this only passed after 6s it
  // would prove the blocking path ran, which is the bug being guarded against.
  await page.waitForSelector('#nav a', { timeout: 4000 })
  const labels = await navLabels(page)
  ok(labels.includes('Gym') && labels.includes('Work'),
    `cached layout was not used — nav: ${labels.join(',')}`)
  strictEqual(await page.locator('.auth-card').count(), 0, 'login gate rendered over the cache')
  await ctx.close()
})

// ---- 2. no cached layout -> the blocking path is unchanged -------------------
await check('cold cache still waits, then offers the login gate', async () => {
  const { ctx, page } = await boot({ user: 'u-cold', lastUser: 'u-cold', layout: false })
  strictEqual(await page.locator('#nav a').count(), 0, 'booted with nothing cached to boot from')
  await page.waitForSelector('.auth-card', { timeout: 15000 })
  await ctx.close()
})

// ---- 3. cache belongs to someone else -> never painted ----------------------
await check("another account's cache is never fast-booted", async () => {
  const { ctx, page } = await boot({ user: 'u-me', lastUser: 'u-SOMEONE-ELSE', layout: true })
  // The warm path is skipped, so this falls to the blocking path and, with the
  // server unreachable, ends at the gate — never showing the other account's nav.
  await page.waitForSelector('.auth-card', { timeout: 15000 })
  strictEqual(await page.locator('#nav a').count(), 0, "rendered another account's cached layout")
  await ctx.close()
})

await browser.close()
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
