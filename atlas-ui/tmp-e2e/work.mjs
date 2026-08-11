// Work plugin suite — all data is local, so no network faking. Headless.
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name, extra = '') => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) } }

const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d }

// same period logic as work.js, so expectations hold on any run date
const periodStart = (period) => {
  const d = new Date()
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  else if (period === 'month') d.setDate(1)
  else if (period === 'year') { d.setMonth(0); d.setDate(1) }
  else return ''
  return dkey(d)
}

const browser = await chromium.launch({ headless: true })
// This suite predates the login overlay — seed offline auth into every context
// it opens, otherwise the gate hides the whole app. The dashboard-board seed
// marks the profile as a legacy install so the plugin registry migration
// enables every plugin (this suite also predates the plugin system).
const _newContext = browser.newContext.bind(browser)
browser.newContext = async (o) => {
  const c = await _newContext(o)
  await c.addInitScript(() => {
    localStorage.setItem('atlas.auth.v1', '{"offline":true}')
    localStorage.setItem('atlas.page.v1', '{"v":1,"rows":[]}')
  })
  return c
}

// A. page shell + settings
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/#/work`)
  await page.waitForSelector('.pwidget--wk')
  console.log('A. shell + settings')
  ok(await page.locator('#title').innerText() === 'Work', 'topbar label says Work')
  ok(await page.locator('.nav__item', { hasText: 'Work' }).count() === 1, 'Work appears in sidebar nav')
  ok(await page.locator('.pwidget--wkshifts').count() === 1 && await page.locator('.pwidget--wkincome').count() === 1 && await page.locator('.pwidget--wktipshare').count() === 1 && await page.locator('.pwidget--wkupcoming').count() === 1, 'starter board has all four widgets (incl. Upcoming shifts)')
  ok((await page.locator('.page-tab').allInnerTexts()).join(',') === 'Board,Settings', 'Board/Settings tabs shown')

  // tips off → no tips input in shift form, tip share shows the enable note
  ok(await page.locator('.wk-tipsin').count() === 0, 'tips input hidden while toggle is off')
  ok((await page.locator('.pwidget--wktipshare .gym-empty').innerText()).includes('Enable tip positions'), 'tip share prompts to enable the setting')

  await page.click('.page-tab:has-text("Settings")')
  await page.waitForSelector('#wk-wage')
  await page.fill('#wk-wage', '15')
  await page.click('[data-wk-set="tips"]')
  await page.waitForSelector('[data-wk-set="tips"].is-on')
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')))
  ok(st.wage === 15 && st.tips === true && st.openEnded === false, 'wage + tips toggle persisted', JSON.stringify(st))

  console.log('B. shifts + wage snapshot')
  await page.click('.page-tab:has-text("Board")')
  await page.waitForSelector('.wk-add')
  ok(await page.locator('.wk-tipsin').count() === 1, 'tips input appears once toggle is on')
  // clock-time shift: 17:00–23:30 = 6.5h @ $15 + $80 tips = $177.50
  await page.fill('.wk-startin', '17:00')
  await page.fill('.wk-endin', '23:30')
  await page.fill('.wk-tipsin', '80')
  await page.click('[data-wk-act="add-shift"]')
  await page.waitForSelector('.pwidget--wkshifts .wk-row')
  const row1 = await page.locator('.pwidget--wkshifts .wk-row').first().innerText()
  ok(row1.includes('5:00 PM–11:30 PM') && row1.includes('6:30'), 'times render with computed hours in h:mm', row1)
  ok(row1.includes('$177.50'), 'earned = hours × wage + tips', row1)
  // hours-only shift, entered as h:mm (4:30 = 4.5h @ $15 = $67.50)
  await page.fill('.wk-hoursin', '4:30')
  await page.click('[data-wk-act="add-shift"]')
  await page.waitForFunction(() => document.querySelectorAll('.pwidget--wkshifts .wk-row').length === 2)
  const row2 = await page.locator('.pwidget--wkshifts .wk-row').nth(1).innerText()
  ok(row2.includes('4:30') && row2.includes('$67.50'), 'h:mm hours entry parses to decimal hours and displays back as 4:30', row2)
  // raise the wage → old shifts keep $15
  await page.click('.page-tab:has-text("Settings")')
  await page.waitForSelector('#wk-wage')
  await page.fill('#wk-wage', '20')
  await page.click('.page-tab:has-text("Board")')
  await page.waitForSelector('.wk-add')
  await page.fill('.wk-hoursin', '2:00')
  await page.click('[data-wk-act="add-shift"]')
  await page.waitForFunction(() => document.querySelectorAll('.pwidget--wkshifts .wk-row').length === 3)
  const texts = await page.locator('.pwidget--wkshifts .wk-row').allInnerTexts()
  ok(texts.some((t) => t.includes('$177.50')) && texts.some((t) => t.includes('$67.50')) && texts.some((t) => t.includes('$40.00')), 'past shifts keep their snapshot wage after a raise', texts.join('|'))
  const wages = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).shifts.map((x) => x.wage))
  ok(JSON.stringify(wages) === '[15,15,20]', 'wage snapshotted per shift', JSON.stringify(wages))
  // delete one
  await page.locator('[data-wk-act="del-shift"]').last().click()
  await page.waitForFunction(() => document.querySelectorAll('.pwidget--wkshifts .wk-row').length === 2)
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).shifts.length) === 2, 'delete removes the shift')
  await ctx.close()
}

