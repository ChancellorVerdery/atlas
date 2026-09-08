// Notes graphs must survive a change of page geometry.
//
// A graph is drawn once into a fixed-viewBox SVG whose axis labels are HTML in
// a <foreignObject>. Nothing used to re-lay it out, and the Mac app's View-menu
// zoom (WKWebView.pageZoom) is applied natively with no signal to the page at
// all — so the labels kept the layout the old zoom produced.
//
// Two invariants are asserted here:
//   1. no .ng-fo carries opacity < 1. That is the WebKit compositing trigger
//      (bug 23113) for foreignObject content losing the viewBox scale, so the
//      labels are dimmed with colour instead.
//   2. an 'atlas:pagezoom' event (dispatched by WebView.swift) and a window
//      resize each rebuild the open note's graphs, and the tick labels still
//      sit on their ticks afterwards.
//
// Run: node tmp-e2e/notegraph-zoom.mjs   (needs the dev server on 5173)
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok   ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const NOTE = `# Projectile motion

\`\`\`atlas-graph
{"title":"Height vs time","xLabel":"t (s)","yLabel":"h (m)","domain":[0,4],
 "curves":[{"latex":"-4.9x^2+20x","label":"h(t)"}]}
\`\`\`
`

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()
await page.route('**/notes-api/tree*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ dirs: [], notes: [{ path: 'projectile.md', mtime: 1 }] }) }))
await page.route('**/graph-api/file*', (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: NOTE }))
await page.route('**/notes-sync/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rev: 0, files: [] }) }))
await page.addInitScript(() => {
  const seed = (k, v) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v) }
  seed('atlas.auth.v1', '{"offline":true}')
  seed('atlas.plugins.v1', JSON.stringify({ enabled: { notes: true }, installed: {} }))
  seed('atlas.notes.v1', JSON.stringify({ dir: '/tmp/notes', lastSubdir: '', openDirs: [] }))
  seed('atlas.ai.v1', JSON.stringify({ providers: { claude: { oauth: { access: 'test-token' } } } }))
})

await page.goto(`${BASE}/#/notes`)
await page.waitForSelector('.nt-note', { timeout: 15000 })
await page.click('.nt-note')
await page.waitForSelector('.nt-md .ng-svg', { timeout: 15000 })
await page.waitForTimeout(2500) // compute-engine is a lazy ~1MB import

// --- 1. the compositing trigger is gone -------------------------------------
const opacities = await page.$$eval('.ng-svg .ng-fo', els => els.map(e => getComputedStyle(e).opacity))
ok(opacities.length > 0, `the graph has foreignObject labels (${opacities.length})`)
ok(opacities.every(o => Number(o) === 1), `no label carries opacity < 1 (got ${[...new Set(opacities)].join(',')})`)
// the title is deliberately undimmed; check a tick label
const dimmed = await page.$eval('.ng-svg .ng-fo:not(.ng-fo--title)', e => getComputedStyle(e).color)
ok(/rgba\(/.test(dimmed) && /0\.75\)/.test(dimmed), `tick labels are dimmed with colour instead (${dimmed})`)
const title = await page.$eval('.ng-svg .ng-fo--title', e => getComputedStyle(e).color)
ok(!/rgba\(/.test(title), `the title stays full strength (${title})`)

// --- 2. geometry: x tick labels sit under their ticks ------------------------
// The label box is centred on the tick; measure both in page pixels.
const measure = () => page.evaluate(() => {
  const svg = document.querySelector('.nt-md .ng-svg')
  if (!svg) return null
  const fos = [...svg.querySelectorAll('foreignObject')].filter(f => f.querySelector('.ng-fo--c'))
  const box = svg.getBoundingClientRect()
  return {
    w: Math.round(box.width),
    labels: fos.map(f => { const r = f.getBoundingClientRect(); return { cx: r.left + r.width / 2 - box.left, top: r.top - box.top, w: r.width } }),
  }
})

const before = await measure()
ok(before && before.labels.length >= 2, `x-axis tick labels measured (${before?.labels.length})`)
const inside = (m) => m.labels.every(l => l.cx > 0 && l.cx < m.w && l.w > 0)
ok(inside(before), 'every tick label box lands inside the plot at load')

// --- 3. a page-zoom event rebuilds the graph --------------------------------
await page.evaluate(() => { document.querySelector('.nt-md .ng-svg').dataset.stale = '1' })
await page.evaluate(() => window.dispatchEvent(new CustomEvent('atlas:pagezoom', { detail: { zoom: 1.5 } })))
await page.waitForTimeout(1200)
const rebuiltOnZoom = await page.evaluate(() => !document.querySelector('.nt-md .ng-svg[data-stale]'))
ok(rebuiltOnZoom, 'atlas:pagezoom redraws the open note’s graph')

// --- 4. a resize rebuilds it too, and the labels still line up ---------------
await page.evaluate(() => { document.querySelector('.nt-md .ng-svg').dataset.stale = '1' })
await page.setViewportSize({ width: 900, height: 1000 })
await page.waitForTimeout(1200)
const rebuiltOnResize = await page.evaluate(() => !document.querySelector('.nt-md .ng-svg[data-stale]'))
ok(rebuiltOnResize, 'a window resize redraws it as well')
const after = await measure()
ok(after && after.labels.length === before.labels.length, `same number of tick labels after (${after?.labels.length})`)
ok(after && inside(after), 'every tick label still lands inside the plot after the redraw')

console.log(`\nnotegraph-zoom: ${passed} passed, ${failed} failed`)
await browser.close()
process.exit(failed ? 1 : 0)
