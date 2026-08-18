// Canvas plugin — widgets + settings tab. All eight widgets are live views
// over one shared fetch (courses → assignment groups w/ submissions,
// announcements, todos), hydrated after render like the calendar widgets.
// Interactions (course pills, class filters, overdue dismissals) re-fill just
// the affected widget from the cached data.

import {
  loadCanvas, saveCanvas, canvasConnected, fetchCanvasData, whoAmI, courseLabel,
  courseScore, courseLetter, letterPoints, courseCredits, semesterGPA, overallGPA, semesterValue, parseScale,
  dueDate, isSubmitted, isOverdue, overdueKey, dismissOverdue, clearDismissed,
} from './canvas.js'
import { cachedValue, cacheAge, writeCache } from './datacache.js'

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const fmtN = (n) => (n == null ? '—' : Number.isInteger(n) ? String(n) : Number(n).toFixed(1).replace(/\.0$/, ''))
const note = (t) => `<p class="cal-wnote">${t}</p>`

export const CV_KINDS = ['cvgradebook', 'cvupcoming', 'cvannounce', 'cvoverdue', 'cvgpa', 'cvsemesters', 'cvcourses', 'cvtodo']
const HEADS = {
  cvgradebook: 'Gradebook', cvupcoming: 'Upcoming assignments', cvannounce: 'Announcements',
  cvoverdue: 'Overdue', cvgpa: 'GPA', cvsemesters: 'Semesters', cvcourses: 'Courses', cvtodo: 'To-do',
}

// ---- shared data ------------------------------------------------------------

const CACHE_KEY = 'canvas.data'
// Last launch's copy, so widgets have something real to draw before any request
// is made. Fetching one course's assignment groups per course makes a cold
// Canvas load slow enough that the wait is the whole problem.
let data = cachedValue(CACHE_KEY)
let dataPromise = null
let dataAt = 0
function canvasData(force = false) {
  if (!force && dataPromise && Date.now() - dataAt < 120e3) return dataPromise
  dataAt = Date.now()
  dataPromise = fetchCanvasData().then((d) => {
    data = d
    writeCache(CACHE_KEY, d)
    return d
  })
  dataPromise.catch(() => { dataPromise = null })
  return dataPromise
}
export const invalidateCanvasData = () => { dataPromise = null; data = null }

// Pull Canvas in the background at boot so the page is already populated by the
// time it is opened. Quiet on failure: the cached copy stays on screen.
export async function warmCanvas() {
  if (!canvasConnected()) return
  if (cacheAge(CACHE_KEY) < 120e3) return // still fresh from this session
  try { await canvasData() } catch { /* prefetch is best-effort */ }
}

const ui = new Map() // widget id → {course, filter} (session-only view state)
const uiFor = (wid) => { if (!ui.has(wid)) ui.set(wid, {}); return ui.get(wid) }

const PALETTE = ['#7986cb', '#33b679', '#e67c73', '#e0b15c', '#74d6c4', '#b39ddb', '#f6bf26', '#8e24aa']
const courseColor = (c) => PALETTE[Math.max(0, data.courses.indexOf(c)) % PALETTE.length]

// All-or-nothing course labels. Every course-naming site funnels through
// courseCode, so flipping labelMode ticks the WHOLE page from nicknames to codes
// at once — never a mix. reflowLabels (below) decides the mode by measurement.
let labelMode = 'nick' // 'nick' | 'code'
const courseCode = (c) => courseLabel(c, labelMode, loadCanvas().labels)
const hiddenCourses = () => loadCanvas().hiddenCourses.map(String)
const visibleCourses = () => {
  const hidden = hiddenCourses()
  return data.courses.filter((c) => !hidden.includes(String(c.id)))
}

// ---- widget shells ------------------------------------------------------------

export function canvasWidgetHTML(w) {
  return `<p class="gym-head">${HEADS[w.kind]}</p><div class="cv-mount" data-cv-widget="${w.kind}" data-wid="${esc(w.id)}"><p class="cal-wnote">Loading…</p></div>`
}

export function hydrateCanvasWidgets(contentEl) {
  const mounts = contentEl.querySelectorAll('[data-cv-widget]')
  if (!mounts.length) return
  if (!canvasConnected()) {
    for (const m of mounts) m.innerHTML = note('Connect Canvas in <a href="#/canvas/settings">Canvas → Settings</a>.')
    return
  }
  // Paint the cached copy first — the page is then never a wall of "Loading…",
  // and the refresh below swaps in fresh data when it lands.
  const hadCache = !!data
  if (hadCache) { for (const m of mounts) fillMount(m); scheduleReflow(contentEl) }
  observeLabels(contentEl)
  canvasData()
    .then(() => { for (const m of contentEl.querySelectorAll('[data-cv-widget]')) fillMount(m); scheduleReflow(contentEl) })
    .catch((err) => {
      // With a cached copy on screen, a failed refresh is not worth replacing
      // real (if stale) grades with an error message.
      if (hadCache) return
      for (const m of contentEl.querySelectorAll('[data-cv-widget]')) m.innerHTML = note(esc(err.message))
    })
}

