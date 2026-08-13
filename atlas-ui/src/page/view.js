// The one page renderer, used for BOTH the read-only dashboard and Customize
// mode — customizing only adds affordances (row handles, draggable widgets,
// delete ×, inline edit fields). Markup mirrors the model 1:1:
//   .page-root > .prow > .pcol > .pline > .pwidget
// each carrying its model id in a data attribute (hitzones.js matches on them).

import { barChart, lineChart } from './chart.js'
import { loadPage, findWidget } from './model.js'
import { gymWidgetHTML, gymScoreGraphSVG, GYM_KINDS } from './gymui.js'
import { calWidgetHTML, hydrateCalWidgets, CAL_KINDS } from './calendarui.js'
import { canvasWidgetHTML, hydrateCanvasWidgets, CV_KINDS } from './canvasui.js'
import { workWidgetHTML, WK_KINDS } from './workui.js'
import { sleepWidgetHTML, sleepHoursChartSVG, sleepDebtChartSVG, SL_KINDS } from './sleepui.js'
import { isKindEnabled, KIND_PLUGIN, pluginDef } from './plugins.js'
import { MathfieldElement, convertLatexToMarkup } from 'mathlive'
import 'mathlive/fonts.css'
import 'mathlive/static.css'

// No audio assets. The virtual keyboard is opt-in via the corner toggle next
// to Customize (renderer.js) — every math-field ships
// math-virtual-keyboard-policy="manual" so MathLive itself never auto-shows
// it; that toggle's focus/blur wiring is the only thing that calls
// mathVirtualKeyboard.show()/hide().
MathfieldElement.soundsDirectory = null

// Three custom layers for the constructs a physical keyboard genuinely can't
// produce and that MathLive's built-in "symbols" layout only hides behind a
// long-press (definite integral bounds, ∧/∨/⇒/⇔) or doesn't include at all
// (sum and product live on the "numeric" layout, which we don't load;
// matrices and nth roots only exist in the desktop right-click Insert menu).
// Split by subject (Chancellor: "organize into a few labeled pages") so a
// calculus-heavy session and a linear-algebra-heavy one aren't sharing one
// crowded page. Every key taps directly to the full template — no
// long-press required — EXCEPT constructs already reachable by typing plain
// English-keyboard characters or MathLive's own word shortcuts (≤ via "<=",
// ∀ via "AA", √ via "sqrt", …): those are deliberately left off so the
// keyboard doesn't pad itself with redundant keys.
const CALCULUS_LAYOUT = {
  label: '&int;&Sigma;&part;',
  labelClass: 'MLK__tex-math',
  tooltip: 'Calculus — integrals, sums, derivatives, limits',
  // Base keys show a clean illustrative glyph (no empty placeholder boxes)
  // via `latex`, but `insert` — the actual keystroke action — is the fully
  // parameterized template. Every key carries `class: 'small'` (uniform
  // across all three custom pages, not just the tall ones) because the
  // keycap cells are only ~42px tall on the floating panel, so a
  // display-style \sum with limits (~71px) would spill out the bottom row
  // and get clipped by the panel's rounded overflow; big operators
  // additionally use `\textstyle` (bounds inline beside the symbol, not
  // stacked above/below). Long-press variants stay full display-style
  // templates — those render at full size in the pop-up, not inside a
  // keycap.
  rows: [
    [
      {
        latex: '\\textstyle\\int_a^b',
        class: 'small',
        insert: '\\int_{#?}^{#?}#?\\,\\mathrm{d}#?',
        tooltip: 'Definite integral',
        variants: [
          { latex: '\\int#?\\,\\mathrm{d}#?', aside: 'indefinite', class: 'small' },
          { latex: '\\iint_{#?}^{#?}#?\\,\\mathrm{d}#?', aside: 'double', class: 'small' },
          { latex: '\\iiint_{#?}^{#?}#?\\,\\mathrm{d}#?', aside: 'triple', class: 'small' },
          { latex: '\\oint#?\\,\\mathrm{d}#?', aside: 'contour', class: 'small' },
        ],
      },
      { latex: '\\textstyle\\sum_{i=1}^{n}', class: 'small', insert: '\\sum_{#?}^{#?}#?', tooltip: 'Summation' },
      { latex: '\\textstyle\\prod_{i=1}^{n}', class: 'small', insert: '\\prod_{#?}^{#?}#?', tooltip: 'Product' },
      { latex: '\\lim_{x\\to a}', class: 'small', insert: '\\lim_{#?\\to#?}#?', tooltip: 'Limit' },
      {
        latex: '\\frac{d}{dx}',
        class: 'small',
        insert: '\\dfrac{\\mathrm{d}}{\\mathrm{d}x}#?',
        tooltip: 'Derivative',
        variants: [
          { latex: '\\dfrac{\\mathrm{d}^#?}{\\mathrm{d}x^#?}#?', aside: 'nth derivative', class: 'small' },
          { latex: '\\dfrac{\\mathrm{d}}{\\mathrm{d}x}#?\\bigm|_{x=#?}', aside: 'at a point', class: 'small' },
        ],
      },
    ],
    [
      {
        latex: '\\frac{\\partial}{\\partial x}',
        class: 'small',
        insert: '\\dfrac{\\partial}{\\partial x}#?',
        tooltip: 'Partial derivative',
        variants: [
          { latex: '\\dfrac{\\partial^2}{\\partial x^2}#?', aside: '2nd order', class: 'small' },
          { latex: '\\dfrac{\\partial^2}{\\partial x\\partial y}#?', aside: 'mixed', class: 'small' },
        ],
      },
      { latex: '\\sqrt[n]{x}', class: 'small', insert: '\\sqrt[#?]{#?}', tooltip: 'Nth root' },
      {
        latex: '\\nabla f',
        class: 'small',
        insert: '\\nabla#?',
        tooltip: 'Gradient (nabla)',
        variants: [
          { latex: '\\nabla\\cdot\\vec F', insert: '\\nabla\\cdot#?', aside: 'divergence', class: 'small' },
          { latex: '\\nabla\\times\\vec F', insert: '\\nabla\\times#?', aside: 'curl', class: 'small' },
          { latex: '\\nabla^2 f', insert: '\\nabla^{2}#?', aside: 'Laplacian', class: 'small' },
        ],
      },
      { latex: '\\tbinom{n}{k}', class: 'small', insert: '\\binom{#?}{#?}', tooltip: 'Binomial coefficient' },
      { latex: '\\log_n x', class: 'small', insert: '\\log_{#?}{#?}', tooltip: 'Log, arbitrary base' },
    ],
  ],
}

