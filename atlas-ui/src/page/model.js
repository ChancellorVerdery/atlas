// Page layout model: rows (stacked vertically) → cols (side by side) →
// sections (stacked vertically) → lines (stacked vertically) → widgets
// (side by side). A widget is a single card, list, or graph. A SECTION is
// the user-visible group (border + optional title); lines are the shelves
// inside it. Pure data + localStorage — no DOM. Every mutation saves
// immediately (Customize live-edits the real page; there is no draft).
//
// localStorage is the single source of truth: callers loadPage() fresh,
// mutate, and the mutation helpers save — no long-lived shared page object.

const DEFAULT_KEY = 'atlas.page.v1'
// Which storage key a loaded page object belongs to — kept OUT of the object
// itself so it never leaks into the serialized JSON.
const pageKeys = new WeakMap()

export const uid = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export function loadPage(storageKey = DEFAULT_KEY) {
  try {
    const raw = localStorage.getItem(storageKey)
    const p = JSON.parse(raw)
    if (p && Array.isArray(p.rows)) {
      prune(p)
      // Persist whatever normalization/migration changed — generated ids
      // must be minted ONCE, or every load would re-mint them and the DOM's
      // ids would never match a fresh load's (breaking drag snapshots).
      const out = JSON.stringify(p)
      if (out !== raw) localStorage.setItem(storageKey, out)
      pageKeys.set(p, storageKey)
      return p
    }
  } catch { /* corrupted → fresh page */ }
  const fresh = { v: 1, rows: [] }
  pageKeys.set(fresh, storageKey)
  return fresh
}

export function savePage(page) {
  localStorage.setItem(pageKeys.get(page) || DEFAULT_KEY, JSON.stringify(page))
}

// Mobile gets its own storage key per page, seeded once from seedFn() (e.g. a
// clone of the desktop layout) and independent of the desktop key from then
// on — editing the mobile layout never touches desktop's, and vice versa.
export const mobileKey = (k) => k + '.mobile'
export function loadPageMobile(storageKey, seedFn) {
  const mk = mobileKey(storageKey)
  if (localStorage.getItem(mk) == null) {
    const seed = seedFn()
    if (seed) localStorage.setItem(mk, JSON.stringify(structuredClone(seed)))
  }
  return loadPage(mk)
}

const demoPoints = () =>
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => ({ label, value: Math.round(10 + Math.random() * 90) }))

export function newWidget(kind) {
  if (kind === 'card') return { id: uid('w'), kind, title: 'New card', text: '' }
  if (kind === 'list') return { id: uid('w'), kind, title: 'New list', items: ['New item'] }
  if (kind === 'eqcard') return { id: uid('w'), kind, title: 'New equation', latex: '' }
  if (kind === 'eqlist') return { id: uid('w'), kind, title: 'New equation list', items: [{ name: 'New equation', latex: '' }] }
  if (kind.startsWith('gym')) return { id: uid('w'), kind } // gym widgets are live views over the gym store
  if (kind.startsWith('cal')) return { id: uid('w'), kind } // calendar widgets are live views over Google Calendar
  if (kind.startsWith('cv')) return { id: uid('w'), kind } // canvas widgets are live views over the Canvas LMS API
  if (kind.startsWith('wk')) return { id: uid('w'), kind } // work widgets are live views over the work store
  if (kind.startsWith('sl')) return { id: uid('w'), kind } // sleep widgets are live views over the sleep store
  return { id: uid('w'), kind: 'graph', graphType: 'bar', title: 'New graph', xLabel: '', yLabel: '', points: demoPoints() }
}

// → { widget, row, col, section, line, ri, ci, si, li, wi } | null
export function findWidget(page, id) {
  for (let ri = 0; ri < page.rows.length; ri++) {
    const row = page.rows[ri]
    for (let ci = 0; ci < row.cols.length; ci++) {
      const col = row.cols[ci]
      for (let si = 0; si < col.sections.length; si++) {
        const section = col.sections[si]
        for (let li = 0; li < section.lines.length; li++) {
          const line = section.lines[li]
          for (let wi = 0; wi < line.widgets.length; wi++) {
            if (line.widgets[wi].id === id) return { widget: line.widgets[wi], row, col, section, line, ri, ci, si, li, wi }
          }
        }
      }
    }
  }
  return null
}

