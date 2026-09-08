// Equations print sheet self-check: the selection tree's shaping rules, the
// flat print order, the keep-with-next column flow, the auto-fit solver (with
// a fake measurer), the legibility maths and the persisted state. Run:
//   node tests/eqprint.check.mjs
import assert from 'node:assert/strict'
import {
  DEFAULTS, MIN_SHRINK, SIZE_MIN, SIZE_MAX, STORE_KEY, CAL_KEY,
  loadState, saveState, loadCal, saveCal, paperSize, geometry, effDpi,
  buildTree, allLeaves, stateOf, findNode, buildBlocks, flow, solve, legibility,
} from '../src/page/eqprint.js'

const fakeStorage = () => { const d = {}; return { getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v) }, removeItem: (k) => { delete d[k] } } }

// ---- tree shaping ------------------------------------------------------------
const page = { v: 1, rows: [
  { id: 'r1', title: 'Physics II', cols: [{ id: 'c1', sections: [
    // section whose only widget is a list with the section's title → list level collapses
    { id: 's1', title: 'Constants', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'eqlist', title: 'Constants', items: [{ name: 'k', latex: 'k=9' }, { name: 'e', latex: 'e_0=8' }] }] }] },
    // titled section with a card and a differently-named list → both kept
    { id: 's2', title: 'Fields', lines: [{ id: 'l2', widgets: [{ id: 'w2', kind: 'eqcard', title: 'Coulomb', latex: 'F=k\\frac{q_1q_2}{r^2}' }, { id: 'w3', kind: 'eqlist', title: 'Dipoles', items: [{ name: 'p', latex: 'p=qd' }] }] }] },
    // untitled section → its widgets hoist into the category; graphs ignored
    { id: 's3', lines: [{ id: 'l3', widgets: [{ id: 'w4', kind: 'graph', title: 'x' }, { id: 'w5', kind: 'eqcard', title: 'Loose', latex: 'a=b' }] }] },
  ] }] },
  { id: 'r2', cols: [{ id: 'c2', sections: [{ id: 's4', lines: [{ id: 'l4', widgets: [{ id: 'w6', kind: 'eqcard', title: 'Quadratic', latex: 'x=\\frac{-b}{2a}' }] }] }] }] },
  { id: 'r3', title: 'Empty row', cols: [{ id: 'c3', sections: [{ id: 's5', title: 'Only graphs', lines: [{ id: 'l5', widgets: [{ id: 'w7', kind: 'graph' }] }] }] }] },
] }
const tree = buildTree(page)
assert.equal(tree.length, 2, 'rows without equations are dropped')
assert.deepEqual(tree[0].children.map((n) => n.kind + ':' + (n.label || '')), ['sub:Constants', 'sub:Fields', 'eq:Loose'])
assert.deepEqual(tree[0].children[0].children.map((n) => n.id), ['w1#0', 'w1#1'], 'same-title list collapses into the section')
assert.deepEqual(tree[0].children[1].children.map((n) => n.kind), ['eq', 'list'], 'card + list under a titled section both survive')
assert.equal(tree[1].label, '', 'untitled row keeps an empty label (UI shows Ungrouped)')
const ALL = allLeaves(tree)
assert.deepEqual(ALL.map((l) => l.id), ['w1#0', 'w1#1', 'w2', 'w3#0', 'w5', 'w6'])

// ---- tri-state -------------------------------------------------------------------
const sel = new Set(['w1#0', 'w2'])
assert.equal(stateOf(findNode(tree, 's1'), sel), 'mixed')
assert.equal(stateOf(findNode(tree, 's2'), sel), 'mixed')
assert.equal(stateOf(findNode(tree, 'w3'), sel), 'off')
assert.equal(stateOf(findNode(tree, 'r2'), sel), 'off')
assert.equal(stateOf(findNode(tree, 'w2'), sel), 'on')
assert.equal(stateOf(findNode(tree, 'r1'), new Set(ALL.map((l) => l.id))), 'on')

