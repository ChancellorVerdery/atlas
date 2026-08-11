// Sleep plugin: nights/naps logging, rolling sleep debt with recovery ratio +
// nap credit + window drop-off, tonight's-bedtime plan, and the two charts.
// Headless, deterministic (frozen clock, seeded store).
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name, extra = '') => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) } }

const NOW = new Date('2026-07-05T09:00:00')
const browser = await chromium.launch({ headless: true })

// Seeded history (a night's date = the morning you woke up), pref 8:00,
// window 7, ratio 1.2, nap credit 50%:
//   7/1 23:00–06:00 = 7:00  → short 60      → debt  60
//   7/2 23:30–07:30 = 8:00  → even          → debt  60
//   7/3 00:00–06:00 = 6:00  → short 120     → debt 180
//   7/4 (no log)             → carried       → debt 180
//   7/5 23:00–08:00 = 9:00 + 60m nap @50% = 9:30 → surplus 90 → repays 90/1.2 = 75 → debt 105
const SEED = () => {
  localStorage.setItem('atlas.devMode', '1')
  localStorage.setItem('atlas.sleep.v1', JSON.stringify({
    prefMin: 480, bedtime: '23:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3,
    logs: [
      { id: 'n1', type: 'night', date: '2026-07-01', start: '23:00', end: '06:00', minutes: 420 },
      { id: 'n2', type: 'night', date: '2026-07-02', start: '23:30', end: '07:30', minutes: 480, quality: 4 },
      { id: 'n3', type: 'night', date: '2026-07-03', start: '00:00', end: '06:00', minutes: 360 },
      { id: 'n5', type: 'night', date: '2026-07-05', start: '23:00', end: '08:00', minutes: 540 },
      { id: 'p1', type: 'nap', date: '2026-07-05', minutes: 60 },
    ],
  }))
}

