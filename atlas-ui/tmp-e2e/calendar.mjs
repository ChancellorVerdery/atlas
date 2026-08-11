// Calendar plugin suite — Google Calendar API faked at the network layer with
// real RRULE expansion (singleEvents=true), so the app's actual fetch/parse/
// grid/mutation code runs end-to-end. Headless always.
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }
// Wait for a just-created event to land in the fake store. Asserting on the
// month-grid chip instead is day-of-week fragile: a month cell shows only its
// first 3 events, so a new event on an already-busy "today" (e.g. a Monday that
// already holds a recurring standup) overflows into "+N more" and never renders
// a chip — green on a quiet day, red on a busy one.
const waitStore = async (S, summary, ms = 10000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { if ([...S.events.values()].some((e) => e.summary === summary)) return true; await new Promise((r) => setTimeout(r, 40)) }
  return false
}

// ---- fake Google Calendar backend -------------------------------------------

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const parseD = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
const daysInMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()

const today = new Date(); today.setHours(0, 0, 0, 0)
const at = (base, h, m = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m)
const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1)
const monthAgo = new Date(today); monthAgo.setDate(today.getDate() - 30)

function freshState() {
  return {
    cals: [
      { id: 'primary', summary: 'Chance', backgroundColor: '#7986cb', primary: true, accessRole: 'owner' },
      { id: 'work@group.calendar.google.com', summary: 'Work', backgroundColor: '#33b679', accessRole: 'owner' },
    ],
    events: new Map([
      ['e1', { id: 'e1', _cal: 'primary', summary: 'Standup review', status: 'confirmed',
        start: { dateTime: at(today, 10).toISOString() }, end: { dateTime: at(today, 11).toISOString() } }],
      ['e2', { id: 'e2', _cal: 'work@group.calendar.google.com', summary: 'Launch day', status: 'confirmed',
        start: { date: ymd(today) }, end: { date: ymd(tomorrow) } }],
      ['e3', { id: 'e3', _cal: 'primary', summary: 'Morning run', status: 'confirmed',
        start: { dateTime: at(monthAgo, 7).toISOString() }, end: { dateTime: at(monthAgo, 7, 45).toISOString() },
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'] }],
      ['e4', { id: 'e4', _cal: 'work@group.calendar.google.com', summary: 'Team sync', status: 'confirmed',
        start: { dateTime: at(tomorrow, 14).toISOString() }, end: { dateTime: at(tomorrow, 15).toISOString() },
        attendees: [
          { email: 'chance@example.com', self: true, responseStatus: 'needsAction' },
          { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
        ] }],
    ]),
    overrides: new Map(), // instanceId → patch (or {status:'cancelled'})
    seq: 10, log: [],
  }
}

function expand(S, ev, timeMin, timeMax) {
  const out = []
  const rule = ev.recurrence?.find((r) => r.startsWith('RRULE:'))
  const allDay = !!ev.start.date
  const s = allDay ? parseD(ev.start.date) : new Date(ev.start.dateTime)
  const durMs = (allDay ? parseD(ev.end.date) : new Date(ev.end.dateTime)) - s
  if (!rule) {
    if (s < timeMax && new Date(s.getTime() + durMs) > timeMin) out.push(ev)
    return out
  }
  const get = (k) => rule.match(new RegExp(`${k}=([^;]+)`))?.[1]
  const freq = get('FREQ'), byday = get('BYDAY'), bymonthday = get('BYMONTHDAY'), until = get('UNTIL')
  const untilD = until ? new Date(+until.slice(0, 4), +until.slice(4, 6) - 1, +until.slice(6, 8), 23, 59, 59) : null
  const d = new Date(s.getFullYear(), s.getMonth(), s.getDate())
  for (let i = 0; i < 500 && d <= timeMax; i++, d.setDate(d.getDate() + 1)) {
    if (untilD && d > untilD) break
    let match = false
    if (freq === 'DAILY') match = true
    else if (freq === 'WEEKLY') match = (byday || '').split(',').includes(DAYS[d.getDay()])
    else if (bymonthday) match = d.getDate() === +bymonthday
    else if (byday) {
      const m = byday.match(/^(-?\d)([A-Z]{2})$/)
      match = d.getDay() === DAYS.indexOf(m[2]) &&
        (+m[1] === -1 ? d.getDate() + 7 > daysInMonth(d) : Math.floor((d.getDate() - 1) / 7) + 1 === +m[1])
    }
    if (!match) continue
    const st2 = allDay ? parseD(ymd(d)) : new Date(d.getFullYear(), d.getMonth(), d.getDate(), s.getHours(), s.getMinutes())
    if (!(st2 < timeMax && new Date(st2.getTime() + durMs) > timeMin)) continue
    const key = `${ev.id}_${ymd(d).replace(/-/g, '')}`
    const ov = S.overrides.get(key)
    if (ov?.status === 'cancelled') continue
    const base = {
      ...ev, recurrence: undefined, id: key, recurringEventId: ev.id,
      start: allDay ? { date: ymd(st2) } : { dateTime: st2.toISOString() },
      end: allDay ? { date: ymd(new Date(st2.getTime() + durMs)) } : { dateTime: new Date(st2.getTime() + durMs).toISOString() },
    }
    out.push(ov ? { ...base, ...ov, id: key, recurringEventId: ev.id, status: 'confirmed' } : base)
  }
  return out
}

function installFake(page, S) {
  return page.route('https://www.googleapis.com/calendar/v3/**', (route) => {
    const req = route.request()
    const u = new URL(req.url())
    const path = decodeURIComponent(u.pathname.replace('/calendar/v3/', ''))
    const method = req.method()
    const post = () => JSON.parse(req.postData() || '{}')
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o ?? {}) })
    S.log.push(`${method} ${path}`)

    if (path === 'users/me/calendarList') return json({ items: S.cals })
    let m
    if ((m = path.match(/^calendars\/([^/]+)\/events$/))) {
      const calId = m[1]
      if (method === 'POST') {
        const id = `e${++S.seq}`
        S.events.set(id, { ...post(), id, _cal: calId, status: 'confirmed' })
        S.log.push(`CREATE ${id} ${JSON.stringify(post().recurrence || [])}`)
        return json(S.events.get(id))
      }
      const timeMin = new Date(u.searchParams.get('timeMin'))
      const timeMax = new Date(u.searchParams.get('timeMax'))
      const items = [...S.events.values()].filter((e) => e._cal === calId)
        .flatMap((e) => expand(S, e, timeMin, timeMax))
        .sort((a, b) => new Date(a.start.dateTime || a.start.date) - new Date(b.start.dateTime || b.start.date))
      return json({ items })
    }
    if ((m = path.match(/^calendars\/([^/]+)\/events\/([^/?]+)$/))) {
      const id = m[2]
      if (method === 'GET') return json(S.events.get(id) || { error: 'nf' }, S.events.has(id) ? 200 : 404)
      if (method === 'PATCH') {
        const body = post()
        if (id.includes('_')) { S.overrides.set(id, { ...(S.overrides.get(id) || {}), ...body }); return json({ id }) }
        const ev = S.events.get(id)
        Object.assign(ev, body)
        return json(ev)
      }
      if (method === 'DELETE') {
        if (id.includes('_')) S.overrides.set(id, { status: 'cancelled' })
        else S.events.delete(id)
        return route.fulfill({ status: 204, body: '' })
      }
    }
    return json({ error: `unhandled ${method} ${path}` }, 500)
  })
}

