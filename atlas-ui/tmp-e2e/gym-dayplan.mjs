// The Gym day-override UI, driven in real WebKit at iPhone metrics (the engine
// the iOS shell actually runs). Covers the delegated <select> change handler,
// which no unit test can reach — gym-plan.check.mjs owns the data rules.
// Run: node tmp-e2e/gym-dayplan.mjs
import { webkit } from 'playwright'

// ATLAS_BASE lets a second checkout point this at its own dev server —
// vite is strictPort, so parallel agents cannot share 5173.
const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const GYM = {
  v: 1,
  workouts: [
    { id: 'gw-push', name: 'Push' },
    { id: 'gw-pull', name: 'Pull' },
    { id: 'gw-legs', name: 'Legs' },
  ],
  exercises: [{ id: 'ge-bench', workoutId: 'gw-push', name: 'Bench Press' }],
  logs: [], completions: [],
  plan: { type: 'cycle', weekly: {}, cycle: { order: ['gw-push', 'gw-pull', 'gw-legs'], position: 0 }, overrides: {} },
  unit: 'lbs',
}

const b = await webkit.launch({ headless: true })
const ctx = await b.newContext({
  viewport: { width: 402, height: 874 }, // iPhone 17 Pro CSS px
  deviceScaleFactor: 3,
  hasTouch: true,
})
await ctx.addInitScript((gym) => {
  localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { gym: true }, installed: {} }))
  localStorage.setItem('atlas.gym.v1', JSON.stringify(gym))
  // The shell's own signal, so isMobile()/is-native-ios take the real iOS path.
  window.__ATLAS_NATIVE__ = { platform: 'ios' }
}, GYM)

const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })

await page.goto(`${BASE}/#/gym`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.gym-pick', { timeout: 15000 })

ok(await page.locator('body.is-mobile').count() === 1, 'iOS shell puts the app in mobile mode')
ok((await page.locator('.gym-big').first().innerText()).trim() === 'Push', 'the cycle starts on Push')
ok(await page.locator('.gym-pick select[data-gym-act="pick"]').count() > 0, 'the day picker renders')
ok(await page.locator('.gym-pick button[data-gym-act="skip"]').count() > 0, 'the skip button renders')

// --- choose a specific workout for today ---
await page.selectOption('.gym-pick select[data-gym-act="pick"]', 'gw-legs')
await page.waitForFunction(() => document.querySelector('.gym-big')?.textContent.trim() === 'Legs', null, { timeout: 5000 })
ok(true, 'choosing Legs switches today to Legs')
ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.gym.v1')).plan.cycle.position) === 0,
  'choosing a workout does not move the cycle position')

// --- skip the day ---
await page.click('.gym-pick button[data-gym-act="skip"]')
await page.waitForSelector('[data-gym-act="unskip"]', { timeout: 5000 })
ok((await page.locator('.gym-big').first().innerText()).trim() === 'Skipped', 'skipping shows the skipped state')
ok(await page.locator('.gym-log-row').count() === 0, 'a skipped day offers nothing to log')

// --- undo ---
await page.click('[data-gym-act="unskip"]')
await page.waitForFunction(() => document.querySelector('.gym-big')?.textContent.trim() === 'Push', null, { timeout: 5000 })
ok(true, 'undo returns to the planned workout')
ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.gym.v1')).plan.cycle.position) === 0,
  'the cycle position survived skip + undo untouched')

// --- the picker must not overflow the phone's width ---
const overflow = await page.evaluate(() => {
  const el = document.querySelector('.gym-pick')
  const r = el.getBoundingClientRect()
  const vw = document.documentElement.clientWidth
  return { right: Math.round(r.right), vw, docScroll: document.documentElement.scrollWidth > vw + 1 }
})
ok(overflow.right <= overflow.vw + 1, `picker stays inside the viewport (right ${overflow.right} vs ${overflow.vw})`)
ok(!overflow.docScroll, 'the gym page does not scroll sideways on a phone')

await b.close()
if (errs.length) console.log('\n=== console/page errors ===\n' + [...new Set(errs)].join('\n'))
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
