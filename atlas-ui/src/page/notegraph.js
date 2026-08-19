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
// expression evaluator in Atlas rather than two.

const PALETTE = ['#7986cb', '#33b679', '#e67c73', '#e0b15c', '#74d6c4', '#b39ddb']
const W = 640, H = 380
const M = { top: 28, right: 18, bottom: 42, left: 56 }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const finite = (x) => typeof x === 'number' && isFinite(x)

let cePromise = null
const getCE = () => (cePromise ??= import('@cortex-js/compute-engine').then((m) => new m.ComputeEngine()))

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

export function normalizeSpec(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const curves = (Array.isArray(s.curves) ? s.curves : [])
    .filter((c) => c && typeof c.latex === 'string' && c.latex.trim())
    .slice(0, 6)
    .map((c) => ({ latex: c.latex.trim(), label: typeof c.label === 'string' ? c.label : c.latex.trim() }))
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
  return {
    title: typeof s.title === 'string' ? s.title : '',
    xLabel: typeof s.xLabel === 'string' ? s.xLabel : 'x',
    yLabel: typeof s.yLabel === 'string' ? s.yLabel : 'y',
    domain: dom, range: rng, curves, series, points,
    valid: !!(curves.length || series.length || points.length),
  }
}

// Sample a curve across the domain. Non-finite values (poles, out-of-domain)
// come back as null so the path can BREAK there instead of drawing a vertical
// line across the plot — which is what makes 1/x and tan(x) look wrong.
async function sampleCurve(latex, [x0, x1], n = 240) {
  const ce = await getCE()
  let expr
  try { expr = ce.parse(latex) } catch { return null }
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

const pad = (lo, hi) => {
  if (lo === hi) return [lo - 1, hi + 1]
  const p = (hi - lo) * 0.08
  return [lo - p, hi + p]
}

export async function buildPlot(rawSpec) {
  const spec = normalizeSpec(rawSpec)
  if (!spec.valid) return null

  // Domain: explicit, else the span of the data, else a sensible default.
  let domain = spec.domain
  if (!domain) {
    const xs = [...spec.series.flatMap((d) => d.data.map((p) => p.x)), ...spec.points.map((p) => p.x)]
    domain = xs.length ? pad(Math.min(...xs), Math.max(...xs)) : [-10, 10]
  }

  const curves = []
  for (const c of spec.curves) {
    const pts = await sampleCurve(c.latex, domain)
    if (pts) curves.push({ ...c, pts })
  }
  if (!curves.length && !spec.series.length && !spec.points.length) return null

  let range = spec.range
  if (!range) {
    const ys = [
      ...curves.flatMap((c) => c.pts.map((p) => p.y).filter((y) => y != null)),
      ...spec.series.flatMap((d) => d.data.map((p) => p.y)),
      ...spec.points.map((p) => p.y),
    ]
    // A pole sends one sample to 1e17 and flattens everything else into a
    // line, so clip to the central 96% before choosing the window.
    const sorted = ys.filter(finite).sort((a, b) => a - b)
    if (!sorted.length) return null
    const lo = sorted[Math.floor(sorted.length * 0.02)]
    const hi = sorted[Math.ceil(sorted.length * 0.98) - 1]
    range = pad(Math.min(lo, 0) === 0 && lo > 0 ? 0 : lo, hi)
  }
  return { spec, domain, range, curves }
}

export async function graphSVG(rawSpec) {
  const plot = await buildPlot(rawSpec)
  if (!plot) return null
  const { spec, domain, range, curves } = plot
  const [x0, x1] = domain, [y0, y1] = range
  const pw = W - M.left - M.right, ph = H - M.top - M.bottom
  const sx = (x) => M.left + ((x - x0) / (x1 - x0 || 1)) * pw
  const sy = (y) => M.top + ph - ((y - y0) / (y1 - y0 || 1)) * ph

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
    ...xt.map((t) => `<text x="${sx(t).toFixed(1)}" y="${(M.top + ph + 16).toFixed(1)}" class="ng-tick" text-anchor="middle">${esc(fmtTick(t))}</text>`),
    ...yt.map((t) => `<text x="${(M.left - 8).toFixed(1)}" y="${(sy(t) + 4).toFixed(1)}" class="ng-tick" text-anchor="end">${esc(fmtTick(t))}</text>`),
  ].join('')

  let ci = 0
  const paths = curves.map((c) => {
    const colour = PALETTE[ci++ % PALETTE.length]
    let d = '', pen = false
    for (const p of c.pts) {
      if (p.y == null || p.y < y0 - (y1 - y0) || p.y > y1 + (y1 - y0)) { pen = false; continue }
      d += `${pen ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`
      pen = true
    }
    return d ? `<path d="${d}" fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"/>` : ''
  }).join('')

  const seriesSvg = spec.series.map((s) => {
    const colour = PALETTE[ci++ % PALETTE.length]
    const d = s.data.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)} ${sy(p.y).toFixed(1)}`).join('')
    const dots = s.dots ? s.data.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${colour}"/>`).join('') : ''
    return `<path d="${d}" fill="none" stroke="${colour}" stroke-width="2"/>${dots}`
  }).join('')

  const pointSvg = spec.points.map((p) => `<circle cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4" class="ng-pt"/>`
    + (p.label ? `<text x="${(sx(p.x) + 7).toFixed(1)}" y="${(sy(p.y) - 7).toFixed(1)}" class="ng-tick">${esc(p.label)}</text>` : '')).join('')

  const legendItems = [...curves.map((c) => c.label), ...spec.series.map((s) => s.label)].filter(Boolean)
  const legend = legendItems.map((label, i) => {
    const colour = PALETTE[i % PALETTE.length]
    const y = M.top + 4 + i * 16
    return `<rect x="${M.left + pw - 130}" y="${y - 8}" width="10" height="10" fill="${colour}" rx="2"/>`
      + `<text x="${M.left + pw - 116}" y="${y + 1}" class="ng-tick">${esc(label)}</text>`
  }).join('')

  return `<svg class="ng-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title || 'graph')}" xmlns="http://www.w3.org/2000/svg">`
    + (spec.title ? `<text x="${W / 2}" y="18" class="ng-title" text-anchor="middle">${esc(spec.title)}</text>` : '')
    + grid + axes + ticks + paths + seriesSvg + pointSvg + legend
    + `<text x="${M.left + pw / 2}" y="${H - 8}" class="ng-tick" text-anchor="middle">${esc(spec.xLabel)}</text>`
    + `<text x="14" y="${M.top + ph / 2}" class="ng-tick" text-anchor="middle" transform="rotate(-90 14 ${M.top + ph / 2})">${esc(spec.yLabel)}</text>`
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
