// Graphs and tables in notes are drawn by CODE, so they get a code test.
// Run: node tests/notegraph.check.mjs
import assert from 'node:assert/strict'
import { niceTicks, fmtTick, normalizeSpec, buildPlot, graphSVG, tableMarkdown, toLatex, labelHTML } from '../src/page/notegraph.js'

// ---- ASCII maths → LaTeX -----------------------------------------------------
// Models write sqrt(x) as often as \sqrt{x}, and compute-engine reads the bare
// name as the PRODUCT s·q·r·t, which is NaN everywhere and draws nothing. This
// is the regression behind "the unit circle doesn't plot".
assert.equal(toLatex('sqrt(1-x^2)'), '\\sqrt(1-x^2)')
assert.equal(toLatex('\\sqrt{1-x^2}'), '\\sqrt{1-x^2}', 'already-escaped names are left alone')
assert.equal(toLatex('cos(t)+sin(t)'), '\\cos(t)+\\sin(t)')
assert.equal(toLatex('x**2'), 'x^2')
assert.equal(toLatex('2pi'), '2\\pi')
assert.equal(toLatex('minutes'), 'minutes', 'a word merely CONTAINING a function name is untouched')
assert.equal(toLatex('\\arcsin(x)'), '\\arcsin(x)', 'longest name wins, and stays escaped')

// ---- mathprint labels --------------------------------------------------------
{
  const ml = (l) => `<M>${l}</M>` // stand-in for mathlive, so this asserts routing not typography
  assert.equal(labelHTML('x', ml), '<M>x</M>', 'a bare axis name is maths by role')
  assert.equal(labelHTML('-2', ml), '<M>-2</M>', 'tick numbers typeset too')
  assert.equal(labelHTML('1.0e7', ml), '<M>1.0e7</M>', 'including exponent ticks')
  assert.equal(labelHTML('points from the table', ml), 'points from the table', 'prose stays prose')
  // A one-word label must NOT typeset or it renders as the product m·e·a·s·u·r·e·d.
  assert.equal(labelHTML('measured', ml), 'measured', 'a single prose word is not maths')
  assert.equal(labelHTML('$h(t)$ in metres', ml), '<M>h(t)</M> in metres', 'mixed maths and prose')
  assert.equal(labelHTML('$y=sqrt(x)$', ml), '<M>y=\\sqrt(x)</M>', 'label maths is normalised too')
  assert.equal(labelHTML('', ml), '')
  // Model-authored text lands inside SVG markup, so angle brackets never typeset.
  assert.ok(!labelHTML('<script>alert(1)</script>', ml).includes('<script>'))
  assert.ok(labelHTML('<script>alert(1)</script>', ml).includes('&lt;script&gt;'))
  assert.equal(labelHTML('x^2', ml), 'x^2', 'unmarked source is prose — $ is what asks for typesetting')
  // A real mathlive render must produce markup, not the raw string.
  assert.ok(labelHTML('$x^2$').includes('<span'), 'mathlive actually typesets')
  assert.ok(labelHTML('x').includes('<span'), 'and does so for by-role labels')
}

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
{
  // The exact spec from the Calculus III note, which drew an EMPTY plot before
  // toLatex: 2 finite samples out of 241, both incidentally zero at x=±1.
  const plot = await buildPlot({ domain: [-1, 1], curves: [{ latex: 'sqrt(1-x^2)' }, { latex: '-sqrt(1-x^2)' }] })
  assert.ok(plot, 'the unit circle plots at all')
  const good = plot.curves[0].pts.filter((p) => p.y != null)
  assert.ok(good.length > 200, `upper half is a curve, not two dots (${good.length} samples)`)
  const mid = plot.curves[0].pts.find((p) => Math.abs(p.x) < 0.01)
  assert.ok(Math.abs(mid.y - 1) < 1e-3, 'and it really is the unit circle at x=0')
}

