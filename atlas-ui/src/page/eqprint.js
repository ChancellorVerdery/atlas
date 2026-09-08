// Print sheet — the pure layout logic behind the Equations page's print
// workbench. eqprintui.js owns the DOM (measuring, preview, raster, the print
// dialog); everything here is data in, data out, and runs under node too —
// see tests/eqprint.check.mjs.
//
// Vocabulary: the equations board is rows → cols → sections → lines →
// widgets. On the sheet a row title is the CATEGORY heading, a section title
// the SUBCATEGORY heading, and an eqcard or an eqlist item is one EQUATION.
// Content flows top-to-bottom down a column, then into the next column, then
// onto the next side (front, back, next sheet's front …).

export const STORE_KEY = 'atlas.eqprint.v1' // settings + selection — syncs like every atlas.* key
export const CAL_KEY = 'atlasEqprintCal'   // screen calibration is per device: deliberately NOT an atlas.* key

export const PAPERS = {
  letter: { w: 8.5, h: 11, label: 'Letter' },
  a4: { w: 8.27, h: 11.69, label: 'A4' },
  legal: { w: 8.5, h: 14, label: 'Legal' },
  half: { w: 5.5, h: 8.5, label: 'Half letter' },
  i35: { w: 3, h: 5, label: '3 × 5 card', card: true },
  i46: { w: 4, h: 6, label: '4 × 6 card', card: true },
  i58: { w: 5, h: 8, label: '5 × 8 card', card: true },
  custom: { w: 8.5, h: 11, label: 'Custom' },
}
export const DEFAULTS = {
  paper: 'letter', orient: 'portrait', customW: 8.5, customH: 11, margin: 0.3,
  sides: 2, pages: 1, cols: 'auto', rules: false,
  sizeMode: 'auto', size: 8,
  showCat: true, showSub: true, showNames: true, nameStyle: 'above', labels: false,
  pv: 'fit', dpi: 300, ptype: 'laser', loupe: true, dots1: false,
}
export const PX_PER_IN = 96
export const GUTTER_IN = 0.18
// Long equations shrink to their column (they never wrap), but not below this
// share of their natural width — past it the solver prefers fewer columns over
// a bigger base size. A "fits" that crushes the longest formula isn't a fit.
export const MIN_SHRINK = 0.55
export const SIZE_MIN = 3
export const SIZE_MAX = 28
export const MAX_COLS = 6
// Safari refuses canvases much past this many pixels; the raster preview caps
// its dpi for big paper rather than silently drawing nothing.
export const CANVAS_AREA_CAP = 16e6

// ---- persisted state --------------------------------------------------------

export function loadState(storage = localStorage) {
  let saved = null
  try { saved = JSON.parse(storage.getItem(STORE_KEY)) } catch { /* corrupt → defaults */ }
  const settings = { ...DEFAULTS }
  if (saved?.settings) for (const k of Object.keys(DEFAULTS)) if (k in saved.settings) settings[k] = saved.settings[k]
  // sel === null means "never saved" → the UI selects everything.
  return { settings, sel: Array.isArray(saved?.sel) ? saved.sel : null }
}
export function saveState(settings, sel, storage = localStorage) {
  storage.setItem(STORE_KEY, JSON.stringify({ v: 1, settings, sel: [...sel] }))
}
export function loadCal(storage = localStorage) {
  const c = parseFloat(storage.getItem(CAL_KEY))
  return c > 0.5 && c < 2 ? c : 1
}
export function saveCal(cal, storage = localStorage) { storage.setItem(CAL_KEY, String(cal)) }

// ---- paper geometry ------------------------------------------------------------

