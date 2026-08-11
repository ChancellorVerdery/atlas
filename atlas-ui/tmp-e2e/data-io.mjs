// Backup & restore (General Settings → export/import all atlas.* data).
// Headless. Exercises a real file download + a real file upload round-trip.
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name, extra = '') => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-dataio-'))

const browser = await chromium.launch({ headless: true })

// ---- A. export gathers every atlas.* key ------------------------------------------
let backupPath
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 }, acceptDownloads: true })
  const page = await ctx.newPage()
  await page.addInitScript(() => {
    // gym needs real content or the boot auto-seeds/overwrites it (gymStoreEmpty)
    localStorage.setItem('atlas.gym.v1', JSON.stringify({ v: 1, workouts: [{ id: 'w', name: 'x' }], marker: 'GYM-DATA' }))
    localStorage.setItem('atlas.work.v1', JSON.stringify({ marker: 'WORK-DATA' }))
    localStorage.setItem('atlas.email.v1', JSON.stringify({ clientId: 'cid', clientSecret: 'SECRET-XYZ', address: 'me@x.com' }))
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('unrelated.key', 'should-not-export') // non-atlas key must be ignored
  })
  await page.goto(`${BASE}/#/settings`)
  await page.waitForSelector('[data-act="export-data"]')
  await page.waitForTimeout(300) // let boot seeding settle before snapshotting
  console.log('A. export')
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="export-data"]')])
  ok(/^atlas-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()), `download named atlas-backup-<date>.json (${download.suggestedFilename()})`)
  backupPath = path.join(tmp, 'backup.json')
  await download.saveAs(backupPath)
  const payload = JSON.parse(fs.readFileSync(backupPath, 'utf8'))
  ok(payload.atlasBackup === 1 && typeof payload.exportedAt === 'string', 'file has the backup envelope (atlasBackup + exportedAt)')
  ok(payload.data['atlas.gym.v1']?.includes('GYM-DATA') && payload.data['atlas.work.v1']?.includes('WORK-DATA'), 'all atlas.* keys captured')
  ok(payload.data['atlas.devMode'] === '1', 'scalar keys (devMode) captured too')
  ok(!('unrelated.key' in payload.data), 'non-atlas localStorage keys are NOT exported')
  ok(payload.data['atlas.email.v1']?.includes('SECRET-XYZ'), 'credentials ARE included (it is a full backup — the UI warns to keep it private)')
  ok((await page.locator('#data-status').innerText()).includes('Exported'), 'status line confirms the export')
  await ctx.close()
}

// ---- B. import replaces all data, then reloads ------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept()) // the "replace all data?" confirm
  await page.goto(`${BASE}/#/settings`)
  await page.waitForSelector('#import-file', { state: 'attached' })
  console.log('B. import (replace + reload)')
  // Set stale pre-existing data via evaluate (NOT addInitScript — that re-runs
  // on the post-import reload and would clobber the restored values back).
  await page.evaluate(() => {
    localStorage.setItem('atlas.finance.v1', JSON.stringify({ marker: 'STALE-FINANCE' }))
    localStorage.setItem('atlas.gym.v1', JSON.stringify({ marker: 'STALE-GYM' }))
  })
  await page.setInputFiles('#import-file', backupPath)
  // importData calls location.reload() on success — wait for the restored value
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('atlas.gym.v1') || '{}').marker === 'GYM-DATA', null, { timeout: 8000 })
  ok(true, 'gym data restored from the backup after reload')
  const finance = await page.evaluate(() => localStorage.getItem('atlas.finance.v1'))
  ok(finance === null, 'a key absent from the backup is CLEARED (restore, not merge — no stale STALE-FINANCE left behind)')
  const work = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.work.v1')).marker)
  ok(work === 'WORK-DATA', 'work data restored')
  ok(await page.evaluate(() => localStorage.getItem('atlas.devMode')) === '1', 'devMode restored')
  await ctx.close()
}

// ---- C. a junk file is rejected, current data untouched ---------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } })
  const page = await ctx.newPage()
  let confirmed = false
  page.on('dialog', (d) => { confirmed = true; d.accept() })
  await page.addInitScript(() => localStorage.setItem('atlas.gym.v1', JSON.stringify({ v: 1, workouts: [{ id: 'w', name: 'x' }], marker: 'KEEP-ME' })))
  await page.goto(`${BASE}/#/settings`)
  await page.waitForSelector('#import-file', { state: 'attached' })
  console.log('C. bad file rejected')
  const junk = path.join(tmp, 'junk.json')
  fs.writeFileSync(junk, '{"totally":"not a backup"}')
  await page.setInputFiles('#import-file', junk)
  await page.waitForFunction(() => document.getElementById('data-status')?.textContent.includes("doesn't look like"), null, { timeout: 5000 })
  ok(true, 'a JSON file without atlas data is rejected with a message')
  ok(!confirmed, 'no destructive confirm is even shown for an invalid backup')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.gym.v1')).marker) === 'KEEP-ME', 'existing data untouched by a rejected import')
  const notjson = path.join(tmp, 'notjson.json')
  fs.writeFileSync(notjson, 'this is not json at all')
  await page.setInputFiles('#import-file', notjson)
  await page.waitForFunction(() => document.getElementById('data-status')?.textContent.includes('valid JSON'), null, { timeout: 5000 })
  ok(true, 'a non-JSON file is rejected with a message')
  await ctx.close()
}

fs.rmSync(tmp, { recursive: true, force: true })
await browser.close()
console.log(`\ndata-io: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
