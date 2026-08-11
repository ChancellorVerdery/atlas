// Screenshot pass for the work plugin (headless, local data).
import { chromium } from 'playwright'
const OUT = (process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp'

const dkey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const ago = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return dkey(d) }
const SHIFTS = [
  { id: 'o1', date: ago(0), start: '17:00', end: '', hours: null, tips: 0, wage: 16.5 }, // open, projected
  { id: 's1', date: ago(1), start: '17:00', end: '23:15', hours: null, tips: 142, wage: 16.5 },
  { id: 's2', date: ago(3), start: '11:00', end: '16:30', hours: null, tips: 61, wage: 16.5 },
  { id: 's3', date: ago(7), start: '17:00', end: '23:45', hours: null, tips: 128, wage: 16.5 },
  { id: 's4', date: ago(9), start: '', end: '', hours: 5, tips: 74, wage: 15 },
  { id: 's5', date: ago(14), start: '17:00', end: '23:00', hours: null, tips: 96, wage: 15 },
  { id: 's6', date: ago(45), start: '', end: '', hours: 6, tips: 88, wage: 15 },
]

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page.addInitScript((shifts) => {
  if (!localStorage.getItem('atlas.work.v1')) localStorage.setItem('atlas.work.v1', JSON.stringify({
    wage: 16.5, tips: true, openEnded: true, shifts,
  }))
}, SHIFTS)
await page.goto('http://localhost:5173/#/work')
await page.waitForSelector('.wk-row')
await page.waitForTimeout(1200)
// fill the tip share calculator so it photographs working
await page.fill('[data-wk-ts="pool"]', '260')
const rows = page.locator('.wk-ts-row[data-i]')
await rows.nth(0).locator('[data-wk-ts="name"]').fill('Me')
await rows.nth(0).locator('[data-wk-ts="hours"]').fill('6.5')
await rows.nth(1).locator('[data-wk-ts="name"]').fill('Jordan')
await rows.nth(1).locator('[data-wk-ts="hours"]').fill('4')
await page.waitForTimeout(200)
await page.screenshot({ path: `${OUT}/work-board.png` })
await page.click('.page-tab:has-text("Settings")')
await page.waitForSelector('#wk-wage')
await page.waitForTimeout(700)
await page.screenshot({ path: `${OUT}/work-settings.png` })
await browser.close()
console.log('shots done')
