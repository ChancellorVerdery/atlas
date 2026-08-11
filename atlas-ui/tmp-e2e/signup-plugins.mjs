// A NEW account must start with zero plugins enabled — even in a browser that
// already holds Atlas data from a previous profile (which is what makes the
// legacy-evidence migration fire). Real signup against the live backend; the
// per-IP limit is 10 auth calls / 10 min, so this suite spends exactly 2.
// Run: node tmp-e2e/signup-plugins.mjs [base-url]
import { chromium } from 'playwright'
import { strictEqual, ok } from 'node:assert'

const BASE = process.env.ATLAS_BASE || process.argv[2] || 'http://localhost:5173'
const stamp = Date.now()
let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message.split('\n')[0]) }
}

const browser = await chromium.launch()
// Every context starts DIRTY: legacy Atlas data from a "previous user" of this
// browser. Without the signup seed this alone flips all 14 plugins on.
const dirty = async () => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript(() => {
    localStorage.setItem('atlas.gym.v1', JSON.stringify({ workouts: [], logs: [], completions: [] }))
    localStorage.setItem('atlas.work.v1', JSON.stringify({ wage: 12, shifts: [] }))
    localStorage.setItem('atlas.page.v1', '{"v":1,"rows":[]}')
  })
  const page = await ctx.newPage()
  await page.goto(BASE + '/')
  await page.waitForSelector('.auth-card', { timeout: 15000 })
  return { ctx, page }
}
const signup = async (page, email) => {
  await page.click('.auth-toggle')
  await page.fill('.auth-input[name="email"]', email)
  await page.fill('.auth-input[name="password"]', 'correct-horse-9')
  await page.click('.auth-submit')
}
const navLabels = (page) => page.$$eval('#nav .nav__item .nav__label', (n) => n.map((x) => x.textContent))

// ---- 1. signup + "Start fresh" → no plugins --------------------------------
{
  const { ctx, page } = await dirty()
  await signup(page, `plug-fresh-${stamp}@test.local`)
  await check('dirty browser offers the import card on signup', async () => {
    await page.waitForSelector('[data-act="fresh"]', { timeout: 20000 })
  })
  await check('Start fresh → new account has ZERO plugins enabled', async () => {
    await page.click('[data-act="fresh"]')
    await page.waitForSelector('#nav a', { timeout: 20000 })
    strictEqual((await navLabels(page)).join(','), 'Dashboard,Settings')
    const reg = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.plugins.v1')))
    strictEqual(Object.values(reg.enabled).filter(Boolean).length, 0, JSON.stringify(reg.enabled))
  })
  await check('the empty registry survives a reload (migration cannot re-fire)', async () => {
    await page.reload()
    await page.waitForSelector('#nav a', { timeout: 20000 })
    strictEqual((await navLabels(page)).join(','), 'Dashboard,Settings')
  })
  await ctx.close()
}

// ---- 2. signup + "Import everything" → plugins for the imported data --------
{
  const { ctx, page } = await dirty()
  await signup(page, `plug-import-${stamp}@test.local`)
  await check('Import everything → imported profile lights up its plugins', async () => {
    await page.waitForSelector('[data-act="import"]', { timeout: 20000 })
    await page.click('[data-act="import"]')
    await page.waitForSelector('#nav a', { timeout: 25000 })
    const labels = await navLabels(page)
    ok(labels.includes('Gym') && labels.includes('Work'),
      `imported data landed invisible — nav: ${labels.join(',')}`)
  })
  await ctx.close()
}

await browser.close()
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