// ---- blocks ----------------------------------------------------------------------
const S = { ...DEFAULTS }
let blocks = buildBlocks(tree, new Set(ALL.map((l) => l.id)), S)
assert.deepEqual(blocks.map((b) => b.t + ':' + (b.text || b.name)),
  ['cat:Physics II', 'sub:Constants', 'eq:k', 'eq:e', 'sub:Fields', 'eq:Coulomb', 'list:Dipoles', 'eq:p', 'eq:Loose', 'eq:Quadratic'],
  'board order; untitled row prints no category heading')
blocks = buildBlocks(tree, new Set(['w3#0', 'w6']), { ...S, showCat: false })
assert.deepEqual(blocks.map((b) => b.t + ':' + (b.text || b.name)), ['sub:Fields', 'list:Dipoles', 'eq:p', 'eq:Quadratic'], 'only selected leaves, headings only where something below is selected')
blocks = buildBlocks(tree, new Set(['w3#0']), { ...S, showSub: false })
assert.deepEqual(blocks.map((b) => b.t), ['cat', 'eq'], 'showSub off drops both sub and list headings')
assert.deepEqual(buildBlocks(tree, new Set(), S), [])

// ---- flow ------------------------------------------------------------------------
const bl = [{ t: 'cat' }, { t: 'sub' }, { t: 'eq' }, { t: 'eq' }, { t: 'sub' }, { t: 'eq' }, { t: 'eq' }]
let cols = flow(bl, [10, 10, 30, 30, 10, 30, 30], 100)
assert.deepEqual(cols, [[0, 1, 2, 3], [4, 5, 6]], 'the second sub heading keeps with its first equation instead of stranding at 80–90')
cols = flow(bl, [10, 10, 30, 30, 10, 30, 30], 1000)
assert.deepEqual(cols, [[0, 1, 2, 3, 4, 5, 6]])
cols = flow([{ t: 'eq' }, { t: 'eq' }], [500, 40], 100)
assert.deepEqual(cols, [[0], [1]], 'an oversized block takes a column alone rather than looping')
assert.deepEqual(flow([], [], 100), [])

// ---- solver with a fake measurer ---------------------------------------------------
// Model: every block is `size × 3` px tall; the column count only changes how
// far the longest equation shrinks (k columns → longest at 1/k of full width,
// capped at 1). 40 blocks, columns 600px tall.
const fake = (n, ch = 600) => (size, k, g) => {
  const h = size * 3
  const perCol = Math.max(1, Math.floor(ch / h))
  return { sides: Math.ceil(Math.ceil(n / perCol) / k), minScale: Math.min(1, 1.7 / k) }
}
let r = solve({ ...S, pages: 1, sides: 2, cols: 'auto' }, fake(40))
assert.ok(r.fits && !r.loose, 'auto-fit finds a fitting layout')
assert.ok(r.minScale >= MIN_SHRINK, `shrink floor honoured (k=${r.k}, minScale=${r.minScale})`)
assert.equal(r.k, 3, 'k=4 would shrink to 42%: the floor pushes it back to 3 columns')
assert.ok(r.size >= SIZE_MIN && r.size <= SIZE_MAX && r.size * 4 === Math.round(r.size * 4), 'quarter-point size')
// bigger allowance → bigger size, never smaller
const r2 = solve({ ...S, pages: 2, sides: 2, cols: 'auto' }, fake(40))
assert.ok(r2.size >= r.size, 'more sides never shrinks the solved size')
// fixed size: fewest columns that fit wins
r = solve({ ...S, sizeMode: 'fixed', size: 10, pages: 1, sides: 2, cols: 'auto' }, fake(40))
assert.ok(r.fits && r.size === 10)
assert.equal(r.k, 1, 'fixed 10pt: 40 blocks × 30px = 2 columns of 600 → 1 column per side fits 2 sides')
r = solve({ ...S, sizeMode: 'fixed', size: 28, pages: 1, sides: 1, cols: '1' }, fake(40))
assert.ok(!r.fits && r.sides > 1, 'fixed size that overflows reports the sides it would need')
// nothing satisfies the shrink floor → loose fallback, flagged
r = solve({ ...S, pages: 1, sides: 1, cols: '5' }, fake(4))
assert.ok(r.fits && r.loose, 'forced 5 columns can only fit by shrinking past the floor → loose')
// nothing fits even at SIZE_MIN → best effort with the fewest sides
r = solve({ ...S, pages: 1, sides: 1, cols: 'auto' }, fake(4000))
assert.ok(!r.fits && r.size === SIZE_MIN)
// columns too narrow are skipped entirely
r = solve({ ...S, paper: 'i35', orient: 'landscape', margin: 1.4, cols: '6' }, fake(4))
assert.equal(r, null, 'six columns on a 3×5 card with 1.4in margins leaves no column at all')

