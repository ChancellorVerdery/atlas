// Ladder planner suite. Everything external is faked at page.route (Google
// Calendar, Nominatim geocoding, OSRM routing); the clock is frozen to a known
// Monday morning so placements are deterministic. Headless always.
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name, extra = '') => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) } }

// Frozen "now": Sunday 2026-07-05, 09:00 local — the planner's window starts
// the NEXT day (today is excluded), so this puts the window at Mon..Sun,
// matching every fixture date below exactly as before that behavior changed.
const NOW = new Date('2026-07-05T09:00:00')
const D = (day, hm) => `2026-07-${String(day).padStart(2, '0')}T${hm}:00`

// coords keyed by address keyword; drive minutes by unordered lat-pair
const GEO = { home: 35.0, class: 35.1, gym: 35.2, work: 35.3 }
// All multiples of 5 — production now rounds routing minutes up to the
// nearest 5, so fixture values already in that form make rounding a no-op
// and keep expected-time arithmetic in the tests exact, not approximate.
const DRIVES = { 'home|class': 20, 'class|gym': 10, 'gym|work': 15, 'home|gym': 25, 'home|work': 30, 'class|work': 20 }
// Mirrors ladderui.js's private time12() exactly, so expected label text can
// be computed here rather than hand-derived and hardcoded.
const time12 = (ms) => {
  const d = new Date(ms)
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}
const latName = (lat) => Object.keys(GEO).find((k) => Math.abs(GEO[k] - lat) < 0.01)

const GCAL_EVENTS = [
  { id: 'ev-class', status: 'confirmed', summary: 'Chemistry class', location: '200 Class Blvd',
    start: { dateTime: D(6, '10:00') }, end: { dateTime: D(6, '11:30') } },
  { id: 'ev-late', status: 'confirmed', summary: 'Late show',
    start: { dateTime: D(10, '23:00') }, end: { dateTime: D(11, '02:00') } },
  // campus-room location that doesn't geocode — resolved by a location alias
  { id: 'ev-orgo', status: 'confirmed', summary: 'Orgo lecture', location: 'Fretwell 306',
    start: { dateTime: D(9, '10:00') }, end: { dateTime: D(9, '11:30') } },
  // no location at all — resolved by a TITLE alias
  { id: 'ev-sem', status: 'confirmed', summary: 'Evening seminar',
    start: { dateTime: D(8, '18:00') }, end: { dateTime: D(8, '20:00') } },
  // unresolvable location: no alias, geocoder finds nothing
  { id: 'ev-myst', status: 'confirmed', summary: 'Mystery meetup', location: 'Nowhere Hall',
    start: { dateTime: D(10, '10:00') }, end: { dateTime: D(10, '11:00') } },
  // a RECURRING event (two window instances share recurringEventId) — no
  // location so it adds no drives; on clear Wed/Fri afternoons
  { id: 'ev-yoga-1', status: 'confirmed', summary: 'Yoga', recurringEventId: 'rec-yoga',
    start: { dateTime: D(8, '15:00') }, end: { dateTime: D(8, '16:00') } },
  { id: 'ev-yoga-2', status: 'confirmed', summary: 'Yoga', recurringEventId: 'rec-yoga',
    start: { dateTime: D(10, '15:00') }, end: { dateTime: D(10, '16:00') } },
]

function installFakes(page, state) {
  return Promise.all([
    page.route('https://www.googleapis.com/**', (route) => {
      const u = new URL(route.request().url())
      const method = route.request().method()
      if (method !== 'GET') state.writes.push(`${method} ${u.pathname}`)
      const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
      if (u.pathname.endsWith('/users/me/calendarList'))
        return json({ items: [{ id: 'primary', summary: 'Personal' }, { id: 'cal-work', summary: 'Atlas Work' }] })
      if (u.pathname.includes('/calendars/primary/events')) return json({ items: GCAL_EVENTS })
      if (u.pathname.includes('/calendars/cal-work/events'))
        return json({ items: [{ id: 'ev-x', status: 'confirmed', summary: 'ShouldNotAppear', start: { dateTime: D(8, '09:00') }, end: { dateTime: D(8, '17:00') } }] })
      return json({ items: [] })
    }),
    page.route('https://nominatim.openstreetmap.org/**', (route) => {
      const q = new URL(route.request().url()).searchParams.get('q').toLowerCase()
      const key = Object.keys(GEO).find((k) => q.includes(k))
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(key ? [{ lat: String(GEO[key]), lon: '-80.0' }] : []) })
    }),
    page.route('https://router.project-osrm.org/**', (route) => {
      const m = route.request().url().match(/driving\/[^,]+,([\d.]+);[^,]+,([\d.]+)/)
      const a = latName(Number(m[1])), b = latName(Number(m[2]))
      const mins = DRIVES[`${a}|${b}`] ?? DRIVES[`${b}|${a}`] ?? 25
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [{ duration: mins * 60 }] }) })
    }),
  ])
}