// ---- A. debt math, bedtime plan, charts -------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.clock.install({ time: NOW })
  await page.addInitScript(SEED)
  await page.goto(`${BASE}/#/sleep`)
  await page.waitForSelector('.pwidget--slbedtime')

  console.log('A1. rolling debt: shortfalls add, ratio repays, missing days carry')
  const debt = await page.evaluate(async () => {
    const m = await import('/src/page/sleep.js')
    return m.debtSeries(m.loadSleep()).map((p) => `${p.date.slice(5)}:${p.debt}`)
  })
  ok(debt.join(' ') === '06-29:0 06-30:0 07-01:60 07-02:60 07-03:180 07-04:180 07-05:105',
    `series matches hand-computed values (${debt.join(' ')})`)

  console.log('A2. tonight\'s bedtime widget')
  const bedText = await page.locator('.pwidget--slbedtime').innerText()
  ok(bedText.includes('11:00 PM'), `bedtime anchors to the preferred 11:00 PM (${bedText.split('\n')[1]})`)
  // extra = ceil(105×1.2 / 3 nights / 5)×5 = 45 min → wake 23:00 + 8:00 + 0:45 = 7:45 AM
  ok(bedText.includes('7:45 AM'), 'wake time floats: preferred 8:00 + 45 min of debt recoup → 7:45 AM')
  ok(bedText.includes('1:45 sleep debt'), 'current debt (1:45) is stated')
  ok(bedText.includes('+45 min tonight'), 'tonight\'s share of the recoup is stated')

  console.log('A3. charts render with real axes')
  await page.waitForSelector('.pwidget--slhours svg.chart')
  const hoursSvg = await page.locator('.pwidget--slhours').innerHTML()
  ok(hoursSvg.includes('Hours slept'), 'hours chart has its y-axis title')
  ok(hoursSvg.includes('Goal: 8:00 per night'), 'hours chart states the nightly goal')
  ok((hoursSvg.match(/chart__bar/g) || []).length === 7, `one bar per window day (${(hoursSvg.match(/chart__bar/g) || []).length})`)
  const debtSvg = await page.locator('.pwidget--sldebt').innerHTML()
  ok(debtSvg.includes('Sleep debt (hours)'), 'debt chart has its y-axis title')
  ok(debtSvg.includes('7-day window · 1.2× recovery'), 'debt chart states the window and ratio')
  ok((debtSvg.match(/chart__dot/g) || []).length === 7, 'debt line has one point per window day')

  console.log('A4. log via the form: night, then a nap (form swaps), stars, delete')
  const before = await page.locator('.pwidget--sllog .wk-row').count()
  await page.locator('.sl-add .sl-date').fill('2026-07-04')
  await page.locator('.sl-add .sl-bed').fill('23:45')
  await page.locator('.sl-add .sl-wake').fill('06:15')
  await page.click('[data-sl-star="4"]')
  await page.click('[data-sl-act="add"]')
  await page.waitForFunction((n) => document.querySelectorAll('.pwidget--sllog .wk-row').length === n + 1, before)
  const rowText = await page.locator('.pwidget--sllog .wk-row', { hasText: '7/4' }).innerText()
  ok(rowText.includes('11:45 PM–6:15 AM') && rowText.includes('6:30'), `night row shows times + cross-midnight duration (${rowText.trim().replace(/\s+/g, ' ')})`)
  ok(rowText.includes('★★★★') && !rowText.includes('★★★★★'), 'quality stars recorded (4 of 5)')
  // 7/4 now logged 6:30 → short 90 → debt series rebuilds: 60,60,180,270 → 7/5 repays 75 → 195
  const debt2 = await page.evaluate(async () => {
    const m = await import('/src/page/sleep.js')
    return m.currentDebt(m.loadSleep())
  })
  ok(debt2 === 195, `debt recomputed live after the new short night (${debt2})`)
  // nap: switching the type select swaps time inputs for a duration field
  await page.selectOption('.sl-add .sl-type', 'nap')
  await page.waitForSelector('.sl-add .sl-dur')
  ok(await page.locator('.sl-add .sl-bed').count() === 0, 'nap mode swaps bed/wake inputs for a duration field')
  await page.locator('.sl-add .sl-date').fill('2026-07-04')
  await page.locator('.sl-add .sl-dur').fill('0:40')
  await page.click('[data-sl-act="add"]')
  await page.waitForFunction((n) => document.querySelectorAll('.pwidget--sllog .wk-row').length === n + 2, before)
  ok((await page.locator('.pwidget--sllog').innerText()).includes('nap · 0:40'), 'nap logged with its duration')
  // 40m nap @50% = +20 on 7/4 → short 70 → debt 60+60+180+250 → repay 75 → 175
  const debt3 = await page.evaluate(async () => {
    const m = await import('/src/page/sleep.js')
    return m.currentDebt(m.loadSleep())
  })
  ok(debt3 === 175, `nap repays at the 50% nap credit (${debt3})`)
  const rows = await page.locator('.pwidget--sllog .wk-row').count()
  await page.locator('.pwidget--sllog .wk-row', { hasText: 'nap · 0:40' }).locator('[data-sl-act="del"]').click()
  await page.waitForFunction((n) => document.querySelectorAll('.pwidget--sllog .wk-row').length === n - 1, rows)
  ok(true, 'deleting an entry removes it')

  ok(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 200)})`)
  await ctx.close()
}

// ---- B. settings drive the math: window drop-off, ratio, nap credit ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.clock.install({ time: NOW })
  await page.addInitScript(SEED)
  await page.goto(`${BASE}/#/sleep/settings`)
  await page.waitForSelector('#sl-window')
  console.log('B. settings: drop-off, ratio, nap credit')
  // shrink the window to 3 days: 7/1+7/2's debt drops off entirely →
  // 7/3 short 120, 7/4 carried, 7/5 surplus 90 repays 75 → 45
  await page.fill('#sl-window', '3')
  let d = await page.evaluate(async () => { const m = await import('/src/page/sleep.js'); return m.currentDebt(m.loadSleep()) })
  ok(d === 45, `old days DROP OFF past the window — debt 105 → 45 with a 3-day window (${d})`)
  // ratio 1.0: the same 90 surplus now repays 90 → 30
  await page.fill('#sl-ratio', '1.0')
  d = await page.evaluate(async () => { const m = await import('/src/page/sleep.js'); return m.currentDebt(m.loadSleep()) })
  ok(d === 30, `recovery ratio applies to repayment — 1.2→1.0 lowers debt to 30 (${d})`)
  // nap credit 100%: the 60m nap now counts in full → surplus 120 repays all → 0
  await page.fill('#sl-napcredit', '100')
  d = await page.evaluate(async () => { const m = await import('/src/page/sleep.js'); return m.currentDebt(m.loadSleep()) })
  ok(d === 0, `nap credit % applies — at 100% the nap clears the rest (${d})`)
  // debt floors at zero (no banking): bedtime plan shows no extra
  await page.goto(`${BASE}/#/sleep`)
  await page.waitForSelector('.pwidget--slbedtime')
  const t = await page.locator('.pwidget--slbedtime').innerText()
  ok(t.includes('No sleep debt') && t.includes('7:00 AM'), `zero debt: wake is bed + preferred exactly, no banking (${t.split('\n')[2] || ''})`)
  await ctx.close()
}

