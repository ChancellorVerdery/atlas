// Customize mode: palette (drag sources), drag-and-drop placement with a live
// ghost preview + FLIP-animated shifting, inline content editing, widget
// delete, and row reordering. All mutations go through model.js and persist
// immediately (live-save); rerender() is the app's render().
//
// All drags are same-document, so a module-level dragState carries the
// payload — no MIME sniffing. One setData() call remains because Firefox
// won't start a drag with an empty data store.

import { loadPage, savePage, newWidget, findWidget, findSection, insertWidget, moveWidget, moveRow, removeWidget, setColWidths, setRowWidth, setRowHeight } from './model.js'
import { snapshotZones, toLayoutPoint, resolveTarget, resolveRowTarget } from './hitzones.js'
import { isKindEnabled } from './plugins.js'
import { drawChart, fixAccentSubscript } from './view.js'

let ctx = null       // { rerender, contentEl, paletteEl }
let dragState = null // { source:'palette'|'widget'|'row', kind?, widgetId?, rowId?, snapshot, target, lastSig, rafPending }
let ghost = null     // the single reused .drop-ghost element

// Widget kinds carry their plugin (palette category) — the dev/test widgets
// only appear in the palette when Dev mode is on (Settings).
const KIND_META = {
  card: { label: 'Card', hint: 'Title + text', plugin: 'Developer', dev: true },
  list: { label: 'List', hint: 'Bulleted items', plugin: 'Developer', dev: true },
  graph: { label: 'Graph', hint: 'Bar or line chart', plugin: 'Developer', dev: true },
  eqcard: { label: 'Equation', hint: 'Name + LaTeX equation', plugin: 'Equations' },
  eqlist: { label: 'Equation list', hint: 'Named equations', plugin: 'Equations' },
  gymcurrent: { label: 'Current workout', hint: 'Today\'s session + set logging', plugin: 'Gym' },
  gymnext: { label: 'Upcoming workout', hint: 'What\'s next in your plan', plugin: 'Gym' },
  gymscore: { label: 'Strength score', hint: 'Average progress index', plugin: 'Gym' },
  gymscoregraph: { label: 'Strength graph', hint: 'Score over time', plugin: 'Gym' },
  gymexercises: { label: 'Exercise list', hint: 'All exercises + history', plugin: 'Gym' },
  gymvolume: { label: 'Weekly volume', hint: 'Work done this week', plugin: 'Gym' },
  calagenda: { label: 'Upcoming events', hint: 'Next two weeks, view-only', plugin: 'Calendar' },
  calmonth: { label: 'Mini calendar', hint: 'This month at a glance, view-only', plugin: 'Calendar' },
  cvgradebook: { label: 'Gradebook', hint: 'Grades by category with weights', plugin: 'Canvas' },
  cvupcoming: { label: 'Upcoming assignments', hint: 'What\'s due, filter by class', plugin: 'Canvas' },
  cvannounce: { label: 'Announcements', hint: 'Course news, filter by class', plugin: 'Canvas' },
  cvoverdue: { label: 'Overdue', hint: 'Unsubmitted past-due, dismissible', plugin: 'Canvas' },
  cvgpa: { label: 'GPA', hint: 'Overall + this semester', plugin: 'Canvas' },
  cvsemesters: { label: 'Semesters', hint: 'GPA history by term', plugin: 'Canvas' },
  cvcourses: { label: 'Course cards', hint: 'Every course grade at a glance', plugin: 'Canvas' },
  cvtodo: { label: 'To-do', hint: 'Canvas to-do items', plugin: 'Canvas' },
  wkincome: { label: 'Income', hint: 'Earnings — week, month, year, all time', plugin: 'Work' },
  wkshifts: { label: 'Shift log', hint: 'Add shifts, clock out, last 3', plugin: 'Work' },
  wkhistory: { label: 'Shift history', hint: 'Every past shift, 10 per page', plugin: 'Work' },
  wktipshare: { label: 'Tip share', hint: 'Split a tip pool by hours', plugin: 'Work' },
  wkupcoming: { label: 'Upcoming shifts', hint: 'Scheduled shifts, pushed to their own calendar', plugin: 'Work' },
  slbedtime: { label: 'Tonight\'s bedtime', hint: 'Bedtime + wake time, debt-adjusted', plugin: 'Sleep' },
  sllog: { label: 'Sleep log', hint: 'Log nights and naps, with quality', plugin: 'Sleep' },
  slhours: { label: 'Hours per night', hint: 'Night sleep vs your goal, charted', plugin: 'Sleep' },
  sldebt: { label: 'Sleep debt', hint: 'Rolling debt over your window, charted', plugin: 'Sleep' },
}

