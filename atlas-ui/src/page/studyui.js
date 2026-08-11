// Study plugin UI — a full-window page (registry: full:true). Course tabs
// across the top; per tab four tools: Study (tutor chat quizzing from the
// question bank, answers graded by the compute engine with a Claude-judge
// fallback), Question Bank (view/add/edit/upload-extract), Flashcards
// (spaced repetition, 1-3-7-14-21-day ladder), Card Bank. All Claude work
// runs through the dev server's /study-api (see vite.config.js).

import {
  loadStudy, saveStudy, newTab, normQuestion, normCard, fixEscapes, fixSlashes,
  localToday, dueCards, gradeCard, recordCat, catPct,
  checkPart, partRule, extractStudy, chatTurn, judgeItems,
  listJobs, getJob, retryJob, removeJob,
} from './study.js'
import { sanitizeHTML } from './canvasui.js'
import { marked } from 'marked'
import { convertLatexToMarkup } from 'mathlive' // mathlive CSS is loaded globally by view.js
import { renderMath, fitEquations, tuneMathFields } from './view.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// No file-type restriction — anything can be uploaded, and the dev server
// converts what Claude can't read natively (HEIC photos, Word docs). The only
// caps left are transport ones: the JSON body has to stay under /study-api's
// 50MB backstop, and Claude Code resizes oversized images itself.
const MAX_FILE = 25e6, MAX_TOTAL = 45e6

// Session-only state — survives re-renders and page switches, not reloads.
const ui = {
  tool: 'study',   // study | bank | cards | cardbank
  chatDraft: '',
  rename: null,    // non-null while the active tab name is being edited
  busy: null,      // { tabId, text } — one Claude turn at a time, app-wide
  fc: null,        // flashcard session { ids, i, missed:Set, flipped, practice }
  modal: null,     // { type: 'question'|'card'|'upload'|'review', … }
  focusChat: false,
}
let pageRoot = null

// Extraction queue — a MIRROR of the dev server's job store, where the work
// actually runs (one Claude agent per uploaded file, 4 at a time). Because
// the server owns the jobs, a page reload rebuilds every loading bar and the
// extractions keep running through it; the ticker animates the bars locally
// and re-polls the server every few beats.
let jobs = []      // [{ id, target, tabId, tabName, label, phase, error, startedAt, count }]
let qTimer = null  // bar ticker + poll driver, runs only while jobs exist
let qBeat = 0

// ---- markdown + math rendering (same $…$ pipeline as the Notes viewer) ------

const fixDots = (latex) => latex.replace(/\\dotsb\b/g, '\\cdots').replace(/\\dots[cmio]?\b/g, '\\ldots')

const inlineMath = (latex) => {
  try { return `<span class="nt-math">${convertLatexToMarkup(fixDots(fixSlashes(latex)).trim(), { defaultMode: 'textstyle' })}</span>` }
  catch { return esc(latex) }
}
const mathMarkup = (latex, block) => (block ? renderMath(fixDots(latex)) : inlineMath(latex))

// Inline math requires non-space immediately inside both delimiters (Pandoc's
// rule). Without it, "$12 for the first unit and $30" reads as one math span
// and both dollar amounts vanish — and this is a prose channel where the tutor
// writes word problems, not the math-first Notes viewer this came from.
const INLINE_MATH = /\$(?![\s$])([^\n$]*[^\s$])\$/g