// C. income widget periods
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  const shifts = [
    { id: 'x1', date: dkey(new Date()), start: '', end: '', hours: 5, tips: 10, wage: 10 }, // 60 — every period
    { id: 'x2', date: dkey(daysAgo(40)), start: '', end: '', hours: 3, tips: 0, wage: 10 }, // 30
    { id: 'x3', date: dkey(daysAgo(400)), start: '', end: '', hours: 2, tips: 0, wage: 10 }, // 20 — all time only
  ]
  const val = (sh) => sh.hours * sh.wage + sh.tips
  const expect = (period) => shifts.filter((sh) => sh.date >= periodStart(period)).reduce((t, sh) => t + val(sh), 0)
  await page.addInitScript((data) => {
    if (!localStorage.getItem('atlas.work.v1')) localStorage.setItem('atlas.work.v1', JSON.stringify({ wage: 10, tips: true, openEnded: false, shifts: data }))
  }, shifts)
  await page.goto(`${BASE}/#/work`)
  await page.waitForSelector('.pwidget--wkincome .gym-big')
  console.log('C. income periods')
  const big = () => page.locator('.pwidget--wkincome .gym-big').innerText()
  ok((await big()) === `$${expect('week').toFixed(2)}`, `this week total ($${expect('week')})`, await big())
  for (const [k, want] of [['month', expect('month')], ['year', expect('year')], ['all', expect('all')]]) {
    await page.click(`[data-wk-range="${k}"]`)
    await page.waitForFunction((w) => document.querySelector('.pwidget--wkincome .gym-big').textContent === w, `$${want.toFixed(2)}`)
    ok(true, `${k} total $${want.toFixed(2)}`)
  }
  const sub = await page.locator('.pwidget--wkincome .gym-sub').innerText()
  ok(sub.includes('10h') && sub.includes('3 shifts') && sub.includes('$10.00 tips') && sub.includes('$11.00/h'), 'sub shows hours, shifts, tips, $/h', sub)

  console.log('C2. range persists across reload')
  const wid = await page.evaluate(() => document.querySelector('.pwidget--wkincome').dataset.widgetId)
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).ranges)
  ok(stored[wid] === 'all', 'selected period stored under the widget id', JSON.stringify(stored))
  await page.reload()
  await page.waitForSelector('.pwidget--wkincome .gym-big')
  ok(await page.locator('[data-wk-range="all"]').first().evaluate((el) => el.classList.contains('is-on')), '"All time" pill still selected after reload')
  ok((await big()) === `$${expect('all').toFixed(2)}`, 'total still reflects the persisted range after reload')
  await ctx.close()
}