// The page currently being customized (its storage, not the default's).
const pageNow = () => loadPage(ctx.pageDef.storageKey)

export function enterCustomize({ rerender, pageDef }) {
  if (ctx) return
  const contentEl = document.getElementById('content')
  const paletteEl = document.createElement('div')
  paletteEl.className = 'palette'
  // No Settings toggle for this since the Dev-mode row was removed — set
  // localStorage 'atlas.devMode' to '1' by hand to get the dev widgets back.
  const devMode = localStorage.getItem('atlas.devMode') === '1'
  // dev widgets need dev mode; plugin widgets need their plugin enabled
  const kinds = pageDef.kinds.filter((k) => (!KIND_META[k].dev || devMode) && isKindEnabled(k))
  const groups = []
  for (const k of kinds) {
    let g = groups.find((x) => x.name === KIND_META[k].plugin)
    if (!g) groups.push(g = { name: KIND_META[k].plugin, kinds: [] })
    g.kinds.push(k)
  }
  paletteEl.innerHTML = `<p class="palette__head">Widgets</p>` + groups.map((g) =>
    `<p class="palette__cat">${g.name}</p>` + g.kinds.map((kind) =>
      `<div class="palette__item" draggable="true" data-kind="${kind}">
        <span class="palette__label">${KIND_META[kind].label}</span><span class="palette__hint">${KIND_META[kind].hint}</span>
      </div>`
    ).join('')
  ).join('')
  document.querySelector('.sidebar')?.appendChild(paletteEl)
  ctx = { rerender, contentEl, paletteEl, pageDef }

  document.addEventListener('dragstart', onDragStart)
  document.addEventListener('dragend', onDragEnd)
  contentEl.addEventListener('dragenter', onDragEnter)
  contentEl.addEventListener('dragover', onDragOver)
  contentEl.addEventListener('drop', onDrop)
  contentEl.addEventListener('dragleave', onDragLeave)
  contentEl.addEventListener('input', onInput)
  contentEl.addEventListener('change', onChange) // math-field fires 'change' on blur
  contentEl.addEventListener('click', onClick)
  contentEl.addEventListener('mousedown', onMouseDown)
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', onResizeUp)
}

export function exitCustomize() {
  if (!ctx) return
  document.removeEventListener('dragstart', onDragStart)
  document.removeEventListener('dragend', onDragEnd)
  ctx.contentEl.removeEventListener('dragenter', onDragEnter)
  ctx.contentEl.removeEventListener('dragover', onDragOver)
  ctx.contentEl.removeEventListener('drop', onDrop)
  ctx.contentEl.removeEventListener('dragleave', onDragLeave)
  ctx.contentEl.removeEventListener('input', onInput)
  ctx.contentEl.removeEventListener('change', onChange)
  ctx.contentEl.removeEventListener('click', onClick)
  ctx.contentEl.removeEventListener('mousedown', onMouseDown)
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', onResizeUp)
  document.body.classList.remove('resizing-col', 'resizing-row', 'eq-reordering')
  eqDrag = null
  ctx.paletteEl.remove()
  clearPreview()
  stopAutoScroll()
  dragState = null
  resizeState = null
  ctx = null
}

// ---- drag and drop --------------------------------------------------------

// Text selection inside an edit field must not start a widget drag.
function onMouseDown(e) {
  if (e.target.closest('.pcol-resize')) { onColResizeDown(e); return }
  if (e.target.closest('.prow-resize')) { onRowResizeDown(e); return }
  if (e.target.closest('.prow-hresize')) { onRowHResizeDown(e); return }
  if (e.target.closest('.pw-eq-grip')) { onEqGripDown(e); return }
  const widgetEl = e.target.closest('.pwidget')
  if (widgetEl) widgetEl.draggable = !e.target.closest('input,textarea,select,button,math-field')
}

