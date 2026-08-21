// The off-canvas nav drawer — the ONLY way to change page on a phone, and the
// one thing whose failure makes the app unusable rather than merely ugly.
// Checks it opens, that every enabled page is reachable and tappable inside the
// viewport, that tapping one navigates AND closes the drawer, and that the
// scrim closes it again.
// Run: node tmp-e2e/mobile-nav.mjs
import { webkit } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
const PLUGINS = ['calendar', 'canvas', 'email', 'equations', 'formal', 'flashcards',
  'gym', 'ladder', 'notes', 'sleep', 'study', 'work']
let passed = 0, failed = 0
const ok = (c, n) => { if (c) { passed++; console.log(`  ok ${n}`) } else { failed++; console.log(`  FAIL ${n}`) } }

const b = await webkit.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 3, hasTouch: true })
await ctx.addInitScript((plugins) => {
  localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: Object.fromEntries(plugins.map((p) => [p, true])), installed: {} }))
  window.__ATLAS_NATIVE__ = { platform: 'ios' }
}, PLUGINS)
const page = await ctx.newPage()
await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

const closed = await page.evaluate(() => {
  const s = document.querySelector('.sidebar').getBoundingClientRect()
  return { open: document.body.classList.contains('nav-open'), left: Math.round(s.left), w: Math.round(s.width) }
})
ok(!closed.open && closed.left <= -1, `drawer starts closed and off-canvas (left=${closed.left})`)
ok(await page.locator('#nav-toggle').isVisible(), 'the hamburger is visible on mobile')

await page.click('#nav-toggle')
await page.waitForTimeout(500)

const open = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth
  const s = document.querySelector('.sidebar').getBoundingClientRect()
  const items = [...document.querySelectorAll('.nav__item')].map((a) => {
    const r = a.getBoundingClientRect()
    return { label: (a.innerText || '').trim(), left: Math.round(r.left), right: Math.round(r.right), inView: r.left >= -1 && r.right <= vw + 1 }
  })
  return { vw, open: document.body.classList.contains('nav-open'), left: Math.round(s.left), items, scrim: !!document.querySelector('.nav-scrim') }
})
ok(open.open && open.left >= -1, `drawer slides in on tap (left=${open.left})`)
ok(open.items.length >= 12, `every enabled page is listed (${open.items.length} items)`)
ok(open.items.every((i) => i.inView), `every nav item is inside the viewport (${open.items.filter((i) => !i.inView).map((i) => i.label).join(', ') || 'all in view'})`)
ok(open.scrim, 'a scrim is present to dismiss the drawer')

// Tapping a page navigates and closes the drawer.
await page.evaluate(() => [...document.querySelectorAll('.nav__item')].find((a) => /gym/i.test(a.innerText))?.click())
await page.waitForTimeout(900)
const after = await page.evaluate(() => ({ hash: location.hash, open: document.body.classList.contains('nav-open') }))
ok(after.hash.includes('gym'), `tapping a nav item navigates (hash=${after.hash})`)
ok(!after.open, 'navigating closes the drawer')

// The scrim closes it without navigating.
await page.click('#nav-toggle')
await page.waitForTimeout(400)
await page.evaluate(() => document.querySelector('.nav-scrim')?.click())
await page.waitForTimeout(400)
const scrimmed = await page.evaluate(() => ({ open: document.body.classList.contains('nav-open'), hash: location.hash }))
ok(!scrimmed.open, 'tapping the scrim closes the drawer')
ok(scrimmed.hash.includes('gym'), 'closing via the scrim does not navigate away')

await b.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