const BUILDERS = {
  cvgradebook: gradebookHTML, cvupcoming: upcomingHTML, cvannounce: announceHTML,
  cvoverdue: overdueHTML, cvgpa: gpaHTML, cvsemesters: semestersHTML, cvcourses: coursesHTML, cvtodo: todoHTML,
}
function fillMount(m) {
  try { m.innerHTML = BUILDERS[m.dataset.cvWidget](m.dataset.wid) } catch (err) { m.innerHTML = note(esc(err.message)) }
}
const refillWid = (wid) => {
  const m = document.querySelector(`.cv-mount[data-wid="${CSS.escape(wid)}"]`)
  if (m && data) fillMount(m)
}
const refillKind = (kind) => {
  if (!data) return
  for (const m of document.querySelectorAll(`[data-cv-widget="${kind}"]`)) fillMount(m)
}

// Course-label reflow: show nicknames when they all fit, else tick every .cv-ctag
// over to its code. The mode is decided from the nickname baseline so growing the
// element reverts the switch. Mirrors view.js's .chart-mount ResizeObserver idiom;
// the width guard ignores height-only changes (including our own refills), so the
// re-fill below can't loop.
let labelRO = null, labelRoot = null, labelW = -1, labelPending = false
function refillAllMounts(root) {
  if (!data) return
  for (const m of root.querySelectorAll('[data-cv-widget]')) fillMount(m)
}
function anyTagOverflows(root) {
  for (const t of root.querySelectorAll('.cv-ctag')) if (t.scrollWidth > t.clientWidth + 1) return true
  return false
}
function reflowLabels(root) {
  if (!data || !root.querySelector('.cv-ctag')) return
  if (labelMode !== 'nick') { labelMode = 'nick'; refillAllMounts(root) }
  if (anyTagOverflows(root)) { labelMode = 'code'; refillAllMounts(root) }
}
function scheduleReflow(root) {
  if (labelPending) return
  labelPending = true
  requestAnimationFrame(() => { labelPending = false; reflowLabels(root) })
}
function observeLabels(root) {
  if (labelRoot !== root) { labelRO?.disconnect(); labelRO = null; labelW = -1 }
  labelRoot = root
  if (labelRO) return
  labelRO = new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width)
    if (w === labelW) return
    labelW = w
    scheduleReflow(root)
  })
  labelRO.observe(root)
}

// ---- builders --------------------------------------------------------------------

const filterBar = (wid, filt) => `
  <select class="pw-field cv-filter" data-wid="${esc(wid)}" aria-label="Filter by class">
    <option value="all"${filt === 'all' ? ' selected' : ''}>All classes</option>
    ${visibleCourses().map((c) => `<option value="${c.id}"${filt === String(c.id) ? ' selected' : ''}>${esc(courseCode(c))}</option>`).join('')}
  </select>`

const ctag = (c) => `<span class="cv-ctag" style="--cvc:${courseColor(c)}">${esc(courseCode(c))}</span>`

function fmtRel(d) {
  const days = Math.floor((d - new Date()) / 86400e3)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (days < 0) return `${-days}d ago`
  if (days === 0 && d > new Date()) return `today · ${time}`
  if (days === 0) return `${Math.max(1, Math.round((new Date() - d) / 3600e3))}h ago`
  if (days === 1) return `tomorrow · ${time}`
  return `in ${days}d · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`
}