// Matrices/vectors/products moved here from the calculus page — a linear
// algebra session shouldn't have to hunt through integral templates for a
// determinant, and vice versa.
const LINALG_LAYOUT = {
  label: '[&#8945;]',
  labelClass: 'MLK__tex-math',
  tooltip: 'Linear algebra — matrices, vectors, dot & cross products',
  rows: [
    [
      {
        latex: '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}',
        insert: '\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}',
        tooltip: 'Matrix',
        class: 'small',
        variants: [
          { latex: '\\begin{bmatrix}#?&#?\\\\#?&#?\\end{bmatrix}', aside: 'brackets', class: 'small' },
          { latex: '\\begin{vmatrix}#?&#?\\\\#?&#?\\end{vmatrix}', aside: 'determinant', class: 'small' },
          { latex: '\\begin{pmatrix}#?&#?&#?\\\\#?&#?&#?\\\\#?&#?&#?\\end{pmatrix}', aside: '3×3', class: 'small' },
          { latex: '\\begin{pmatrix}1&0\\\\0&1\\end{pmatrix}', aside: 'identity', class: 'small' },
        ],
      },
      {
        latex: '\\vec{v}',
        class: 'small',
        insert: '\\vec{#?}',
        tooltip: 'Vector',
        variants: [{ latex: '\\hat{v}', insert: '\\hat{#?}', aside: 'unit vector', class: 'small' }],
      },
      {
        latex: 'a\\cdot b',
        class: 'small',
        insert: '#?\\cdot#?',
        tooltip: 'Dot product',
        variants: [{ latex: '\\cdot', insert: '\\cdot', aside: 'scalar dot', class: 'small' }],
      },
      {
        latex: 'a\\times b',
        class: 'small',
        insert: '#?\\times#?',
        tooltip: 'Cross product',
        variants: [{ latex: '\\times', insert: '\\times', aside: 'cross/times', class: 'small' }],
      },
      {
        latex: 'A^{\\mathsf{T}}',
        class: 'small',
        insert: '#?^{\\mathsf{T}}',
        tooltip: 'Transpose',
        variants: [
          { latex: 'A^{\\dagger}', insert: '#?^{\\dagger}', aside: 'conjugate transpose', class: 'small' },
          { latex: 'A^{-1}', insert: '#?^{-1}', aside: 'inverse', class: 'small' },
        ],
      },
    ],
    [
      { latex: '\\lVert v \\rVert', class: 'small', insert: '\\lVert#?\\rVert', tooltip: 'Norm / magnitude' },
      { latex: '\\frac{a}{b}', class: 'small', insert: '\\frac{#?}{#?}', tooltip: 'Fraction' },
    ],
  ],
}