const SEED = (dir) => {
  localStorage.setItem('atlas.devMode', '1') // exposes window.__ladder test hook
  localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
  localStorage.setItem('atlas.ladder.v1', JSON.stringify({
    home: '100 Home St', wake: '07:00', bed: '23:00', windowDays: 7, buffer: 5,
    meals: [
      { id: 'm1', name: 'Breakfast', pref: '08:00', duration: 30, enabled: true },
      { id: 'm2', name: 'Lunch', pref: '12:30', duration: 45, enabled: true },
      { id: 'm3', name: 'Dinner', pref: '18:30', duration: 45, enabled: true },
    ],
    flex: [
      { id: 'lf1', title: 'Project work', minutes: 120, kind: 'week' },
      { id: 'lf2', title: 'Tuesday project', minutes: 90, kind: 'day', date: '2026-07-07' },
      { id: 'lf3', title: 'Monday study', minutes: 120, kind: 'recur', weekday: 1 },
    ],
    geo: {}, drives: {},
    aliases: [
      { id: 'al1', match: 'Fretwell', address: '200 Class Blvd' },
      { id: 'al2', match: 'Evening seminar', address: '400 Work Ave' },
    ],
  }))
  localStorage.setItem('atlas.gym.v1', JSON.stringify({
    v: 1,
    workouts: [{ id: 'gw1', name: 'Push day' }],
    exercises: [], logs: [],
    completions: [
      { workoutId: 'gw1', date: '2026-06-29', ts: 1, start: '17:00', end: '18:00' },
      { workoutId: 'gw1', date: '2026-06-22', ts: 2, start: '17:00', end: '18:10' },
    ],
    plan: { type: 'weekly', weekly: { mon: 'gw1', tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, cycle: { order: [], position: 0 } },
    unit: 'kg', address: '300 Gym Rd', hours: { start: '16:00', end: '21:00' }, defaultDuration: 75,
  }))
  localStorage.setItem('atlas.work.v1', JSON.stringify({
    wage: 15, tips: false, openEnded: false, shifts: [], ranges: {},
    upcoming: [{ id: 'up1', date: '2026-07-07', start: '09:00', end: '17:00', gcalId: 'g-up1' }],
    address: '400 Work Ave', calId: 'cal-work',
  }))
}

const browser = await chromium.launch({ headless: true })

// ---- A. the plan ------------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  const state = { writes: [] }
  await installFakes(page, state)
  await page.clock.install({ time: NOW })
  await page.addInitScript(SEED)
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForSelector('.lad-canvas')
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })

  console.log('A0. current day is included, planned like any other day')
  const win = await page.evaluate(() => ({ start: window.__ladder.windowStart, end: window.__ladder.windowEnd }))
  const expectedStart = new Date('2026-07-05T00:00:00').getTime() // "now" is Sun 7/5 — window starts TODAY
  ok(win.start === expectedStart, `windowStart is today's midnight, not tomorrow's (got ${new Date(win.start).toISOString()})`)
  ok(win.end === expectedStart + 7 * 86400000, 'windowEnd is 7 full days after that')
  ok(await page.locator('.lad-daylabel', { hasText: 'SUN 7/5' }).count() === 1, 'today (Sunday) is in the plan with its own day label')
  // today is planned from wake, not from "now": the 8:00 AM breakfast lands at
  // 8:00 even though "now" is 9:00 AM — the current-time line never pushes it.
  const todayBfast = await page.evaluate(() => window.__ladder.blocks.find((b) => b.mealId && new Date(b.start).getDate() === 5 && b.title === 'Breakfast'))
  ok(todayBfast && new Date(todayBfast.start).getHours() === 8, `today's breakfast is placed at its 8:00 slot, before "now" (${todayBfast ? new Date(todayBfast.start).toLocaleTimeString() : 'missing'})`)
  ok(await page.locator('.lad-nowline').count() === 1, 'the current-time line is displayed on today')

  console.log('A1. fixed blocks land')
  ok(await page.locator('.lad-card--cal', { hasText: 'Chemistry class' }).count() === 1, 'calendar event blocked in')
  ok(await page.locator('.lad-card--shift', { hasText: 'Work' }).count() === 1, "Tuesday's scheduled shift blocked in")
  ok(await page.locator('.lad-card', { hasText: 'ShouldNotAppear' }).count() === 0, 'Atlas Work calendar excluded (no double-count with local shifts)')
  ok(await page.locator('.lad-sleep').count() >= 7, 'sleep bands drawn')
  // a full night (not the window-clamped first one) shows its bed→wake time
  const sleepTexts = await page.locator('.lad-sleep').allInnerTexts()
  ok(sleepTexts.some((t) => /\d{1,2}:\d{2}\s?(AM|PM)\s?–\s?\d{1,2}:\d{2}\s?(AM|PM)/.test(t)), `sleep bands show their time range (got e.g. ${JSON.stringify(sleepTexts.find((t) => /–/.test(t)) || sleepTexts[0])})`)
  ok(await page.locator('.lad-dayline').count() === 6, 'day boundary lines between the 7 days')

  console.log('A2. drive chain: home → class → gym → home, with the +5 cushion')
  const driveTitles = await page.locator('.lad-card--drive').allInnerTexts()
  const blocks = await page.evaluate(() => window.__ladder.blocks)
  const driveTo = (title) => blocks.find((b) => b.type === 'drive' && b.toTitle === title)
  // mirrors ladderui.js: a settings place (toPlace) replaces the event title
  const labelFor = (b) => {
    const place = b.toPlace || (b.toType === 'sleep' ? 'home' : null)
    const dest = place === 'home' ? 'home' : place === 'work' ? 'to work' : place === 'gym' ? 'to the gym' : `to ${b.toTitle}`
    return `${time12(b.start)} – ${time12(b.end)} drive ${dest}`
  }

  const classDriveB = driveTo('Chemistry class')
  ok(!!classDriveB && classDriveB.mins === 20, `home→class drive uses the 20-min leg (got ${classDriveB?.mins})`)
  ok(classDriveB.toPlace == null, "a non-settings destination (200 Class Blvd) keeps the event name, no place word")
  ok(driveTitles.includes(labelFor(classDriveB)), `home→class drive shows its full h:mm–h:mm range incl. cushion (want "${labelFor(classDriveB)}", got ${JSON.stringify(driveTitles)})`)

  const gymDriveB = driveTo('Push day')
  ok(!!gymDriveB && gymDriveB.mins === 10, `drive INTO the gym uses class→gym (10 min), not home→gym (25) — the chain tracked location (got ${gymDriveB?.mins})`)
  ok(gymDriveB.toPlace === 'gym', 'drive to the gym address says "gym", not the workout name "Push day"')
  ok(driveTitles.some((t) => t.includes('drive to the gym')) && driveTitles.includes(labelFor(gymDriveB)), `gym drive reads "drive to the gym" (want "${labelFor(gymDriveB)}")`)

  // The gym ends late afternoon, but bed isn't until 23:00 — the evening is
  // free, so the drive home is NOT pinned right before sleep (section K covers
  // the late-night case where it IS kept). Nothing to show; you drift home on
  // your own time.
  const homeDriveB = blocks.find((b) => b.type === 'drive' && b.toType === 'sleep')
  ok(!homeDriveB, 'no drive-home-to-bed after a gym that ends hours before bedtime — free evening, not a scheduled drive')

  const workDriveB = driveTo('Work')
  ok(!!workDriveB && workDriveB.mins === 30, `Tuesday's commute uses home→work (30 min, got ${workDriveB?.mins})`)
  ok(workDriveB.toPlace === 'work', 'drive to the work address says "work"')
  ok(driveTitles.some((t) => t.includes('drive to work')) && driveTitles.includes(labelFor(workDriveB)), `work commute reads "drive to work" (want "${labelFor(workDriveB)}")`)
  // the drive carries its destination in its label + accent class
  const classDrive = page.locator('.lad-card--drive', { hasText: 'drive to Chemistry class' })
  ok(await classDrive.count() === 1, 'drive is its own block, carrying its destination in the label')
  ok((await classDrive.getAttribute('class')).includes('lad-drive--to-cal'), 'drive block carries its destination-type accent (lad-drive--to-cal)')
  ok((await classDrive.getAttribute('title')).includes('5 min cushion'), 'drive tooltip still reports the +5 min cushion (buffer applied)')
  {
    // 20 min drive + 5 buffer = 25 min = 18.75px, below the 24px readability
    // floor — so this ALSO exercises the min-card-height stretch below.
    const driveBox = await classDrive.boundingBox()
    const destBox = await page.locator('.lad-card--cal', { hasText: 'Chemistry class' }).boundingBox()
    const MIN_H = 24, PPM = 0.75, natural = 25 * PPM
    ok(Math.abs(driveBox.height - MIN_H) <= 1, `short drive is stretched to the readable floor, not left at its true ${natural}px (${driveBox.height.toFixed(1)}px)`)
    // bottom edge unmoved (still the real arrival time, == the event's top) —
    // the drive grows UPWARD when stretched, never down into the event, so
    // the event can never paint over (hide) the drive.
    ok(Math.abs((driveBox.y + driveBox.height) - destBox.y) <= 1, `drive's bottom stays pinned exactly at the event's top — zero overlap with its destination (${((driveBox.y + driveBox.height) - destBox.y).toFixed(1)}px gap)`)
    ok(driveBox.y < destBox.y - natural + 1, `the stretch bled UPWARD (earlier), not into the destination (drive top ${driveBox.y.toFixed(1)} vs natural start ${(destBox.y - natural).toFixed(1)})`)
  }
  console.log('A2c. drive is never visually covered by the event it drives to')
  ok(await page.evaluate(() => getComputedStyle(document.querySelector('.lad-card--drive')).zIndex) === '3', 'drives paint above regular cards (z-index 3 > 2), can never be hidden behind one')
  {
    // Sample points along the drive's own box and confirm the element hit at
    // each one really is the drive (or its own children), not the event card
    // painted on top of it — i.e. the drive is fully visible, not obscured.
    // (The plan now auto-scrolls to today's current-time line, so a next-day
    // drive starts offscreen — bring it into view before hit-testing.)
    await classDrive.scrollIntoViewIfNeeded()
    const box = await classDrive.boundingBox()
    const hits = await page.evaluate(({ x, y, w, h }) => {
      const pts = [0.25, 0.5, 0.75].map((f) => document.elementFromPoint(x + w / 2, y + h * f))
      return pts.map((el) => !!el?.closest('.lad-card--drive'))
    }, { x: box.x, y: box.y, w: box.width, h: box.height })
    ok(hits.every(Boolean), `every point inside the drive's box actually hit the drive, not something drawn over it (${JSON.stringify(hits)})`)
  }

  console.log('A2b. no card is too short for its text to fit')
  const shortCards = await page.locator('.lad-card').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height))
  ok(shortCards.length > 10 && shortCards.every((h) => h >= 23), `every card (incl. every drive) is at least the 24px readability floor (min seen: ${Math.min(...shortCards).toFixed(1)}px)`)
  // the title text itself must actually render inside that floor, not just the box
  const titleFits = await page.locator('.lad-card--drive .lad-card__title').first().evaluate((el) => {
    const card = el.closest('.lad-card')
    return card.getBoundingClientRect().height >= el.getBoundingClientRect().height
  })
  ok(titleFits, 'a stretched card is tall enough to contain its own title line (not just padded taller with the text still clipped)')

  console.log('A3. gym from the Gym plugin')
  const gymCard = page.locator('.lad-card--gym')
  ok(await gymCard.count() === 1, 'one gym block (Monday is the only planned workout day)')
  ok((await gymCard.innerText()).includes('Push day'), 'gym block carries the workout name')
  const gymBox = await gymCard.boundingBox()
  const canvasBox = await page.locator('#lad-canvas').boundingBox()
  const PPM = 0.75
  // Position is asserted on the block's real START TIME, not a linear pixel
  // offset — the y-axis is piecewise now (dense morning regions stretch), so
  // pixel-from-midnight math no longer equals clock minutes.
  const gymBlock = await page.evaluate(() => window.__ladder.blocks.find((b) => b.type === 'gym'))
  ok(new Date(gymBlock.start).getHours() === 16 && new Date(gymBlock.start).getMinutes() === 0, `gym starts at 16:00, the gym-hours window opening (${new Date(gymBlock.start).toLocaleTimeString()})`)
  ok(Math.round((gymBlock.end - gymBlock.start) / 60000) === 65, `gym duration is the 65-min historic average, not the 75-min default (${Math.round((gymBlock.end - gymBlock.start) / 60000)}m)`)
  // its rendered height still reflects that 65 min (gym isn't in a dense region, so it maps ~linearly)
  ok(Math.abs(gymBox.height / PPM - 65) < 4, `gym card height tracks its duration (${Math.round(gymBox.height / PPM)}m)`)

  console.log('A4. flexible events')
  // Day membership is asserted on block start TIMES against day boundaries (the
  // piecewise y-axis means pixel-from-midnight is no longer a clock reading).
  const dayOfBlock = (b) => Math.floor((b.start - new Date('2026-07-06T00:00:00').getTime()) / 86400000)
  const blk = (t) => page.evaluate((title) => window.__ladder.blocks.find((b) => b.title === title), t)
  ok(dayOfBlock(await blk('Monday study')) === 0, 'recurring Monday event landed on Monday (day 0)')
  ok(dayOfBlock(await blk('Tuesday project')) === 1, 'day-specific event landed on its day (Tuesday, day 1)')
  ok(await page.locator('.lad-card--flex', { hasText: 'Project work' }).count() === 1, 'week-level flexible event placed somewhere in the window')
  ok(await page.locator('.lad-card--meal').count() >= 18, 'meals placed across the window')
  const bfast = await blk('Breakfast')
  ok(new Date(bfast.start).getHours() === 8 && new Date(bfast.start).getMinutes() === 0, `first day's breakfast lands at its 8:00 preferred time, not clamped to "now" (${new Date(bfast.start).toLocaleTimeString()})`)

  console.log('A5. cross-midnight event: one card, line crosses proportionally')
  const late = page.locator('.lad-card--cal', { hasText: 'Late show' })
  ok(await late.count() === 1, 'event spanning midnight is ONE card, not split')
  const lateBox = await late.boundingBox()
  const lines = await page.locator('.lad-dayline').all()
  let crossing = null
  for (const l of lines) {
    const b = await l.boundingBox()
    if (b.y > lateBox.y && b.y < lateBox.y + lateBox.height) crossing = b
  }
  ok(!!crossing, 'a day line passes through the card')
  const frac = crossing ? (crossing.y - lateBox.y) / lateBox.height : -1
  ok(Math.abs(frac - 1 / 3) < 0.02, `line crosses at the 1/3 mark — 23:00→02:00 puts midnight a third in (${frac.toFixed(3)})`)

  console.log('A6. planner never writes to Google Calendar')
  ok(state.writes.length === 0, `no POST/PATCH/DELETE to googleapis (${state.writes.join(', ') || 'none'})`)

  console.log('A6b. event addresses: aliases, on-card display, geocode failures')
  const orgo = page.locator('.lad-card--cal', { hasText: 'Orgo lecture' })
  ok((await orgo.locator('.lad-card__loc').innerText()).includes('Fretwell 306'), "card shows the event's own location text")
  const orgoDriveB = driveTo('Orgo lecture')
  ok(!!orgoDriveB && orgoDriveB.mins === 20, `alias resolves "Fretwell 306" to the class address — drive computed via home→class (20 min, got ${orgoDriveB?.mins})`)
  ok(driveTitles.includes(labelFor(orgoDriveB)), `Orgo drive shows its time range (want "${labelFor(orgoDriveB)}")`)
  const semDriveB = driveTo('Evening seminar')
  ok(!!semDriveB && semDriveB.mins === 30, `event with NO location resolves through a TITLE alias to work (30 min, got ${semDriveB?.mins})`)
  ok(driveTitles.includes(labelFor(semDriveB)), `seminar drive shows its time range (want "${labelFor(semDriveB)}")`)
  const myst = page.locator('.lad-card--cal', { hasText: 'Mystery meetup' })
  ok(await myst.locator('.lad-card__loc--bad').count() === 1, 'unresolvable location is marked "not found" on the card')
  ok((await page.locator('#lad-notices').innerText()).includes('Nowhere Hall'), 'geocode failure reported in the notices')
  ok(!driveTitles.some((t) => t.includes('Mystery meetup')), 'no drive block fabricated for an unlocatable event')

  console.log('A7. add + remove a flex event from the page')
  await page.fill('#lad-new-title', 'Oversized thing')
  await page.fill('#lad-new-dur', '20:00')
  await page.click('[data-lad="add"]')
  await page.waitForFunction(() => document.getElementById('lad-notices')?.textContent.includes('Oversized thing'), null, { timeout: 20000 })
  ok(true, 'an unplaceable event is reported, not silently dropped')
  await page.fill('#lad-new-title', 'Quick errand')
  await page.fill('#lad-new-dur', '0:30')
  await page.click('[data-lad="add"]')
  await page.waitForFunction(() => [...document.querySelectorAll('.lad-card--flex')].some((c) => c.textContent.includes('Quick errand')), null, { timeout: 20000 })
  ok(true, 'h:mm-entered flex event gets placed')
  const before = await page.locator('.lad-card--flex', { hasText: 'Quick errand' }).count()
  await page.locator('.lad-card--flex', { hasText: 'Quick errand' }).locator('.lad-card__x').click()
  await page.waitForFunction(() => ![...document.querySelectorAll('.lad-card--flex')].some((c) => c.textContent.includes('Quick errand')), null, { timeout: 20000 })
  ok(before === 1, 'deleting a flex card removes it from the plan')

  ok(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 250)})`)
  await ctx.close()
}

// ---- A8. drive minutes round UP to the nearest 5 (never down, never left raw) -------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.clock.install({ time: NOW })
  const RAW = { odd: 23, even: 20 } // 23 → should round UP to 25; 20 already exact, stays 20
  await page.route('https://www.googleapis.com/calendar/v3/users/me/calendarList**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'primary', summary: 'Personal' }] }) }))
  await page.route('https://www.googleapis.com/calendar/v3/calendars/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [
      { id: 'ev-odd', status: 'confirmed', summary: 'Odd event', location: 'odd loc', start: { dateTime: D(6, '10:00') }, end: { dateTime: D(6, '11:00') } },
      { id: 'ev-even', status: 'confirmed', summary: 'Even event', location: 'even loc', start: { dateTime: D(7, '10:00') }, end: { dateTime: D(7, '11:00') } },
    ] }) }))
  await page.route('https://nominatim.openstreetmap.org/**', (route) => {
    const q = new URL(route.request().url()).searchParams.get('q').toLowerCase()
    const key = q.includes('odd') ? 'odd' : q.includes('even') ? 'even' : q.includes('home') ? 'home' : null
    const lat = { home: 40, odd: 40.1, even: 40.2 }[key]
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lat ? [{ lat: String(lat), lon: '-90' }] : []) })
  })
  await page.route('https://router.project-osrm.org/**', (route) => {
    // URL is driving/{originLon},{originLat};{destLon},{destLat} — the
    // destination (what determines which fixture's drive this is) is the
    // SECOND coordinate pair, after the semicolon.
    const m = route.request().url().match(/;[^,]+,([\d.]+)/)
    const toLat = Number(m[1])
    const rawMin = Math.abs(toLat - 40.1) < 0.01 ? RAW.odd : RAW.even
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [{ duration: rawMin * 60 }] }) })
  })
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
    localStorage.setItem('atlas.ladder.v1', JSON.stringify({
      home: 'home address', wake: '07:00', bed: '23:00', windowDays: 7, buffer: 5,
      meals: [], flex: [], geo: {}, drives: {}, aliases: [],
    }))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  console.log('A8. drive-time rounding')
  const rblocks = await page.evaluate(() => window.__ladder.blocks)
  const oddDrive = rblocks.find((b) => b.type === 'drive' && b.toTitle === 'Odd event')
  const evenDrive = rblocks.find((b) => b.type === 'drive' && b.toTitle === 'Even event')
  ok(oddDrive?.mins === 25, `a raw 23-min route rounds UP to 25, never down to 20 (got ${oddDrive?.mins})`)
  ok(evenDrive?.mins === 20, `a raw 20-min route (already a multiple of 5) is left at 20, not bumped to 25 (got ${evenDrive?.mins})`)
  await ctx.close()
}

// ---- A9. a drive-time CACHE HIT re-rounds too — not just a freshly fetched route -----
// (routeMinutes returns a cache hit verbatim; only loadLadder's own normalization
// pass catches a value that was cached before this rounding rule existed.)
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.clock.install({ time: NOW })
  await page.route('https://www.googleapis.com/calendar/v3/users/me/calendarList**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'primary', summary: 'Personal' }] }) }))
  await page.route('https://www.googleapis.com/calendar/v3/calendars/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [
      // ends at bedtime, so the drive home into sleep is kept (an early event
      // would drop it now — see section K) and both cached legs are exercised.
      { id: 'ev-stale', status: 'confirmed', summary: 'Stale event', location: 'stale loc', start: { dateTime: D(6, '21:30') }, end: { dateTime: D(6, '23:00') } },
    ] }) }))
  let osrmCalled = false
  await page.route('https://router.project-osrm.org/**', (route) => {
    osrmCalled = true // shouldn't fire at all — 999 makes it obvious in the data if it does
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [{ duration: 999 * 60 }] }) })
  })
  await page.route('https://nominatim.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
    localStorage.setItem('atlas.ladder.v1', JSON.stringify({
      home: 'home address', wake: '07:00', bed: '23:00', windowDays: 7, buffer: 5,
      meals: [], flex: [], aliases: [],
      geo: { 'home address': { lat: 40, lon: -90 }, 'stale loc': { lat: 40.5, lon: -90 } },
      // both directions pre-cached (there's also a drive back home for sleep)
      // with stale un-rounded values, so a genuinely zero-network run is possible.
      drives: { '40.0000,-90.0000>40.5000,-90.0000': 23, '40.5000,-90.0000>40.0000,-90.0000': 17 },
    }))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  console.log('A9. stale cached drive minutes are re-rounded on load')
  const sblocks = await page.evaluate(() => window.__ladder.blocks)
  const staleDrive = sblocks.find((b) => b.type === 'drive' && b.toTitle === 'Stale event')
  const staleHome = sblocks.find((b) => b.type === 'drive' && b.toType === 'sleep')
  ok(staleDrive?.mins === 25, `a pre-existing cached 23-min entry is corrected to 25 on load, not left stale forever (got ${staleDrive?.mins})`)
  ok(staleHome?.mins === 20, `the reverse-direction cached 17-min entry also corrects to 20 (got ${staleHome?.mins})`)
  ok(!osrmCalled, 'both directions were cache hits — OSRM is never re-queried; this is a load-time fix, not a new network round-trip')
  await ctx.close()
}

// ---- F. attached (paired) events: front/back of an anchor, by tag or by id ---------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  const state = { writes: [] }
  await installFakes(page, state)
  await page.clock.install({ time: NOW })
  await page.addInitScript(SEED)
  await page.addInitScript(() => { // runs after SEED — append the attached defs
    const s = JSON.parse(localStorage.getItem('atlas.ladder.v1'))
    s.flex.push(
      { id: 'af1', title: 'Post-gym cleanup', minutes: 45, kind: 'attached', side: 'after', anchorTag: 'gym', place: 'home' },
      { id: 'af2', title: 'Pack bag', minutes: 30, kind: 'attached', side: 'before', anchorId: 'cal-ev-class', place: 'home' },
      // 600m after Wed yoga (ends 16:00) runs to 02:00 — straight into the
      // Evening seminar, a REAL calendar event (immovable). The gym is not a
      // valid obstacle anymore: planner-placed blocks move for attachments.
      { id: 'af3', title: 'Overflow thing', minutes: 600, kind: 'attached', side: 'after', anchorId: 'cal-ev-yoga-1', place: 'none' },
      { id: 'af4', title: 'Ghost', minutes: 30, kind: 'attached', side: 'after', anchorId: 'cal-nope', place: 'none' },
    )
    localStorage.setItem('atlas.ladder.v1', JSON.stringify(s))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  const at = (day, hm) => new Date(`2026-07-${String(day).padStart(2, '0')}T${hm}:00`).getTime()
  const fblocks = await page.evaluate(() => window.__ladder.blocks)

  console.log('F1. after-attachment at home: gym → drive home → cleanup, as one train')
  const cleanup = fblocks.find((b) => b.attached && b.title === 'Post-gym cleanup')
  ok(!!cleanup, 'cleanup block exists, paired to the gym session')
  ok(cleanup?.start === at(6, '17:35') && cleanup?.end === at(6, '18:20'),
    `cleanup runs 5:35–6:20 PM — gym ends 5:05, +25 min drive home +5 cushion (got ${new Date(cleanup?.start).toLocaleTimeString()}–${new Date(cleanup?.end).toLocaleTimeString()})`)
  const cleanupDrive = fblocks.find((b) => b.type === 'drive' && b.toTitle === 'Post-gym cleanup')
  ok(!!cleanupDrive && cleanupDrive.mins === 25 && cleanupDrive.end === cleanup.start, 'the drive home is pulled in between gym and cleanup (gym→home leg)')
  const monSleepDrive = fblocks.find((b) => b.type === 'drive' && b.toType === 'sleep' && b.start < at(7, '00:00'))
  ok(!monSleepDrive, "no separate late-night drive home before Monday's sleep — the chain already came home for the cleanup")

  console.log('F2. before-attachment at home: pack bag, then the drive to class')
  const pack = fblocks.find((b) => b.attached && b.title === 'Pack bag')
  ok(pack?.start === at(6, '09:05') && pack?.end === at(6, '09:35'),
    `pack-bag ends 9:35 AM, exactly where the 20+5 min drive to the 10:00 class departs (got ${new Date(pack?.start).toLocaleTimeString()}–${new Date(pack?.end).toLocaleTimeString()})`)
  const classDrv = fblocks.find((b) => b.type === 'drive' && b.toTitle === 'Chemistry class')
  ok(!!classDrv && classDrv.start === pack.end, "the class's own drive-in departs the moment pack-bag ends — a seamless train")
  // Pack-bag is only 30 min → a compact card (< 34px tall at the default
  // window scale). Unlike other short cards, an attached block's time is
  // COMPUTED (it rides the anchor), so it stays visible even when compact.
  const packCardH = await page.locator('.lad-card--attached', { hasText: 'Pack bag' }).evaluate((el) => el.getBoundingClientRect().height)
  const packCardText = await page.locator('.lad-card--attached', { hasText: 'Pack bag' }).innerText()
  ok(packCardH < 34, `pack-bag card is compact as expected (${packCardH}px)`)
  ok(/9:05\s?AM.*9:35\s?AM/.test(packCardText), `compact attached card still shows its time range (got ${JSON.stringify(packCardText)})`)

  console.log('F3. impossible pairings error out, never silently vanish')
  const notices = await page.locator('#lad-notices').innerText()
  ok(notices.includes('Overflow thing') && notices.includes('Evening seminar') && notices.includes('is in the way'), `a pairing blocked by a real calendar event reports what's in the way (${notices.slice(0, 160)}…)`)
  ok(notices.includes('Ghost') && notices.includes("anchor event isn't in this window"), 'a pairing whose anchor no longer exists says so')
  ok(!fblocks.some((b) => b.title === 'Overflow thing'), 'the blocked pairing is not drawn overlapping something else')

  console.log('F4. creating an attached event from the bar')
  await page.selectOption('#lad-new-kind', 'attached')
  ok(!(await page.locator('#lad-new-anchor').isHidden()), 'choosing "Attached to…" reveals side/anchor/place controls')
  const anchorOptions = await page.locator('#lad-new-anchor option').allInnerTexts()
  ok(anchorOptions.some((t) => t.includes('every gym session')), 'anchor list offers every-instance tags')
  ok(anchorOptions.some((t) => t.includes('Chemistry class')), "anchor list offers the window's specific upcoming events")
  await page.fill('#lad-new-title', 'Warm-up')
  await page.fill('#lad-new-dur', '0:20')
  await page.selectOption('#lad-new-side', 'before')
  await page.selectOption('#lad-new-anchor', 'tag:gym')
  await page.selectOption('#lad-new-place', 'same')
  await page.click('[data-lad="add"]')
  await page.waitForFunction(() => window.__ladder?.blocks.some((b) => b.title === 'Warm-up'), null, { timeout: 20000 })
  const warm = await page.evaluate(() => window.__ladder.blocks.find((b) => b.title === 'Warm-up'))
  ok(warm.attached && warm.end === at(6, '16:00'), 'bar-created warm-up butts against the gym start (before-side, same place)')
  ok(await page.locator('.lad-card--attached', { hasText: 'Warm-up' }).count() === 1, 'attached card is visually marked as paired')
  await page.locator('.lad-card--attached', { hasText: 'Warm-up' }).locator('.lad-card__x').click()
  await page.waitForFunction(() => window.__ladder?.blocks && !window.__ladder.blocks.some((b) => b.title === 'Warm-up'), null, { timeout: 20000 })
  ok(true, 'deleting the attached card removes the pairing everywhere')

  console.log('F5. sleep + auto-detected recurring events as anchors')
  await page.selectOption('#lad-new-kind', 'attached')
  const opts2 = await page.locator('#lad-new-anchor option').allInnerTexts()
  ok(opts2.some((t) => t === 'every sleep'), 'anchor list includes "every sleep"')
  ok(opts2.some((t) => t.includes('every “Yoga”')), 'the recurring "Yoga" (shared recurringEventId) is auto-detected as an anchor option')
  ok(opts2.filter((t) => t.includes('every “Yoga”')).length === 1, 'a recurring series appears ONCE, not once per instance')
  // attach to every Yoga occurrence
  await page.fill('#lad-new-title', 'Stretch')
  await page.fill('#lad-new-dur', '0:15')
  await page.selectOption('#lad-new-side', 'before')
  await page.selectOption('#lad-new-anchor', 'series:rec-yoga')
  await page.selectOption('#lad-new-place', 'none')
  await page.click('[data-lad="add"]')
  await page.waitForFunction(() => window.__ladder?.blocks.filter((b) => b.title === 'Stretch').length === 2, null, { timeout: 20000 })
  const stretches = await page.evaluate(() => window.__ladder.blocks.filter((b) => b.title === 'Stretch').map((b) => b.end))
  ok(stretches.length === 2 && stretches.includes(at(8, '15:00')) && stretches.includes(at(10, '15:00')),
    'one Stretch lands before EVERY Yoga occurrence (Wed + Fri 15:00), not just one')
  // attach a wind-down before every sleep (the Add above re-rendered the page,
  // resetting the kind dropdown — reselect "attached" to reveal the controls)
  await page.selectOption('#lad-new-kind', 'attached')
  await page.waitForFunction(() => [...document.querySelectorAll('#lad-new-anchor option')].some((o) => o.value === 'tag:sleep'), null, { timeout: 10000 })
  await page.fill('#lad-new-title', 'Wind down')
  await page.fill('#lad-new-dur', '0:20')
  await page.selectOption('#lad-new-side', 'before')
  await page.selectOption('#lad-new-anchor', 'tag:sleep')
  await page.selectOption('#lad-new-place', 'none')
  await page.click('[data-lad="add"]')
  await page.waitForFunction(() => window.__ladder?.blocks.filter((b) => b.title === 'Wind down').length >= 3, null, { timeout: 20000 })
  const winds = await page.evaluate(() => window.__ladder.blocks.filter((b) => b.title === 'Wind down'))
  ok(winds.length >= 3, `"every sleep" places a wind-down before multiple nights' sleep (${winds.length})`)
  ok(winds.every((b) => b.attached && b.anchorTitle === 'Sleep'), 'each wind-down is paired to a Sleep block')

  ok(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 250)})`)
  await ctx.close()
}

// ---- H. planner-placed gym MOVES for a sleep-anchored attachment -------------------
// The user's exact report: "Morning Routine" after every sleep errored with
// "Chest & Back A is in the way" — the gym had already squatted at wake. The
// gym isn't hard-set in the calendar, so it must route around the routine.
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  const state = { writes: [] }
  await installFakes(page, state)
  await page.clock.install({ time: NOW })
  await page.addInitScript(SEED)
  await page.addInitScript(() => {
    // gym hours unconstrained → without the fix the gym lands right AT wake
    const g = JSON.parse(localStorage.getItem('atlas.gym.v1'))
    delete g.hours
    localStorage.setItem('atlas.gym.v1', JSON.stringify(g))
    const s = JSON.parse(localStorage.getItem('atlas.ladder.v1'))
    s.flex.push({ id: 'mr1', title: 'Morning Routine', minutes: 30, kind: 'attached', side: 'after', anchorTag: 'sleep', place: 'none' })
    localStorage.setItem('atlas.ladder.v1', JSON.stringify(s))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  console.log('H. gym moves out of the way of a sleep-anchored routine')
  const notices = await page.locator('#lad-notices').innerText().catch(() => '')
  ok(!notices.includes('Morning Routine'), `no "can't fit" errors for the routine (${notices.slice(0, 120) || 'no notices'})`)
  const hblocks = await page.evaluate(() => window.__ladder.blocks)
  const at = (day, hm) => new Date(`2026-07-${String(day).padStart(2, '0')}T${hm}:00`).getTime()
  const routines = hblocks.filter((b) => b.title === 'Morning Routine')
  ok(routines.length >= 7, `a routine placed after every night's sleep (${routines.length})`)
  const monRoutine = routines.find((b) => b.start === at(6, '07:00'))
  ok(!!monRoutine && monRoutine.end === at(6, '07:30'), 'Monday routine sits right at wake, 7:00–7:30')
  const monGym = hblocks.find((b) => b.type === 'gym' && b.start < at(7, '00:00'))
  ok(!!monGym && monGym.start === at(6, '08:00'), `gym MOVED past the routine — starts 8:00 (7:30 + 30 min drive), not at wake (got ${monGym ? new Date(monGym.start).toLocaleTimeString() : 'missing'})`)
  await ctx.close()
}

