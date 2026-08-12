// Equations import self-check: the served formula sheet lands as a COLUMN
// directly beside the one holding the anchor subject, and re-running after an
// earlier import replaces that column instead of duplicating it.
// Needs the dev server on :5173. Run: node tests/eqimport.check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const PAGE_KEY = 'atlas.page.equations.v1'
const FLAG = 'atlas.eqimport.v3' // must track EQ_IMPORT_FLAG in renderer.js
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
  // Placement is "column beside the anchor", per EQ_IMPORT_FLAG's block in
  // renderer.js. This check used to expect a whole new row underneath, which is
  // what the import did before the v3 flag bump.
  const row = p.rows[at]
  const anchorAt = row.cols.findIndex((c) => /physics i\b/i.test(title(c)))
  const imported = row.cols[anchorAt + 1]
  assert.ok(imported, 'the sheet landed as a column directly beside the physics column')
  assert.equal(title(imported), 'Physics II formula sheet')
  // sections became eqlist widgets, first one categorized from the raw sheet
  const lines = imported.sections[0].lines
  assert.equal(lines[0].widgets[0].kind, 'eqlist')
  assert.equal(lines[0].widgets[0].title, 'Constants')
  assert.ok(lines.some((l) => l.widgets[0].title === 'Capacitor charging'))
  // exactly one copy anywhere on the board
  const copies = p.rows.flatMap((r) => r.cols).filter((c) => title(c) === 'Physics II formula sheet')
  assert.equal(copies.length, 1, 'no duplicate import column')
}

await browser.close()
console.log('eqimport.check.mjs OK')
