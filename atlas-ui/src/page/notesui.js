// Notes plugin UI: pick a root notes folder, browse and read the markdown
// inside it (clickable [[wiki-links]]), and turn uploads — handwriting
// photos, screenshots, PDFs, pasted text, web links — into new notes.
// Conversion runs in the dev server (/notes-api → Claude). Hitting Convert
// queues the job at the top of the page (one converts at a time, the rest
// wait) so other Atlas pages stay usable; finished jobs hold for review —
// nothing is written to disk until the preview is approved.

import {
  loadNotesStore, saveNotesStore, pickFolder, fetchTree, convertNote, saveNote,
  readNote, deleteNote,
  appleNotesTree, appleNotesFetch, fileURL, revealFile, WIKI_RE, EMBED_RE, IMG_RE,
  syncNotes, remoteNotes, notesRoot, resetNotesRoot,
} from './notes.js'
import { clearSnapshot } from './notessync.js'
import { isNative, isNativeIOS } from '../platform.js'
import { confirmDelete } from './confirm.js'
import { isAIConfigured, loadAI } from './ai.js'
// ponytail: AI is single-provider (Claude) now; capability routing collapsed to "is AI connected"
const providerForCapability = () => isAIConfigured(loadAI())
import { sanitizeHTML } from './canvasui.js'
import { graphSVG, tableMarkdown } from './notegraph.js'
import { marked } from 'marked'
import { convertLatexToMarkup } from 'mathlive' // mathlive CSS is loaded globally by view.js
import { renderMath, fitEquations } from './view.js' // reuse the equations plugin's scale-to-fit

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const NO_AI_MSG = 'Connect an AI account in Settings → Accounts to use this.'
const SWITCHED_MSG = 'Primary AI was out of tokens — switched to your secondary.'

const dirName = (dir) => dir.split('/').filter(Boolean).pop() || dir
const noteName = (rel) => rel.split('/').pop().replace(/\.md$/i, '')

// Per-upload caps mirror Anthropic's limits (5MB/image, larger for PDFs);
// the 25MB total keeps the JSON body well under the API's 32MB request cap.
const MAX_IMG = 5e6, MAX_PDF = 20e6, MAX_TOTAL = 25e6

const pg = { tree: null, open: null, statusTimer: null } // page session state
let up = null // upload-modal state (null = closed)

// Conversion queue — module-level so jobs keep running while the user is on
// other Atlas pages (the SPA never unloads this module). A browser refresh
// mid-convert drops in-flight jobs; server-side job infra is the upgrade path
// if that ever hurts. Jobs: { id, dir, files, text, url, subdir, newdir,
// label, phase: queued|converting|ready|error, error, result, filename }
const queue = []
let qSeq = 0
let qTimer = null // progress ticker, runs only while a job is converting

window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/notes')) closeUpload()
})

// <details> fires 'toggle' and it does NOT bubble, so this listens in the
// capture phase — a delegated click handler can't see it, and per-element
// listeners would have to be re-attached every renderTree().
document.addEventListener('toggle', (e) => {
  const d = e.target
  if (!(d instanceof HTMLElement) || !d.classList.contains('nt-dir')) return
  const dir = d.dataset.dir
  if (!dir) return
  const s = loadNotesStore()
  const open = new Set(s.openDirs)
  if (d.open) open.add(dir); else open.delete(dir)
  s.openDirs = [...open]
  saveNotesStore(s)
}, true)

export function renderNotesPage(root) {
  const s = loadNotesStore()
  const native = isNative() // native stores in iCloud — no user-picked folder
  if (!s.dir && !native) {
    root.innerHTML = `<div class="nt">
      <div class="gf-empty">
        <p class="gym-empty">Pick your notes folder and Atlas turns anything you upload — handwriting, screenshots, PDFs, links — into markdown notes with wiki-links.</p>
        <button type="button" class="gym-btn" data-nt="pick">Choose folder…</button>
      </div>
    </div>`
    root.onclick = onPageClick
    return
  }
  const noAI = !providerForCapability('notes')
  root.innerHTML = `<div class="nt">
    <div class="gf-bar">
      <button type="button" class="gym-btn" data-nt="new" ${noAI ? 'disabled' : ''}>+ New note</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-nt="pick">Change folder…</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-nt="sync">Sync</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-nt="archive">Archive</button>
      <span class="gf-dir" id="nt-root" title="${native ? 'iCloud' : esc(s.dir)}">${native ? 'iCloud' : esc(dirName(s.dir))}</span>
      <span class="gf-status" id="nt-status">${noAI ? esc(NO_AI_MSG) : ''}</span>
    </div>
    <div class="nt-queue" id="nt-queue"></div>
    <div class="nt-body">
      <nav class="nt-tree" id="nt-tree"><p class="cal-wnote">Loading…</p></nav>
      <section class="nt-view card" id="nt-view"><p class="cal-wnote">Select a note to read it.</p></section>
    </div>
  </div>`
  root.onclick = onPageClick
  renderQueue()
  loadTree(s.dir)
  showNativeRoot()
  runSync({ quiet: true }) // opening the page is the natural moment to converge
}

// On native the notes root lives in the app, not in atlas.notes.v1, so the
// label has to be asked for. Shows the folder name plus a way back to the
// built-in iCloud location once the user has chosen their own.
async function showNativeRoot() {
  if (!isNative()) return
  const r = await notesRoot().catch(() => null)
  const el = document.getElementById('nt-root')
  if (!r || !el) return
  el.textContent = r.label || 'iCloud'
  el.title = r.path || ''
  if (r.custom && !document.querySelector('[data-nt="root-reset"]')) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'gym-btn gym-btn--ghost'
    b.dataset.nt = 'root-reset'
    b.textContent = 'Use default'
    el.parentElement.insertBefore(b, el)
  }
}

