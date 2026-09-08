// Atlas's tabs are one control, not two lookalikes.
//
// Study/Flashcards course tabs used to be .st-tab: a hand-rolled near-copy of
// .page-tab with a different font size, a different weight and a different
// hover state. They are .page-tab now, with .st-tab left holding only the
// affordances the shared class has no opinion about (add, delete, rename).
// This measures both strips and asserts the box really is identical.
//
// Run: node tmp-e2e/tabs-match.mjs   (needs the dev server on 5173)
import { chromium } from 'playwright'

let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok   ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const BOX = ['fontSize', 'fontWeight', 'fontFamily', 'borderRadius', 'paddingTop', 'paddingBottom',
  'borderTopWidth', 'borderTopStyle', 'lineHeight', 'display', 'alignItems', 'transitionDuration']

const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1400, height: 950 } })
await ctx.addInitScript(() => {
  const seed = (k, v) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v) }
  seed('atlas.auth.v1', '{"offline":true}')
  seed('atlas.plugins.v1', JSON.stringify({ enabled: { study: true, flashcards: true }, installed: {} }))
  seed('atlas.ai.v1', JSON.stringify({ providers: { claude: { oauth: { access: 'test-token' } } } }))
  // two courses, so there is a real tab strip with an active tab to measure
  seed('atlas.study.v1', JSON.stringify({
    active: 'c1',
    tabs: [{ id: 'c1', name: 'Calculus 2' }, { id: 'c2', name: 'Physics 2' }],
  }))
})
const pg = await ctx.newPage()

const styleOf = (sel) => pg.$eval(sel, (el, keys) => {
  const cs = getComputedStyle(el)
  const out = {}
  for (const k of keys) out[k] = cs[k]
  out.height = Math.round(el.getBoundingClientRect().height)
  return out
}, BOX)

// --- the settings tab strip (the reference) ---------------------------------
await pg.goto('http://localhost:5173/#/settings/appearance', { waitUntil: 'domcontentloaded' })
await pg.waitForSelector('#page-tabs .page-tab', { timeout: 15000 })
const settingsTab = await styleOf('#page-tabs .page-tab')
const settingsActive = await pg.$eval('#page-tabs .page-tab.is-active', e => getComputedStyle(e).color)

// --- the Study course tab strip --------------------------------------------
await pg.goto('http://localhost:5173/#/study', { waitUntil: 'domcontentloaded' })
await pg.waitForSelector('.st-tabs', { timeout: 15000 })
await pg.waitForTimeout(600)
const strip = await pg.$eval('.st-tabs', e => ({ cls: e.className, wrap: getComputedStyle(e).flexWrap, gap: getComputedStyle(e).gap }))
ok(/\bpage-tabs\b/.test(strip.cls), `the course strip is a .page-tabs (class="${strip.cls}")`)

const courseTabs = await pg.$$('.st-tabs .page-tab')
ok(courseTabs.length >= 1, `course tabs render as .page-tab (${courseTabs.length} found)`)
ok((await pg.$$('.st-tabs .st-tab:not(.page-tab)')).length === 0, 'no course tab is left on the old class alone')

const courseTab = await styleOf('.st-tabs .page-tab:not(.st-tab--add)')
for (const k of BOX) {
  ok(courseTab[k] === settingsTab[k], `${k} matches the settings tab (${courseTab[k]} vs ${settingsTab[k]})`)
}
ok(courseTab.height === settingsTab.height, `same rendered height (${courseTab.height}px vs ${settingsTab.height}px)`)

// the active state is the shared brass one, not st-tab's old full-brass border
const courseActive = await pg.$eval('.st-tabs .page-tab.is-active', e => getComputedStyle(e).color).catch(() => null)
ok(courseActive === settingsActive, `active colour matches (${courseActive} vs ${settingsActive})`)

// --- Bridge's strip behaviour: wrap, then scroll inside the strip ------------
const stripCSS = await pg.$eval('#page-tabs, .st-tabs', e => {
  const cs = getComputedStyle(e)
  return { wrap: cs.flexWrap, maxHeight: cs.maxHeight, overflowY: cs.overflowY }
})
ok(stripCSS.wrap === 'wrap', `the strip wraps (${stripCSS.wrap})`)
ok(stripCSS.maxHeight === '68px', `the strip caps at two rows (${stripCSS.maxHeight})`)
ok(stripCSS.overflowY === 'auto', `and scrolls inside itself past that (${stripCSS.overflowY})`)

console.log(`\ntabs-match: ${passed} passed, ${failed} failed`)
await b.close()
process.exit(failed ? 1 : 0)
