// Flashcards plugin UI — a full-window page (registry: full:true), split out
// of Study (2026-08) into its own plugin + store (atlas.flashcards.v1, see
// flashcards.js). Course tabs across the top; per tab two tools: Flashcards
// (spaced repetition, 1-3-7-14-21-day ladder) and Card bank (view/add/edit/
// upload-extract). Fully independent from Study — its own tab list, no
// shared courses — but reuses Study's CSS classes and, via studyjobs.js, the
// upload/extract/review pipeline and the app-wide "one Claude turn" lock
// (both plugins' Claude work rides the same dev-server /study-api, see
// study.js's extractStudy/listJobs/getJob/retryJob/removeJob).

import {
  loadFlashcards, saveFlashcards, newTab, normCard,
  localToday, dueCards, gradeCard,
} from './flashcards.js'
import { extractStudy, listJobs, getJob, retryJob, removeJob } from './study.js'
import {
  busyBox, stMD, syncNavDot as jobsSyncNavDot, queueHTML as jobsQueueHTML, qPct,
  addFiles as jobsAddFiles, uploadHTML as jobsUploadHTML, reviewHTML as jobsReviewHTML,
  importAllReady as jobsImportAllReady, bindFileInput,
} from './studyjobs.js'
import { fitEquations } from './view.js'
import { confirmDelete } from './confirm.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Session-only state — survives re-renders and page switches, not reloads.
const ui = {
  tool: 'cards',   // cards | cardbank
  rename: null,    // non-null while the active tab name is being edited
  fc: null,        // flashcard session { ids, i, missed:Set, flipped, practice }
  modal: null,     // { type: 'card'|'upload'|'review', … }
  // ponytail: busy is backed by studyjobs' shared lock, same object Study
  // uses — nothing here reads/writes it today (no on-demand Claude call in
  // Flashcards, only queued extraction), but it's kept wired so a future
  // foreground Claude call here (e.g. a card judge) automatically respects
  // "one turn app-wide" instead of racing a Study tutor turn.
  get busy() { return busyBox.v },
  set busy(v) { busyBox.v = v },
}
let pageRoot = null

// Extraction queue — a MIRROR of the dev server's job store (see studyui.js
// for the full rationale). Scoped to target:'cards' only — Study's
// 'questions' jobs live in its own mirror there.
let jobs = []
let qTimer = null
let qBeat = 0

// ---- helpers ----------------------------------------------------------------

const curTab = (s) => s.tabs.find((t) => t.id === s.active) || s.tabs[0] || null

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ponytail: no chat transcript to post failures to (unlike Study) — console
// only. Upgrade path is an inline notice banner if this proves to matter.
function pushSys(tabId, text) { console.error(`[flashcards] ${text}`) }

