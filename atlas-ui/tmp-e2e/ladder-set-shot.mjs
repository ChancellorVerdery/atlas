import { chromium } from 'playwright'
const BASE = 'http://localhost:5173'
const NOW = new Date('2026-07-05T09:00:00')
const b = await chromium.launch({ headless: true })
const page = await (await b.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
await page.route('https://www.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }))
await page.route('https://nominatim.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }))
await page.route('https://router.project-osrm.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ routes: [{ duration: 25 * 60 }] }) }))
await page.clock.install({ time: NOW })
await page.addInitScript(() => {
  localStorage.setItem('atlas.devMode', '1')
  localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'x', address: 'me@x.com', token: { access_token: 't', expires_at: Date.now() + 3600e3 } }))
  localStorage.setItem('atlas.ladder.v1', JSON.stringify({
    home: '100 Home St', wake: '07:00', windowDays: 3, buffer: 5,
    meals: [{ id: 'm1', name: 'Lunch', pref: '12:30', duration: 45, enabled: true }],
    geo: {}, drives: {}, aliases: [],
    flex: [
      { id: 'sf1', title: 'Dentist appointment', kind: 'set', date: '2026-07-05', start: '10:00', end: '11:00', minutes: 60 },
      { id: 'sf2', title: 'Study block', kind: 'week', minutes: 90 },
    ],
    pushed: { '2026-07-05': [{ calId: 'c', id: 'e' }] }, // day 0 shown as already pushed
  }))
  localStorage.setItem('atlas.sleep.v1', JSON.stringify({ prefMin: 480, bedtime: '23:00', windowDays: 7, ratio: 1.2, napCredit: 50, recoverNights: 3, logs: [] }))
})
await page.goto(`${BASE}/#/ladder`)
await page.waitForFunction(() => document.getElementById('lad-status')?.textContent.includes('blocks'), null, { timeout: 20000 })
await page.waitForTimeout(400)
await page.evaluate(() => { document.querySelector('.lad-scroll').scrollTop = 0 })
await page.waitForTimeout(200)
await page.screenshot({ path: 'tmp-e2e/ladder-set.png', clip: { x: 230, y: 210, width: 1370, height: 360 } })
console.log('saved tmp-e2e/ladder-set.png')
await b.close()
