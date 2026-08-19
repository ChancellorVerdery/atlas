// A note containing all three generated block types must render as: a real
// HTML table, a plotted SVG, and a sanitized inline figure. The unit test
// covers the plotting maths; this covers the part that only exists in a
// browser — extraction order (the specs must survive the math/wiki passes),
// async hydration of the graph mount, and sanitisation of model-authored SVG.
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const NOTE = `---
date: 2026-08-19
source: handwritten
---

# Projectile motion

Height is $h(t) = -4.9t^2 + 20t$, so the apex is at [[Kinematics]].

\`\`\`atlas-graph
{"title":"Height vs time","xLabel":"t (s)","yLabel":"h (m)","domain":[0,4],
 "curves":[{"latex":"-4.9x^2+20x","label":"h(t)"}],
 "points":[{"x":2.04,"y":20.4,"label":"apex"}]}
\`\`\`

\`\`\`atlas-table
{"columns":["Ion","Charge"],"rows":[["Na","+1"],["O","-2"]],"caption":"Common ions"}
\`\`\`

\`\`\`atlas-figure
<svg viewBox="0 0 200 120" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="80" height="40" stroke="currentColor" fill="none"/><text x="20" y="35">block</text><script>window.__pwned = 1</script></svg>
\`\`\`

A malformed one must not eat the note:

\`\`\`atlas-graph
{ this is not json
\`\`\`

End of note.
`

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()

await page.route('**/notes-api/tree*', (r) => r.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ dirs: [], notes: [{ path: 'projectile.md', mtime: 1 }] }),
}))
await page.route('**/graph-api/file*', (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: NOTE }))
await page.route('**/notes-sync/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rev: 0, files: [] }) }))

await page.addInitScript(() => {
  const seed = (k, v) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v) }
  seed('atlas.auth.v1', '{"offline":true}')
  seed('atlas.plugins.v1', JSON.stringify({ enabled: { notes: true }, installed: {} }))
  seed('atlas.notes.v1', JSON.stringify({ dir: '/tmp/notes', lastSubdir: '', openDirs: [] }))
})

await page.goto(`${BASE}/#/notes`)
await page.waitForSelector('.nt-note', { timeout: 15000 })
await page.click('.nt-note')
await page.waitForSelector('.nt-md', { timeout: 15000 })
await page.waitForSelector('.nt-md .ng-svg, .nt-md .ng-mount', { timeout: 15000 })
await page.waitForTimeout(2500) // compute-engine is a lazy ~1MB import

console.log('1. the graph is plotted by the app, not described')
ok(await page.locator('.nt-md .ng-svg').count() === 1, 'exactly one plotted svg')
ok(await page.locator('.nt-md .ng-svg path').count() >= 1, 'the curve was drawn')
const svgText = await page.locator('.nt-md .ng-svg').innerText().catch(() => '')
ok(/Height vs time/.test(await page.locator('.nt-md .ng-svg').innerHTML()), 'title rendered into the svg')
ok(/apex/.test(await page.locator('.nt-md .ng-svg').innerHTML()), 'labelled point rendered')
// The MALFORMED block below is deliberately left visible, so "atlas-graph"
// does still appear. What must not appear is the consumed spec's contents.
const noteText = await page.locator('.nt-md').innerText()
ok(!noteText.includes('"curves"') && !noteText.includes('-4.9x^2'), 'the consumed spec is not shown as raw text')

console.log('2. the table is a real table')
ok(await page.locator('.nt-md table').count() === 1, 'one html table')
ok(await page.locator('.nt-md table th').count() === 2, 'two header cells')
ok(await page.locator('.nt-md table tbody tr').count() === 2, 'two body rows')
const tableText = await page.locator('.nt-md table').innerText()
ok(/Na/.test(tableText) && /\+1/.test(tableText), 'cell contents present')
ok(/Common ions/.test(await page.locator('.nt-md').innerText()), 'caption kept')

console.log('3. the figure is inlined and sanitised')
ok(await page.locator('.nt-md .nt-figure svg').count() === 1, 'figure svg inlined')
ok(await page.locator('.nt-md .nt-figure svg rect').count() === 1, 'its shapes survived')
ok(await page.evaluate(() => window.__pwned) === undefined, 'the <script> inside the figure did NOT run')
ok(!(await page.locator('.nt-md').innerHTML()).includes('__pwned'), 'and was stripped from the DOM')

console.log('4. a malformed spec degrades, it does not eat the note')
ok(/End of note/.test(await page.locator('.nt-md').innerText()), 'content after the bad block still renders')
ok(/Projectile motion/.test(await page.locator('.nt-md').innerText()), 'and the heading before it')

console.log('5. the rest of the note still works')
ok(await page.locator('.nt-md .nt-wiki').count() >= 1, 'wiki-links still parsed')
ok((await page.locator('.nt-md').innerHTML()).includes('ML__mathlive') || (await page.locator('.nt-md').innerHTML()).includes('math'), 'inline math still rendered')

await ctx.close()
await browser.close()
console.log(`\nnotes-generated-blocks: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
