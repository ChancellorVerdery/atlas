// Equations import self-check: the served formula sheet lands as a NEW ROW
// directly under the row holding the anchor subject, and re-running after a
// v1-style import replaces that column instead of duplicating it.
// Needs the dev server on :5173. Run: node tests/eqimport.check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const PAGE_KEY = 'atlas.page.equations.v1'
const FLAG = 'atlas.eqimport.v2'
const browser = await chromium.launch() // headless
const ctx = await browser.newContext()
const page = await ctx.newPage()

// Empty sections get pruned on load, so every seeded column carries a widget.
const col = (id, title) => ({ id, sections: [{ id: `s-${id}`, title, lines: [
  { id: `l-${id}`, widgets: [{ id: `w-${id}`, kind: 'eqcard', title: 'Sample', latex: 'a^2+b^2=c^2' }] },
] }] })
const seed = (extraCol) => ({ v: 1, rows: [
  { id: 'r-top', cols: [col('c-calc', 'Calculus II')] },
  { id: 'r-phys', cols: [
    col('c-phys1', 'Physics I'),
    ...(extraCol ? [col('c-old', 'Physics II formula sheet')] : []),
  ] },
]})

const run = async (extraCol) => {
  await page.goto('http://localhost:5173/#/equations')
  await page.evaluate(([k, f, s]) => {
    localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true })) // skip the login gate
    localStorage.setItem(k, JSON.stringify(s)); localStorage.removeItem(f)
  }, [PAGE_KEY, FLAG, seed(extraCol)])
  await page.reload()
  await page.waitForFunction((f) => localStorage.getItem(f) !== null, FLAG, { timeout: 10000 })
  return page.evaluate((k) => JSON.parse(localStorage.getItem(k)), PAGE_KEY)
}

const title = (c) => c.sections[0].title
for (const extraCol of [false, true]) {
  const p = await run(extraCol)
  const at = p.rows.findIndex((r) => r.cols.some((c) => /physics i\b/i.test(title(c))))
  assert.ok(at > -1, 'anchor row survived')
  const imported = p.rows[at + 1]
  assert.ok(imported, 'a row exists directly under the physics row')
  assert.equal(imported.cols.length, 1)
  assert.equal(title(imported.cols[0]), 'Physics II formula sheet')
  // sections became eqlist widgets, first one categorized from the raw sheet
  const lines = imported.cols[0].sections[0].lines
  assert.equal(lines[0].widgets[0].kind, 'eqlist')
  assert.equal(lines[0].widgets[0].title, 'Constants')
  assert.ok(lines.some((l) => l.widgets[0].title === 'Capacitor charging'))
  // exactly one copy anywhere on the board
  const copies = p.rows.flatMap((r) => r.cols).filter((c) => title(c) === 'Physics II formula sheet')
  assert.equal(copies.length, 1, 'no duplicate import column')
}

await browser.close()
console.log('eqimport.check.mjs OK')
