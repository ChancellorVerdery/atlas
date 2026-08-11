// E2E: inline editing, persistence, modal, legacy cleanup, mode transitions.
import { chromium } from 'playwright'

const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","cols":[
   {"id":"c-1","lines":[
     {"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"A","text":"aa"},{"id":"w-b","kind":"card","title":"B","text":"bb"}]},
     {"id":"l-2","widgets":[{"id":"w-c","kind":"card","title":"C","text":"cc"}]}]},
   {"id":"c-2","lines":[
     {"id":"l-3","widgets":[{"id":"w-d","kind":"graph","graphType":"bar","title":"D","xLabel":"Day","yLabel":"N","points":[{"label":"Mon","value":10},{"label":"Tue","value":30},{"label":"Wed","value":20}]}]}]}]},
 {"id":"r-2","cols":[
   {"id":"c-3","lines":[
     {"id":"l-4","widgets":[{"id":"w-e","kind":"list","title":"E","items":["one","two"]}]}]}]}]}

const results = []
let consoleErrors = []
let errMark = 0

function record(check, ok, detail) {
  // fold in any console errors that appeared during this check
  const fresh = consoleErrors.slice(errMark)
  errMark = consoleErrors.length
  if (fresh.length) {
    ok = false
    detail = (detail ? detail + ' | ' : '') + 'console errors: ' + fresh.join(' ;; ')
  }
  results.push({ check, ok, ...(detail ? { detail } : {}) })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
await context.addInitScript(({ fixture }) => {
  // Guard: only seed on first load so a reload (check 5) does NOT re-seed.
  if (!localStorage.getItem('atlas.page.v1')) {
    localStorage.setItem('atlas.page.v1', JSON.stringify(fixture))
    localStorage.setItem('atlas.customWidgets.v2', '[{"id":"custom-1","title":"Old","blocks":[]}]')
    localStorage.setItem('atlas.widgetSize.v2', '{"x":{"w":50,"h":30}}')
  }
}, { fixture: FIXTURE })

const page = await context.newPage()
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('[console] ' + m.text()) })
page.on('pageerror', (e) => consoleErrors.push('[pageerror] ' + e.message))

const LS = () => page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')))
const rawLS = (k) => page.evaluate((key) => localStorage.getItem(key), k)
const findW = (pg, id) => {
  for (const r of pg.rows) for (const c of r.cols) for (const sec of c.sections) for (const l of sec.lines) for (const w of l.widgets) if (w.id === id) return w
  return null
}