// ---- legibility ----------------------------------------------------------------------
let L = legibility(8, 1, 300, true)
assert.ok(Math.abs(L.xhPt - 8 * 0.7 * 0.43) < 1e-9 && L.grade === 'good' && Math.round(L.dots) === 10)
L = legibility(8, 0.5, 150, true)
assert.equal(L.grade, 'hard to read', `${L.dots} dots`)
L = legibility(6, 1, 300, false)
assert.equal(L.grade, 'good', 'no scripts → the base x-height is what counts')
assert.equal(legibility(6, 1, 300, true).grade, 'marginal')

// ---- paper + state -------------------------------------------------------------------
assert.deepEqual(paperSize({ paper: 'i35', orient: 'landscape' }), [5, 3])
assert.deepEqual(paperSize({ paper: 'i35', orient: 'portrait' }), [3, 5])
assert.deepEqual(paperSize({ paper: 'custom', orient: 'portrait', customW: 11, customH: 4 }), [4, 11], 'custom sizes normalise so portrait is the tall way up')
assert.deepEqual(paperSize({ paper: 'nope' }), [8.5, 11], 'unknown paper falls back to Letter')
const g = geometry({ ...S, paper: 'letter', orient: 'portrait', margin: 0.5 }, 2)
assert.equal(g.W, 816); assert.equal(g.H, 1056); assert.equal(g.mg, 48)
assert.ok(Math.abs(g.cw - (816 - 96 - 0.18 * 96) / 2) < 1e-9)
assert.equal(geometry({ ...S, labels: true }, 1).ch, 1056 - 2 * 0.3 * 96 - 10)
assert.equal(effDpi({ ...S, dpi: 300 }), 300)
assert.ok(effDpi({ ...S, dpi: 1200 }) < 1200, 'letter at 1200 dpi exceeds the canvas cap')
assert.equal(effDpi({ ...S, paper: 'i35', dpi: 600 }), 600, 'a 3×5 card at 600 dpi fits under the cap')

const st = fakeStorage()
let loaded = loadState(st)
assert.deepEqual(loaded, { settings: DEFAULTS, sel: null }, 'fresh: defaults, sel null (= select everything)')
saveState({ ...DEFAULTS, sides: 1, paper: 'i46', bogus: 1 }, new Set(['a', 'b']), st)
loaded = loadState(st)
assert.equal(loaded.settings.sides, 1); assert.equal(loaded.settings.paper, 'i46'); assert.ok(!('bogus' in loaded.settings), 'unknown keys never come back')
assert.deepEqual(loaded.sel, ['a', 'b'])
st.setItem(STORE_KEY, '{not json')
assert.deepEqual(loadState(st).settings, DEFAULTS, 'corrupt store → defaults')
assert.equal(loadCal(st), 1)
saveCal(1.12, st); assert.equal(loadCal(st), 1.12)
st.setItem(CAL_KEY, '9'); assert.equal(loadCal(st), 1, 'out-of-range calibration is ignored')
assert.ok(!CAL_KEY.startsWith('atlas.'), 'calibration is per device and must not sync')

console.log('eqprint.check: all good')
