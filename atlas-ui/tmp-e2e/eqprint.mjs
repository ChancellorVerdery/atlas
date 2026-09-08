// Equations → Print sheet workbench, headless. Needs the dev server on :5173.
//   node tmp-e2e/eqprint.mjs
import fs from 'node:fs'
import { chromium } from 'playwright'
const out = []
const check = (n, ok, d = '') => out.push({ name: n, ok: !!ok, detail: d })
const seed = JSON.parse(fs.readFileSync('tmp-e2e/_qa/seeds/equations.json', 'utf8')).seeds
const applySeed = (s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)) }
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 2 })
await ctx.addInitScript(applySeed, seed)
const page = await ctx.newPage()
const errs = []
// Known shell noise, not the workbench: the Mac app's /local/icon probe 404s in a browser, and Vite's HMR socket points at the dev tunnel.
const NOISE = /WebSocket|\[vite\]|404/
page.on('console', (m) => { if (m.type() === 'error' && !NOISE.test(m.text())) errs.push(m.text()) })
page.on('pageerror', (e) => { if (!NOISE.test(e.message)) errs.push(e.message) })
await page.goto('http://localhost:5173/#/equations', { waitUntil: 'load' })
await page.waitForSelector('.page-root')
await page.evaluate(() => document.fonts.ready)

// 1. the button: visible on the equations board, left of Math keys, hidden elsewhere
const pos = await page.evaluate(() => {
  const r = (id) => document.getElementById(id)?.getBoundingClientRect()
  return { p: r('eqprint-toggle'), m: r('mathkbd-toggle'), c: r('customize') }
})
check('Print sheet button sits left of Math keys', pos.p && pos.m && pos.p.width > 0 && pos.p.right <= pos.m.left, JSON.stringify(pos))
await page.click('a[href="#/dashboard"]').catch(() => page.click('.nav__item'))
await page.waitForTimeout(200)
check('button hidden off the equations board', await page.evaluate(() => document.getElementById('eqprint-toggle').style.display === 'none'))
await page.click('a[href="#/equations"]')
await page.waitForSelector('.page-root')

// 2. enter the mode
await page.click('#eqprint-toggle')
await page.waitForSelector('.eqp-page', { timeout: 8000 })
const mode = await page.evaluate(() => ({
  crumb: document.getElementById('crumb').textContent,
  custHidden: document.getElementById('customize').style.display === 'none',
  kbdHidden: document.getElementById('mathkbd-toggle').style.display === 'none',
  active: document.getElementById('eqprint-toggle').classList.contains('is-active'),
  pages: document.querySelectorAll('.eqp-page').length,
  size: document.querySelector('[data-el="ro-size"] .eqp-ro__v').textContent,
  sides: document.querySelector('[data-el="ro-sides"] .eqp-ro__v').textContent,
  leg: document.querySelector('[data-el="ro-leg"] .eqp-ro__s').textContent,
  cats: document.querySelectorAll('.eqp-tnode[data-kind="cat"]').length,
  selCount: document.querySelector('[data-el="cnt-sel"]').textContent,
  allCount: document.querySelector('[data-el="cnt-all"]').textContent,
  mathNodes: document.querySelectorAll('.eqp-page .ML__latex, .eqp-page .ML__base').length,
}))
check('workbench replaces the board with pages and readouts', mode.pages >= 1 && /pt/.test(mode.size) && /\d+ \/ \d+/.test(mode.sides) && /dots? @ \d+ dpi/.test(mode.leg), JSON.stringify(mode))
check('crumb, Customize and Math keys reflect the mode', /Print sheet/.test(mode.crumb) && mode.custHidden && mode.kbdHidden && mode.active)
check('tree lists every equation, all selected on first visit', mode.cats >= 2 && mode.selCount === mode.allCount && +mode.allCount > 3, `${mode.selCount}/${mode.allCount}`)
check('sheet renders MathLive markup, not raw LaTeX', mode.mathNodes > 0)

