// Is the GPA available offline, from the device cache?
//
// GPA is not fetched — it is COMPUTED from two things that are already local:
// the courses in atlasCache.canvas.data (their computed_current_score) and the
// credits/semesters/scale in atlas.canvas.v1 (synced Atlas data). So it should
// paint with no network at all. This proves that instead of assuming it.
//
// Canvas points at a host that cannot resolve, so every refresh is guaranteed
// to fail: anything that renders came from the cache.
// Run: node tmp-e2e/gpa-cache.mjs
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || process.argv[2] || 'http://localhost:5173'
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}`) } }

// Two current courses at 95% and 93% → both letter A → 4.0 each, 3 credits each
// (the default) → this semester = 4.00 over 6 credits.
// One past semester entered by hand: 3.00 over 12 credits.
// Overall = (3.00*12 + 4.00*6) / 18 = 3.33.
const canvasPayload = {
  courses: [
    { id: 991, name: 'THERMODYNAMICS', course_code: 'MEGR 3111', enrollments: [{ type: 'student', computed_current_score: 95 }] },
    { id: 992, name: 'DYNAMICS', course_code: 'MEGR 2144', enrollments: [{ type: 'student', computed_current_score: 93 }] },
  ],
  groups: { 991: [], 992: [] },
  announcements: [],
  todos: [],
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await ctx.addInitScript((cache) => {
  localStorage.setItem('atlas.auth.v1', '{"offline":true}')
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { canvas: true }, installed: {} }))
  // Unresolvable host: every refresh fails, so only the cache can render.
  localStorage.setItem('atlas.canvas.v1', JSON.stringify({
    host: 'canvas.invalid.test', token: 'tok-fake', scale: 'plusminus',
    credits: {}, hiddenCourses: [], dismissed: [],
    semesters: [{ id: 's1', name: 'Spring 2026', gpa: '3.00', credits: '12' }],
  }))
  localStorage.setItem('atlas.page.canvas.v1', JSON.stringify({
    v: 1,
    rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'cvgpa' }] }] }] }] }],
  }))
  localStorage.setItem('atlasCache.canvas.data', JSON.stringify({ at: Date.now() - 3 * 86400000, value: cache }))
}, canvasPayload)

const page = await ctx.newPage()
await page.goto(BASE + '/#/canvas')

// Short window on purpose: this has to come from cache, not from a request.
await page.waitForSelector('.cv-gpa', { timeout: 5000 }).catch(() => {})
const nums = await page.locator('.cv-gpa__num').allInnerTexts()
const sub = await page.locator('.cv-gpa').locator('xpath=following-sibling::p[1]').innerText().catch(() => '')
console.log(`   GPA widget: ${JSON.stringify(nums)}  |  ${sub}`)

ok(nums.length === 2, 'the GPA widget rendered with no network at all')
ok(nums[1] === '4.00', `this semester computed from the cached scores (got ${nums[1]})`)
ok(nums[0] === '3.33', `overall blends the cached semester with the stored one (got ${nums[0]})`)
ok(!nums.includes('—'), 'no placeholder dashes — the numbers are real')
ok(sub.includes('18 credits'), `credits total came through (got "${sub.split(' · ')[0]}")`)

// And it must survive the doomed refresh that follows the cached paint.
await page.waitForTimeout(6000)
const after = await page.locator('.cv-gpa__num').allInnerTexts()
ok(JSON.stringify(after) === JSON.stringify(nums), 'the failed Canvas refresh did not wipe the GPA off screen')

await ctx.close()
await browser.close()
console.log(`\ngpa-cache: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
