// Graph plugin UI: the full-window graph page and the view-only dashboard
// widget. 2D renders with vis-network — the SAME engine and options graphify's
// exported graph.html uses, so the board is pixel-identical to it (minus the
// navigator sidebar, deliberately not ported). 3D renders with 3d-force-graph
// styled as the closest possible twin. Libs load on demand — three.js only
// downloads if 3D mode is used, vis-network only on graph surfaces.

import {
  loadGraphStore, saveGraphStore, pickFolder, fetchGraph, buildGraph,
  fileURL, revealFile, watchEvents, prepGraphData, MD_RE,
} from './graph.js'
import { sanitizeHTML } from './canvasui.js'
import { marked } from 'marked'
// force-graph's own physics engine (3D-only here): collide keeps spheres apart.
import { forceCollide } from 'd3-force-3d'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const GF_KINDS = ['gfgraph']

const visLoad = () => import('vis-network/standalone/esm/vis-network.js')
const fg3d = () => import('3d-force-graph').then((m) => m.default)

// Tableau-10, in graphify's community order — the same colors graph.html uses.
const PALETTE = ['#4E79A7', '#F28E2B', '#E15759', '#76B7B2', '#59A14F', '#EDC948', '#B07AA1', '#FF9DA7', '#9C755F', '#BAB0AC']
const BG = '#0f0f1a' // graphify board background
const nodeColor = (n) => PALETTE[(n.community ?? 0) % PALETTE.length]
const dirName = (dir) => dir.split('/').filter(Boolean).pop() || dir

// ---- graph.html's exact vis-network data shape + options ----------------------

// Mirrors graphify's own exporter: dot nodes colored by community (white fill on
// highlight), labels only on the top-connected nodes, edges inherit the source
// node's color at 0.7 opacity, dashed when INFERRED, small arrowheads.
function toVisNodes(nodes) {
  return nodes.map((n) => {
    const c = nodeColor(n)
    return {
      id: n.id, label: n.label, size: n.size,
      color: { background: c, border: c, highlight: { background: '#ffffff', border: c } },
      font: { size: n.labeled ? 12 : 0, color: '#ffffff' },
      title: n.file ? `${n.label} — ${n.file}` : n.label,
      _label: n.label, _file: n.file, _ftype: n.ftype, _ntype: n.ntype, _community: n.community,
    }
  })
}
const toVisEdges = (links) => links.map((l, i) => ({
  id: i,
  from: typeof l.source === 'object' ? l.source.id : l.source,
  to: typeof l.target === 'object' ? l.target.id : l.target,
  title: `${l.relation || 'related'} [${l.inferred ? 'INFERRED' : 'EXTRACTED'}]`,
  dashes: !!l.inferred,
  width: 2,
  color: { opacity: 0.7 }, // color itself inherits from the source node (vis default)
  arrows: { to: { enabled: true, scaleFactor: 0.5 } },
}))

// Verbatim from graphify's graph.html (only the container/data differ).
const VIS_OPTIONS = {
  physics: {
    enabled: true,
    solver: 'forceAtlas2Based',
    forceAtlas2Based: {
      gravitationalConstant: -60,
      centralGravity: 0.005,
      springLength: 120,
      springConstant: 0.08,
      damping: 0.4,
      avoidOverlap: 0.8,
    },
    stabilization: { iterations: 200, fit: true },
  },
  interaction: {
    hover: true,
    tooltipDelay: 100,
    hideEdgesOnDrag: true,
    navigationButtons: false,
    keyboard: false,
  },
  nodes: { shape: 'dot', borderWidth: 1.5 },
  edges: { smooth: { type: 'continuous', roundness: 0.2 }, selectionWidth: 3 },
}

// ---- page state ----------------------------------------------------------------

// Page-scoped session state. The EventSource must not outlive the page —
// closed on re-render and on route change.
const pg = { network: null, nodesDS: null, edgesDS: null, graph: null, es: null, raw: null, dir: null, sel: null, onSettled: null }

function teardown() {
  pg.es?.close()
  pg.es = null
  pg.network?.destroy?.()
  pg.network = null
  pg.nodesDS = pg.edgesDS = null
  pg.graph?._destructor?.()
  pg.graph = null
  pg.onSettled = null
}
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/graph')) teardown() })