// ---- synced folder ----------------------------------------------------------

// A pass reads and writes the same folder loadTree() renders, so the tree is
// reloaded whenever anything actually moved. Quiet passes (page open, timer)
// say nothing unless there IS something to say.
let syncTimer = null
async function runSync({ quiet = false } = {}) {
  if (!quiet) setStatus('Syncing…')
  let r
  try {
    r = await syncNotes()
  } catch (e) {
    setStatus(`Sync failed — ${e.message}`)
    return null
  }
  if (!r) { if (!quiet) setStatus('') ; return null }
  const moved = r.pulled.length + r.pushed.length + r.deletedLocal.length + r.deletedRemote.length + r.conflicts.length
  if (moved) { pg.tree = null; loadTree(loadNotesStore().dir) }
  const bits = []
  if (r.pulled.length) bits.push(`${r.pulled.length} in`)
  if (r.pushed.length) bits.push(`${r.pushed.length} out`)
  if (r.deletedLocal.length) bits.push(`${r.deletedLocal.length} removed here`)
  if (r.deletedRemote.length) bits.push(`${r.deletedRemote.length} removed on the server`)
  if (r.conflicts.length) bits.push(`${r.conflicts.length} kept as conflict ${r.conflicts.length === 1 ? 'copy' : 'copies'}`)
  if (r.errors.length) bits.push(`${r.errors.length} failed`)
  if (bits.length) setStatus(`Synced — ${bits.join(', ')}`)
  else if (!quiet) setStatus('Synced — already up to date')
  return r
}

// Poll while the notes page is on screen. Deliberately not a global background
// loop: syncing a folder the user is not looking at buys nothing and would run
// on every page of the app.
export function startNotesSyncLoop() {
  clearInterval(syncTimer)
  syncTimer = setInterval(() => {
    if (!location.hash.startsWith('#/notes') || document.hidden) return
    runSync({ quiet: true })
  }, 60_000)
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)
const daysLeft = (expiresAt) => Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400e3))

async function renderArchive() {
  const view = document.getElementById('nt-view')
  if (!view) return
  view.innerHTML = '<p class="cal-wnote">Loading the archive…</p>'
  let j
  try { j = await remoteNotes.archive() } catch (e) {
    view.innerHTML = `<p class="cal-wnote">Couldn't load the archive — ${esc(e.message)}</p>`
    return
  }
  if (!j.files.length) {
    view.innerHTML = `<h3 class="nt-title">Archive</h3><p class="cal-wnote">Nothing deleted in the last ${j.days} days.</p>`
    return
  }
  view.innerHTML = `<h3 class="nt-title">Archive</h3>
    <p class="cal-wnote">Deleted notes are kept for ${j.days} days, then permanently removed.</p>
    <div class="nt-arch">${j.files.map((f) => `
      <div class="nt-arch__row">
        <span class="nt-arch__path" title="${esc(f.path)}">${esc(f.path)}</span>
        <span class="nt-arch__meta">${fmtBytes(f.size)} · deleted ${new Date(f.deletedAt).toLocaleDateString()} · ${daysLeft(f.expiresAt)}d left</span>
        <button type="button" class="gym-btn gym-btn--ghost" data-nt="arch-restore" data-path="${esc(f.path)}">Restore</button>
        <button type="button" class="nt-chip__x" data-nt="arch-purge" data-path="${esc(f.path)}" aria-label="Delete forever">×</button>
      </div>`).join('')}</div>`
}

function setStatus(t) {
  const el = document.getElementById('nt-status')
  if (!el) return
  el.textContent = t
  clearTimeout(pg.statusTimer)
  if (t) pg.statusTimer = setTimeout(() => { el.textContent = '' }, 4000)
}

// ---- directory tree ---------------------------------------------------------------

async function loadTree(dir, openPath = null) {
  const el = document.getElementById('nt-tree')
  try {
    pg.tree = await fetchTree(dir)
    if (!document.getElementById('nt-tree')) return // navigated away mid-fetch
    // A note opened programmatically (just saved, followed a wiki-link) may sit
    // inside collapsed folders, where the tree would simply not show it. Reveal
    // its ancestors only — the point of collapsing is that everything ELSE
    // stays shut.
    if (openPath) revealAncestors(openPath)
    renderTree()
    if (openPath) openNote(openPath)
    else if (pg.open && pg.tree.notes.some((n) => n.path === pg.open)) openNote(pg.open)
  } catch (err) {
    if (el) el.innerHTML = `<p class="cal-wnote">${esc(err.message)}</p>`
    if (String(err.message).includes('bad or missing dir')) {
      // root folder moved/deleted — fall back to the picker state
      const s = loadNotesStore()
      s.dir = ''
      saveNotesStore(s)
      renderNotesPage(document.querySelector('.nt').parentElement)
    }
  }
}

// Mark every folder above a note as open, so revealing it does not mean
// expanding the whole tree.
function revealAncestors(rel) {
  const parts = String(rel).split('/').slice(0, -1)
  if (!parts.length) return
  const s = loadNotesStore()
  const open = new Set(s.openDirs)
  const before = open.size
  for (let i = 1; i <= parts.length; i++) open.add(parts.slice(0, i).join('/'))
  if (open.size === before) return
  s.openDirs = [...open]
  saveNotesStore(s)
}