// ---- equation-list reorder: grab a row's grip, slide it vertically; the
// displaced rows FLIP out of the way (plain mouse events, like the resizes) --

let eqDrag = null // { rowEl, article, sourceId, srcIndex, eqIds, grabDY, staticTop }

function onEqGripDown(e) {
  const rowEl = e.target.closest('.pw-eq-row')
  const article = rowEl?.closest('.pwidget')
  if (!rowEl || !article) return
  e.preventDefault() // also stops the widget's native HTML5 drag from starting
  // Which widgets on the page are equation lists? Only those are drop targets
  // when moving a row between lists. Layout is stable during a drag, so cache it.
  const page = pageNow()
  const eqIds = new Set([...document.querySelectorAll('.pwidget[data-widget-id]')]
    .map((a) => a.dataset.widgetId)
    .filter((id) => findWidget(page, id)?.widget.kind === 'eqlist'))
  eqDrag = {
    rowEl, article,          // article = the list the row currently lives in (mutates on cross)
    sourceId: article.dataset.widgetId,
    srcIndex: Number(rowEl.dataset.index),
    eqIds,
    grabDY: e.clientY - rowEl.getBoundingClientRect().top, // cursor offset within the row
    staticTop: rowEl.getBoundingClientRect().top,          // row's layout position sans transform
  }
  rowEl.classList.add('is-eq-dragging')
  document.body.classList.add('eq-reordering')
}

function eqDragMove(e) {
  const s = eqDrag
  // Crossed into a different equation list? Adopt the row into it, then let the
  // slotting below place it at the cursor. (is-eq-dragging is pointer-events:none
  // so elementFromPoint reports the list under the cursor, not the row itself.)
  const overArt = document.elementFromPoint(e.clientX, e.clientY)?.closest('.pwidget[data-widget-id]')
  if (overArt && overArt !== s.article && s.eqIds.has(overArt.dataset.widgetId)) {
    s.rowEl.style.transform = ''
    overArt.insertBefore(s.rowEl, overArt.querySelector(':scope > .pw-add-item') || null)
    s.article = overArt
    s.staticTop = s.rowEl.getBoundingClientRect().top
  }
  const desiredTop = e.clientY - s.grabDY
  const rows = [...s.article.querySelectorAll(':scope > .pw-eq-row')]
  // Should the dragged row change slots? Compare the cursor against the other
  // rows' live midpoints (their mid-animation rects give natural hysteresis).
  const over = rows.find((r) => {
    if (r === s.rowEl) return false
    const rc = r.getBoundingClientRect()
    return e.clientY >= rc.top && e.clientY <= rc.bottom
  })
  if (over) {
    const rc = over.getBoundingClientRect()
    const ref = e.clientY > rc.top + rc.height / 2 ? over.nextElementSibling : over
    if (ref !== s.rowEl && ref !== s.rowEl.nextElementSibling) {
      // FLIP the others: capture, reorder the DOM, invert, play.
      const others = rows.filter((r) => r !== s.rowEl)
      const first = new Map(others.map((r) => [r, r.getBoundingClientRect().top]))
      s.rowEl.style.transform = '' // static, so the post-move measure is honest
      s.article.insertBefore(s.rowEl, ref)
      s.staticTop = s.rowEl.getBoundingClientRect().top
      for (const r of others) {
        const d = first.get(r) - r.getBoundingClientRect().top
        if (!d) continue
        r.style.transition = 'none'
        r.style.transform = `translateY(${d}px)`
        requestAnimationFrame(() => { r.style.transition = 'transform 0.18s ease'; r.style.transform = '' })
      }
    }
  }
  s.rowEl.style.transform = `translateY(${desiredTop - s.staticTop}px)` // follow the cursor
}

