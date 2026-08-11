// Drop-target resolution. A snapshot of the page's natural layout is taken
// ONCE per drag (re-measuring mid-drag would see the preview ghost's shoved
// layout and oscillate); every dragover then resolves the cursor against the
// frozen snapshot. Coordinates are content-local (content rect subtracted,
// scroll added back), so the snapshot survives mid-drag scrolling.
//
// resolveTarget is a decision tree over nested slabs, so the hit zones are
// disjoint BY CONSTRUCTION — every point takes exactly one path:
//   1. page: above/below/between row bands → newrow; else inside one row
//   2. row: left/right padding strips + column gutters → newcol; else one col
//   3. col: gaps between sections, the tail under a short column, and a thin
//      band inside each section's top/bottom edges → newsection; else inside
//      one section
//   4. section: above/between/below lines → newline; else inside one line
//   5. line: gaps between widgets → beside; else inside one widget →
//      nearest-edge diagonal partition (normalized, so the four zones are the
//      corner-to-corner triangles): left/right → beside, top/bottom → newline.
//      The dead space BELOW a short widget (a taller sibling stretches the
//      line past it) → stack: the drop lands directly under that widget by
//      splitting the line into per-widget columns (model.js insertWidget).

export function toLayoutPoint(contentEl, clientX, clientY) {
  const r = contentEl.getBoundingClientRect()
  return { x: clientX - r.left + contentEl.scrollLeft, y: clientY - r.top + contentEl.scrollTop }
}

export function snapshotZones(contentEl, page, { excludeWidgetId } = {}) {
  const cr = contentEl.getBoundingClientRect()
  const sx = contentEl.scrollLeft
  const sy = contentEl.scrollTop
  const rectOf = (el) => {
    const r = el.getBoundingClientRect()
    return {
      left: r.left - cr.left + sx, top: r.top - cr.top + sy,
      right: r.right - cr.left + sx, bottom: r.bottom - cr.top + sy,
      width: r.width, height: r.height,
    }
  }
  const q = (sel) => contentEl.querySelector(sel)
  const rows = page.rows.map((row) => {
    const rowEl = q(`.prow[data-row-id="${row.id}"]`)
    return rowEl && {
      id: row.id, rect: rectOf(rowEl),
      cols: row.cols.map((col) => {
        const colEl = q(`.pcol[data-col-id="${col.id}"]`)
        return colEl && {
          id: col.id, rect: rectOf(colEl),
          sections: col.sections.map((sec) => {
            const secEl = q(`.psec[data-sec-id="${sec.id}"]`)
            return secEl && {
              id: sec.id, rect: rectOf(secEl),
              lines: sec.lines.map((ln) => {
                const lineEl = q(`.pline[data-line-id="${ln.id}"]`)
                return lineEl && {
                  id: ln.id, rect: rectOf(lineEl),
                  widgets: ln.widgets.map((w) => {
                    const wEl = q(`.pwidget[data-widget-id="${w.id}"]`)
                    return wEl && { id: w.id, rect: rectOf(wEl), excluded: w.id === excludeWidgetId }
                  }).filter(Boolean),
                }
              }).filter(Boolean),
            }
          }).filter(Boolean),
        }
      }).filter(Boolean),
    }
  }).filter(Boolean)
  return { rows }
}

export function resolveTarget(snap, x, y) {
  const rows = snap.rows
  if (!rows.length) return { type: 'newrow', index: 0 }
  if (y < rows[0].rect.top) return { type: 'newrow', index: 0 }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (y > row.rect.bottom) {
      const next = rows[i + 1]
      if (!next) return { type: 'newrow', index: rows.length }
      if (y < next.rect.top) return { type: 'newrow', index: i + 1 }
      continue
    }
    return inRow(row, x, y)
  }
  return { type: 'newrow', index: rows.length }
}

// Columns are equal-share flex, so they always fill the row edge-to-edge and
// no literal "empty space beside the content" exists inside a row. The spec's
// new-section-beside gesture still needs an in-row home, so a thin strip just
// inside the row's outermost edges resolves to newcol (capped so a narrow
// column keeps most of its own zones).
const EDGE = 24
function inRow(row, x, y) {
  const cols = row.cols
  const first = cols[0].rect
  const last = cols[cols.length - 1].rect
  if (x < first.left + Math.min(EDGE, first.width / 4)) return { type: 'newcol', rowId: row.id, index: 0 }
  if (x > last.right - Math.min(EDGE, last.width / 4)) return { type: 'newcol', rowId: row.id, index: cols.length }
  for (let j = 0; j < cols.length; j++) {
    const col = cols[j]
    if (x > col.rect.right) {
      const next = cols[j + 1]
      if (!next) return { type: 'newcol', rowId: row.id, index: cols.length }
      if (x < next.rect.left) return { type: 'newcol', rowId: row.id, index: j + 1 }
      continue
    }
    return inCol(col, x, y)
  }
  return { type: 'newcol', rowId: row.id, index: cols.length }
}