const allCols = (page) => page.rows.flatMap((r) => r.cols)
const allSections = (page) => allCols(page).flatMap((c) => c.sections)
const findRow = (page, id) => page.rows.find((r) => r.id === id)
const findCol = (page, id) => allCols(page).find((c) => c.id === id)
export const findSection = (page, id) => allSections(page).find((s) => s.id === id)
const findLine = (page, id) => allSections(page).flatMap((s) => s.lines).find((l) => l.id === id)
function findLineCtx(page, lineId) {
  for (const row of page.rows) for (const col of row.cols) for (const section of col.sections)
    for (const line of section.lines) if (line.id === lineId) return { row, col, section, line }
  return null
}

// Drop-target vocabulary (produced by hitzones.resolveTarget):
//   { type:'beside',     lineId,    index } — into an existing line of widgets
//   { type:'newline',    sectionId, index } — new line inside a section
//   { type:'newsection', colId,     index } — new section stacked in a column
//   { type:'newcol',     rowId,     index } — new column in a row
//   { type:'newrow',     index }            — new row on the page
//   { type:'stack',      lineId,    index } — under widget [index] of a line:
//     the line's widgets split into per-widget columns and the new widget
//     becomes a section stacked beneath the pointed one
//   { type:'none' }                         — no-op (cursor over the dragged widget)
// Returns true only when the target container actually resolved and the
// widget was placed — a stale target (e.g. the page changed in another tab
// between dragstart and drop) must not be silently swallowed, or a caller
// that already detached the widget would end up deleting it.
export function insertWidget(page, widget, target) {
  const line = () => ({ id: uid('l'), widgets: [widget] })
  const section = () => ({ id: uid('s'), lines: [line()] })
  const col = () => ({ id: uid('c'), sections: [section()] })
  if (target.type === 'beside') {
    const ln = findLine(page, target.lineId)
    if (!ln) return false
    ln.widgets.splice(target.index, 0, widget)
  } else if (target.type === 'newline') {
    const s = findSection(page, target.sectionId)
    if (!s) return false
    s.lines.splice(target.index, 0, line())
  } else if (target.type === 'newsection') {
    const c = findCol(page, target.colId)
    if (!c) return false
    c.sections.splice(target.index, 0, section())
  } else if (target.type === 'newcol') {
    const r = findRow(page, target.rowId)
    if (!r) return false
    r.cols.splice(target.index, 0, col())
  } else if (target.type === 'newrow') {
    page.rows.splice(target.index, 0, { id: uid('r'), cols: [col()] })
  } else if (target.type === 'stack') {
    // Split the line's widgets into per-widget columns (equal shares of the
    // old column's width) and stack the new widget as a section under the
    // pointed widget — the model's only vertical unit inside one slot of a
    // side-by-side line is a column of sections.
    const f = findLineCtx(page, target.lineId)
    if (!f || f.col.sections.length !== 1 || f.section.lines.length !== 1) return false
    const at = Math.min(target.index, f.line.widgets.length - 1)
    if (at < 0) return false
    const share = (Number(f.col.width) > 0 ? Number(f.col.width) : 1) / f.line.widgets.length
    // ponytail: a section title that visually spanned the whole line stays on
    // the first column's section only
    const cols = f.line.widgets.map((w, i) => ({
      id: uid('c'), width: share,
      sections: [{ id: uid('s'), ...(i === 0 && f.section.title ? { title: f.section.title } : {}), lines: [{ id: uid('l'), widgets: [w] }] }],
    }))
    cols[at].sections.push(section())
    f.row.cols.splice(f.row.cols.indexOf(f.col), 1, ...cols)
  } else return false
  prune(page)
  savePage(page)
  return true
}

export function moveWidget(page, id, target) {
  if (!target || target.type === 'none') return
  const f = findWidget(page, id)
  if (!f) return
  const [w] = f.line.widgets.splice(f.wi, 1)
  // The target index was resolved against the pre-move layout; removing the
  // widget from the same line shifts later slots down by one. Containers are
  // NOT pruned until after insert, so section/line indices stay as snapshotted.
  let t = target
  if ((t.type === 'beside' || t.type === 'stack') && t.lineId === f.line.id && t.index > f.wi) t = { ...t, index: t.index - 1 }
  if (!insertWidget(page, w, t)) f.line.widgets.splice(f.wi, 0, w) // stale target — put it back, save nothing
}