// dirs + note paths → nested {dirs: Map, notes: []}, rendered as native
// <details> elements (collapsible for free, no JS toggling).
function buildTree() {
  const rootNode = { dirs: new Map(), notes: [] }
  const nodeFor = (parts) => {
    let n = rootNode
    for (const p of parts) {
      if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), notes: [] })
      n = n.dirs.get(p)
    }
    return n
  }
  for (const d of pg.tree.dirs) nodeFor(d.split('/'))
  for (const note of pg.tree.notes) nodeFor(note.path.split('/').slice(0, -1)).notes.push(note)
  return rootNode
}

// Folders start CLOSED and remember what you left open — keyed by folder path
// in atlas.notes.v1, so it survives reloads. A path missing from the set is
// collapsed, which is also what a brand-new folder gets.
function treeHTML(node, prefix = '', open = new Set(loadNotesStore().openDirs)) {
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))
  const notes = [...node.notes].sort((a, b) => a.path.localeCompare(b.path))
  return dirs.map(([name, child]) => {
    const p = prefix ? `${prefix}/${name}` : name
    return `<details class="nt-dir" data-dir="${esc(p)}"${open.has(p) ? ' open' : ''}><summary>${esc(name)}</summary>${treeHTML(child, p, open)}</details>`
  }).join('')
    // ponytail: the row's flex layout is inline because styles.css is another
    // agent's file — a .nt-note-row rule is the upgrade path. The × deletes.
    + notes.map((n) => `<div class="nt-note-row" style="display:flex;align-items:center;gap:2px">`
      + `<button type="button" class="nt-note${pg.open === n.path ? ' is-open' : ''}" style="flex:1;min-width:0" data-nt="open" data-path="${esc(n.path)}">${esc(noteName(n.path))}</button>`
      + `<button type="button" class="nt-chip__x" data-nt="note-del" data-path="${esc(n.path)}" aria-label="Delete note">×</button>`
      + `</div>`).join('')
}

function renderTree() {
  const el = document.getElementById('nt-tree')
  if (!el) return
  el.innerHTML = pg.tree.notes.length || pg.tree.dirs.length
    ? treeHTML(buildTree())
    : '<p class="cal-wnote">No notes yet — hit “+ New note” to create the first one.</p>'
}

// ---- viewer -----------------------------------------------------------------------

// mathlive implements \ldots/\cdots but NOT amsmath's \dots family — those
// render as a literal "\dots" error atom. Models emit \dots constantly, so
// normalize before converting.
const fixDots = (latex) => latex.replace(/\\dotsb\b/g, '\\cdots').replace(/\\dots[cmio]?\b/g, '\\ldots')

// Block ($$…$$) equations reuse the equations plugin's .eq-render structure so
// fitEquations() scales any that overflow down to fit (left-aligned) instead
// of scrolling. Inline ($…$) math stays a small textstyle span.
const mathMarkup = (latex, block) => {
  if (block) return renderMath(fixDots(latex))
  try { return `<span class="nt-math">${convertLatexToMarkup(fixDots(latex).trim(), { defaultMode: 'textstyle' })}</span>` }
  catch { return esc(latex) } // malformed LaTeX → show it raw rather than break the page
}

// The server appends an "Originals: ![[…]]" block on save so the vault file
// still links its source scan (Obsidian shows it); Atlas's viewer omits it.
const stripOriginals = (md) => md.replace(/\n+---\s*\n\*\*Originals:\*\*[\s\S]*$/, '')

// Render a note to HTML. Math ($$…$$ block, $…$ inline) is pulled out to
// placeholders BEFORE marked so LaTeX (underscores, backslashes) isn't mangled
// by markdown, then spliced back before sanitize (which leaves mathlive's
// spans intact). Then wiki-links, then markdown.
// ponytail: [[…]] and $…$ inside code fences get transformed too, and two $ on
// one prose line read as inline math — fine at personal scale; a marked
// extension / real tokenizer is the upgrade path.
// Generated blocks the converter can emit. Extracted FIRST, before the math
// and wiki-link passes, so a spec's braces, backslashes and dollar signs are
// never mangled by rules meant for prose.
//   atlas-table  → a real markdown table (searchable, editable, diffable)
//   atlas-graph  → a spec this app plots itself (notegraph.js)
//   atlas-figure → SVG for the things neither of those can express
const GEN_FENCE_RE = /```atlas-(graph|table|figure)[^\n]*\n([\s\S]*?)```/g
const safeJSON = (s) => { try { return JSON.parse(s) } catch { return null } }