// ---- I. gym reserves its drive OUT — never crammed against the next event ----------
// The user's report: only Calculus (9:45, located) on the calendar, gym filled
// the morning gap wall-to-wall (ending exactly 9:45), forcing the gym→class
// drive to overlap the gym's tail — while the free afternoon sat unused.
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.route('https://www.googleapis.com/**', (route) => {
    const u = new URL(route.request().url())
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (u.pathname.endsWith('/users/me/calendarList')) return json({ items: [{ id: 'primary', summary: 'Personal' }] })
    if (u.pathname.includes('/calendars/primary/events')) return json({ items: [
      { id: 'calc', status: 'confirmed', summary: 'Calculus', location: '200 Class Blvd', start: { dateTime: D(6, '09:45') }, end: { dateTime: D(6, '11:00') } },
    ] })
    return json({ items: [] })
  })
  const state = { writes: [] }
  await Promise.all([
    page.route('https://nominatim.openstreetmap.org/**', (route) => {
      const q = new URL(route.request().url()).searchParams.get('q').toLowerCase()
      const key = Object.keys(GEO).find((k) => q.includes(k))
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(key ? [{ lat: String(GEO[key]), lon: '-80.0' }] : []) })
    }),
    page.route('https://router.project-osrm.org/**', (route) => {
      const m = route.request().url().match(/driving\/[^,]+,([\d.]+);[^,]+,([\d.]+)/)
      const a = latName(Number(m[1])), b = latName(Number(m[2]))
      const mins = DRIVES[`${a}|${b}`] ?? DRIVES[`${b}|${a}`] ?? 25
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [{ duration: mins * 60 }] }) })
    }),
  ])
  await page.clock.install({ time: NOW })
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
    // Sleep 23:00 + 9h → wake 08:00, so the morning gap 8:00–9:45 holds
    // drive-in(30) + gym(75) EXACTLY, with zero room for the gym→class leg.
    // Must skip to after class instead. (Bedtime + length come from the Sleep
    // plugin now; the ladder's own wake is just a fallback.)
    localStorage.setItem('atlas.sleep.v1', JSON.stringify({ prefMin: 540, bedtime: '23:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3, logs: [] }))
    localStorage.setItem('atlas.ladder.v1', JSON.stringify({ home: '100 Home St', wake: '08:00', windowDays: 7, buffer: 5, meals: [], flex: [], geo: {}, drives: {}, aliases: [] }))
    localStorage.setItem('atlas.gym.v1', JSON.stringify({ v: 1, workouts: [{ id: 'gw1', name: 'Push day' }], exercises: [], logs: [],
      completions: [], plan: { type: 'weekly', weekly: { mon: 'gw1', tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, cycle: { order: [], position: 0 } },
      unit: 'kg', address: '300 Gym Rd', defaultDuration: 75 }))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  console.log('I. gym skips a gap that has no room for its drive out')
  const at = (day, hm) => new Date(`2026-07-${String(day).padStart(2, '0')}T${hm}:00`).getTime()
  const iblocks = await page.evaluate(() => window.__ladder.blocks)
  const gym = iblocks.find((b) => b.type === 'gym')
  ok(!!gym && gym.start === at(6, '11:15') && gym.end === at(6, '12:30'),
    `gym placed AFTER Calculus (11:15–12:30 = class end + 10+5 drive), not crammed before it (got ${gym ? new Date(gym.start).toLocaleTimeString() + '–' + new Date(gym.end).toLocaleTimeString() : 'missing'})`)
  const overlaps = iblocks.filter((b) => b !== gym && b.start < gym.end && b.end > gym.start).map((b) => b.title)
  ok(overlaps.length === 0, `nothing overlaps the gym block (${overlaps.join(', ') || 'clean'})`)
  const notices = await page.locator('#lad-notices').innerText().catch(() => '')
  ok(!notices.includes('Tight'), `no "Tight: drive overlaps" warning (${notices.slice(0, 100) || 'no notices'})`)
  await ctx.close()
}

// ---- I2. the gym's WHOLE outbound train is composed, not min()'d -------------------
// The user's live setup: gym → drive home → post-gym routine at home → drive to
// class. The first fix reserved only ONE outbound leg, so a longer workout let
// the train overflow the class start ("Tight: the drive to Calculus II
// overlaps what's before it" ×4 on their screen).
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.route('https://www.googleapis.com/**', (route) => {
    const u = new URL(route.request().url())
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (u.pathname.endsWith('/users/me/calendarList')) return json({ items: [{ id: 'primary', summary: 'Personal' }] })
    if (u.pathname.includes('/calendars/primary/events')) return json({ items: [
      { id: 'calc1', status: 'confirmed', summary: 'Calculus II', location: '200 Class Blvd', recurringEventId: 'rec-calc', start: { dateTime: D(6, '10:30') }, end: { dateTime: D(6, '12:00') } },
      { id: 'calc2', status: 'confirmed', summary: 'Calculus II', location: '200 Class Blvd', recurringEventId: 'rec-calc', start: { dateTime: D(7, '10:30') }, end: { dateTime: D(7, '12:00') } },
    ] })
    return json({ items: [] })
  })
  await Promise.all([
    page.route('https://nominatim.openstreetmap.org/**', (route) => {
      const q = new URL(route.request().url()).searchParams.get('q').toLowerCase()
      const key = Object.keys(GEO).find((k) => q.includes(k))
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(key ? [{ lat: String(GEO[key]), lon: '-80.0' }] : []) })
    }),
    page.route('https://router.project-osrm.org/**', (route) => {
      const m = route.request().url().match(/driving\/[^,]+,([\d.]+);[^,]+,([\d.]+)/)
      const a = latName(Number(m[1])), b = latName(Number(m[2]))
      const mins = DRIVES[`${a}|${b}`] ?? DRIVES[`${b}|${a}`] ?? 25
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [{ duration: mins * 60 }] }) })
    }),
  ])
  await page.clock.install({ time: NOW })
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
    localStorage.setItem('atlas.ladder.v1', JSON.stringify({ home: '100 Home St', wake: '07:00', bed: '23:00', windowDays: 7, buffer: 5, meals: [],
      flex: [
        { id: 'mr', title: 'Morning Routine', minutes: 30, kind: 'attached', side: 'after', anchorTag: 'sleep', place: 'none' },
        { id: 'pg', title: 'Post-gym', minutes: 15, kind: 'attached', side: 'after', anchorTag: 'gym', place: 'home' },
      ], geo: {}, drives: {}, aliases: [] }))
    // Mon workout avg 60 min (train fits the morning EXACTLY-ish), Tue avg 105
    // (train overflows the 10:30 class → gym must relocate to after class)
    localStorage.setItem('atlas.gym.v1', JSON.stringify({ v: 1,
      workouts: [{ id: 'w60', name: 'Short day' }, { id: 'w105', name: 'Long day' }], exercises: [], logs: [],
      completions: [
        { workoutId: 'w60', date: '2026-06-29', ts: 1, start: '17:00', end: '18:00' },
        { workoutId: 'w105', date: '2026-06-30', ts: 2, start: '17:00', end: '18:45' },
      ],
      plan: { type: 'weekly', weekly: { mon: 'w60', tue: 'w105', wed: null, thu: null, fri: null, sat: null, sun: null }, cycle: { order: [], position: 0 } },
      unit: 'kg', address: '300 Gym Rd', defaultDuration: 75 }))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  console.log('I2. composed outbound train: gym → home → post-gym → class')
  const at = (day, hm) => new Date(`2026-07-${String(day).padStart(2, '0')}T${hm}:00`).getTime()
  const bs = await page.evaluate(() => window.__ladder.blocks)
  const t = (b) => `${new Date(b.start).toLocaleTimeString()}–${new Date(b.end).toLocaleTimeString()}`
  // Monday (60-min workout): whole train fits the morning.
  // routine 7:00–7:30 → drive 30 → gym 8:00–9:00 → drive home 30 → post-gym
  // 9:30–9:45 → drive to class 25 → 10:10 ≤ 10:30 class ✓
  const monGym = bs.find((b) => b.type === 'gym' && b.start < at(7, '00:00'))
  ok(!!monGym && monGym.start === at(6, '08:00') && monGym.end === at(6, '09:00'), `Monday's 60-min workout keeps its morning slot — the full train fits (got ${monGym ? t(monGym) : 'missing'})`)
  const monPg = bs.find((b) => b.attached && b.title === 'Post-gym' && b.start < at(7, '00:00'))
  ok(!!monPg && monPg.start === at(6, '09:30') && monPg.end === at(6, '09:45'), `Monday post-gym at home 9:30–9:45, after the drive home (got ${monPg ? t(monPg) : 'missing'})`)
  // Tuesday (105-min workout): 8:00+105 = 9:45, +45 train = 10:30, +25 leg =
  // 10:55 > 10:30 class → overflow → gym relocates to after class.
  const tueGym = bs.find((b) => b.type === 'gym' && b.start >= at(7, '00:00'))
  ok(!!tueGym && tueGym.start === at(7, '12:15') && tueGym.end === at(7, '14:00'), `Tuesday's 105-min workout MOVES past the class (12:15–14:00 = class end + 10+5 drive), instead of overflowing into it (got ${tueGym ? t(tueGym) : 'missing'})`)
  const notices = await page.locator('#lad-notices').innerText().catch(() => '')
  ok(!notices.includes('Tight'), `no "Tight: drive overlaps" warnings anywhere (${notices.slice(0, 120) || 'no notices'})`)
  const gyms = bs.filter((b) => b.type === 'gym')
  const overl = bs.filter((b) => gyms.some((g) => b !== g && b.start < g.end && b.end > g.start)).map((b) => b.title)
  ok(overl.length === 0, `nothing overlaps any gym block (${overl.join(', ') || 'clean'})`)
  await ctx.close()
}

