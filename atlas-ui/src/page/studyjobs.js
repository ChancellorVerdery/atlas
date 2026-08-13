// Shared upload → extract → review pipeline for Study (target: 'questions')
// and Flashcards (target: 'cards') — same dev-server job store
// (server/middlewares.js /study-api, see study.js's extractStudy/listJobs/
// getJob/retryJob/removeJob), same UI shell. Each plugin keeps its OWN job
// mirror + poll timer (studyui.js / flashcardsui.js) and calls into these
// pure/parameterized pieces rather than duplicating ~400 lines of HTML and
// file-handling — but nothing here holds cross-plugin state, so Study and
// Flashcards stay independent stores wired through a shared UI toolkit.

import { getJob, removeJob, fixSlashes, fixEscapes } from './study.js'
import { sanitizeHTML } from './canvasui.js'
import { marked } from 'marked'
import { convertLatexToMarkup } from 'mathlive'
import { renderMath } from './view.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// No file-type restriction — anything can be uploaded, and the dev server
// converts what Claude can't read natively (HEIC photos, Word docs). The only
// caps left are transport ones: the JSON body has to stay under /study-api's
// 50MB backstop, and Claude Code resizes oversized images itself.
export const MAX_FILE = 25e6, MAX_TOTAL = 45e6

// ponytail: one Claude-turn lock shared by Study (tutor chat / grading) and
// Flashcards — both ride the dev server's single claude-CLI process through
// /study-api, so a shared object (not a per-plugin copy) keeps "one turn at a
// time" true even across a navigation between the two pages, not just within
// one. Neither plugin's own store depends on this — it's UI-only.
export const busyBox = { v: null }

// ---- markdown + math rendering (same $…$ pipeline as the Notes viewer) ------

const fixDots = (latex) => latex.replace(/\\dotsb\b/g, '\\cdots').replace(/\\dots[cmio]?\b/g, '\\ldots')

// Bare-LaTeX (not prose-with-$…$) inline render — bank/review answer cells,
// where the field IS the equation rather than containing one.
export const inlineMath = (latex) => {
  try { return `<span class="nt-math">${convertLatexToMarkup(fixDots(fixSlashes(latex)).trim(), { defaultMode: 'textstyle' })}</span>` }
  catch { return esc(latex) }
}
const mathMarkup = (latex, block) => (block ? renderMath(fixDots(latex)) : inlineMath(latex))

// Inline math requires non-space immediately inside both delimiters (Pandoc's
// rule). Without it, "$12 for the first unit and $30" reads as one math span
// and both dollar amounts vanish — and this is a prose channel (tutor chat,
// card faces), not the math-first Notes viewer this came from.
const INLINE_MATH = /\$(?![\s$])([^\n$]*[^\s$])\$/g

