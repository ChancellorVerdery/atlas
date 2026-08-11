// Headless e2e: shift log trimmed to 3, paged Shift history widget (10/page),
// and the content-driven row wrap (earned total drops to its own line instead
// of clipping the time span). Requires vite dev on 5173.
import { chromium } from 'playwright'
import { strictEqual, ok } from 'node:assert'

const URL = 'http://localhost:5173/'
const N = 25
const shifts = Array.from({ length: N }, (_, i) => ({
  id: 'sh' + i,
  date: `2026-07-${String(i + 1).padStart(2, '0')}`, // i=24 → 07-25 is the newest
  start: '16:30',
  end: '22:15',
  hours: null,
  tips: 120.5,
  wage: 8,
}))

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
const page = await ctx.newPage()
await page.addInitScript((s) => {
  localStorage.setItem('atlas.auth.v1', '{"offline":true}')
  localStorage.setItem('atlas.work.v1', JSON.stringify({ wage: 8, tips: true, openEnded: false, shifts: s, ranges: {}, upcoming: [], address: '', calId: '' }))
}, shifts)
await page.goto(URL + '#/work')
await page.waitForSelector('.pwidget--wkhistory .wk-row', { timeout: 10000 })

const results = []
const check = (name, fn) => {
  try { fn(); results.push(true); console.log('PASS', name) }
  catch (e) { results.push(false); console.log('FAIL', name, '-', e.message) }
}

// ---- shift log shows only the last 3 --------------------------------------
const logRows = await page.$$eval('.pwidget--wkshifts .wk-row', (r) => r.map((x) => x.querySelector('.wk-date').textContent))
check('shift log shows 3 rows', () => strictEqual(logRows.length, 3))
check('shift log shows the newest 3, newest first', () => strictEqual(logRows.join(','), '7/25,7/24,7/23'))

// ---- history pagination ----------------------------------------------------
const pageState = () => page.evaluate(() => {
  const w = document.querySelector('.pwidget--wkhistory')
  return {
    rows: [...w.querySelectorAll('.wk-row .wk-date')].map((x) => x.textContent),
    label: w.querySelector('.wk-page .gym-sub').textContent,
    prevOff: w.querySelector('[data-d="-1"]').disabled,
    nextOff: w.querySelector('[data-d="1"]').disabled,
  }
})
const next = async () => { await page.click('.pwidget--wkhistory [data-d="1"]'); await page.waitForTimeout(120) }
const prev = async () => { await page.click('.pwidget--wkhistory [data-d="-1"]'); await page.waitForTimeout(120) }

let p = await pageState()
check('page 1: 10 rows, newest first', () => { strictEqual(p.rows.length, 10); strictEqual(p.rows[0], '7/25'); strictEqual(p.rows[9], '7/16') })
check('page 1 label', () => strictEqual(p.label, '1–10 of 25'))
check('page 1 prev disabled', () => strictEqual(p.prevOff, true))

await next()
p = await pageState()
check('page 2: rows 11–20', () => { strictEqual(p.rows.length, 10); strictEqual(p.rows[0], '7/15'); strictEqual(p.rows[9], '7/6') })
check('page 2 label', () => strictEqual(p.label, '11–20 of 25'))

await next()
p = await pageState()
check('page 3: remaining 5', () => { strictEqual(p.rows.length, 5); strictEqual(p.rows[0], '7/5'); strictEqual(p.rows[4], '7/1') })
check('page 3 label', () => strictEqual(p.label, '21–25 of 25'))
check('page 3 next disabled', () => strictEqual(p.nextOff, true))

await prev(); await prev()
p = await pageState()
check('prev returns to page 1', () => strictEqual(p.label, '1–10 of 25'))

// deleting from the last page must not strand the pager past the end
await next(); await next()
await page.click('.pwidget--wkhistory .wk-row:last-child [data-wk-act="del-shift"]')
await page.waitForTimeout(150)
p = await pageState()
check('delete on last page reflows the pager', () => strictEqual(p.label, '21–24 of 24'))

// ---- row wrap is content-driven, measured ----------------------------------
// Measure the FIRST history row at a wide and a narrow widget width.
const measure = (px) => page.evaluate((w) => {
  const wid = document.querySelector('.pwidget--wkhistory')
  wid.style.maxWidth = w + 'px'
  const row = wid.querySelector('.wk-row')
  const q = (s) => row.querySelector(s)
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right) } }
  const time = q('.wk-time')
  const rows = wid.querySelector('.wk-rows')
  return {
    rowsOverflow: rows.scrollWidth > rows.clientWidth + 1, // min-content floor must not push the row past the card
    rowRight: Math.round(row.getBoundingClientRect().right),
    date: box(q('.wk-date')),
    time: box(time),
    earned: box(q('.wk-earned')),
    timeClipped: time.scrollWidth > time.clientWidth + 1,
  }
}, px)

// Spec: the money always sits on its own line, left edge flush under the time
// span (never right-aligned), and the time is never truncated — at any width.
for (const px of [560, 380, 260]) {
  const m = await measure(px)
  check(`${px}px: money on its own line below the time`, () => ok(m.earned.top > m.time.top, `earned top ${m.earned.top} vs time top ${m.time.top}`))
  check(`${px}px: money left-aligned directly under the time`, () => strictEqual(m.earned.left, m.time.left))
  // Only discriminating where the money doesn't nearly fill the line anyway.
  if (px >= 380) check(`${px}px: money is NOT right-aligned`, () => ok(m.rowRight - m.earned.right > 40, `only ${m.rowRight - m.earned.right}px of slack to the right`))
  check(`${px}px: date sits on the time's line`, () => {
    // baseline alignment leaves the 12px date and 13px time a pixel apart on top
    ok(Math.abs(m.time.top - m.date.top) <= 3, `time top ${m.time.top} vs date top ${m.date.top}`)
    ok(m.time.left > m.date.right, 'time starts after the date')
  })
  check(`${px}px: time not clipped`, () => strictEqual(m.timeClipped, false))
  check(`${px}px: row does not overflow the card`, () => strictEqual(m.rowsOverflow, false))
}

await browser.close()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
