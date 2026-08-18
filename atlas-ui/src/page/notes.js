// Notes plugin — data layer. The browser can't read/write the notes folder
// or call an AI provider with a private key, so everything goes through the
// dev server's /notes-api middleware (vite.config.js). Reading a note's
// contents reuses the graph plugin's sandboxed /graph-api/file endpoint.
// ponytail: atlas.notes.v1 deliberately does NOT sync (unlike graph's key) —
// it holds an absolute macOS path, meaningless on another machine, and
// syncing would force a backend mapper change.

import { loadAI, ensureFreshClaude, credsForClaude, credsHeader } from './ai.js'
import { isNative } from '../platform.js'

const KEY = 'atlas.notes.v1'

export function loadNotesStore() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (typeof s.dir !== 'string') s.dir = ''
  if (typeof s.lastSubdir !== 'string') s.lastSubdir = ''
  if (!Array.isArray(s.openDirs)) s.openDirs = [] // folder paths left expanded; absent = collapsed
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

// AI-backed request: carries the user's own connected Claude account as the
// x-atlas-ai header (base64 JSON), refreshed just-in-time. Not connected → the
// same 'Connect an AI account in Settings' failure the UI already surfaces.
const postAI = async (url, payload) => {
  const cred = credsForClaude(await ensureFreshClaude(loadAI()))
  if (!cred) throw new Error('Connect an AI account in Settings')
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-atlas-ai': credsHeader(cred) }, body: JSON.stringify(payload) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `request failed (${r.status})`)
  return j
}

export async function pickFolder() {
  const r = await fetch('/notes-api/pick')
  return r.json() // {path} | {canceled:true}
}

// {dirs: ['Physics', 'Physics/Labs', …], notes: [{path: 'Physics/Waves.md', mtime}]}
// On Apple devices (isNative) STORAGE is the app's iCloud container via the
// native LocalServer /icloud/notes/* endpoints — same JSON shape, so notesui
// stays unchanged; web/macOS-dev keeps the /notes-api sidecar.
export async function fetchTree(dir) {
  if (isNative()) {
    const r = await fetch('/icloud/notes/tree')
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || `tree failed (${r.status})`)
    return j
  }
  const r = await fetch(`/notes-api/tree?${q(dir)}`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error || `tree failed (${r.status})`)
  return j
}

// A saved note's markdown text. Native reads it from iCloud by relative path;
// web reads through the sandboxed graph middleware (the same /graph-api/file
// endpoint the viewer already uses for images).
export async function readNote(dir, rel) {
  const r = await fetch(isNative()
    ? `/icloud/notes/read?path=${encodeURIComponent(rel)}`
    : fileURL(dir, rel))
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `read failed (${r.status})`)
  return r.text()
}

// {dir, files: [{name, media_type, data(b64)}], text?, url?} → {title, markdown}
// Carries the user's own connected Claude account (ai.js credsForClaude) on
// every request — the server never falls back to its own local Claude Code
// subscription.
export const convertNote = (payload) => postAI('/notes-api/convert', payload)

// {dir, subdir, filename, markdown, uploads: [{name, data(b64)}]} → {ok, path}
// Native writes to iCloud, whose save contract is just {path, content} — so
// original uploads/attachments are NOT carried there (the iCloud endpoint has
// no attachment slot). ponytail: dropping originals on native is the deliberate
// ceiling; an /icloud/notes/save that accepted uploads is the upgrade path.
export async function saveNote(payload) {
  if (isNative()) {
    const rel = (payload.subdir ? payload.subdir.replace(/\/+$/, '') + '/' : '')
      + payload.filename.replace(/\.md$/i, '') + '.md'
    const j = await post('/icloud/notes/save', { path: rel, content: payload.markdown })
    return { ok: true, path: j.path || rel }
  }
  return post('/notes-api/save', payload)
}

// Delete a saved note by its path relative to the notes root. Native deletes
// from iCloud; web hits the sidecar delete route.
export async function deleteNote(dir, rel) {
  if (isNative()) return post('/icloud/notes/delete', { path: rel })
  return post('/notes-api/delete', { dir, path: rel })
}

// Apple Notes import: the account → folder → note tree (each note carries a
// STABLE id — never keyed by title, which can collide silently), and one
// note's full content fetched directly by that id. Typed notes come back as
// markdown with no conversion step; handwritten notes still render slowly
// (the dev server reads ink vectors off disk) and come back as PDF pages to
// route through the normal upload+convert flow.
// → [{account, folders: [{name, id, notes: [{id, title}]}]}]
export async function appleNotesTree() {
  const r = await fetch('/notes-api/apple-tree')
  const j = await r.json().catch(() => ([])) // non-JSON (e.g. dev server mid-restart) → []
  if (!r.ok) throw new Error(j.error || `tree failed (${r.status})`)
  return Array.isArray(j) ? j : []
}
// → { kind: 'typed', title, markdown } | { kind: 'ink', title, files: [{name, media_type, data}], source }
// files[] normalized so a malformed response can never crash the caller on .length.
export async function appleNotesFetch(id) {
  const j = await post('/notes-api/apple-note', { id })
  return j.kind === 'ink' ? { ...j, files: Array.isArray(j.files) ? j.files : [] } : j
}

// note contents + original images are read via the graph middleware (sandboxed)
export const fileURL = (dir, rel) => `/graph-api/file?${q(dir)}&path=${encodeURIComponent(rel)}`
export const revealFile = (dir, rel) => fetch(`/graph-api/reveal?${q(dir)}&path=${encodeURIComponent(rel)}`, { method: 'POST' })

export const WIKI_RE = /\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/g
export const EMBED_RE = /!\[\[([^\]|]+?)\]\]/g
export const IMG_RE = /\.(png|jpe?g|gif|webp|heic)$/i
