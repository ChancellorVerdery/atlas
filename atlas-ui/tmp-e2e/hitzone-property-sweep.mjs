// Property-test of hit-zone partition (src/page/hitzones.js) via direct module import.
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
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext()
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
const consoleErrors = []
await context.addInitScript((fx) => {
  localStorage.setItem('atlas.page.v1', JSON.stringify(fx))
}, FIXTURE)
const page = await context.newPage()
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push('console: ' + m.text()) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

await page.goto('http://localhost:5173/#/dashboard', { waitUntil: 'networkidle' })
await page.waitForSelector('.page-root .pwidget[data-widget-id="w-a"]', { timeout: 5000 })
await page.click('#customize')
await page.waitForSelector('body.customizing .palette .palette__item[data-kind="card"]', { timeout: 5000 })
await page.waitForSelector('.prow-handle', { timeout: 5000 })

const out = await page.evaluate(async (fixture) => {
  const hz = await import('/src/page/hitzones.js')
  const content = document.getElementById('content')
  const model = JSON.parse(localStorage.getItem('atlas.page.v1'))
  const snap = hz.snapshotZones(content, model)

  // ---- model lookup tables (from the MIGRATED model, not the raw fixture:
  // section ids are minted at first load) ----
  const rowIds = new Set(), colIds = new Set(), secIds = new Set(), lineIds = new Set()
  const colsPerRow = {}, secsPerCol = {}, linesPerSec = {}, widgetsPerLine = {}
  for (const r of model.rows) {
    rowIds.add(r.id); colsPerRow[r.id] = r.cols.length
    for (const c of r.cols) {
      colIds.add(c.id); secsPerCol[c.id] = c.sections.length
      for (const sec of c.sections) {
        secIds.add(sec.id); linesPerSec[sec.id] = sec.lines.length
        for (const l of sec.lines) { lineIds.add(l.id); widgetsPerLine[l.id] = l.widgets.length }
      }
    }
  }
  const nRows = model.rows.length
  const VALID = new Set(['newrow', 'newcol', 'newsection', 'newline', 'beside'])

  const validate = (t, x, y) => {
    if (t === null || typeof t !== 'object' || Array.isArray(t))
      return `not a plain object: ${JSON.stringify(t)}`
    if (!VALID.has(t.type)) return `bad type '${t.type}' (${JSON.stringify(t)})`
    if (!Number.isInteger(t.index)) return `non-integer index: ${JSON.stringify(t)}`
    if (t.type === 'newrow') {
      if (t.index < 0 || t.index > nRows) return `newrow index ${t.index} out of [0,${nRows}]`
    } else if (t.type === 'newcol') {
      if (!rowIds.has(t.rowId)) return `unknown rowId ${t.rowId}`
      if (t.index < 0 || t.index > colsPerRow[t.rowId]) return `newcol index ${t.index} out of [0,${colsPerRow[t.rowId]}] in ${t.rowId}`
    } else if (t.type === 'newsection') {
      if (!colIds.has(t.colId)) return `unknown colId ${t.colId}`
      if (t.index < 0 || t.index > secsPerCol[t.colId]) return `newsection index ${t.index} out of [0,${secsPerCol[t.colId]}] in ${t.colId}`
    } else if (t.type === 'newline') {
      if (!secIds.has(t.sectionId)) return `unknown sectionId ${t.sectionId}`
      if (t.index < 0 || t.index > linesPerSec[t.sectionId]) return `newline index ${t.index} out of [0,${linesPerSec[t.sectionId]}] in ${t.sectionId}`
    } else {
      if (!lineIds.has(t.lineId)) return `unknown lineId ${t.lineId}`
      if (t.index < 0 || t.index > widgetsPerLine[t.lineId]) return `beside index ${t.index} out of [0,${widgetsPerLine[t.lineId]}] in ${t.lineId}`
    }
    return null
  }

  // ---- full-grid sweep, 12px, content-local coords 0..scrollWidth/Height ----
  const W = content.scrollWidth, H = content.scrollHeight
  const violations = []
  const dist = { newrow: 0, newcol: 0, newsection: 0, newline: 0, beside: 0 }
  let total = 0
  for (let y = 0; y <= H; y += 12) {
    for (let x = 0; x <= W; x += 12) {
      total++
      let t
      try { t = hz.resolveTarget(snap, x, y) } catch (e) {
        if (violations.length < 25) violations.push(`(${x},${y}) threw: ${e.message}`)
        continue
      }
      const err = validate(t, x, y)
      if (err) { if (violations.length < 25) violations.push(`(${x},${y}) ${err}`) }
      else dist[t.type]++
    }
  }

  // ---- geometry helpers for hand-picked coherence points ----
  const findRect = (id) => {
    for (const r of snap.rows) {
      if (r.id === id) return r.rect
      for (const c of r.cols) {
        if (c.id === id) return c.rect
        for (const sec of c.sections) {
          if (sec.id === id) return sec.rect
          for (const l of sec.lines) {
            if (l.id === id) return l.rect
            for (const w of l.widgets) if (w.id === id) return w.rect
          }
        }
      }
    }
    return null
  }
  const rWA = findRect('w-a'), rWB = findRect('w-b')
  const rR1 = findRect('r-1'), rR2 = findRect('r-2')

  const coherence = []
  const probe = (label, x, y, expect) => {
    const t = hz.resolveTarget(snap, x, y)
    const ok = Object.entries(expect).every(([k, v]) => t[k] === v)
    coherence.push({ label, x, y, ok, got: t, expect })
  }
  probe('center of w-a -> beside l-1',
    (rWA.left + rWA.right) / 2, (rWA.top + rWA.bottom) / 2,
    { type: 'beside', lineId: 'l-1' })
  probe('x=20, y=center of r-1 band -> newcol r-1 index 0',
    20, (rR1.top + rR1.bottom) / 2,
    { type: 'newcol', rowId: 'r-1', index: 0 })
  probe('center of gap r-1/r-2 -> newrow index 1',
    (rR1.left + rR1.right) / 2, (rR1.bottom + rR2.top) / 2,
    { type: 'newrow', index: 1 })
  probe('y=10 above everything -> newrow index 0',
    (rR1.left + rR1.right) / 2, 10,
    { type: 'newrow', index: 0 })

  // ---- exclusion snapshot: w-b -> none inside its rect; w-a unaffected ----
  const snapEx = hz.snapshotZones(content, model, { excludeWidgetId: 'w-b' })
  const exViolations = []
  let exPoints = 0
  for (let y = Math.ceil(rWB.top) + 2; y < rWB.bottom - 2; y += 8) {
    for (let x = Math.ceil(rWB.left) + 2; x < rWB.right - 2; x += 8) {
      exPoints++
      const t = hz.resolveTarget(snapEx, x, y)
      if (!t || t.type !== 'none') {
        if (exViolations.length < 10) exViolations.push(`inside w-b (${x},${y}) -> ${JSON.stringify(t)} (expected {type:'none'})`)
      }
    }
  }
  const waViolations = []
  let waPoints = 0
  for (let y = Math.ceil(rWA.top) + 2; y < rWA.bottom - 2; y += 8) {
    for (let x = Math.ceil(rWA.left) + 2; x < rWA.right - 2; x += 8) {
      waPoints++
      const a = hz.resolveTarget(snap, x, y)
      const b = hz.resolveTarget(snapEx, x, y)
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        if (waViolations.length < 10) waViolations.push(`w-a (${x},${y}) base=${JSON.stringify(a)} excl=${JSON.stringify(b)}`)
      }
    }
  }

  return { W, H, total, violations, dist, coherence, exPoints, exViolations, waPoints, waViolations, rects: { rWA, rWB, rR1, rR2 } }
}, FIXTURE)

