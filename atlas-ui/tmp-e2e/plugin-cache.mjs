// Opening Canvas or Mail should show the last known data at once, not a
// "Loading…" wall while the remote API answers.
//
// Every case here seeds a cache and points Canvas at an unroutable host, so the
// refresh is guaranteed to fail. Anything that renders therefore came from the
// cache — and the failing refresh must not wipe it off the screen.
// Run: node tmp-e2e/plugin-cache.mjs [base-url]
import { chromium } from 'playwright'
import { strictEqual, ok } from 'node:assert'

const BASE = process.env.ATLAS_BASE || process.argv[2] || 'http://localhost:5173'
let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message.split('\n')[0]) }
}

const COURSE = 'CACHED THERMODYNAMICS'
const canvasPayload = {
  courses: [{
    id: 991, name: COURSE, course_code: COURSE, enrollments: [{ type: 'student', computed_current_score: 91.4 }],
  }],
  groups: { 991: [] },
  announcements: [],
  todos: [],
}

const browser = await chromium.launch()
const openApp = async (seed) => {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await ctx.addInitScript((s) => {
    localStorage.setItem('atlas.auth.v1', '{"offline":true}')
    localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { canvas: true }, installed: {} }))
    // A host that cannot resolve: every refresh fails, so only cache can render.
    localStorage.setItem('atlas.canvas.v1', JSON.stringify({ host: 'canvas.invalid.test', token: 'tok-fake' }))
    localStorage.setItem('atlas.page.canvas.v1', JSON.stringify({
      v: 1,
      rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'cvcourses' }] }] }] }] }],
    }))
    if (s.cache) localStorage.setItem('atlasCache.canvas.data', JSON.stringify({ at: Date.now(), value: s.cache }))
  }, seed)
  const page = await ctx.newPage()
  await page.goto(BASE + '/#/canvas')
  return { ctx, page }
}

await check('a cached Canvas page paints without reaching Canvas', async () => {
  const { ctx, page } = await openApp({ cache: canvasPayload })
  // Short window on purpose: this must come from cache, not from a request.
  await page.waitForSelector(`text=${COURSE}`, { timeout: 4000 })
  await ctx.close()
})

await check('a failed refresh does not wipe the cached view', async () => {
  const { ctx, page } = await openApp({ cache: canvasPayload })
  await page.waitForSelector(`text=${COURSE}`, { timeout: 4000 })
  // Let the (doomed) refresh settle, then confirm the course survived it.
  await page.waitForTimeout(6000)
  ok(await page.locator(`text=${COURSE}`).count() > 0, 'cached data was replaced by the refresh error')
  await ctx.close()
})

await check('with no cache the page still reports the failure', async () => {
  const { ctx, page } = await openApp({ cache: null })
  strictEqual(await page.locator(`text=${COURSE}`).count(), 0)
  // Nothing cached, so the user must be told rather than left on a spinner.
  await page.waitForFunction(() => {
    const t = document.querySelector('.cv-mount')?.textContent || ''
    return t && !t.includes('Loading')
  }, { timeout: 20000 })
  await ctx.close()
})

await check('cached remote data is never pushed to the server', async () => {
  const { ctx, page } = await openApp({ cache: canvasPayload })
  await page.waitForSelector(`text=${COURSE}`, { timeout: 4000 })
  // sync.js only pushes keys starting with 'atlas.' — the cache prefix must
  // stay outside that namespace, or every launch would upload Canvas grades.
  const leaks = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('atlas.') && (localStorage.getItem(k) || '').includes('CACHED THERMODYNAMICS')))
  strictEqual(leaks.join(','), '', `cache leaked into synced keys: ${leaks.join(',')}`)
  await ctx.close()
})

await browser.close()
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
