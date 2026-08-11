// Screenshot pass for the calendar plugin (headless, fake Calendar API).
import { chromium } from 'playwright'
const OUT = (process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp'
const BASE = 'http://localhost:5173'
const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const today = new Date(); today.setHours(0, 0, 0, 0)
const at = (b, h, m = 0) => new Date(b.getFullYear(), b.getMonth(), b.getDate(), h, m)
const shift = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return d }

const cals = [
  { id: 'primary', summary: 'Personal', backgroundColor: '#7986cb', accessRole: 'owner' },
  { id: 'work', summary: 'Work', backgroundColor: '#33b679', accessRole: 'owner' },
  { id: 'family', summary: 'Family', backgroundColor: '#e67c73', accessRole: 'owner' },
]
let seq = 0
const mk = (cal, summary, s, e, extra = {}) => ({
  id: `e${++seq}`, _cal: cal, summary, status: 'confirmed',
  start: s instanceof Date ? { dateTime: s.toISOString() } : { date: s },
  end: e instanceof Date ? { dateTime: e.toISOString() } : { date: e }, ...extra,
})
const events = [
  mk('primary', 'Morning run', at(shift(-30), 7), at(shift(-30), 7, 45), { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'] }),
  mk('work', 'Standup', at(shift(-20), 9, 30), at(shift(-20), 9, 45), { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'] }),
  mk('work', 'Design review', at(today, 11), at(today, 12, 30)),
  mk('work', 'Team sync', at(shift(1), 14), at(shift(1), 15), { attendees: [
    { email: 'chance@example.com', self: true, responseStatus: 'needsAction' },
    { email: 'ada@example.com', organizer: true, responseStatus: 'accepted' },
    { email: 'grace@example.com', responseStatus: 'tentative' },
  ], location: 'Observatory / Zoom', description: 'Quarterly roadmap walk-through.' }),
  mk('family', 'Anniversary dinner', at(shift(2), 19), at(shift(2), 21, 30)),
  mk('family', 'Cabin weekend', ymd(shift(8)), ymd(shift(11))),
  mk('primary', 'Rent due', at(shift(-40), 9), at(shift(-40), 9, 15), { recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1'] }),
  mk('primary', 'Dentist', at(today, 15), at(today, 16)),
  mk('work', '1:1 with Sam', at(today, 13), at(today, 13, 30)),
  mk('primary', 'Book club', at(shift(-35), 18), at(shift(-35), 19, 30), { recurrence: ['RRULE:FREQ=MONTHLY;BYDAY=2TU'] }),
]
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const dim = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
function expand(ev, timeMin, timeMax) {
  const rule = ev.recurrence?.[0]
  const allDay = !!ev.start.date
  const s = allDay ? new Date(ev.start.date + 'T00:00') : new Date(ev.start.dateTime)
  const dur = (allDay ? new Date(ev.end.date + 'T00:00') : new Date(ev.end.dateTime)) - s
  if (!rule) return s < timeMax && new Date(s.getTime() + dur) > timeMin ? [ev] : []
  const get = (k) => rule.match(new RegExp(`${k}=([^;]+)`))?.[1]
  const out = []
  const d = new Date(s.getFullYear(), s.getMonth(), s.getDate())
  for (let i = 0; i < 500 && d <= timeMax; i++, d.setDate(d.getDate() + 1)) {
    let m = false
    if (get('FREQ') === 'WEEKLY') m = get('BYDAY').split(',').includes(DAYS[d.getDay()])
    else if (get('BYMONTHDAY')) m = d.getDate() === +get('BYMONTHDAY')
    else if (get('BYDAY')) { const x = get('BYDAY').match(/^(-?\d)([A-Z]{2})$/); m = d.getDay() === DAYS.indexOf(x[2]) && (+x[1] === -1 ? d.getDate() + 7 > dim(d) : Math.floor((d.getDate() - 1) / 7) + 1 === +x[1]) }
    if (!m) continue
    const st2 = new Date(d.getFullYear(), d.getMonth(), d.getDate(), s.getHours(), s.getMinutes())
    if (!(st2 < timeMax && new Date(st2.getTime() + dur) > timeMin)) continue
    out.push({ ...ev, recurrence: undefined, id: `${ev.id}_${i}`, recurringEventId: ev.id, start: { dateTime: st2.toISOString() }, end: { dateTime: new Date(st2.getTime() + dur).toISOString() } })
  }
  return out
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
await page.route('https://www.googleapis.com/calendar/v3/**', (route) => {
  const u = new URL(route.request().url())
  const path = decodeURIComponent(u.pathname.replace('/calendar/v3/', ''))
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
  if (path === 'users/me/calendarList') return json({ items: cals })
  let m
  if ((m = path.match(/^calendars\/([^/]+)\/events$/))) {
    const timeMin = new Date(u.searchParams.get('timeMin')), timeMax = new Date(u.searchParams.get('timeMax'))
    return json({ items: events.filter((e) => e._cal === m[1]).flatMap((e) => expand(e, timeMin, timeMax)) })
  }
  if ((m = path.match(/^calendars\/[^/]+\/events\/([^/?]+)$/))) return json(events.find((e) => e.id === m[1]) || {})
  return json({})
})
await page.addInitScript(() => {
  localStorage.setItem('atlas.email.v1', JSON.stringify({
    clientId: 'x.apps.googleusercontent.com',
    token: { access_token: 'tok', expires_at: Date.now() + 3600e3 },
    address: 'chance@example.com', pinned: [],
  }))
  localStorage.setItem('atlas.page.v1', JSON.stringify({ v: 1, rows: [
    { id: 'r1', title: 'Schedule', cols: [
      { id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'calagenda' }] }] }] },
      { id: 'c2', sections: [{ id: 's2', lines: [{ id: 'l2', widgets: [{ id: 'w2', kind: 'calmonth' }] }] }] } ] } ] }))
})
await page.goto(`${BASE}/#/calendar`)
await page.waitForSelector('.cal-chip')
await page.waitForTimeout(900)
await page.screenshot({ path: `${OUT}/cal-month.png` })
await page.click('[data-cal-view="week"]')
await page.waitForSelector('.cal-block')
await page.waitForTimeout(300)
await page.screenshot({ path: `${OUT}/cal-week.png` })
await page.click('.cal-chip:has-text("Team sync"), .cal-block:has-text("Team sync")')
await page.waitForSelector('.cal-rsvp')
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/cal-invite.png` })
await page.click('[data-cal-x="close"]')
await page.click('[data-cal-view="month"]')
await page.waitForSelector('.cal-cell')
await page.click('[data-cal="new"]')
await page.waitForSelector('.cal-overlay')
await page.fill('#ed-title', 'Strength training')
await page.selectOption('#ed-freq', 'weekly')
await page.selectOption('#ed-ends', 'on')
await page.fill('#ed-until', ymd(shift(60)))
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/cal-editor.png` })
await page.click('[data-cal-x="close"]')
await page.goto(`${BASE}/#/dashboard`)
await page.waitForSelector('.cal-agrow')
await page.waitForSelector('.cal-mini')
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/cal-widgets.png` })
await browser.close()
console.log('shots done')
