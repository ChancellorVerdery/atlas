// Notes plugin UI: pick a root notes folder, browse and read the markdown
// inside it (clickable [[wiki-links]]), and turn uploads — handwriting
// photos, screenshots, PDFs, pasted text, web links — into new notes.
// Conversion runs in the dev server (/notes-api → Claude). Hitting Convert
// queues the job at the top of the page (one converts at a time, the rest
// wait) so other Atlas pages stay usable; finished jobs hold for review —
// nothing is written to disk until the preview is approved.

import {
  loadNotesStore, saveNotesStore, pickFolder, fetchTree, convertNote, saveNote,
  appleNotesTree, appleNotesFetch, fileURL, revealFile, WIKI_RE, EMBED_RE, IMG_RE,
} from './notes.js'
import { sanitizeHTML } from './canvasui.js'
import { marked } from 'marked'
import { convertLatexToMarkup } from 'mathlive' // mathlive CSS is loaded globally by view.js
import { renderMath, fitEquations } from './view.js' // reuse the equations plugin's scale-to-fit

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

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

export function renderNotesPage(root) {
  const s = loadNotesStore()
  if (!s.dir) {
    root.innerHTML = `<div class="nt">
      <div class="gf-empty">
        <p class="gym-empty">Pick your notes folder and Atlas turns anything you upload — handwriting, screenshots, PDFs, links — into markdown notes with wiki-links.</p>
        <button type="button" class="gym-btn" data-nt="pick">Choose folder…</button>
      </div>
    </div>`
    root.onclick = onPageClick
    return
  }
  root.innerHTML = `<div class="nt">
    <div class="gf-bar">
      <button type="button" class="gym-btn" data-nt="new">+ New note</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-nt="pick">Change folder…</button>
      <span class="gf-dir" title="${esc(s.dir)}">${esc(dirName(s.dir))}</span>
      <span class="gf-status" id="nt-status"></span>
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

function treeHTML(node) {
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))
  const notes = [...node.notes].sort((a, b) => a.path.localeCompare(b.path))
  return dirs.map(([name, child]) => `<details class="nt-dir" open><summary>${esc(name)}</summary>${treeHTML(child)}</details>`).join('')
    + notes.map((n) => `<button type="button" class="nt-note${pg.open === n.path ? ' is-open' : ''}" data-nt="open" data-path="${esc(n.path)}">${esc(noteName(n.path))}</button>`).join('')
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
function renderMarkdown(text, dir) {
  const math = []
  const src = stripOriginals(text)
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
  return sanitizeHTML(html)
}

async function openNote(rel) {
  const s = loadNotesStore()
  pg.open = rel
  document.querySelectorAll('.nt-note').forEach((b) => b.classList.toggle('is-open', b.dataset.path === rel))
  const view = document.getElementById('nt-view')
  if (!view) return
  view.innerHTML = '<p class="cal-wnote">Loading…</p>'
  try {
    const r = await fetch(fileURL(s.dir, rel))
    if (!r.ok) throw new Error((await r.json()).error || `read failed (${r.status})`)
    const text = await r.text()
    if (pg.open !== rel || !document.getElementById('nt-view')) return // clicked away mid-fetch
    view.innerHTML = `
      <div class="nt-view__head">
        <h2 class="nt-view__title">${esc(noteName(rel))}</h2>
        <button type="button" class="gym-btn gym-btn--ghost" data-nt="reveal" data-path="${esc(rel)}">Reveal in Finder</button>
      </div>
      <p class="gf-card__file" title="${esc(rel)}">${esc(rel)}</p>
      <div class="cv-annbody nt-md">${renderMarkdown(text, s.dir)}</div>`
    fitEquations(view) // scale any overflowing block equations to fit
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
      if (r.canceled || !r.path) return
      s.dir = r.path
      s.lastSubdir = ''
      saveNotesStore(s)
      pg.tree = null
      pg.open = null
      renderNotesPage(document.querySelector('.nt').parentElement)
    })
  } else if (act === 'new') openUpload()
  else if (act === 'open') openNote(el.dataset.path)
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
  if (up.phase === 'preview' && !up.raw) fitEquations(o) // fit equations in the preview too
}

// Apple Notes tree, rendered with the same <details> markup/classes as the
// vault's own note tree — two levels only (account, then its top-level
// folders; see the ponytail note on parseAppleTree in middlewares.js). Notes
// are buttons keyed by their stable id, never by title.
function appleTreeHTML(accounts) {
  if (!accounts.length) return '<p class="cal-wnote">No notes found in Apple Notes.</p>'
  return accounts.map((a) => `<details class="nt-dir" open><summary>${esc(a.account)}</summary>${
    a.folders.map((f) => `<details class="nt-dir" open><summary>${esc(f.name)}</summary>${
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
