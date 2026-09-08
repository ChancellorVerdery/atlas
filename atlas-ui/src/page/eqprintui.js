// Print sheet workbench for the Equations page (topbar "Print sheet", left of
// Math keys — Chancellor, 2026-09-08). Three panes: Include (which categories,
// subcategories, lists and equations), Paper & fit (paper, sides, sheets,
// columns, type size, what to show), and the preview with its fit readouts.
// eqprint.js holds the pure layout logic; this file measures real DOM, draws
// the pages, rasterizes them for the print simulation, and opens the
// browser's print dialog with the page size preset.
//
// The sheet is a self-contained document: its CSS (SHEET_CSS), MathLive's
// static markup CSS and every font it uses (embedded as data URIs) travel
// with it into the raster SVG, so the simulation shows the same glyphs the
// printer gets — not a system-font stand-in.
import { renderMath } from './view.js'
import mlStaticRaw from 'mathlive/static.css?raw'
import {
  PAPERS, MIN_SHRINK, SIZE_MIN, SIZE_MAX, PX_PER_IN,
  loadState, saveState, loadCal, saveCal, paperSize, geometry, effDpi, screenPpi,
  buildTree, allLeaves, leavesOf, stateOf, findNode, buildBlocks, flow, solve, legibility,
} from './eqprint.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Styles the printed sheet itself needs — on screen, inside the raster SVG
// (which sees none of the page's stylesheets), and in the print root. One
// string, three homes. Deliberately no '>' combinators or ']]>' so it can sit
// inside the raster's CDATA block verbatim.
const SHEET_CSS = `
.eqp-page { position: relative; background: #fff; color: #111; font-family: "Hanken Grotesk", system-ui, sans-serif; overflow: hidden; box-sizing: border-box; -webkit-font-smoothing: auto; }
.eqp-cols { display: grid; height: 100%; align-items: start; }
.eqp-col { position: relative; display: flex; flex-direction: column; min-width: 0; height: 100%; }
.eqp-col.is-rule::before { content: ''; position: absolute; left: -0.09in; top: 0; bottom: 0; border-left: 0.5px solid #999; }
.eqp-cat { font-family: "Instrument Serif", Georgia, serif; font-weight: 400; font-size: 1.55em; letter-spacing: 0.005em; line-height: 1.1; padding: 0.1em 0 0.15em; border-bottom: 0.6px solid #111; margin-bottom: 0.25em; }
.eqp-sub { font-weight: 700; font-size: 0.82em; text-transform: uppercase; letter-spacing: 0.08em; line-height: 1.2; padding: 0.6em 0 0.3em; color: #222; }
.eqp-list { font-weight: 600; font-size: 0.9em; padding: 0.4em 0 0.2em; color: #333; }
.eqp-eq { padding: 0.12em 0 0.42em; }
.eqp-eq.is-beside { display: flex; align-items: center; gap: 0.6em; }
.eqp-eq.is-beside .eqp-name { flex: 0 0 36%; padding: 0; }
.eqp-eq.is-beside .eqp-math { flex: 1 1 auto; min-width: 0; }
.eqp-name { font-weight: 600; font-size: 0.78em; line-height: 1.25; color: #2a2a2a; padding-bottom: 0.15em; }
.eqp-math .eq-render { font-size: 1em; color: #111; padding: 0; overflow: hidden; line-height: 1.2; }
.eqp-math .eq-render__inner { display: inline-block; transform-origin: left top; }
.eqp-math .eq-render--invalid { font-family: "IBM Plex Mono", Menlo, monospace; font-size: 0.8em; color: #333; word-break: break-all; }
.eqp-label { position: absolute; left: 0; right: 0; text-align: center; font-size: 6pt; color: #555; letter-spacing: 0.08em; text-transform: uppercase; }
`
// MathLive's static stylesheet, minus its @font-face rules (their relative
// fonts/ URLs mean nothing inside an SVG image — sheetFontCSS() embeds the
// same faces as data URIs instead).
const ML_STATIC = mlStaticRaw.replace(/@font-face\s*\{[^}]*\}/g, '')

let sheetStyle = null
function ensureSheetStyle() {
  if (sheetStyle) return
  sheetStyle = document.createElement('style')
  sheetStyle.id = 'eqp-sheet-css'
  sheetStyle.textContent = SHEET_CSS
  document.head.appendChild(sheetStyle)
}