// ∈ ∉ ⊆ ∪ ∩ ∀ ∃ ¬ ∧ ∨ ⇒ ⇔ and the common relations: all the "set theory &
// logic" and "common relations" symbols the user asked for by name. Most
// have a MathLive word-shortcut too (AA, EE, sube, uu, nn, …) but none of
// those are printed on a physical keycap, so — unlike sqrt/sin/log, which
// stay off the keyboard — they get direct taps here. Paired forms (∈/∉,
// ∧/∨, ≤/≥, …) share one key via shift, the same way the built-in Greek
// layer pairs lower/uppercase.
const LOGICSETS_LAYOUT = {
  label: '&isin;&forall;&not;',
  labelClass: 'MLK__tex-math',
  tooltip: 'Logic & sets — quantifiers, connectives, relations',
  rows: [
    [
      { latex: '\\in', shift: '\\notin', class: 'small', tooltip: 'Element of / not an element of' },
      {
        latex: '\\subseteq',
        shift: '\\supseteq',
        class: 'small',
        tooltip: 'Subset / superset (or equal)',
        variants: [
          { latex: '\\subset', aside: 'proper subset', class: 'small' },
          { latex: '\\supset', aside: 'proper superset', class: 'small' },
        ],
      },
      { latex: '\\cup', shift: '\\cap', class: 'small', tooltip: 'Union / intersection' },
      { latex: '\\varnothing', class: 'small', tooltip: 'Empty set' },
      {
        latex: '\\forall',
        shift: '\\exists',
        class: 'small',
        tooltip: 'For all / there exists',
        variants: [{ latex: '\\nexists', aside: 'does not exist', class: 'small' }],
      },
    ],
    [
      { latex: '\\neg', class: 'small', tooltip: 'Logical not' },
      { latex: '\\land', shift: '\\lor', class: 'small', tooltip: 'And / or' },
      {
        latex: '\\Rightarrow',
        shift: '\\Leftrightarrow',
        class: 'small',
        tooltip: 'Implies / if and only if',
        variants: [{ latex: '\\Leftarrow', aside: 'implied by', class: 'small' }],
      },
      {
        latex: '\\to',
        shift: '\\mapsto',
        class: 'small',
        tooltip: 'Maps to / arrow',
        variants: [
          { latex: '\\leftrightarrow', aside: 'iff arrow', class: 'small' },
          { latex: '\\longrightarrow', aside: 'long arrow', class: 'small' },
        ],
      },
      {
        latex: '\\le',
        shift: '\\ge',
        class: 'small',
        tooltip: 'Order & equivalence relations',
        variants: [
          { latex: '\\ne', aside: 'not equal', class: 'small' },
          { latex: '\\approx', aside: 'approximately', class: 'small' },
          { latex: '\\equiv', aside: 'equivalent', class: 'small' },
          { latex: '\\propto', aside: 'proportional to', class: 'small' },
        ],
      },
    ],
  ],
}

// Virtual keyboard: only the layouts a physical keyboard CAN'T provide
// (symbols + calculus + linear algebra + logic/sets + greek — no
// alphabetic, no numeric), and it floats as a movable panel instead of
// docking across the window (position via the CSS vars below; the toolbar
// is the drag handle).
window.mathVirtualKeyboard.layouts = ['symbols', CALCULUS_LAYOUT, LINALG_LAYOUT, LOGICSETS_LAYOUT, 'greek']
let kbDrag = null
document.addEventListener('pointerdown', (e) => {
  const bar = e.target.closest?.('.MLK__toolbar')
  if (!bar || e.target.closest('.layer-switch, [data-command], button, svg')) return
  const cs = getComputedStyle(document.documentElement)
  kbDrag = {
    x: e.clientX, y: e.clientY,
    right: parseFloat(cs.getPropertyValue('--atlas-kb-right')) || 26,
    bottom: parseFloat(cs.getPropertyValue('--atlas-kb-bottom')) || 26,
  }
  e.preventDefault()
})
document.addEventListener('pointermove', (e) => {
  if (!kbDrag) return
  document.documentElement.style.setProperty('--atlas-kb-right', `${Math.max(0, kbDrag.right - (e.clientX - kbDrag.x))}px`)
  document.documentElement.style.setProperty('--atlas-kb-bottom', `${Math.max(0, kbDrag.bottom - (e.clientY - kbDrag.y))}px`)
})
document.addEventListener('pointerup', () => { kbDrag = null })