export function renderGraphPage(root) {
  teardown()
  if (localStorage.getItem('atlas.devMode') === '1') window.__gf = pg // test hook
  const s = loadGraphStore()
  root.innerHTML = `<div class="gf">
    <div class="gf-bar">
      <button type="button" class="gym-btn" data-gf="pick">${s.dir ? 'Change folder…' : 'Choose folder…'}</button>
      ${s.dir ? `<span class="gf-dir" title="${esc(s.dir)}">${esc(dirName(s.dir))}</span>` : ''}
      <span class="gf-pills">
        <button type="button" class="wk-pill${s.mode === '2d' ? ' is-on' : ''}" data-gf="mode" data-v="2d">2D</button>
        <button type="button" class="wk-pill${s.mode === '3d' ? ' is-on' : ''}" data-gf="mode" data-v="3d">3D</button>
      </span>
      <span class="gf-pills">
        <button type="button" class="wk-pill${!s.mdOnly ? ' is-on' : ''}" data-gf="md" data-v="">All files</button>
        <button type="button" class="wk-pill${s.mdOnly ? ' is-on' : ''}" data-gf="md" data-v="1">Markdown</button>
      </span>
      <label class="gf-maxnodes">Max nodes
        <input type="number" class="pw-field wk-num" min="50" step="50" data-gf="maxnodes" value="${esc(s.maxNodes)}" title="Graphs past this size render only the top-connected nodes" aria-label="Maximum nodes to render">
      </label>
      <span class="gf-status" id="gf-status"></span>
    </div>
    <div class="gf-stage" id="gf-stage">${s.dir ? '' : `
      <div class="gf-empty">
        <p class="gym-empty">Pick a directory and Atlas maps it into a knowledge graph with graphify.</p>
        <button type="button" class="gym-btn" data-gf="pick">Choose folder…</button>
      </div>`}
    </div>
    <div class="gf-card" id="gf-card" hidden></div>
  </div>`

  root.onclick = onPageClick
  root.onchange = onMaxNodesChange
  if (s.dir) openDir(s.dir, root)
}

const setStatus = (t, live = false) => {
  const el = document.getElementById('gf-status')
  if (el) { el.textContent = t; el.classList.toggle('is-live', live) }
}

const statusText = (data, live) =>
  `${data.nodes.length} nodes · ${data.links.length} links` +
  (data.capped ? ` — showing top ${data.capped.shown} of ${data.capped.total} by connections` : '') +
  (live ? ' · live' : '')

async function openDir(dir, root) {
  pg.dir = dir
  try {
    let raw = await fetchGraph(dir)
    if (!raw) {
      setStatus('Building graph… (first scan of this folder)')
      await buildGraph(dir)
      raw = await fetchGraph(dir)
      if (!raw) throw new Error('graphify produced no graph — is the folder empty?')
    } else {
      // stale-while-revalidate, deferred until the layout exists so the CLI
      // rebuild never competes with stabilization for CPU.
      pg.onSettled = () => buildGraph(dir).then(() => refresh()).catch(() => {})
    }
    pg.raw = raw
    if (pg.dir !== dir || !document.getElementById('gf-stage')) return // navigated away mid-fetch
    await draw()
    startWatch(dir)
  } catch (err) {
    setStatus(err.message)
  }
}

// Live refresh (a rebuild landed): update IN PLACE. 2D diffs the DataSets —
// vis keeps positions for known ids and physics is off, so nothing scatters;
// new nodes are seeded next to a linked neighbor. 3D merges positions the
// same way it always has.
async function refresh() {
  if (!pg.dir) return
  try {
    const raw = await fetchGraph(pg.dir)
    if (!raw) return
    pg.raw = raw
    const s = loadGraphStore()
    const data = prepGraphData(raw, s.mdOnly, s.maxNodes)
    if (s.mode === '2d' && pg.network && pg.nodesDS) {
      const nextNodes = toVisNodes(data.nodes)
      const have = new Set(pg.nodesDS.getIds())
      const next = new Set(nextNodes.map((n) => n.id))
      const positions = pg.network.getPositions()
      for (const n of nextNodes) {
        if (have.has(n.id)) continue
        // seed unseen nodes near a linked, already-placed neighbor
        const link = data.links.find((l) => (l.source === n.id && positions[l.target]) || (l.target === n.id && positions[l.source]))
        const anchorId = link ? (link.source === n.id ? link.target : link.source) : null
        const p = anchorId ? positions[anchorId] : { x: 0, y: 0 }
        n.x = p.x + 60 * ((n.id.length % 5) - 2) / 2 + 40
        n.y = p.y + 60 * ((n.id.charCodeAt(0) % 5) - 2) / 2 + 40
      }
      pg.nodesDS.remove([...have].filter((id) => !next.has(id)))
      pg.nodesDS.update(nextNodes)
      pg.edgesDS.clear()
      pg.edgesDS.add(toVisEdges(data.links))
    } else if (s.mode === '3d' && pg.graph) {
      merge3DPositions(pg.graph.graphData(), data)
      pg.graph.graphData(data)
    }
    setStatus(statusText(data, true))
  } catch { /* transient — next event retries */ }
}