// ---- fonts for the raster ------------------------------------------------------
// Every @font-face the sheet uses, re-declared with the font file inlined as a
// data URI: the KaTeX faces from mathlive/fonts.css (same-origin, so their
// rules are readable) and Hanken Grotesk / Instrument Serif from the Google
// Fonts link (cross-origin → cssRules throws, but the CSS itself is fetchable
// with CORS). Fetched once per session; offline the Google faces simply drop
// out and the raster falls back to system faces for the text, never the math.
const WANT_FAMILY = (f) => /^KaTeX_/.test(f) || f === 'Hanken Grotesk' || f === 'Instrument Serif'
function parseFaces(cssText) {
  const out = []
  for (const m of cssText.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const body = m[1]
    const prop = (k) => (new RegExp(`(?:^|;|\\s)${k}\\s*:\\s*([^;]+)`).exec(body)?.[1] || '').trim()
    const family = prop('font-family').replace(/^["']|["']$/g, '')
    const src = prop('src')
    const url = /url\(["']?([^"')]+)["']?\)\s*format\(["']?woff2/.exec(src)?.[1] || /url\(["']?([^"')]+)["']?\)/.exec(src)?.[1]
    if (family && url) out.push({ family, weight: prop('font-weight') || '400', style: prop('font-style') || 'normal', url, range: prop('unicode-range') })
  }
  return out
}
async function collectFaces() {
  const faces = []
  for (const ss of document.styleSheets) {
    let rules
    try { rules = ss.cssRules } catch { continue } // cross-origin sheet
    for (const r of rules) if (r instanceof CSSFontFaceRule) faces.push(...parseFaces(r.cssText))
  }
  for (const link of document.querySelectorAll('link[rel="stylesheet"][href*="fonts.googleapis.com"]')) {
    try { faces.push(...parseFaces(await (await fetch(link.href)).text())) } catch { /* offline */ }
  }
  return faces
}
const blobToDataURL = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob) })
let fontCssPromise = null
export function sheetFontCSS() {
  if (!fontCssPromise) fontCssPromise = (async () => {
    // Latin blocks only: Google splits each face into unicode-range subsets.
    const faces = (await collectFaces()).filter((f) => WANT_FAMILY(f.family) && (!f.range || /U\+0000/i.test(f.range)))
    // One file can back several weights (Google serves Hanken Grotesk as a
    // variable font): group by file, declare the weight span once.
    const byUrl = new Map()
    for (const f of faces) {
      const key = `${f.url}|${f.family}|${f.style}`
      const g = byUrl.get(key) || { ...f, weights: [] }
      g.weights.push(...String(f.weight).split(/\s+/).map(Number).filter((n) => n > 0))
      byUrl.set(key, g)
    }
    const out = []
    for (const g of byUrl.values()) {
      let data
      try { data = await blobToDataURL(await (await fetch(g.url)).blob()) } catch { continue }
      const lo = Math.min(...g.weights), hi = Math.max(...g.weights)
      out.push(`@font-face{font-family:"${g.family}";font-weight:${lo === hi ? lo : `${lo} ${hi}`};font-style:${g.style};src:url(${data}) format("woff2")}`)
    }
    return out.join('\n')
  })()
  return fontCssPromise
}

// ---- the workbench ---------------------------------------------------------------

const SVG_CHEV = '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M3 1l4 4-4 4z"/></svg>'
const SVG_CK = '<svg class="ck" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 5l2.2 2.2L8 3"/></svg><svg class="mx" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 5h6"/></svg>'