// Pre-render a formula at boot so the math fonts load long before the first
// math-field mounts: MathLive re-renders when fonts arrive late, which can
// remount its keyboard sink mid-typing and silently drop keystrokes.
const warm = document.createElement('div')
warm.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden'
warm.innerHTML = convertLatexToMarkup('\\sqrt{x^{2}}+\\cos\\pi\\int_0^1')
document.body.append(warm)
document.fonts?.ready?.then(() => warm.remove())

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// A STRETCHY over-accent (\overrightarrow &c.) with a trailing subscript —
// e.g. \overrightarrow{F}_{net} — renders the subscript centered UNDERNEATH
// the accent instead of at the lower-right, because a stretchy accent treats
// a following sub/superscript as an under/over-limit. Wrapping the accent in
// a group first (→ {\overrightarrow{F}}_{net}) makes the subscript attach to
// the group as a normal subscript. This is what MathLive's editor emits when
// you put a vector arrow over an already-subscripted variable.
// ponytail: single non-nested pass; a stretchy accent nested inside another's
// argument isn't rewritten (rare) — a real LaTeX parse is the upgrade path.
const STRETCHY_ACCENTS = ['overrightarrow', 'overleftarrow', 'overleftrightarrow', 'widehat', 'widetilde', 'overline', 'overbrace', 'overparen']
export function fixAccentSubscript(latex) {
  const s = String(latex ?? '')
  let out = '', i = 0
  while (i < s.length) {
    let matched = false
    if (s[i] === '\\') {
      for (const cmd of STRETCHY_ACCENTS) {
        if (!s.startsWith('\\' + cmd + '{', i)) continue
        let depth = 0, j = i + cmd.length + 1 // index of the opening '{'
        for (; j < s.length; j++) {
          if (s[j] === '{') depth++
          else if (s[j] === '}' && --depth === 0) break
        }
        // only regroup when a sub/superscript immediately follows the accent
        if (j < s.length && (s[j + 1] === '_' || s[j + 1] === '^')) {
          out += '{' + s.slice(i, j + 1) + '}'
          i = j + 1
          matched = true
        }
        break
      }
    }
    if (!matched) { out += s[i]; i++ }
  }
  return out
}

// Static LaTeX → markup for view mode (and the equation modal). MathLive
// only emits math markup from PARSED LaTeX — no raw HTML passthrough — so
// the result is safe to inject; invalid input falls back to escaped text.
export function renderMath(latex) {
  try { return `<div class="eq-render"><span class="eq-render__inner">${convertLatexToMarkup(fixAccentSubscript(latex))}</span></div>` }
  catch { return `<div class="eq-render eq-render--invalid">${esc(latex)}</div>` }
}

// Long equations must never scroll — instead the whole expression scales
// down to fit its container (math can't reflow/wrap mid-expression the way
// text can). scrollWidth/offsetHeight are layout-only and unaffected by a
// CSS transform, so re-measuring after a previous shrink is safe without
// resetting it first.
function fitEq(el) {
  const inner = el.querySelector(':scope > .eq-render__inner')
  if (!inner) return
  const natural = inner.scrollWidth
  const avail = el.clientWidth
  if (!natural || !avail) return
  const scale = Math.min(1, avail / natural)
  if (scale >= 0.999) { inner.style.transform = ''; el.style.height = ''; return }
  inner.style.transform = `scale(${scale})`
  // el is box-sizing:border-box (global reset) — its `height` includes
  // padding, so the shrunk content needs that padding added back or the
  // scaled math overflows the (now much shorter) box and gets clipped.
  const cs = getComputedStyle(el)
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
  el.style.height = `${inner.offsetHeight * scale + padY}px`
}
let eqObserver = null
export function fitEquations(rootEl) {
  if (!eqObserver) eqObserver = new ResizeObserver((entries) => { for (const e of entries) fitEq(e.target) })
  eqObserver.disconnect()
  for (const el of rootEl.querySelectorAll('.eq-render:not(.eq-render--invalid)')) {
    fitEq(el)
    eqObserver.observe(el)
  }
}