function eqDragUp() {
  const s = eqDrag
  eqDrag = null
  s.rowEl.classList.remove('is-eq-dragging')
  document.body.classList.remove('eq-reordering')
  const page = pageNow()
  const targetId = s.article.dataset.widgetId
  if (targetId === s.sourceId) {
    // same list — reorder by the rows' original indexes (existing behavior)
    const order = [...s.article.querySelectorAll(':scope > .pw-eq-row')].map((r) => Number(r.dataset.index))
    const f = findWidget(page, s.sourceId)
    if (f) { const items = f.widget.items; f.widget.items = order.map((i) => items[i]); savePage(page) }
  } else {
    // moved to another list — pull the item from the source, drop it in the
    // target at the row's landed DOM position.
    const src = findWidget(page, s.sourceId), tgt = findWidget(page, targetId)
    const at = [...s.article.querySelectorAll(':scope > .pw-eq-row')].indexOf(s.rowEl)
    if (src && tgt) {
      const [item] = src.widget.items.splice(s.srcIndex, 1)
      if (item !== undefined) {
        tgt.widget.items.splice(at < 0 ? tgt.widget.items.length : at, 0, item)
        savePage(page)
      }
    }
  }
  ctx.rerender() // clean slate: fresh indexes, no leftover transforms
}

// ---- width resize: sections within a row, and whole rows against the page
// (plain mouse events, independent of the DnD) --------------------------------

let resizeState = null // kind 'col':  { bar, leftEl, rightEl, leftId, rightId, startX, leftW, pairW, G, gL? }
                       // kind 'row':  { bar, rowEl, rowId, startX, startW, rootW, pct? }
                       // kind 'rowh': { bar, rowEl, rowId, startY, startH, poolH, h? }
const SNAP_FRACTIONS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4]
const SNAP_PX = 26      // strong catch radius, matches what fraction snapping used before
const COL_MIN_PX = 110
const ROW_MIN_PX = 220
const ROW_MIN_H_PX = 120

const growOf = (el) => { const g = parseFloat(el.style.flexGrow); return g > 0 ? g : 1 }

// Snap a px value to quarters/thirds/halves of a pool width (plus any extra
// candidates, e.g. the full pool). Returns the snapped-or-raw value.
function snapPx(raw, pool, extra = []) {
  let best = null
  for (const cand of [...SNAP_FRACTIONS.map((f) => pool * f), ...extra]) {
    const d = Math.abs(raw - cand)
    if (d < SNAP_PX && (!best || d < best.d)) best = { cand, d }
  }
  return best ? best.cand : raw
}

function onColResizeDown(e) {
  const bar = e.target.closest('.pcol-resize')
  const leftEl = ctx.contentEl.querySelector(`.pcol[data-col-id="${bar.dataset.leftCol}"]`)
  const rightEl = ctx.contentEl.querySelector(`.pcol[data-col-id="${bar.dataset.rightCol}"]`)
  if (!leftEl || !rightEl) return
  e.preventDefault() // no text selection mid-drag
  const lw = leftEl.getBoundingClientRect().width
  resizeState = {
    kind: 'col', bar, leftEl, rightEl,
    leftId: bar.dataset.leftCol, rightId: bar.dataset.rightCol,
    startX: e.clientX, leftW: lw, pairW: lw + rightEl.getBoundingClientRect().width,
    G: growOf(leftEl) + growOf(rightEl), // the pair's combined share stays fixed — siblings are unaffected
  }
  bar.classList.add('is-resizing')
  document.body.classList.add('resizing-col')
}

function onRowResizeDown(e) {
  const bar = e.target.closest('.prow-resize')
  const rowEl = bar.closest('.prow')
  const root = ctx.contentEl.querySelector('.page-root')
  if (!rowEl || !root) return
  e.preventDefault()
  resizeState = {
    kind: 'row', bar, rowEl, rowId: rowEl.dataset.rowId,
    startX: e.clientX,
    startW: rowEl.getBoundingClientRect().width,
    rootW: root.getBoundingClientRect().width,
  }
  bar.classList.add('is-resizing')
  document.body.classList.add('resizing-col')
}

function onRowHResizeDown(e) {
  const bar = e.target.closest('.prow-hresize')
  const rowEl = bar.closest('.prow')
  if (!rowEl) return
  e.preventDefault()
  const cs = getComputedStyle(ctx.contentEl)
  resizeState = {
    kind: 'rowh', bar, rowEl, rowId: rowEl.dataset.rowId,
    startY: e.clientY, lastY: e.clientY,
    startH: rowEl.getBoundingClientRect().height,
    // fraction pool = the content area's visible height (its padding removed)
    poolH: ctx.contentEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
    autoGrow: 0,   // extra height accumulated while auto-scrolling at the edge
    scrollStep: 0, // current px/frame the auto-scroller advances
  }
  bar.classList.add('is-resizing')
  document.body.classList.add('resizing-row')
}