function renderMarkdown(text, dir) {
  const math = []
  const blocks = []
  const src = stripOriginals(text)
    .replace(GEN_FENCE_RE, (m, kind, body) => {
      if (kind === 'table') {
        const md = tableMarkdown(safeJSON(body))
        return md ? `\n\n${md}\n\n` : m // unparseable → leave the fence visible
      }
      if (kind === 'figure') {
        // Model-authored markup, so it goes through the same sanitizer as any
        // other untrusted HTML before it is ever inserted.
        return `NTBLOCK${blocks.push(`<figure class="nt-figure">${sanitizeHTML(body)}</figure>`) - 1}NTBLOCK`
      }
      const spec = safeJSON(body)
      if (!spec) return m
      // Plotting needs compute-engine (a lazy ~1MB import) so it cannot happen
      // in this synchronous pass; leave a mount and fill it after insertion,
      // the same idiom view.js uses for charts.
      return `NTBLOCK${blocks.push(`<div class="ng-mount" data-ng="${esc(JSON.stringify(spec))}"></div>`) - 1}NTBLOCK`
    })
    // LaTeX-style delimiters → dollar form BEFORE extraction (marked would
    // otherwise eat the backslashes and leave raw LaTeX as plain text)
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, l) => `$$${l}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (m, l) => `$${l.replace(/\n/g, ' ')}$`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, l) => `NTMATH${math.push(mathMarkup(l, true)) - 1}NTMATH`)
    .replace(/\$([^\n$]+?)\$/g, (m, l) => `NTMATH${math.push(mathMarkup(l, false)) - 1}NTMATH`)
    .replace(EMBED_RE, (m, t) => {
      const name = t.trim()
      return IMG_RE.test(name)
        ? `<img class="nt-embed" src="${esc(fileURL(dir, `note uploads/${name}`))}" alt="${esc(name)}">`
        : `<a class="nt-wiki" href="${esc(fileURL(dir, `note uploads/${name}`))}" target="_blank" rel="noopener">${esc(name)}</a>`
    })
    .replace(WIKI_RE, (m, t, label) => `<a class="nt-wiki" href="#" data-nt="wiki" data-target="${esc(t.trim())}">${esc((label || t).trim())}</a>`)
  const html = marked.parse(src)
    // a block equation alone in a paragraph → drop the <p> wrapper (renderMath
    // emits a block <div>, invalid inside <p>); any remaining (inline) in place
    .replace(/<p>NTMATH(\d+)NTMATH<\/p>/g, (m, i) => math[Number(i)])
    .replace(/NTMATH(\d+)NTMATH/g, (m, i) => math[Number(i)])
    // Generated blocks are block-level: a <p> wrapper around a <figure> or a
    // graph mount is invalid HTML and the browser would hoist them out anyway.
    .replace(/<p>NTBLOCK(\d+)NTBLOCK<\/p>/g, (m, i) => blocks[Number(i)])
    .replace(/NTBLOCK(\d+)NTBLOCK/g, (m, i) => blocks[Number(i)])
  return sanitizeHTML(html)
}

// Fill the graph mounts left by renderMarkdown. Async and per-mount: one
// unplottable spec must not cost the note its other graphs.
// A notes graph is drawn ONCE, into a fixed-viewBox SVG whose axis labels are
// HTML inside a <foreignObject> rather than <text>. Nothing ever re-lays it out
// afterwards, so a change to the page's geometry leaves those labels sitting
// where the OLD geometry put them — the "zooming breaks the axis labels" shape.
// Two things change it without any re-render of ours:
//   - the Mac app's View menu zoom. It is applied natively (WKWebView.pageZoom)
//     and the page has no way to observe it at all, which is why WebView.swift
//     now dispatches 'atlas:pagezoom' after setting it.
//   - an ordinary window resize.
// Redrawing is cheap and idempotent: the spec is still on the mount's dataset,
// so this rebuilds from source rather than trying to patch the live SVG. That
// fresh DOM insertion is also the standard way to make WebKit redo
// foreignObject layout from clean.
let regraphTimer = null
function regraphOpenNote() {
  clearTimeout(regraphTimer)
  regraphTimer = setTimeout(() => {
    const view = document.getElementById('nt-view')
    if (view && pg.open) hydrateGraphs(view)
  }, 150)
}
if (typeof window !== 'undefined') {
  window.addEventListener('atlas:pagezoom', regraphOpenNote)
  window.addEventListener('resize', regraphOpenNote)
}

async function hydrateGraphs(root) {
  for (const el of root.querySelectorAll('.ng-mount')) {
    let spec
    try { spec = JSON.parse(el.dataset.ng) } catch { continue }
    let svg = null
    try { svg = await graphSVG(spec) } catch { svg = null }
    if (!document.body.contains(el)) return // navigated away mid-render
    el.innerHTML = svg || '<p class="cal-wnote">This graph could not be drawn.</p>'
  }
}

async function openNote(rel) {
  const s = loadNotesStore()
  pg.open = rel
  document.querySelectorAll('.nt-note').forEach((b) => b.classList.toggle('is-open', b.dataset.path === rel))
  const view = document.getElementById('nt-view')
  if (!view) return
  view.innerHTML = '<p class="cal-wnote">Loading…</p>'
  try {
    const text = await readNote(s.dir, rel) // iCloud when native, graph middleware on web
    if (pg.open !== rel || !document.getElementById('nt-view')) return // clicked away mid-fetch
    view.innerHTML = `
      <div class="nt-view__head">
        <h2 class="nt-view__title">${esc(noteName(rel))}</h2>
        <button type="button" class="gym-btn gym-btn--ghost" data-nt="reveal" data-path="${esc(rel)}">Reveal in Finder</button>
      </div>
      <p class="gf-card__file" title="${esc(rel)}">${esc(rel)}</p>
      <div class="cv-annbody nt-md">${renderMarkdown(text, s.dir)}</div>`
    fitEquations(view) // scale any overflowing block equations to fit
    hydrateGraphs(view) // fill any ```atlas-graph mounts (async, lazy engine)
  } catch (err) {
    view.innerHTML = `<p class="cal-wnote">${esc(err.message)}</p>`
  }
}

// [[target]] resolves case-insensitively against note basenames (then full
// relative paths); unresolved targets are legal Obsidian dangling links.
function followWiki(target) {
  const t = target.toLowerCase()
  const hit = pg.tree?.notes.find((n) => noteName(n.path).toLowerCase() === t)
    || pg.tree?.notes.find((n) => n.path.replace(/\.md$/i, '').toLowerCase() === t)
  if (hit) openNote(hit.path)
  else setStatus(`No note yet for “${target}”`)
}