// The field's ☰ menu (opened by right-click — its on-field button is hidden,
// see styles.css) ships MathLive's full default: matrix row/col ops, matrix
// border style, insert-matrix, a structural "insert" submenu (integral/sum/
// derivative templates), math accents (vector arrows, dots, overline — not
// a font feature), a mode switcher (math/text/raw-LaTeX-source), font
// style/color/background-color submenus, and cut/copy(as 4 formats)/paste/
// select-all. Chancellor: "disable all the font stuff — mode, font style,
// color, background". Keep only the genuinely useful editing actions;
// pruneMenuItems is an allowlist by id, not a denylist, so anything new a
// MathLive upgrade adds shows up OFF by default rather than sneaking back
// in the "font stuff" bucket.
const MENU_KEEP_IDS = new Set([
  'add-row-above', 'add-row-below', 'add-column-before', 'add-column-after',
  'delete-row', 'delete-column',
  'insert-matrix', 'insert', 'accent',
  'cut', 'copy', 'paste', 'select-all',
])
// Pure and side-effect-free (see mathkbd.check.mjs) — takes whatever
// mf.menuItems returns and filters it, so it works whether that's MathLive's
// live default or (idempotently) an already-pruned array from a prior call.
export function pruneMenuItems(items) {
  const kept = (items ?? []).filter((it) =>
    it.type === 'divider' || (it.id ? MENU_KEEP_IDS.has(it.id) : it.submenuClass === 'border-submenu')
  )
  // Filtering strands some dividers at the start/end or back-to-back —
  // collapse those rather than leave orphaned separator lines in the menu.
  const out = []
  for (const it of kept) {
    if (it.type === 'divider' && (!out.length || out[out.length - 1].type === 'divider')) continue
    out.push(it)
  }
  if (out[out.length - 1]?.type === 'divider') out.pop()
  // "Copy" ships 4 export formats (LaTeX/Typst/ASCII-math/MathML) — the
  // "different types" the user doesn't want; only LaTeX ("math print that
  // uses backslashes") stays. MathLive 0.110 gives the LaTeX and Typst
  // entries the SAME id ("copy-latex" — an upstream duplicate), so filter on
  // the LaTeX entry's keyboard shortcut instead, which is unique.
  return out.map((it) =>
    it.id === 'copy' && it.submenu
      ? { ...it, submenu: it.submenu.filter((s) => s.keyboardShortcut === 'meta+C') }
      : it
  )
}

// MathLive disables the spacebar in math mode by default; give it a real
// horizontal space so typing flows naturally in equation fields. Also patch
// its inline-shortcut gaps (merge so the built-ins survive):
//  • -+ → ∓  (MathLive ships +- → ± but not the converse)
//  • arccot / arcsinh / arccoth — MathLive knows arccos/arcsin/arctan/arcsec/
//    arccsc (and most inverse-hyperbolics) but is missing these three, so
//    typing "arccot" gave "arc" as variables followed by \cot.
// Shared by every page that mounts math-fields (Equations widgets, Study).
// Idempotent — it re-runs on every render, and every step here (assigning
// mode/inlineShortcuts/menuItems) is a plain overwrite, safe to repeat on
// the same field or a freshly-mounted one.
export function tuneMathFields(rootEl) {
  for (const mf of rootEl.querySelectorAll('math-field')) {
    mf.mathModeSpace = '\\;'
    mf.inlineShortcuts = {
      ...mf.inlineShortcuts,
      '-+': '\\mp',
      arccot: '\\operatorname{arccot}',
      arcsinh: '\\operatorname{arcsinh}',
      arccoth: '\\operatorname{arccoth}',
    }
    // Pin to math mode edited via LaTeX/backslash commands — the only mode
    // the user wants (the ☰ menu's math/text/latex-source switcher is gone,
    // see pruneMenuItems, but this also forecloses any other path in).
    mf.mode = 'math'
    // mf.menuItems throws until the element's connectedCallback has run;
    // every math-field here was just parsed into a live rootEl via
    // innerHTML, so the custom element upgrade (and thus the mount) already
    // happened synchronously — this is a defensive guard, not an expected
    // throw path.
    try { mf.menuItems = pruneMenuItems(mf.menuItems) } catch { /* not mounted yet */ }
  }
}