// ---- parametric curves -------------------------------------------------------
{
  // x = t²-2t, y = t+1 over t ∈ [-2,2] — the note's worked example. Before
  // this the model had to hand-tabulate points and got their ORDER wrong,
  // which drew a line back across the plot.
  const plot = await buildPlot({ curves: [{ x: 't^2-2t', y: 't+1', t: [-2, 2] }] })
  assert.ok(plot, 'a parametric curve plots')
  const pts = plot.curves[0].pts.filter((p) => p.x != null)
  assert.ok(pts.length > 300, 'sampled densely in t')
  // Spot-check against the table in the note: t=-2 → (8,-1), t=2 → (0,3).
  assert.ok(Math.abs(pts[0].x - 8) < 1e-6 && Math.abs(pts[0].y + 1) < 1e-6, 'starts at t=-2')
  const last = pts[pts.length - 1]
  assert.ok(Math.abs(last.x - 0) < 1e-6 && Math.abs(last.y - 3) < 1e-6, 'ends at t=2')
  // Monotone in y is what makes it a function of t, not of x.
  assert.ok(pts.every((p, i) => !i || p.y >= pts[i - 1].y - 1e-9), 'traced in t order')
}
{
  // A circle must come out ROUND: equal scaling is the default once every
  // curve is parametric, or the unit circle renders as a wide ellipse.
  const plot = await buildPlot({ curves: [{ x: '\\cos t', y: '\\sin t', t: [0, 6.2832] }] })
  const [x0, x1] = plot.domain, [y0, y1] = plot.range
  const pw = 640 - 64 - 20, ph = 380 - 30 - 54
  assert.ok(Math.abs((x1 - x0) / pw - (y1 - y0) / ph) < 1e-6, 'x and y units are the same length on screen')
  assert.ok(x1 - x0 >= 2 && y1 - y0 >= 2, 'equalising GREW the tight axis, it did not crop the curve')
  assert.equal(normalizeSpec({ curves: [{ x: 't', y: 't', t: [0, 1] }], equal: false }).equal, false, 'explicit equal:false wins')
  assert.equal(normalizeSpec({ curves: [{ latex: 'x^2' }] }).equal, false, 'ordinary function plots are not equalised')
}
{
  const plot = await buildPlot({ curves: [{ x: 'nope(', y: 't', t: [0, 1] }] })
  assert.equal(plot, null, 'an unparseable parametric coordinate → no graph, no throw')
}
{
  // Which letter names the free variable carries no information, and getting
  // it "wrong" used to plot NOTHING at all. The converter is told that "latex"
  // is always in x, and the model duly wrote a t-parametrised circle as
  // \cos(x) — so both names bind to the same value.
  const asX = await buildPlot({ curves: [{ x: '\\cos(x)', y: '\\sin(x)', t: [0, 6.2832] }] })
  assert.ok(asX, 'a parametric curve written in x still plots')
  const asT = await buildPlot({ curves: [{ x: '\\cos(t)', y: '\\sin(t)', t: [0, 6.2832] }] })
  assert.deepEqual(asX.curves[0].pts[10], asT.curves[0].pts[10], 'and traces exactly the same points')
  // The mirror case: an ordinary y=f(x) curve written in t.
  const fnInT = await buildPlot({ curves: [{ latex: 't^2' }], domain: [-3, 3] })
  assert.ok(fnInT, 'y = f(x) written in t still plots')
  const at2 = fnInT.curves[0].pts.find((p) => Math.abs(p.x - 2) < 0.02)
  assert.ok(Math.abs(at2.y - 4) < 0.2, 'and really is the square')
}
{
  const svg = await graphSVG({ curves: [{ x: '\\cos t', y: '\\sin t', t: [0, 6.2832] }] })
  assert.ok(svg.includes('<path'), 'parametric curve drawn')
  // Direction of travel is the whole point of a parametric curve.
  assert.ok(svg.includes('rotate('), 'direction arrowheads placed')
  assert.ok(!/NaN|Infinity/.test(svg), 'no NaN leaked into the arrow transforms')
  const off = await graphSVG({ curves: [{ x: '\\cos t', y: '\\sin t', t: [0, 6.2832], arrow: false }] })
  assert.ok(!off.includes('rotate(0') && !off.includes('L-9 4.5'), 'arrow:false suppresses them')
}

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