// Destructive — gate on confirmDelete (the tree × sits one pixel from the note
// button, so it's easy to hit by accident). Deletes from the active backend
// (iCloud when native), then refreshes the tree and clears the viewer if the
// deleted note was open.
async function deleteNoteFlow(rel) {
  if (!(await confirmDelete(`Delete “${noteName(rel)}”?`))) return
  const s = loadNotesStore()
  try {
    await deleteNote(s.dir, rel)
    if (pg.open === rel) {
      pg.open = null
      const view = document.getElementById('nt-view')
      if (view) view.innerHTML = '<p class="cal-wnote">Select a note to read it.</p>'
    }
    await loadTree(s.dir)
    setStatus(`Deleted ${noteName(rel)}`)
  } catch (err) {
    setStatus(err.message)
  }
}

// ---- page click delegation ----------------------------------------------------------

function onPageClick(e) {
  const el = e.target.closest('[data-nt]')
  if (!el) return
  const act = el.dataset.nt
  const s = loadNotesStore()
  if (act === 'pick') {
    el.disabled = true
    pickFolder().then((r) => {
      el.disabled = false
      if (r.canceled || !r.path) { if (r.error) setStatus(r.error); return }
      // MUST clear the sync snapshot. It records the state of the OLD folder,
      // so keeping it would make every file in that folder look locally
      // deleted on the next pass — and the reconciler would faithfully
      // propagate those deletions to the server and every other device.
      // Cleared, the first pass treats both sides as additions and merges.
      clearSnapshot()
      s.dir = r.path
      s.lastSubdir = ''
      s.openDirs = [] // folder paths belong to the old root
      saveNotesStore(s)
      pg.tree = null
      pg.open = null
      renderNotesPage(document.querySelector('.nt').parentElement)
    })
  } else if (act === 'root-reset') {
    clearSnapshot()
    resetNotesRoot()
      .then(() => { s.openDirs = []; saveNotesStore(s); pg.tree = null; pg.open = null; renderNotesPage(document.querySelector('.nt').parentElement) })
      .catch((err) => setStatus(err.message))
  } else if (act === 'sync') runSync()
  else if (act === 'archive') renderArchive()
  else if (act === 'arch-restore') {
    // Restore un-deletes it server-side; the sync pass is what brings the file
    // back to this device (and every other one) — same path as any other change.
    remoteNotes.restore(el.dataset.path)
      .then(() => runSync())
      .then(() => renderArchive())
      .catch((err) => setStatus(`Restore failed — ${err.message}`))
  } else if (act === 'arch-purge') {
    confirmDelete(`Delete “${el.dataset.path}” forever? This cannot be undone.`).then((yes) => {
      if (!yes) return
      remoteNotes.purge(el.dataset.path).then(renderArchive).catch((err) => setStatus(`Failed — ${err.message}`))
    })
  }
  else if (act === 'new') openUpload()
  else if (act === 'open') openNote(el.dataset.path)
  else if (act === 'note-del') deleteNoteFlow(el.dataset.path)
  else if (act === 'wiki') { e.preventDefault(); followWiki(el.dataset.target) }
  else if (act === 'reveal') revealFile(s.dir, el.dataset.path)
  else if (act === 'q-review') {
    const job = queue.find((j) => j.id === Number(el.dataset.id))
    if (job) openUpload(job)
  }
  else if (act === 'q-retry') {
    const job = queue.find((j) => j.id === Number(el.dataset.id))
    if (job) { job.phase = 'queued'; job.error = ''; pump() }
  } else if (act === 'q-remove') {
    const i = queue.findIndex((j) => j.id === Number(el.dataset.id))
    if (i >= 0 && queue[i].phase !== 'converting') { queue.splice(i, 1); renderQueue() }
  }
}

// ---- conversion queue -----------------------------------------------------------------

// No real progress signal exists (one claude spawn, returns at the end), so
// the bar is a time estimate: asymptotic fill that hits ~63% at 30s and caps
// at 95% until the job actually finishes.
const qPct = (j) => Math.min(95, Math.round(100 * (1 - Math.exp(-(Date.now() - j.startedAt) / 30000))))