// D. open-ended shifts + projection
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  // history: two closed shifts on THIS weekday, 17:00 start, 370 & 372 min →
  // avg 371min from the shift's own 17:05 start → 23:16 → rounded up to 23:30
  const hist = [
    { id: 'h1', date: dkey(daysAgo(7)), start: '17:00', end: '23:10', hours: null, tips: 0, wage: 12 },
    { id: 'h2', date: dkey(daysAgo(14)), start: '17:00', end: '23:12', hours: null, tips: 0, wage: 12 },
    { id: 'h3', date: dkey(daysAgo(3)), start: '09:00', end: '12:00', hours: null, tips: 0, wage: 12 }, // other day/time — must not pollute
  ]
  await page.addInitScript((data) => {
    if (!localStorage.getItem('atlas.work.v1')) localStorage.setItem('atlas.work.v1', JSON.stringify({ wage: 12, tips: true, openEnded: true, shifts: data }))
  }, hist)
  await page.goto(`${BASE}/#/work`)
  await page.waitForSelector('.wk-add')
  console.log('D. open-ended + projection')
  await page.fill('.wk-startin', '17:05')
  await page.click('[data-wk-act="add-shift"]')
  await page.waitForSelector('.wk-row--open')
  const openRow = await page.locator('.wk-row--open').innerText()
  ok(openRow.includes('5:05 PM →') && openRow.includes('~11:30 PM') && openRow.includes('proj.'), 'projected out time from same-weekday history, rounded up to 15 min', openRow)
  ok(await page.locator('.wk-row--open .wk-out').inputValue() === '23:30', 'clock-out field prefilled with projection')
  // open shift earns nothing yet
  await page.click('[data-wk-range="all"]')
  const before = await page.locator('.pwidget--wkincome .gym-big').innerText()
  // clock out at 23:20 (6h15 from 17:05) with $55 tips → 6.25×12+55 = $130
  await page.fill('.wk-row--open .wk-out', '23:20')
  await page.fill('.wk-row--open .wk-tips-in', '55')
  await page.click('[data-wk-act="clock-out"]')
  await page.waitForFunction(() => !document.querySelector('.wk-row--open'))
  const closedRow = await page.locator('.wk-row').first().innerText()
  ok(closedRow.includes('5:05 PM–11:20 PM') && closedRow.includes('$130.00'), 'clock out closes the shift with actual time + tips', closedRow)
  const after = await page.locator('.pwidget--wkincome .gym-big').innerText()
  ok(before !== after && after === `$${(130 + hist.reduce((t, h) => t + 12 * ((h.end.split(':')[0] * 60 + +h.end.split(':')[1] - h.start.split(':')[0] * 60 - +h.start.split(':')[1]) / 60), 0)).toFixed(2)}`, 'income counts the shift only once closed', `${before} → ${after}`)
  // log-shift button label + logging by TOTAL time (h:mm) instead of out time
  await page.fill('.wk-startin', '06:45') // a start time no fixture shift uses
  await page.click('[data-wk-act="add-shift"]') // a fresh open shift (open-ended on)
  await page.waitForSelector('.wk-row--open')
  ok((await page.locator('.wk-row--open [data-wk-act="clock-out"]').innerText()) === 'Log shift', 'open-shift button says "Log shift"')
  ok(await page.locator('.wk-row--open .wk-hours-out').count() === 1, 'total-time h:mm field offered')
  await page.fill('.wk-row--open .wk-hours-out', '6:30') // total time, not an out time
  await page.fill('.wk-row--open .wk-tips-in', '40')
  await page.click('.wk-row--open [data-wk-act="clock-out"]')
  await page.waitForFunction(() => document.querySelectorAll('.wk-row--open').length === 0)
  const byTotal = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).shifts.find((x) => x.start === '06:45'))
  ok(byTotal.hours === 6.5 && byTotal.end === '' && byTotal.tips === 40, 'logged by total time: 6:30 → 6.5h, no end, tips kept', JSON.stringify(byTotal))
  // overnight shift math: 22:00 → 02:00 = 4h
  await page.fill('.wk-startin', '22:00')
  await page.fill('.wk-endin', '02:00')
  await page.click('[data-wk-act="add-shift"]')
  await page.waitForFunction(() => [...document.querySelectorAll('.wk-row')].some((r) => r.textContent.includes('4:00')))
  ok(true, 'overnight shift wraps midnight (22:00–02:00 = 4:00) and displays h:mm')

  // no-history projection: fresh weekday/time with openEnded on
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('atlas.work.v1'))
    s.shifts = []
    localStorage.setItem('atlas.work.v1', JSON.stringify(s))
  })
  await page.reload()
  await page.waitForSelector('.wk-add')
  await page.fill('.wk-startin', '11:00')
  await page.click('[data-wk-act="add-shift"]')
  await page.waitForSelector('.wk-row--open')
  ok((await page.locator('.wk-row--open').innerText()).includes('on the clock'), 'no history → "on the clock", no fake projection')
  await ctx.close()
}