const onFlashcardsPage = () => location.hash.replace(/^#\/?/, '').split('/')[0] === 'flashcards'

// ---- page entry -------------------------------------------------------------

export function renderFlashcardsPage(root) {
  pageRoot = root
  root.onclick = onClick
  root.oninput = onInput
  root.onchange = onChange
  root.ondblclick = onDblClick
  render()
  refreshJobs() // rebuild the queue strip from the server — bars survive reload
}

function captureFocus() {
  const el = document.activeElement
  if (!el || !pageRoot?.contains(el) || !el.id) return null
  const f = { sel: `#${el.id}` }
  try { f.start = el.selectionStart; f.end = el.selectionEnd } catch { /* not a text input */ }
  return f
}
function restoreFocus(f) {
  const el = f && pageRoot.querySelector(f.sel)
  if (!el) return false
  el.focus()
  if (f.start != null) try { el.setSelectionRange(f.start, f.end) } catch { /* not a plain text input */ }
  return true
}

function render() {
  if (!pageRoot?.isConnected || !onFlashcardsPage()) return
  // Flashcards fits the viewport during a review session (the card scrolls
  // internally); the bank list keeps normal page scrolling. Scoped to
  // data-page="flashcards" in the CSS, so a lingering class can never affect
  // other pages.
  document.documentElement.classList.toggle('st-fit', ui.tool === 'cards')
  const keep = captureFocus()
  const s = loadFlashcards()
  if (!s.tabs.length) {
    pageRoot.innerHTML = `<div class="st"><div class="gf-empty">
      <p class="gym-empty">Make a tab per course — each gets flashcards on a spaced-repetition schedule.</p>
      <button type="button" class="gym-btn" data-st="tab-add">+ Add your first course</button>
    </div></div>`
    return
  }
  const tab = curTab(s)
  const views = { cards: cardsView, cardbank: cardBankView }
  pageRoot.innerHTML = `<div class="st">
    ${tabsBar(s)}
    ${toolsBar(tab)}
    <div class="nt-queue" id="fc-queue">${jobsQueueHTML(stripJobs())}</div>
    <div class="st-view">${(views[ui.tool] || cardsView)(tab)}</div>
  </div>`
  syncNavDot()
  fitEquations(pageRoot)
  if (restoreFocus(keep)) return // mid-edit: keep the caret exactly where it was
  if (ui.rename != null) {
    const el = pageRoot.querySelector('#fc-rename')
    if (el) { el.focus(); el.select() } // first render of a fresh rename: select all
  }
}

// ---- chrome: course tabs + tool pills ---------------------------------------

const tabBtnHTML = (t, active) =>
  `<button type="button" class="page-tab st-tab${active ? ' is-active' : ''}" data-st="tab" data-id="${esc(t.id)}"${active ? ' title="Double-click to rename"' : ''}><span class="st-tab__name">${esc(t.name)}</span>${active ? `<span class="st-tab__x" data-st="tab-del" data-id="${esc(t.id)}" aria-label="Delete course">×</span>` : ''}</button>`

function tabsBar(s) {
  return `<div class="page-tabs st-tabs">
    ${s.tabs.map((t) => {
      const active = t.id === s.active
      return active && ui.rename != null
        ? `<span class="page-tab st-tab is-active st-tab--edit"><input id="fc-rename" class="st-tab__in" value="${esc(ui.rename)}" data-stf="rename" spellcheck="false"></span>`
        : tabBtnHTML(t, active)
    }).join('')}
    <button type="button" class="page-tab st-tab st-tab--add" data-st="tab-add" aria-label="Add course">+</button>
  </div>`
}

function toolsBar(tab) {
  const due = dueCards(tab).length
  const T = [
    ['cards', due ? `Flashcards (${due} due)` : 'Flashcards'],
    ['cardbank', `Card bank (${tab.cards.length})`],
  ]
  return `<div class="st-tools">${T.map(([k, l]) =>
    `<button type="button" class="wk-pill${ui.tool === k ? ' is-on' : ''}" data-st="tool" data-tool="${k}">${esc(l)}</button>`).join('')}</div>`
}

// ---- Flashcards -------------------------------------------------------------

function cardsView(tab) {
  const today = localToday()
  const due = dueCards(tab, today)
  const f = ui.fc
  if (!f) {
    const next = tab.cards.filter((c) => c.due && c.due > today).sort((a, b) => (a.due < b.due ? -1 : 1))[0]
    return `<div class="card st-fcpanel">
      <h3 class="gym-head">Flashcards</h3>
      <p class="gym-sub">${tab.cards.length} card${tab.cards.length === 1 ? '' : 's'} · <b>${due.length} due</b>${!due.length && next ? ` — next on ${esc(next.due)}` : ''}</p>
      <p class="st-ladder">Each correct answer roughly doubles the wait — 1, 3, 7, 14, then 21 days. A miss starts back at 1 day.</p>
      <div class="st-fcacts">
        <button type="button" class="gym-btn" data-st="fc-start" ${due.length ? '' : 'disabled'}>Review ${due.length} due</button>
        <button type="button" class="gym-btn gym-btn--ghost" data-st="fc-practice" ${tab.cards.length ? '' : 'disabled'}>Practice all (no scheduling)</button>
      </div>
      ${tab.cards.length ? '' : '<p class="gym-empty">No cards yet — add or upload some in the Card bank tab.</p>'}
    </div>`
  }
  if (f.i >= f.ids.length) {
    return `<div class="card st-fcpanel">
      <h3 class="gym-head">Session done</h3>
      <p class="gym-sub">${f.ids.length} review${f.ids.length === 1 ? '' : 's'} · ${f.missed.size} card${f.missed.size === 1 ? '' : 's'} missed${f.practice ? ' · practice run, nothing rescheduled' : ''}</p>
      <div class="st-fcacts"><button type="button" class="gym-btn" data-st="fc-end">Done</button></div>
    </div>`
  }
  const card = curTab(loadFlashcards())?.cards.find((c) => c.id === f.ids[f.i])
  if (!card) { f.i++; return cardsView(tab) } // card deleted mid-session
  return `<div class="st-fcwrap">
    <div class="st-fcbar">
      <span>${f.i + 1} / ${f.ids.length}</span>
      ${f.practice ? '<span class="st-gen">practice</span>' : ''}
      <button type="button" class="gym-btn gym-btn--ghost gym-btn--sm" data-st="fc-end">End session</button>
    </div>
    <div class="card st-flash${f.flipped ? ' is-flipped' : ''}" data-st="fc-flip">
      <div class="st-flash__content">${stMD(f.flipped ? card.back : card.front)}</div>
      <div class="st-flash__hint">${f.flipped ? 'front ⇄ back' : 'click or space to flip'}</div>
    </div>
    ${f.flipped ? `<div class="st-fcacts">
      <button type="button" class="gym-btn gym-btn--ghost" data-st="fc-miss">✘ Missed <kbd>1</kbd></button>
      <button type="button" class="gym-btn" data-st="fc-got">✔ Got it <kbd>2</kbd></button>
    </div>` : ''}
  </div>`
}

function startSession(practice) {
  const s = loadFlashcards()
  const tab = curTab(s)
  if (!tab) return
  const pool = practice ? tab.cards : dueCards(tab)
  if (!pool.length) return
  ui.fc = { ids: shuffle(pool.map((c) => c.id)), i: 0, missed: new Set(), flipped: false, practice }
  render()
}

function gradeFc(got) {
  const f = ui.fc
  if (!f || !f.flipped) return
  const s = loadFlashcards()
  const tab = curTab(s)
  const id = f.ids[f.i]
  const card = tab?.cards.find((c) => c.id === id)
  if (card && !f.practice) {
    // a same-session recovery after a miss keeps the demotion the miss wrote
    if (!got) gradeCard(card, false)
    else if (!f.missed.has(id)) gradeCard(card, true)
    saveFlashcards(s)
  }
  if (!got) { f.missed.add(id); f.ids.push(id) } // missed cards recycle until cleared
  f.i++
  f.flipped = false
  render()
}

// ---- Card bank --------------------------------------------------------------

function cardBankView(tab) {
  const today = localToday()
  const dueChip = (c) => (!c.due ? 'new' : c.due <= today ? 'due now' : `due ${c.due}`)
  return `
    <div class="gf-bar">
      <button type="button" class="gym-btn" data-st="c-add">+ Add card</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-st="up-open" data-target="cards">Upload material…</button>
      <span class="gf-status">${tab.cards.length ? `${tab.cards.length} card${tab.cards.length === 1 ? '' : 's'}` : ''}</span>
    </div>
    ${tab.cards.length ? `<div class="card st-crows">${tab.cards.map((c) => `<div class="st-crow">
        <div class="st-crow__front">${stMD(c.front)}</div>
        <div class="st-crow__back">${stMD(c.back)}</div>
        <span class="st-duechip">${esc(dueChip(c))}</span>
        <div class="st-qrow__acts">
          <button type="button" class="st-iconbtn" data-st="c-edit" data-id="${esc(c.id)}" aria-label="Edit">✎</button>
          <button type="button" class="nt-chip__x" data-st="c-del" data-id="${esc(c.id)}" aria-label="Remove">×</button>
        </div>
      </div>`).join('')}</div>`
      : '<p class="gym-empty">No cards yet — upload material (definitions, formulas, key facts) or add cards by hand. The Flashcards tab schedules them for you.</p>'}`
}

// ---- upload → extract → review ----------------------------------------------
// Shared with Study via studyjobs.js (HTML rendering, file handling, bulk
// import) — this file supplies the card-specific bits (the review-item
// preview) and keeps its own job mirror + poll timer scoped to
// target:'cards', so a question extraction on the Study page never surfaces
// here.

function syncNavDot() { jobsSyncNavDot('#/flashcards', jobs.length > 0) }

const tabJobs = () => {
  const active = curTab(loadFlashcards())?.id
  return jobs.filter((j) => j.tabId === active)
}

const stripJobs = () => tabJobs().filter((j) => j.phase !== 'ready' || ui.tool === 'cardbank')

function renderQueue() {
  syncNavDot()
  const el = document.getElementById('fc-queue')
  if (el) el.innerHTML = jobsQueueHTML(stripJobs())
}

let bulkBusy = false
async function importAllReady() {
  if (bulkBusy) return
  bulkBusy = true
  try {
    const s = loadFlashcards()
    const tab = curTab(s)
    if (!tab) return
    await jobsImportAllReady(jobs, tab, 'cards', (t, items) => t.cards.push(...items.map((c) => normCard({ front: c.front, back: c.back }))), pushSys)
    saveFlashcards(s)
    await refreshJobs()
    render()
  } finally { bulkBusy = false }
}

async function refreshJobs() {
  let r
  try { r = await listJobs() } catch { return } // dev server unreachable — keep what we have
  const all = Array.isArray(r?.jobs) ? r.jobs : []
  const tabIds = new Set(loadFlashcards().tabs.map((t) => t.id))
  jobs = (tabIds.size ? all.filter((j) => tabIds.has(j.tabId)) : all).filter((j) => j.target === 'cards')
  renderQueue()
  if (jobs.length && !qTimer) qTimer = setInterval(qTick, 600)
  if (!jobs.length && qTimer) { clearInterval(qTimer); qTimer = null }
}

function qTick() {
  syncNavDot()
  for (const j of jobs) {
    if (j.phase !== 'converting') continue
    const fill = document.querySelector(`[data-qid="${j.id}"] .nt-qfill`)
    if (fill) fill.style.width = qPct(j) + '%'
  }
  if (++qBeat % 4 === 0) refreshJobs()
}

async function enqueueExtract() {
  const m = ui.modal
  if (!m) return
  if (!m.files.length && !m.text.trim()) { m.error = 'Add files or paste some material first.'; return renderModal() }
  const s = loadFlashcards()
  const tab = curTab(s)
  const payload = {
    target: 'cards', tabId: tab.id, tabName: tab.name,
    files: m.files.map(({ name, media_type, data }) => ({ name, media_type, data })),
    bundle: m.files.length > 1 && !!m.bundle,
    text: m.text,
  }
  closeModal()
  try { await extractStudy(payload) } catch (err) { pushSys(tab.id, `Upload failed: ${err.message}`); render() }
  refreshJobs()
}

function importChosen() {
  const m = ui.modal
  const s = loadFlashcards()
  const tab = s.tabs.find((t) => t.id === m.tabId)
  if (tab) {
    const picked = m.items.filter((_, i) => m.chosen.has(i))
    tab.cards.push(...picked.map((c) => normCard({ front: c.front, back: c.back })))
    saveFlashcards(s)
  }
  removeJob(m.jobId).catch(() => {}).then(refreshJobs) // resolved — off the strip
  closeModal()
}

// ---- modals -----------------------------------------------------------------

function openModal(m) {
  ui.modal = m
  let o = document.querySelector('.st-overlay')
  if (!o) {
    o = document.createElement('div')
    o.className = 'modal-overlay cal-overlay st-overlay'
    o.addEventListener('click', (e) => { if (e.target === o) return closeModal(); onModalClick(e) })
    o.addEventListener('input', onModalInput)
    o.addEventListener('change', onModalInput)
    document.body.appendChild(o)
  }
  renderModal()
}

function closeModal() {
  document.querySelector('.st-overlay')?.remove()
  ui.modal = null
  render()
}

window.addEventListener('hashchange', () => {
  if (!onFlashcardsPage()) { document.querySelector('.st-overlay')?.remove(); ui.modal = null }
})

function renderModal() {
  const o = document.querySelector('.st-overlay')
  const m = ui.modal
  if (!o || !m) return
  const TITLES = { card: m.id ? 'Edit card' : 'New card', upload: 'Upload material', review: 'Review extracted items' }
  const BODIES = { card: cardEditorHTML, upload: jobsUploadHTML, review: (mm) => jobsReviewHTML(mm, cardReviewItemHTML) }
  o.innerHTML = `<div class="cal-panel st-panel">
    <div class="cal-panel__head">
      <h2 class="cal-panel__title">${TITLES[m.type]}</h2>
      <button type="button" class="mail-iconbtn" data-st="m-close" aria-label="Close">✕</button>
    </div>
    ${BODIES[m.type](m)}
    ${m.error ? `<p class="nt-error">${esc(m.error)}</p>` : ''}
  </div>`
  fitEquations(o) // the overlay lives outside pageRoot, so render()'s pass misses it
}

function cardEditorHTML(m) {
  const d = m.draft
  return `
    <label class="st-flabel">Front (math inline as $…$)
      <textarea class="pw-field pw-field--text" data-stf="front" rows="3">${esc(d.front)}</textarea>
    </label>
    <label class="st-flabel">Back
      <textarea class="pw-field pw-field--text" data-stf="back" rows="3">${esc(d.back)}</textarea>
    </label>
    <div class="nt-acts"><button type="button" class="gym-btn" data-st="m-savec">Save card</button></div>`
}

// Review-item preview for an extracted card. (The question-preview analogue
// lives in studyui.js — small enough that sharing it wasn't worth it.)
function cardReviewItemHTML(c) {
  return `<div class="st-rev__body"><div class="st-crow__front">${stMD(c.front)}</div><div class="st-crow__back">${stMD(c.back)}</div></div>`
}

function onModalInput(e) {
  const m = ui.modal
  if (!m) return
  if (e.target.dataset.stRev != null) {
    const i = Number(e.target.dataset.stRev)
    e.target.checked ? m.chosen.add(i) : m.chosen.delete(i)
    const btn = document.querySelector('[data-st="m-import"]')
    if (btn) btn.textContent = `Import ${m.chosen.size} selected`
    return
  }
  const f = e.target.dataset.stf
  if (!f) return
  if (m.type === 'upload' && f === 'uptext') m.text = e.target.value
  else if (m.type === 'card') m.draft[f] = e.target.value
}

function onModalClick(e) {
  const el = e.target.closest('[data-st]')
  const m = ui.modal
  if (!el || !m) return
  const act = el.dataset.st
  if (act === 'm-close') closeModal()
  else if (act === 'up-files') document.getElementById('fc-file-input')?.click()
  else if (act === 'up-remove') { m.files.splice(Number(el.dataset.i), 1); renderModal() }
  else if (act === 'up-bundle') m.bundle = el.checked
  else if (act === 'up-extract') enqueueExtract()
  else if (act === 'm-import') importChosen()
  else if (act === 'm-savec') saveCard()
}

function saveCard() {
  const m = ui.modal
  if (!String(m.draft.front).trim() || !String(m.draft.back).trim()) { m.error = 'A card needs both a front and a back.'; return renderModal() }
  const s = loadFlashcards()
  const tab = curTab(s)
  if (!tab) return closeModal()
  if (m.id) {
    const c = tab.cards.find((x) => x.id === m.id)
    if (c) { c.front = String(m.draft.front); c.back = String(m.draft.back) }
  } else tab.cards.push(normCard(m.draft))
  saveFlashcards(s)
  closeModal()
}

// ---- events -----------------------------------------------------------------

async function onClick(e) {
  const el = e.target.closest('[data-st]')
  if (!el) return
  const act = el.dataset.st

  // Checked first: tab-del's span nests inside the tab-select button, so a
  // tap on the × must never also fall through to the tab-select branch.
  if (act === 'tab-del') {
    e.stopPropagation()
    const s0 = loadFlashcards()
    const t = s0.tabs.find((x) => x.id === el.dataset.id)
    if (!t) return
    if (!(await confirmDelete(`Delete “${t.name}” with its cards?`))) return
    const s = loadFlashcards()
    s.tabs = s.tabs.filter((x) => x.id !== t.id)
    s.active = s.tabs[0]?.id || ''
    ui.fc = null
    // the dead course's jobs go too — their results have nowhere to import
    for (const j of jobs.filter((x) => x.tabId === t.id)) removeJob(j.id).catch(() => {})
    saveFlashcards(s)
    refreshJobs()
    return render()
  }

  const s = loadFlashcards()
  const tab = curTab(s)

  if (act === 'tab-add') {
    const t = newTab('New course')
    s.tabs.push(t)
    s.active = t.id
    ui.rename = t.name
    ui.fc = null
    saveFlashcards(s)
    return render()
  }
  if (act === 'tab') {
    if (el.dataset.id !== s.active) {
      s.active = el.dataset.id
      ui.fc = null
      ui.rename = null
      saveFlashcards(s)
      render()
    }
    return
  }
  if (act === 'tool') { ui.tool = el.dataset.tool; return render() }
  if (!tab) return

  if (act === 'c-add') return openModal({ type: 'card', id: null, draft: { front: '', back: '' } })
  if (act === 'c-edit') {
    const c = tab.cards.find((x) => x.id === el.dataset.id)
    if (c) openModal({ type: 'card', id: c.id, draft: { front: c.front, back: c.back } })
    return
  }
  if (act === 'c-del') {
    if (!confirm('Remove this card?')) return
    tab.cards = tab.cards.filter((x) => x.id !== el.dataset.id)
    saveFlashcards(s)
    return render()
  }

  if (act === 'up-open') return openModal({ type: 'upload', target: el.dataset.target, files: [], text: '', bundle: false, error: '' })
  if (act === 'job-review') {
    getJob(Number(el.dataset.id)).then((j) => {
      if (j?.phase === 'ready') openModal({ type: 'review', target: j.target, tabId: j.tabId, jobId: j.id, items: j.results || [], chosen: new Set((j.results || []).map((_, i) => i)) })
    }).catch(() => {})
    return
  }
  if (act === 'jobs-import-all') { importAllReady(); return }
  if (act === 'job-retry') { retryJob(Number(el.dataset.id)).catch(() => {}).then(refreshJobs); return }
  if (act === 'job-remove') { removeJob(Number(el.dataset.id)).catch(() => {}).then(refreshJobs); return }

  if (act === 'fc-start') return startSession(false)
  if (act === 'fc-practice') return startSession(true)
  if (act === 'fc-flip') { if (ui.fc) { ui.fc.flipped = !ui.fc.flipped; render() } return }
  if (act === 'fc-miss') return gradeFc(false)
  if (act === 'fc-got') return gradeFc(true)
  if (act === 'fc-end') { ui.fc = null; return render() }
}

function onInput(e) {
  if (e.target.dataset?.stf === 'rename') ui.rename = e.target.value
}

function onChange(e) {
  if (e.target.dataset?.stf === 'rename') commitRename(e.target.value) // blur commits
}

function onDblClick(e) {
  const el = e.target.closest('[data-st="tab"]')
  if (!el) return
  const s = loadFlashcards()
  if (el.dataset.id !== s.active) return
  ui.rename = curTab(s)?.name ?? ''
  render()
}

function commitRename(value) {
  if (ui.rename == null) return
  const s = loadFlashcards()
  const tab = curTab(s)
  if (tab) tab.name = String(value).trim() || 'Course'
  ui.rename = null
  saveFlashcards(s)
  // Patch just the editing chip. A full re-render here would rebuild the page
  // during the mousedown that blurred this input, so the button the user was
  // pressing would be gone by mouseup and their click would never land.
  const chip = pageRoot?.querySelector('.st-tab--edit')
  if (chip && tab) chip.outerHTML = tabBtnHTML(tab, true)
  else render()
}

document.addEventListener('keydown', (e) => {
  if (!onFlashcardsPage()) return
  if (ui.modal) { if (e.key === 'Escape') closeModal(); return }
  const t = e.target
  if (t.closest?.('input,textarea,select')) {
    if (e.key === 'Enter' && t.id === 'fc-rename') { e.preventDefault(); commitRename(t.value) }
    else if (e.key === 'Escape' && t.id === 'fc-rename') { ui.rename = null; render() }
    return
  }
  if (ui.tool === 'cards' && ui.fc && ui.fc.i < ui.fc.ids.length) {
    // not when a button has focus — there Space must press the button, and
    // hijacking it would un-flip the card and delete the grade buttons instead
    if (e.code === 'Space' && !t.closest?.('button')) { e.preventDefault(); ui.fc.flipped = !ui.fc.flipped; render() }
    else if (e.key === '1' && ui.fc.flipped) gradeFc(false)
    else if (e.key === '2' && ui.fc.flipped) gradeFc(true)
  }
})

bindFileInput('fc-file-input', (list) => {
  if (ui.modal?.type !== 'upload') return
  jobsAddFiles(ui.modal, list, renderModal)
})