function gradebookHTML(wid) {
  const courses = visibleCourses()
  if (!courses.length) return note(data.courses.length ? 'All courses are disabled — enable one in <a href="#/canvas/settings">Canvas → Settings</a>.' : 'No active courses.')
  const st = uiFor(wid)
  const course = courses.find((c) => String(c.id) === String(st.course)) || courses[0]
  const { pct } = courseScore(course)
  const letter = courseLetter(course, loadCanvas()) // Atlas's scale, so this line can't disagree with the Courses card
  const groups = (data.groups[course.id] || []).slice().sort((a, b) => (a.position || 0) - (b.position || 0))
  const pills = courses.map((c) => `
    <button type="button" class="cv-pill${c.id === course.id ? ' is-active' : ''}" data-wid="${esc(wid)}" data-cv-course="${c.id}" style="--cvc:${courseColor(c)}">${esc(courseCode(c))}</button>`).join('')
  const groupsHTML = groups.map((g) => {
    const as = (g.assignments || []).slice().sort((a, b) => (dueDate(a) || 0) - (dueDate(b) || 0))
    const graded = as.filter((a) => a.submission?.score != null && !a.submission?.excused && a.points_possible > 0)
    const avg = graded.length
      ? (graded.reduce((t, a) => t + a.submission.score, 0) / graded.reduce((t, a) => t + a.points_possible, 0)) * 100
      : null
    const rows = as.map((a) => {
      let right
      if (a.submission?.excused) right = `<span class="cv-score cv-dim">EX</span>`
      else if (a.submission?.score != null) {
        const apct = a.points_possible > 0 ? (a.submission.score / a.points_possible) * 100 : null
        const diff = apct != null && avg != null && graded.length > 1 ? apct - avg : null
        const trend = diff != null && Math.abs(diff) >= 1
          ? `<span class="cv-trend ${diff > 0 ? 'cv-up' : 'cv-down'}" title="vs. category average">${diff > 0 ? '▲' : '▼'}${Math.abs(diff).toFixed(0)}%</span>` : ''
        right = `${trend}<span class="cv-score">${fmtN(a.submission.score)}/${fmtN(a.points_possible)}</span>${apct != null ? `<span class="cv-pct">${apct.toFixed(0)}%</span>` : ''}`
      } else right = `<span class="cv-score cv-dim">—/${fmtN(a.points_possible)}</span>`
      return `<button type="button" class="cv-arow cv-arow--btn" data-cv-assign="${course.id}:${a.id}"><span class="cv-aname" title="${esc(a.name)}">${esc(a.name)}</span>${right}</button>`
    }).join('')
    return `<div class="cv-group">
      <div class="cv-group__head"><span class="cv-group__name">${esc(g.name)}</span>
        ${g.group_weight > 0 ? `<span class="cv-weight">${fmtN(g.group_weight)}%</span>` : ''}
        ${avg != null ? `<span class="cv-gavg">avg ${avg.toFixed(1)}%</span>` : ''}
      </div>${rows || note('No assignments yet.')}</div>`
  }).join('')
  return `<div class="cv-pills">${pills}</div>
    <div class="cv-course-line"><span class="cv-cname" title="${esc(course.original_name || course.name)}">${esc(courseCode(course))}</span>
      <span class="cv-cgrade">${pct != null ? pct.toFixed(1) + '%' : '—'}${letter ? ` · ${esc(letter)}` : ''}</span></div>
    ${groupsHTML || note('No assignment groups.')}`
}

function upcomingHTML(wid) {
  const st = uiFor(wid)
  const filt = st.filter || 'all'
  const now = new Date()
  const items = []
  for (const c of visibleCourses()) {
    if (filt !== 'all' && String(c.id) !== filt) continue
    for (const g of data.groups[c.id] || []) {
      for (const a of g.assignments || []) {
        const d = dueDate(a)
        if (d && d > now) items.push({ a, c, d })
      }
    }
  }
  items.sort((x, y) => x.d - y.d)
  const rows = items.slice(0, 12).map(({ a, c, d }) => `
    <button type="button" class="cv-arow cv-arow--btn" data-cv-assign="${c.id}:${a.id}">${ctag(c)}
      <span class="cv-aname">${esc(a.name)}${isSubmitted(a) ? ' <span class="cv-done" title="Submitted">✓</span>' : ''}</span>
      <span class="cv-due">${fmtRel(d)}</span>
    </button>`).join('')
  return filterBar(wid, filt) + (rows ? `<div class="cv-rows">${rows}</div>` : note('Nothing coming up.'))
}

function announceHTML(wid) {
  const st = uiFor(wid)
  const filt = st.filter || 'all'
  const vis = new Set(visibleCourses().map((c) => `course_${c.id}`))
  const list = data.announcements
    .filter((a) => vis.has(a.context_code) && (filt === 'all' || a.context_code === `course_${filt}`))
    .slice().sort((a, b) => new Date(b.posted_at) - new Date(a.posted_at)).slice(0, 10)
  const rows = list.map((a) => {
    const c = data.courses.find((x) => `course_${x.id}` === a.context_code)
    return `<button type="button" class="cv-ann" data-idx="${data.announcements.indexOf(a)}">
      ${c ? ctag(c) : '<span></span>'}<span class="cv-aname">${esc(a.title)}</span>
      <span class="cv-due">${new Date(a.posted_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
    </button>`
  }).join('')
  return filterBar(wid, filt) + (rows ? `<div class="cv-rows">${rows}</div>` : note('No announcements.'))
}