export function stMD(text) {
  const math = []
  const src = fixEscapes(text) // raw paths (review items) bypass the normalizers
    .replace(/\\\[([\s\S]+?)\\\]/g, (m, l) => `$$${l}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (m, l) => `$${l.replace(/\n/g, ' ')}$`)
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, l) => `STMATH${math.push(mathMarkup(l, true)) - 1}STMATH`)
    .replace(INLINE_MATH, (m, l) => `STMATH${math.push(mathMarkup(l, false)) - 1}STMATH`)
  const html = marked.parse(src)
    .replace(/<p>STMATH(\d+)STMATH<\/p>/g, (m, i) => math[Number(i)])
    .replace(/STMATH(\d+)STMATH/g, (m, i) => math[Number(i)])
  return sanitizeHTML(html)
}

// ---- job queue strip ---------------------------------------------------------

// No real progress signal exists (one claude spawn, returns at the end), so
// each bar is a time estimate: asymptotic fill that hits ~63% at 30s and caps
// at 95% until its job actually finishes. (Same estimator as Notes.)
export const qPct = (j) => Math.min(95, Math.round(100 * (1 - Math.exp(-(Date.now() - j.startedAt) / 30000))))

const Q_STATUS = { queued: 'Queued', converting: 'Extracting with Claude…', ready: 'Ready to review', error: 'Failed' }

export function jobCardHTML(j) {
  return `<div class="nt-qcard" data-qid="${j.id}">
    <div class="nt-qtop">
      <span class="nt-qlabel" title="${esc(j.label)}">${esc(j.label)}</span>
      <span class="nt-qstatus">${Q_STATUS[j.phase] || esc(j.phase)}${j.phase === 'ready' ? ` — ${j.count} ${j.target === 'cards' ? 'card' : 'question'}${j.count === 1 ? '' : 's'}` : ''}</span>
      ${j.phase === 'ready' ? `<button type="button" class="gym-btn gym-btn--sm" data-st="job-review" data-id="${j.id}">Review</button>` : ''}
      ${j.phase === 'error' ? `<button type="button" class="gym-btn gym-btn--ghost gym-btn--sm" data-st="job-retry" data-id="${j.id}">Retry</button>` : ''}
      ${j.phase !== 'converting' ? `<button type="button" class="nt-chip__x" data-st="job-remove" data-id="${j.id}" aria-label="Remove">×</button>` : ''}
    </div>
    ${j.phase === 'queued' || j.phase === 'converting'
      ? `<div class="nt-qbar"><div class="nt-qfill" style="width:${j.phase === 'converting' ? qPct(j) : 0}%"></div></div>` : ''}
    ${j.phase === 'error' ? `<p class="nt-error">${esc(j.error)}</p>` : ''}
    ${j.phase === 'ready' && j.switched ? '<p class="cal-panel__cal">Primary AI was out of tokens — switched to your secondary.</p>' : ''}
  </div>`
}

// `js` is already filtered to the current course + tool (caller's stripJobs).
export function queueHTML(js) {
  const ready = js.filter((j) => j.phase === 'ready')
  const items = ready.reduce((a, j) => a + j.count, 0)
  const all = ready.length > 1
    ? `<div class="st-qall"><button type="button" class="gym-btn gym-btn--sm" data-st="jobs-import-all">Import all — ${ready.length} files, ${items} item${items === 1 ? '' : 's'}</button></div>` : ''
  return all + js.map(jobCardHTML).join('')
}

// Nav dot stays lit until the queue is empty — a ready-to-review or failed
// job still needs attention, not just a running one.
export function syncNavDot(navHash, hasJobs) {
  document.querySelector(`.nav__item[href="${navHash}"]`)?.classList.toggle('is-busy', hasJobs)
}

// ---- upload → extract → review -----------------------------------------------

const totalSize = (files) => files.reduce((a, f) => a + f.size, 0)

// Mutates modal `m` in place (error/text/files) as FileReader callbacks
// resolve; calls `onDone()` once every file in `list` has settled.
export function addFiles(m, list, onDone) {
  m.error = ''
  let pending = 0
  for (const file of list) {
    // plain text lands in the paste box so it stays visible and editable
    if (/\.(txt|md|csv)$/i.test(file.name) || file.type.startsWith('text/')) {
      pending++
      const r = new FileReader()
      r.onload = () => { m.text = (m.text ? m.text + '\n\n' : '') + r.result; if (!--pending) onDone() }
      r.readAsText(file)
      continue
    }
    if (file.size > MAX_FILE) { m.error = `${file.name} is too big (limit ${MAX_FILE / 1e6}MB per file).`; continue }
    if (totalSize(m.files) + file.size > MAX_TOTAL) { m.error = `Total upload limit is ${MAX_TOTAL / 1e6}MB — split it up.`; continue }
    pending++
    const r = new FileReader()
    r.onload = () => {
      // media_type may be '' for types the OS doesn't recognize; the server
      // falls back to the filename extension, so send the name regardless
      m.files.push({ name: file.name, media_type: file.type || '', data: String(r.result).split(',')[1], size: file.size })
      if (!--pending) onDone()
    }
    r.readAsDataURL(file)
  }
  if (!pending) onDone()
}

export function uploadHTML(m) {
  return `
    <p class="cal-panel__cal">${m.target === 'cards'
      ? 'Any files — photos, PDFs, Word docs, slides, notes — or pasted text. Claude turns definitions, formulas, and key facts into flashcards for this course.'
      : 'Old homework, worksheets, exams, notes — any file type or pasted text. Claude mines them for practice questions (answers included) for this course\'s bank.'}</p>
    <div class="nt-files">
      <button type="button" class="gym-btn" data-st="up-files">Add files…</button>
      <input type="file" id="${m.target === 'cards' ? 'fc-file-input' : 'st-file-input'}" multiple hidden>
      ${m.files.map((f, i) => `<span class="nt-chip">${esc(f.name)} <button type="button" class="nt-chip__x" data-st="up-remove" data-i="${i}" aria-label="Remove">×</button></span>`).join('')}
    </div>
    ${m.files.length > 1 ? `<label class="st-bundle"><input type="checkbox" data-st="up-bundle"${m.bundle ? ' checked' : ''}> One bundle — one agent per document; figure images named after a file (&quot;1.11 fig 2.png&quot;) attach to its questions, and an all-image bundle keeps a single agent</label>` : ''}
    <textarea class="pw-field nt-text" data-stf="uptext" rows="5" placeholder="…or paste material here">${esc(m.text)}</textarea>
    <div class="nt-acts"><button type="button" class="gym-btn" data-st="up-extract">Extract</button></div>
    <p class="cal-panel__cal">Extract queues the job — progress shows at the top of the page, and Atlas stays usable while Claude works.</p>`
}

// `itemHTML(item, i)` renders one reviewed item's preview — the caller
// supplies it (question preview needs figsHTML/partAnswerHTML from study;
// card preview is a plain front/back pair) so this stays plugin-agnostic.
export function reviewHTML(m, itemHTML) {
  return `
    <p class="cal-panel__cal">${m.items.length ? 'Uncheck anything you don\'t want, then import.' : 'Claude found nothing usable in that material.'}</p>
    <div class="st-revlist">
      ${m.items.map((it, i) => `<label class="st-rev">
        <input type="checkbox" data-st-rev="${i}" ${m.chosen.has(i) ? 'checked' : ''}>
        ${itemHTML(it, i)}
      </label>`).join('')}
    </div>
    <div class="nt-acts">
      ${m.items.length ? `<button type="button" class="gym-btn" data-st="m-import">Import ${m.chosen.size} selected</button>` : ''}
    </div>`
}

// One click for a whole semester's worth of ready files — items land exactly
// as a per-job review import would (same normalizers via `pushInto`), jobs
// leave the strip. Caller owns saving the store and re-rendering.
export async function importAllReady(jobsList, tab, target, pushInto, pushSys) {
  const failed = []
  for (const job of jobsList.filter((j) => j.tabId === tab.id && j.phase === 'ready' && j.target === target)) {
    let full
    try { full = await getJob(job.id) } catch (err) { failed.push(`${job.label}: ${err.message}`); continue }
    if (full?.phase !== 'ready') continue
    pushInto(tab, full.results || [])
    removeJob(job.id).catch(() => {})
  }
  for (const f of failed) pushSys?.(tab.id, `Import failed for ${f}`)
  return failed
}

// Wires the hidden <input type=file> that a plugin's "Add files…" button
// clicks — each plugin uses its own element id, so the two never collide
// even though the listener lives on `document` for the app's lifetime.
export function bindFileInput(id, onFiles) {
  document.addEventListener('change', (e) => {
    if (e.target.id !== id || !e.target.files?.length) return
    onFiles([...e.target.files])
    e.target.value = ''
  })
}
