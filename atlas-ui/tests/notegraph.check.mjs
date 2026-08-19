// Graphs and tables in notes are drawn by CODE, so they get a code test.
// Run: node tests/notegraph.check.mjs
import assert from 'node:assert/strict'
import { niceTicks, fmtTick, normalizeSpec, buildPlot, graphSVG, tableMarkdown } from '../src/page/notegraph.js'

// ---- ticks -------------------------------------------------------------------
assert.deepEqual(niceTicks(0, 10, 5), [0, 2, 4, 6, 8, 10])
{
  const t = niceTicks(0, 1, 5)
  assert.equal(t[0], 0)
  assert.equal(t[t.length - 1], 1)
  assert.ok(t.every((v) => Number.isFinite(v)), 'all ticks finite')
}
assert.ok(niceTicks(-3, 3, 6).includes(0), 'zero is always a tick when it is in range')
assert.deepEqual(niceTicks(5, 5), [5], 'a degenerate range does not hang or explode')
{
  // Garbage in must not hang or throw; one placeholder tick is fine.
  const t = niceTicks(NaN, 2)
  assert.ok(Array.isArray(t) && t.length === 1, 'a non-numeric bound degrades to a single tick')
}
// Every tick must be a clean number — this is what stops 0.30000000000000004.
for (const t of niceTicks(0, 1, 7)) assert.ok(String(t).length <= 6, `ugly tick ${t}`)

assert.equal(fmtTick(0), '0')
assert.equal(fmtTick(1000), '1000')
assert.equal(fmtTick(0.30000000000000004), '0.3')
assert.equal(fmtTick(1e7), '1.0e7')

// ---- spec normalisation ------------------------------------------------------
{
  const s = normalizeSpec({ curves: [{ latex: 'x^2', label: 'f' }, { latex: '   ' }, { nope: 1 }] })
  assert.equal(s.curves.length, 1, 'blank/!string curves dropped')
  assert.equal(s.valid, true)
}
{
  const s = normalizeSpec({ series: [{ label: 'a', data: [[0, 1], [1, 'x'], { x: 2, y: 3 }] }] })
  assert.deepEqual(s.series[0].data, [{ x: 0, y: 1 }, { x: 2, y: 3 }], 'non-numeric points dropped, both shapes accepted')
}
assert.equal(normalizeSpec(null).valid, false, 'nothing to draw is not valid')
assert.equal(normalizeSpec({ curves: [] }).valid, false)
{
  const s = normalizeSpec({ domain: [5, -5] })
  assert.deepEqual(s.domain, [-5, 5], 'a reversed domain is sorted, not rejected')
}

// ---- plotting the money path -------------------------------------------------
{
  const plot = await buildPlot({ curves: [{ latex: 'x^2' }], domain: [-3, 3] })
  assert.ok(plot, 'a parabola plots')
  const ys = plot.curves[0].pts.filter((p) => p.y != null)
  assert.ok(ys.length > 200, 'sampled densely')
  const at0 = plot.curves[0].pts.find((p) => Math.abs(p.x) < 0.02)
  assert.ok(Math.abs(at0.y - at0.x ** 2) < 1e-6, 'the curve really is x^2')
  assert.ok(plot.range[0] <= 0 && plot.range[1] >= 9 * 0.9, `range covers the curve (${plot.range})`)
}
{
  // The asymptote case: 1/x must BREAK, not draw a line across the plot.
  const plot = await buildPlot({ curves: [{ latex: '\\frac{1}{x}' }], domain: [-2, 2] })
  assert.ok(plot, '1/x plots')
  const near = plot.curves[0].pts.filter((p) => Math.abs(p.x) < 0.01)
  assert.ok(near.every((p) => p.y == null || Math.abs(p.y) > 50), 'no finite small value at the pole')
  // And the clipped range must stay human-sized rather than 0..1e17.
  assert.ok(plot.range[1] < 1e3, `range was clipped sanely (${plot.range})`)
}
{
  // sqrt over a domain that goes negative: the negative half is undefined and
  // must be dropped, not plotted as 0 or as a complex magnitude.
  const plot = await buildPlot({ curves: [{ latex: '\\sqrt{x}' }], domain: [-4, 4] })
  const neg = plot.curves[0].pts.filter((p) => p.x < -0.1)
  assert.ok(neg.every((p) => p.y == null), 'sqrt of a negative is a break')
}
assert.equal(await buildPlot({ curves: [{ latex: '\\this is not math{' }] }), null, 'unparseable expression → no graph, no throw')
assert.equal(await buildPlot({}), null, 'empty spec → null')

// ---- SVG ---------------------------------------------------------------------
{
  const svg = await graphSVG({ title: 'Parabola', curves: [{ latex: 'x^2', label: 'f(x)' }], domain: [-3, 3], xLabel: 't', yLabel: 'h' })
  assert.ok(svg.startsWith('<svg'), 'emits an svg')
  assert.ok(svg.includes('viewBox'), 'scalable, not fixed-size')
  assert.ok(svg.includes('<path'), 'has a curve path')
  assert.ok(svg.includes('Parabola') && svg.includes('&gt;') === false, 'title rendered')
  assert.ok(svg.includes('>t<') && svg.includes('>h<'), 'axis labels rendered')
  assert.ok(!/NaN|Infinity|undefined/.test(svg), 'no NaN/undefined leaked into coordinates')
}
{
  // Titles and labels are user/model text and land inside SVG markup.
  const svg = await graphSVG({ title: '<script>alert(1)</script>', curves: [{ latex: 'x' }], domain: [0, 1] })
  assert.ok(!svg.includes('<script>'), 'title is escaped')
  assert.ok(svg.includes('&lt;script&gt;'), 'escaped, not stripped')
}
{
  const svg = await graphSVG({ series: [{ label: 'measured', data: [[0, 1], [1, 4], [2, 9]] }] })
  assert.ok(svg.includes('<circle'), 'data series get dots')
  assert.ok(svg.includes('measured'), 'series legend')
}

// ---- tables ------------------------------------------------------------------
{
  const md = tableMarkdown({ columns: ['Ion', 'Charge'], rows: [['Na', '+1'], ['O', '-2']] })
  assert.equal(md.split('\n')[0], '| Ion | Charge |')
  assert.equal(md.split('\n')[1], '| --- | --- |')
  assert.equal(md.split('\n')[2], '| Na | +1 |')
}
{
  const md = tableMarkdown({ columns: ['a', 'b'], rows: [['x|y', 'line\nbreak']], align: ['left', 'right'] })
  assert.ok(md.includes('x\\|y'), 'a pipe in a cell is escaped or it would split the row')
  assert.ok(md.includes('line break'), 'newlines in a cell are flattened')
  assert.ok(md.split('\n')[1].includes('---:'), 'alignment honoured')
}
{
  const md = tableMarkdown({ columns: ['a', 'b'], rows: [['only-one']] })
  assert.equal(md.split('\n')[2], '| only-one |  |', 'a short row is padded, not dropped')
}
assert.equal(tableMarkdown({ columns: [], rows: [] }), null, 'an empty table is nothing')
assert.equal(tableMarkdown(null), null)
{
  const md = tableMarkdown({ columns: ['a'], rows: [['1']], caption: 'Table 1' })
  assert.ok(md.endsWith('*Table 1*'), 'caption kept as emphasis below the table')
}

console.log('notegraph.check: ticks, plotting, asymptotes, escaping and tables all covered')