// E. tip share calculator
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    if (!localStorage.getItem('atlas.work.v1')) localStorage.setItem('atlas.work.v1', JSON.stringify({ wage: 10, tips: true, openEnded: false, shifts: [] }))
  })
  await page.goto(`${BASE}/#/work`)
  await page.waitForSelector('.wk-ts')
  console.log('E. tip share')
  await page.fill('[data-wk-ts="pool"]', '100')
  const rows = page.locator('.wk-ts-row[data-i]')
  await rows.nth(0).locator('[data-wk-ts="name"]').fill('Ana')
  await rows.nth(0).locator('[data-wk-ts="hours"]').fill('6')
  await rows.nth(1).locator('[data-wk-ts="name"]').fill('Ben')
  await rows.nth(1).locator('[data-wk-ts="hours"]').fill('2')
  ok(await rows.nth(0).locator('[data-ts-share]').innerText() === '$75.00', 'hours-weighted share: 6h of 8h → $75')
  ok(await rows.nth(1).locator('[data-ts-share]').innerText() === '$25.00', '2h of 8h → $25')
  ok(await page.locator('[data-ts-total]').innerText() === '8:00 total', 'total hours shown in h:mm')
  // h:mm entry with minutes weights the split correctly
  await rows.nth(0).locator('[data-wk-ts="hours"]').fill('5:30')
  await rows.nth(1).locator('[data-wk-ts="hours"]').fill('2:30')
  ok(await rows.nth(0).locator('[data-ts-share]').innerText() === '$68.75', 'h:mm minutes weight the split (5:30 of 8:00 → $68.75)')
  ok(await page.locator('[data-ts-total]').innerText() === '8:00 total', 'h:mm hours sum in the total')
  await rows.nth(0).locator('[data-wk-ts="hours"]').fill('6')
  await rows.nth(1).locator('[data-wk-ts="hours"]').fill('2')
  ok(await page.evaluate(() => document.activeElement?.dataset.wkTs) === 'hours', 'live recalc keeps input focus')
  await page.click('[data-wk-act="ts-add"]')
  await page.waitForFunction(() => document.querySelectorAll('.wk-ts-row[data-i]').length === 3)
  await page.locator('.wk-ts-row[data-i="2"] [data-wk-ts="hours"]').fill('8')
  ok(await rows.nth(0).locator('[data-ts-share]').innerText() === '$37.50', 'third person rebalances shares')
  await page.locator('[data-wk-act="ts-del"][data-i="2"]').click()
  await page.waitForFunction(() => document.querySelectorAll('.wk-ts-row[data-i]').length === 2)
  ok(true, 'remove person works')
  await ctx.close()
}