// Storage key of the page currently on screen — drawChart re-reads the model
// on every redraw and must read the right page's storage.
let activeKey
export function renderPageInto(contentEl, page, customizing, storageKey) {
  activeKey = storageKey
  if (!page.rows.length) {
    // Only reachable while customizing (view mode renders the app's empty
    // state instead) — one big drop target for the first widget.
    contentEl.innerHTML = `<div class="page-root page-root--empty"><div class="page-empty-drop">Drag a widget here</div></div>`
    observeCharts(contentEl) // no mounts left — releases stale observations
    fitEquations(contentEl)
    return
  }
  contentEl.innerHTML = `<div class="page-root">${page.rows.map((r) => rowHTML(r, customizing)).join('')}</div>`
  tuneMathFields(contentEl)
  observeCharts(contentEl)
  fitEquations(contentEl)
  hydrateCalWidgets(contentEl)
  hydrateCanvasWidgets(contentEl)
}

// In customize mode a resize bar sits in each gutter between adjacent
// columns (the .prow gap is 0 there — the 18px bars ARE the spacing, so
// view/customize column proportions stay identical).
const rowWidth = (row) => {
  const w = Number(row.width)
  return w > 0 && w < 100 ? w : 100
}
const rowStyle = (row) => {
  const parts = []
  if (rowWidth(row) < 100) parts.push(`width:${rowWidth(row)}%`)
  const h = Number(row.height)
  if (h > 0) parts.push(`min-height:${Math.round(h)}px`) // a floor — content can still grow past it
  return parts.length ? ` style="${parts.join(';')}"` : ''
}
// Optional row title above the columns: always an edit field while
// customizing, rendered only when non-empty in view mode.
const rowTitleHTML = (row, cz) => cz
  ? `<input class="pw-field prow-title-input" data-field="rowTitle" value="${esc(row.title ?? '')}" placeholder="Row title (optional)">`
  : (row.title ? `<h2 class="prow-title">${esc(row.title)}</h2>` : '')

const rowHTML = (row, cz) => {
  if (!cz && !rowVisible(row)) return ''
  const cols = cz ? row.cols : row.cols.filter(colVisible)
  return `<div class="prow" data-row-id="${esc(row.id)}"${rowStyle(row)}>
  ${cz ? `<div class="prow-handle" draggable="true" title="Move row">⋮⋮</div>` : ''}
  ${rowTitleHTML(row, cz)}
  <div class="prow-body">
    ${cols.map((c, i) =>
      (cz && i ? `<div class="pcol-resize" data-left-col="${esc(cols[i - 1].id)}" data-right-col="${esc(c.id)}"></div>` : '') + colHTML(c, cz)
    ).join('')}
  </div>
  ${cz ? `<div class="prow-resize" title="Row width"></div><div class="prow-hresize" title="Row height"></div>` : ''}
</div>`
}

const colWidth = (col) => (Number(col.width) > 0 ? Number(col.width) : 1)

const colHTML = (col, cz) => `<div class="pcol" data-col-id="${esc(col.id)}" style="flex:${colWidth(col)} 1 0%">
  ${(cz ? col.sections : col.sections.filter(secVisible)).map((s) => sectionHTML(s, cz)).join('')}
</div>`

// The section is the user-visible group: dashed frame in customize mode and
// an optional title (same treatment as rows, one size down). Sections stack
// vertically inside a column; lines are the shelves inside a section.
const sectionTitleHTML = (sec, cz) => cz
  ? `<input class="pw-field psec-title-input" data-field="secTitle" value="${esc(sec.title ?? '')}" placeholder="Section title (optional)">`
  : (sec.title ? `<h3 class="psec-title">${esc(sec.title)}</h3>` : '')

const sectionHTML = (sec, cz) => {
  const secCtx = {} // per-section render state (e.g. successive "up next" widgets)
  const lines = cz ? sec.lines : sec.lines.filter((l) => !l.widgets.length || lineVisible(l))
  return `<div class="psec" data-sec-id="${esc(sec.id)}">
  ${sectionTitleHTML(sec, cz)}
  ${lines.map((l) => lineHTML(l, cz, secCtx)).join('')}
</div>`
}