export function removeWidget(page, id) {
  const f = findWidget(page, id)
  if (!f) return
  f.line.widgets.splice(f.wi, 1)
  prune(page)
  savePage(page)
}

// pct: the row's width as a percentage of the page content width (100 =
// full width, the default). Zoom-safe because it's relative, like the rest.
export function setRowWidth(page, rowId, pct) {
  const row = page.rows.find((r) => r.id === rowId)
  if (!row) return
  row.width = pct
  savePage(page)
}

// px: the row's minimum height in pixels (absent = content-sized). Stored as
// a floor, not a hard height, so content can never be clipped by it.
export function setRowHeight(page, rowId, px) {
  const row = page.rows.find((r) => r.id === rowId)
  if (!row) return
  row.height = px
  savePage(page)
}

// widths: { [colId]: growShare } — a column's flex-grow share within its row
// (fr-like: 1 is the default equal share; 2 means twice its siblings).
export function setColWidths(page, widths) {
  for (const row of page.rows) {
    for (const col of row.cols) {
      if (widths[col.id] != null) col.width = widths[col.id]
    }
  }
  savePage(page)
}

export function moveRow(page, rowId, toIndex) {
  const from = page.rows.findIndex((r) => r.id === rowId)
  if (from === -1) return
  const [row] = page.rows.splice(from, 1)
  page.rows.splice(from < toIndex ? toIndex - 1 : toIndex, 0, row)
  savePage(page)
}

// Invariant: no empty widgets/lines/sections/cols arrays survive; empty rows
// = empty page. Doubles as a normalizer for hand-edited/corrupted storage
// (containers must be objects with array children, widgets must have a known
// kind, kind-specific arrays are coerced) AND as the migration for the
// pre-section shape, where a col held `lines` (and possibly `title`)
// directly — those become the col's single section. loadPage runs this
// inside its try/catch, but render() runs outside it, so anything prune lets
// through must render.
export const KINDS = new Set(['card', 'list', 'graph', 'eqcard', 'eqlist', 'gymcurrent', 'gymnext', 'gymscore', 'gymscoregraph', 'gymexercises', 'gymvolume', 'calagenda', 'calmonth', 'cvgradebook', 'cvupcoming', 'cvannounce', 'cvoverdue', 'cvgpa', 'cvsemesters', 'cvcourses', 'cvtodo', 'wkincome', 'wkshifts', 'wkhistory', 'wktipshare', 'wkupcoming', 'slbedtime', 'sllog', 'slhours', 'sldebt'])
const isObj = (o) => o !== null && typeof o === 'object'
function prune(page) {
  page.rows = (Array.isArray(page.rows) ? page.rows : []).filter((r) => isObj(r) && Array.isArray(r.cols))
  for (const row of page.rows) {
    row.id ||= uid('r')
    row.cols = row.cols.filter((c) => isObj(c) && (Array.isArray(c.sections) || Array.isArray(c.lines)))
    for (const col of row.cols) {
      col.id ||= uid('c')
      if (!Array.isArray(col.sections)) {
        // pre-section data: col.lines (+ optional col.title) → one section
        col.sections = [{ id: uid('s'), ...(col.title ? { title: col.title } : {}), lines: col.lines }]
        delete col.lines
        delete col.title
      }
      col.sections = col.sections.filter((s) => isObj(s) && Array.isArray(s.lines))
      for (const section of col.sections) {
        section.id ||= uid('s')
        section.lines = section.lines.filter((l) => isObj(l) && Array.isArray(l.widgets))
        for (const line of section.lines) {
          line.id ||= uid('l')
          line.widgets = line.widgets.filter((w) => isObj(w) && KINDS.has(w.kind))
          for (const w of line.widgets) {
            w.id ||= uid('w')
            if (w.kind === 'list' && !Array.isArray(w.items)) w.items = []
            if (w.kind === 'graph' && !Array.isArray(w.points)) w.points = []
            if (w.kind === 'eqlist') w.items = Array.isArray(w.items) ? w.items.filter(isObj) : []
          }
        }
        section.lines = section.lines.filter((l) => l.widgets.length)
      }
      col.sections = col.sections.filter((s) => s.lines.length)
    }
    row.cols = row.cols.filter((c) => c.sections.length)
  }
  page.rows = page.rows.filter((r) => r.cols.length)
  return page
}