// 3. deselect a category → fewer equations on the sheet
const before = await page.evaluate(() => document.querySelectorAll('.eqp-page .eqp-eq').length)
await page.click('.eqp-tnode[data-kind="cat"] .eqp-tcheck')
await page.waitForTimeout(300)
const after = await page.evaluate(() => ({ eqs: document.querySelectorAll('.eqp-page .eqp-eq').length, sel: +document.querySelector('[data-el="cnt-sel"]').textContent, state: document.querySelector('.eqp-tnode[data-kind="cat"] .eqp-tcheck').classList.contains('is-off') }))
check('unticking a category drops its equations from the sheet', after.eqs < before && after.sel < before, `${before} → ${after.eqs}`)
await page.click('[data-act="sel-all"]')
await page.waitForTimeout(300)

// 4. index card + fixed size → overflow warning; auto-fit clears it
await page.selectOption('[data-set="paper"]', 'i35')
await page.click('[data-seg="sizeMode"][data-v="fixed"]')
await page.$eval('[data-set="size"]', (el) => { el.value = 20; el.dispatchEvent(new Event('input', { bubbles: true })) })
await page.waitForTimeout(400)
const ov = await page.evaluate(() => ({ warn: document.querySelector('[data-el="warn"]').classList.contains('is-on'), text: document.querySelector('[data-el="warn"]').textContent, orient: document.querySelector('[data-seg="orient"].is-on')?.dataset.v }))
check('3×5 card defaults to landscape; fixed 20pt overflows with a warning', ov.warn && /won't fit/.test(ov.text) && ov.orient === 'landscape', JSON.stringify(ov))
await page.click('[data-seg="sizeMode"][data-v="auto"]')
await page.waitForTimeout(500)
const af = await page.evaluate(() => ({ warn: document.querySelector('[data-el="warn"]').classList.contains('is-on'), size: document.querySelector('[data-el="ro-size"] .eqp-ro__v').textContent }))
check('auto-fit finds a size for the card (no warning)', !af.warn && /pt/.test(af.size), JSON.stringify(af))

// 5. print simulation: rasterized at the chosen dpi, hard dots, loupe on hover, embedded fonts
await page.selectOption('[data-set="paper"]', 'letter')
await page.selectOption('[data-set="dpi"]', '150')
await page.click('[data-seg="pv"][data-v="sim"]')
await page.waitForSelector('.eqp-sim[data-dpi]', { timeout: 20000 })
await page.waitForTimeout(300)
const sim = await page.evaluate(() => {
  const c = document.querySelector('.eqp-sim[data-dpi]')
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let black = 0, grey = 0
  for (let i = 0; i < d.length; i += 4 * 53) { if (d[i] === 0) black++; else if (d[i] < 255) grey++ }
  return { w: c.width, h: c.height, dpi: c.dataset.dpi, black, grey, note: document.querySelector('[data-el="note"]').textContent }
})
check('raster is 8.5×11 at 150 dpi with ink on it', sim.w === 1275 && sim.h === 1650 && sim.black > 50, JSON.stringify(sim))
check('laser mode leaves no grey pixels', sim.grey === 0, `grey=${sim.grey}`)
const bb = await (await page.$('.eqp-sim[data-dpi]')).boundingBox()
await page.mouse.move(bb.x + bb.width * 0.2, bb.y + bb.height * 0.1)
await page.waitForTimeout(200)
const lp = await page.evaluate(() => { const l = document.querySelector('[data-el="loupe"]'); const r = l.getBoundingClientRect(); return { on: l.classList.contains('is-on'), w: r.width, label: document.querySelector('[data-el="loupe-r"]').textContent } })
check('loupe appears on hover, a quarter inch of dots', lp.on && lp.w > 200 && /38² dots/.test(lp.label), JSON.stringify(lp))
const fontCss = await page.evaluate(async () => { const m = await import('/src/page/eqprintui.js'); const css = await m.sheetFontCSS(); return { len: css.length, katex: /KaTeX_Main/.test(css), hg: /Hanken Grotesk/.test(css), serif: /Instrument Serif/.test(css), data: /url\(data:/.test(css) } })
check('sheet fonts embedded for the raster (KaTeX + Atlas faces as data URIs)', fontCss.katex && fontCss.data && fontCss.len > 100000, JSON.stringify({ ...fontCss, hgAndSerifNeedNetwork: fontCss.hg && fontCss.serif }))
await page.screenshot({ path: process.env.EQPRINT_SHOT || '/tmp/eqprint-sim.png' })

// 6. 1:1 dots view sizes the canvas to the dot grid
await page.click('label:has([data-set="dots1"])')
await page.waitForTimeout(300)
const one = await page.evaluate(() => { const c = document.querySelector('.eqp-sim[data-dpi]'); return { css: parseFloat(c.style.width), dots: c.width, dpr: devicePixelRatio, cls: c.classList.contains('is-1to1') } })
check('1 dot = 1 screen pixel: css width = dots / dpr', one.cls && Math.abs(one.css - one.dots / one.dpr) < 1, JSON.stringify(one))

// 7. print → print root with @page, cleaned up on afterprint
await page.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++ } })
await page.click('[data-act="print"]')
await page.waitForTimeout(200)
const pr = await page.evaluate(() => ({ printed: window.__printed, root: !!document.querySelector('.eqp-print-root'), pages: document.querySelectorAll('.eqp-print-root .eqp-page').length, atpage: document.querySelector('.eqp-print-root style')?.textContent, cls: document.body.classList.contains('eqp-printing') }))
check('Print… builds the print root with @page sized to the paper', pr.printed === 1 && pr.root && pr.pages >= 1 && /size: 8\.5in 11in/.test(pr.atpage) && pr.cls, JSON.stringify(pr))
await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
check('afterprint removes the print root', await page.evaluate(() => !document.querySelector('.eqp-print-root') && !document.body.classList.contains('eqp-printing')))

