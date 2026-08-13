// Pure-logic checks for the math keyboard/menu rework in src/page/view.js.
//
// view.js can't be imported directly in plain Node: it pulls in mathlive's
// CSS at module scope (`import 'mathlive/fonts.css'`, which Node's loader
// rejects with ERR_UNKNOWN_FILE_EXTENSION) and touches `window`/`document`
// as soon as it loads (the virtual-keyboard layout wiring, the boot-time
// warm render). Neither exists here, and this is a headless-only machine —
// no real browser to run it in either (see eqimport.check.mjs's own
// Playwright-against-the-dev-server workaround for the parts that truly do
// need a DOM).
//
// pruneMenuItems and the three custom keyboard layouts are genuinely pure,
// though — no DOM, no closures over `mf`/`window`/`document` — so this pulls
// their REAL source text out of view.js and evaluates just that, rather than
// reimplementing (and silently drifting from) the logic here.
// Run: node tests/mathkbd.check.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../src/page/view.js', import.meta.url), 'utf8')
const slice = (startMarker, endMarker) => {
  const start = src.indexOf(startMarker)
  const end = src.indexOf(endMarker, start)
  assert.ok(start > -1 && end > start, `markers moved in view.js — update mathkbd.check.mjs (${startMarker})`)
  return src.slice(start, end)
}

// --- the three custom keyboard layouts --------------------------------------
const layoutsSrc = slice('const CALCULUS_LAYOUT = {', 'window.mathVirtualKeyboard.layouts =')
const { CALCULUS_LAYOUT, LINALG_LAYOUT, LOGICSETS_LAYOUT } = new Function(
  `${layoutsSrc}\nreturn { CALCULUS_LAYOUT, LINALG_LAYOUT, LOGICSETS_LAYOUT }`
)()

// window.mathVirtualKeyboard.layouts itself references `window` — assert its
// literal text (order matters: it's the tab order the user sees) rather than
// evaluating it.
assert.match(
  src,
  /window\.mathVirtualKeyboard\.layouts = \['symbols', CALCULUS_LAYOUT, LINALG_LAYOUT, LOGICSETS_LAYOUT, 'greek'\]/,
  'the five keyboard pages (built-in symbols/greek + the three custom ones) must all be wired in'
)

// Structural sanity: every base key on every page is either a raw string
// (a built-in control like "[shift]") or an object with a `latex` glyph to
// show on the keycap — a key with neither renders as an empty box.
for (const [name, layout] of Object.entries({ CALCULUS_LAYOUT, LINALG_LAYOUT, LOGICSETS_LAYOUT })) {
  assert.ok(layout.label && layout.tooltip, `${name} needs a label and tooltip to be a real keyboard tab`)
  assert.ok(Array.isArray(layout.rows) && layout.rows.length > 0, `${name}.rows must be a non-empty array`)
  for (const row of layout.rows) {
    assert.ok(Array.isArray(row) && row.length > 0, `${name} has an empty row`)
    for (const key of row) {
      if (typeof key === 'string') continue
      assert.ok(typeof key.latex === 'string' && key.latex.length, `${name} has a key with no latex glyph`)
      for (const v of key.variants ?? []) assert.ok(typeof v.latex === 'string' && v.latex.length, `${name} variant with no latex`)
    }
  }
}

// Requirement #1's explicit symbol list — spot-check each one actually made
// it onto a key (as the base latex, its shift form, or a long-press variant)
// so a future edit can't silently drop one.
const allLatex = (layout) => layout.rows.flat().flatMap((k) =>
  typeof k === 'string' ? [k] : [k.latex, k.shift, k.shift?.latex, ...(k.variants ?? []).map((v) => v.latex)]
).filter(Boolean)
const calc = allLatex(CALCULUS_LAYOUT), linalg = allLatex(LINALG_LAYOUT), logic = allLatex(LOGICSETS_LAYOUT)
const has = (list, needle) => list.some((l) => l.includes(needle))

// calculus: integrals, derivatives/partials, sum/product, limits, nabla/gradient
assert.ok(has(calc, '\\int_'), 'definite integral')
assert.ok(has(calc, '\\dfrac{\\mathrm{d}}{\\mathrm{d}x}'), 'derivative')
assert.ok(has(calc, '\\partial'), 'partial derivative')
assert.ok(has(calc, '\\sum'), 'summation')
assert.ok(has(calc, '\\prod'), 'product')
assert.ok(has(calc, '\\lim'), 'limit')
assert.ok(has(calc, '\\nabla'), 'nabla/gradient')
assert.ok(calc.some((l) => l.includes('\\nabla') && l.includes('\\cdot')), 'divergence')
assert.ok(calc.some((l) => l.includes('\\nabla') && l.includes('\\times')), 'curl')

// linear algebra: vectors/matrices/determinants, dot/cross products
assert.ok(has(linalg, '\\begin{pmatrix}'), 'matrix')
assert.ok(has(linalg, '\\begin{vmatrix}'), 'determinant')
assert.ok(has(linalg, '\\vec{'), 'vector')
assert.ok(linalg.some((l) => l.includes('\\cdot')), 'dot product')
assert.ok(linalg.some((l) => l.includes('\\times')), 'cross product')

