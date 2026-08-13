// Click-to-enlarge modal for any bar/line chart (the generic `graph` widget,
// gym's strength graph, sleep's hours/debt graphs) — same barChart/lineChart
// functions as the inline widget, just drawn bigger, plus a floating tooltip
// that follows the cursor and reads the hovered datum's value/label off the
// data-v/data-l attributes chart.js now stamps on every bar/dot/hit-rect (see
// chart.js's hitTargets). No pan/zoom — "everything renders bigger" + hover,
// per Chancellor.
//
// Builds its own overlay rather than importing renderer.js's private
// openModal: reusing the SAME #app-modal/.modal-overlay/.modal/.modal__title/
// .modal__body markup+CSS contract IS the existing pattern for a plugin
// module opening a modal from outside renderer.js (see gymui.js's
// openExerciseModal) — importing across renderer.js↔view.js would also be a
// real circular import (renderer.js already imports view.js, which imports
// this module).
import { barChart, lineChart } from './chart.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Pure: "<label>: <value>" (or just the value, for the render-callback charts
// that don't stamp a label) with the value re-rounded to 2dp so float noise
// (83.399999999999991) never reaches the tooltip. Node-testable — see
// tests/chartmodal.check.mjs.
export function tooltipText(rawValue, rawLabel) {
  const n = Number(rawValue)
  const value = Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(rawValue ?? '')
  return rawLabel ? `${rawLabel}: ${value}` : value
}

// Pure: where to place a tw×th tooltip near the cursor (cx,cy) without
// spilling past a vw×vh viewport. Node-testable, no DOM.
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
export function clampTooltipPos(cx, cy, tw, th, vw, vh, margin = 12, offset = 14) {
  return {
    x: clamp(cx + offset, margin, Math.max(margin, vw - tw - margin)),
    y: clamp(cy + offset, margin, Math.max(margin, vh - th - margin)),
  }
}

// spec: either { title, kind:'bar'|'line', points, xLabel, yLabel } (the
// generic graph widget) or { title, render: (w,h) => svgOrHTML } (gym/sleep,
// whose SVG functions already take a size and own their data source).
export function openChartModal(spec) {
  document.getElementById('app-modal')?.remove()
  const o = document.createElement('div')
  o.className = 'modal-overlay'
  o.id = 'app-modal'
  o.innerHTML = `<div class="modal modal--chart" role="dialog" aria-modal="true">
    <h2 class="modal__title">${esc(spec.title || 'Chart')}</h2>
    <div class="modal__body">
      <div class="chart-mount chart-modal-mount"></div>
    </div>
  </div>`
  document.body.appendChild(o)

  const mount = o.querySelector('.chart-modal-mount')
  const tip = document.createElement('div')
  tip.className = 'chart-tooltip'
  tip.hidden = true
  document.body.appendChild(tip)

  // No eager draw call: ResizeObserver guarantees one initial callback with
  // the box's current size (same reliance as view.js's observeCharts), which
  // also means the redraw-on-window-resize case is covered for free.
  const draw = () => {
    const w = Math.max(1, Math.round(mount.clientWidth))
    const h = Math.max(1, Math.round(mount.clientHeight))
    mount.innerHTML = spec.render
      ? spec.render(w, h)
      : (spec.kind === 'line' ? lineChart : barChart)(spec.points, { w, h, xLabel: spec.xLabel, yLabel: spec.yLabel })
  }
  const ro = new ResizeObserver(draw)
  ro.observe(mount)

  const hideTip = () => { tip.hidden = true }
  const onMove = (e) => {
    const hit = e.target.closest?.('[data-v]')
    if (!hit) return hideTip()
    tip.textContent = tooltipText(hit.dataset.v, hit.dataset.l)
    tip.hidden = false
    // measure after the text is set (offsetWidth/Height reflect this frame's content)
    const pos = clampTooltipPos(e.clientX, e.clientY, tip.offsetWidth, tip.offsetHeight, window.innerWidth, window.innerHeight)
    tip.style.left = `${pos.x}px`
    tip.style.top = `${pos.y}px`
  }
  mount.addEventListener('mousemove', onMove)
  mount.addEventListener('mouseleave', hideTip)

  const close = () => {
    ro.disconnect()
    o.remove()
    tip.remove()
    document.removeEventListener('keydown', onKey)
  }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  o.addEventListener('click', (e) => { if (e.target === o) close() })
  document.addEventListener('keydown', onKey)
}