// ---- G. dense region stretches the y-axis so nothing overlaps ----------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.clock.install({ time: NOW })
  // 10 back-to-back 12-min calendar events on Monday afternoon: 120 min of real
  // time = 90px linear, but 10 cards each needing ≥24px = ≥240px. Under a linear
  // axis they'd pile up unreadably; the map must stretch this region.
  const TIGHT = Array.from({ length: 10 }, (_, i) => {
    const startMin = 13 * 60 + i * 12
    const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    return { id: 'ev-t' + i, status: 'confirmed', summary: 'Meeting ' + i, start: { dateTime: D(6, hm(startMin)) }, end: { dateTime: D(6, hm(startMin + 12)) } }
  })
  await page.route('https://www.googleapis.com/**', (route) => {
    const u = new URL(route.request().url())
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (u.pathname.endsWith('/users/me/calendarList')) return json({ items: [{ id: 'primary', summary: 'Personal' }] })
    if (u.pathname.includes('/calendars/primary/events')) return json({ items: TIGHT })
    return json({ items: [] })
  })
  await page.route('https://nominatim.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await page.route('https://router.project-osrm.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"routes":[]}' }))
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
    localStorage.setItem('atlas.ladder.v1', JSON.stringify({ home: '', wake: '07:00', bed: '23:00', windowDays: 7, buffer: 5, meals: [], flex: [], geo: {}, drives: {}, aliases: [] }))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  console.log('G. dense cluster stretches the axis, no overlaps')
  const boxes = await page.locator('.lad-card--cal').evaluateAll((els) => els
    .map((e) => e.getBoundingClientRect())
    .map((r) => ({ top: r.top, bottom: r.bottom, h: r.height }))
    .sort((a, b) => a.top - b.top))
  ok(boxes.length === 10, `all 10 tight meetings rendered (${boxes.length})`)
  ok(boxes.every((b) => b.h >= 23), `every card cleared the readable floor (min ${Math.min(...boxes.map((b) => b.h)).toFixed(1)}px)`)
  let maxOverlap = 0
  for (let i = 1; i < boxes.length; i++) maxOverlap = Math.max(maxOverlap, boxes[i - 1].bottom - boxes[i].top)
  ok(maxOverlap <= 1, `no two consecutive cards overlap in pixels (worst ${maxOverlap.toFixed(1)}px)`)
  // the 120-min cluster occupies ≥ 240px (10×24), well over its 90px linear span
  const clusterPx = boxes[boxes.length - 1].bottom - boxes[0].top
  ok(clusterPx >= 238, `the dense region was stretched from ~90px linear to ${Math.round(clusterPx)}px so all 10 fit`)
  // a sparse part of the SAME day is still ~linear: the map only expands where needed
  const total = await page.evaluate(() => window.__ladder.total ?? (window.__ladder.y ? null : null))
  ok(await page.evaluate(() => typeof window.__ladder.y === 'function'), 'y-map exposed for inspection')
  const linearVsMapped = await page.evaluate(() => {
    const y = window.__ladder.y, ws = window.__ladder.windowStart
    const t9 = ws + 9 * 3600000, t10 = ws + 10 * 3600000 // 9–10am on day 0, empty
    return (y(t10) - y(t9)) / (60 * 0.75) // ratio to the linear 45px
  })
  ok(Math.abs(linearVsMapped - 1) < 0.05, `an empty hour stays clock-linear (rate ${linearVsMapped.toFixed(3)}× baseline), only the crowded region stretched`)
  await ctx.close()
}