// [width, height] in inches with orientation applied (index cards are stored
// portrait like everything else; the UI defaults them to landscape).
export function paperSize(s) {
  const p = s.paper === 'custom' ? { w: +s.customW || 8.5, h: +s.customH || 11 } : (PAPERS[s.paper] || PAPERS.letter)
  const w = Math.min(p.w, p.h), h = Math.max(p.w, p.h)
  return s.orient === 'landscape' ? [h, w] : [w, h]
}
// Everything the flow needs, in CSS px at 96/in, for k columns.
export function geometry(s, k) {
  const [Win, Hin] = paperSize(s)
  const W = Win * PX_PER_IN, H = Hin * PX_PER_IN
  const mg = Math.max(0, +s.margin || 0) * PX_PER_IN, gut = GUTTER_IN * PX_PER_IN
  const label = s.labels ? 10 : 0
  return { Win, Hin, W, H, mg, gut, label, cw: (W - 2 * mg - (k - 1) * gut) / k, ch: H - 2 * mg - label }
}
export function effDpi(s) {
  const [Win, Hin] = paperSize(s)
  const d = +s.dpi || 300
  return Win * Hin * d * d > CANVAS_AREA_CAP ? Math.floor(Math.sqrt(CANVAS_AREA_CAP / (Win * Hin))) : d
}
export const screenPpi = (cal, dpr = 1) => Math.round(PX_PER_IN * cal * dpr)

// ---- selection tree ------------------------------------------------------------

// Rules that keep the tree readable: an untitled section hoists its widgets
// straight into the category (no blank heading to tick); a section whose only
// widget is a list carrying the section's own title (what the formula-sheet
// import produces) collapses that duplicate list level away. List items get
// synthetic ids `${widgetId}#${index}` — index-based, so reordering a list's
// items after saving a selection shifts which ones are ticked (ceiling; a
// per-item id would need a model change).
export function buildTree(page) {
  const cats = []
  for (const r of page.rows || []) {
    const cat = { id: r.id, kind: 'cat', label: r.title || '', children: [] }
    for (const c of r.cols || []) for (const s of c.sections || []) {
      const widgets = (s.lines || []).flatMap((l) => l.widgets || []).filter((w) => w.kind === 'eqcard' || w.kind === 'eqlist')
      const nodes = widgets.map((w) => w.kind === 'eqcard'
        ? { id: w.id, kind: 'eq', label: w.title || '', latex: w.latex || '', leaf: true }
        : { id: w.id, kind: 'list', label: w.title || '', children: (w.items || []).map((it, i) => ({ id: `${w.id}#${i}`, kind: 'eq', label: it.name || '', latex: it.latex || '', leaf: true })) })
      if (!nodes.length) continue
      if (!s.title) { cat.children.push(...nodes); continue }
      const only = nodes.length === 1 && nodes[0].kind === 'list' && (!nodes[0].label || nodes[0].label === s.title) ? nodes[0] : null
      cat.children.push({ id: s.id, kind: 'sub', label: s.title, children: only ? only.children : nodes })
    }
    if (cat.children.length) cats.push(cat)
  }
  return cats
}
export const leavesOf = (n) => (n.leaf ? [n] : n.children.flatMap(leavesOf))
export const allLeaves = (tree) => tree.flatMap(leavesOf)
// 'on' | 'off' | 'mixed' — the tri-state checkbox of any node.
export function stateOf(n, sel) {
  if (n.leaf) return sel.has(n.id) ? 'on' : 'off'
  const ls = leavesOf(n)
  const k = ls.filter((l) => sel.has(l.id)).length
  return k === 0 ? 'off' : k === ls.length ? 'on' : 'mixed'
}
export function findNode(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n
    if (!n.leaf) { const f = findNode(n.children, id); if (f) return f }
  }
  return null
}

// ---- blocks: the flat print order ---------------------------------------------

// [{ t:'cat'|'sub'|'list', text } | { t:'eq', id, name, latex }] — only the
// selected equations, only the headings that are switched on, in board order.
export function buildBlocks(tree, sel, s) {
  const blocks = []
  const any = (n) => leavesOf(n).some((l) => sel.has(l.id))
  const eq = (l) => blocks.push({ t: 'eq', id: l.id, name: l.label, latex: l.latex })
  const list = (n) => {
    if (!any(n)) return
    if (s.showSub && n.label) blocks.push({ t: 'list', text: n.label })
    for (const l of n.children) if (sel.has(l.id)) eq(l)
  }
  for (const cat of tree) {
    if (!any(cat)) continue
    if (s.showCat && cat.label) blocks.push({ t: 'cat', text: cat.label })
    for (const ch of cat.children) {
      if (ch.leaf) { if (sel.has(ch.id)) eq(ch); continue }
      if (ch.kind === 'list') { list(ch); continue }
      if (!any(ch)) continue
      if (s.showSub && ch.label) blocks.push({ t: 'sub', text: ch.label })
      for (const g of ch.children) g.leaf ? (sel.has(g.id) && eq(g)) : list(g)
    }
  }
  return blocks
}