// set theory & logic: ∈ ∉ ⊆ ∪ ∩ ∀ ∃ ¬ ∧ ∨ ⇒ ⇔, plus common relations
for (const sym of ['\\in', '\\notin', '\\subseteq', '\\cup', '\\cap', '\\forall', '\\exists', '\\neg', '\\land', '\\lor', '\\Rightarrow', '\\Leftrightarrow']) {
  assert.ok(has(logic, sym), `logic/sets page is missing ${sym}`)
}
for (const sym of ['\\le', '\\ge', '\\ne', '\\approx', '\\equiv', '\\propto', '\\to']) {
  assert.ok(has(logic, sym), `relations are missing ${sym}`)
}

// Greek letters are the built-in 'greek' layout (untouched) — just confirm
// this pass didn't accidentally drop it, or the custom pages, from the tab
// order asserted above; nothing further to check here.

console.log('mathkbd.check: all three keyboard layouts cover the requested symbols')

// --- pruneMenuItems: the field ☰ menu allowlist -----------------------------
const menuSrc = slice('const MENU_KEEP_IDS = new Set([', '// MathLive disables the spacebar')
  .replace('export function pruneMenuItems', 'function pruneMenuItems')
const { pruneMenuItems } = new Function(`${menuSrc}\nreturn { pruneMenuItems }`)()

// A stand-in for what mf.menuItems returns by default (mathlive.mjs's
// getDefaultMenuItems) — trimmed to the shape pruneMenuItems actually reads
// (id/type/submenuClass/submenu/keyboardShortcut), in the same order,
// including the real duplicate-id quirk on the copy submenu (LaTeX and
// Typst both carry id "copy-latex" in MathLive 0.110 — see the comment in
// view.js) that forces filtering by keyboardShortcut instead of id.
const fakeDefaultMenu = [
  { id: 'add-row-above' }, { id: 'add-row-below' }, { id: 'add-column-before' }, { id: 'add-column-after' },
  { type: 'divider' },
  { id: 'delete-row' }, { id: 'delete-column' },
  { type: 'divider' },
  { submenuClass: 'border-submenu' }, // "borders" — no top-level id in the real menu
  { type: 'divider' },
  { id: 'insert-matrix' },
  { type: 'divider' },
  { id: 'insert' },
  { type: 'divider' },
  { id: 'mode' }, // math/text/latex-source switcher
  { type: 'divider' },
  { id: 'variant' }, // font style
  { id: 'color' },
  { id: 'background-color' },
  { id: 'accent' }, // vector arrows/dots/overline — NOT a font feature, stays
  { id: 'decoration' }, // boxed/coloured decorations
  { type: 'divider' },
  { id: 'ce-evaluate' }, { id: 'ce-simplify' }, { id: 'ce-solve' }, // compute-engine, not on the keep-list
  { type: 'divider' },
  { id: 'cut' },
  { id: 'copy', submenu: [
    { id: 'copy-latex', keyboardShortcut: 'meta+C' },
    { id: 'copy-latex', keyboardShortcut: undefined }, // typst — same buggy id, no shortcut
    { id: 'copy-ascii-math' },
    { id: 'copy-math-ml' },
  ] },
  { id: 'paste' },
  { id: 'select-all' },
]

const pruned = pruneMenuItems(fakeDefaultMenu)
const ids = pruned.filter((it) => it.type !== 'divider').map((it) => it.id ?? 'borders')

assert.deepEqual(ids, [
  'add-row-above', 'add-row-below', 'add-column-before', 'add-column-after',
  'delete-row', 'delete-column',
  'borders',
  'insert-matrix',
  'insert',
  'accent',
  'cut', 'copy', 'paste', 'select-all',
], 'kept items, in order, minus mode/variant/color/background-color/decoration/ce-*')

// no leading/trailing/doubled dividers left stranded by the filter
assert.ok(pruned[0].type !== 'divider' && pruned[pruned.length - 1].type !== 'divider', 'no dangling dividers at the ends')
for (let i = 1; i < pruned.length; i++) {
  assert.ok(!(pruned[i].type === 'divider' && pruned[i - 1].type === 'divider'), 'no back-to-back dividers')
}

// copy keeps only the LaTeX export — the "different types" (Typst/ASCII/
// MathML) the user didn't want — found by shortcut, not the buggy shared id
const copy = pruned.find((it) => it.id === 'copy')
assert.equal(copy.submenu.length, 1)
assert.equal(copy.submenu[0].keyboardShortcut, 'meta+C')

// font/color/mode/compute-engine items are gone entirely
for (const gone of ['mode', 'variant', 'color', 'background-color', 'decoration', 'ce-evaluate', 'ce-simplify', 'ce-solve']) {
  assert.ok(!ids.includes(gone), `${gone} should have been pruned`)
}

// idempotent — tuneMathFields re-runs on every render, re-reading whatever
// mf.menuItems now returns (i.e. the previous prune's own output)
const prunedAgain = pruneMenuItems(pruned)
assert.deepEqual(prunedAgain, pruned, 'pruning an already-pruned menu must be a no-op')

console.log('mathkbd.check: pruneMenuItems keeps matrix/insert/accent/cut/copy/paste/select-all, drops the rest, idempotently')