check('sweep: every grid point resolves to a valid, model-consistent target',
  out.violations.length === 0,
  out.violations.length ? `${out.violations.length}+ violations of ${out.total} pts (area ${out.W}x${out.H}): ${out.violations.slice(0, 8).join(' | ')}` :
  `${out.total} points over ${out.W}x${out.H}, dist=${JSON.stringify(out.dist)}`)

check('sweep: all five target types occur',
  ['newrow', 'newcol', 'newsection', 'newline', 'beside'].every((k) => out.dist[k] > 0),
  `dist=${JSON.stringify(out.dist)}`)

for (const c of out.coherence) {
  check(`coherence: ${c.label}`, c.ok,
    c.ok ? `at (${Math.round(c.x)},${Math.round(c.y)})` :
    `at (${Math.round(c.x)},${Math.round(c.y)}) got ${JSON.stringify(c.got)} expected ${JSON.stringify(c.expect)}`)
}

check(`exclude w-b: all ${out.exPoints} points inside w-b rect -> {type:'none'}`,
  out.exViolations.length === 0,
  out.exViolations.join(' | ') || `w-b rect=${JSON.stringify(out.rects.rWB)}`)

check(`exclude w-b: w-a zones unaffected (${out.waPoints} points identical)`,
  out.waViolations.length === 0, out.waViolations.join(' | '))

check('no console/page errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '))

await browser.close()

console.log(JSON.stringify({
  totalSwept: out.total,
  gridArea: { scrollWidth: out.W, scrollHeight: out.H },
  distribution: out.dist,
  results,
  pass: results.every((r) => r.ok),
}, null, 2))
process.exit(results.every((r) => r.ok) ? 0 : 1)
