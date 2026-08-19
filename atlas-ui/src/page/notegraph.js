// Clean graphs and tables for notes, drawn by CODE rather than by a model.
//
// A hand-drawn parabola in a photo becomes an ```atlas-graph fence holding a
// SPEC — the function, its domain, the labels — and this module plots it. That
// is the whole reason graphs are not image generation: the model is good at
// reading "h = -4.9t² + 20t" off the page and bad at drawing an accurate curve,
// while the reverse is true here. A spec also stays editable, re-themes with
// the app, scales without blurring, and diffs as text in the vault.
//
// Expressions are LaTeX and are evaluated with compute-engine — already a
// dependency (study.js uses it) and the same subs().N() idiom, so there is one
// expression evaluator in Atlas rather than two. Labels are typeset with
// mathlive, the same renderer the note prose uses, so a curve called
// "y = \sqrt{1-x^2}" prints as maths and not as source code.

import { convertLatexToMarkup } from 'mathlive' // notesui.js already imports mathlive; no new weight

const PALETTE = ['#7986cb', '#33b679', '#e67c73', '#e0b15c', '#74d6c4', '#b39ddb']
const W = 640, H = 380
const M = { top: 30, right: 20, bottom: 54, left: 64 } // room for typeset tick labels

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const finite = (x) => typeof x === 'number' && isFinite(x)

let cePromise = null
const getCE = () => (cePromise ??= import('@cortex-js/compute-engine').then((m) => new m.ComputeEngine()))

// Models write "sqrt(1-x^2)" and "cos(t)" as often as they write real LaTeX,
// and compute-engine reads the bare names as a PRODUCT of variables — s·q·r·t
// — which silently evaluates to NaN everywhere and draws an empty graph. That
// was the actual bug behind "the unit circle doesn't plot". Backslashing the
// known names is the whole fix: \sqrt(…), \abs(…) and friends all parse.
const FUNCS = 'arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|sec|csc|cot|ln|log|exp|sqrt|abs|max|min'
const CONSTS = 'pi|theta|alpha|beta|gamma|lambda|mu|omega|infty'
// \b would not fire in "2pi" (digit→letter is not a word boundary), so the
// preceding character is captured instead: a letter means it is part of a
// longer name, a backslash means it is already LaTeX. No lookbehind — Safari
// only grew it in 16.4 and a regex SyntaxError would take the whole page down.
const NAME_RE = new RegExp(`([A-Za-z\\\\]?)(${FUNCS}|${CONSTS})(?![A-Za-z])`, 'g')
export const toLatex = (s) => String(s ?? '')
  .replace(/\*\*/g, '^') // x**2 → x^2
  .replace(NAME_RE, (m, pre, name) => (pre ? m : `\\${name}`))

// Axis ticks on 1/2/5×10^n boundaries — the steps people actually label.
export function niceTicks(min, max, count = 6) {
  if (!finite(min) || !finite(max) || min === max) return [min || 0]
  const raw = (max - min) / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const norm = raw / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag
  const out = []
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) {
    out.push(Math.abs(t) < step * 1e-9 ? 0 : Number(t.toPrecision(12)))
  }
  return out
}

// Short, consistent tick text: no 0.30000000000000004, no 1e+3 for 1000.
export const fmtTick = (v) => {
  if (!finite(v)) return ''
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e5 || a < 1e-4) return v.toExponential(1).replace('e+', 'e')
  return String(Number(v.toPrecision(6)))
}

