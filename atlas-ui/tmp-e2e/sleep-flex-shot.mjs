// Screenshot: flexible sleep — late Monday shift pushes Tuesday's sleep later
// (full 8h), and a Wednesday 06:00 lab pulls Tuesday's bedtime earlier.
import { chromium } from 'playwright'
const BASE = 'http://localhost:5173'
const NOW = new Date('2026-07-05T09:00:00')
const D = (day, hm) => `2026-07-${String(day).padStart(2, '0')}T${hm}:00`
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } })
const page = await ctx.newPage()
await page.clock.install({ time: NOW })
await page.route('https://www.googleapis.com/calendar/v3/users/me/calendarList**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'primary', summary: 'Personal' }] }) }))
await page.route('https://www.googleapis.com/calendar/v3/calendars/**', (r) =>
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [
    { id: 'ev-lab', status: 'confirmed', summary: 'Early lab', location: '200 Class Blvd', start: { dateTime: D(8, '06:00') }, end: { dateTime: D(8, '07:30') } },
  ] }) }))
await page.route('https://nominatim.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
await page.route('https://router.project-osrm.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [{ duration: 25 * 60 }] }) }))
await page.addInitScript(() => {
  localStorage.setItem('atlas.devMode', '1')
  localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
  localStorage.setItem('atlas.ladder.v1', JSON.stringify({
    home: 'home address', wake: '07:00', bed: '23:00', windowDays: 4, buffer: 5,
    meals: [], flex: [], aliases: [],
    geo: { 'home address': { lat: 40, lon: -90 }, '200 class blvd': { lat: 40.5, lon: -90 }, '400 work ave': { lat: 40.7, lon: -90 } },
    drives: {
      '40.0000,-90.0000>40.5000,-90.0000': 20, '40.5000,-90.0000>40.0000,-90.0000': 20,
      '40.0000,-90.0000>40.7000,-90.0000': 30, '40.7000,-90.0000>40.0000,-90.0000': 30,
    },
  }))
  localStorage.setItem('atlas.work.v1', JSON.stringify({ wage: 15, tips: false, openEnded: false, shifts: [], ranges: {},
    upcoming: [{ id: 'up1', date: '2026-07-06', start: '17:00', end: '01:00', gcalId: 'g1' }], address: '400 Work Ave', calId: 'cal-work' }))
})
await page.goto(`${BASE}/#/ladder`)
await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
await page.waitForTimeout(400)
await page.evaluate(() => { const el = document.querySelector('.lad-card--shift') || [...document.querySelectorAll('.lad-card')].find((c) => c.textContent.includes('Work')); el?.scrollIntoView({ block: 'start' }) }); await page.waitForTimeout(300); await page.screenshot({ path: 'tmp-e2e/sleep-flex.png' })
console.log('saved tmp-e2e/sleep-flex.png')
await b.close()