function shellHTML() {
  const seg = (key, opts) => `<div class="eqp-seg" data-seg-of="${key}">${opts.map(([v, l]) => `<button type="button" data-seg="${key}" data-v="${v}">${l}</button>`).join('')}</div>`
  const chk = (key, label) => `<label class="eqp-chk"><input type="checkbox" data-set="${key}"> ${label}</label>`
  return `<div class="eqp">
    <div class="eqp-head">
      <div><p class="eqp-head__eyebrow">Print sheet</p><p class="eqp-head__sum" data-el="summary"></p></div>
      <div class="eqp-head__actions"><button type="button" class="eqp-btn" data-act="done">Done</button><button type="button" class="eqp-btn eqp-btn--primary" data-act="print">Print…</button></div>
    </div>
    <div class="eqp-tool">
      <div class="eqp-pane">
        <div class="eqp-pane__h"><span>Include</span><span><button type="button" class="eqp-lnk" data-act="sel-all">All</button> · <button type="button" class="eqp-lnk" data-act="sel-none">None</button></span></div>
        <div class="eqp-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input data-el="q" placeholder="Filter equations" aria-label="Filter equations"></div>
        <div class="eqp-tree" data-el="tree"></div>
        <div class="eqp-tree-foot"><span><b data-el="cnt-sel">0</b> of <b data-el="cnt-all">0</b> equations</span><span data-el="cnt-groups"></span></div>
      </div>
      <div class="eqp-pane">
        <div class="eqp-pane__h"><span>Paper &amp; fit</span></div>
        <div class="eqp-set">
          <div class="eqp-set__l">Paper</div>
          <div class="eqp-row"><span class="eqp-lab">Size</span><select class="eqp-sel" data-set="paper">${Object.entries(PAPERS).map(([k, p]) => `<option value="${k}">${p.label}${k === 'custom' ? '…' : ` ${p.w} × ${p.h}`}</option>`).join('')}</select></div>
          <div class="eqp-custom" data-el="custom"><span class="eqp-lab">W</span><input class="eqp-num" data-set="customW" type="number" step="0.1" min="2" max="17"><span class="eqp-lab">H</span><input class="eqp-num" data-set="customH" type="number" step="0.1" min="2" max="17"><span class="eqp-sub">in</span></div>
          <div class="eqp-row"><span class="eqp-lab">Orientation</span>${seg('orient', [['portrait', 'Portrait'], ['landscape', 'Landscape']])}</div>
          <div class="eqp-row"><span class="eqp-lab">Margins</span><span><input class="eqp-num" data-set="margin" type="number" step="0.05" min="0" max="1.5"> <span class="eqp-sub">in</span></span></div>
        </div>
        <div class="eqp-set">
          <div class="eqp-set__l">Pages</div>
          <div class="eqp-row"><span class="eqp-lab">Sides</span>${seg('sides', [['1', 'One side'], ['2', 'Front &amp; back']])}</div>
          <div class="eqp-row"><span class="eqp-lab">Sheets</span><span class="eqp-row__r"><span class="eqp-stepper"><button type="button" data-act="pg-dec" aria-label="Fewer sheets">−</button><output data-el="pg-out">1</output><button type="button" data-act="pg-inc" aria-label="More sheets">+</button></span><span class="eqp-sub" data-el="sides-out"></span></span></div>
        </div>
        <div class="eqp-set">
          <div class="eqp-set__l">Columns</div>
          ${seg('cols', [['auto', 'Auto'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5'], ['6', '6']]).replace('eqp-seg', 'eqp-seg eqp-seg--full')}
          ${chk('rules', 'Hairline between columns')}
        </div>
        <div class="eqp-set">
          <div class="eqp-set__l">Type size</div>
          ${seg('sizeMode', [['auto', 'Auto-fit to pages'], ['fixed', 'Fixed']]).replace('eqp-seg', 'eqp-seg eqp-seg--full')}
          <div class="eqp-row"><span class="eqp-lab">Base size</span><span class="eqp-sub" data-el="size-out">—</span></div>
          <input class="eqp-range" data-set="size" type="range" min="${SIZE_MIN}" max="${SIZE_MAX}" step="0.25" aria-label="Base type size in points">
          <p class="eqp-sub eqp-help">Auto-fit finds the largest size where everything lands on your sheets, trying each column count. Long equations shrink to their column, never wrap.</p>
        </div>
        <div class="eqp-set">
          <div class="eqp-set__l">Show</div>
          ${chk('showCat', 'Category headings')}${chk('showSub', 'Subcategory headings')}${chk('showNames', 'Equation names')}
          <div class="eqp-row"><span class="eqp-lab">Name placement</span>${seg('nameStyle', [['above', 'Above'], ['beside', 'Beside']])}</div>
          ${chk('labels', 'Sheet labels in the margin')}
        </div>
        <div class="eqp-set">
          <div class="eqp-set__l">Preview</div>
          ${seg('pv', [['fit', 'Fit'], ['actual', 'Actual size'], ['sim', 'Print sim']]).replace('eqp-seg', 'eqp-seg eqp-seg--full')}
          <div class="eqp-row"><span class="eqp-lab">Printer</span><select class="eqp-sel" data-set="dpi"><option value="150">150 dpi · inkjet draft</option><option value="300">300 dpi · typical</option><option value="600">600 dpi · laser</option><option value="1200">1200 dpi · photo</option></select></div>
          <div class="eqp-row"><span class="eqp-lab">Ink</span>${seg('ptype', [['laser', 'Laser · hard dots'], ['inkjet', 'Inkjet · soft']])}</div>
          ${chk('loupe', 'Loupe on hover (¼ inch square)')}${chk('dots1', '1 printer dot = 1 screen pixel')}
          <div class="eqp-row"><span class="eqp-lab">Screen scale</span><span><span class="eqp-sub" data-el="cal-out"></span> · <button type="button" class="eqp-lnk" data-act="cal-open">Calibrate</button></span></div>
        </div>
      </div>
      <div class="eqp-pane eqp-preview">
        <div class="eqp-readout">
          <div class="eqp-ro" data-el="ro-size"><div class="eqp-ro__l">Solved size</div><div class="eqp-ro__v">—</div><div class="eqp-ro__s"></div></div>
          <div class="eqp-ro" data-el="ro-sides"><div class="eqp-ro__l">Sides used</div><div class="eqp-ro__v">—</div><div class="eqp-ro__s"></div></div>
          <div class="eqp-ro" data-el="ro-leg"><div class="eqp-ro__l">Smallest text on paper</div><div class="eqp-ro__v">—</div><div class="eqp-ro__s"></div></div>
        </div>
        <div class="eqp-warn" data-el="warn"></div>
        <div class="eqp-well" data-el="well"><div class="eqp-well__inner" data-el="pages"></div><div class="eqp-note" data-el="note"></div></div>
        <div class="eqp-loupe" data-el="loupe"><canvas data-el="loupe-c" width="468" height="468"></canvas><div class="eqp-loupe__l"><span data-el="loupe-l"></span><span data-el="loupe-r"></span></div></div>
      </div>
    </div>
    <div class="eqp-measure" data-el="measure" aria-hidden="true"></div>
    <div class="eqp-pop" data-el="pop">
      <div class="eqp-pop__card">
        <h3>Calibrate actual size</h3>
        <p>Hold a credit card against the screen and drag until the outline matches its edges. Atlas then knows how many screen pixels make one printed inch, so “Actual size” and the print simulation are true to scale.</p>
        <div class="eqp-cc"><div class="eqp-cc__box" data-el="cc-box">3.370 × 2.125 in</div></div>
        <div class="eqp-pop__row"><input class="eqp-range" data-set="cal" type="range" min="0.7" max="1.5" step="0.005"><output data-el="cal-o"></output></div>
        <div class="eqp-pop__actions"><button type="button" class="eqp-btn" data-act="cal-cancel">Cancel</button><button type="button" class="eqp-btn eqp-btn--primary" data-act="cal-ok">Save</button></div>
      </div>
    </div>
  </div>`
}