async function draw() {
  const s = loadGraphStore()
  const stage = document.getElementById('gf-stage')
  if (!stage || !pg.raw) return
  pg.network?.destroy?.()
  pg.network = null
  pg.graph?._destructor?.()
  pg.graph = null
  stage.innerHTML = ''
  const data = prepGraphData(pg.raw, s.mdOnly, s.maxNodes)
  if (s.mode === '2d') await draw2D(stage, data)
  else await draw3D(stage, data)
  setStatus(statusText(data, true))
}

// ---- 2D: vis-network, exactly as graph.html configures it ------------------------

async function draw2D(stage, data) {
  const vis = await visLoad()
  pg.nodesDS = new vis.DataSet(toVisNodes(data.nodes))
  pg.edgesDS = new vis.DataSet(toVisEdges(data.links))
  const network = new vis.Network(stage, { nodes: pg.nodesDS, edges: pg.edgesDS }, VIS_OPTIONS)
  // graph.html: once stabilized, physics goes OFF — the board is static and a
  // drag moves only the dragged node.
  network.once('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { enabled: false } })
    const cb = pg.onSettled
    pg.onSettled = null
    cb?.()
  })
  let hovered = null
  network.on('hoverNode', (p) => { hovered = p.node; stage.style.cursor = 'pointer' })
  network.on('blurNode', () => { hovered = null; stage.style.cursor = 'default' })
  network.on('click', (p) => {
    const id = p.nodes[0] ?? hovered
    if (id != null) { network.selectNodes([id]); showCard(pg.nodesDS.get(id)) }
    else hideCard()
  })
  pg.network = network
}

// ---- 3D: 3d-force-graph styled as the vis board's twin ---------------------------

function skin3D(g, communityOf) {
  g.backgroundColor(BG)
    // vis "size" is the dot's radius; three-forcegraph draws r = cbrt(val), so
    // val = size³ renders the same radius the 2D board shows.
    .nodeRelSize(1)
    .nodeVal((n) => n.size ** 3)
    .nodeColor((n) => (n.id === pg.sel ? '#ffffff' : nodeColor(n)))
    // edges inherit the SOURCE node's color at 0.7 opacity, exactly like the 2D
    // board (vis color.inherit:'from'). The map resolves string ids too — the
    // accessor can run before the lib swaps ids for node objects.
    .linkColor((l) => nodeColor({ community: communityOf.get(typeof l.source === 'object' ? l.source.id : l.source) ?? 0 }))
    .linkOpacity(0.7)
    .linkCurvature(0.2)
    .linkDirectionalArrowLength(4)
    .linkDirectionalArrowRelPos(1)
  // FA2-flavored forces (springLength 120, damping 0.4) + no overlapping spheres.
  // ponytail: no dashed lines or always-on labels in 3D — the lib has no
  // linkLineDash and sprite labels would add a dependency; hover covers both.
  g.d3VelocityDecay(0.4)
  g.d3Force('link')?.distance(120)
  g.d3Force('charge')?.strength(-120)
  g.d3Force('charge')?.distanceMax(600)
  g.d3Force('collide', forceCollide().radius((n) => (n.size || 10) + 2))
  // Static like the 2D board: layout computed before first paint, no cooldown.
  g.d3AlphaMin(0.001).warmupTicks(300).cooldownTicks(0).cooldownTime(0)
  return g
}

// Carry over positions so a live refresh nudges the 3D layout instead of
// restarting it; pinned during the update warmup, freed on engine stop.
function merge3DPositions(oldData, newData) {
  if (!oldData?.nodes?.length) return newData
  const byId = new Map(oldData.nodes.map((n) => [n.id, n]))
  for (const n of newData.nodes) {
    const old = byId.get(n.id)
    if (!old) continue
    n.x = old.x; n.y = old.y; n.z = old.z
    n.fx = old.x; n.fy = old.y; n.fz = old.z // transient — released on engine stop
  }
  pg.transientPin = true
  return newData
}