// Sections stack vertically inside a column. Gaps between sections, the tail
// under a short column, and a thin band just inside each section's top and
// bottom edges (but still within the row's box) all mean "new stacked
// section here" — deeper inside a section means adding to that section.
const SEC_EDGE = 20
function inCol(col, x, y) {
  const secs = col.sections
  if (y < secs[0].rect.top) return { type: 'newsection', colId: col.id, index: 0 }
  for (let s = 0; s < secs.length; s++) {
    const sec = secs[s]
    if (y > sec.rect.bottom) {
      const next = secs[s + 1]
      // Past the last section = the empty tail under a short column (still
      // inside the row band, or we'd never have descended into this row).
      if (!next) return { type: 'newsection', colId: col.id, index: secs.length }
      if (y < next.rect.top) return { type: 'newsection', colId: col.id, index: s + 1 }
      continue
    }
    const edge = Math.min(SEC_EDGE, sec.rect.height / 5)
    if (y < sec.rect.top + edge) return { type: 'newsection', colId: col.id, index: s }
    if (y > sec.rect.bottom - edge) return { type: 'newsection', colId: col.id, index: s + 1 }
    return inSection(col, sec, x, y)
  }
  return { type: 'newsection', colId: col.id, index: secs.length }
}

function inSection(col, sec, x, y) {
  const lines = sec.lines
  if (y < lines[0].rect.top) return { type: 'newline', sectionId: sec.id, index: 0 }
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k]
    if (y > line.rect.bottom) {
      const next = lines[k + 1]
      if (!next) return { type: 'newline', sectionId: sec.id, index: lines.length }
      if (y < next.rect.top) return { type: 'newline', sectionId: sec.id, index: k + 1 }
      continue
    }
    return inLine(col, sec, k, line, x, y)
  }
  return { type: 'newline', sectionId: sec.id, index: lines.length }
}

function inLine(col, sec, k, line, x, y) {
  const ws = line.widgets
  if (x < ws[0].rect.left) return { type: 'beside', lineId: line.id, index: 0 }
  for (let m = 0; m < ws.length; m++) {
    const w = ws[m]
    if (x > w.rect.right) {
      const next = ws[m + 1]
      if (!next) return { type: 'beside', lineId: line.id, index: ws.length }
      if (x < next.rect.left) return { type: 'beside', lineId: line.id, index: m + 1 }
      continue
    }
    if (w.excluded) return { type: 'none' }
    // Nearest-edge diagonal partition, normalized so the four triangular
    // zones meet at the true corners regardless of the widget's aspect ratio.
    const u = (x - w.rect.left) / (w.rect.width || 1)
    const v = (y - w.rect.top) / (w.rect.height || 1)
    // Entirely below this widget: the dead space a shorter widget leaves in
    // the line. Stack the drop directly under it — offered only when the
    // structure supports the column split (single-section column, single-line
    // section, side-by-side widgets) and the gap is a real target, not a
    // sliver; otherwise it stays what it always was, a new full-width line.
    if (v > 1) {
      if (col.sections.length === 1 && sec.lines.length === 1 && ws.length >= 2
        && line.rect.bottom - w.rect.bottom >= 24) return { type: 'stack', lineId: line.id, index: m }
      return { type: 'newline', sectionId: sec.id, index: k + 1 }
    }
    const min = Math.min(u, 1 - u, v, 1 - v)
    if (min === u) return { type: 'beside', lineId: line.id, index: m }
    if (min === 1 - u) return { type: 'beside', lineId: line.id, index: m + 1 }
    if (min === v) return { type: 'newline', sectionId: sec.id, index: k }
    return { type: 'newline', sectionId: sec.id, index: k + 1 }
  }
  return { type: 'beside', lineId: line.id, index: ws.length }
}

// Row reordering: slabs split at row centers — cursor above row i's center
// drops the dragged row at index i; past the last center appends.
export function resolveRowTarget(snap, y) {
  const rows = snap.rows
  for (let i = 0; i < rows.length; i++) {
    if (y < (rows[i].rect.top + rows[i].rect.bottom) / 2) return { index: i }
  }
  return { index: rows.length }
}