// Mount the workbench into contentEl for the given equations board. onDone
// is the renderer's "leave print mode" (Done button; the topbar toggle does
// the same through the renderer).
export function renderPrintSheet(contentEl, { page, onDone }) {
  ensureSheetStyle()
  const tree = buildTree(page)
  const ALL = allLeaves(tree)
  const leafIds = new Set(ALL.map((l) => l.id))
  const st = loadState()
  const S = st.settings
  let cal = loadCal()
  // First visit selects everything; afterwards the saved picks come back
  // (minus anything since deleted from the board).
  const sel = new Set(st.sel ? st.sel.filter((id) => leafIds.has(id)) : ALL.map((l) => l.id))
  const open = new Set(tree.map((c) => c.id))
  let query = ''

  contentEl.innerHTML = shellHTML()
  const root = contentEl.querySelector('.eqp')
  const el = (name) => root.querySelector(`[data-el="${name}"]`)
  const persist = () => { try { saveState(S, sel) } catch { /* quota */ } }

  // ---- include tree ----
  function renderTree() {
    const out = []
    const q = query.trim().toLowerCase()
    const walk = (n, depth) => {
      const st = stateOf(n, sel)
      if (q && !leavesOf(n).some((l) => l.label.toLowerCase().includes(q)) && !(n.label || '').toLowerCase().includes(q)) return
      const isOpen = q ? true : open.has(n.id)
      const untitled = !n.label
      out.push(`<div class="eqp-tnode${st === 'off' ? ' is-off' : ''}${isOpen ? ' is-open' : ''}" data-id="${esc(n.id)}" data-kind="${n.kind}" style="--depth:${depth}">
        <button type="button" class="eqp-tchev${n.leaf ? ' is-leaf' : ''}" data-act="open" aria-label="Expand">${SVG_CHEV}</button>
        <button type="button" class="eqp-tcheck is-${st}" data-act="toggle" role="checkbox" aria-checked="${st === 'on' ? 'true' : st === 'mixed' ? 'mixed' : 'false'}" aria-label="Include ${esc(n.label || 'group')}">${SVG_CK}</button>
        <span class="eqp-tlabel${untitled ? ' is-untitled' : ''}" data-act="toggle">${esc(n.label || (n.kind === 'cat' ? 'Ungrouped' : 'Untitled'))}</span><span class="eqp-tcount">${n.leaf ? '' : leavesOf(n).length}</span></div>`)
      if (!n.leaf && isOpen) n.children.forEach((c) => walk(c, depth + 1))
    }
    tree.forEach((c) => walk(c, 0))
    el('tree').innerHTML = out.join('') || '<p class="eqp-empty">No equations on this board yet — add cards or lists in Customize first.</p>'
    el('cnt-sel').textContent = sel.size
    el('cnt-all').textContent = ALL.length
    const subs = tree.flatMap((c) => c.children.filter((x) => x.kind === 'sub'))
    el('cnt-groups').textContent = `${tree.length} categor${tree.length === 1 ? 'y' : 'ies'} · ${subs.length} sub`
  }

  // ---- controls ↔ state ----
  function syncControls() {
    root.querySelectorAll('[data-seg]').forEach((b) => b.classList.toggle('is-on', String(S[b.dataset.seg]) === b.dataset.v))
    root.querySelectorAll('input[type="checkbox"][data-set]').forEach((c) => { c.checked = !!S[c.dataset.set] })
    root.querySelectorAll('select[data-set]').forEach((s) => { s.value = String(S[s.dataset.set]) })
    for (const k of ['margin', 'customW', 'customH']) root.querySelector(`[data-set="${k}"]`).value = S[k]
    const size = root.querySelector('[data-set="size"]'); size.value = S.size; size.disabled = S.sizeMode === 'auto'
    el('custom').classList.toggle('is-on', S.paper === 'custom')
    el('pg-out').value = S.pages
    const n = S.pages * S.sides
    el('sides-out').textContent = `= ${n} side${n === 1 ? '' : 's'}`
    el('cal-out').textContent = cal.toFixed(3)
  }

  // ---- blocks + measurement ----
  // Block nodes live in the off-screen measure box; pages get clones. The
  // measure box has the sheet's font and the column's width, so heights read
  // there are the heights the flow will see on paper.
  let blocks = [], nodes = []
  function buildNodes() {
    blocks = buildBlocks(tree, sel, S)
    const m = el('measure')
    m.innerHTML = ''
    nodes = blocks.map((b) => {
      const d = document.createElement('div')
      if (b.t !== 'eq') { d.className = 'eqp-' + b.t; d.textContent = b.text }
      else {
        d.className = 'eqp-eq' + (S.nameStyle === 'beside' && S.showNames ? ' is-beside' : '')
        d.innerHTML = `${S.showNames ? `<div class="eqp-name">${esc(b.name)}</div>` : ''}<div class="eqp-math">${renderMath(b.latex)}</div>`
      }
      m.appendChild(d)
      return d
    })
  }
  // Shrink-to-column, same idea as view.js's fitEq but batched (all reads,
  // then all writes) so a pass costs a couple of reflows, not one per equation.
  function fitAt(sizePt, k, g) {
    const m = el('measure')
    m.style.width = g.cw + 'px'
    m.style.fontSize = sizePt + 'pt'
    const eqs = []
    nodes.forEach((n, i) => {
      if (blocks[i].t !== 'eq') return
      const box = n.querySelector('.eq-render'), inner = box?.querySelector('.eq-render__inner')
      if (!inner) return
      eqs.push({ box, inner, natural: inner.offsetWidth, avail: box.clientWidth, h: inner.offsetHeight })
    })
    let minScale = 1
    for (const e of eqs) {
      const sc = e.natural && e.avail ? Math.min(1, e.avail / e.natural) : 1
      e.inner.style.transform = sc < 0.999 ? `scale(${sc})` : ''
      e.box.style.height = sc < 0.999 ? `${e.h * sc}px` : ''
      if (sc < minScale) minScale = sc
    }
    const heights = nodes.map((n) => n.offsetHeight)
    const cols = flow(blocks, heights, g.ch)
    return { sides: Math.ceil(cols.length / k), minScale, cols }
  }

  // ---- render ----
  let sol = null, pageEls = [], simCanvases = []
  function render() {
    buildNodes()
    if (!blocks.length) { pageEls = []; el('pages').innerHTML = ''; setReadout(null); return }
    sol = solve(S, fitAt)
    if (!sol) { pageEls = []; el('pages').innerHTML = ''; setReadout(null); return }
    const { k, size } = sol
    const g = geometry(S, k)
    const lim = S.pages * S.sides
    const { cols } = fitAt(size, k, g) // leaves the nodes fitted at the winning size
    const sidesNeeded = Math.ceil(cols.length / k)
    const sidesShown = Math.min(sidesNeeded, lim)
    sol.sidesNeeded = sidesNeeded
    sol.dropped = cols.slice(sidesShown * k).flat().filter((i) => blocks[i].t === 'eq').length
    sol.leg = legibility(size, sol.minScale, S.dpi, blocks.some((b) => b.t === 'eq' && /[_^]/.test(b.latex)))
    const first = tree.find((c) => leavesOf(c).some((l) => sel.has(l.id)))
    const host = el('pages')
    host.innerHTML = ''
    pageEls = []; simCanvases = []
    for (let sIdx = 0; sIdx < sidesShown; sIdx++) {
      const pg = document.createElement('div')
      pg.className = 'eqp-page'
      pg.style.cssText = `width:${g.W}px;height:${g.H}px;padding:${g.mg}px ${g.mg}px ${g.mg + g.label}px`
      const grid = document.createElement('div')
      grid.className = 'eqp-cols'
      grid.style.cssText = `grid-template-columns:repeat(${k},minmax(0,1fr));column-gap:${g.gut}px;font-size:${size}pt`
      for (let c = 0; c < k; c++) {
        const col = document.createElement('div')
        col.className = 'eqp-col' + (S.rules && c > 0 ? ' is-rule' : '')
        for (const i of (cols[sIdx * k + c] || [])) col.appendChild(nodes[i].cloneNode(true))
        grid.appendChild(col)
      }
      pg.appendChild(grid)
      const sideName = S.sides === 2 ? (sIdx % 2 ? 'back' : 'front') : 'one side'
      const sheetNo = Math.floor(sIdx / S.sides) + 1
      if (S.labels) {
        const lb = document.createElement('div')
        lb.className = 'eqp-label'
        lb.style.bottom = Math.max(2, g.mg * 0.35) + 'px'
        lb.textContent = `${first?.label || 'Equations'} · sheet ${sheetNo}${S.sides === 2 ? ' ' + sideName : ''}`
        pg.appendChild(lb)
      }
      pageEls.push(pg)
      const slot = document.createElement('div')
      slot.className = 'eqp-slot'
      const cap = document.createElement('div')
      cap.className = 'eqp-slot__cap'
      cap.textContent = `Sheet ${sheetNo} · ${sideName} · ${g.Win} × ${g.Hin} in`
      slot.appendChild(cap)
      if (S.pv === 'sim') { const cv = document.createElement('canvas'); cv.className = 'eqp-sim is-pending'; slot.appendChild(cv) }
      else { const sc = document.createElement('div'); sc.className = 'eqp-scale'; sc.appendChild(pg); slot.appendChild(sc) }
      host.appendChild(slot)
    }
    layoutSlots()
    if (S.pv === 'sim') rasterizeAll()
    setReadout(sol)
  }
  function layoutSlots() {
    const [Win, Hin] = paperSize(S)
    const W = Win * PX_PER_IN, H = Hin * PX_PER_IN
    const well = el('well')
    const scale = S.pv === 'fit' ? Math.max(0.05, Math.min((well.clientWidth - 56) / W, (well.clientHeight - 90) / H, 2)) : cal
    const dpr = window.devicePixelRatio || 1, dpi = effDpi(S)
    root.querySelectorAll('.eqp-slot').forEach((slot) => {
      const cv = slot.querySelector('.eqp-sim')
      const w = cv && S.dots1 ? Math.round(Win * dpi) / dpr : W * scale
      const h = cv && S.dots1 ? Math.round(Hin * dpi) / dpr : H * scale
      slot.style.width = w + 'px'; slot.style.height = h + 'px'
      const sc = slot.querySelector('.eqp-scale'); if (sc) sc.style.transform = `scale(${scale})`
      if (cv) { cv.style.width = w + 'px'; cv.style.height = h + 'px'; cv.classList.toggle('is-1to1', S.dots1) }
    })
    const ppi = screenPpi(cal, dpr)
    const ink = S.ptype === 'laser' ? 'hard dots' : 'soft ink'
    const capNote = dpi !== S.dpi ? ` · capped at ${dpi} dpi for this paper size` : ''
    el('note').textContent = S.pv === 'fit' ? `Fit to window · ${Math.round(scale * 100)}% of actual size`
      : S.pv === 'actual' ? `Actual size · 1 in on paper = ${(PX_PER_IN * cal).toFixed(0)} px on this screen (calibrate if a ruler disagrees)`
      : S.dots1 ? `${dpi} dpi ${ink} · every printer dot is one screen pixel, so the page shows at ${Math.round(100 * ppi / dpi)}% of paper size${capNote}`
      : `${dpi} dpi ${ink} · actual size · this screen is ≈${ppi} ppi and averages finer dots, so use the loupe or 1:1${capNote}`
  }

  // ---- readouts ----
  function setReadout(s) {
    const ro = (name, v, sub, bad) => { const r = el(name); r.classList.toggle('is-bad', !!bad); r.querySelector('.eqp-ro__v').innerHTML = v; r.querySelector('.eqp-ro__s').textContent = sub }
    const lim = S.pages * S.sides
    const warn = el('warn')
    const paperLabel = PAPERS[S.paper]?.label || 'Custom'
    if (!s) {
      ro('ro-size', '—', ALL.length ? 'Nothing selected' : 'No equations on this board'); ro('ro-sides', `0 / ${lim}`, ''); ro('ro-leg', '—', '')
      warn.classList.remove('is-on')
      el('summary').innerHTML = ALL.length ? 'Pick equations on the left to start a sheet.' : 'This board has no equations yet.'
      el('size-out').textContent = '—'
      return
    }
    const shrink = `longest equation at ${Math.round(s.minScale * 100)}% width`
    ro('ro-size', `${s.size} pt<small>${s.k} column${s.k > 1 ? 's' : ''}</small>`,
      s.loose ? `Only fits by shrinking long equations below ${Math.round(MIN_SHRINK * 100)}% · ${shrink}`
        : S.sizeMode === 'auto' ? `Largest size that fits ${lim} side${lim > 1 ? 's' : ''} · ${shrink}` : `Fixed size · ${shrink}`, !!s.loose)
    ro('ro-sides', `${Math.min(s.sidesNeeded, lim)} / ${lim}`,
      s.fits ? `${S.pages} sheet${S.pages > 1 ? 's' : ''} of ${paperLabel}, ${S.sides === 2 ? 'front and back' : 'one side'}` : `Needs ${s.sidesNeeded} sides at this size`, !s.fits)
    const d = s.leg.dots, dots = Math.round(d)
    const cls = s.leg.grade === 'good' ? '' : s.leg.grade === 'marginal' ? 'is-warn' : 'is-bad'
    const worst = (() => { let m = 1, name = ''; nodes.forEach((n, i) => { if (blocks[i].t !== 'eq') return; const t = n.querySelector('.eq-render__inner')?.style.transform; const sc = t ? parseFloat(t.slice(6)) : 1; if (sc < m) { m = sc; name = blocks[i].name } }); return name })()
    ro('ro-leg', `<span class="eqp-dot ${cls}"></span>${s.leg.effPt.toFixed(1)} pt<small>${s.leg.grade}</small>`,
      `${s.leg.xhPt.toFixed(1)} pt subscripts = ${dots} dot${dots === 1 ? '' : 's'} @ ${S.dpi} dpi${worst ? ` · “${worst}”` : ' · nothing shrinks'}`, d < 5)
    el('size-out').textContent = `${s.size} pt`
    if (S.sizeMode === 'auto') root.querySelector('[data-set="size"]').value = s.size
    warn.classList.toggle('is-on', !s.fits)
    if (!s.fits) warn.innerHTML = S.sizeMode === 'fixed'
      ? `<b>${s.dropped} equation${s.dropped === 1 ? '' : 's'} won't fit</b> at ${s.size} pt on ${lim} side${lim > 1 ? 's' : ''}. Add a sheet, use both sides, or switch to Auto-fit.`
      : `<b>Even at ${SIZE_MIN} pt this doesn't fit</b> on ${lim} side${lim > 1 ? 's' : ''} — ${s.dropped} equation${s.dropped === 1 ? '' : 's'} cut. Add a sheet or deselect a category.`
    const eqs = blocks.filter((b) => b.t === 'eq').length
    el('summary').innerHTML = `<b>${eqs}</b> equation${eqs === 1 ? '' : 's'} · <b>${esc(paperLabel)}</b> ${S.orient} · <b>${S.pages}</b> sheet${S.pages > 1 ? 's' : ''}, ${S.sides === 2 ? 'front &amp; back' : 'one side'} · ${s.k} col · ${s.size} pt`
  }

  // ---- print simulation ----
  function pageSVG(pg, css) {
    const w = parseFloat(pg.style.width), h = parseFloat(pg.style.height)
    const xhtml = new XMLSerializer().serializeToString(pg)
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml"><style><![CDATA[${css.replace(/\]\]>/g, ']] >')}]]></style>${xhtml}</div></foreignObject></svg>`
  }
  // A laser RIP has no grey: every dot is on or off. Threshold the
  // anti-aliased raster so thin fraction bars and subscripts drop out the way
  // they do on paper; 170/255 mimics a RIP's minimum stroke width plus toner
  // gain (hairlines survive, everything gets a touch bolder). Safari taints a
  // canvas that drew a foreignObject image, so getImageData can throw there:
  // fall back to a contrast filter, or to soft ink with a note.
  function harden(ctx, w, h, img) {
    try {
      const im = ctx.getImageData(0, 0, w, h), d = im.data
      for (let i = 0; i < d.length; i += 4) { const v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) < 170 ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255 }
      ctx.putImageData(im, 0, 0)
      return 'exact'
    } catch { /* tainted */ }
    if ('filter' in ctx) {
      try { ctx.filter = 'grayscale(1) contrast(60)'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h); ctx.filter = 'none'; return 'approx' } catch { /* fall through */ }
    }
    return 'none'
  }
  async function rasterizeAll() {
    const mine = pageEls
    const dpi = effDpi(S)
    const [Win, Hin] = paperSize(S)
    let fontCss = ''
    try { fontCss = await sheetFontCSS() } catch { /* raster falls back to system faces */ }
    if (pageEls !== mine) return // a newer render replaced these pages
    const css = ML_STATIC + '\n' + fontCss + '\n' + SHEET_CSS
    const slots = root.querySelectorAll('.eqp-slot')
    let hardened = ''
    for (let i = 0; i < mine.length; i++) {
      if (pageEls !== mine) return
      const cv = slots[i]?.querySelector('.eqp-sim')
      if (!cv) continue
      const dw = Math.round(Win * dpi), dh = Math.round(Hin * dpi)
      cv.width = dw; cv.height = dh
      // A data: URL, not a blob: URL — Chromium taints the canvas for a
      // foreignObject SVG loaded through blob:, which would kill the exact
      // hard-dot pass (getImageData) and the loupe; data: stays clean.
      const img = new Image()
      await new Promise((res) => { img.onload = res; img.onerror = res; img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(pageSVG(mine[i], css)) })
      if (pageEls !== mine) return
      const ctx = cv.getContext('2d')
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, dw, dh)
      try {
        ctx.drawImage(img, 0, 0, dw, dh)
        if (S.ptype === 'laser') hardened = harden(ctx, dw, dh, img)
      } catch { ctx.fillStyle = '#c33'; ctx.font = '24px sans-serif'; ctx.fillText('This browser blocked the raster preview', 40, 60) }
      cv.classList.remove('is-pending')
      cv.dataset.dpi = dpi
      simCanvases[i] = cv
      cv.addEventListener('pointermove', onLoupe)
      cv.addEventListener('pointerleave', () => el('loupe').classList.remove('is-on'))
    }
    layoutSlots()
    if (hardened === 'none') el('note').textContent += ' · this browser blocked the hard-dot pass, showing soft ink'
  }
  function onLoupe(e) {
    if (!S.loupe) return
    const cv = e.currentTarget, dpi = +cv.dataset.dpi, r = cv.getBoundingClientRect()
    const x = (e.clientX - r.left) / r.width * cv.width, y = (e.clientY - r.top) / r.height * cv.height
    const side = Math.round(dpi / 4) // a quarter inch, whatever the dpi — so dpis compare fairly
    const lc = el('loupe-c'), ctx = lc.getContext('2d')
    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, lc.width, lc.height)
    ctx.drawImage(cv, Math.round(x - side / 2), Math.round(y - side / 2), side, side, 0, 0, lc.width, lc.height)
    el('loupe-l').textContent = `${dpi} dpi · ${S.ptype === 'laser' ? 'hard' : 'soft'}`
    el('loupe-r').textContent = `¼ in = ${side}² dots`
    el('loupe').classList.add('is-on')
  }

  // ---- print ----
  // In place, through the browser's own dialog: a print root of unscaled
  // pages appears, everything else hides (styles.css @media print), @page is
  // set to the paper so nothing gets re-fitted, and the dialog's duplex
  // setting does the front/back. Cleaned up on afterprint.
  function printSheet() {
    if (!pageEls.length) return
    const [Win, Hin] = paperSize(S)
    document.querySelector('.eqp-print-root')?.remove()
    const pr = document.createElement('div')
    pr.className = 'eqp-print-root'
    const st = document.createElement('style')
    st.textContent = `@page { size: ${Win}in ${Hin}in; margin: 0; }`
    pr.appendChild(st)
    for (const pg of pageEls) pr.appendChild(pg.cloneNode(true))
    document.body.appendChild(pr)
    document.body.classList.add('eqp-printing')
    const done = () => { pr.remove(); document.body.classList.remove('eqp-printing'); window.removeEventListener('afterprint', done) }
    window.addEventListener('afterprint', done)
    setTimeout(done, 120000)
    window.print()
  }

  // ---- events ----
  let raf = 0
  const schedule = () => { persist(); cancelAnimationFrame(raf); raf = requestAnimationFrame(render) }
  root.addEventListener('click', (e) => {
    const seg = e.target.closest('[data-seg]')
    if (seg) {
      const key = seg.dataset.seg
      S[key] = key === 'sides' ? +seg.dataset.v : seg.dataset.v
      if (key === 'loupe' && !S.loupe) el('loupe').classList.remove('is-on')
      syncControls(); schedule()
      return
    }
    const act = e.target.closest('[data-act]')
    if (!act) return
    const a = act.dataset.act
    if (a === 'open' || a === 'toggle') {
      const id = act.closest('.eqp-tnode')?.dataset.id
      const n = id && findNode(tree, id)
      if (!n) return
      if (a === 'open') { open.has(id) ? open.delete(id) : open.add(id); renderTree(); return }
      const on = stateOf(n, sel) !== 'on'
      for (const l of leavesOf(n)) on ? sel.add(l.id) : sel.delete(l.id)
      renderTree(); schedule()
    } else if (a === 'sel-all') { ALL.forEach((l) => sel.add(l.id)); renderTree(); schedule() }
    else if (a === 'sel-none') { sel.clear(); renderTree(); schedule() }
    else if (a === 'pg-dec') { S.pages = Math.max(1, S.pages - 1); syncControls(); schedule() }
    else if (a === 'pg-inc') { S.pages = Math.min(20, S.pages + 1); syncControls(); schedule() }
    else if (a === 'cal-open') {
      const r = root.querySelector('[data-set="cal"]'); r.value = cal
      el('cc-box').style.setProperty('--cal', cal); el('cal-o').textContent = `1 in = ${(PX_PER_IN * cal).toFixed(1)} px`
      el('pop').classList.add('is-on')
    } else if (a === 'cal-cancel') el('pop').classList.remove('is-on')
    else if (a === 'cal-ok') { cal = +root.querySelector('[data-set="cal"]').value; try { saveCal(cal) } catch { /* quota */ } el('pop').classList.remove('is-on'); syncControls(); schedule() }
    else if (a === 'print') printSheet()
    else if (a === 'done') onDone?.()
  })
  root.addEventListener('input', (e) => {
    const t = e.target
    if (t === el('q')) { query = t.value; renderTree(); return }
    const key = t.dataset.set
    if (!key) return
    if (key === 'cal') { el('cc-box').style.setProperty('--cal', t.value); el('cal-o').textContent = `1 in = ${(PX_PER_IN * +t.value).toFixed(1)} px`; return }
    if (key === 'size') { S.size = +t.value; el('size-out').textContent = `${S.size} pt`; schedule(); return }
    if (key === 'margin' || key === 'customW' || key === 'customH') { S[key] = Math.max(0, +t.value || 0); schedule() }
  })
  root.addEventListener('change', (e) => {
    const t = e.target, key = t.dataset.set
    if (!key) return
    if (t.type === 'checkbox') { S[key] = t.checked; if (key === 'loupe' && !S.loupe) el('loupe').classList.remove('is-on'); schedule(); return }
    if (key === 'paper') {
      S.paper = t.value
      // Index cards default to landscape with slim margins; paper to portrait.
      const card = !!PAPERS[S.paper]?.card
      S.orient = card ? 'landscape' : 'portrait'
      S.margin = card ? 0.15 : 0.3
      syncControls(); schedule()
    } else if (key === 'dpi') { S.dpi = +t.value; schedule() }
  })
  // Fit-to-window follows the pane, not the window: sidebar drawer, resizes.
  new ResizeObserver(() => { if (root.isConnected) layoutSlots() }).observe(el('well'))

  syncControls()
  renderTree()
  render()
}
