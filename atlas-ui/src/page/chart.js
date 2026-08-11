// Minimal inline SVG charts (bar + line), no charting library. Drawn at the
// container's REAL pixel size (viewBox === element px, so 1:1 — text renders at
// its true CSS px size and is never stretched). The renderer re-draws them via
// a ResizeObserver whenever the widget resizes, so geometry (bars, line,
// gridlines, axes) recomputes to the new width/height — while the fixed padding
// keeps constant room for the labels.

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// "Nice" tick step (1/2/5 × 10^n) so axis values read like 0/20/40/60 instead
// of the raw 0/17/34/51.
function niceStep(max, targetTicks) {
  const rough = max / targetTicks
  const mag = 10 ** Math.floor(Math.log10(rough || 1))
  const norm = rough / mag
  return (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
}

// Compact axis-value labels so large domains (net worth in the thousands) read
// as 0/2k/4k instead of 0/2000/4000 and don't crowd the y-axis gutter.
const fmtTick = (v) => {
  const a = Math.abs(v)
  if (a >= 1000) return `${(Math.round(v / 100) / 10).toString().replace(/\.0$/, '')}k`
  return String(Math.round(v * 100) / 100)
}

let instance = 0 // keeps gradient ids unique across multiple charts on one page

// Shared axis/grid scaffolding for both chart types: fixed-px padding, a nice
// y-scale, gridlines + tick labels, solid axes, x-labels, and axis captions.
// xFor(i) returns the horizontal center of the i-th point's slot (bars are
// centered on it; the line threads through it).
function frame(points, W, H, xLabel, yLabel) {
  const pad = { l: yLabel ? 48 : 34, r: 10, t: 14, b: xLabel ? 46 : 30 }
  const innerW = Math.max(1, W - pad.l - pad.r)
  const innerH = Math.max(1, H - pad.t - pad.b)
  const axisY = pad.t + innerH

  // y-domain spans the data but always includes zero, so an all-negative series
  // (e.g. a negative net worth) renders on-scale instead of shooting off-canvas.
  const dMax = Math.max(...points.map((p) => p.value), 0)
  const dMin = Math.min(...points.map((p) => p.value), 0)
  const step = niceStep((dMax - dMin) || 1, 4)
  const niceMax = Math.ceil(dMax / step) * step
  const niceMin = Math.floor(dMin / step) * step
  const domain = (niceMax - niceMin) || 1
  const yFor = (v) => pad.t + innerH - ((v - niceMin) / domain) * innerH
  const zeroY = yFor(0)
  const slot = innerW / points.length
  const xFor = (i) => pad.l + slot * (i + 0.5)

  const ticks = []
  for (let v = niceMin; v <= niceMax + step * 1e-6; v += step) ticks.push(v)
  // One gridline + value label per tick. The bottom-most tick sits on the
  // x-axis line, so it gets a label but no duplicate gridline.
  const gridlines = ticks.map((v) => {
    const y = yFor(v)
    const line = Math.abs(y - axisY) < 0.5 ? ''
      : `<line class="chart__grid" x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(W - pad.r).toFixed(1)}" y2="${y.toFixed(1)}" />`
    return `${line}<text class="chart__ylab" x="${(pad.l - 8).toFixed(1)}" y="${y.toFixed(1)}" dy="3.5" text-anchor="end">${fmtTick(v)}</text>`
  }).join('')
  const zeroLabel = ''

  const axisLines = `
    <line class="chart__axis" x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${axisY.toFixed(1)}" />
    <line class="chart__axis" x1="${pad.l}" y1="${axisY.toFixed(1)}" x2="${(W - pad.r).toFixed(1)}" y2="${axisY.toFixed(1)}" />`

  // Thin x-labels so adjacent labels never collide: keep at most one label per
  // (widest label) of slot, anchored to the last point so the newest reading is
  // always labelled. Below that density every label draws (everyN === 1).
  const charW = 6.2 // ~ IBM Plex Mono 9.5px glyph advance
  const maxLabelW = Math.max(1, ...points.map((p) => String(p.label).length)) * charW
  const everyN = Math.max(1, Math.ceil(maxLabelW / slot))
  const xLabels = points.map((p, i) =>
    (everyN > 1 && (points.length - 1 - i) % everyN !== 0) ? ''
      : `<text class="chart__xlab" x="${xFor(i).toFixed(1)}" y="${(axisY + 16).toFixed(1)}" text-anchor="middle">${esc(p.label)}</text>`
  ).join('')

  // Squeeze an axis caption to fit rather than letting it overflow and clip.
  const fit = (text, limit) => (String(text).length * charW > limit
    ? ` textLength="${Math.max(1, limit).toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : '')
  const xTitle = xLabel
    ? `<text class="chart__axis-title" x="${(pad.l + innerW / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle"${fit(xLabel, innerW)}>${esc(xLabel)}</text>`
    : ''
  const yMid = pad.t + innerH / 2
  const yTitle = yLabel
    ? `<text class="chart__axis-title" x="12" y="${yMid.toFixed(1)}" text-anchor="middle" transform="rotate(-90 12 ${yMid.toFixed(1)})"${fit(yLabel, innerH)}>${esc(yLabel)}</text>`
    : ''

  return { axisY, zeroY, slot, yFor, xFor, gridlines, zeroLabel, axisLines, xLabels, xTitle, yTitle }
}

// points: [{ label, value }, ...]. opts.w/h are the container px; xLabel/yLabel
// are the axis captions.
export function barChart(points, opts = {}) {
  if (!points?.length) return ''
  const W = opts.w || 480
  const H = opts.h || 220
  const f = frame(points, W, H, opts.xLabel, opts.yLabel)
  const gradId = `barFill${instance++}`

  const barW = f.slot * 0.56
  const bars = points.map((p, i) => {
    const x = f.xFor(i) - barW / 2
    const y = f.yFor(p.value)
    const top = Math.min(y, f.zeroY)
    const barH = Math.max(1, Math.abs(f.zeroY - y))
    return `<rect class="chart__bar" fill="url(#${gradId})" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="4"/>`
  }).join('')

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Bar chart">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="chart__grad-a" />
        <stop offset="1" class="chart__grad-b" />
      </linearGradient>
    </defs>
    ${f.gridlines}
    ${f.zeroLabel}
    ${f.axisLines}
    ${bars}
    ${f.xLabels}
    ${f.xTitle}
    ${f.yTitle}
  </svg>`
}

export function lineChart(points, opts = {}) {
  if (!points?.length) return ''
  const W = opts.w || 480
  const H = opts.h || 220
  const f = frame(points, W, H, opts.xLabel, opts.yLabel)
  const gradId = `lineFill${instance++}`

  const xy = points.map((p, i) => [f.xFor(i), f.yFor(p.value)])
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${xy[xy.length - 1][0].toFixed(1)},${f.zeroY.toFixed(1)} L${xy[0][0].toFixed(1)},${f.zeroY.toFixed(1)} Z`
  const dots = xy.map(([x, y]) => `<circle class="chart__dot" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" />`).join('')

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Line chart">
    <defs>
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="chart__area-a" />
        <stop offset="1" class="chart__area-b" />
      </linearGradient>
    </defs>
    ${f.gridlines}
    ${f.zeroLabel}
    ${f.axisLines}
    <path class="chart__area" fill="url(#${gradId})" d="${area}" />
    <path class="chart__line" d="${line}" />
    ${dots}
    ${f.xLabels}
    ${f.xTitle}
    ${f.yTitle}
  </svg>`
}