// Widgets of a disabled plugin are skipped in VIEW mode only, never deleted —
// they come back when the plugin is re-enabled. Customize mode renders every
// model widget (hidden ones as stubs): drag/drop indices come from the DOM,
// so the DOM must mirror the model 1:1 there or drops land one slot off.
const lineHTML = (line, cz, secCtx) => `<div class="pline" data-line-id="${esc(line.id)}">
  ${(cz ? line.widgets : line.widgets.filter((w) => isKindEnabled(w.kind))).map((w) => widgetHTML(w, cz, secCtx)).join('')}
</div>`

// View-mode visibility: structure whose every widget is hidden renders as
// dead space (a blank flex column, a titled empty row) — skip it instead.
// Customize shows everything. A widget-LESS skeleton the user built on
// purpose (title-only sections) is not touched by any of this.
const lineVisible = (l) => l.widgets.some((w) => isKindEnabled(w.kind))
const secVisible = (s) => s.lines.some(lineVisible) || !s.lines.some((l) => l.widgets.length)
const colVisible = (c) => c.sections.some(secVisible)
const rowVisible = (r) => r.cols.some(colVisible)
export const pageHasHiddenAll = (page) => {
  const all = page.rows.flatMap((r) => r.cols.flatMap((c) => c.sections.flatMap((s) => s.lines.flatMap((l) => l.widgets))))
  return all.length > 0 && !all.some((w) => isKindEnabled(w.kind))
}

export function widgetHTML(w, cz, secCtx = {}) {
  const del = cz ? `<button type="button" class="pw-delete" data-act="delete-widget" title="Delete">×</button>` : ''
  if (!isKindEnabled(w.kind)) {
    // Customize-mode stub for a disabled plugin's widget (view mode filters
    // these out in lineHTML): keeps model↔DOM index parity for drag/drop,
    // and makes the widget visible enough to move or delete while hidden.
    const owner = pluginDef(KIND_PLUGIN[w.kind])
    return `<article class="pwidget pwidget--off card" data-widget-id="${esc(w.id)}" draggable="true">${del}
      <p class="pw-off__name">${esc(owner?.name || w.kind)} widget</p>
      <p class="pw-off__sub">plugin is off — shows again when ${esc(owner?.name || 'its plugin')} is enabled</p>
    </article>`
  }
  if (GYM_KINDS.includes(w.kind)) {
    // Gym widgets are live views over the gym store — no editable title.
    return `<article class="pwidget pwidget--gym pwidget--${esc(w.kind)} card" data-widget-id="${esc(w.id)}"${cz ? ' draggable="true"' : ''}>${del}${gymWidgetHTML(w, cz, secCtx)}</article>`
  }
  if (CAL_KINDS.includes(w.kind)) {
    // Calendar widgets render a placeholder synchronously; hydrateCalWidgets
    // fills them from the (cached) Google Calendar API after each render.
    return `<article class="pwidget pwidget--cal pwidget--${esc(w.kind)} card" data-widget-id="${esc(w.id)}"${cz ? ' draggable="true"' : ''}>${del}${calWidgetHTML(w)}</article>`
  }
  if (CV_KINDS.includes(w.kind)) {
    return `<article class="pwidget pwidget--cv pwidget--${esc(w.kind)} card" data-widget-id="${esc(w.id)}"${cz ? ' draggable="true"' : ''}>${del}${canvasWidgetHTML(w)}</article>`
  }
  if (WK_KINDS.includes(w.kind)) {
    // Work widgets are live views over the local work store — sync render.
    return `<article class="pwidget pwidget--wk pwidget--${esc(w.kind)} card" data-widget-id="${esc(w.id)}"${cz ? ' draggable="true"' : ''}>${del}${workWidgetHTML(w, cz)}</article>`
  }
  if (SL_KINDS.includes(w.kind)) {
    // Sleep widgets are live views over the local sleep store — sync render.
    return `<article class="pwidget pwidget--sl pwidget--${esc(w.kind)} card" data-widget-id="${esc(w.id)}"${cz ? ' draggable="true"' : ''}>${del}${sleepWidgetHTML(w, cz)}</article>`
  }
  const title = cz
    ? `<input class="pw-field pw-field--title" data-field="title" value="${esc(w.title)}" placeholder="Title">`
    : `<h3 class="card__title">${esc(w.title)}</h3>`
  let body
  if (w.kind === 'card') {
    body = cz
      ? `<textarea class="pw-field pw-field--text" data-field="text" rows="3" placeholder="Card text">${esc(w.text)}</textarea>`
      : `<div class="card__body">${esc(w.text)}</div>`
  } else if (w.kind === 'list') {
    body = cz
      ? w.items.map((it, i) =>
          `<div class="pw-list-row"><input class="pw-field" data-field="item" data-index="${i}" value="${esc(it)}"><button type="button" class="pw-item-remove" data-act="remove-item" data-index="${i}" title="Remove item">×</button></div>`
        ).join('') +
        `<button type="button" class="pw-add-item" data-act="add-item">+ Add item</button>`
      : `<ul class="pw-list">${w.items.map((it) => `<li class="pw-list__item">${esc(it)}</li>`).join('')}</ul>`
  } else if (w.kind === 'eqcard') {
    // math-field parses its text content as LaTeX; edits come back as LaTeX
    // via its bubbling input events (handled in customize.js).
    body = cz
      ? `<math-field class="pw-mathfield" data-field="latex" math-virtual-keyboard-policy="manual">${esc(w.latex)}</math-field>`
      : renderMath(w.latex)
  } else if (w.kind === 'eqlist') {
    body = cz
      ? w.items.map((it, i) =>
          `<div class="pw-eq-row" data-index="${i}">
            <span class="pw-eq-grip" title="Drag to reorder">⋮⋮</span>
            <input class="pw-field pw-eq-name" data-field="itemName" data-index="${i}" value="${esc(it.name)}" placeholder="Name">
            <button type="button" class="pw-item-remove" data-act="remove-item" data-index="${i}" title="Remove equation">×</button>
            <math-field class="pw-mathfield" data-field="itemLatex" data-index="${i}" math-virtual-keyboard-policy="manual">${esc(it.latex)}</math-field>
          </div>`
        ).join('') +
        `<button type="button" class="pw-add-item" data-act="add-item">+ Add equation</button>`
      : `<ul class="pw-list pw-eqlist">${w.items.map((it) =>
          `<li class="pw-list__item pw-eqlist__item"><span class="pw-eqlist__name">${esc(it.name)}</span>${renderMath(it.latex)}</li>`
        ).join('')}</ul>`
  } else {
    const controls = cz
      ? `<div class="pw-graph-controls">
          <select class="pw-field pw-field--select" data-field="graphType">
            <option value="bar"${w.graphType === 'bar' ? ' selected' : ''}>Bar</option>
            <option value="line"${w.graphType === 'line' ? ' selected' : ''}>Line</option>
          </select>
          <input class="pw-field" data-field="xLabel" value="${esc(w.xLabel)}" placeholder="X axis label">
          <input class="pw-field" data-field="yLabel" value="${esc(w.yLabel)}" placeholder="Y axis label">
        </div>`
      : ''
    body = `${controls}<div class="chart-mount" data-widget-id="${esc(w.id)}"></div>`
  }
  return `<article class="pwidget pwidget--${esc(w.kind)} card" data-widget-id="${esc(w.id)}"${cz ? ' draggable="true"' : ''}>${del}${title}${body}</article>`
}