// min-height, not height: dragging below the content's natural size just
// parks the floor there — nothing ever clips. Snaps against the visible
// content height, so 1/2 means "half the viewport's content area" — except
// while auto-scrolling, where a snap plateau would stall the steady growth.
function applyRowH(s) {
  const raw = s.startH + (s.lastY - s.startY) + s.autoGrow
  s.h = Math.round(Math.max(ROW_MIN_H_PX, s.scrollStep > 0 ? raw : snapPx(raw, s.poolH)))
  s.rowEl.style.minHeight = `${s.h}px`
}

// ---- auto-scroll: holding a height drag near the content's bottom edge
// keeps growing the row past the current viewport ----------------------------

const SCROLL_EDGE = 48     // px band above #content's bottom that engages it
const SCROLL_MAX_STEP = 18 // px/frame at the very edge
let autoScrollRAF = 0

function updateAutoScroll() {
  const s = resizeState
  if (!s || s.kind !== 'rowh' || !ctx) { stopAutoScroll(); return }
  const bottom = ctx.contentEl.getBoundingClientRect().bottom
  const over = s.lastY - (bottom - SCROLL_EDGE)
  s.scrollStep = over > 0 ? Math.min(SCROLL_MAX_STEP, (over / SCROLL_EDGE) * SCROLL_MAX_STEP) : 0
  if (s.scrollStep > 0) startAutoScroll()
  else stopAutoScroll()
}

function autoScrollTick() {
  const s = resizeState
  if (!s || !s.scrollStep || !ctx) { autoScrollRAF = 0; return }
  // Grow first (adds scrollHeight), then scroll — at the bottom there'd
  // otherwise be nothing to scroll into and the loop would stall.
  s.autoGrow += s.scrollStep
  applyRowH(s)
  ctx.contentEl.scrollTop += s.scrollStep
  autoScrollRAF = requestAnimationFrame(autoScrollTick)
}
function startAutoScroll() { if (!autoScrollRAF) autoScrollRAF = requestAnimationFrame(autoScrollTick) }
function stopAutoScroll() { if (autoScrollRAF) { cancelAnimationFrame(autoScrollRAF); autoScrollRAF = 0 } }

function onResizeMove(e) {
  if (eqDrag) { eqDragMove(e); return }
  const s = resizeState
  if (!s) return
  if (s.kind === 'rowh') {
    s.lastY = e.clientY
    applyRowH(s)
    updateAutoScroll()
    return
  }
  if (s.kind === 'col') {
    // Snap to fractions of the PAIR's combined width (never the page): with
    // two columns in a row that reads as fractions of the row.
    let leftPx = snapPx(s.leftW + (e.clientX - s.startX), s.pairW)
    const min = Math.min(COL_MIN_PX, s.pairW * 0.2)
    leftPx = Math.max(min, Math.min(s.pairW - min, leftPx))
    s.gL = s.G * (leftPx / s.pairW)
    s.leftEl.style.flex = `${s.gL} 1 0%`
    s.rightEl.style.flex = `${s.G - s.gL} 1 0%`
  } else {
    // Whole row against the page: fractions of the page content width, plus
    // a snap back to full width.
    let w = snapPx(s.startW + (e.clientX - s.startX), s.rootW, [s.rootW])
    w = Math.max(Math.min(ROW_MIN_PX, s.rootW * 0.2), Math.min(s.rootW, w))
    s.pct = (w / s.rootW) * 100
    s.rowEl.style.width = s.pct >= 99.95 ? '' : `${w}px`
  }
}