// "Mathprint" labels. A $…$ span is typeset, exactly as in note prose. On top
// of that, a bare axis name ("x", "t") or a bare number ("-2", "1.0e7") is
// maths by role, because those are the strings this module generates itself
// for ticks and axis defaults. Everything else needs its $…$ — a one-word
// prose label like "measured" must NOT typeset, or it comes out as the product
// m·e·a·s·u·r·e·d in italics.
// ponytail: angle brackets refuse to typeset (they are never maths and it
// keeps model-authored text away from raw markup); upgrade = a real sanitizer.
const BY_ROLE = /^(?:[A-Za-z]|[-+]?\d*\.?\d+(?:e-?\d+)?)$/
export function labelHTML(text, toMarkup = convertLatexToMarkup) {
  const s = String(text ?? '')
  if (!s) return ''
  const math = (l) => {
    const t = l.trim()
    if (!t || /[<>]/.test(t)) return esc(l)
    try { return toMarkup(toLatex(t), { defaultMode: 'textstyle' }) } catch { return esc(l) }
  }
  if (!s.includes('$')) return BY_ROLE.test(s) ? math(s) : esc(s)
  return s.split(/(\$[^$]+\$)/)
    .map((seg) => (seg.length > 2 && seg.startsWith('$') && seg.endsWith('$') ? math(seg.slice(1, -1)) : esc(seg)))
    .join('')
}

// Typeset text has to live in an HTML box, so labels are foreignObject rather
// than <text>. Boxes are generous and alignment is done in CSS, because the
// rendered width of a formula is not knowable from here.
const fo = (x, y, w, h, cls, html, extra = '') =>
  `<foreignObject x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"${extra}>`
  + `<div xmlns="http://www.w3.org/1999/xhtml" class="ng-fo ${cls}">${html}</div></foreignObject>`

const asMath = (s) => `$${s}$` // a derived label is maths by construction

function normCurve(c) {
  if (!c || typeof c !== 'object') return null
  // Parametric: x(t), y(t). The right primitive for "x = t²-2t, y = t+1" —
  // before this the model had to hand-tabulate points, in t order, by eye.
  if (typeof c.x === 'string' && c.x.trim() && typeof c.y === 'string' && c.y.trim()) {
    const t = Array.isArray(c.t) && c.t.length === 2 && c.t.every((n) => finite(Number(n)))
      ? [Number(c.t[0]), Number(c.t[1])].sort((a, b) => a - b)
      : [0, 2 * Math.PI] // ponytail: trig parametrics dominate; specs should state t
    return {
      kind: 'param', x: c.x.trim(), y: c.y.trim(), t,
      label: typeof c.label === 'string' ? c.label : asMath(`x=${c.x.trim()},\\ y=${c.y.trim()}`),
      arrow: c.arrow !== false, // direction of travel is the point of a parametric curve
    }
  }
  if (typeof c.latex === 'string' && c.latex.trim()) {
    return { kind: 'fn', latex: c.latex.trim(), label: typeof c.label === 'string' ? c.label : asMath(c.latex.trim()) }
  }
  return null
}

export function normalizeSpec(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const curves = (Array.isArray(s.curves) ? s.curves : []).map(normCurve).filter(Boolean).slice(0, 6)
  const series = (Array.isArray(s.series) ? s.series : [])
    .filter((d) => d && Array.isArray(d.data))
    .slice(0, 6)
    .map((d) => ({
      label: typeof d.label === 'string' ? d.label : '',
      // Accept [[x,y],…] and [{x,y},…]; anything non-numeric is dropped rather
      // than plotted at zero, which would invent a data point.
      data: d.data.map((p) => (Array.isArray(p) ? { x: Number(p[0]), y: Number(p[1]) } : { x: Number(p?.x), y: Number(p?.y) }))
        .filter((p) => finite(p.x) && finite(p.y)),
      dots: d.dots !== false,
      line: d.line !== false,
      arrow: d.arrow === true, // opt-in: only an ordered path has a direction
    }))
    .filter((d) => d.data.length)
  const points = (Array.isArray(s.points) ? s.points : [])
    .map((p) => ({ x: Number(p?.x), y: Number(p?.y), label: typeof p?.label === 'string' ? p.label : '' }))
    .filter((p) => finite(p.x) && finite(p.y))
    .slice(0, 24)
  const dom = Array.isArray(s.domain) && s.domain.length === 2 && s.domain.every((n) => finite(Number(n)))
    ? [Number(s.domain[0]), Number(s.domain[1])].sort((a, b) => a - b)
    : null
  const rng = Array.isArray(s.range) && s.range.length === 2 && s.range.every((n) => finite(Number(n)))
    ? [Number(s.range[0]), Number(s.range[1])].sort((a, b) => a - b)
    : null
  // A curve in the plane is a SHAPE: a unit circle drawn on unequal axes is an
  // ellipse, which is simply the wrong picture. So equal scaling is the default
  // once every curve is parametric, and always available explicitly.
  const allParam = curves.length > 0 && curves.every((c) => c.kind === 'param')
  return {
    title: typeof s.title === 'string' ? s.title : '',
    xLabel: typeof s.xLabel === 'string' ? s.xLabel : 'x',
    yLabel: typeof s.yLabel === 'string' ? s.yLabel : 'y',
    domain: dom, range: rng, curves, series, points,
    equal: typeof s.equal === 'boolean' ? s.equal : allParam,
    valid: !!(curves.length || series.length || points.length),
  }
}

