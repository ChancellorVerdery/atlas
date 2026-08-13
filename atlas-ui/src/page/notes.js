// Notes plugin — data layer. The browser can't read/write the notes folder
// or call an AI provider with a private key, so everything goes through the
// dev server's /notes-api middleware (vite.config.js). Reading a note's
// contents reuses the graph plugin's sandboxed /graph-api/file endpoint.
// ponytail: atlas.notes.v1 deliberately does NOT sync (unlike graph's key) —
// it holds an absolute macOS path, meaningless on another machine, and
// syncing would force a backend mapper change.

import { credsForCapability } from './ai.js'

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

// {dir, files: [{name, media_type, data(b64)}], text?, url?} → {title, markdown, switched}
// Carries the resolved AI credential list (ai.js credsForCapability) on
// every request — the server never falls back to its own local Claude Code
// subscription; an empty list comes back `{error: 'no_ai_provider'}`.
export const convertNote = (payload) => post('/notes-api/convert', { ...payload, ai: credsForCapability('notes') })

// {dir, subdir, filename, markdown, uploads: [{name, data(b64)}]} → {ok, path}
export const saveNote = (payload) => post('/notes-api/save', payload)

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