function onResizeUp() {
  if (eqDrag) { eqDragUp(); return }
  const s = resizeState
  if (!s) return
  stopAutoScroll()
  resizeState = null
  s.bar.classList.remove('is-resizing')
  document.body.classList.remove('resizing-col', 'resizing-row')
  const page = pageNow()
  if (s.kind === 'col') {
    if (s.gL == null) return // click without movement
    const r3 = (n) => Math.round(n * 1000) / 1000
    setColWidths(page, { [s.leftId]: r3(s.gL), [s.rightId]: r3(s.G - s.gL) })
  } else if (s.kind === 'row') {
    if (s.pct == null) return
    setRowWidth(page, s.rowId, s.pct >= 99.95 ? 100 : Math.round(s.pct * 10) / 10)
  } else {
    if (s.h == null) return
    setRowHeight(page, s.rowId, s.h)
  }
  ctx.rerender()
}

function onDragStart(e) {
  if (!ctx) return
  // A selection drag out of an edit field targets an element inside the
  // widget; it must never be mistaken for a widget drag (and leaving
  // dragState null lets the browser's native text drop proceed untouched).
  if (e.target.closest?.('input,textarea,select,math-field')) return
  const pal = e.target.closest?.('.palette__item')
  const handle = e.target.closest?.('.prow-handle')
  const widgetEl = !pal && !handle && e.target.closest?.('.pwidget')
  if (pal) dragState = { source: 'palette', kind: pal.dataset.kind }
  else if (handle) dragState = { source: 'row', rowId: handle.closest('.prow')?.dataset.rowId }
  else if (widgetEl && ctx.contentEl.contains(widgetEl)) dragState = { source: 'widget', widgetId: widgetEl.dataset.widgetId }
  else return
  dragState.snapshot = snapshotZones(ctx.contentEl, pageNow(), { excludeWidgetId: dragState.widgetId })
  dragState.depth = 0 // dragenter/dragleave nesting inside #content
  e.dataTransfer.setData('application/x-atlas', '')
  e.dataTransfer.effectAllowed = dragState.source === 'palette' ? 'copy' : 'move'
  // Dim after this frame, so the browser's drag image is captured undimmed.
  const dimEl = dragState.source === 'widget' ? widgetEl : dragState.source === 'row' ? handle.closest('.prow') : null
  if (dimEl) requestAnimationFrame(() => dimEl.classList.add('is-dragging'))
}

// Cancelling dragenter is REQUIRED, not optional: placing the ghost can put a
// new element (e.g. an expanded .page-root) under a stationary cursor, and
// Chromium fires dragenter on it but no further dragover until the mouse
// moves — if that dragenter isn't cancelled, the pending drop dies and
// mouseup ends the drag with no drop event at all.
function onDragEnter(e) {
  if (!dragState || !ctx) return
  e.preventDefault()
  dragState.depth++
}

function onDragLeave() {
  if (!dragState || !ctx) return
  // dragenter (new el) fires before dragleave (old el), so the pairs balance
  // while moving within #content; hitting zero means the cursor truly left.
  if (--dragState.depth > 0) return
  dragState.depth = 0
  dragState.outside = true // parks any already-scheduled placement rAF
  dragState.lastSig = null
  dragState.lastTarget = null
  flip(ctx.contentEl, clearPreview)
}

// Band ghosts only: inserting a new-line/new-row band shifts everything
// below it, so chasing the visible band resolves (in frozen snapshot space)
// to a different target and the band jumps away — hold while inside it.
// Beside/column ghosts don't get this: they replace the space the cursor was
// already in (snapshot resolution stays stable there), and being equal-share
// wide, holding them would make half the row sticky.
function cursorInGhost(clientX, clientY) {
  if (!ghost?.isConnected || !ghost.classList.contains('drop-ghost--band')) return false
  const r = ghost.getBoundingClientRect()
  return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom
}