// ---- B. work: upcoming shift auto-push to the Atlas Work calendar -------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  const calls = []
  await page.route('https://www.googleapis.com/**', (route) => {
    const u = new URL(route.request().url())
    const method = route.request().method()
    calls.push(`${method} ${u.pathname}`)
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (u.pathname.endsWith('/users/me/calendarList')) return json({ items: [{ id: 'primary', summary: 'Personal' }] })
    if (method === 'POST' && u.pathname.endsWith('/calendars')) return json({ id: 'cal-new-work' })
    if (method === 'POST' && u.pathname.includes('/calendars/cal-new-work/events')) {
      calls.push('BODY:' + JSON.stringify(route.request().postDataJSON()))
      return json({ id: 'ev-shift-1' })
    }
    if (method === 'DELETE') return route.fulfill({ status: 204, body: '' })
    return json({ items: [] })
  })
  await page.addInitScript(() => {
    localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
    localStorage.setItem('atlas.page.work.v1', JSON.stringify({
      v: 1, rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'wkupcoming' }] }] }] }] }],
    }))
  })
  await page.goto(`${BASE}/#/work`)
  await page.waitForSelector('.pwidget--wkupcoming')
  console.log('B. upcoming shifts push')
  await page.fill('.wk-datein', '2026-08-14')
  await page.fill('.wk-up-start', '18:00')
  await page.fill('.wk-up-end', '01:30')
  await page.click('[data-wk-act="add-upcoming"]')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('atlas.work.v1') || '{}').upcoming?.[0]?.gcalId === 'ev-shift-1', null, { timeout: 10000 })
  ok(calls.some((c) => c === 'POST /calendar/v3/calendars'), 'creates the dedicated Atlas Work calendar')
  const body = calls.find((c) => c.startsWith('BODY:'))
  ok(body?.includes('"2026-08-14T18:00:00"'), 'event starts at the shift start')
  ok(body?.includes('"2026-08-15T01:30:00"'), 'overnight shift ends the NEXT day, one event')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).calId) === 'cal-new-work', 'calendar id remembered')
  await page.click('[data-wk-act="del-upcoming"]')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('atlas.work.v1')).upcoming.length === 0)
  await page.waitForTimeout(300)
  ok(calls.some((c) => c.startsWith('DELETE') && c.includes('ev-shift-1')), 'removing the shift deletes the calendar event')
  await ctx.close()
}

