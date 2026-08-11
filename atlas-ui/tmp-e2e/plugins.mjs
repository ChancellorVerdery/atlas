// Plugin system e2e: base ship (login+settings+dashboard), enable/disable
// gating of nav/pages/palette/widgets, legacy migration, and zip install via
// the Settings drop zone. Run: node tmp-e2e/plugins.mjs [base-url]
// Needs plugins-dist/ built: node ../tools/build-plugin-zips.mjs
import { chromium } from 'playwright'
import { strictEqual, ok } from 'node:assert'
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = process.env.ATLAS_BASE || process.argv[2] || 'http://localhost:5173'
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = join(ROOT, 'plugins-dist')

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message.split('\n')[0]) }
}
const browser = await chromium.launch()
const fresh = async (extraSeed) => {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await ctx.addInitScript((seed) => {
    localStorage.setItem('atlas.auth.v1', '{"offline":true}')
    for (const [k, v] of Object.entries(seed || {})) localStorage.setItem(k, v)
  }, extraSeed || {})
  const page = await ctx.newPage()
  await page.goto(BASE + '/#/dashboard')
  await page.waitForSelector('#nav a', { timeout: 10000 })
  return { ctx, page }
}
const navLabels = (page) => page.$$eval('#nav .nav__item .nav__label', (n) => n.map((x) => x.textContent))

// ---- A. fresh install = dashboard + settings only --------------------------
{
  const { ctx, page } = await fresh()
  await check('fresh: nav is Dashboard + Settings only', async () => {
    const labels = await navLabels(page)
    strictEqual(labels.join(','), 'Dashboard,Settings')
  })
  await check('fresh: a plugin URL routes back to the dashboard', async () => {
    await page.goto(BASE + '/#/work')
    await page.waitForFunction(() => document.getElementById('title')?.textContent === 'Dashboard')
  })
  await check('fresh: dashboard shows the empty state, no plugin widgets', async () => {
    strictEqual(await page.locator('.pwidget').count(), 0)
  })
  await check('fresh: default registry persists — later base-app writes cannot flip it to all-on', async () => {
    // The migration must be one-shot: the fresh default is WRITTEN at first
    // load, so a dashboard save (or the boot Google-status cache write)
    // arriving later no longer reads as "legacy install".
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.plugins.v1')))
    ok(persisted && typeof persisted.enabled === 'object', 'atlas.plugins.v1 not persisted on fresh boot')
    await page.evaluate(() => localStorage.setItem('atlas.page.v1', '{"v":1,"rows":[]}')) // simulate a base-app write
    await page.reload()
    await page.waitForSelector('#nav a')
    strictEqual((await navLabels(page)).join(','), 'Dashboard,Settings')
  })

  // ---- B. enable via settings toggle ---------------------------------------
  await check('settings lists all 14 plugins, all off', async () => {
    await page.goto(BASE + '/#/settings')
    await page.waitForSelector('[data-plug-toggle]')
    strictEqual(await page.locator('[data-plug-toggle]').count(), 14)
    strictEqual(await page.locator('[data-plug-toggle].is-on').count(), 0)
  })
  await check('enabling Work adds the page, seeds its board', async () => {
    await page.click('[data-plug-toggle="work"]')
    await page.waitForSelector('[data-plug-toggle="work"].is-on')
    ok((await navLabels(page)).includes('Work'), 'Work not in nav')
    await page.goto(BASE + '/#/work')
    await page.waitForSelector('.pwidget--wkshifts', { timeout: 8000 })
    strictEqual(await page.locator('.pwidget--wkhistory').count(), 1)
  })
  await check('work palette only offers Work widgets', async () => {
    await page.click('#customize')
    await page.waitForSelector('.palette__item')
    const cats = await page.$$eval('.palette__cat', (n) => n.map((x) => x.textContent))
    strictEqual(cats.join(','), 'Work')
    await page.click('#customize') // exit customize
  })
  await check('disabling Work removes page, widgets survive disabled', async () => {
    await page.goto(BASE + '/#/settings')
    await page.waitForSelector('[data-plug-toggle="work"].is-on')
    await page.click('[data-plug-toggle="work"]')
    await page.waitForFunction(() => !document.querySelector('[data-plug-toggle="work"].is-on'))
    ok(!(await navLabels(page)).includes('Work'), 'Work still in nav')
    // board data untouched — re-enable brings it straight back
    await page.click('[data-plug-toggle="work"]')
    await page.goto(BASE + '/#/work')
    await page.waitForSelector('.pwidget--wkshifts', { timeout: 8000 })
  })
  await ctx.close()
}

// ---- C. legacy install migrates to everything-on ---------------------------
{
  const { ctx, page } = await fresh({ 'atlas.page.v1': '{"v":1,"rows":[]}' })
  await check('legacy data → all plugins auto-enabled once', async () => {
    const labels = await navLabels(page)
    strictEqual(labels.length, 16, `nav has ${labels.length} items: ${labels}`) // dashboard + 14 + settings
    ok(labels.includes('Formal') && labels.includes('Email'), 'plugin pages missing')
  })
  await ctx.close()
}

