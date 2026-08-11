// Notes plugin — data layer. The browser can't read/write the notes folder
// or call Claude with a private key, so everything goes through the dev
// server's /notes-api middleware (vite.config.js). Reading a note's contents
// reuses the graph plugin's sandboxed /graph-api/file endpoint.
// ponytail: atlas.notes.v1 deliberately does NOT sync (unlike graph's key) —
// it holds an absolute macOS path, meaningless on another machine, and
// syncing would force a backend mapper change.

const KEY = 'atlas.notes.v1'

export function loadNotesStore() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (typeof s.dir !== 'string') s.dir = ''
  if (typeof s.lastSubdir !== 'string') s.lastSubdir = ''
  return s
}
export function saveNotesStore(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

const q = (dir) => `dir=${encodeURIComponent(dir)}`

const post = async (url, payload) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `request failed (${r.status})`)
  return j
}

export async function pickFolder() {
  const r = await fetch('/notes-api/pick')
  return r.json() // {path} | {canceled:true}
}

// {dirs: ['Physics', 'Physics/Labs', …], notes: [{path: 'Physics/Waves.md', mtime}]}
export async function fetchTree(dir) {
  const r = await fetch(`/notes-api/tree?${q(dir)}`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `tree failed (${r.status})`)
  return j
}

// {dir, files: [{name, media_type, data(b64)}], text?, url?} → {title, markdown}
export const convertNote = (payload) => post('/notes-api/convert', payload)

// {dir, subdir, filename, markdown, uploads: [{name, data(b64)}]} → {ok, path}
export const saveNote = (payload) => post('/notes-api/save', payload)

// Apple Notes import: list note titles / export one as a PDF (slow — the dev
// server drives the Notes app UI; needs the Mac unlocked)
export async function appleNotesList() {
  const r = await fetch('/notes-api/apple-list')
  const j = await r.json().catch(() => ({})) // non-JSON (e.g. dev server mid-restart) → {}
  if (!r.ok) throw new Error(j.error || `list failed (${r.status})`)
  return Array.isArray(j.titles) ? j.titles : []
}
// → { files: [{name, media_type, data}], source } ; files[] normalized so a
// malformed response can never crash the caller on .length.
export async function appleNotesExport(title) {
  const j = await post('/notes-api/apple-export', { title })
  return { files: Array.isArray(j.files) ? j.files : [], source: j.source }
}

// note contents + original images are read via the graph middleware (sandboxed)
export const fileURL = (dir, rel) => `/graph-api/file?${q(dir)}&path=${encodeURIComponent(rel)}`
export const revealFile = (dir, rel) => fetch(`/graph-api/reveal?${q(dir)}&path=${encodeURIComponent(rel)}`, { method: 'POST' })

export const WIKI_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g
export const EMBED_RE = /!\[\[([^\]|]+?)\]\]/g
export const IMG_RE = /\.(png|jpe?g|gif|webp|heic)$/i