// Sample y = f(x) across the domain. Non-finite values (poles, out-of-domain)
// come back as null so the path can BREAK there instead of drawing a vertical
// line across the plot — which is what makes 1/x and tan(x) look wrong.
async function sampleFn(latex, [x0, x1], n = 240) {
  const ce = await getCE()
  let expr
  try { expr = ce.parse(toLatex(latex)) } catch { return null }
  const pts = []
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n
    let y = null
    try {
      const v = expr.subs({ x }).N()
      const re = v?.re
      if (finite(re) && Math.abs(v?.im ?? 0) < 1e-9) y = re
    } catch { /* leave as a break */ }
    pts.push({ x, y })
  }
  return pts.some((p) => p.y != null) ? pts : null
}

// Sample (x(t), y(t)). Both coordinates move, so a break needs both nulled.
async function sampleParam(c, n = 400) {
  const ce = await getCE()
  let ex, ey
  try { ex = ce.parse(toLatex(c.x)); ey = ce.parse(toLatex(c.y)) } catch { return null }
  const real = (v) => (finite(v?.re) && Math.abs(v?.im ?? 0) < 1e-9 ? v.re : null)
  const [t0, t1] = c.t
  const pts = []
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n
    let x = null, y = null
    try { x = real(ex.subs({ t }).N()); y = real(ey.subs({ t }).N()) } catch { /* break */ }
    pts.push(x == null || y == null ? { x: null, y: null } : { x, y })
  }
  return pts.some((p) => p.x != null) ? pts : null
}

const pad = (lo, hi) => {
  if (lo === hi) return [lo - 1, hi + 1]
  const p = (hi - lo) * 0.08
  return [lo - p, hi + p]
}

// A pole sends one sample to 1e17 and flattens everything else into a line, so
// choose the window from the central 96% of the values rather than the extremes.
function window96(values) {
  const sorted = values.filter(finite).sort((a, b) => a - b)
  if (!sorted.length) return null
  return [sorted[Math.floor(sorted.length * 0.02)], sorted[Math.ceil(sorted.length * 0.98) - 1]]
}

export async function buildPlot(rawSpec) {
  const spec = normalizeSpec(rawSpec)
  if (!spec.valid) return null

  // Parametric curves carry their own x values, so they are sampled BEFORE the
  // domain is chosen and then feed into it.
  const curves = []
  for (const c of spec.curves) {
    if (c.kind !== 'param') continue
    const pts = await sampleParam(c)
    if (pts) curves.push({ ...c, pts })
  }

  let domain = spec.domain
  if (!domain) {
    const xs = [
      ...spec.series.flatMap((d) => d.data.map((p) => p.x)),
      ...spec.points.map((p) => p.x),
      ...curves.flatMap((c) => c.pts.map((p) => p.x).filter((x) => x != null)),
    ]
    const w = window96(xs)
    domain = w ? pad(w[0], w[1]) : [-10, 10]
  }

  for (const c of spec.curves) {
    if (c.kind !== 'fn') continue
    const pts = await sampleFn(c.latex, domain)
    if (pts) curves.push({ ...c, pts })
  }
  if (!curves.length && !spec.series.length && !spec.points.length) return null

  let range = spec.range
  if (!range) {
    const w = window96([
      ...curves.flatMap((c) => c.pts.map((p) => p.y).filter((y) => y != null)),
      ...spec.series.flatMap((d) => d.data.map((p) => p.y)),
      ...spec.points.map((p) => p.y),
    ])
    if (!w) return null
    const [lo, hi] = w
    range = pad(lo > 0 ? 0 : lo, hi) // a curve sitting entirely above zero still shows its baseline
  }

  if (spec.equal) [domain, range] = equalize(domain, range)
  return { spec, domain, range, curves }
}

