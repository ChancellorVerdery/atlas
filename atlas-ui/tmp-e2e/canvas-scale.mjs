// Per-course grade scale — the one thing the node check can't prove: that the
// settings field writes the store and every grade readout picks it up.
// Canvas's REST API is faked at the network layer (same-origin /canvas-proxy),
// so the real fetch/parse/render/GPA code runs.
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

// 95 → A on every scale; 88 → B+ on the default ± scale, B on a 10-point one.
const COURSES = [
  { id: 101, name: 'Physics II Lab', course_code: 'PHYS 220', enrollments: [{ type: 'student', computed_current_score: 95.0, computed_current_grade: 'A' }] },
  { id: 102, name: 'Linear Algebra', course_code: 'MATH 220', enrollments: [{ type: 'student', computed_current_score: 88.0, computed_current_grade: 'B+' }] },
]
const installFake = (page) => page.route('**/canvas-proxy/**', (route) => {
  const path = new URL(route.request().url()).pathname.replace(/^\/canvas-proxy\/[^/]+\/api\/v1/, '')
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
  if (path === '/users/self') return json({ id: 1, name: 'Chance V' })
  if (path === '/courses') return json(COURSES)
  return json([])
})

const SEED = {
  host: 'school.instructure.com', token: 'tok-123', scale: 'plusminus',
  credits: { 101: 4, 102: 3 }, semesters: [], dismissed: [],
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
const page = await ctx.newPage()
await installFake(page)
await page.addInitScript((s) => {
  localStorage.setItem('atlas.auth.v1', '{"offline":true}')
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { canvas: true }, installed: {} }))
  // guarded: addInitScript re-runs on reload, and the reload check below needs
  // the store the page just wrote, not the seed
  if (!localStorage.getItem('atlas.canvas.v1')) localStorage.setItem('atlas.canvas.v1', JSON.stringify(s))
}, SEED)
await page.goto(`${BASE}/#/canvas`)
await page.waitForSelector('.cv-card')

console.log('1. baseline on the global ± scale')
const letters = () => page.locator('.cv-card__letter').allInnerTexts()
ok((await letters()).join(',') === 'A,B+', 'course cards start at A / B+')
const gpa = () => page.locator('[data-cv-widget="cvgpa"] .cv-gpa__num').nth(1).innerText()
ok(await gpa() === '3.70', `semester GPA 3.70 = (4.0×4 + 3.3×3)/7 (got ${await gpa()})`)

console.log('2. settings field')
await page.click('.page-tab:has-text("Settings")')
await page.waitForSelector('[data-cv-scale="102"]')
ok(await page.locator('[data-cv-scale]').count() === 2, 'a scale field per course')
ok(await page.locator('[data-cv-scale="102"]').inputValue() === '', 'blank by default (= use the global scale)')
await page.fill('[data-cv-scale="102"]', 'A 90, B 80, C 70, D 60')
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.canvas.v1')).scales)
ok(stored['102'] === 'A 90, B 80, C 70, D 60', 'custom scale persisted for that course only')
ok(stored['101'] === undefined, 'the other course keeps no override')
ok((await page.locator('[data-cv-scale="102"]').getAttribute('title')).startsWith('A ≥ 90'), 'title previews the parsed cutoffs')
ok(!(await page.locator('[data-cv-scale="102"]').evaluate((e) => e.classList.contains('cv-bad'))), 'a valid scale is not flagged')

console.log('3. widgets pick it up')
await page.click('.page-tab:has-text("Board")')
await page.waitForSelector('.cv-card')
ok((await letters()).join(',') === 'A,B', 'MATH drops to B on its own 10-point scale, PHYS unchanged')
ok(await gpa() === '3.57', `GPA recomputes to 3.57 = (4.0×4 + 3.0×3)/7 (got ${await gpa()})`)
await page.locator('.cv-pill', { hasText: 'Linear Algebra' }).click()
await page.waitForFunction(() => document.querySelector('[data-cv-widget="cvgradebook"] .cv-pill.is-active')?.textContent === 'Linear Algebra')
ok(await page.locator('.cv-cgrade').innerText() === '88.0% · B', 'gradebook header agrees with the card (not Canvas\'s B+)')

console.log('4. survives reload, and junk falls back')
await page.reload()
await page.waitForSelector('.cv-card')
ok((await letters()).join(',') === 'A,B', 'override survives a reload')
await page.click('.page-tab:has-text("Settings")')
await page.waitForSelector('[data-cv-scale="102"]')
await page.fill('[data-cv-scale="102"]', 'curve is weird')
ok(await page.locator('[data-cv-scale="102"]').evaluate((e) => e.classList.contains('cv-bad')), 'unparseable input is flagged')
await page.click('.page-tab:has-text("Board")')
await page.waitForSelector('.cv-card')
ok((await letters()).join(',') === 'A,B+', 'unparseable scale falls back to the global one')
await page.click('.page-tab:has-text("Settings")')
await page.waitForSelector('[data-cv-scale="102"]')
await page.fill('[data-cv-scale="102"]', '')
ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.canvas.v1')).scales['102']) === undefined, 'clearing the field removes the override')

await ctx.close()
await browser.close()
console.log(`\ncanvas-scale: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
