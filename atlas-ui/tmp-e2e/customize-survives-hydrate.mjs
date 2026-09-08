// A background refresh must not throw away work in progress.
//
// The reported shape: "on the equations page, hit Customize and add a new
// equation sheet. After a period of time the page refreshes and the newly added
// equation list along with all its data is deleted." A hydrate dispatches
// 'atlas:hydrated'; renderer.js re-rendered on it unconditionally, and a
// re-render rebuilds the content area from scratch — taking the open Customize
// session with it. main.js's resume guard only ever checked for an open modal,
// and Customize is a page-level mode, not a modal.
//
// Run: node tmp-e2e/customize-survives-hydrate.mjs   (needs the dev server on 5173)
import { chromium } from 'playwright'

let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok   ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } })
await ctx.addInitScript(() => {
  const seed = (k, v) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v) }
  seed('atlas.auth.v1', '{"offline":true}')
  seed('atlas.plugins.v1', JSON.stringify({ enabled: { equations: true }, installed: {} }))
  seed('atlas.page.equations.v1', JSON.stringify({ v: 1, rows: [] }))
})
const pg = await ctx.newPage()
await pg.goto('http://localhost:5173/#/equations', { waitUntil: 'domcontentloaded' })
// #customize is static markup in index.html, so it exists long before
// renderer.js has bound the click delegate to it. Waiting for the button alone
// raced the boot and clicked into the void. The 'ready' class is set after the
// first render, which is the earliest the button actually does anything.
await pg.waitForFunction(() => document.documentElement.classList.contains('ready'), null, { timeout: 20000 })

// --- enter Customize and add an equation list -------------------------------
await pg.click('#customize')
await pg.waitForSelector('.palette__item[data-kind="eqlist"]', { timeout: 10000 })
await pg.click('.palette__item[data-kind="eqlist"]')
await pg.waitForSelector('.pwidget[data-widget-id]', { timeout: 10000 })
const widgetId = await pg.$eval('.pwidget[data-widget-id]', e => e.dataset.widgetId)
ok(!!widgetId, `an equation list was added (${widgetId})`)

// name it, the way the user would — customize live-saves on each keystroke
const titleField = '.pwidget[data-widget-id] [data-field="title"]'
await pg.waitForSelector(titleField, { timeout: 10000 })
await pg.fill(titleField, 'Thermo formulas')
await pg.waitForTimeout(250)
const storedAfterEdit = await pg.evaluate(() => localStorage.getItem('atlas.page.equations.v1'))
ok(/Thermo formulas/.test(storedAfterEdit), 'the name is live-saved to the board')
ok(await pg.evaluate(() => document.body.classList.contains('customizing')), 'still in Customize')

// --- the background refresh lands -------------------------------------------
// This is exactly what hydrateInBackground dispatches once the server pull has
// been applied, and what the resume path fires again on every foreground.
await pg.evaluate(() => window.dispatchEvent(new CustomEvent('atlas:hydrated')))
await pg.waitForTimeout(600)

ok(await pg.evaluate(() => document.body.classList.contains('customizing')), 'Customize survives the refresh')
ok(await pg.$(`.pwidget[data-widget-id="${widgetId}"]`) !== null, 'the new equation list is still on the page')
const liveValue = await pg.$eval(titleField, e => e.value ?? e.textContent).catch(() => null)
ok(/Thermo formulas/.test(liveValue || ''), `the typed name is still in the field (${JSON.stringify(liveValue)})`)
const storedAfterHydrate = await pg.evaluate(() => localStorage.getItem('atlas.page.equations.v1'))
ok(/Thermo formulas/.test(storedAfterHydrate), 'and still in the stored board')
ok(await pg.evaluate(() => !!document.querySelector('.palette__item')), 'the widget palette is still open')

// --- the guard is doing work, not just passing ------------------------------
// Out of Customize the same event must still re-render, or "don't clobber
// edits" would have quietly become "never refresh".
await pg.click('#customize') // leave Customize
await pg.waitForTimeout(300)
// Mark a CHILD: render() replaces #content's innerHTML, so a marker on
// #content itself survives the re-render and would prove nothing.
await pg.evaluate(() => document.getElementById('content').firstElementChild?.setAttribute('data-stale', '1'))
const marked = await pg.evaluate(() => !!document.querySelector('#content [data-stale]'))
ok(marked, 'a child of the content area was marked')
await pg.evaluate(() => window.dispatchEvent(new CustomEvent('atlas:hydrated')))
await pg.waitForTimeout(500)
const stillStale = await pg.evaluate(() => !!document.querySelector('#content [data-stale]'))
ok(!stillStale, 'with nothing being edited, a refresh still re-renders')

console.log(`\ncustomize-survives-hydrate: ${passed} passed, ${failed} failed`)
await b.close()
process.exit(failed ? 1 : 0)