// Make one unit of x as long as one unit of y by GROWING the tighter axis —
// never shrinking, so nothing already in view is pushed out.
function equalize([x0, x1], [y0, y1]) {
  const pw = W - M.left - M.right, ph = H - M.top - M.bottom
  const ux = (x1 - x0) / pw, uy = (y1 - y0) / ph
  if (!finite(ux) || !finite(uy) || ux <= 0 || uy <= 0) return [[x0, x1], [y0, y1]]
  const u = Math.max(ux, uy)
  const grow = ([a, b], span) => {
    const c = (a + b) / 2
    return [c - span / 2, c + span / 2]
  }
  return [grow([x0, x1], u * pw), grow([y0, y1], u * ph)]
}

export async function graphSVG(rawSpec) {
  const plot = await buildPlot(rawSpec)
  if (!plot) return null
  const { spec, domain, range, curves } = plot
  const [x0, x1] = domain, [y0, y1] = range
  const pw = W - M.left - M.right, ph = H - M.top - M.bottom
  const sx = (x) => M.left + ((x - x0) / (x1 - x0 || 1)) * pw
  const sy = (y) => M.top + ph - ((y - y0) / (y1 - y0 || 1)) * ph
  const inView = (p) => p.x != null && p.y != null
    && p.x >= x0 - (x1 - x0) && p.x <= x1 + (x1 - x0)
    && p.y >= y0 - (y1 - y0) && p.y <= y1 + (y1 - y0)

  const xt = niceTicks(x0, x1), yt = niceTicks(y0, y1)
  const grid = [
    ...xt.map((t) => `<line x1="${sx(t).toFixed(1)}" y1="${M.top}" x2="${sx(t).toFixed(1)}" y2="${M.top + ph}" class="ng-grid"/>`),
    ...yt.map((t) => `<line x1="${M.left}" y1="${sy(t).toFixed(1)}" x2="${M.left + pw}" y2="${sy(t).toFixed(1)}" class="ng-grid"/>`),
  ].join('')

  // Axes sit at zero when zero is in view, otherwise on the frame — an axis
  // drawn off-plot is worse than no axis.
  const ax = y0 <= 0 && y1 >= 0 ? sy(0) : M.top + ph
  const ay = x0 <= 0 && x1 >= 0 ? sx(0) : M.left
  const axes = `<line x1="${M.left}" y1="${ax.toFixed(1)}" x2="${M.left + pw}" y2="${ax.toFixed(1)}" class="ng-axis"/>`
    + `<line x1="${ay.toFixed(1)}" y1="${M.top}" x2="${ay.toFixed(1)}" y2="${M.top + ph}" class="ng-axis"/>`

  const ticks = [
    ...xt.map((t) => fo(sx(t) - 34, M.top + ph + 6, 68, 18, 'ng-fo--c', labelHTML(fmtTick(t)))),
    ...yt.map((t) => fo(M.left - 60, sy(t) - 9, 52, 18, 'ng-fo--r', labelHTML(fmtTick(t)))),
  ].join('')

  // Draw a polyline, breaking wherever a sample is undefined or has run far
  // outside the window (a pole would otherwise be drawn as a vertical line).
  const polyline = (pts) => {
    let d = '', pen = false
    for (const p of pts) {
      if (!inView(p)) { pen = false; continue }
      d += `${pen ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`
      pen = true
    }
    return d
  }

  // Direction of travel. ponytail: placed by sample index, not arc length —
  // fine for uniform sampling; measure arc length if a curve ever bunches up.
  const arrows = (pts, colour) => {
    const seen = pts.filter(inView)
    if (seen.length < 8) return ''
    return [0.34, 0.72].map((f) => {
      const a = seen[Math.floor(seen.length * f)], b = seen[Math.floor(seen.length * f) + 1]
      if (!a || !b) return ''
      const dx = sx(b.x) - sx(a.x), dy = sy(b.y) - sy(a.y)
      if (!dx && !dy) return ''
      const ang = (Math.atan2(dy, dx) * 180) / Math.PI
      return `<path d="M0 0 L-9 4.5 L-9 -4.5 Z" fill="${colour}" transform="translate(${sx(a.x).toFixed(1)} ${sy(a.y).toFixed(1)}) rotate(${ang.toFixed(1)})"/>`
    }).join('')
  }

  let ci = 0
  const curveSvg = curves.map((c) => {
    const colour = PALETTE[ci++ % PALETTE.length]
    const d = polyline(c.pts)
    if (!d) return ''
    return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      + (c.kind === 'param' && c.arrow ? arrows(c.pts, colour) : '')
  }).join('')

  const seriesSvg = spec.series.map((s) => {
    const colour = PALETTE[ci++ % PALETTE.length]
    const d = s.line ? polyline(s.data) : ''
    const dots = s.dots ? s.data.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${colour}"/>`).join('') : ''
    return (d ? `<path d="${d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"/>` : '')
      + (s.arrow ? arrows(s.data, colour) : '') + dots
  }).join('')

  const pointSvg = spec.points.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" class="ng-pt"/>`
    + (p.label ? fo(sx(p.x) + 7, sy(p.y) - 24, 110, 17, 'ng-fo--l', labelHTML(p.label)) : '')).join('')

  const legendItems = [...curves.map((c) => c.label), ...spec.series.map((s) => s.label)].filter(Boolean)
  const legend = legendItems.map((label, i) => {
    const colour = PALETTE[i % PALETTE.length]
    const y = M.top + 2 + i * 18
    return `<rect x="${M.left + pw - 152}" y="${y + 3}" width="10" height="10" fill="${colour}" rx="2"/>`
      + fo(M.left + pw - 138, y, 138, 16, 'ng-fo--l', labelHTML(label))
  }).join('')

  const cy = M.top + ph / 2
  return `<svg class="ng-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title || 'graph')}" xmlns="http://www.w3.org/2000/svg">`
    + (spec.title ? fo(0, 4, W, 22, 'ng-fo--title', labelHTML(spec.title)) : '')
    + grid + axes + ticks + curveSvg + seriesSvg + pointSvg + legend
    + fo(M.left, H - 24, pw, 18, 'ng-fo--c', labelHTML(spec.xLabel))
    + fo(16 - ph / 2, cy - 9, ph, 18, 'ng-fo--c', labelHTML(spec.yLabel), ` transform="rotate(-90 16 ${cy.toFixed(1)})"`)
    + `</svg>`
}

// A table spec -> a real markdown table, handed back to marked. Tables are
// NOT drawn: markdown already has them, they stay searchable and editable, and
// an image of a table is useless in a vault.
export function tableMarkdown(rawSpec) {
  const s = rawSpec && typeof rawSpec === 'object' ? rawSpec : {}
  const cols = (Array.isArray(s.columns) ? s.columns : []).map((c) => String(c ?? ''))
  const rows = (Array.isArray(s.rows) ? s.rows : []).map((r) => (Array.isArray(r) ? r : [])).map((r) => r.map((c) => String(c ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ')))
  if (!cols.length || !rows.length) return null
  const align = (Array.isArray(s.align) ? s.align : []).map((a) => (a === 'right' ? '---:' : a === 'center' ? ':---:' : '---'))
  const sep = cols.map((_, i) => align[i] || '---')
  const line = (cells) => `| ${cols.map((_, i) => cells[i] ?? '').join(' | ')} |`
  const caption = typeof s.caption === 'string' && s.caption.trim() ? `\n\n*${s.caption.trim()}*` : ''
  return [line(cols.map((c) => c.replace(/\|/g, '\\|'))), `| ${sep.join(' | ')} |`, ...rows.map(line)].join('\n') + caption
}