try {
  await page.goto('http://localhost:5173/#/dashboard', { waitUntil: 'load' })
  await page.waitForSelector('.page-root .pwidget[data-widget-id="w-a"]')

  // ---- Check 1: legacy keys removed, nothing from them renders ----
  {
    const legacy1 = await rawLS('atlas.customWidgets.v2')
    const legacy2 = await rawLS('atlas.widgetSize.v2')
    const bodyText = await page.evaluate(() => document.body.innerText)
    const rendersOld = /\bOld\b/.test(bodyText)
    const ok = legacy1 === null && legacy2 === null && !rendersOld
    record('1. legacy keys removed and not rendered', ok,
      ok ? '' : `customWidgets.v2=${JSON.stringify(legacy1)} widgetSize.v2=${JSON.stringify(legacy2)} rendersOld=${rendersOld}`)
  }

  // ---- Check 2: inline edit w-a title + text, persistence per input, focus retention ----
  {
    await page.click('#customize')
    await page.waitForSelector('body.customizing .palette')
    const titleField = page.locator('.pwidget[data-widget-id="w-a"] .pw-field--title')
    await titleField.fill('Renamed')
    const afterTitle = findW(await LS(), 'w-a')
    const titleOk = afterTitle && afterTitle.title === 'Renamed'

    const textField = page.locator('.pwidget[data-widget-id="w-a"] .pw-field--text')
    await textField.click()
    await textField.fill('')
    await textField.pressSequentially('hello wo', { delay: 15 })
    const focusMid = await textField.evaluate((el) => el === document.activeElement)
    await textField.pressSequentially('rld', { delay: 15 })
    const focusEnd = await textField.evaluate((el) => el === document.activeElement)
    const afterText = findW(await LS(), 'w-a')
    const textOk = afterText && afterText.text === 'hello world'
    const ok = titleOk && focusMid && focusEnd && textOk
    record('2. card inline edits persist per-input, field keeps focus', ok,
      ok ? '' : `title=${JSON.stringify(afterTitle?.title)} (exp "Renamed"), text=${JSON.stringify(afterText?.text)} (exp "hello world"), focusMid=${focusMid}, focusEnd=${focusEnd}`)
  }

  // ---- Check 3: list editing on w-e ----
  {
    const item0 = page.locator('.pwidget[data-widget-id="w-e"] .pw-field[data-field="item"][data-index="0"]')
    await item0.fill('uno')
    const afterEdit = findW(await LS(), 'w-e')
    const editOk = afterEdit && afterEdit.items[0] === 'uno'

    await page.click('.pwidget[data-widget-id="w-e"] .pw-add-item')
    await sleep(120)
    const rows3 = await page.locator('.pwidget[data-widget-id="w-e"] .pw-list-row').count()
    const afterAdd = findW(await LS(), 'w-e')
    const addOk = rows3 === 3 && afterAdd && afterAdd.items.length === 3

    await page.click('.pwidget[data-widget-id="w-e"] .pw-item-remove[data-index="1"]')
    await sleep(120)
    const rows2 = await page.locator('.pwidget[data-widget-id="w-e"] .pw-list-row').count()
    const afterRm = findW(await LS(), 'w-e')
    const rmOk = rows2 === 2 && afterRm && afterRm.items.length === 2
    const ok = editOk && addOk && rmOk
    record('3. list item edit / add / remove', ok,
      ok ? '' : `items[0]=${JSON.stringify(afterEdit?.items?.[0])} (exp "uno"); after add rendered=${rows3} persisted=${afterAdd?.items?.length} (exp 3); after remove rendered=${rows2} persisted=${JSON.stringify(afterRm?.items)} (exp 2)`)
  }

  // ---- Check 4: graph editing on w-d ----
  {
    await page.waitForSelector('.pwidget[data-widget-id="w-d"] .chart-mount svg')
    await page.selectOption('.pwidget[data-widget-id="w-d"] select[data-field="graphType"]', 'line')
    await sleep(120)
    const lineCount = await page.locator('.pwidget[data-widget-id="w-d"] .chart-mount svg path.chart__line').count()
    const lineOk = lineCount >= 1

    await page.fill('.pwidget[data-widget-id="w-d"] .pw-field[data-field="xLabel"]', 'Weekday')
    await sleep(120)
    const axisTitles = await page.locator('.pwidget[data-widget-id="w-d"] .chart-mount svg text.chart__axis-title').allTextContents()
    const axisOk = axisTitles.includes('Weekday')

    const ylabs = await page.locator('.pwidget[data-widget-id="w-d"] .chart-mount svg text.chart__ylab').allTextContents()
    const xlabs = await page.locator('.pwidget[data-widget-id="w-d"] .chart-mount svg text.chart__xlab').allTextContents()
    const ylabOk = ylabs.length > 0 && ylabs.every((t) => /^-?\d+(\.\d+)?$/.test(t.trim()))
    const xlabOk = ['Mon', 'Tue', 'Wed'].every((l) => xlabs.includes(l))
    const ok = lineOk && axisOk && ylabOk && xlabOk
    record('4. graph type flip + axis label + tick/point labels', ok,
      ok ? '' : `chart__line paths=${lineCount} (exp >=1); axis-titles=${JSON.stringify(axisTitles)} (exp incl "Weekday"); ylabs=${JSON.stringify(ylabs)}; xlabs=${JSON.stringify(xlabs)} (exp Mon/Tue/Wed)`)
  }

  // ---- Check 5: reload, edits survive, view mode ----
  {
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('.page-root .pwidget[data-widget-id="w-a"]')
    const customizing = await page.evaluate(() => document.body.classList.contains('customizing'))
    const h3 = await page.locator('.pwidget[data-widget-id="w-a"] h3.card__title').textContent().catch(() => null)
    const pg = await LS()
    const wa = findW(pg, 'w-a'), we = findW(pg, 'w-e'), wd = findW(pg, 'w-d')
    const persisted = wa?.title === 'Renamed' && wa?.text === 'hello world' &&
      we?.items?.length === 2 && we?.items?.[0] === 'uno' &&
      wd?.graphType === 'line' && wd?.xLabel === 'Weekday'
    const ok = !customizing && h3 === 'Renamed' && persisted
    record('5. reload: edits survived, view mode shows Renamed', ok,
      ok ? '' : `customizing=${customizing} (exp false); h3=${JSON.stringify(h3)} (exp "Renamed"); wa=${JSON.stringify({ title: wa?.title, text: wa?.text })}; we.items=${JSON.stringify(we?.items)}; wd=${JSON.stringify({ graphType: wd?.graphType, xLabel: wd?.xLabel })}`)
  }

  // ---- Check 6: modal in view mode, no modal in customize ----
  {
    await page.click('.pwidget[data-widget-id="w-a"]')
    const modal = await page.waitForSelector('#app-modal', { timeout: 2000 }).catch(() => null)
    const modalTitle = modal ? await page.locator('#app-modal .modal__title').textContent() : null
    await page.keyboard.press('Escape')
    await sleep(150)
    const goneAfterEsc = (await page.locator('#app-modal').count()) === 0

    await page.click('#customize')
    await page.waitForSelector('body.customizing .palette')
    // click the padding edge of w-a (top-left corner, away from delete button and fields)
    await page.locator('.pwidget[data-widget-id="w-a"]').click({ position: { x: 4, y: 4 } })
    await sleep(300)
    const modalInCustomize = await page.locator('#app-modal').count()
    const ok = modal !== null && modalTitle === 'Renamed' && goneAfterEsc && modalInCustomize === 0
    record('6. modal opens in view mode, Escape closes, none in customize', ok,
      ok ? '' : `modalAppeared=${modal !== null}; title=${JSON.stringify(modalTitle)} (exp "Renamed"); goneAfterEsc=${goneAfterEsc}; modalCountInCustomize=${modalInCustomize} (exp 0)`)
  }

  // ---- Check 7: navigating away while customizing exits mode ----
  {
    // still customizing from check 6
    await page.evaluate(() => { location.hash = '#/settings' })
    await sleep(200)
    const customizing = await page.evaluate(() => document.body.classList.contains('customizing'))
    const palettes = await page.locator('.palette').count()
    const btnLabel = (await page.locator('#customize span').textContent())?.trim()

    await page.evaluate(() => { location.hash = '#/dashboard' })
    await sleep(200)
    const rootOk = (await page.locator('.page-root .pwidget[data-widget-id="w-a"]').count()) === 1
    const stillView = await page.evaluate(() => document.body.classList.contains('customizing'))
    const ok = !customizing && palettes === 0 && btnLabel === 'Customize' && rootOk && !stillView
    record('7. #/settings while customizing exits mode; back to dashboard renders', ok,
      ok ? '' : `customizing=${customizing} (exp false); palettes=${palettes} (exp 0); btnLabel=${JSON.stringify(btnLabel)} (exp "Customize"); dashboardRendered=${rootOk}; customizingAfterBack=${stillView}`)
  }

  // ---- Check 8: rapid toggle x3, no duplicate palettes, no errors ----
  {
    for (let i = 0; i < 6; i++) await page.click('#customize', { delay: 0 })
    await sleep(300)
    const palettes = await page.locator('.palette').count()
    const ok = palettes === 0 || palettes === 1
    record('8. rapid customize toggle x3: 0 or 1 palettes, no errors', ok,
      ok ? '' : `palette count=${palettes} (exp 0 or 1)`)
  }
} catch (err) {
  record('UNEXPECTED SCRIPT ERROR', false, err.message.split('\n')[0])
} finally {
  await browser.close()
}

console.log(JSON.stringify({ results, consoleErrors }, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