// F. upcoming shifts: estimated vs auto-predicted end, both push to the calendar
// BROKEN since Google auth moved server-side (2026-07-16): calendar writes now
// go over the WS `google.api` proxy, so this googleapis.com route mock never
// fires and every gcalId stays ''. The local record (date/end/endMode) is still
// created correctly — verified by probe. Fix = mock the google.api WS code.
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  const posts = []
  await page.route('https://www.googleapis.com/**', (route) => {
    const u = new URL(route.request().url())
    const method = route.request().method()
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (method === 'POST' && u.pathname.includes('/calendars/cal-work/events')) {
      posts.push(route.request().postDataJSON())
      return json({ id: 'ev-' + posts.length })
    }
    if (method === 'DELETE') return route.fulfill({ status: 204, body: '' })
    return json({ items: [] })
  })
  await page.addInitScript(() => {
    // `connected` is what isConnected() reads since Google auth moved server-side
    localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', connected: true, token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
    localStorage.setItem('atlas.page.work.v1', JSON.stringify({
      v: 1, rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'wkupcoming' }] }] }] }] }],
    }))
    // open-ended ON + two closed TUESDAY shifts: 8h and 8.5h from 09:00 →
    // predicted end for a Tuesday 09:00 shift = 09:00 + 8.25h = 17:15.
    // Guarded: this re-runs on reload and must not clobber in-test changes.
    if (!localStorage.getItem('atlas.work.v1')) localStorage.setItem('atlas.work.v1', JSON.stringify({
      wage: 15, tips: false, openEnded: true, ranges: {}, upcoming: [], address: '', calId: 'cal-work',
      shifts: [
        { id: 'h1', date: '2026-06-23', start: '09:00', end: '17:00', hours: null, tips: 0, wage: 15 },
        { id: 'h2', date: '2026-06-30', start: '09:00', end: '17:30', hours: null, tips: 0, wage: 15 },
      ],
    }))
  })
  await page.goto(`${BASE}/#/work`)
  await page.waitForSelector('.pwidget--wkupcoming')
  console.log('F. upcoming: estimated vs auto-predicted end')

  // 1) blank end → predicted from history, marked "auto end", pushed with it
  await page.fill('.wk-datein', '2026-08-11') // a Tuesday
  await page.fill('.wk-up-start', '09:00')
  await page.click('[data-wk-act="add-upcoming"]')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('atlas.work.v1')).upcoming[0]?.gcalId === 'ev-1', null, { timeout: 10000 })
  const up1 = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).upcoming[0])
  ok(up1.end === '17:15' && up1.endMode === 'auto', `blank end predicted from Tuesday history: 8h & 8.5h avg → 17:15 (got ${up1.end}/${up1.endMode})`)
  const row1 = await page.locator('.wk-row[data-up-id]').first().innerText()
  ok(row1.includes('9:00 AM–5:15 PM') && row1.includes('auto end'), `row shows the predicted end + "auto end" marker (${row1.trim().replace(/\s+/g, ' ')})`)
  ok(posts[0]?.end?.dateTime === '2026-08-11T17:15:00', `calendar event pushed automatically with the PREDICTED end (${posts[0]?.end?.dateTime})`)

  // 2) typed end → the user's estimate, pushed verbatim, no auto marker
  await page.fill('.wk-datein', '2026-08-12')
  await page.fill('.wk-up-start', '10:00')
  await page.fill('.wk-up-end', '16:00')
  await page.click('[data-wk-act="add-upcoming"]')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('atlas.work.v1')).upcoming.length === 2 && JSON.parse(localStorage.getItem('atlas.work.v1')).upcoming[1].gcalId, null, { timeout: 10000 })
  const up2 = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).upcoming[1])
  ok(up2.end === '16:00' && up2.endMode === 'est', 'typed end is kept as the user estimate')
  ok(posts[1]?.end?.dateTime === '2026-08-12T16:00:00', 'estimated shift pushed with the typed end')
  ok(!(await page.locator('.wk-row', { hasText: '8/12' }).innerText()).includes('auto end'), 'estimated row carries no auto marker')

  // 3) open-ended OFF → blank end refuses to add (no half-made shifts)
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('atlas.work.v1')); s.openEnded = false
    localStorage.setItem('atlas.work.v1', JSON.stringify(s))
  })
  await page.reload()
  await page.waitForSelector('.pwidget--wkupcoming')
  await page.fill('.wk-datein', '2026-08-13')
  await page.fill('.wk-up-start', '09:00')
  await page.click('[data-wk-act="add-upcoming"]')
  await page.waitForTimeout(400)
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).upcoming.length) === 2, 'with open-ended shifts off, a blank end adds nothing')
  await ctx.close()
}