// 8. settings persist across a reload; Done restores the board; navigation exits the mode
await page.click('[data-seg="sides"][data-v="1"]')
await page.waitForTimeout(300)
await page.reload({ waitUntil: 'load' })
await page.waitForSelector('.page-root')
check('reload lands on the board, not the workbench', await page.evaluate(() => !document.querySelector('.eqp') && !!document.querySelector('.page-root')))
await page.click('#eqprint-toggle')
await page.waitForSelector('.eqp-slot') // sim mode was saved: pages exist only as canvases there
const persisted = await page.evaluate(() => ({ sides: document.querySelector('[data-seg="sides"].is-on')?.dataset.v, pv: document.querySelector('[data-seg="pv"].is-on')?.dataset.v, dpi: document.querySelector('[data-set="dpi"]').value, store: JSON.parse(localStorage.getItem('atlas.eqprint.v1')) }))
check('settings and selection persist in atlas.eqprint.v1', persisted.sides === '1' && persisted.pv === 'sim' && persisted.dpi === '150' && Array.isArray(persisted.store?.sel), JSON.stringify({ sides: persisted.sides, pv: persisted.pv, dpi: persisted.dpi, selN: persisted.store?.sel?.length }))
await page.click('[data-act="done"]')
await page.waitForSelector('.page-root')
check('Done returns to the board', await page.evaluate(() => !document.querySelector('.eqp') && !document.getElementById('eqprint-toggle').classList.contains('is-active') && document.getElementById('customize').style.display !== 'none'))
await page.click('#eqprint-toggle')
await page.waitForSelector('.eqp-slot')
await page.click('a[href="#/dashboard"]')
await page.waitForTimeout(300)
check('navigating away leaves print mode', await page.evaluate(() => !document.querySelector('.eqp') && !document.getElementById('eqprint-toggle').classList.contains('is-active')))

check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '))
await browser.close()
for (const r of out) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.detail && !r.ok ? ' — ' + r.detail : ''}`)
const failed = out.filter((r) => !r.ok).length
console.log(failed ? `\n${failed} failed` : '\nall good')
process.exit(failed ? 1 : 0)