// ---- C. fresh install: nav entry, starter board, empty states ----------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.clock.install({ time: NOW })
  await page.goto(`${BASE}/#/sleep`)
  await page.waitForSelector('.pwidget--sllog')
  console.log('C. fresh install')
  ok(await page.locator('.nav__item', { hasText: 'Sleep' }).count() === 1, 'Sleep appears in the sidebar nav')
  for (const k of ['slbedtime', 'sllog', 'slhours', 'sldebt']) {
    ok(await page.locator(`.pwidget--${k}`).count() === 1, `starter board includes ${k}`)
  }
  ok((await page.locator('.pwidget--slhours').innerText()).includes('Log some nights'), 'hours chart shows an empty state, not a broken chart')
  ok((await page.locator('.pwidget--slbedtime').innerText()).includes('11:00 PM'), 'bedtime widget works out of the box on defaults')
  // customize palette offers the sleep widgets
  await page.click('#customize')
  await page.waitForSelector('.palette')
  ok((await page.locator('.palette').innerText()).includes('Sleep'), 'palette has a Sleep group')
  await ctx.close()
}

// ---- D. bed/wake are plain text with a lenient parser (was hostile <input type=time>) --
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.clock.install({ time: NOW })
  await page.addInitScript(() => localStorage.setItem('atlas.sleep.v1', JSON.stringify({ prefMin: 480, bedtime: '23:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3, logs: [] })))
  await page.goto(`${BASE}/#/sleep`)
  await page.waitForSelector('.sl-add')
  console.log('D. free-typing bed/wake times')
  const bed = page.locator('.sl-add .sl-bed')
  ok(await bed.getAttribute('type') === 'text', 'bed field is a plain text input, not a native time picker')
  // type a messy-but-common format that the native picker rejected
  await bed.click()
  await page.keyboard.type('1130pm', { delay: 20 })
  await page.locator('.sl-add .sl-wake').click() // blur bed → canonicalize
  ok(await bed.inputValue() === '11:30 PM', `"1130pm" free-typed and canonicalized to 11:30 PM (got ${await bed.inputValue()})`)
  await page.keyboard.type('7a', { delay: 20 })
  await page.locator('.sl-add .sl-date').click()
  ok(await page.locator('.sl-add .sl-wake').inputValue() === '7:00 AM', '"7a" → 7:00 AM')
  await page.click('[data-sl-act="add"]')
  await page.waitForSelector('.pwidget--sllog .wk-row')
  const row = await page.locator('.pwidget--sllog .wk-row').first().innerText()
  ok(row.includes('11:30 PM–7:00 AM') && row.includes('7:30'), `logged night from free-typed times, 7:30 duration (${row.trim().replace(/\s+/g, ' ')})`)
  await ctx.close()
}

await browser.close()
console.log(`\nsleep: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