// Greedy column flow. heights[i] is block i's height in px; colH the usable
// column height. Headings keep with whatever follows them, so a subcategory
// title is never stranded at the foot of a column. → [[blockIdx…], …]
export function flow(blocks, heights, colH) {
  const cols = []
  let cur = [], y = 0
  for (let i = 0; i < blocks.length; i++) {
    let need = heights[i], j = i
    while (blocks[j].t !== 'eq' && j + 1 < blocks.length) { need += heights[j + 1]; j++ }
    if (y > 0 && y + need > colH) { cols.push(cur); cur = []; y = 0 }
    cur.push(i)
    y += heights[i]
  }
  if (cur.length) cols.push(cur)
  return cols
}

// ---- the solver ------------------------------------------------------------------

// fitAt(sizePt, k, geo) → { sides, minScale } is supplied by the caller (it
// measures real DOM). Auto mode finds, per column count, the largest base
// size that lands on the allowed sides without crushing long equations past
// MIN_SHRINK, then keeps the biggest. Fixed mode keeps the fewest columns that
// fit. If nothing satisfies the shrink floor the search runs again without it
// (flagged `loose`) so the user still sees a sheet, plus a warning.
export function solve(s, fitAt) {
  const lim = Math.max(1, (+s.pages || 1) * (+s.sides || 1))
  const Ks = s.cols === 'auto' ? Array.from({ length: MAX_COLS }, (_, i) => i + 1) : [Math.max(1, +s.cols || 1)]
  const run = (guard) => {
    let best = null
    for (const k of Ks) {
      const g = geometry(s, k)
      if (g.cw < 40) continue // a column narrower than ~0.4in isn't a column
      const ok = (r) => r.sides <= lim && (!guard || r.minScale >= MIN_SHRINK)
      let cand
      if (s.sizeMode === 'fixed') {
        const size = Math.min(SIZE_MAX, Math.max(SIZE_MIN, +s.size || DEFAULTS.size))
        const r = fitAt(size, k, g)
        cand = { k, size, ...r, fits: ok(r) }
      } else {
        let lo = SIZE_MIN, hi = SIZE_MAX, rlo = fitAt(lo, k, g)
        if (!ok(rlo)) cand = { k, size: lo, ...rlo, fits: false }
        else {
          const rhi = fitAt(hi, k, g)
          if (ok(rhi)) { lo = hi; rlo = rhi }
          else for (let i = 0; i < 8; i++) { const mid = (lo + hi) / 2; const r = fitAt(mid, k, g); if (ok(r)) { lo = mid; rlo = r } else hi = mid }
          lo = Math.floor(lo * 4) / 4 // quarter-point steps read cleanly in the UI
          rlo = fitAt(lo, k, g)
          cand = { k, size: lo, ...rlo, fits: ok(rlo) }
        }
      }
      if (!best) { best = cand; continue }
      if (cand.fits !== best.fits) { if (cand.fits) best = cand; continue }
      if (cand.fits) { if (s.sizeMode !== 'fixed' && cand.size > best.size) best = cand } // fixed: first (fewest columns) that fits wins
      else if (cand.sides < best.sides) best = cand
    }
    return best
  }
  let best = run(true)
  if (!best || !best.fits) {
    const loose = run(false)
    if (loose && (loose.fits || !best)) { best = loose; best.loose = true }
  }
  return best
}

// How small the smallest ink on the page really is. MathLive's KaTeX fonts
// have an x-height of ~0.43em and set scripts at 0.7×, so the subscript
// x-height in points is 0.43 × 0.7 × (base size × how far the most-shrunk
// equation scaled). In printer dots that's the number that decides legibility.
export function legibility(sizePt, minScale, dpi, hasScripts) {
  const effPt = sizePt * minScale
  const xhPt = 0.43 * (hasScripts ? 0.7 : 1) * effPt
  const dots = xhPt / 72 * dpi
  return { effPt, xhPt, dots, grade: dots >= 8 ? 'good' : dots >= 5 ? 'marginal' : 'hard to read' }
}