function overdueHTML() {
  const s = loadCanvas()
  const now = new Date()
  const items = []
  for (const c of visibleCourses()) {
    for (const g of data.groups[c.id] || []) {
      for (const a of g.assignments || []) {
        if (isOverdue(a, now) && !s.dismissed.includes(overdueKey(c.id, a))) items.push({ a, c, d: dueDate(a) })
      }
    }
  }
  items.sort((x, y) => y.d - x.d)
  const rows = items.map(({ a, c, d }) => `
    <div class="cv-arow cv-arow--overdue">${ctag(c)}
      <span class="cv-aname">${esc(a.name)}</span>
      <span class="cv-due cv-late">${fmtRel(d)}</span>
      <button type="button" class="cv-x" data-cv-dismiss="${overdueKey(c.id, a)}" title="Hide — handled outside Canvas (e.g. turned in on paper)">×</button>
    </div>`).join('')
  const hidden = s.dismissed.length
    ? `<button type="button" class="cv-unhide">${s.dismissed.length} hidden · unhide all</button>` : ''
  return (rows ? `<div class="cv-rows">${rows}</div>` : note('Nothing overdue. Clean slate.')) + hidden
}

function gpaHTML() {
  const s = loadCanvas()
  const cur = semesterGPA(visibleCourses(), s)
  const all = overallGPA(visibleCourses(), s)
  return `<div class="cv-gpa">
      <div class="cv-gpa__item"><span class="cv-gpa__num">${all ? all.gpa.toFixed(2) : '—'}</span><span class="cv-gpa__lab">overall</span></div>
      <div class="cv-gpa__item"><span class="cv-gpa__num">${cur ? cur.gpa.toFixed(2) : '—'}</span><span class="cv-gpa__lab">this semester</span></div>
    </div>
    <p class="gym-sub">${all ? `${fmtN(all.credits)} credits · ` : ''}${s.scale === 'letters' ? 'plain-letter scale' : '± scale'} · credits & semesters in Canvas → Settings</p>`
}

function semestersHTML() {
  const s = loadCanvas()
  const cur = semesterGPA(visibleCourses(), s)
  const rows = s.semesters.map((sem) => {
    const v = semesterValue(sem)
    const n = sem.classes?.length
    return `
    <div class="cv-semrow"><span class="cv-semname">${esc(sem.name || 'Semester')}</span>
      <span class="cv-semcr">${v ? fmtN(v.credits) : '—'} cr${n ? ` · ${n} class${n === 1 ? '' : 'es'}` : ''}</span>
      <span class="cv-semgpa">${v ? v.gpa.toFixed(2) : '—'}</span></div>`
  }).join('')
  const curRow = cur ? `
    <div class="cv-semrow cv-semrow--current"><span class="cv-semname">Current (live)</span>
      <span class="cv-semcr">${fmtN(cur.credits)} cr</span><span class="cv-semgpa">${cur.gpa.toFixed(2)}</span></div>` : ''
  return (rows + curRow || note('No semesters yet.')) +
    `<p class="cal-wnote">Add past semesters in <a href="#/canvas/settings">Canvas → Settings</a>.</p>`
}

function coursesHTML() {
  const courses = visibleCourses()
  if (!courses.length) return note('No active courses.')
  const s = loadCanvas()
  return `<div class="cv-cards">${courses.map((c) => {
    const { pct } = courseScore(c)
    const letter = courseLetter(c, s)
    const p = letterPoints(letter)
    const tone = p == null ? '' : p >= 3.7 ? ' cv-tone-a' : p >= 2.7 ? ' cv-tone-b' : p >= 1.7 ? ' cv-tone-c' : ' cv-tone-d'
    return `<div class="cv-card" style="--cvc:${courseColor(c)}">
      <span class="cv-card__code">${esc(courseCode(c))}</span>
      <span class="cv-card__pct">${pct != null ? pct.toFixed(1) + '%' : '—'}</span>
      <span class="cv-card__letter${tone}">${letter || '·'}</span>
    </div>`
  }).join('')}</div>`
}

function todoHTML() {
  const hidden = hiddenCourses()
  const courseOf = (t) =>
    data.courses.find((x) => String(x.id) === String(t.course_id)) ||
    data.courses.find((x) => x.name === t.context_name || x.original_name === t.context_name)
  const items = data.todos
    .map((t) => ({ t, c: courseOf(t), idx: data.todos.indexOf(t) }))
    .filter(({ t, c }) => (t.assignment || t.type === 'submitting') && (!c || !hidden.includes(String(c.id))))
    .slice(0, 10)
  const rows = items.map(({ t, c, idx }) => {
    const d = t.assignment?.due_at ? new Date(t.assignment.due_at) : null
    return `<button type="button" class="cv-arow cv-arow--btn" data-cv-todo="${idx}">
      ${c ? ctag(c) : t.context_name ? `<span class="cv-ctag">${esc(t.context_name)}</span>` : ''}
      <span class="cv-aname">${esc(t.assignment?.name || t.title || 'To-do')}</span>
      <span class="cv-due">${d ? fmtRel(d) : ''}</span>
    </button>`
  }).join('')
  return rows ? `<div class="cv-rows">${rows}</div>` : note('Canvas to-do list is empty.')
}