const jobLabel = (j) =>
  j.files[0]?.name
  || (j.url ? j.url.replace(/^https?:\/\//, '').split('/')[0] : '')
  || (j.text.length > 40 ? j.text.slice(0, 40) + '…' : j.text)
  || 'Note'

function pump() {
  renderQueue()
  if (queue.some((j) => j.phase === 'converting')) return // one at a time
  const job = queue.find((j) => j.phase === 'queued')
  if (!job) return
  job.phase = 'converting'
  job.startedAt = Date.now()
  renderQueue()
  if (!qTimer) qTimer = setInterval(qTick, 500)
  convertNote({
    dir: job.dir,
    files: job.files.map(({ name, media_type, data }) => ({ name, media_type, data })),
    text: job.text,
    url: job.url,
  }).then((r) => {
    job.result = { title: String(r.title || 'Untitled'), markdown: String(r.markdown || '') }
    job.filename = job.result.title
    job.label = job.result.title
    job.switched = !!r.switched
    job.phase = 'ready'
  }).catch((err) => {
    job.phase = 'error'
    job.error = err.message
  }).then(() => pump()) // render + start the next queued job
}

function qTick() {
  syncNavDot() // ponytail: renderNav wipes the class on route change; the tick reasserts it
  if (!queue.length) { clearInterval(qTimer); qTimer = null; return } // dot must survive nav while jobs wait
  const j = queue.find((x) => x.phase === 'converting')
  if (!j) return
  const fill = document.querySelector(`[data-qid="${j.id}"] .nt-qfill`)
  if (fill) fill.style.width = qPct(j) + '%'
}

// Nav dot on Notes stays lit until the queue is empty — a ready-to-review or
// failed job still needs attention, not just a running one.
function syncNavDot() {
  document.querySelector('.nav__item[href="#/notes"]')?.classList.toggle('is-busy', queue.length > 0)
}

const Q_STATUS = { queued: 'Queued', converting: 'Converting with Claude…', ready: 'Ready to review', error: 'Failed' }

function qCardHTML(j) {
  return `<div class="nt-qcard" data-qid="${j.id}">
    <div class="nt-qtop">
      <span class="nt-qlabel" title="${esc(j.label)}">${esc(j.label)}</span>
      <span class="nt-qstatus">${Q_STATUS[j.phase]}</span>
      ${j.phase === 'ready' ? `<button type="button" class="gym-btn" data-nt="q-review" data-id="${j.id}">Review</button>` : ''}
      ${j.phase === 'error' ? `<button type="button" class="gym-btn gym-btn--ghost" data-nt="q-retry" data-id="${j.id}">Retry</button>` : ''}
      ${j.phase !== 'converting' ? `<button type="button" class="nt-chip__x" data-nt="q-remove" data-id="${j.id}" aria-label="Remove">×</button>` : ''}
    </div>
    ${j.phase === 'queued' || j.phase === 'converting'
      ? `<div class="nt-qbar"><div class="nt-qfill" style="width:${j.phase === 'converting' ? qPct(j) : 0}%"></div></div>` : ''}
    ${j.phase === 'error' ? `<p class="nt-error">${esc(j.error)}</p>` : ''}
    ${j.phase === 'ready' && j.switched ? `<p class="cal-panel__cal">${esc(SWITCHED_MSG)}</p>` : ''}
  </div>`
}

function renderQueue() {
  syncNavDot()
  const el = document.getElementById('nt-queue')
  if (el) el.innerHTML = queue.map(qCardHTML).join('')
}

// ---- upload modal --------------------------------------------------------------------

// With a job: reopen a finished queue entry for review. Without: a fresh note.
function openUpload(job = null) {
  if (job && job.phase !== 'ready') return
  const s = loadNotesStore()
  up = job ? {
    files: job.files, text: job.text, url: job.url, subdir: job.subdir, newdir: job.newdir,
    phase: 'preview', busy: false, error: '', result: job.result, filename: job.filename, raw: false,
    dir: job.dir, jobId: job.id,
  } : {
    files: [], text: '', url: '', subdir: s.lastSubdir, newdir: '',
    phase: 'edit', busy: false, error: '', result: null, filename: '', raw: false,
    dir: s.dir, jobId: null,
  }
  const o = document.createElement('div')
  o.className = 'modal-overlay cal-overlay nt-overlay'
  o.addEventListener('click', (e) => {
    if (e.target === o) return closeUpload() // backdrop click
    onModalClick(e)
  })
  o.addEventListener('input', onModalInput)
  o.addEventListener('change', onModalChange)
  document.body.appendChild(o)
  renderUpload()
}

function closeUpload() {
  // reviewing a queued job — keep filename/markdown edits on the job so
  // reopening Review doesn't lose them (up.result already IS job.result)
  if (up?.jobId) {
    const job = queue.find((j) => j.id === up.jobId)
    if (job && job.phase === 'ready') { job.filename = up.filename; job.subdir = up.subdir; job.newdir = up.newdir }
  }
  document.querySelector('.nt-overlay')?.remove()
  up = null
}

const totalSize = () => up.files.reduce((a, f) => a + f.size, 0)

function renderUpload() {
  const o = document.querySelector('.nt-overlay')
  if (!o || !up) return
  const s = loadNotesStore()
  const body = up.phase === 'preview' ? previewHTML(s) : editHTML()
  o.innerHTML = `<div class="cal-panel nt-panel">
    <div class="cal-panel__head">
      <h2 class="cal-panel__title">${up.phase === 'preview' ? 'Review note' : 'New note'}</h2>
      <button type="button" class="mail-iconbtn" data-nt="up-close" aria-label="Close">✕</button>
    </div>
    ${body}
    ${up.error ? `<p class="nt-error">${esc(up.error)}</p>` : ''}
  </div>`
  if (up.phase === 'preview' && !up.raw) {
    fitEquations(o) // fit equations in the preview too
    hydrateGraphs(o) // …and plot its graphs, or the review shows an empty box
  }
}

// Apple Notes tree, rendered with the same <details> markup/classes as the
// vault's own note tree — two levels only (account, then its top-level
// folders; see the ponytail note on parseAppleTree in middlewares.js). Notes
// are buttons keyed by their stable id, never by title.
function appleTreeHTML(accounts) {
  if (!accounts.length) return '<p class="cal-wnote">No notes found in Apple Notes.</p>'
  // Collapsed by default and remembered, exactly like the vault tree. Keys are
  // namespaced 'apple:' so an Apple folder called "Classes" and a vault folder
  // called "Classes" cannot toggle each other.
  const open = new Set(loadNotesStore().openDirs)
  const key = (...parts) => `apple:${parts.join('/')}`
  return accounts.map((a) => `<details class="nt-dir" data-dir="${esc(key(a.account))}"${open.has(key(a.account)) ? ' open' : ''}><summary>${esc(a.account)}</summary>${
    a.folders.map((f) => `<details class="nt-dir" data-dir="${esc(key(a.account, f.name))}"${open.has(key(a.account, f.name)) ? ' open' : ''}><summary>${esc(f.name)}</summary>${
      f.notes.length
        ? f.notes.map((n) => `<button type="button" class="nt-note" data-nt="apple-pick" data-id="${esc(n.id)}">${esc(n.title)}</button>`).join('')
        : '<p class="cal-wnote">Empty</p>'
    }</details>`).join('')
  }</details>`).join('')
}

// Shared by both phases: a typed Apple Note (pickAppleNote) lands straight on
// the preview phase, skipping edit entirely, so the destination picker has to
// be reachable from there too or that path could never choose a folder.
function destHTML() {
  return `<div class="nt-dest">
      <label>Save into
        <select class="pw-field" data-nt-field="subdir" ${up.busy ? 'disabled' : ''}>
          <option value="">(top level)</option>
          ${(pg.tree?.dirs || []).map((d) => `<option value="${esc(d)}"${up.subdir === d ? ' selected' : ''}>${esc(d)}</option>`).join('')}
        </select>
      </label>
      <input class="pw-field" type="text" data-nt-field="newdir" placeholder="…or a new folder" value="${esc(up.newdir)}" ${up.busy ? 'disabled' : ''}>
    </div>`
}

function editHTML() {
  return `
    <p class="cal-panel__cal">Photos of handwriting, screenshots, PDFs, pasted text, or a link — Claude turns it all into one markdown note.</p>
    <div class="nt-files">
      <button type="button" class="gym-btn" data-nt="up-files" ${up.busy ? 'disabled' : ''}>Add files…</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-nt="up-apple" ${up.busy || up.apple ? 'disabled' : ''}>From Apple Notes…</button>
      <input type="file" id="nt-file-input" multiple accept="image/*,.pdf,.txt,.md" hidden>
      ${up.files.map((f, i) => `<span class="nt-chip">${esc(f.name)} <button type="button" class="nt-chip__x" data-nt="up-remove" data-i="${i}" aria-label="Remove">×</button></span>`).join('')}
    </div>
    ${up.apple ? `<div class="nt-apple">
      <div class="nt-tree">${
        up.apple.busy ? '<p class="cal-wnote">Reading…</p>'
        : up.apple.tree === null ? '<p class="cal-wnote">Loading…</p>'
        : appleTreeHTML(up.apple.tree)
      }</div>
      <button type="button" class="gym-btn gym-btn--ghost" data-nt="apple-cancel" ${up.apple.busy ? 'disabled' : ''}>Cancel</button>
    </div>` : ''}
    <textarea class="pw-field nt-text" data-nt-field="text" rows="5" placeholder="…or type/paste notes here" ${up.busy ? 'disabled' : ''}>${esc(up.text)}</textarea>
    <input class="pw-field" type="url" data-nt-field="url" placeholder="…or a website link (https://…)" value="${esc(up.url)}" ${up.busy ? 'disabled' : ''}>
    ${destHTML()}
    <div class="nt-acts">
      <button type="button" class="gym-btn" data-nt="up-convert">Convert</button>
    </div>`
}

function previewHTML(s) {
  return `
    <label class="nt-fname">Filename
      <input class="pw-field" type="text" data-nt-field="filename" value="${esc(up.filename)}" ${up.busy ? 'disabled' : ''}>
    </label>
    <span class="gf-pills">
      <button type="button" class="wk-pill${!up.raw ? ' is-on' : ''}" data-nt="up-rendered">Rendered</button>
      <button type="button" class="wk-pill${up.raw ? ' is-on' : ''}" data-nt="up-raw">Raw</button>
    </span>
    ${up.raw
      ? `<textarea class="pw-field nt-text nt-rawmd" data-nt-field="markdown" rows="16">${esc(up.result.markdown)}</textarea>`
      : `<div class="cv-annbody nt-md nt-prevmd">${renderMarkdown(up.result.markdown, s.dir)}</div>`}
    ${up.files.length ? '<p class="cal-panel__cal">Originals will be saved to “note uploads” and attached below the note.</p>' : ''}
    ${destHTML()}
    <div class="nt-acts">
      <button type="button" class="gym-btn gym-btn--ghost" data-nt="up-back" ${up.busy ? 'disabled' : ''}>Back</button>
      <button type="button" class="gym-btn" data-nt="up-save" ${up.busy ? 'disabled' : ''}>${up.busy ? 'Saving…' : 'Save note'}</button>
    </div>`
}

function onModalInput(e) {
  const f = e.target.dataset.ntField
  if (!f || !up) return
  if (f === 'markdown') up.result.markdown = e.target.value
  else up[f] = e.target.value
}

function onModalChange(e) {
  if (e.target.dataset.ntField === 'subdir' && up) { up.subdir = e.target.value; return }
  if (e.target.id !== 'nt-file-input' || !e.target.files?.length) return
  addFiles([...e.target.files])
  e.target.value = ''
}

function addFiles(list) {
  up.error = ''
  let pending = 0
  for (const file of list) {
    // typed notes as files: fold .txt/.md contents into the text box
    if (/\.(txt|md)$/i.test(file.name) || file.type.startsWith('text/')) {
      pending++
      const r = new FileReader()
      r.onload = () => { up.text = (up.text ? up.text + '\n\n' : '') + r.result; if (!--pending) renderUpload() }
      r.readAsText(file)
      continue
    }
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
    if (!isPdf && !file.type.startsWith('image/')) { up.error = `${file.name}: only images, PDFs, and text files are supported.`; continue }
    if (file.size > (isPdf ? MAX_PDF : MAX_IMG)) { up.error = `${file.name} is too big (${isPdf ? 'PDF limit 20MB' : 'image limit 5MB'}).`; continue }
    if (totalSize() + file.size > MAX_TOTAL) { up.error = 'Total upload limit is 25MB — split into two notes.'; continue }
    pending++
    const r = new FileReader()
    r.onload = () => {
      up.files.push({
        name: file.name,
        media_type: isPdf ? 'application/pdf' : file.type,
        data: String(r.result).split(',')[1], // strip the data: URL prefix
        size: file.size,
      })
      if (!--pending) renderUpload()
    }
    r.readAsDataURL(file)
  }
  if (!pending) renderUpload()
}

// Opens the account/folder/note tree. Fetching a note happens on click, in
// pickAppleNote below — nothing is exported/duplicated just by browsing.
async function openApplePicker() {
  up.error = ''
  up.apple = { tree: null, busy: false } // tree:null = still loading the list
  renderUpload()
  try {
    const tree = await appleNotesTree()
    if (!up?.apple) return // modal closed / cancelled while listing
    up.apple.tree = tree
  } catch (err) {
    if (!up) return
    up.apple = null
    up.error = err.message
  }
  renderUpload()
}

// Fetches one note's full content directly by its stable id — no export, no
// duplicate/delete in Apple Notes. A typed note comes back as markdown and
// goes straight into the preview (same shape as a claude conversion result,
// so it reuses that whole screen — Save writes only into Atlas's vault, never
// back into Apple Notes). A handwritten note still needs claude to transcribe
// the rendered ink, so its PDF page(s) join up.files as normal upload chips,
// exactly like a file upload — the user then hits Convert as usual. A
// truncated (not-yet-synced) handwritten note surfaces its error instead of
// silently importing a partial page.
async function pickAppleNote(id) {
  if (!up?.apple || up.apple.busy) return
  up.apple.busy = true
  up.error = ''
  renderUpload()
  try {
    const note = await appleNotesFetch(id)
    if (!up) return
    if (note.kind === 'typed') {
      up.result = { title: note.title, markdown: note.markdown }
      up.filename = note.title
      up.raw = false
      up.apple = null
      up.phase = 'preview'
    } else {
      if (!note.files.length) throw new Error('That note produced no pages to import.')
      for (const f of note.files) {
        const size = Math.floor((f.data || '').length * 0.75) // base64 → bytes
        if (size > MAX_PDF) throw new Error(`${f.name} rendered at ${(size / 1e6).toFixed(1)}MB — over the 20MB PDF limit.`)
        if (totalSize() + size > MAX_TOTAL) throw new Error('Total upload limit is 25MB — split into two notes.')
        up.files.push({ name: f.name, media_type: f.media_type, data: f.data, size })
      }
      up.apple = null
    }
  } catch (err) {
    if (!up) return
    if (up.apple) up.apple.busy = false
    up.error = err.message
  }
  renderUpload()
}

function onModalClick(e) {
  const el = e.target.closest('[data-nt]')
  if (!el || !up) return
  const act = el.dataset.nt
  if (act === 'up-close') closeUpload()
  else if (act === 'up-files') document.getElementById('nt-file-input')?.click()
  else if (act === 'up-apple') openApplePicker()
  else if (act === 'apple-pick') pickAppleNote(el.dataset.id)
  else if (act === 'apple-cancel') { up.apple = null; renderUpload() }
  else if (act === 'up-remove') { up.files.splice(Number(el.dataset.i), 1); renderUpload() }
  else if (act === 'up-convert') doConvert()
  else if (act === 'up-rendered') { up.raw = false; renderUpload() }
  else if (act === 'up-raw') { up.raw = true; renderUpload() }
  else if (act === 'up-back') { up.phase = 'edit'; up.error = ''; renderUpload() }
  else if (act === 'up-save') doSave()
}

// Convert = enqueue: the modal closes immediately and the job runs in the
// background (queue strip at the top of the page shows progress).
function doConvert() {
  // iOS has no sidecar, so the AI converter can't run there. Reading, editing,
  // and deleting iCloud notes still work — only new-note conversion needs the Mac.
  if (isNativeIOS()) {
    up.error = 'Creating a note from uploads needs the Mac app — its AI converter isn’t available on iPhone/iPad. You can still read, edit, and delete your iCloud notes here.'
    return renderUpload()
  }
  if (!providerForCapability('notes')) {
    up.error = NO_AI_MSG
    return renderUpload()
  }
  if (!up.files.length && !up.text.trim() && !up.url.trim()) {
    up.error = 'Add a file, some text, or a link first.'
    return renderUpload()
  }
  const job = {
    id: ++qSeq, dir: up.dir,
    files: up.files, text: up.text.trim(), url: up.url.trim(),
    subdir: up.subdir, newdir: up.newdir,
    phase: 'queued', error: '', result: null, filename: '',
  }
  job.label = jobLabel(job)
  // re-converting a reviewed job (Back → edit → Convert) replaces it
  if (up.jobId) {
    const i = queue.findIndex((j) => j.id === up.jobId)
    if (i >= 0) queue.splice(i, 1)
  }
  queue.push(job)
  up.jobId = null // closeUpload must not write edit-phase state onto the fresh job
  closeUpload()
  pump()
}

async function doSave() {
  if (!up.filename.trim()) { up.error = 'Give the note a filename.'; return renderUpload() }
  const s = loadNotesStore()
  const dir = up.dir || s.dir
  const subdir = up.newdir.trim().replace(/^\/+|\/+$/g, '') || up.subdir
  up.busy = true
  up.error = ''
  renderUpload()
  try {
    const r = await saveNote({
      dir,
      subdir,
      filename: up.filename.trim(),
      markdown: up.result.markdown,
      uploads: up.files.map(({ name, data }) => ({ name, data })),
    })
    s.lastSubdir = subdir
    saveNotesStore(s)
    const jobId = up.jobId
    up.jobId = null // job is resolved — don't write review edits back onto it
    closeUpload()
    if (jobId) {
      const i = queue.findIndex((j) => j.id === jobId)
      if (i >= 0) queue.splice(i, 1)
      renderQueue()
    }
    setStatus(`Saved ${r.path}`)
    if (dir === s.dir) await loadTree(s.dir, r.path)
  } catch (err) {
    if (up) { up.error = err.message; up.busy = false; renderUpload() }
  }
}