// ---- D. zip install ---------------------------------------------------------
{
  const { ctx, page } = await fresh()
  await page.goto(BASE + '/#/settings')
  await page.waitForSelector('#plugin-file', { state: 'attached' }) // it's a hidden input

  await check('formal.zip installs via the file picker and enables', async () => {
    await page.setInputFiles('#plugin-file', join(DIST, 'formal.zip'))
    await page.waitForFunction(() => document.getElementById('plugin-status')?.textContent.includes('Installed'))
    const st = await page.locator('#plugin-status').innerText()
    ok(st.includes('Formal v1.0.0'), `status: ${st}`)
    ok((await navLabels(page)).includes('Formal'), 'Formal not in nav')
    strictEqual(await page.locator('.plug-badge').count(), 1) // zip badge on the row
  })
  await check('installed zip shows Remove; removing disables but keeps data', async () => {
    await page.click('[data-plug-remove="formal"]')
    await page.waitForFunction(() => document.getElementById('plugin-status')?.textContent.includes('Removed'))
    ok(!(await navLabels(page)).includes('Formal'), 'Formal still in nav after remove')
    const boardKept = await page.evaluate(() => localStorage.getItem('atlas.page.formal.v1') !== null)
    ok(boardKept, 'formal board data was deleted on remove')
  })
  await check('drag-and-drop install works (synthetic drop)', async () => {
    const bytes = [...readFileSync(join(DIST, 'work.zip'))]
    await page.evaluate(async (arr) => {
      const dt = new DataTransfer()
      dt.items.add(new File([new Uint8Array(arr)], 'work.zip', { type: 'application/zip' }))
      const zone = document.getElementById('plugin-drop')
      zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    }, bytes)
    await page.waitForFunction(() => document.getElementById('plugin-status')?.textContent.includes('Work'))
    ok((await navLabels(page)).includes('Work'), 'Work not enabled after drop')
  })
  await check('a garbage file is rejected with a readable error', async () => {
    const junk = join(DIST, '.junk.zip')
    writeFileSync(junk, 'this is not a zip at all')
    await page.setInputFiles('#plugin-file', junk)
    await page.waitForFunction(() => document.getElementById('plugin-status')?.classList.contains('is-err'))
    const st = await page.locator('#plugin-status').innerText()
    ok(/couldn't read that zip/i.test(st), `status: ${st}`)
    rmSync(junk)
  })
  await check('an unknown-id zip is rejected pending the plugin API', async () => {
    const stage = join(DIST, '.stage-unknown')
    mkdirSync(stage, { recursive: true })
    writeFileSync(join(stage, 'plugin.json'), JSON.stringify({ format: 1, id: 'weather', name: 'Weather', version: '0.1.0' }))
    execSync(`zip -q -r ../unknown.zip .`, { cwd: stage })
    await page.setInputFiles('#plugin-file', join(DIST, 'unknown.zip'))
    await page.waitForFunction(() => document.getElementById('plugin-status')?.textContent.includes('plugin API'))
    rmSync(stage, { recursive: true })
    rmSync(join(DIST, 'unknown.zip'))
  })
  await ctx.close()
}

// ---- E. hidden widgets in customize: stubs keep model↔DOM parity ------------
{
  const board = { v: 1, rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [
    { id: 'w-hidden', kind: 'wkincome' }, { id: 'w-card', kind: 'card', title: 'T', text: 'x' }] }] }] }] }] }
  const { ctx, page } = await fresh({
    'atlas.page.v1': JSON.stringify(board),
    'atlas.plugins.v1': '{"enabled":{},"installed":{}}', // work OFF explicitly — no migration
    'atlas.devMode': '1', // dev palette so customize has drag sources
  })
  await check('view mode hides the disabled widget, no dead space', async () => {
    strictEqual(await page.locator('.pwidget').count(), 1)
    strictEqual(await page.locator('.pwidget--off').count(), 0)
  })
  await check('customize shows a stub for the hidden widget (model↔DOM parity)', async () => {
    await page.click('#customize')
    await page.waitForSelector('.pwidget--off')
    strictEqual(await page.locator('.pline .pwidget').count(), 2)
    const stub = await page.locator('.pwidget--off').innerText()
    ok(stub.includes('Work'), `stub names its plugin: ${stub}`)
  })
  await check('palette drop lands where it was dropped despite the hidden widget', async () => {
    // Real-mouse (CDP) HTML5 drag: palette Card → right edge of the visible
    // card. Same choreography as over-widget-drop-zones.mjs: threshold nudge
    // to fire dragstart, staged approach, settle move, then release.
    const pal = page.locator('.palette__item[data-kind="card"]')
    await pal.scrollIntoViewIfNeeded()
    const src = await pal.boundingBox()
    const dst = await page.locator('[data-widget-id="w-card"]').boundingBox()
    const sx = src.x + src.width / 2, sy = src.y + src.height / 2
    // inside-right half of the card = the "beside, after" zone (the OUTER
    // right-edge strip is a separately broken zone at baseline — avoid it)
    const tx = dst.x + dst.width * 0.75, ty = dst.y + dst.height / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await page.mouse.move(sx + 6, sy + 6, { steps: 3 })
    await page.mouse.move((sx + tx) / 2, (sy + ty) / 2, { steps: 10 })
    await page.mouse.move(tx, ty, { steps: 10 })
    await page.mouse.move(tx, ty)
    await page.mouse.up()
    await page.waitForFunction(() => {
      const p = JSON.parse(localStorage.getItem('atlas.page.v1'))
      return p.rows[0].cols[0].sections[0].lines[0].widgets.length === 3
    }, null, { timeout: 5000 })
    const order = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('atlas.page.v1')).rows[0].cols[0].sections[0].lines[0].widgets.map((w) => w.id))
    // dropped on the card's right half → beside-after → must land AFTER
    // w-card in the MODEL. Before the stub fix, the DOM-index splice put the
    // new widget between w-hidden and w-card instead.
    strictEqual(order[0], 'w-hidden')
    strictEqual(order[1], 'w-card')
    ok(order[2] && order[2] !== 'w-hidden' && order[2] !== 'w-card', `new widget last: ${order}`)
  })
  await ctx.close()
}

await browser.close()
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