function onDragOver(e) {
  if (!dragState || !ctx) return
  e.preventDefault()
  e.dataTransfer.dropEffect = dragState.source === 'palette' ? 'copy' : 'move'
  dragState.outside = false
  // Hysteresis: the ghost reflows the live page while zones stay frozen at
  // the dragstart snapshot, so chasing the visible ghost would resolve to a
  // different target and yank it away. While the cursor is inside the live
  // ghost, the preview is already showing exactly what a drop will do — hold.
  if (cursorInGhost(e.clientX, e.clientY)) return
  // Coalesce, don't drop: always record the newest coords — a burst of
  // dragovers within one frame must end with the LAST position processed,
  // or the preview freezes wherever the first event of the burst was.
  dragState.pendingX = e.clientX
  dragState.pendingY = e.clientY
  if (dragState.rafPending) return
  dragState.rafPending = true
  requestAnimationFrame(() => {
    if (!dragState || !ctx) return
    dragState.rafPending = false
    if (dragState.outside) return // dragleave won the race — stay cleared
    const { x, y } = toLayoutPoint(ctx.contentEl, dragState.pendingX, dragState.pendingY)
    const target = dragState.source === 'row'
      ? { type: 'rowmove', ...resolveRowTarget(dragState.snapshot, y) }
      : resolveTarget(dragState.snapshot, x, y)
    const sig = JSON.stringify(target)
    if (sig === dragState.lastSig) return
    dragState.lastSig = sig
    dragState.lastTarget = target
    flip(ctx.contentEl, () => placeGhost(target))
  })
}

function onDrop(e) {
  if (!dragState || !ctx) return
  e.preventDefault()
  const s = dragState
  // Same hysteresis as dragover: dropping on the visible ghost commits what
  // the ghost previews. Checked before finishDrag() removes the ghost.
  const onGhost = cursorInGhost(e.clientX, e.clientY)
  finishDrag()
  let t
  if (onGhost && s.lastTarget) t = s.lastTarget
  else {
    // Resolve fresh from the actual drop point (same frozen snapshot the
    // preview used) — the last dragover's rAF may not have run yet.
    const { x, y } = toLayoutPoint(ctx.contentEl, e.clientX, e.clientY)
    t = s.source === 'row'
      ? { type: 'rowmove', ...resolveRowTarget(s.snapshot, y) }
      : resolveTarget(s.snapshot, x, y)
  }
  if (!t || t.type === 'none') return
  const page = pageNow()
  if (s.source === 'palette') insertWidget(page, newWidget(s.kind), t)
  else if (s.source === 'widget') moveWidget(page, s.widgetId, t)
  else if (s.source === 'row' && t.type === 'rowmove') moveRow(page, s.rowId, t.index)
  ctx.rerender()
}

function onDragEnd() {
  finishDrag()
}

function finishDrag() {
  clearPreview()
  ctx?.contentEl.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'))
  dragState = null
}

// ---- ghost preview --------------------------------------------------------

// The ghost is a real element inserted at the exact drop position, so the
// browser computes the true post-drop layout and existing widgets shift to
// their genuine final places. Safe from feedback loops because targeting
// reads the frozen snapshot, never the ghost-shoved live DOM.
function placeGhost(target) {
  if (!ghost) ghost = document.createElement('div')
  ghost.remove()
  ghost.className = 'drop-ghost'
  const c = ctx.contentEl
  c.querySelector('.page-empty-drop')?.classList.remove('is-over')
  if (!target || target.type === 'none') return
  if (target.type === 'beside') {
    insertAt(c.querySelector(`.pline[data-line-id="${target.lineId}"]`), '.pwidget', target.index)
  } else if (target.type === 'stack') {
    // The dead space below a short widget is already empty — the ghost is
    // positioned inside the widget (its .pwidget is position:relative), not
    // inserted in flow, so nothing shifts.
    const w = c.querySelectorAll(`.pline[data-line-id="${target.lineId}"] > .pwidget`)[target.index]
    if (!w) return
    ghost.classList.add('drop-ghost--stack')
    w.appendChild(ghost)
    return
  } else if (target.type === 'newline') {
    ghost.classList.add('drop-ghost--band')
    insertAt(c.querySelector(`.psec[data-sec-id="${target.sectionId}"]`), '.pline', target.index)
  } else if (target.type === 'newsection') {
    ghost.classList.add('drop-ghost--band')
    insertAt(c.querySelector(`.pcol[data-col-id="${target.colId}"]`), '.psec', target.index)
  } else if (target.type === 'newcol') {
    insertAt(c.querySelector(`.prow[data-row-id="${target.rowId}"] > .prow-body`), '.pcol', target.index)
  } else { // newrow | rowmove
    const empty = c.querySelector('.page-empty-drop')
    if (empty) { empty.classList.add('is-over'); return }
    ghost.classList.add('drop-ghost--band')
    insertAt(c.querySelector('.page-root'), '.prow', target.index)
  }
}

