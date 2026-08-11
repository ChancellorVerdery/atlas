// Graph plugin — data layer. The browser can't read directories, open
// Finder, or run graphify, so everything goes through the dev server's
// /graph-api middleware (vite.config.js). The graph itself is graphify's
// graphify-out/graph.json (node-link format: nodes carry label/source_file/
// file_type/community, links carry source/target/relation).

const KEY = 'atlas.graph.v1'

export function loadGraphStore() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (typeof s.dir !== 'string') s.dir = ''
  if (s.mode !== '3d') s.mode = '2d'
  s.mdOnly = !!s.mdOnly
  // Opera (per the user) renders force-graph noticeably better than this
  // machine's default browser, so the render-quality/size tradeoff belongs to
  // the user, not a hardcoded constant — hence a persisted, user-set ceiling.
  if (!Number.isInteger(s.maxNodes) || s.maxNodes < 1) s.maxNodes = 1500
  return s
}
export function saveGraphStore(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

const q = (dir, extra = '') => `dir=${encodeURIComponent(dir)}${extra}`

export async function pickFolder() {
  const r = await fetch('/graph-api/pick')
  return r.json() // {path} | {canceled:true}
}

// null → no graph built yet for this directory
export async function fetchGraph(dir) {
  const r = await fetch(`/graph-api/graph?${q(dir)}`)
  if (r.status === 404) return null
  if (!r.ok) throw new Error((await r.json()).error || `graph fetch failed (${r.status})`)
  return r.json()
}

export async function buildGraph(dir) {
  const r = await fetch(`/graph-api/build?${q(dir)}`, { method: 'POST' })
  if (!r.ok) throw new Error((await r.json()).error || 'graphify build failed')
}

export const fileURL = (dir, rel) => `/graph-api/file?${q(dir, `&path=${encodeURIComponent(rel)}`)}`
export const revealFile = (dir, rel) => fetch(`/graph-api/reveal?${q(dir, `&path=${encodeURIComponent(rel)}`)}`, { method: 'POST' })
export const watchEvents = (dir) => new EventSource(`/graph-api/events?${q(dir)}`)

export const MD_RE = /\.(md|mdx|qmd)$/i

// graphify node-link JSON → force-graph {nodes, links}, optionally narrowed
// to markdown-sourced nodes. val (node size) = degree, capped so god nodes
// don't swallow the view. Graphs past capN nodes are truncated to the
// top-connected ones (force-graph/3d-force-graph both bog down well past
// this size) — capped is reported back so the UI can say what was dropped
// instead of silently rendering a subset.
export function prepGraphData(raw, mdOnly, capN = 1500) {
  let nodes = (raw.nodes || []).map((n) => ({
    id: n.id,
    label: n.label || n.id,
    file: n.source_file || null,
    ftype: n.file_type || null,
    ntype: n.type || null,
    community: n.community ?? 0,
  }))
  if (mdOnly) nodes = nodes.filter((n) => n.file && MD_RE.test(n.file))
  const keepAll = new Set(nodes.map((n) => n.id))
  const linksAll = (raw.links || raw.edges || [])
    .filter((l) => keepAll.has(l.source) && keepAll.has(l.target))
    .map((l) => ({
      source: l.source, target: l.target, relation: l.relation || '',
      inferred: l.confidence === 'INFERRED', // drawn dashed, like graphify's html
    }))
  const deg = new Map()
  for (const l of linksAll) {
    deg.set(l.source, (deg.get(l.source) || 0) + 1)
    deg.set(l.target, (deg.get(l.target) || 0) + 1)
  }
  // graphify's sizing: radius 10 + 0.2875·degree capped at 40; labels only on
  // the top-connected nodes (radius ≥ 14.5). The renderer (skinGraph) turns
  // size into the mode-correct nodeVal (size² in 2D, size³ in 3D).
  for (const n of nodes) {
    n.deg = deg.get(n.id) || 0
    n.size = Math.min(40, 10 + 0.2875 * n.deg)
    n.labeled = n.size >= 14.5
  }

  let capped = null
  if (nodes.length > capN) {
    nodes = [...nodes].sort((a, b) => (deg.get(b.id) || 0) - (deg.get(a.id) || 0)).slice(0, capN)
    capped = { shown: capN, total: keepAll.size }
  }
  const keep = capped ? new Set(nodes.map((n) => n.id)) : keepAll
  const links = capped ? linksAll.filter((l) => keep.has(l.source) && keep.has(l.target)) : linksAll
  return { nodes, links, capped }
}