// ---- C. gym: timed completion feeds the duration average ----------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    localStorage.setItem('atlas.gym.v1', JSON.stringify({
      v: 1, workouts: [{ id: 'gw1', name: 'Push day' }],
      exercises: [{ id: 'ge1', workoutId: 'gw1', name: 'Bench', unilateral: false }], logs: [], completions: [],
      plan: { type: 'weekly', weekly: { mon: 'gw1', tue: 'gw1', wed: 'gw1', thu: 'gw1', fri: 'gw1', sat: 'gw1', sun: 'gw1' }, cycle: { order: [], position: 0 } },
      unit: 'kg',
    }))
    localStorage.setItem('atlas.page.gym.v1', JSON.stringify({
      v: 1, rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'gymcurrent' }] }] }] }] }],
    }))
  })
  await page.goto(`${BASE}/#/gym`)
  await page.waitForSelector('.gym-times')
  console.log('C. timed gym completions')
  await page.fill('.gym-time-in', '17:05')
  await page.fill('.gym-time-out', '18:20')
  await page.click('[data-gym-act="complete"]')
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('atlas.gym.v1')).completions.length === 1)
  const comp = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.gym.v1')).completions[0])
  ok(comp.start === '17:05' && comp.end === '18:20', 'completion records the session start/end')
  await ctx.close()
}

// ---- D. cycle-type gym plans project forward (the exclude-today regression) --------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.clock.install({ time: NOW }) // same frozen Sunday 09:00 → window Mon..Sun
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('atlas.gym.v1', JSON.stringify({
      v: 1,
      workouts: [{ id: 'gw1', name: 'Push day' }, { id: 'gw2', name: 'Pull day' }],
      exercises: [], logs: [], completions: [],
      plan: { type: 'cycle', weekly: {}, cycle: { order: ['gw1', 'gw2'], position: 0 } },
      unit: 'kg', address: '', hours: {}, defaultDuration: 60,
    }))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  console.log('D. cycle plan gym blocks now show on future days, not just today')
  const gymCards = await page.locator('.lad-card--gym').allInnerTexts()
  ok(gymCards.some((t) => t.includes('Push day')), `Monday (position 0) gets Push day (${gymCards.join(' | ')})`)
  ok(gymCards.some((t) => t.includes('Pull day')), 'Tuesday (position 1) gets Pull day — cycle projected forward, not stuck on "today"')
  ok(gymCards.length >= 6, `cycle repeats across the whole window (${gymCards.length} gym blocks)`)
  await ctx.close()
}