function insertAt(parent, childSel, index) {
  if (!parent) return
  const kids = parent.querySelectorAll(`:scope > ${childSel}`)
  parent.insertBefore(ghost, kids[index] || null)
}

function clearPreview() {
  ghost?.remove()
  ctx?.contentEl.querySelector('.page-empty-drop')?.classList.remove('is-over')
}

// FLIP: capture positions, mutate the DOM, then transform each moved widget
// back to where it was and let it transition to its new place — the only way
// to animate flex-layout reflow.
function flip(rootEl, mutate) {
  const els = [...rootEl.querySelectorAll('.pwidget')]
  const first = new Map(els.map((el) => [el, el.getBoundingClientRect()]))
  mutate()
  for (const [el, f] of first) {
    if (!el.isConnected) continue
    const l = el.getBoundingClientRect()
    const dx = f.left - l.left
    const dy = f.top - l.top
    if (!dx && !dy) { el.style.transform = ''; continue }
    el.style.transition = 'none'
    el.style.transform = `translate(${dx}px,${dy}px)`
    requestAnimationFrame(() => {
      el.style.transition = 'transform .18s ease'
      el.style.transform = ''
    })
  }
}

// ---- inline editing -------------------------------------------------------

// math-field fires 'change' on blur/commit — the moment to rewrite a
// stretchy-accent subscript in the live field (setting .value mid-keystroke
// would jump the caret, so onInput only stores the fixed form).
function onChange(e) {
  const mf = e.target.tagName === 'MATH-FIELD' ? e.target : null
  if (!mf || !/^(latex|itemLatex)$/.test(mf.dataset.field || '')) return
  const fixed = fixAccentSubscript(mf.value)
  if (fixed !== mf.value) mf.value = fixed
}

function onInput(e) {
  // math-field is a custom element whose bubbling input events carry LaTeX
  // in .value (typing sqrt/^/cos etc. builds the structure; we just store).
  const field = e.target.closest('.pw-field') || (e.target.tagName === 'MATH-FIELD' ? e.target : null)
  if (!field) return
  const page = pageNow()
  if (field.dataset.field === 'rowTitle') {
    const row = page.rows.find((r) => r.id === field.closest('.prow')?.dataset.rowId)
    if (!row) return
    row.title = field.value
    savePage(page) // live-save, no re-render — the input keeps focus
    return
  }
  if (field.dataset.field === 'secTitle') {
    const sec = findSection(page, field.closest('.psec')?.dataset.secId)
    if (!sec) return
    sec.title = field.value
    savePage(page)
    return
  }
  const id = field.closest('.pwidget')?.dataset.widgetId
  const f = findWidget(page, id)
  if (!f) return
  const name = field.dataset.field
  // regroup stretchy-accent subscripts so they render as normal subscripts
  // (see fixAccentSubscript); store the fixed form — the live field is set
  // back on blur, not mid-keystroke, so the caret isn't disturbed
  const latexVal = () => fixAccentSubscript(field.value)
  if (name === 'item') f.widget.items[Number(field.dataset.index)] = field.value
  else if (name === 'itemName') f.widget.items[Number(field.dataset.index)].name = field.value
  else if (name === 'itemLatex') f.widget.items[Number(field.dataset.index)].latex = latexVal()
  else if (name === 'latex') f.widget.latex = latexVal()
  else f.widget[name] = field.value
  savePage(page)
  if (f.widget.kind === 'graph' && name !== 'title') {
    drawChart(field.closest('.pwidget').querySelector('.chart-mount'))
  }
}

function onClick(e) {
  const btn = e.target.closest('[data-act]')
  if (!btn || !ctx) return
  const act = btn.dataset.act
  const id = btn.closest('.pwidget')?.dataset.widgetId
  if (!['delete-widget', 'add-item', 'remove-item'].includes(act)) return
  const page = pageNow()
  if (act === 'delete-widget') {
    removeWidget(page, id)
  } else {
    const f = findWidget(page, id)
    if (!f) return
    const items = f.widget.items
    if (act === 'add-item') items.push(f.widget.kind === 'eqlist' ? { name: 'New equation', latex: '' } : 'New item')
    else items.splice(Number(btn.dataset.index), 1)
    savePage(page)
  }
  ctx.rerender()
}