async function draw3D(stage, data) {
  const Ctor = await fg3d()
  const g = new Ctor(stage, { rendererConfig: { antialias: false } })
    .width(stage.clientWidth)
    .height(stage.clientHeight)
    .nodeLabel((n) => `${esc(n.label)}${n.file ? ` — ${esc(n.file)}` : ''}`)
    .onNodeClick((n) => showCard({ id: n.id, _label: n.label, _file: n.file, _ftype: n.ftype, _ntype: n.ntype }))
    .onBackgroundClick(() => hideCard())
    .onEngineStop(() => {
      if (pg.transientPin) {
        for (const n of g.graphData().nodes) { delete n.fx; delete n.fy; delete n.fz }
        pg.transientPin = false
      }
      const cb = pg.onSettled
      pg.onSettled = null
      cb?.()
    })
    // static board: a dragged node stays where dropped, nothing else moves
    .onNodeDragEnd((n) => { delete n.fx; delete n.fy; delete n.fz })
  skin3D(g, new Map(data.nodes.map((n) => [n.id, n.community ?? 0])))
  // zoom dollies toward the point under the cursor, like the 2D board's
  // pointer-anchored wheel zoom (vis does that natively).
  g.controls().zoomToCursor = true
  g.graphData(data)
  if (data.nodes.length > 500) {
    // large-graph render-quality tradeoffs (3D only; 2D is vis-network's canvas)
    g.renderer().setPixelRatio(1)
    g.nodeResolution(6)
  }
  pg.graph = g
}

function startWatch(dir) {
  pg.es?.close()
  pg.es = watchEvents(dir)
  pg.es.onmessage = (e) => {
    if (e.data === 'building') setStatus('Folder changed — rebuilding graph…')
    else if (e.data === 'updated') refresh()
    else if (e.data === 'error') setStatus('Rebuild failed — check the folder.')
  }
}

function onPageClick(e) {
  const el = e.target.closest('[data-gf]')
  if (!el) return
  const s = loadGraphStore()
  const act = el.dataset.gf
  if (act === 'pick') {
    el.disabled = true
    pickFolder().then((r) => {
      el.disabled = false
      if (r.canceled || !r.path) return
      s.dir = r.path
      saveGraphStore(s)
      renderGraphPage(document.querySelector('.gf').parentElement)
    })
  } else if (act === 'mode') {
    if (s.mode === el.dataset.v) return
    s.mode = el.dataset.v
    saveGraphStore(s)
    for (const p of el.parentElement.children) p.classList.toggle('is-on', p === el)
    hideCard()
    draw()
  } else if (act === 'md') {
    const on = !!el.dataset.v
    if (s.mdOnly === on) return
    s.mdOnly = on
    saveGraphStore(s)
    for (const p of el.parentElement.children) p.classList.toggle('is-on', p === el)
    hideCard()
    draw() // data set changed — relayout, exactly like reopening graph.html
  } else if (act === 'reveal') {
    revealFile(pg.dir, el.dataset.path)
  } else if (act === 'preview') {
    openPreview(pg.dir, el.dataset.path)
  } else if (act === 'card-close') { hideCard(); pg.network?.unselectAll() }
  else if (act === 'overlay-close') document.querySelector('.gf-overlay')?.remove()
}

function onMaxNodesChange(e) {
  const el = e.target.closest('[data-gf="maxnodes"]')
  if (!el) return
  const s = loadGraphStore()
  const n = Math.max(50, Math.round(Number(el.value)) || 1500)
  el.value = n
  if (s.maxNodes === n) return
  s.maxNodes = n
  saveGraphStore(s)
  hideCard()
  draw()
}

// ---- node card (bottom-left) -----------------------------------------------------

function showCard(n) {
  const card = document.getElementById('gf-card')
  if (!card || !n) return
  pg.sel = n.id
  pg.graph?.nodeColor(pg.graph.nodeColor()) // 3D: restyle for the white highlight
  card.hidden = false
  card.innerHTML = `
    <button type="button" class="cv-x gf-card__x" data-gf="card-close" aria-label="Close">×</button>
    <p class="gf-card__title">${esc(n._label)}</p>
    <p class="gf-card__meta">${[n._ntype, n._ftype].filter(Boolean).map(esc).join(' · ') || 'node'}</p>
    ${n._file ? `<p class="gf-card__file" title="${esc(n._file)}">${esc(n._file)}</p>
    <div class="gf-card__acts">
      <button type="button" class="gym-btn" data-gf="preview" data-path="${esc(n._file)}">Preview</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-gf="reveal" data-path="${esc(n._file)}">Reveal in Finder</button>
    </div>` : '<p class="gf-card__file">No source file for this node.</p>'}`
}
const hideCard = () => {
  pg.sel = null
  pg.graph?.nodeColor(pg.graph.nodeColor())
  const c = document.getElementById('gf-card')
  if (c) c.hidden = true
}