// ---- D2. after completing today's cycle workout, the plan reflects the one
// you're NOW on — not the one after it. Completing advances cycle.position, so
// the forward projection must not count today again (was: skipped the current).
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.clock.install({ time: NOW }) // frozen Sunday 2026-07-05 09:00
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    // CYCLE [Push, Pull, Legs]. Did PUSH today → completeWorkout advanced
    // position 0→1, so the user is now ON Pull, with today's completion logged.
    localStorage.setItem('atlas.gym.v1', JSON.stringify({
      v: 1,
      workouts: [{ id: 'A', name: 'Push' }, { id: 'B', name: 'Pull' }, { id: 'C', name: 'Legs' }],
      exercises: [], logs: [],
      completions: [{ workoutId: 'A', date: '2026-07-05', ts: 1, start: '', end: '' }],
      plan: { type: 'cycle', weekly: {}, cycle: { order: ['A', 'B', 'C'], position: 1 } },
      unit: 'kg', address: '', hours: { start: '06:00', end: '21:00' }, defaultDuration: 60,
    }))
    localStorage.setItem('atlas.ladder.v1', JSON.stringify({ home: '', wake: '07:00', windowDays: 4, buffer: 5, meals: [], flex: [], geo: {}, drives: {}, aliases: [] }))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  console.log("D2. cycle reflects the current workout after today's is done")
  const seq = await page.evaluate(() => window.__ladder.blocks.filter((b) => b.type === 'gym').sort((a, z) => a.start - z.start).map((b) => b.title))
  ok(seq[0] === 'Pull', `the next gym day is the workout you're ON (Pull), not the one after it (got ${seq[0]})`)
  ok(seq.slice(0, 3).join(',') === 'Pull,Legs,Push', `the projection rotates from the current position (got ${seq.slice(0, 3).join(',')})`)
  ok(!seq.slice(0, 1).includes('Push'), "today's already-done Push is not re-planned tomorrow")
  await ctx.close()
}