// ---- suite -------------------------------------------------------------------

const browser = await chromium.launch({ headless: true })
const MONTH_LABEL = today.toLocaleDateString([], { month: 'long', year: 'numeric' }).replace(',', '')

// A. unconnected
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/#/calendar`)
  await page.waitForSelector('.mail-connect')
  console.log('A. unconnected')
  ok(await page.locator('#title').innerText() === 'Calendar', 'topbar label says Calendar')
  ok((await page.locator('.mail-connect__title').innerText()).includes('Connect Google Calendar'), 'connect card shown')
  ok(await page.locator('#customize').isHidden(), 'Customize hidden on calendar page')
  ok(await page.locator('.nav__item', { hasText: 'Calendar' }).count() === 1, 'Calendar in sidebar nav')
  await ctx.close()
}

// B. connected (fake API)
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept())
  const S = freshState()
  await installFake(page, S)
  await page.addInitScript(() => {
    localStorage.setItem('atlas.email.v1', JSON.stringify({
      clientId: 'test.apps.googleusercontent.com',
      token: { access_token: 'tok', expires_at: Date.now() + 3600e3 },
      address: 'chance@example.com', pinned: [],
    }))
    localStorage.setItem('atlas.page.v1', JSON.stringify({ v: 1, rows: [
      { id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [
        { id: 'w1', kind: 'calagenda' }, { id: 'w2', kind: 'calmonth' } ] }] }] }] } ] }))
  })
  await page.goto(`${BASE}/#/calendar`)
  await page.waitForSelector('.cal-cell')

  console.log('B1. month view')
  ok((await page.locator('#cal-label').innerText()).replace(' ', ' ') === MONTH_LABEL || (await page.locator('#cal-label').innerText()).includes(String(today.getFullYear())), `month label (${await page.locator('#cal-label').innerText()})`)
  ok(await page.locator('.cal-cell').count() === 42, '42-cell month grid')
  ok(await page.locator('.cal-cell--today').count() === 1, 'today highlighted')
  ok(await page.locator('.cal-chip', { hasText: 'Standup review' }).count() === 1, 'timed event chip in month')
  ok(await page.locator('.cal-chip--fill', { hasText: 'Launch day' }).count() >= 1, 'all-day event renders as filled chip')
  const runs = await page.locator('.cal-chip', { hasText: 'Morning run' }).count()
  ok(runs >= 6, `weekly recurrence expands across the month (${runs} instances)`)

  console.log('B2. calendar folders on/off')
  ok(await page.locator('.cal-src').count() === 2, 'both calendars listed')
  await page.click('.cal-src:nth-of-type(2) .cal-src__box')
  await page.waitForFunction(() => !document.querySelector('.cal-chip--fill'))
  ok(await page.locator('.cal-chip', { hasText: 'Launch day' }).count() === 0, 'disabled calendar hides its events')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.calendar.v1')).hiddenCals.length) === 1, 'hidden calendar persisted')
  await page.click('.cal-src:nth-of-type(2) .cal-src__box')
  await page.waitForSelector('.cal-chip--fill')
  ok(true, 're-enabled calendar shows events again')

  console.log('B3. sidebar toggle + navigation')
  await page.click('[data-cal="toggle-nav"]')
  ok(await page.locator('.cal-nav').isHidden(), 'calendar list hides')
  await page.click('[data-cal="toggle-nav"]')
  const label0 = await page.locator('#cal-label').innerText()
  await page.click('[data-cal="next"]')
  await page.waitForFunction((l) => document.querySelector('#cal-label').textContent !== l, label0)
  ok(await page.locator('#cal-label').innerText() !== label0, 'next month navigates')
  await page.click('[data-cal="today"]')
  await page.waitForFunction((l) => document.querySelector('#cal-label').textContent === l, label0)
  ok(true, 'Today returns')

  console.log('B4. week + day views')
  await page.click('[data-cal-view="week"]')
  await page.waitForSelector('.cal-week')
  ok(await page.locator('.cal-day-col').count() === 7, 'week view: 7 day columns')
  const block = page.locator('.cal-block', { hasText: 'Standup review' })
  ok(await block.count() === 1, 'timed block in week view')
  ok((await block.getAttribute('style')).includes(`top:${(10 * 60 / 60) * 44}px`), 'block positioned at 10:00')
  ok(await page.locator('.cal-now').count() === 1, 'now-line on today')
  await page.click('[data-cal-view="day"]')
  await page.waitForFunction(() => document.querySelectorAll('.cal-day-col').length === 1)
  ok(true, 'day view: single column')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.calendar.v1')).view) === 'day', 'view persisted')
  await page.click('[data-cal-view="month"]')
  await page.waitForSelector('.cal-cell')

  console.log('B5. create a simple event')
  await page.click('[data-cal="new"]')
  await page.waitForSelector('.cal-overlay')
  await page.fill('#ed-title', 'Dentist')
  await page.fill('#ed-start-time', '15:00')
  await page.fill('#ed-end-time', '16:00')
  await page.click('[data-cal-x="save"]')
  await page.waitForFunction(() => !document.querySelector('.cal-overlay'))
  ok(await waitStore(S, 'Dentist'), 'created event lands in the store')
  const dentist = [...S.events.values()].find((e) => e.summary === 'Dentist')
  ok(dentist && dentist.start.dateTime.includes('T15:00:00') && dentist.start.timeZone, 'created with local time + timezone')
  ok(!dentist.recurrence, 'no recurrence when Repeats=None')

  console.log('B6. weekly recurring with end date')
  await page.click('[data-cal="new"]')
  await page.waitForSelector('.cal-overlay')
  await page.fill('#ed-title', 'Gym class')
  await page.selectOption('#ed-freq', 'weekly')
  // start-day box is pre-checked; build an exact TU+TH set
  await page.evaluate(() => { for (const inp of document.querySelectorAll('.cal-dows input')) inp.checked = ['TU', 'TH'].includes(inp.value) })
  await page.selectOption('#ed-ends', 'on')
  const until = new Date(today); until.setDate(until.getDate() + 21)
  await page.fill('#ed-until', ymd(until))
  await page.click('[data-cal-x="save"]')
  await page.waitForFunction(() => !document.querySelector('.cal-overlay'))
  ok(await waitStore(S, 'Gym class'), 'recurring event lands in the store')
  const gymEv = [...S.events.values()].find((e) => e.summary === 'Gym class')
  ok(/^RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=\d{8}T\d{6}Z$/.test(gymEv?.recurrence?.[0] || ''), `weekly RRULE with UNTIL (${gymEv?.recurrence?.[0]})`)
  ok(await page.locator('.cal-chip', { hasText: 'Gym class' }).count() >= 4, 'weekly instances appear on the grid')

  console.log('B7. monthly recurrence, both flavors')
  await page.click('[data-cal="new"]')
  await page.waitForSelector('.cal-overlay')
  await page.fill('#ed-title', 'Rent')
  await page.selectOption('#ed-freq', 'monthly')
  await page.click('[data-cal-x="save"]')
  await page.waitForFunction(() => !document.querySelector('.cal-overlay'))
  const rent = [...S.events.values()].find((e) => e.summary === 'Rent')
  ok(rent?.recurrence?.[0] === `RRULE:FREQ=MONTHLY;BYMONTHDAY=${today.getDate()}`, `monthly-by-date RRULE (${rent?.recurrence?.[0]})`)
  await page.click('[data-cal="new"]')
  await page.waitForSelector('.cal-overlay')
  await page.fill('#ed-title', 'Board meeting')
  await page.selectOption('#ed-freq', 'monthly')
  await page.check('input[name="ed-monthly"][value="weekday"]', { force: true })
  await page.click('[data-cal-x="save"]')
  await page.waitForFunction(() => !document.querySelector('.cal-overlay'))
  const nth = Math.floor((today.getDate() - 1) / 7) + 1
  const isLast = today.getDate() + 7 > daysInMonth(today)
  const expected = `RRULE:FREQ=MONTHLY;BYDAY=${isLast && nth >= 4 ? -1 : nth}${DAYS[today.getDay()]}`
  const board = [...S.events.values()].find((e) => e.summary === 'Board meeting')
  ok(board?.recurrence?.[0] === expected, `monthly-by-weekday RRULE (${board?.recurrence?.[0]} vs ${expected})`)

  console.log('B8. edit one occurrence vs the whole series')
  await page.click('.cal-chip:has-text("Morning run")')
  await page.waitForSelector('.cal-panel')
  ok((await page.locator('.cal-panel__rule').innerText()).includes('Repeats'), 'view modal flags recurring event')
  await page.click('[data-cal-x="edit"]')
  await page.waitForSelector('[data-cal-scope]')
  ok(true, 'edit asks for scope')
  await page.click('[data-cal-scope="one"]')
  await page.waitForSelector('#ed-title')
  ok((await page.locator('.cal-panel__title').innerText()).includes('this occurrence'), 'single-occurrence editor')
  ok(await page.locator('#ed-freq').count() === 0, 'no recurrence controls for one occurrence')
  await page.fill('#ed-title', 'Morning run (moved)')
  await page.click('[data-cal-x="save"]')
  await page.waitForFunction(() => !document.querySelector('.cal-overlay'))
  await page.waitForSelector('.cal-chip:has-text("(moved)")')
  ok(S.log.some((l) => /PATCH calendars\/primary\/events\/e3_\d+/.test(l)), 'patch hit the instance id')
  ok(await page.locator('.cal-chip', { hasText: '(moved)' }).count() === 1, 'only that occurrence changed')
  await page.click('.cal-chip:has-text("Morning run"):not(:has-text("moved"))')
  await page.waitForSelector('.cal-panel')
  await page.click('[data-cal-x="edit"]')
  await page.click('[data-cal-scope="all"]')
  await page.waitForSelector('#ed-freq')
  ok(true, 'series editor keeps recurrence controls')
  await page.fill('#ed-title', 'Morning jog')
  await page.click('[data-cal-x="save"]')
  await page.waitForFunction(() => !document.querySelector('.cal-overlay'))
  await page.waitForSelector('.cal-chip:has-text("Morning jog")')
  ok(S.events.get('e3').summary === 'Morning jog', 'series master patched')
  ok(await page.locator('.cal-chip', { hasText: 'Morning jog' }).count() >= 5, 'all occurrences renamed')

  console.log('B9. delete one / delete series')
  const jogs = await page.locator('.cal-chip', { hasText: 'Morning jog' }).count()
  await page.click('.cal-chip:has-text("Morning jog")')
  await page.waitForSelector('.cal-panel')
  await page.click('[data-cal-x="delete"]')
  await page.click('[data-cal-scope="one"]')
  await page.waitForFunction((n) => document.querySelectorAll('.cal-chip')?.length >= 0 && [...document.querySelectorAll('.cal-chip')].filter((c) => c.textContent.includes('Morning jog')).length === n - 1, jogs)
  ok(true, 'deleting one occurrence removes exactly one chip')
  await page.click('.cal-chip:has-text("Morning jog")')
  await page.waitForSelector('.cal-panel')
  await page.click('[data-cal-x="delete"]')
  await page.click('[data-cal-scope="all"]')
  await page.waitForFunction(() => ![...document.querySelectorAll('.cal-chip')].some((c) => c.textContent.includes('Morning jog')))
  ok(!S.events.has('e3'), 'deleting the series removes the master')

  console.log('B10. invites: accept / decline')
  const sync = page.locator('.cal-chip', { hasText: 'Team sync' })
  ok((await sync.getAttribute('class')).includes('cal-chip--rsvp'), 'unanswered invite is marked on the grid')
  await sync.click()
  await page.waitForSelector('.cal-rsvp')
  ok(await page.locator('.cal-guest').count() === 2, 'guest list with statuses shown')
  await page.click('[data-cal-rsvp="accepted"]')
  await page.waitForFunction(() => !document.querySelector('.cal-overlay'))
  const self = S.events.get('e4').attendees.find((a) => a.self)
  ok(self.responseStatus === 'accepted', 'accept pushed to Google (responseStatus=accepted)')
  await page.waitForSelector('.cal-chip:has-text("Team sync"):not(.cal-chip--rsvp)')
  ok(true, 'answered invite loses the needs-reply marker')

  console.log('B11. editor validation + quick create from grid')
  await page.click('[data-cal="new"]')
  await page.waitForSelector('.cal-overlay')
  await page.fill('#ed-title', 'Backwards')
  await page.fill('#ed-start-time', '15:00')
  await page.fill('#ed-end-time', '14:00')
  await page.click('[data-cal-x="save"]')
  ok((await page.locator('#ed-status').innerText()) === 'End must be after start.', 'end-before-start rejected')
  await page.click('[data-cal-x="close"]')
  await page.click('[data-cal-view="week"]')
  await page.waitForSelector('.cal-day-col')
  const colBox = await page.locator('.cal-day-col').first().boundingBox()
  const scrollBox = await page.locator('.cal-week__scroll').boundingBox()
  await page.mouse.click(colBox.x + colBox.width - 6, scrollBox.y + 80) // an empty slot
  await page.waitForSelector('.cal-overlay')
  ok(await page.locator('#ed-start-time').count() === 1, 'clicking empty grid opens quick create')
  await page.click('[data-cal-x="close"]')

  console.log('B11c. HTML event notes render as clean text, not raw markup')
  // Inject an Outlook/Exchange-authored note (a whole HTML document whose only
  // real content is "Fretwell 306", with theme-hostile black inline color),
  // refetch, and open it in day view (no month-cell chip cap).
  S.events.set('e5', { id: 'e5', _cal: 'primary', summary: 'Chem lecture', status: 'confirmed',
    start: { dateTime: at(today, 13).toISOString() }, end: { dateTime: at(today, 14).toISOString() },
    description: '<html>\n<head>\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n</head>\n<body>\n<div class="PlainText" style="font-size:11pt">&nbsp;<span style="color:rgb(0,0,0)">Fretwell 306</span></div>\n</body>\n</html>' })
  await page.goto(`${BASE}/#/dashboard`)
  await page.goto(`${BASE}/#/calendar`)
  await page.waitForSelector('.cal-grid')
  await page.click('[data-cal-view="day"]')
  await page.waitForSelector('.cal-block:has-text("Chem lecture")')
  await page.click('.cal-block:has-text("Chem lecture")')
  await page.waitForSelector('.cal-panel .cal-desc')
  const notesText = (await page.locator('.cal-panel .cal-desc').innerText()).replace(/\s+/g, ' ').trim()
  ok(notesText === 'Fretwell 306', `HTML note shows only its content, no markup (got "${notesText}")`)
  const notesHTML = await page.locator('.cal-panel .cal-desc').innerHTML()
  ok(!/<html|PlainText|style=|<meta|<head/i.test(notesHTML), 'raw document wrapper + inline styles stripped from the rendered note')
  await page.click('[data-cal-x="edit"]')
  await page.waitForSelector('#ed-desc')
  ok((await page.locator('#ed-desc').inputValue()).trim() === 'Fretwell 306', 'editor shows the note as plain text, not HTML source')
  await page.click('[data-cal-x="save"]')
  await page.waitForFunction(() => !document.querySelector('.cal-overlay'))
  ok(S.events.get('e5').description.includes('PlainText'), 'saving an untouched HTML note preserves the original markup (non-destructive)')

  console.log('B12. dashboard widgets')
  await page.goto(`${BASE}/#/dashboard`)
  await page.waitForSelector('.cal-agrow')
  ok((await page.locator('.cal-agrow').allInnerTexts()).some((t) => t.includes('Standup review')), 'agenda widget lists today\'s events')
  ok((await page.locator('.cal-aghead').first().innerText()).toLowerCase() === 'today', 'agenda groups by day starting Today')
  await page.waitForSelector('.cal-mini')
  ok(await page.locator('.cal-mini__cell').count() === 42, 'mini month renders 42 cells')
  ok(await page.locator('.cal-mini__cell.is-today').count() === 1, 'mini month highlights today')
  ok(await page.locator('.cal-mini__dots i').count() > 0, 'mini month shows event dots')
  ok(await page.locator('.cal-mini button, .cal-agrow button').count() === 0, 'widgets are view-only (no buttons)')

  await ctx.close()
}

await browser.close()
console.log(`\ncalendar: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