// ---- interactions ------------------------------------------------------------------

export function sanitizeHTML(html) {
  const t = document.createElement('template')
  t.innerHTML = html
  t.content.querySelectorAll('script,iframe,object,embed,link,meta,style,form').forEach((n) => n.remove())
  for (const n of t.content.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      // Browsers strip tab/CR/LF from a URL before reading its scheme, so
      // "jav&#9;ascript:…" still runs as javascript: — normalize before
      // matching, or the check is bypassed by an href plain markdown can
      // express. data: is refused for navigation only (inline <img> is fine).
      const url = /^(href|src|xlink:href|formaction)$/i.test(a.name) ? a.value.replace(/[\t\n\r\0]/g, '').trim() : ''
      if (/^on/i.test(a.name) || /^(javascript|vbscript):/i.test(url) || (/^href$/i.test(a.name) && /^data:/i.test(url))) n.removeAttribute(a.name)
    }
  }
  return t.innerHTML
}

const findAssignment = (courseId, assignmentId) => {
  for (const g of data?.groups[courseId] || []) {
    const a = (g.assignments || []).find((x) => String(x.id) === String(assignmentId))
    if (a) return a
  }
  return null
}

// Status line for the assignment modal — mirrors the score/overdue logic the
// widgets use, in words.
function assignmentStatus(a) {
  const sub = a.submission
  if (sub?.excused) return { label: 'Excused', cls: 'cv-dim' }
  if (sub?.score != null) {
    const pct = a.points_possible > 0 ? ` · ${((sub.score / a.points_possible) * 100).toFixed(0)}%` : ''
    return { label: `Scored ${fmtN(sub.score)} / ${fmtN(a.points_possible)}${pct}`, cls: 'cv-up' }
  }
  if (sub?.submitted_at) return { label: 'Submitted · awaiting grade', cls: '' }
  if (isOverdue(a)) return { label: 'Overdue · not submitted', cls: 'cv-down' }
  return { label: 'Not submitted', cls: '' }
}

