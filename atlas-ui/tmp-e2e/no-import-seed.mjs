// A fresh device must not INVENT plugin data.
//
// Regression for real data loss: renderer.js used to fetch /gym-import.json (and
// course/equations siblings) whenever the matching store looked empty, and write
// the fixture straight into localStorage — which the sync hook then pushed. The
// fetch is started while bootApp() imports renderer.js, i.e. BEFORE
// hydrateInBackground() begins, so a 6KB local file beat the WebSocket pull
// every time. The gym seed did a full replace, so a device booting with an empty
// store overwrote the server's real gym blob with a fixture carrying 0 logs,
// 0 completions and cycle position 0.
//
// This asserts the two things that made that possible are gone: the fixtures are
// not served, and a boot with an empty gym store leaves it empty.
// Run: node tmp-e2e/no-import-seed.mjs
import { webkit } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (c, n) => { if (c) { passed++; console.log(`  ok ${n}`) } else { failed++; console.log(`  FAIL ${n}`) } }

// 1. The fixtures must not be served at all.
for (const f of ['gym-import.json', 'course-import.json', 'equations-import.json']) {
  const r = await fetch(`${BASE}/${f}`).catch(() => null)
  // A dev server may answer the SPA fallback (200 HTML) for unknown paths, so
  // "not served" means "not JSON", not merely "not 404".
  let isJson = false
  if (r && r.ok) { try { await r.clone().json(); isJson = true } catch { isJson = false } }
  ok(!isJson, `${f} is not served as JSON (status ${r ? r.status : 'no response'})`)
}

// 2. A boot with an empty gym store must leave it empty.
const b = await webkit.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
await ctx.addInitScript(() => {
  localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({
    enabled: { gym: true, course: true, equations: true }, installed: {} }))
  // Deliberately NO atlas.gym.v1 — this is the fresh-device state that used to
  // trigger the import.
})
const page = await ctx.newPage()
await page.goto(`${BASE}/#/gym`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2500) // longer than any fixture fetch would need

const after = await page.evaluate(() => {
  const read = (k) => { try { return JSON.parse(localStorage.getItem(k)) } catch { return null } }
  const g = read('atlas.gym.v1')
  const c = read('atlas.course.v1')
  return {
    gymKeyPresent: localStorage.getItem('atlas.gym.v1') !== null,
    workouts: g?.workouts?.length ?? 0,
    exercises: g?.exercises?.length ?? 0,
    courses: c?.courses?.length ?? 0,
    eqFlag: localStorage.getItem('atlas.eqimport.v3'),
  }
})
console.log('  state after boot:', JSON.stringify(after))
ok(after.workouts === 0, `no workouts invented on a fresh device (got ${after.workouts})`)
ok(after.exercises === 0, `no exercises invented on a fresh device (got ${after.exercises})`)
ok(after.courses === 0, `no courses invented on a fresh device (got ${after.courses})`)
ok(after.eqFlag === null, 'no equations-import flag written on a fresh device')

await b.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