// Charts draw at their mount's real pixel size and redraw whenever that box
// changes (drag preview shifts, window resize, zoom). One shared observer,
// re-attached after each render (innerHTML replaces the mounts).
let chartObserver = null
export function observeCharts(rootEl) {
  if (!chartObserver) chartObserver = new ResizeObserver((entries) => { for (const e of entries) drawChart(e.target) })
  chartObserver.disconnect()
  for (const mount of rootEl.querySelectorAll('.chart-mount')) chartObserver.observe(mount)
}

export function drawChart(mount) {
  if (!mount) return
  const f = findWidget(loadPage(activeKey), mount.dataset.widgetId)
  if (!f) return
  const w = Math.round(mount.clientWidth)
  const h = Math.round(mount.clientHeight)
  if (w <= 0 || h <= 0) return
  if (f.widget.kind === 'gymscoregraph') { mount.innerHTML = gymScoreGraphSVG(w, h); return }
  if (f.widget.kind === 'slhours') { mount.innerHTML = sleepHoursChartSVG(w, h); return }
  if (f.widget.kind === 'sldebt') { mount.innerHTML = sleepDebtChartSVG(w, h); return }
  if (f.widget.kind !== 'graph') return
  const g = f.widget
  mount.innerHTML = (g.graphType === 'line' ? lineChart : barChart)(g.points, { w, h, xLabel: g.xLabel, yLabel: g.yLabel })
}