function openAssignment(a, c) {
  if (!a) return
  document.querySelector('.cv-overlay')?.remove()
  const d = dueDate(a)
  const st = assignmentStatus(a)
  const meta = [
    c ? esc(courseCode(c)) : null,
    d ? `Due ${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'No due date',
    a.points_possible != null ? `${fmtN(a.points_possible)} pts` : null,
  ].filter(Boolean).join(' · ')
  const body = a.description ? sanitizeHTML(a.description) : ''
  const o = document.createElement('div')
  o.className = 'modal-overlay cal-overlay cv-overlay'
  o.innerHTML = `<div class="cal-panel">
    <div class="cal-panel__head"><h2 class="cal-panel__title">${esc(a.name || 'Assignment')}</h2>
      <button type="button" class="mail-iconbtn" data-cv-x="close" aria-label="Close">✕</button></div>
    <p class="cal-panel__cal">${meta}</p>
    <p class="cv-status ${st.cls}">${st.label}</p>
    ${body ? `<div class="cv-annbody">${body}</div>` : note('No description provided.')}
    ${a.html_url ? `<div class="cal-panel__foot"><a class="gym-btn" href="${esc(a.html_url)}" target="_blank" rel="noopener">Open in Canvas ↗</a></div>` : ''}</div>`
  o.addEventListener('click', (e) => { if (e.target === o) o.remove() })
  document.body.appendChild(o)
  for (const link of o.querySelectorAll('.cv-annbody a')) { link.target = '_blank'; link.rel = 'noopener' }
}

function openAnnouncement(idx) {
  const a = data?.announcements[idx]
  if (!a) return
  document.querySelector('.cv-overlay')?.remove()
  const c = data.courses.find((x) => `course_${x.id}` === a.context_code)
  const o = document.createElement('div')
  o.className = 'modal-overlay cal-overlay cv-overlay'
  o.innerHTML = `<div class="cal-panel">
    <div class="cal-panel__head"><h2 class="cal-panel__title">${esc(a.title)}</h2>
      <button type="button" class="mail-iconbtn" data-cv-x="close" aria-label="Close">✕</button></div>
    <p class="cal-panel__cal">${esc(c?.name || '')} · ${new Date(a.posted_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</p>
    <div class="cv-annbody">${sanitizeHTML(a.message || '')}</div>`
  o.addEventListener('click', (e) => { if (e.target === o) o.remove() })
  document.body.appendChild(o)
  for (const link of o.querySelectorAll('a')) { link.target = '_blank'; link.rel = 'noopener' }
}

// One-time delegation for all canvas widgets, wherever they render.
export function bindCanvas() {
  document.addEventListener('click', (e) => {
    const pill = e.target.closest('.cv-pill')
    if (pill) { uiFor(pill.dataset.wid).course = pill.dataset.cvCourse; refillWid(pill.dataset.wid); return }
    const dis = e.target.closest('[data-cv-dismiss]')
    if (dis) {
      const [cid, aid] = dis.dataset.cvDismiss.split(':')
      dismissOverdue(cid, { id: aid })
      refillKind('cvoverdue')
      return
    }
    if (e.target.closest('.cv-unhide')) { clearDismissed(); refillKind('cvoverdue'); return }
    const ann = e.target.closest('.cv-ann')
    if (ann) { openAnnouncement(Number(ann.dataset.idx)); return }
    const assign = e.target.closest('[data-cv-assign]')
    if (assign) {
      const [cid, aid] = assign.dataset.cvAssign.split(':')
      openAssignment(findAssignment(cid, aid), data?.courses.find((x) => String(x.id) === cid))
      return
    }
    const todo = e.target.closest('[data-cv-todo]')
    if (todo) {
      const t = data?.todos[Number(todo.dataset.cvTodo)]
      if (t) {
        const c = data.courses.find((x) => String(x.id) === String(t.course_id)) ||
          data.courses.find((x) => x.name === t.context_name || x.original_name === t.context_name)
        // todo carries the full assignment; fall back to a title-only stub
        openAssignment(t.assignment || { name: t.title || 'To-do' }, c)
      }
      return
    }
    if (e.target.closest('[data-cv-x="close"]')) document.querySelector('.cv-overlay')?.remove()
  })
  document.addEventListener('change', (e) => {
    const f = e.target.closest('.cv-filter')
    if (f) { uiFor(f.dataset.wid).filter = f.value; refillWid(f.dataset.wid) }
  })
}

// ---- Canvas settings tab -------------------------------------------------------------

const semId = () => 's' + Math.random().toString(36).slice(2, 8)

const GRADE_OPTIONS = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D+', 'D', 'D-', 'F']

export function renderCanvasSettings(container) {
  const s = loadCanvas()
  const semRows = s.semesters.map((sem) => {
    const locked = !!sem.classes?.length // classes present → GPA/credits are computed
    const v = locked ? semesterValue(sem) : null
    return `
    <div class="cv-semblock" data-sem-id="${esc(sem.id)}">
      <div class="cv-semedit">
        <input class="pw-field" data-cv-sem="name" value="${esc(sem.name || '')}" placeholder="Fall 2025" aria-label="Semester name">
        <input class="pw-field cv-num" data-cv-sem="gpa" type="number" min="0" max="4" step="0.01" value="${locked ? (v ? v.gpa.toFixed(2) : '') : esc(sem.gpa ?? '')}"${locked ? ' disabled title="Computed from the classes below"' : ''} placeholder="GPA" aria-label="Semester GPA">
        <input class="pw-field cv-num" data-cv-sem="credits" type="number" min="0" step="0.5" value="${locked ? (v ? v.credits : '') : esc(sem.credits ?? '')}"${locked ? ' disabled title="Computed from the classes below"' : ''} placeholder="credits" aria-label="Semester credits">
        <button type="button" class="pw-item-remove" data-cv-set="rm-sem" title="Remove semester">×</button>
      </div>
      ${(sem.classes || []).map((cl) => `
      <div class="cv-semedit cv-classrow" data-class-id="${esc(cl.id)}">
        <input class="pw-field" data-cv-class="name" value="${esc(cl.name || '')}" placeholder="Course name" aria-label="Class name">
        <select class="pw-field cv-num" data-cv-class="grade" aria-label="Grade">${GRADE_OPTIONS.map((g) => `<option${cl.grade === g ? ' selected' : ''}>${g}</option>`).join('')}</select>
        <input class="pw-field cv-num" data-cv-class="credits" type="number" min="0" step="0.5" value="${esc(cl.credits ?? '')}" placeholder="credits" aria-label="Class credits">
        <button type="button" class="pw-item-remove" data-cv-set="rm-class" title="Remove class">×</button>
      </div>`).join('')}
      <button type="button" class="cv-addclass" data-cv-set="add-class">+ Add class${locked ? '' : ' — or list the classes and Atlas computes the GPA'}</button>
    </div>`
  }).join('')
  container.innerHTML = `<div class="page gym-settings cv-settings">
    <p class="gym-head">Connection</p>
    <div class="cv-conn">
      <input id="cv-host" class="pw-field" placeholder="yourschool.instructure.com" value="${esc(s.host)}" aria-label="Canvas host">
      <input id="cv-token" class="pw-field" type="password" placeholder="Canvas access token" value="${esc(s.token)}" aria-label="Canvas access token">
      <button type="button" class="gym-btn" data-cv-set="connect">Save & test</button>
    </div>
    <p class="gym-sub" id="cv-conn-status">${canvasConnected(s)
      ? 'Token saved — widgets sync from this account.'
      : 'Create a token in Canvas → Account → Settings → “+ New Access Token”, then paste it here with your school\'s Canvas address.'}</p>
    <p class="gym-head">Grade scale</p>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Letter scale</span>
        <span class="set-row__sub">How Canvas percentages become grade points for GPA.</span></div>
      <select id="cv-scale" class="pw-field">
        <option value="plusminus"${s.scale === 'plusminus' ? ' selected' : ''}>Letters with + / − (A− = 3.7)</option>
        <option value="letters"${s.scale === 'letters' ? ' selected' : ''}>Letters only (A = 4)</option>
      </select>
    </div>
    <p class="gym-head">Courses</p>
    <p class="gym-sub">Untick a course to hide it from every widget (grades, GPA, upcoming, announcements…). Canvas doesn't publish credit hours — set them here (unset courses count as 3).</p>
    <p class="gym-sub">Scale: leave blank to use the letter scale above, or type one class's own cutoffs — <code>A 90, B 80, C 70, D 60</code>. Pluses and minuses work too (<code>A 93, A- 90, B+ 87</code>); anything below the lowest cutoff is an F.</p>
    <div id="cv-credits">${canvasConnected(s) ? note('Loading courses…') : note('Connect first to list your courses.')}</div>
    <p class="gym-head">Previous semesters</p>
    <p class="gym-sub">Enter each semester's overall GPA directly, or list its classes and the GPA is computed for you.</p>
    <div id="cv-sems">${semRows || note('None yet — add the semesters you completed before using Atlas.')}</div>
    <button type="button" class="gym-btn gym-btn--ghost" data-cv-set="add-sem">+ Add semester</button>
    <p class="gym-head">Hidden overdue assignments</p>
    <p class="gym-sub" id="cv-hidden-line">${s.dismissed.length} hidden${s.dismissed.length ? ' <button type="button" class="gym-btn gym-btn--ghost" data-cv-set="unhide">Unhide all</button>' : ''}</p>
  </div>`

  const fillCredits = () => {
    const el = container.querySelector('#cv-credits')
    if (!el) return
    canvasData().then(() => {
      const s2 = loadCanvas()
      const hidden = s2.hiddenCourses.map(String)
      const labels = s2.labels
      el.innerHTML = data.courses.map((c) => `
        <div class="cv-semedit cv-labelrow${hidden.includes(String(c.id)) ? ' cv-course-off' : ''}">
          <label class="gym-check" title="Show this course in widgets"><input type="checkbox" data-cv-course-on="${c.id}"${hidden.includes(String(c.id)) ? '' : ' checked'}></label>
          <span class="cv-credit-name" title="${esc(c.original_name || c.name)}">${esc(c.name)}</span>
          <input class="pw-field cv-labelin" data-cv-nick="${c.id}" value="${esc(labels[c.id]?.nick ?? '')}" placeholder="${esc(c.name)}" aria-label="Nickname for ${esc(c.name)}">
          <input class="pw-field cv-labelin" data-cv-code="${c.id}" value="${esc(labels[c.id]?.code ?? '')}" placeholder="${esc(c.course_code || 'code')}" aria-label="Short code for ${esc(c.name)}">
          <input class="pw-field cv-labelin cv-scalein" data-cv-scale="${c.id}" value="${esc(s2.scales[c.id] ?? '')}" placeholder="default — e.g. A 90, B 80, C 70" aria-label="Grade scale for ${esc(c.name)}">
          <input class="pw-field cv-num" type="number" min="0" step="0.5" data-cv-credit="${c.id}" value="${esc(s2.credits[c.id] ?? '')}" placeholder="3" aria-label="Credit hours for ${esc(c.name)}">
        </div>`).join('') || note('No active courses found.')
    }).catch((err) => { el.innerHTML = note(esc(err.message)) })
  }
  if (canvasConnected(s)) fillCredits()

  container.onclick = (e) => {
    const act = e.target.closest('[data-cv-set]')
    if (!act) return
    const s2 = loadCanvas()
    if (act.dataset.cvSet === 'connect') {
      s2.host = container.querySelector('#cv-host').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      s2.token = container.querySelector('#cv-token').value.trim()
      saveCanvas(s2)
      invalidateCanvasData()
      const status = container.querySelector('#cv-conn-status')
      status.textContent = 'Testing…'
      whoAmI()
        .then((me) => { status.textContent = `Connected as ${me.name || me.short_name || 'you'}.`; fillCredits() })
        .catch((err) => { status.textContent = err.message })
    }
    if (act.dataset.cvSet === 'add-sem') {
      s2.semesters.push({ id: semId(), name: '', gpa: '', credits: '' })
      saveCanvas(s2)
      renderCanvasSettings(container)
    }
    if (act.dataset.cvSet === 'rm-sem') {
      const id = act.closest('[data-sem-id]')?.dataset.semId
      s2.semesters = s2.semesters.filter((x) => x.id !== id)
      saveCanvas(s2)
      renderCanvasSettings(container)
    }
    if (act.dataset.cvSet === 'add-class') {
      const sem = s2.semesters.find((x) => x.id === act.closest('[data-sem-id]')?.dataset.semId)
      if (sem) {
        sem.classes = sem.classes || []
        sem.classes.push({ id: semId(), name: '', grade: 'A', credits: '' })
        saveCanvas(s2)
        renderCanvasSettings(container)
      }
    }
    if (act.dataset.cvSet === 'rm-class') {
      const sem = s2.semesters.find((x) => x.id === act.closest('[data-sem-id]')?.dataset.semId)
      const clsId = act.closest('[data-class-id]')?.dataset.classId
      if (sem) {
        sem.classes = (sem.classes || []).filter((x) => x.id !== clsId)
        saveCanvas(s2)
        renderCanvasSettings(container)
      }
    }
    if (act.dataset.cvSet === 'unhide') {
      clearDismissed()
      renderCanvasSettings(container)
    }
  }
  container.oninput = (e) => {
    const s2 = loadCanvas()
    const onOff = e.target.closest('[data-cv-course-on]')
    if (onOff) {
      const id = onOff.dataset.cvCourseOn
      s2.hiddenCourses = onOff.checked ? s2.hiddenCourses.filter((x) => String(x) !== String(id)) : [...s2.hiddenCourses, id]
      saveCanvas(s2)
      onOff.closest('.cv-semedit')?.classList.toggle('cv-course-off', !onOff.checked)
      return
    }
    const credit = e.target.closest('[data-cv-credit]')
    if (credit) { s2.credits[credit.dataset.cvCredit] = credit.value; saveCanvas(s2); return }
    const scale = e.target.closest('[data-cv-scale]')
    if (scale) {
      const txt = scale.value.trim()
      if (txt) s2.scales[scale.dataset.cvScale] = txt; else delete s2.scales[scale.dataset.cvScale]
      saveCanvas(s2)
      // Typing "A 9" is a half-written cutoff, not an error — only flag a
      // non-empty string that parses to nothing at all.
      scale.classList.toggle('cv-bad', !!txt && !parseScale(txt))
      scale.title = parseScale(txt)?.map(([cut, l]) => `${l} ≥ ${cut}`).join(' · ') || ''
      return
    }
    const label = e.target.closest('[data-cv-nick],[data-cv-code]')
    if (label) {
      const nick = label.dataset.cvNick
      const id = nick ?? label.dataset.cvCode
      const cur = { ...(s2.labels[id] || {}), [nick != null ? 'nick' : 'code']: label.value.trim() }
      if (!cur.nick && !cur.code) delete s2.labels[id]; else s2.labels[id] = cur
      saveCanvas(s2)
      return
    }
    const cls = e.target.closest('[data-cv-class]')
    if (cls) {
      const block = cls.closest('[data-sem-id]')
      const sem = s2.semesters.find((x) => x.id === block?.dataset.semId)
      const target = sem?.classes?.find((x) => x.id === cls.closest('[data-class-id]')?.dataset.classId)
      if (target) {
        target[cls.dataset.cvClass] = cls.value
        saveCanvas(s2)
        // keep the computed GPA/credit fields live while typing
        const v = semesterValue(sem)
        block.querySelector('[data-cv-sem="gpa"]').value = v ? v.gpa.toFixed(2) : ''
        block.querySelector('[data-cv-sem="credits"]').value = v ? v.credits : ''
      }
      return
    }
    const sem = e.target.closest('[data-cv-sem]')
    if (sem) {
      const id = sem.closest('[data-sem-id]')?.dataset.semId
      const target = s2.semesters.find((x) => x.id === id)
      if (target) { target[sem.dataset.cvSem] = sem.value; saveCanvas(s2) }
    }
  }
  container.onchange = (e) => {
    if (e.target.id === 'cv-scale') {
      const s2 = loadCanvas()
      s2.scale = e.target.value
      saveCanvas(s2)
    }
  }
}