// ---- J. flexible sleep: full nights that SHIFT around hard commitments -------------
// Calendar events + shifts are immovable; sleep keeps its target length by
// moving (later after a late shift, earlier before an early event), and only
// shrinks — logged as sleep debt — when pinned from both sides.
{
  // Every scenario: home lat 40, class 40.5, work 40.7, lon -90. Geocodes and
  // drive minutes are PRE-CACHED (home↔class 20, home↔work 30) so runs are
  // deterministic and network-free; buffer 5 makes the legs 25 and 35 min.
  const sleepCtx = async (events, work, sleepStore, ladderBed, flex) => {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    const page = await ctx.newPage()
    await page.clock.install({ time: NOW })
    await page.route('https://www.googleapis.com/calendar/v3/users/me/calendarList**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'primary', summary: 'Personal' }] }) }))
    await page.route('https://www.googleapis.com/calendar/v3/calendars/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: events }) }))
    await page.route('https://nominatim.openstreetmap.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
    await page.route('https://router.project-osrm.org/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [{ duration: 25 * 60 }] }) }))
    await page.addInitScript(({ work, sleepStore, ladderBed, flex }) => {
      localStorage.setItem('atlas.devMode', '1')
      localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
      localStorage.setItem('atlas.ladder.v1', JSON.stringify({
        home: 'home address', wake: '07:00', ...(ladderBed ? { bed: ladderBed } : {}), windowDays: 7, buffer: 5,
        meals: [], flex: flex || [], aliases: [],
        geo: { 'home address': { lat: 40, lon: -90 }, '200 class blvd': { lat: 40.5, lon: -90 }, '400 work ave': { lat: 40.7, lon: -90 } },
        drives: {
          '40.0000,-90.0000>40.5000,-90.0000': 20, '40.5000,-90.0000>40.0000,-90.0000': 20,
          '40.0000,-90.0000>40.7000,-90.0000': 30, '40.7000,-90.0000>40.0000,-90.0000': 30,
        },
      }))
      localStorage.setItem('atlas.work.v1', JSON.stringify({ wage: 15, tips: false, openEnded: false, shifts: [], ranges: {}, upcoming: work, address: '400 Work Ave', calId: 'cal-work' }))
      if (sleepStore) localStorage.setItem('atlas.sleep.v1', JSON.stringify(sleepStore))
    }, { work, sleepStore, ladderBed, flex })
    await page.goto(`${BASE}/#/ladder`)
    await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
    const plan = await page.evaluate(() => ({ blocks: window.__ladder.blocks, warnings: window.__ladder.warnings }))
    await ctx.close()
    return plan
  }
  const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
  const sleepInto = (plan, day) => plan.blocks.find((b) => b.type === 'sleep' && new Date(b.end).getDate() === day)
  const durMin = (b) => Math.round((b.end - b.start) / 60000)

  console.log('J. flexible sleep')
  // J1: shift Mon 17:00 → Tue 01:00 at work. Drive home 30+5, so bed Tue
  // 01:35 — and the night stays FULL 8h, waking 09:35.
  {
    const plan = await sleepCtx([], [{ id: 'up1', date: '2026-07-06', start: '17:00', end: '01:00', gcalId: 'g1' }])
    const n = sleepInto(plan, 7)
    ok(n && hhmm(n.start) === '01:35', `late shift pushes bed to 01:35 after the drive home (got ${n && hhmm(n.start)})`)
    ok(n && durMin(n) === 480, `the night keeps its full 8h — wake shifts to ${n && hhmm(n.end)} (${n && durMin(n)}m)`)
    ok(!plan.warnings.some((w) => w.includes('Short night')), 'a late night alone is not a short night')
  }
  // J2: early lab Tue 06:00 at class, evening free. Bed pulls EARLIER to
  // Mon 21:35 (cap 05:35 = 06:00 − 25m drive) and the night stays full.
  {
    const plan = await sleepCtx([{ id: 'ev-lab', status: 'confirmed', summary: 'Early lab', location: '200 Class Blvd', start: { dateTime: D(7, '06:00') }, end: { dateTime: D(7, '07:30') } }], [])
    const n = sleepInto(plan, 7)
    ok(n && hhmm(n.start) === '21:35' && hhmm(n.end) === '05:35', `free evening → bed pulls earlier for a full night before the early lab (got ${n && hhmm(n.start)}–${n && hhmm(n.end)})`)
    ok(n && durMin(n) === 480, 'still a full 8h night')
    ok(!plan.warnings.some((w) => w.includes('Short night')), 'protected night → no debt warning')
  }
  // J3: BOTH — shift till 01:00 and a lab at 08:00. Pinned on both sides:
  // 01:35 → 07:35 is all that fits (6h), and the 2h loss is called out.
  {
    const plan = await sleepCtx(
      [{ id: 'ev-lab', status: 'confirmed', summary: 'Early lab', location: '200 Class Blvd', start: { dateTime: D(7, '08:00') }, end: { dateTime: D(7, '09:30') } }],
      [{ id: 'up1', date: '2026-07-06', start: '17:00', end: '01:00', gcalId: 'g1' }])
    const n = sleepInto(plan, 7)
    ok(n && hhmm(n.start) === '01:35' && hhmm(n.end) === '07:35', `pinned both sides → 01:35–07:35 (got ${n && hhmm(n.start)}–${n && hhmm(n.end)})`)
    ok(plan.warnings.some((w) => w.includes('Short night') && w.includes('+2h sleep debt')), `short night surfaces the 2h debt (${plan.warnings.find((w) => w.includes('Short'))})`)
  }
  // J4: the Sleep plugin drives the target — 6h logged last night = 2h debt,
  // recouped at ratio 1.2 over 3 nights → +50m on the first three nights.
  {
    const plan = await sleepCtx([], [], {
      prefMin: 480, bedtime: '23:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3,
      logs: [{ id: 'n1', type: 'night', date: '2026-07-05', start: '01:00', end: '07:00', minutes: 360 }],
    })
    const tonight = sleepInto(plan, 6) // Sun night → Mon morning
    const later = sleepInto(plan, 10) // 5th night — past recoverNights
    ok(tonight && durMin(tonight) === 530, `debt-aware target: tonight plans 8h50m, not 8h (got ${tonight && durMin(tonight)}m)`)
    ok(later && durMin(later) === 480, `nights past the recoup window fall back to preferred hours (got ${later && durMin(later)}m)`)
  }
  // J5: bedtime comes from the Sleep plugin (22:00 here), and a stale ladder
  // `bed` (20:00) is ignored entirely — the planner has no bedtime of its own.
  {
    const plan = await sleepCtx([], [], { prefMin: 480, bedtime: '22:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3, logs: [] }, '20:00')
    const n = sleepInto(plan, 7) // free night → bed sits exactly at the plugin bedtime
    ok(n && hhmm(n.start) === '22:00' && hhmm(n.end) === '06:00', `free night uses the Sleep plugin bedtime 22:00, not the stale ladder 20:00 (got ${n && hhmm(n.start)}–${n && hhmm(n.end)})`)
  }

  console.log('K. drive-home-to-bed only when the day ends near bedtime')
  const driveToSleep = (plan, day) => plan.blocks.find((b) => b.type === 'drive' && b.toType === 'sleep' && new Date(b.end).getDate() === day)
  const driveIntoRoutine = (plan) => plan.blocks.find((b) => b.type === 'drive' && b.toTitle === 'Evening routine')
  // K1: last event ends at NOON (class), bed at 23:00 — 11h of free evening.
  // The drive home is not pinned before sleep; you drift home on your own time.
  {
    const plan = await sleepCtx([{ id: 'ev-noon', status: 'confirmed', summary: 'Noon class', location: '200 Class Blvd', start: { dateTime: D(7, '10:30') }, end: { dateTime: D(7, '12:00') } }], [])
    ok(!driveToSleep(plan, 8), 'gym/class ending at noon → NO drive-home-to-bed before a midnight bedtime (free evening)')
  }
  // K2: work runs till 23:30 — you drive straight home to sleep, so the drive
  // home IS shown (30-min home↔work leg + 5 buffer).
  {
    const plan = await sleepCtx([], [{ id: 'up-late', date: '2026-07-07', start: '15:00', end: '23:30', gcalId: 'g2' }])
    const d = driveToSleep(plan, 8)
    ok(!!d && d.mins === 30, `work ending 23:30 → drive home into bedtime IS kept (got ${d ? d.mins + 'min' : 'missing'})`)
  }
  // K3: a sleep-anchored evening routine. Free evening → no drive to the
  // routine either; the drive only appears when the day ends late.
  const routineFlex = [{ id: 'lf-eve', title: 'Evening routine', minutes: 30, kind: 'attached', side: 'before', place: 'home', anchorTag: 'sleep' }]
  {
    const free = await sleepCtx([{ id: 'ev-noon', status: 'confirmed', summary: 'Noon class', location: '200 Class Blvd', start: { dateTime: D(7, '10:30') }, end: { dateTime: D(7, '12:00') } }], [], null, null, routineFlex)
    ok(!driveIntoRoutine(free), 'free evening → sleep-anchored routine carries no drive home')
    const late = await sleepCtx([], [{ id: 'up-late', date: '2026-07-07', start: '15:00', end: '23:30', gcalId: 'g2' }], null, null, routineFlex)
    const d = driveIntoRoutine(late)
    ok(!!d && d.mins === 30, `late night → drive home leads into the evening routine (got ${d ? d.mins + 'min' : 'missing'})`)
  }
}

// ---- L. set (fixed) events + push the plan to per-type calendars ------------------
// Set events are immovable local commitments (a hard block like a cal event).
// Pushing routes each block type to its own calendar "folder"; a day can be
// re-pushed (replace) or removed (delete). Google is faked with a stateful mock
// that records created/deleted events and grows a calendar list on demand.
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  const created = [], deleted = [], calsByName = {}
  let calSeq = 0, evSeq = 0
  await page.route('https://www.googleapis.com/**', (route) => {
    const req = route.request(), u = new URL(req.url()), method = req.method(), p = u.pathname
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (p.endsWith('/users/me/calendarList')) return json({ items: Object.values(calsByName).map((c) => ({ id: c.id, summary: c.summary })) })
    if (p === '/calendar/v3/calendars' && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}'); const id = `cal-${++calSeq}`
      calsByName[body.summary] = { id, summary: body.summary }; return json({ id, summary: body.summary })
    }
    const mCreate = p.match(/\/calendars\/([^/]+)\/events$/)
    if (mCreate && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}')
      created.push({ calId: decodeURIComponent(mCreate[1]), id: `ev-${++evSeq}`, summary: body.summary, start: body.start.dateTime })
      return json({ id: `ev-${evSeq}` })
    }
    const mDel = p.match(/\/calendars\/([^/]+)\/events\/([^/]+)$/)
    if (mDel && method === 'DELETE') { deleted.push({ calId: decodeURIComponent(mDel[1]), id: decodeURIComponent(mDel[2]) }); return route.fulfill({ status: 204, body: '' }) }
    return json({ items: [] })
  })
  await page.route('https://nominatim.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
  await page.route('https://router.project-osrm.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [{ duration: 25 * 60 }] }) }))
  await page.clock.install({ time: NOW })
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
    localStorage.setItem('atlas.ladder.v1', JSON.stringify({
      home: '100 Home St', wake: '07:00', windowDays: 2, buffer: 5, meals: [], aliases: [],
      geo: { '100 home st': { lat: 40, lon: -90 }, '300 gym rd': { lat: 40.2, lon: -90 } },
      drives: { '40.0000,-90.0000>40.2000,-90.0000': 25, '40.2000,-90.0000>40.0000,-90.0000': 25 },
      flex: [{ id: 'sf1', title: 'Dentist', kind: 'set', date: '2026-07-06', start: '14:00', end: '15:30', minutes: 90 }],
    }))
    localStorage.setItem('atlas.gym.v1', JSON.stringify({ v: 1, workouts: [{ id: 'gw1', name: 'Push day' }], exercises: [], logs: [], completions: [],
      plan: { type: 'weekly', weekly: { mon: 'gw1', tue: null, wed: null, thu: null, fri: null, sat: null, sun: null }, cycle: { order: [], position: 0 } },
      unit: 'kg', address: '300 Gym Rd', hours: { start: '06:00', end: '21:00' }, defaultDuration: 60 }))
    localStorage.setItem('atlas.sleep.v1', JSON.stringify({ prefMin: 480, bedtime: '23:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3, logs: [] }))
  })
  await page.goto(`${BASE}/#/ladder`)
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
  const at = (day, hm) => new Date(`2026-07-${String(day).padStart(2, '0')}T${hm}:00`).getTime()
  const calNameOf = (calId) => Object.values(calsByName).find((x) => x.id === calId)?.summary

  console.log('L. set (fixed) events + calendar push')
  const setBlk = await page.evaluate(() => window.__ladder.blocks.find((x) => x.type === 'set'))
  ok(setBlk && setBlk.start === at(6, '14:00') && setBlk.end === at(6, '15:30'), `a set event lands as a fixed block at its exact clock time (got ${setBlk ? new Date(setBlk.start).toLocaleTimeString() : 'missing'})`)
  ok(await page.locator('.lad-card--set').count() === 1, 'the set event draws as its own (set-styled) card')

  // add a second set event from the bar
  await page.selectOption('#lad-new-kind', 'set')
  ok(!(await page.locator('#lad-new-start').isHidden()) && !(await page.locator('#lad-new-end').isHidden()), 'choosing "Set event" reveals start + end time inputs')
  ok(await page.locator('#lad-new-dur').isHidden(), 'the duration field hides for a set event (its length is start→end)')
  await page.fill('#lad-new-title', 'Meeting')
  await page.fill('#lad-new-date', '2026-07-06')
  await page.fill('#lad-new-start', '16:00')
  await page.fill('#lad-new-end', '17:00')
  await page.click('[data-lad="add"]')
  await page.waitForFunction(() => window.__ladder?.blocks.some((b) => b.type === 'set' && b.title === 'Meeting'), null, { timeout: 20000 })
  const mtg = await page.evaluate(() => window.__ladder.blocks.find((b) => b.title === 'Meeting'))
  ok(mtg && mtg.start === at(6, '16:00') && mtg.end === at(6, '17:00'), 'a set event created from the bar lands at its typed start→end')

  // push Monday to the calendars
  await page.locator('[data-lad="push-day"][data-day="2026-07-06"]').click()
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('pushed'), null, { timeout: 20000 })
  const sum = (s) => created.find((c) => c.summary === s)
  ok(sum('Push day') && calNameOf(sum('Push day').calId) === 'Atlas Gym', 'the gym session pushes to the "Atlas Gym" calendar')
  ok(created.some((c) => c.summary.startsWith('Drive')) && created.filter((c) => c.summary.startsWith('Drive')).every((c) => calNameOf(c.calId) === 'Atlas Drives'), 'every drive block pushes to the "Atlas Drives" calendar')
  ok(sum('Dentist') && calNameOf(sum('Dentist').calId) === 'Atlas Ladder', 'a set event pushes to the general "Atlas Ladder" calendar')
  ok(sum('Sleep') && calNameOf(sum('Sleep').calId) === 'Atlas Ladder', 'sleep pushes to the "Atlas Ladder" calendar')
  ok(!created.some((c) => c.summary === 'Work'), 'synced work shifts are NOT re-pushed (no duplicates)')

  // re-push replaces (deletes the old, no accumulation)
  const beforeRepush = created.length, delBefore = deleted.length
  await page.locator('[data-lad="push-day"][data-day="2026-07-06"]').click()
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('pushed'), null, { timeout: 20000 })
  ok(deleted.length > delBefore && created.length - beforeRepush === beforeRepush, 're-pushing a day deletes the previous events first, then recreates (replace, not duplicate)')

  // remove the day → all its events deleted, button gone
  const liveIds = new Set(created.map((c) => c.id))
  deleted.forEach((d) => liveIds.delete(d.id))
  await page.locator('[data-lad="remove-day"][data-day="2026-07-06"]').click()
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('removed'), null, { timeout: 20000 })
  const stillLive = [...liveIds].filter((id) => !deleted.some((d) => d.id === id))
  ok(stillLive.length === 0, `removing a day deletes every event it pushed (${stillLive.length} left behind)`)
  ok(await page.locator('[data-lad="remove-day"][data-day="2026-07-06"]').count() === 0, 'after removal the day shows no "remove" button')

  // push-all covers every day in the window
  created.length = 0
  await page.locator('[data-lad="push-all"]').click()
  await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('pushed 2 days'), null, { timeout: 20000 })
  const days = new Set(created.map((c) => c.start.slice(0, 10)))
  ok(days.has('2026-07-05') && days.has('2026-07-06'), `"Push all" pushes every day in the window (${[...days].join(', ')})`)

  ok(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 200)})`)
  await ctx.close()
}

await browser.close()
console.log(`\nladder: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