// ---- preview modal ---------------------------------------------------------------

const IMG_RE = /\.(png|jpe?g|gif|webp|svg)$/i

async function openPreview(dir, rel) {
  document.querySelector('.gf-overlay')?.remove()
  const o = document.createElement('div')
  o.className = 'modal-overlay cal-overlay gf-overlay'
  const inner = (body) => `<div class="cal-panel gf-panel">
    <div class="cal-panel__head"><h2 class="cal-panel__title">${esc(rel.split('/').pop())}</h2>
      <button type="button" class="mail-iconbtn" data-gf="overlay-close" aria-label="Close">✕</button></div>
    <p class="cal-panel__cal">${esc(rel)}</p>${body}</div>`
  o.innerHTML = inner('<p class="cal-wnote">Loading…</p>')
  // the overlay lives on document.body, outside the page's click delegation
  o.addEventListener('click', (e) => { if (e.target === o || e.target.closest('[data-gf="overlay-close"]')) o.remove() })
  document.body.appendChild(o)
  try {
    if (IMG_RE.test(rel)) {
      o.innerHTML = inner(`<img class="gf-previmg" src="${esc(fileURL(dir, rel))}" alt="${esc(rel)}">`)
      return
    }
    const r = await fetch(fileURL(dir, rel))
    if (!r.ok) throw new Error((await r.json()).error || `preview failed (${r.status})`)
    const text = await r.text()
    o.innerHTML = MD_RE.test(rel)
      ? inner(`<div class="cv-annbody">${sanitizeHTML(marked.parse(text))}</div>`)
      : inner(`<pre class="gf-prevtext">${esc(text.slice(0, 40000))}${text.length > 40000 ? '\n… (truncated)' : ''}</pre>`)
  } catch (err) {
    o.innerHTML = inner(`<p class="cal-wnote">${esc(err.message)}</p>`)
  }
}

// ---- dashboard widget (live, view-only) --------------------------------------------

let wCache = null, wCacheAt = 0, wCacheDir = null
function widgetData(dir) {
  if (wCache && wCacheDir === dir && Date.now() - wCacheAt < 120e3) return wCache
  wCacheDir = dir
  wCacheAt = Date.now()
  wCache = fetchGraph(dir)
  wCache.catch(() => { wCache = null })
  return wCache
}

export function graphWidgetHTML(w) {
  return `<p class="gym-head">Graph</p><div class="gf-wmount" data-gf-widget data-wid="${esc(w.id)}"><p class="cal-wnote">Loading…</p></div>`
}

export function hydrateGraphWidgets(contentEl) {
  const mounts = contentEl.querySelectorAll('[data-gf-widget]')
  if (!mounts.length) return
  const s = loadGraphStore()
  if (!s.dir) {
    for (const m of mounts) m.innerHTML = `<p class="cal-wnote">Choose a folder on the <a href="#/graph">Graph page</a> first.</p>`
    return
  }
  Promise.all([widgetData(s.dir), visLoad()]).then(([raw, vis]) => {
    for (const m of contentEl.querySelectorAll('[data-gf-widget]')) {
      if (!raw) { m.innerHTML = `<p class="cal-wnote">No graph yet — open the <a href="#/graph">Graph page</a> to build it.</p>`; continue }
      m.innerHTML = ''
      const data = prepGraphData(raw, s.mdOnly, s.maxNodes)
      // live view-only: pan/zoom/hover work, any click goes to the full page
      const net = new vis.Network(m, { nodes: new vis.DataSet(toVisNodes(data.nodes)), edges: new vis.DataSet(toVisEdges(data.links)) },
        { ...VIS_OPTIONS, interaction: { ...VIS_OPTIONS.interaction, dragNodes: false } })
      net.once('stabilizationIterationsDone', () => net.setOptions({ physics: { enabled: false } }))
      net.on('click', () => { location.hash = '#/graph' })
    }
  }).catch((err) => {
    for (const m of contentEl.querySelectorAll('[data-gf-widget]')) m.innerHTML = `<p class="cal-wnote">${esc(err.message)}</p>`
  })
}