function stMD(text) {
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

// ---- helpers ----------------------------------------------------------------

const curTab = (s) => s.tabs.find((t) => t.id === s.active) || s.tabs[0] || null

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function pushSys(tabId, text) {
  const s = loadStudy()
  const tab = s.tabs.find((t) => t.id === tabId)
  if (!tab) return
  tab.chat.push({ role: 'sys', text })
  saveStudy(s)
}

const onStudyPage = () => location.hash.replace(/^#\/?/, '').split('/')[0] === 'study'

// ---- page entry -------------------------------------------------------------

export function renderStudyPage(root) {
  pageRoot = root
  root.onclick = onClick
  root.oninput = onInput
  root.onchange = onChange
  root.ondblclick = onDblClick
  render()
  refreshJobs() // rebuild the queue strip from the server — bars survive reload
}

// Focus and caret survive a re-render. Background completions (a tutor turn
// landing, an extraction finishing) re-render the whole page; without this the
// caret is thrown out of whatever the user is typing — and the rename chip
// would get select()ed, so the next keystroke wiped the name.
function captureFocus() {
  const el = document.activeElement
  if (!el || !pageRoot?.contains(el)) return null
  const sel = el.id ? `#${el.id}` : el.classList?.contains('st-answer') ? `.st-answer[data-part="${el.dataset.part}"]` : ''
  if (!sel) return null
  const f = { sel }
  try { f.start = el.selectionStart; f.end = el.selectionEnd } catch { /* math-field: no text-selection API */ }
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
  if (!pageRoot?.isConnected || !onStudyPage()) return
  // Study + Flashcards fit the viewport (chat/card scroll internally); the
  // bank lists keep normal page scrolling. Scoped to data-page="study" in the
  // CSS, so a lingering class can never affect other pages.
  document.documentElement.classList.toggle('st-fit', ui.tool === 'study' || ui.tool === 'cards')
  const keep = captureFocus()
  const s = loadStudy()
  if (!s.tabs.length) {
    pageRoot.innerHTML = `<div class="st"><div class="gf-empty">
      <p class="gym-empty">Make a tab per course — each gets a tutor chat quizzing you from its question bank, and flashcards on a spaced-repetition schedule.</p>
      <button type="button" class="gym-btn" data-st="tab-add">+ Add your first course</button>
    </div></div>`
    return
  }
  const tab = curTab(s)
  const views = { study: studyView, bank: bankView, cards: cardsView, cardbank: cardBankView }
  pageRoot.innerHTML = `<div class="st">
    ${tabsBar(s)}
    ${toolsBar(tab)}
    <div class="nt-queue" id="st-queue">${queueHTML()}</div>
    <div class="st-view">${(views[ui.tool] || studyView)(tab, s)}</div>
  </div>`
  syncNavDot()
  tuneMathFields(pageRoot)
  fitEquations(pageRoot)
  const msgs = pageRoot.querySelector('#st-msgs')
  if (msgs) msgs.scrollTop = msgs.scrollHeight
  // Consume the one-shot only once the input is actually focusable — while
  // busy it renders disabled, and focus() on a disabled control does nothing.
  const wantChat = ui.focusChat && !ui.busy
  if (wantChat) ui.focusChat = false
  if (restoreFocus(keep)) return // mid-edit: keep the caret exactly where it was
  if (ui.rename != null) {
    const el = pageRoot.querySelector('#st-rename')
    if (el) { el.focus(); el.select() } // first render of a fresh rename: select all
  } else if (wantChat) pageRoot.querySelector('#st-chat-in')?.focus()
}

// ---- chrome: course tabs + tool pills ---------------------------------------

const tabBtnHTML = (t, active) =>
  `<button type="button" class="st-tab${active ? ' is-active' : ''}" data-st="tab" data-id="${esc(t.id)}"${active ? ' title="Double-click to rename"' : ''}>${esc(t.name)}${active ? `<span class="st-tab__x" data-st="tab-del" data-id="${esc(t.id)}" aria-label="Delete course">×</span>` : ''}</button>`

function tabsBar(s) {
  return `<div class="st-tabs">
    ${s.tabs.map((t) => {
      const active = t.id === s.active
      return active && ui.rename != null
        ? `<span class="st-tab is-active st-tab--edit"><input id="st-rename" class="st-tab__in" value="${esc(ui.rename)}" data-stf="rename" spellcheck="false"></span>`
        : tabBtnHTML(t, active)
    }).join('')}
    <button type="button" class="st-tab st-tab--add" data-st="tab-add" aria-label="Add course">+</button>
  </div>`
}

function toolsBar(tab) {
  const due = dueCards(tab).length
  const T = [
    ['study', 'Study'],
    ['bank', `Question bank (${tab.questions.length})`],
    ['cards', due ? `Flashcards (${due} due)` : 'Flashcards'],
    ['cardbank', `Card bank (${tab.cards.length})`],
  ]
  return `<div class="st-tools">${T.map(([k, l]) =>
    `<button type="button" class="wk-pill${ui.tool === k ? ' is-on' : ''}" data-st="tool" data-tool="${k}">${esc(l)}</button>`).join('')}</div>`
}

// ---- Study (tutor chat) -----------------------------------------------------

const MSG_CLS = { tutor: 'st-msg--tutor', you: 'st-msg--you', result: 'st-msg--result', sys: 'st-msg--sys' }

// One Claude turn runs app-wide at a time, so every tab's compose bar is
// disabled while one is in flight — but only the owning tab claims the
// spinner; the others say whose turn it is instead of implying it's theirs.
function busyLine(s, tab) {
  if (!ui.busy) return ''
  if (ui.busy.tabId === tab.id) return ui.busy.text
  const owner = s.tabs.find((t) => t.id === ui.busy.tabId)
  return owner ? `Busy with ${owner.name}…` : ''
}

function studyView(tab, s) {
  const msgs = tab.chat.map((m) => `<div class="st-msg ${MSG_CLS[m.role] || 'st-msg--sys'}">${stMD(m.text)}</div>`).join('')
  const intro = !tab.chat.length && !tab.activeQ
    ? `<div class="st-msg st-msg--sys">Your tutor quizzes you from this course's question bank (${tab.questions.length} question${tab.questions.length === 1 ? '' : 's'}) — weakest categories first — and grades your answers. Hit <b>Quiz me</b> to start, or just ask something.</div>`
    : ''
  const line = busyLine(s, tab)
  const off = ui.busy ? 'disabled' : ''
  return `<div class="card st-chat">
    <div class="st-msgs" id="st-msgs">
      ${intro}${msgs}
      ${tab.activeQ ? qCardHTML(tab.activeQ, ui.busy?.tabId === tab.id) : ''}
      ${line ? `<div class="st-msg st-msg--sys st-busy">${esc(line)}</div>` : ''}
    </div>
    <div class="st-compose">
      <input id="st-chat-in" class="pw-field" placeholder="Ask your tutor… (Enter to send)" value="${esc(ui.chatDraft)}" ${off}>
      <button type="button" class="gym-btn" data-st="chat-send" ${off}>Send</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-st="chat-quiz" ${off}>Quiz me</button>
      ${tab.chat.length ? `<button type="button" class="gym-btn gym-btn--ghost" data-st="chat-clear" ${off}>Clear</button>` : ''}
    </div>
  </div>`
}

const figsHTML = (q) => (q.figures?.length ? `<div class="st-qfigs">${q.figures.map((f) => `<img class="st-qfig" src="${esc(f)}" alt="figure">`).join('')}</div>` : '')

// A choice part renders its options as a radio group; options can be text,
// a figure image (the pick-the-correct-graph case), or both.
function choiceHTML(p, i, given, frozen) {
  return `<div class="st-choices" data-part="${i}">${p.options.map((o, oi) => `
    <label class="st-choice${String(given) === String(oi) ? ' is-picked' : ''}">
      <input type="radio" name="st-ch-${i}" value="${oi}" ${String(given) === String(oi) ? 'checked' : ''} ${frozen ? 'disabled' : ''}>
      ${o.figure ? `<img class="st-choice__img" src="${esc(o.figure)}" alt="option ${oi + 1}">` : ''}
      ${o.text ? `<span class="st-choice__txt">${stMD(o.text)}</span>` : o.figure ? '' : `<span class="st-choice__txt">option ${oi + 1}</span>`}
    </label>`).join('')}</div>`
}

// `frozen` = this tab's answer is being graded right now. The fields lock so a
// mid-grading edit can't be silently thrown away when the question clears.
function qCardHTML(q, frozen) {
  return `<div class="st-qcard card">
    <div class="st-qhead">
      <span class="st-cat">${esc(q.category)}</span>
      ${q.bankId ? '' : '<span class="st-gen">generated</span>'}
    </div>
    <div class="st-qintro">${stMD(q.intro)}</div>
    ${figsHTML(q)}
    ${q.parts.map((p, i) => `<div class="st-part">
      ${p.prompt ? `<div class="st-part__prompt">${stMD(p.prompt)}</div>` : ''}
      ${p.kind === 'choice' ? choiceHTML(p, i, q.given?.[i], frozen)
        : p.kind === 'math'
        ? `<math-field class="pw-mathfield st-answer" data-part="${i}" math-virtual-keyboard-policy="manual" ${frozen ? 'read-only' : ''}>${esc(q.given?.[i] ?? '')}</math-field>`
        : `<input class="pw-field st-answer" data-part="${i}" value="${esc(q.given?.[i] ?? '')}" placeholder="Your answer" ${frozen ? 'disabled' : ''}>`}
      ${q.verdicts ? `<div class="st-vchip ${q.verdicts[i] === 'correct' ? 'st-vchip--ok' : 'st-vchip--no'}">${q.verdicts[i] === 'correct' ? '✔ correct' : `✘ not yet${q.vnotes?.[i] ? ` — ${esc(q.vnotes[i])}` : ''}`}</div>` : ''}
      ${p.check === 'form' && p.form ? `<div class="st-part__hint">write ${esc(p.form)}</div>`
        : p.check === 'numeric' ? `<div class="st-part__hint">decimal/rounded answer · within ±${esc(String(p.tolerancePct))}%</div>`
        : p.kind === 'math' ? '<div class="st-part__hint">exact value — any equivalent form</div>' : ''}
    </div>`).join('')}
    <div class="st-qacts">
      <button type="button" class="gym-btn" data-st="q-check" ${ui.busy ? 'disabled' : ''}>${q.verdicts ? 'Check again' : 'Check'}</button>
      ${q.bankId ? '' : `<button type="button" class="gym-btn gym-btn--ghost" data-st="q-keep">Save to bank</button>`}
    </div>
  </div>`
}

async function doSend(text) {
  const t = String(text ?? ui.chatDraft).trim()
  if (!t || ui.busy) return
  const s = loadStudy()
  const tab = curTab(s)
  if (!tab) return
  tab.chat.push({ role: 'you', text: t })
  saveStudy(s)
  ui.chatDraft = ''
  ui.focusChat = true
  await tutorTurn(tab.id)
}

async function tutorTurn(tabId) {
  ui.busy = { tabId, text: 'Tutor is thinking…' }
  render()
  let s = loadStudy()
  let tab = s.tabs.find((t) => t.id === tabId)
  if (!tab) { ui.busy = null; return render() }
  try {
    const r = await chatTurn({
      tab: tab.name,
      bank: tab.questions,
      stats: tab.catStats,
      transcript: tab.chat.slice(-24),
      activeQ: tab.activeQ ? { category: tab.activeQ.category, intro: tab.activeQ.intro, parts: tab.activeQ.parts } : null,
    })
    s = loadStudy() // re-read: the store may have moved while we waited
    tab = s.tabs.find((t) => t.id === tabId)
    if (tab) {
      if (r.message) tab.chat.push({ role: 'tutor', text: String(r.message) })
      if (r.question && typeof r.question === 'object') {
        const bq = r.question.bankId ? tab.questions.find((q) => q.id === r.question.bankId) : null
        const nq = normQuestion(bq || r.question)
        tab.activeQ = { ...nq, bankId: bq ? bq.id : null, given: [] }
      }
      saveStudy(s)
    }
  } catch (err) {
    pushSys(tabId, `Tutor error: ${err.message}`)
  }
  ui.busy = null
  ui.focusChat = true // re-arm: the busy render couldn't focus a disabled input
  render()
}

const vMark = (v) => (v === 'correct' ? '✔ correct' : '✘ incorrect')

function resultText(q, verdicts, notes, ok, attempt = 1) {
  const lines = q.parts.map((p, i) => {
    const got = q.given?.[i]?.trim()
    const shown = !got ? '*(blank)*'
      : p.kind === 'choice' ? `“${q.parts[i].options[Number(got)]?.text || `option ${Number(got) + 1}`}”`
      : p.kind === 'math' ? `$${got}$` : `“${got}”`
    return `${p.prompt ? p.prompt + ' — ' : ''}${shown} — ${vMark(verdicts[i])}${notes[i] ? ` (${notes[i]})` : ''}`
  })
  return `Answered **${q.category}**${attempt > 1 ? ` (attempt ${attempt})` : ''}: ${q.intro}  \n${lines.join('  \n')}  \n**${ok ? 'All correct.' : 'Not quite.'}**`
}

async function checkAnswers() {
  if (ui.busy) return
  const s = loadStudy()
  const tab = curTab(s)
  const q = tab?.activeQ
  if (!q) return
  for (const el of pageRoot.querySelectorAll('.st-answer')) q.given[Number(el.dataset.part)] = el.value ?? ''
  for (const el of pageRoot.querySelectorAll('.st-choices')) {
    const picked = el.querySelector('input:checked')
    if (picked) q.given[Number(el.dataset.part)] = picked.value
  }
  saveStudy(s)
  ui.busy = { tabId: tab.id, text: 'Grading…' }
  render()
  // Everything below grades the `q` snapshot taken above — never a re-read of
  // the store — so the transcript can't report answers that weren't graded.
  const notes = q.parts.map(() => '')
  let verdicts
  try {
    verdicts = []
    for (const [i, p] of q.parts.entries()) verdicts.push(await checkPart(p, q.given[i] ?? ''))
    const unsure = verdicts.flatMap((v, i) => (v === 'unsure' ? [i] : []))
    if (unsure.length) {
      const { verdicts: jv } = await judgeItems(unsure.map((i) => ({
        n: i,
        question: [q.intro, q.parts[i].prompt].filter(Boolean).join(' — '),
        expected: q.parts[i].answer,
        given: q.given[i] ?? '',
        rule: partRule(q.parts[i]),
      })))
      for (const v of jv || []) {
        const i = Math.trunc(v.n)
        if (verdicts[i] === 'unsure') { verdicts[i] = v.correct ? 'correct' : 'incorrect'; notes[i] = String(v.note || '') }
      }
    }
  } catch (err) {
    // grader unreachable — keep the question (and typed answers) intact
    ui.busy = null
    pushSys(tab.id, `Couldn't finish grading (${err.message}) — try Check again.`)
    return render()
  }
  for (let i = 0; i < verdicts.length; i++) if (verdicts[i] === 'unsure') { verdicts[i] = 'incorrect'; notes[i] ||= 'could not verify' }
  const ok = verdicts.every((v) => v === 'correct')
  const s2 = loadStudy()
  const t2 = s2.tabs.find((t) => t.id === tab.id)
  if (!t2?.activeQ) { ui.busy = null; return render() }
  const q2 = t2.activeQ
  if (!(q2.attempts > 0)) recordCat(t2, q2.category, ok) // category accuracy scores the FIRST try; coached retries don't re-count
  q2.attempts = (q2.attempts || 0) + 1
  t2.chat.push({ role: 'result', text: resultText(q, verdicts, notes, ok, q2.attempts) })
  if (ok) t2.activeQ = null
  else { // missed — the question stays open and the tutor coaches, never reveals
    q2.given = q.given
    q2.verdicts = verdicts
    q2.vnotes = notes
  }
  saveStudy(s2)
  ui.busy = null
  render()
  tutorTurn(tab.id) // feedback: a targeted hint on a miss, the next question on a pass
}

function keepGenerated() {
  const s = loadStudy()
  const tab = curTab(s)
  if (!tab?.activeQ || tab.activeQ.bankId) return
  const { category, intro, parts } = tab.activeQ
  const q = normQuestion({ category, intro, parts })
  tab.questions.push(q)
  tab.activeQ.bankId = q.id // now it IS a bank question — hide the save button
  tab.chat.push({ role: 'sys', text: 'Saved to the question bank.' })
  saveStudy(s)
  render()
}

// ---- Question bank ----------------------------------------------------------

const ruleBadge = (p) =>
  p.kind === 'choice' ? `choice of ${p.options.length}`
  : p.kind === 'text' ? 'text' : p.check === 'numeric' ? `decimal ±${p.tolerancePct}%` : p.check === 'form' ? `form: ${p.form || '?'}` : 'exact value'

// Answer cell for a part in bank/review lists — for choice parts, the correct
// option (its text, or its image as a thumbnail).
const partAnswerHTML = (p) => {
  if (p.kind === 'choice') {
    const o = p.options[Number(p.answer)] || {}
    return `${o.figure ? `<img class="st-ans__fig" src="${esc(o.figure)}" alt="correct option">` : ''}${esc(o.text || (o.figure ? '' : `option ${Number(p.answer) + 1}`))}`
  }
  return p.kind === 'math' ? inlineMath(p.answer) : esc(p.answer)
}

function bankView(tab) {
  const byCat = new Map()
  for (const q of tab.questions) {
    if (!byCat.has(q.category)) byCat.set(q.category, [])
    byCat.get(q.category).push(q)
  }
  const cats = [...byCat.entries()].sort(([a], [b]) => a.localeCompare(b))
  return `
    <div class="gf-bar">
      <button type="button" class="gym-btn" data-st="q-add">+ Add question</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-st="up-open" data-target="questions">Upload material…</button>
      <span class="gf-status">${tab.questions.length ? `${tab.questions.length} question${tab.questions.length === 1 ? '' : 's'} · accuracy per category` : ''}</span>
    </div>
    ${cats.length ? cats.map(([cat, qs]) => catSection(cat, qs, tab.catStats[cat])).join('')
      : '<p class="gym-empty">No questions yet — upload homework or notes and Claude mines them for practice problems (answers included), or add one by hand. The Study chat quizzes you from this bank.</p>'}`
}

function catSection(cat, qs, stat) {
  const pct = catPct(stat)
  return `<section class="card st-catsec">
    <div class="st-cathead">
      <h3 class="st-cathead__name">${esc(cat)}</h3>
      ${pct != null ? `<span class="st-acc${pct < 60 ? ' is-low' : ''}">${pct}% · ${stat.correct}/${stat.attempts}</span>` : '<span class="st-acc st-acc--none">untested</span>'}
      <span class="st-count">${qs.length}</span>
    </div>
    ${qs.map((q) => `<div class="st-qrow">
      <div class="st-qrow__body">
        <div class="st-qintro">${stMD(q.intro)}</div>
        ${figsHTML(q)}
        ${q.parts.map((p) => `<div class="st-ans">
          ${p.prompt ? `<span class="st-ans__p">${stMD(p.prompt)}</span>` : ''}
          <span class="st-ans__a">${partAnswerHTML(p)}</span>
          <span class="st-ans__rule">${esc(ruleBadge(p))}</span>
        </div>`).join('')}
      </div>
      <div class="st-qrow__acts">
        <button type="button" class="st-iconbtn" data-st="q-edit" data-id="${esc(q.id)}" aria-label="Edit">✎</button>
        <button type="button" class="nt-chip__x" data-st="q-del" data-id="${esc(q.id)}" aria-label="Remove">×</button>
      </div>
    </div>`).join('')}
  </section>`
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
  const card = curTab(loadStudy())?.cards.find((c) => c.id === f.ids[f.i])
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
  const s = loadStudy()
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
  const s = loadStudy()
  const tab = curTab(s)
  const id = f.ids[f.i]
  const card = tab?.cards.find((c) => c.id === id)
  if (card && !f.practice) {
    // a same-session recovery after a miss keeps the demotion the miss wrote
    if (!got) gradeCard(card, false)
    else if (!f.missed.has(id)) gradeCard(card, true)
    saveStudy(s)
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

// No real progress signal exists (one claude spawn, returns at the end), so
// each bar is a time estimate: asymptotic fill that hits ~63% at 30s and caps
// at 95% until its job actually finishes. (Same estimator as Notes.)
const qPct = (j) => Math.min(95, Math.round(100 * (1 - Math.exp(-(Date.now() - j.startedAt) / 30000))))

const Q_STATUS = { queued: 'Queued', converting: 'Extracting with Claude…', ready: 'Ready to review', error: 'Failed' }

function jobCardHTML(j) {
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
  </div>`
}

// Nav dot on Study stays lit until the queue is empty — a ready-to-review or
// failed job still needs attention, not just a running one. (The dot covers
// every course; the strip below is filtered to the course being viewed.)
function syncNavDot() {
  document.querySelector('.nav__item[href="#/study"]')?.classList.toggle('is-busy', jobs.length > 0)
}

// Only the active course's jobs — an upload to Calc II must not show its
// loading bars on the Physics II tab.
const tabJobs = () => {
  const active = curTab(loadStudy())?.id
  return jobs.filter((j) => j.tabId === active)
}

// Running/failed jobs show on every tool; FINISHED jobs wait on their bank
// tab only (per Chancellor — done cards were cluttering the chat view).
const stripJobs = () => tabJobs().filter((j) => j.phase !== 'ready'
  || (ui.tool === 'bank' && j.target === 'questions')
  || (ui.tool === 'cardbank' && j.target === 'cards'))

function queueHTML() {
  const js = stripJobs()
  const ready = js.filter((j) => j.phase === 'ready')
  const items = ready.reduce((a, j) => a + j.count, 0)
  const all = ready.length > 1
    ? `<div class="st-qall"><button type="button" class="gym-btn gym-btn--sm" data-st="jobs-import-all">Import all — ${ready.length} files, ${items} item${items === 1 ? '' : 's'}</button></div>` : ''
  return all + js.map(jobCardHTML).join('')
}

function renderQueue() {
  syncNavDot()
  const el = document.getElementById('st-queue')
  if (el) el.innerHTML = queueHTML()
}

// One click for a whole semester's worth of ready files — items land exactly
// as a per-job review import would (same normalizers), jobs leave the strip.
// The per-file Review gate stays available; this is the bulk bypass.
let bulkBusy = false
async function importAllReady() {
  if (bulkBusy) return
  bulkBusy = true
  try {
    const s = loadStudy()
    const tab = curTab(s)
    if (!tab) return
    const want = ui.tool === 'cardbank' ? 'cards' : 'questions'
    const failed = []
    for (const job of jobs.filter((j) => j.tabId === tab.id && j.phase === 'ready' && j.target === want)) {
      let full
      try { full = await getJob(job.id) } catch (err) { failed.push(`${job.label}: ${err.message}`); continue }
      if (full?.phase !== 'ready') continue
      const items = full.results || []
      if (want === 'cards') tab.cards.push(...items.map((c) => normCard({ front: c.front, back: c.back })))
      else tab.questions.push(...items.map((q) => normQuestion(q)))
      removeJob(job.id).catch(() => {})
    }
    saveStudy(s)
    for (const f of failed) pushSys(tab.id, `Import failed for ${f}`) // after save — pushSys writes the store itself
    await refreshJobs()
    render()
  } finally { bulkBusy = false }
}

async function refreshJobs() {
  let r
  try { r = await listJobs() } catch { return } // dev server unreachable — keep what we have
  const all = Array.isArray(r?.jobs) ? r.jobs : []
  // Jobs whose course isn't in THIS browser's store are ignored, never
  // deleted: the old "orphan GC" removeJob'd them server-side, and a second
  // profile (an e2e run, another login) with a different store wiped a real
  // queue that way. A truly orphaned job (course deleted here) just idles
  // until the dev server restarts; the nav dot ignores it too.
  const tabIds = new Set(loadStudy().tabs.map((t) => t.id))
  jobs = tabIds.size ? all.filter((j) => tabIds.has(j.tabId)) : all
  renderQueue()
  if (jobs.length && !qTimer) qTimer = setInterval(qTick, 600)
  if (!jobs.length && qTimer) { clearInterval(qTimer); qTimer = null }
}

function qTick() {
  syncNavDot() // renderNav wipes the class on route change; the tick reasserts it
  for (const j of jobs) {
    if (j.phase !== 'converting') continue
    const fill = document.querySelector(`[data-qid="${j.id}"] .nt-qfill`)
    if (fill) fill.style.width = qPct(j) + '%'
  }
  if (++qBeat % 4 === 0) refreshJobs() // server poll every ~2.4s while jobs exist
}

const totalSize = (files) => files.reduce((a, f) => a + f.size, 0)

function addFiles(list) {
  const m = ui.modal
  m.error = ''
  let pending = 0
  for (const file of list) {
    // plain text lands in the paste box so it stays visible and editable
    if (/\.(txt|md|csv)$/i.test(file.name) || file.type.startsWith('text/')) {
      pending++
      const r = new FileReader()
      r.onload = () => { m.text = (m.text ? m.text + '\n\n' : '') + r.result; if (!--pending) renderModal() }
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
      if (!--pending) renderModal()
    }
    r.readAsDataURL(file)
  }
  if (!pending) renderModal()
}

// Extract = enqueue on the SERVER: one job (one Claude agent, one loading
// bar) per file — or per upload when "bundle" is checked, so one agent reads
// the whole group; the modal closes immediately and the strip tracks them all.
async function enqueueExtract() {
  const m = ui.modal
  if (!m) return
  if (!m.files.length && !m.text.trim()) { m.error = 'Add files or paste some material first.'; return renderModal() }
  const s = loadStudy()
  const tab = curTab(s)
  const payload = {
    target: m.target, tabId: tab.id, tabName: tab.name,
    files: m.files.map(({ name, media_type, data }) => ({ name, media_type, data })),
    bundle: m.files.length > 1 && !!m.bundle,
    text: m.text,
    categories: [...new Set(tab.questions.map((q) => q.category))],
  }
  closeModal()
  try { await extractStudy(payload) } catch (err) { pushSys(tab.id, `Upload failed: ${err.message}`); render() }
  refreshJobs()
}

function importChosen() {
  const m = ui.modal
  const s = loadStudy()
  const tab = s.tabs.find((t) => t.id === m.tabId)
  if (tab) {
    const picked = m.items.filter((_, i) => m.chosen.has(i))
    if (m.target === 'cards') tab.cards.push(...picked.map((c) => normCard({ front: c.front, back: c.back })))
    else tab.questions.push(...picked.map((q) => normQuestion(q)))
    saveStudy(s)
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

// Dismissing a review list is safe: the job stays "Ready to review" on the
// queue strip (it only leaves the queue on import or an explicit ×).
function closeModal() {
  document.querySelector('.st-overlay')?.remove()
  ui.modal = null
  render()
}

window.addEventListener('hashchange', () => {
  if (!onStudyPage()) { document.querySelector('.st-overlay')?.remove(); ui.modal = null }
})

function renderModal() {
  const o = document.querySelector('.st-overlay')
  const m = ui.modal
  if (!o || !m) return
  const TITLES = { question: m.id ? 'Edit question' : 'New question', card: m.id ? 'Edit card' : 'New card', upload: 'Upload material', review: 'Review extracted items' }
  const BODIES = { question: qEditorHTML, card: cardEditorHTML, upload: uploadHTML, review: reviewHTML }
  o.innerHTML = `<div class="cal-panel st-panel">
    <div class="cal-panel__head">
      <h2 class="cal-panel__title">${TITLES[m.type]}</h2>
      <button type="button" class="mail-iconbtn" data-st="m-close" aria-label="Close">✕</button>
    </div>
    ${BODIES[m.type](m)}
    ${m.error ? `<p class="nt-error">${esc(m.error)}</p>` : ''}
  </div>`
  tuneMathFields(o)
  fitEquations(o) // the overlay lives outside pageRoot, so render()'s pass misses it
}

function qEditorHTML(m) {
  const d = m.draft
  return `
    <label class="st-flabel">Category
      <input class="pw-field" data-stf="category" value="${esc(d.category)}" placeholder="e.g. u-substitution">
    </label>
    <label class="st-flabel">Question (math inline as $…$)
      <textarea class="pw-field pw-field--text" data-stf="intro" rows="3">${esc(d.intro)}</textarea>
    </label>
    ${d.parts.map((p, i) => `<div class="st-pedit">
      <div class="st-pedit__head"><span>Part ${i + 1}</span>
        ${d.parts.length > 1 ? `<button type="button" class="nt-chip__x" data-st="m-delpart" data-i="${i}" aria-label="Remove part">×</button>` : ''}
      </div>
      ${d.parts.length > 1 || p.prompt ? `<input class="pw-field" placeholder="Sub-question, e.g. (a) …" data-stf="p-prompt" data-i="${i}" value="${esc(p.prompt)}">` : ''}
      <div class="st-pedit__row">
        <select class="pw-field pw-field--select" data-stf="p-kind" data-i="${i}">
          <option value="math"${p.kind === 'math' ? ' selected' : ''}>math answer</option>
          <option value="text"${p.kind === 'text' ? ' selected' : ''}>text answer</option>
        </select>
        ${p.kind === 'math' ? `<select class="pw-field pw-field--select" data-stf="p-check" data-i="${i}">
          <option value="equiv"${p.check === 'equiv' ? ' selected' : ''}>exact value (any equivalent form)</option>
          <option value="numeric"${p.check === 'numeric' ? ' selected' : ''}>decimal/rounded, ± tolerance %</option>
          <option value="form"${p.check === 'form' ? ' selected' : ''}>a specific form</option>
        </select>` : ''}
        ${p.kind === 'math' && p.check === 'numeric' ? `<input class="pw-field st-tol" type="number" min="0" step="0.5" data-stf="p-tol" data-i="${i}" value="${esc(String(p.tolerancePct))}" title="tolerance %">` : ''}
      </div>
      ${p.kind === 'math' && p.check === 'form' ? `<input class="pw-field" placeholder="Required form — e.g. as partial fractions" data-stf="p-form" data-i="${i}" value="${esc(p.form)}">` : ''}
      <div class="st-pedit__ans">
        ${p.kind === 'math'
          ? `<math-field class="pw-mathfield" data-stf="p-answer" data-i="${i}" math-virtual-keyboard-policy="manual">${esc(p.answer)}</math-field>`
          : `<input class="pw-field" placeholder="Correct answer" data-stf="p-answer" data-i="${i}" value="${esc(p.answer)}">`}
      </div>
    </div>`).join('')}
    <div class="nt-acts">
      <button type="button" class="gym-btn gym-btn--ghost" data-st="m-addpart">+ Add part</button>
      <button type="button" class="gym-btn" data-st="m-saveq">Save question</button>
    </div>`
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

function uploadHTML(m) {
  return `
    <p class="cal-panel__cal">${m.target === 'cards'
      ? 'Any files — photos, PDFs, Word docs, slides, notes — or pasted text. Claude turns definitions, formulas, and key facts into flashcards for this course.'
      : 'Old homework, worksheets, exams, notes — any file type or pasted text. Claude mines them for practice questions (answers included) for this course\'s bank.'}</p>
    <div class="nt-files">
      <button type="button" class="gym-btn" data-st="up-files">Add files…</button>
      <input type="file" id="st-file-input" multiple hidden>
      ${m.files.map((f, i) => `<span class="nt-chip">${esc(f.name)} <button type="button" class="nt-chip__x" data-st="up-remove" data-i="${i}" aria-label="Remove">×</button></span>`).join('')}
    </div>
    ${m.files.length > 1 ? `<label class="st-bundle"><input type="checkbox" data-st="up-bundle"${m.bundle ? ' checked' : ''}> One bundle — one agent per document; figure images named after a file (&quot;1.11 fig 2.png&quot;) attach to its questions, and an all-image bundle keeps a single agent</label>` : ''}
    <textarea class="pw-field nt-text" data-stf="uptext" rows="5" placeholder="…or paste material here">${esc(m.text)}</textarea>
    <div class="nt-acts"><button type="button" class="gym-btn" data-st="up-extract">Extract</button></div>
    <p class="cal-panel__cal">Extract queues the job — progress shows at the top of the Study page, and Atlas stays usable while Claude works.</p>`
}

function reviewHTML(m) {
  const item = m.target === 'cards'
    ? (c, i) => `<div class="st-rev__body"><div class="st-crow__front">${stMD(c.front)}</div><div class="st-crow__back">${stMD(c.back)}</div></div>`
    : (q, i) => {
        const nq = normQuestion(q)
        return `<div class="st-rev__body">
          <span class="st-cat">${esc(nq.category)}</span>
          <div class="st-qintro">${stMD(nq.intro)}</div>
          ${figsHTML(nq)}
          ${nq.parts.map((p) => `<div class="st-ans">${p.prompt ? `<span class="st-ans__p">${stMD(p.prompt)}</span>` : ''}<span class="st-ans__a">${partAnswerHTML(p)}</span><span class="st-ans__rule">${esc(ruleBadge(p))}</span></div>`).join('')}
        </div>`
      }
  return `
    <p class="cal-panel__cal">${m.items.length ? 'Uncheck anything you don\'t want, then import.' : 'Claude found nothing usable in that material.'}</p>
    <div class="st-revlist">
      ${m.items.map((it, i) => `<label class="st-rev">
        <input type="checkbox" data-st-rev="${i}" ${m.chosen.has(i) ? 'checked' : ''}>
        ${item(it, i)}
      </label>`).join('')}
    </div>
    <div class="nt-acts">
      ${m.items.length ? `<button type="button" class="gym-btn" data-st="m-import">Import ${m.chosen.size} selected</button>` : ''}
    </div>`
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
  const i = Number(e.target.dataset.i)
  if (m.type === 'upload' && f === 'uptext') m.text = e.target.value
  else if (m.type === 'card') m.draft[f] = e.target.value
  else if (m.type === 'question') {
    const p = m.draft.parts[i]
    if (f === 'category' || f === 'intro') m.draft[f] = e.target.value
    else if (f === 'p-prompt') p.prompt = e.target.value
    else if (f === 'p-answer') p.answer = e.target.value
    else if (f === 'p-tol') p.tolerancePct = e.target.value
    else if (f === 'p-kind' && p.kind !== e.target.value) { p.kind = e.target.value; p.check = p.kind === 'text' ? 'text' : 'equiv'; p.answer = ''; renderModal() }
    else if (f === 'p-check' && p.check !== e.target.value) { p.check = e.target.value; renderModal() }
  }
}

function onModalClick(e) {
  const el = e.target.closest('[data-st]')
  const m = ui.modal
  if (!el || !m) return
  const act = el.dataset.st
  if (act === 'm-close') closeModal()
  else if (act === 'up-files') document.getElementById('st-file-input')?.click()
  else if (act === 'up-remove') { m.files.splice(Number(el.dataset.i), 1); renderModal() }
  else if (act === 'up-bundle') m.bundle = el.checked
  else if (act === 'up-extract') enqueueExtract()
  else if (act === 'm-import') importChosen()
  else if (act === 'm-addpart') { m.draft.parts.push({ prompt: '', kind: 'math', answer: '', check: 'equiv', tolerancePct: 1, form: '' }); renderModal() }
  else if (act === 'm-delpart') { m.draft.parts.splice(Number(el.dataset.i), 1); renderModal() }
  else if (act === 'm-saveq') saveQuestion()
  else if (act === 'm-savec') saveCard()
}

function saveQuestion() {
  const m = ui.modal
  const d = m.draft
  if (!String(d.intro).trim()) { m.error = 'Write the question.'; return renderModal() }
  if (d.parts.some((p) => !String(p.answer).trim())) { m.error = 'Every part needs its correct answer.'; return renderModal() }
  const s = loadStudy()
  const tab = curTab(s)
  if (!tab) return closeModal()
  const q = normQuestion({ ...d, id: m.id || undefined })
  const i = m.id ? tab.questions.findIndex((x) => x.id === m.id) : -1
  if (i >= 0) tab.questions[i] = q
  else tab.questions.push(q)
  saveStudy(s)
  closeModal()
}

function saveCard() {
  const m = ui.modal
  if (!String(m.draft.front).trim() || !String(m.draft.back).trim()) { m.error = 'A card needs both a front and a back.'; return renderModal() }
  const s = loadStudy()
  const tab = curTab(s)
  if (!tab) return closeModal()
  if (m.id) {
    const c = tab.cards.find((x) => x.id === m.id)
    if (c) { c.front = String(m.draft.front); c.back = String(m.draft.back) }
  } else tab.cards.push(normCard(m.draft))
  saveStudy(s)
  closeModal()
}

// ---- events -----------------------------------------------------------------

function onClick(e) {
  const el = e.target.closest('[data-st]')
  if (!el) return
  const act = el.dataset.st
  const s = loadStudy()
  const tab = curTab(s)

  if (act === 'tab-add') {
    const t = newTab('New course')
    s.tabs.push(t)
    s.active = t.id
    ui.rename = t.name
    ui.fc = null
    saveStudy(s)
    return render()
  }
  if (act === 'tab') {
    if (el.dataset.id !== s.active) {
      s.active = el.dataset.id
      ui.fc = null
      ui.rename = null
      ui.chatDraft = ''
      saveStudy(s)
      render()
    }
    return
  }
  if (act === 'tab-del') {
    e.stopPropagation()
    const t = s.tabs.find((x) => x.id === el.dataset.id)
    if (!t || !confirm(`Delete “${t.name}” with its questions, cards, and chat?`)) return
    s.tabs = s.tabs.filter((x) => x.id !== t.id)
    s.active = s.tabs[0]?.id || ''
    ui.fc = null
    // the dead course's jobs go too — their results have nowhere to import
    for (const j of jobs.filter((x) => x.tabId === t.id)) removeJob(j.id).catch(() => {})
    saveStudy(s)
    refreshJobs()
    return render()
  }
  if (act === 'tool') { ui.tool = el.dataset.tool; return render() }
  if (!tab) return

  if (act === 'chat-send') return void doSend()
  if (act === 'chat-quiz') return void doSend('Quiz me.')
  if (act === 'chat-clear') {
    tab.chat = []
    tab.activeQ = null
    saveStudy(s)
    return render()
  }
  if (act === 'q-check') return void checkAnswers()
  if (act === 'q-keep') return keepGenerated()

  if (act === 'q-add') return openModal({ type: 'question', id: null, draft: normQuestion({ category: '', intro: '', parts: [{}] }) })
  if (act === 'q-edit') {
    const q = tab.questions.find((x) => x.id === el.dataset.id)
    if (q) openModal({ type: 'question', id: q.id, draft: normQuestion(structuredClone(q)) })
    return
  }
  if (act === 'q-del') {
    if (!confirm('Remove this question?')) return
    tab.questions = tab.questions.filter((x) => x.id !== el.dataset.id)
    saveStudy(s)
    return render()
  }

  if (act === 'c-add') return openModal({ type: 'card', id: null, draft: { front: '', back: '' } })
  if (act === 'c-edit') {
    const c = tab.cards.find((x) => x.id === el.dataset.id)
    if (c) openModal({ type: 'card', id: c.id, draft: { front: c.front, back: c.back } })
    return
  }
  if (act === 'c-del') {
    if (!confirm('Remove this card?')) return
    tab.cards = tab.cards.filter((x) => x.id !== el.dataset.id)
    saveStudy(s)
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
  if (e.target.id === 'st-chat-in') { ui.chatDraft = e.target.value; return }
  if (e.target.dataset?.stf === 'rename') { ui.rename = e.target.value; return }
  if (e.target.classList?.contains('st-answer')) {
    // ponytail: writes the whole store per keystroke — fine at personal scale
    const s = loadStudy()
    const tab = curTab(s)
    if (tab?.activeQ) {
      tab.activeQ.given[Number(e.target.dataset.part)] = e.target.value ?? ''
      saveStudy(s)
    }
  }
}

function onChange(e) {
  if (e.target.dataset?.stf === 'rename') return commitRename(e.target.value) // blur commits
  if (e.target.matches?.('.st-choices input')) { // radio picks persist like typed answers
    const s = loadStudy()
    const tab = curTab(s)
    if (tab?.activeQ) {
      tab.activeQ.given[Number(e.target.closest('.st-choices').dataset.part)] = e.target.value
      saveStudy(s)
      e.target.closest('.st-choices').querySelectorAll('.st-choice').forEach((l) => l.classList.toggle('is-picked', l.querySelector('input').checked))
    }
  }
}

function onDblClick(e) {
  const el = e.target.closest('[data-st="tab"]')
  if (!el) return
  const s = loadStudy()
  if (el.dataset.id !== s.active) return
  ui.rename = curTab(s)?.name ?? ''
  render()
}

function commitRename(value) {
  if (ui.rename == null) return
  const s = loadStudy()
  const tab = curTab(s)
  if (tab) tab.name = String(value).trim() || 'Course'
  ui.rename = null
  saveStudy(s)
  // Patch just the editing chip. A full re-render here would rebuild the page
  // during the mousedown that blurred this input, so the button the user was
  // pressing would be gone by mouseup and their click would never land.
  const chip = pageRoot?.querySelector('.st-tab--edit')
  if (chip && tab) chip.outerHTML = tabBtnHTML(tab, true)
  else render()
}

document.addEventListener('keydown', (e) => {
  if (!onStudyPage()) return
  if (ui.modal) { if (e.key === 'Escape') closeModal(); return }
  const t = e.target
  if (t.closest?.('input,textarea,select,math-field')) {
    if (e.key === 'Enter' && t.id === 'st-chat-in') { e.preventDefault(); doSend() }
    else if (e.key === 'Enter' && t.id === 'st-rename') { e.preventDefault(); commitRename(t.value) }
    else if (e.key === 'Escape' && t.id === 'st-rename') { ui.rename = null; render() }
    else if (e.key === 'Enter' && t.classList?.contains('st-answer')) { e.preventDefault(); checkAnswers() }
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

document.addEventListener('change', (e) => {
  if (e.target.id !== 'st-file-input' || !e.target.files?.length || ui.modal?.type !== 'upload') return
  addFiles([...e.target.files])
  e.target.value = ''
})
