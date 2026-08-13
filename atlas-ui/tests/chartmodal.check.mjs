// Pure-logic checks for the chart-click-to-modal feature: chart.js's
// per-datum hover-target geometry (hitTargets) and chartmodal.js's tooltip
// text/position math. Both modules are safely importable in plain Node —
// chart.js has zero imports and chartmodal.js only touches document/window
// inside function bodies, never at module scope.
//
// The click → modal → hover DOM flow itself (mount gets data-chart, click
// opens #app-modal, mousemove tracks the cursor and shows/hides the
// tooltip, Escape/backdrop-click closes it) needs a real browser and can't
// be exercised headlessly on this machine (see CLAUDE.md) — this check
// covers the math that flow depends on instead.
// Run: node tests/chartmodal.check.mjs
import assert from 'node:assert/strict'
import { barChart, lineChart, hitTargets } from '../src/page/chart.js'
import { tooltipText, clampTooltipPos } from '../src/page/chartmodal.js'

// ---- hitTargets: one full-height rect per datum, tiling the plot width ---
{
  const points = [{ label: 'Mon', value: 10 }, { label: 'Tue', value: 40 }, { label: 'Wed', value: 25 }]
  const hits = hitTargets(points, 480, 220, '', 'Y')
  assert.equal(hits.length, points.length, 'one hit target per datum')
  for (let i = 1; i < hits.length; i++) {
    assert.ok(Math.abs(hits[i].x - (hits[i - 1].x + hits[i - 1].width)) < 0.01, `slot ${i} abuts slot ${i - 1} (no gaps/overlaps)`)
  }
  const h0 = hits[0].height
  hits.forEach((h, i) => {
    assert.ok(h.height > 0 && Math.abs(h.height - h0) < 0.01, 'every rect spans the same full plot height')
    assert.equal(h.value, points[i].value, 'hit rect carries the datum value')
    assert.equal(h.label, points[i].label, 'hit rect carries the datum label')
  })
  assert.deepEqual(hitTargets([], 480, 220), [], 'no points → no hit targets')
}

// ---- barChart/lineChart stamp data-v/data-l on both the visible mark and
// the invisible hit rect, so whichever the pointer actually lands on agrees
{
  const points = [{ label: 'A', value: 5 }, { label: 'B', value: -3 }]
  const svgBar = barChart(points, { w: 300, h: 150 })
  const svgLine = lineChart(points, { w: 300, h: 150 })
  assert.equal((svgBar.match(/data-v="/g) || []).length, points.length * 2, 'bar chart: mark + hit rect per datum')
  assert.equal((svgLine.match(/data-v="/g) || []).length, points.length * 2, 'line chart: dot + hit rect per datum')
  for (const svg of [svgBar, svgLine]) {
    assert.ok(svg.includes('data-v="5" data-l="A"'), 'positive datum present')
    assert.ok(svg.includes('data-v="-3" data-l="B"'), 'negative datum present')
  }
  assert.ok(svgBar.includes('class="chart__bar" data-v="5" data-l="A"'), 'bar itself carries the datum')
  assert.ok(svgLine.includes('class="chart__dot" data-v="5" data-l="A"'), 'dot itself carries the datum')
  assert.equal(barChart([], { w: 300, h: 150 }), '', 'empty points → empty chart, unchanged signature')
}

// ---- tooltipText: "label: value", float noise rounded away, label-less ---
{
  assert.equal(tooltipText(83.399999999999991, 'Mon'), 'Mon: 83.4')
  assert.equal(tooltipText(10, 'Tue'), 'Tue: 10')
  assert.equal(tooltipText(-3, null), '-3')
  assert.equal(tooltipText('7.5', 'Wed'), 'Wed: 7.5', 'attribute values arrive as strings')
}

// ---- clampTooltipPos: tracks the cursor but never crosses the viewport ---
{
  const vw = 1000, vh = 800, tw = 120, th = 40
  const mid = clampTooltipPos(500, 400, tw, th, vw, vh)
  assert.equal(mid.x, 514, 'plenty of room → sits at cursor + offset')
  assert.equal(mid.y, 414)

  const corner = clampTooltipPos(990, 790, tw, th, vw, vh)
  assert.ok(corner.x + tw <= vw - 12 + 1e-9, 'clamped x stays inside the right edge')
  assert.ok(corner.y + th <= vh - 12 + 1e-9, 'clamped y stays inside the bottom edge')

  const topLeft = clampTooltipPos(0, 0, tw, th, vw, vh)
  assert.ok(topLeft.x >= 12 - 1e-9 && topLeft.y >= 12 - 1e-9, 'clamped stays inside the left/top edge')
}

console.log('chartmodal.check.mjs: OK')