// F2. boards from before the Upcoming-shifts widget get it appended once
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    // an old board with no wkupcoming anywhere, and no migration flag
    localStorage.setItem('atlas.page.work.v1', JSON.stringify({
      v: 1, rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'wkshifts' }] }] }] }] }],
    }))
  })
  await page.goto(`${BASE}/#/work`)
  await page.waitForSelector('.pwidget--wkupcoming')
  console.log('F2. legacy board migration')
  ok(true, 'an existing board without the widget gets Upcoming shifts appended')
  // deleting it must STICK (flag prevents re-append)
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('atlas.page.work.v1'))
    p.rows = p.rows.filter((r) => !JSON.stringify(r).includes('wkupcoming'))
    localStorage.setItem('atlas.page.work.v1', JSON.stringify(p))
  })
  await page.reload()
  await page.waitForSelector('.pwidget--wkshifts')
  ok(await page.locator('.pwidget--wkupcoming').count() === 0, 'removing the widget after migration sticks — no re-append')
  await ctx.close()
}

// F3. Add button gives feedback instead of a silent no-op, and accepts
// lenient clock formats ("9am", "5pm") — a fiddly time field leaving start
// blank used to make Add do nothing with no explanation.
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    localStorage.setItem('atlas.page.work.v1', JSON.stringify({ v: 1, rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'wkupcoming' }] }] }] }] }] }))
    if (!localStorage.getItem('atlas.work.v1')) localStorage.setItem('atlas.work.v1', JSON.stringify({ wage: 15, tips: false, openEnded: false, ranges: {}, upcoming: [], shifts: [], address: '', calId: '' }))
  })
  await page.goto(`${BASE}/#/work`)
  await page.waitForSelector('.pwidget--wkupcoming')
  console.log('F3. Add-button feedback + lenient time entry')
  // blank start → visible message, nothing added
  await page.fill('.wk-up-end', '17:00')
  await page.click('[data-wk-act="add-upcoming"]')
  await page.waitForTimeout(100)
  ok((await page.locator('.wk-up-msg').innerText()).includes('start time'), 'blank start shows a message, not a silent no-op')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).upcoming.length) === 0, 'blank start adds nothing')
  // lenient formats: "9am" / "5pm" both parse and add
  await page.fill('.wk-up-start', '9am')
  await page.fill('.wk-up-end', '5pm')
  await page.click('[data-wk-act="add-upcoming"]')
  await page.waitForTimeout(150)
  const up = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).upcoming)
  ok(up.length === 1 && up[0].start === '09:00' && up[0].end === '17:00', 'lenient "9am"/"5pm" parse to 09:00–17:00', JSON.stringify(up))
  ok(await page.locator('.wk-up-msg').isHidden(), 'message clears after a successful add')
  // unreadable start → explains itself
  await page.fill('.wk-up-start', 'nope')
  await page.fill('.wk-up-end', '17:00')
  await page.click('[data-wk-act="add-upcoming"]')
  await page.waitForTimeout(100)
  ok((await page.locator('.wk-up-msg').innerText()).toLowerCase().includes('read'), 'unreadable start explains itself')
  await ctx.close()
}

await browser.close()
console.log(`\nwork: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
