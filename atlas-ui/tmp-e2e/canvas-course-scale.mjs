// Per-course letter-ladder picker (Canvas → Settings → Courses).
// Proves the control renders, persists to atlas.canvas.v1.scaleModes, and that
// clearing it removes the key rather than storing an empty string.
// Run: node tmp-e2e/canvas-course-scale.mjs   (needs the dev server on 5173)
import { chromium } from 'playwright'

const COURSES = [
  { id: 101, name: 'Statics', course_code: 'MEGR-2141', enrollments: [{ type: 'student', computed_current_score: 90, computed_current_grade: 'A-' }] },
  { id: 102, name: 'Calculus III', course_code: 'MATH-2241', enrollments: [{ type: 'student', computed_current_score: 90, computed_current_grade: 'A-' }] },
]

const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } })
// seed ONCE — addInitScript runs on every navigation, so an unguarded seed
// would wipe the very setting the reload is meant to prove survived
await ctx.addInitScript(() => {
  if (localStorage.getItem('atlas.auth.v1')) return
  localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { canvas: true }, installed: {} }))
  localStorage.setItem('atlas.canvas.v1', JSON.stringify({ host: 'example.instructure.com', token: 'x', scale: 'plusminus' }))
})
// stand in for the Canvas REST API
await ctx.route('**/canvas-proxy/**', (route) => {
  const u = route.request().url()
  const body = /\/courses\?|\/courses$/.test(u) || /\/courses\b/.test(u) ? COURSES : []
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
})
const pg = await ctx.newPage()
await pg.goto('http://localhost:5173/#/canvas/settings', { waitUntil: 'domcontentloaded' })
await pg.waitForSelector('[data-cv-scalemode]', { timeout: 15000 })

let bad = 0
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) bad++ }

const selects = await pg.$$eval('[data-cv-scalemode]', els => els.map(e => ({ id: e.dataset.cvScalemode, value: e.value, opts: [...e.options].map(o => o.value) })))
check(selects.length === COURSES.length, `one ladder picker per course (got ${selects.length})`)
check(selects.every(s => s.value === ''), 'every course starts on "default" (inherit)')
check(selects[0]?.opts.join(',') === ',plusminus,letters', `options are default/plusminus/letters (got ${selects[0]?.opts})`)

// set course 101 to letters-only
await pg.selectOption('[data-cv-scalemode="101"]', 'letters')
await pg.waitForTimeout(200)
let stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('atlas.canvas.v1')).scaleModes)
check(stored?.['101'] === 'letters', `picking a ladder persists (got ${JSON.stringify(stored)})`)
check(stored?.['102'] === undefined, 'the other course is untouched')

// the choice survives a reload, and the control shows it
await pg.reload({ waitUntil: 'domcontentloaded' })
await pg.waitForSelector('[data-cv-scalemode]', { timeout: 15000 })
const reValue = await pg.$eval('[data-cv-scalemode="101"]', e => e.value)
check(reValue === 'letters', `the picker reflects the stored ladder after a reload (got "${reValue}")`)

// back to default removes the key rather than storing ''
await pg.selectOption('[data-cv-scalemode="101"]', '')
await pg.waitForTimeout(200)
stored = await pg.evaluate(() => JSON.parse(localStorage.getItem('atlas.canvas.v1')).scaleModes)
check(!('101' in (stored || {})), `"default" deletes the key rather than storing '' (got ${JSON.stringify(stored)})`)

// course grades render to two decimals
await pg.goto('http://localhost:5173/#/canvas', { waitUntil: 'domcontentloaded' })
await pg.waitForTimeout(1500)
const pcts = await pg.$$eval('.cv-card__pct, .cv-cgrade', els => els.map(e => e.textContent.trim()))
const shown = pcts.filter(t => /%/.test(t))
check(shown.length > 0 && shown.every(t => /\d+\.\d{2}%/.test(t)), `course grades show two decimals (got ${JSON.stringify(shown)})`)

console.log(bad ? `\n${bad} check(s) failed` : '\ncanvas-course-scale: all checks passed')
await b.close()
process.exit(bad ? 1 : 0)
