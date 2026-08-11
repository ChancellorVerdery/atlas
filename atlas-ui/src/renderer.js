// App shell: router, sidebar nav, dashboard (the page of widgets), settings,
// and the topbar title/crumb. Two routes only — everything renders from here.
// Customize mode (src/page/customize.js) live-edits the page in place.

import { loadPage, findWidget, uid } from './page/model.js'
import { renderPageInto, observeCharts, renderMath, fitEquations } from './page/view.js'
import { enterCustomize, exitCustomize } from './page/customize.js'
import { PAGES, pageById } from './page/pages.js'
import { bindGym, renderGymSettings } from './page/gymui.js'
import { renderEmailPage } from './page/emailui.js'
import { renderCalendarPage } from './page/calendarui.js'
import { renderGraphPage } from './page/graphui.js'
import { bindCanvas, renderCanvasSettings } from './page/canvasui.js'
import { bindWork, renderWorkSettings } from './page/workui.js'
import { bindFinance, renderFinanceSettings, renderFinanceExplore } from './page/financeui.js'
import { renderLadderPage, renderLadderSettings } from './page/ladderui.js'
import { bindSleep, renderSleepSettings } from './page/sleepui.js'
import { bindFormal } from './page/formalui.js'
import { renderCoursePage, renderCourseMap, renderCourseSettings } from './page/courseui.js'
import { renderNotesPage } from './page/notesui.js'
import { renderStudyPage } from './page/studyui.js'
import { loadEmail, isConnected, connectGmail, disconnectGmail, refreshGoogleStatus } from './page/email.js'

// Widgetless plugins that own the whole content area (registry: full:true).
const FULL_PAGES = { email: renderEmailPage, calendar: renderCalendarPage, graph: renderGraphPage, ladder: renderLadderPage, course: renderCoursePage, notes: renderNotesPage, study: renderStudyPage }
// Plugin-scoped settings tabs (registry: settings:'<key>').
const SETTINGS_PAGES = { gym: renderGymSettings, canvas: renderCanvasSettings, work: renderWorkSettings, finance: renderFinanceSettings, ladder: renderLadderSettings, sleep: renderSleepSettings, course: renderCourseSettings }
// Second full-window tab per plugin (registry: explore:true|'<tab label>').
const EXPLORE_PAGES = { finance: renderFinanceExplore, course: renderCourseMap }
const exploreLabel = (def) => (typeof def.explore === 'string' ? def.explore : 'Explore')

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const ICONS = {
  dashboard: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  gym: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="9" width="3" height="6" rx="1"/><rect x="18.5" y="9" width="3" height="6" rx="1"/><rect x="5.5" y="7" width="3" height="10" rx="1"/><rect x="15.5" y="7" width="3" height="10" rx="1"/><line x1="8.5" y1="12" x2="15.5" y2="12"/></svg>',
  email: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7.5 8.5 6 8.5-6"/></svg>',
  calendar: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>',
  canvas: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 2 9l10 5 10-5z"/><path d="M6 11.8V16c0 1.4 2.7 2.8 6 2.8s6-1.4 6-2.8v-4.2"/><path d="M22 9v5"/></svg>',
  graph: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.6"/><circle cx="18" cy="9" r="2.6"/><circle cx="9" cy="18" r="2.6"/><line x1="8.3" y1="7" x2="15.7" y2="8.4"/><line x1="7" y1="8.3" x2="8.2" y2="15.7"/><line x1="16.2" y1="11.1" x2="10.9" y2="16.3"/></svg>',
  work: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M3 12.5h18"/><path d="M12 11v3"/></svg>',
  finance: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="2"/><line x1="2.5" y1="10" x2="21.5" y2="10"/><line x1="6" y1="14.5" x2="10" y2="14.5"/></svg>',
  ladder: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="16" y2="21"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
  equations: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13.5h3l2.5 6L13 4.5h8"/><path d="M14.5 12l6 8M20.5 12l-6 8"/></svg>',
  sleep: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/><path d="M14.5 5.5h4l-4 4h4"/></svg>',
  course: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5 12 3l9 3.5-9 3.5z"/><path d="M7 8.5V14c0 1.3 2.2 2.5 5 2.5s5-1.2 5-2.5V8.5"/><line x1="21" y1="6.5" x2="21" y2="12"/></svg>',
  formal: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/></svg>',
  notes: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h11l3.5 3.5v13.5a0.5 0.5 0 0 1-0.5 0.5H5a0.5 0.5 0 0 1-0.5-0.5v-16a0.5 0.5 0 0 1 0.5-0.5z"/><path d="M15.5 3.5V7.5h4"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13.5" y2="15"/></svg>',
  study: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.3C10.4 4.9 8.4 4.2 5.8 4.2c-1.1 0-2.2.15-3.3.5V19c1.1-.35 2.2-.5 3.3-.5 2.6 0 4.6.7 6.2 2.1 1.6-1.4 3.6-2.1 6.2-2.1 1.1 0 2.2.15 3.3.5V4.7c-1.1-.35-2.2-.5-3.3-.5-2.6 0-4.6.7-6.2 2.1z"/><line x1="12" y1="6.3" x2="12" y2="20.6"/></svg>',
  settings: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="8.5" x2="20" y2="8.5"/><line x1="4" y1="15.5" x2="20" y2="15.5"/><circle cx="9" cy="8.5" r="2.4"/><circle cx="15" cy="15.5" r="2.4"/></svg>',
}

function route() {
  const h = location.hash.replace(/^#\/?/, '')
  if (h === 'settings') return { name: 'settings' }
  const [id, sub] = h.split('/')
  const def = pageById(id) || PAGES[0]
  const subName = (def.settings && sub === 'settings') ? 'settings' : (def.explore && sub === 'explore') ? 'explore' : null
  return { name: 'page', def, sub: subName }
}

const isDevMode = () => localStorage.getItem('atlas.devMode') === '1'
function setDevMode(on) {
  localStorage.setItem('atlas.devMode', on ? '1' : '0')
  document.documentElement.classList.toggle('dev-mode', on)
}

let customizing = false
function setCustomizing(on) {
  if (customizing === on) return
  customizing = on
  document.body.classList.toggle('customizing', on)
  const btn = document.getElementById('customize')
  if (btn) {
    btn.classList.toggle('is-active', on)
    btn.querySelector('span').textContent = on ? 'Done' : 'Customize'
  }
  if (on) enterCustomize({ rerender: render, pageDef: route().def })
  else exitCustomize()
  render()
}

// ---- card modal (click a card to see its full, untruncated content) ------

function syncModalAspect() {
  const m = document.querySelector('#app-modal .modal')
  if (m) m.style.aspectRatio = `${window.innerWidth} / ${window.innerHeight}`
}

function openModal(title, body) {
  closeModal()
  const o = document.createElement('div')
  o.className = 'modal-overlay'
  o.id = 'app-modal'
  o.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h2 class="modal__title">${esc(title)}</h2>
    <div class="modal__body">${body}</div>
  </div>`
  document.body.appendChild(o)
  syncModalAspect() // always the same aspect ratio as the window
  fitEquations(o) // no-op unless the body contains an .eq-render (eqcard modal)
  o.addEventListener('click', (e) => { if (e.target === o) closeModal() })
  document.addEventListener('keydown', onModalKeydown)
  window.addEventListener('resize', syncModalAspect)
}
function closeModal() {
  document.getElementById('app-modal')?.remove()
  document.removeEventListener('keydown', onModalKeydown)
  window.removeEventListener('resize', syncModalAspect)
}
function onModalKeydown(e) { if (e.key === 'Escape') closeModal() }

const navItem = (hash, label, icon, active) =>
  `<a class="nav__item${active ? ' is-active' : ''}" href="#/${hash}">${icon}<span class="nav__label">${esc(label)}</span><span class="nav__dot"></span></a>`

function renderNav(r) {
  document.getElementById('nav').innerHTML = `
    <p class="nav__head">Navigate</p>
    ${PAGES.map((p) => navItem(p.id, p.label, ICONS[p.id] || ICONS.dashboard, r.def?.id === p.id)).join('')}
    <div class="nav__spacer"></div>
    ${navItem('settings', 'Settings', ICONS.settings, r.name === 'settings')}`
}

const emptyDash = (def) => `
  <div class="empty">
    <div class="empty__mark"><svg viewBox="0 0 64 64" width="58" height="58" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><circle cx="32" cy="32" r="25" opacity="0.35"/><circle cx="32" cy="32" r="18" opacity="0.2"/><path d="M32 7 35.6 28.4 57 32 35.6 35.6 32 57 28.4 35.6 7 32 28.4 28.4Z"/><circle cx="32" cy="32" r="3"/></svg></div>
    <h2 class="empty__title">Your ${esc(def.label.toLowerCase())} page is empty</h2>
    <p class="empty__text">Hit Customize to add widgets.</p>
    <span class="empty__tag">${esc(def.id)}</span>
  </div>`

const settingsHTML = () => {
  const on = isDevMode()
  const em = loadEmail()
  const accounts = em.accounts?.length ? em.accounts : (em.address ? [em.address] : [])
  const gmail = accounts.length
    ? accounts.map((a) => `<div class="set-gmail__acct">
        <span class="set-gmail__who">${esc(a)}</span>
        <button type="button" class="gym-btn gym-btn--ghost" data-act="gmail-disconnect" data-account="${esc(a)}">Disconnect</button>
      </div>`).join('') +
      `<div class="set-gmail__acct">
        ${isConnected(em) ? '' : `<button type="button" class="gym-btn" data-act="gmail-connect">Reconnect</button>`}
        <button type="button" class="gym-btn" data-act="gmail-connect">+ Add account</button>
      </div>`
    : `<button type="button" class="gym-btn" data-act="gmail-connect">Connect Google</button>`
  return `<div class="page">
    <div class="set-row">
      <div class="set-row__meta">
        <span class="set-row__name">Dev mode</span>
        <span class="set-row__sub">Extra logging and debug affordances.</span>
      </div>
      <button type="button" class="switch${on ? ' is-on' : ''}" role="switch" aria-checked="${on}" data-act="toggle-dev-mode">
        <span class="switch__dot"></span>
      </button>
    </div>
    <div class="set-row set-row--gmail">
      <div class="set-row__meta">
        <span class="set-row__name">Google account</span>
        <span class="set-row__sub" id="gmail-status">${em.address
          ? isConnected(em) ? 'Connected — the Email and Calendar pages sync with this account.' : 'Session expired — reconnect to keep syncing.'
          : 'Sign in with Google to connect Gmail and Calendar. The client secret and tokens stay on the Atlas server — never in this browser.'}</span>
      </div>
      <div class="set-gmail">${gmail}</div>
    </div>
    <div class="set-row">
      <div class="set-row__meta">
        <span class="set-row__name">Backup &amp; restore</span>
        <span class="set-row__sub">Export every Atlas setting, plugin, and board to one file, or restore from one. The file can include saved API keys (e.g. Plaid, Canvas) — keep it private. Your Google connection lives on the server and is not part of the export.</span>
      </div>
      <div class="set-data">
        <button type="button" class="gym-btn" data-act="export-data">Export all data</button>
        <button type="button" class="gym-btn gym-btn--ghost" data-act="import-data">Import…</button>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
        <span class="set-row__sub set-data__status" id="data-status"></span>
      </div>
    </div>
  </div>`
}

// Backup = every atlas.* localStorage key. Restore REPLACES all current atlas.*
// data (a true restore, not a merge — keys absent from the backup are cleared),
// after a confirm, then reloads so every plugin re-reads its store.
const DATA_PREFIX = 'atlas.'
const atlasKeys = () => {
  const ks = []
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(DATA_PREFIX)) ks.push(k) }
  return ks
}
function exportData() {
  const data = {}
  for (const k of atlasKeys()) data[k] = localStorage.getItem(k)
  const blob = new Blob([JSON.stringify({ atlasBackup: 1, exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  const d = new Date()
  a.download = `atlas-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  const el = document.getElementById('data-status')
  if (el) el.textContent = `Exported ${Object.keys(data).length} items.`
}
function importData(file) {
  const status = document.getElementById('data-status')
  const fail = (msg) => { if (status) status.textContent = msg }
  const reader = new FileReader()
  reader.onerror = () => fail("Couldn't read that file.")
  reader.onload = () => {
    let payload
    try { payload = JSON.parse(reader.result) } catch { return fail("That file isn't valid JSON.") }
    const data = payload?.data
    if (!data || typeof data !== 'object' || !Object.keys(data).some((k) => k.startsWith(DATA_PREFIX))) {
      return fail("That doesn't look like an Atlas backup.")
    }
    const keys = Object.keys(data).filter((k) => k.startsWith(DATA_PREFIX) && typeof data[k] === 'string')
    if (!confirm(`Restore ${keys.length} items from this backup? This replaces all current Atlas data.`)) return fail('Import cancelled.')
    for (const k of atlasKeys()) localStorage.removeItem(k) // clear first, so absent keys are truly gone
    for (const k of keys) localStorage.setItem(k, data[k])
    // The hooked setItem debounces each sync push by 400ms; reloading right
    // away would kill those timers and boot's pull would re-apply the STALE
    // server state over the restore. Wait out the debounce so the pushes fire
    // (sync.js's beforeunload flush catches any straggler on the way out).
    fail('Restored — syncing…')
    setTimeout(() => location.reload(), 700)
  }
  reader.readAsText(file)
}

function setHead(title, crumb) {
  document.getElementById('title').textContent = title
  document.getElementById('crumb').textContent = crumb
}

// Plugin-scoped tab bar (e.g. Gym: Board | Settings) rendered in the topbar.
function renderPageTabs(r) {
  const el = document.getElementById('page-tabs')
  if (!el) return
  if (r.name !== 'page' || (!r.def.settings && !r.def.explore)) { el.innerHTML = ''; return }
  el.innerHTML = `
    <a class="page-tab${!r.sub ? ' is-active' : ''}" href="#/${r.def.id}">${r.def.full ? esc(r.def.label) : 'Board'}</a>
    ${r.def.explore ? `<a class="page-tab${r.sub === 'explore' ? ' is-active' : ''}" href="#/${r.def.id}/explore">${esc(exploreLabel(r.def))}</a>` : ''}
    ${r.def.settings ? `<a class="page-tab${r.sub === 'settings' ? ' is-active' : ''}" href="#/${r.def.id}/settings">Settings</a>` : ''}`
}

let currentPageId = null
function render() {
  const r = route()
  // Leaving the page being customized exits customize, which re-renders.
  if (customizing && (r.name === 'settings' || r.sub || r.def.id !== currentPageId)) { setCustomizing(false); return }
  closeModal() // a modal must not outlive the page it was opened over
  document.documentElement.dataset.page = r.name === 'settings' ? 'settings' : r.sub ? `${r.def.id}-${r.sub}` : r.def.id
  renderNav(r)
  renderPageTabs(r)
  const content = document.getElementById('content')
  if (r.name === 'settings') {
    setHead('Settings', 'Atlas / Settings')
    content.innerHTML = settingsHTML()
    observeCharts(content) // drops stale chart-mount observations
  } else if (r.sub === 'settings') {
    setHead(r.def.label, `${r.def.crumb} / Settings`)
    SETTINGS_PAGES[r.def.settings](content, render)
    observeCharts(content)
  } else if (r.sub === 'explore') {
    setHead(r.def.label, `${r.def.crumb} / ${exploreLabel(r.def)}`)
    EXPLORE_PAGES[r.def.id](content, render)
    observeCharts(content)
  } else if (r.def.full) {
    // Widgetless full-window plugin — no page model, no Customize.
    currentPageId = r.def.id
    setHead(r.def.label, r.def.crumb)
    FULL_PAGES[r.def.id](content, render)
    observeCharts(content)
  } else {
    currentPageId = r.def.id
    setHead(r.def.label, r.def.crumb)
    const page = loadPage(r.def.storageKey)
    if (!page.rows.length && !customizing) content.innerHTML = emptyDash(r.def)
    else renderPageInto(content, page, customizing, r.def.storageKey)
  }
  const cbtn = document.getElementById('customize')
  if (cbtn) cbtn.style.display = r.name === 'page' && r.def.full ? 'none' : ''
}

document.body.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')
  if (act) {
    if (act.dataset.act === 'toggle-dev-mode') { setDevMode(!isDevMode()); render(); return }
    if (act.dataset.act === 'customize') { setCustomizing(!customizing); return }
    if (act.dataset.act === 'gmail-connect') {
      act.disabled = true
      connectGmail()
        .then(() => render())
        .catch((err) => {
          act.disabled = false
          const el = document.getElementById('gmail-status')
          if (el) el.textContent = err.message
        })
      return
    }
    if (act.dataset.act === 'gmail-disconnect') { disconnectGmail(act.dataset.account || undefined); render(); return }
    if (act.dataset.act === 'export-data') { exportData(); return }
    if (act.dataset.act === 'import-data') { document.getElementById('import-file')?.click(); return }
  }
  if (customizing) return
  const r = route()
  const card = e.target.closest('.pwidget--card, .pwidget--eqcard')
  if (!card || r.name !== 'page') return
  const f = findWidget(loadPage(r.def.storageKey), card.dataset.widgetId)
  if (!f) return
  // Cards show their full text; equation cards show the equation large.
  if (f.widget.kind === 'eqcard') openModal(f.widget.title, `<div class="modal__math">${renderMath(f.widget.latex)}</div>`)
  else openModal(f.widget.title, esc(f.widget.text))
})

// The backup file picker (change bubbles, so this catches the re-rendered input).
document.body.addEventListener('change', (e) => {
  if (e.target.id !== 'import-file' || !e.target.files?.length) return
  importData(e.target.files[0])
  e.target.value = '' // let the same file be re-picked if the user retries
})

// One-time cleanup of the pre-rebuild data model (widget-of-blocks + sizes).
localStorage.removeItem('atlas.customWidgets.v2')
localStorage.removeItem('atlas.widgetSize.v2')

// The Google connection lives server-side and is shared across this user's
// devices; refresh the local connected/address cache from the backend, then
// re-render so Settings/Email/Calendar reflect the true state.
refreshGoogleStatus().then((d) => { if (d) render() })

bindGym(render) // gym logging / complete / exercise-modal delegation (view mode)
bindCanvas() // canvas widget interactions (course pills, filters, dismissals)
bindWork(render) // work widget interactions (shifts, income range, tip share)
bindFinance(render) // finance widget interactions (period pills, recategorize modal, dismiss)
bindSleep(render) // sleep widget interactions (log nights/naps, quality stars, delete)
bindFormal(render) // formal widget interactions (houses, rooms, fit-check slider)
// First visit to the Canvas page gets a ready-made board (key absent = never
// seeded; an intentionally emptied board stays empty).
const CANVAS_STARTER = { v: 1, rows: [
  { id: 'r-cv1', title: 'Now', cols: [
    { id: 'c-cv1', width: 1.25, sections: [{ id: 's-cv1', lines: [{ id: 'l-cv1', widgets: [{ id: 'w-cvup', kind: 'cvupcoming' }] }] }] },
    { id: 'c-cv2', sections: [
      { id: 's-cv2', lines: [{ id: 'l-cv2', widgets: [{ id: 'w-cvod', kind: 'cvoverdue' }] }] },
      { id: 's-cv2b', lines: [{ id: 'l-cv2b', widgets: [{ id: 'w-cvtd', kind: 'cvtodo' }] }] }] },
    { id: 'c-cv3', sections: [{ id: 's-cv3', lines: [{ id: 'l-cv3', widgets: [{ id: 'w-cvan', kind: 'cvannounce' }] }] }] } ] },
  { id: 'r-cv2', title: 'Grades', cols: [
    { id: 'c-cv4', width: 1.5, sections: [{ id: 's-cv4', lines: [{ id: 'l-cv4', widgets: [{ id: 'w-cvgb', kind: 'cvgradebook' }] }] }] },
    { id: 'c-cv5', sections: [
      { id: 's-cv5', lines: [{ id: 'l-cv5', widgets: [{ id: 'w-cvgpa', kind: 'cvgpa' }] }] },
      { id: 's-cv6', lines: [{ id: 'l-cv6', widgets: [{ id: 'w-cvsem', kind: 'cvsemesters' }] }] },
      { id: 's-cv7', lines: [{ id: 'l-cv7', widgets: [{ id: 'w-cvcrs', kind: 'cvcourses' }] }] }] } ] },
] }
if (!localStorage.getItem('atlas.page.canvas.v1')) localStorage.setItem('atlas.page.canvas.v1', JSON.stringify(CANVAS_STARTER))
const WORK_STARTER = { v: 1, rows: [
  { id: 'r-wk1', cols: [
    { id: 'c-wk1', width: 1.5, sections: [
      { id: 's-wk1', lines: [{ id: 'l-wk1', widgets: [{ id: 'w-wksh', kind: 'wkshifts' }] }] },
      { id: 's-wk1b', lines: [{ id: 'l-wk1b', widgets: [{ id: 'w-wkhist', kind: 'wkhistory' }] }] }] },
    { id: 'c-wk2', sections: [
      { id: 's-wk2', lines: [{ id: 'l-wk2', widgets: [{ id: 'w-wkinc', kind: 'wkincome' }] }] },
      { id: 's-wk3', lines: [{ id: 'l-wk3', widgets: [{ id: 'w-wkts', kind: 'wktipshare' }] }] },
      { id: 's-wk4', lines: [{ id: 'l-wk4', widgets: [{ id: 'w-wkup', kind: 'wkupcoming' }] }] }] } ] },
] }
if (!localStorage.getItem('atlas.page.work.v1')) localStorage.setItem('atlas.page.work.v1', JSON.stringify(WORK_STARTER))
// One-time: work boards seeded before the Upcoming-shifts widget existed never
// got it — append it once. Flag-guarded so deleting it later sticks.
if (!localStorage.getItem('atlas.work.upseeded')) {
  try {
    const p = JSON.parse(localStorage.getItem('atlas.page.work.v1'))
    if (p?.rows?.length && !JSON.stringify(p).includes('"wkupcoming"')) {
      p.rows.push({ id: 'r-wkup', cols: [{ id: 'c-wkup', sections: [{ id: 's-wkup', lines: [{ id: 'l-wkup', widgets: [{ id: 'w-wkup2', kind: 'wkupcoming' }] }] }] }] })
      localStorage.setItem('atlas.page.work.v1', JSON.stringify(p))
    }
  } catch { /* corrupted board — leave it to loadPage's normalizer */ }
  localStorage.setItem('atlas.work.upseeded', '1')
}
// Same one-time append for Shift history — the shift log now shows only the
// last 3, so an existing board needs the paged history widget to see the rest.
if (!localStorage.getItem('atlas.work.histseeded')) {
  try {
    const p = JSON.parse(localStorage.getItem('atlas.page.work.v1'))
    if (p?.rows?.length && !JSON.stringify(p).includes('"wkhistory"')) {
      p.rows.push({ id: 'r-wkhist', cols: [{ id: 'c-wkhist', sections: [{ id: 's-wkhist', lines: [{ id: 'l-wkhist', widgets: [{ id: 'w-wkhist2', kind: 'wkhistory' }] }] }] }] })
      localStorage.setItem('atlas.page.work.v1', JSON.stringify(p))
    }
  } catch { /* corrupted board — leave it to loadPage's normalizer */ }
  localStorage.setItem('atlas.work.histseeded', '1')
}
const FINANCE_STARTER = { v: 1, rows: [
  { id: 'r-fin1', title: 'Overview', cols: [
    { id: 'c-fin1', width: 1.3, sections: [{ id: 's-fin1', lines: [{ id: 'l-fin1', widgets: [{ id: 'w-finacc', kind: 'finaccounts' }] }, { id: 'l-fin2', widgets: [{ id: 'w-finrec', kind: 'finrecent' }] }] }] },
    { id: 'c-fin2', sections: [
      { id: 's-fin2', lines: [{ id: 'l-fin3', widgets: [{ id: 'w-fininc', kind: 'finincexp' }] }] },
      { id: 's-fin3', lines: [{ id: 'l-fin4', widgets: [{ id: 'w-fincat', kind: 'fincategory' }] }] },
      { id: 's-fin4', lines: [{ id: 'l-fin5', widgets: [{ id: 'w-finsub', kind: 'finsubs' }] }] }] } ] },
  { id: 'r-fin2', title: 'Details', cols: [
    { id: 'c-fin3', sections: [{ id: 's-fin5', lines: [{ id: 'l-fin6', widgets: [{ id: 'w-fintop', kind: 'fintopspend' }] }] }] },
    { id: 'c-fin4', sections: [{ id: 's-fin6', lines: [{ id: 'l-fin7', widgets: [{ id: 'w-finbud', kind: 'finbudget' }] }] }] },
    { id: 'c-fin5', sections: [
      { id: 's-fin7', lines: [{ id: 'l-fin8', widgets: [{ id: 'w-finnw', kind: 'finnetworth' }] }] },
      { id: 's-fin8', lines: [{ id: 'l-fin9', widgets: [{ id: 'w-finan', kind: 'finanomaly' }] }] }] } ] },
] }
if (!localStorage.getItem('atlas.page.finance.v1')) localStorage.setItem('atlas.page.finance.v1', JSON.stringify(FINANCE_STARTER))
const SLEEP_STARTER = { v: 1, rows: [
  { id: 'r-sl1', cols: [
    { id: 'c-sl1', width: 1.4, sections: [{ id: 's-sl1', lines: [{ id: 'l-sl1', widgets: [{ id: 'w-sllog', kind: 'sllog' }] }] }] },
    { id: 'c-sl2', sections: [{ id: 's-sl2', lines: [{ id: 'l-sl2', widgets: [{ id: 'w-slbed', kind: 'slbedtime' }] }] }] } ] },
  { id: 'r-sl2', title: 'Trends', cols: [
    { id: 'c-sl3', sections: [{ id: 's-sl3', lines: [{ id: 'l-sl3', widgets: [{ id: 'w-slhrs', kind: 'slhours' }] }] }] },
    { id: 'c-sl4', sections: [{ id: 's-sl4', lines: [{ id: 'l-sl4', widgets: [{ id: 'w-sldbt', kind: 'sldebt' }] }] }] } ] },
] }
if (!localStorage.getItem('atlas.page.sleep.v1')) localStorage.setItem('atlas.page.sleep.v1', JSON.stringify(SLEEP_STARTER))
const FORMAL_STARTER = { v: 1, rows: [
  { id: 'r-fm1', cols: [
    { id: 'c-fm1', sections: [{ id: 's-fm1', lines: [{ id: 'l-fm1', widgets: [{ id: 'w-fmh', kind: 'fmhouses', house: { name: '', link: '', price: 0, couches: 0, rooms: [{ id: 'fr-fm1', beds: { king: 0, queen: 0, full: 0, twin: 0, futon: 0 } }] } }] }] }] } ] },
] }
if (!localStorage.getItem('atlas.page.formal.v1')) localStorage.setItem('atlas.page.formal.v1', JSON.stringify(FORMAL_STARTER))
// One-time: houses entered under the original shared-store design move onto
// the widgets themselves (one house per widget). Data-less House widgets on
// the formal board adopt the legacy houses in order; leftovers get their own
// rows. Stripping `houses` from the store makes this self-disabling.
try {
  const fmStore = JSON.parse(localStorage.getItem('atlas.formal.v1'))
  if (fmStore?.houses?.length) {
    const board = JSON.parse(localStorage.getItem('atlas.page.formal.v1'))
    const empties = []
    for (const row of board?.rows || []) for (const col of row.cols || []) for (const sec of col.sections || []) for (const line of sec.lines || [])
      for (const w of line.widgets || []) if (w.kind === 'fmhouses' && !w.house) empties.push(w)
    fmStore.houses.forEach((h, i) => {
      const { id, ...house } = h
      if (empties[i]) empties[i].house = house
      else board.rows.push({ id: `r-fmmig${i}`, cols: [{ id: `c-fmmig${i}`, sections: [{ id: `s-fmmig${i}`, lines: [{ id: `l-fmmig${i}`, widgets: [{ id: `w-fmmig${i}`, kind: 'fmhouses', house }] }] }] }] })
    })
    localStorage.setItem('atlas.page.formal.v1', JSON.stringify(board))
    delete fmStore.houses
    localStorage.setItem('atlas.formal.v1', JSON.stringify(fmStore))
  }
} catch { /* corrupted legacy store — nothing to migrate */ }
// One-time seed: if the gym store holds no real data and a seed file is
// served (e.g. data imported from an older Atlas), adopt it. "No real data"
// rather than "key absent" — merely opening Gym Settings once writes an
// empty store, which must not block the import. Removing the file (or
// having any workout/log/completion) disables it.
const gymStoreEmpty = () => {
  try {
    const g = JSON.parse(localStorage.getItem('atlas.gym.v1'))
    return !g || (!g.workouts?.length && !g.logs?.length && !g.completions?.length)
  } catch { return true }
}
// A gym page with no widgets reads as "nothing imported" even when the data
// is there — give it a starter board the first time gym data exists.
const GYM_STARTER = { v: 1, rows: [
  { id: 'r-gym1', title: 'Today', cols: [
    { id: 'c-gym1', width: 1.4, sections: [{ id: 's-gym1', lines: [{ id: 'l-gym1', widgets: [{ id: 'w-gymcur', kind: 'gymcurrent' }] }] }] },
    { id: 'c-gym2', sections: [
      { id: 's-gym2', title: 'Coming up', lines: [{ id: 'l-gym2', widgets: [{ id: 'w-gymnext1', kind: 'gymnext' }] }, { id: 'l-gym3', widgets: [{ id: 'w-gymnext2', kind: 'gymnext' }] }] },
      { id: 's-gym3', lines: [{ id: 'l-gym4', widgets: [{ id: 'w-gymscore', kind: 'gymscore' }, { id: 'w-gymvol', kind: 'gymvolume' }] }] }] }] },
  { id: 'r-gym2', title: 'Progress', cols: [
    { id: 'c-gym3', sections: [{ id: 's-gym4', lines: [{ id: 'l-gym5', widgets: [{ id: 'w-gymex', kind: 'gymexercises' }, { id: 'w-gymgraph', kind: 'gymscoregraph' }] }] }] }] },
] }
const gymPageEmpty = () => {
  try { const p = JSON.parse(localStorage.getItem('atlas.page.gym.v1')); return !p || !p.rows?.length } catch { return true }
}
const seedGymLayout = () => {
  if (!gymStoreEmpty() && gymPageEmpty()) {
    localStorage.setItem('atlas.page.gym.v1', JSON.stringify(GYM_STARTER))
    render()
  }
}
if (gymStoreEmpty()) {
  fetch('/gym-import.json').then((r) => (r.ok ? r.json() : null)).then((g) => {
    if (g && gymStoreEmpty()) {
      localStorage.setItem('atlas.gym.v1', JSON.stringify(g))
      seedGymLayout()
      render()
    }
  }).catch(() => {})
} else seedGymLayout()

// Same one-time seed for the Course Planner: with no classes yet, adopt a
// served course list (e.g. a degree checksheet import). Non-destructive —
// keeps any terms/settings already present; the empty-store check makes it
// self-disabling once classes exist.
const courseStoreEmpty = () => {
  try { const c = JSON.parse(localStorage.getItem('atlas.course.v1')); return !c || !c.courses?.length } catch { return true }
}
if (courseStoreEmpty()) {
  fetch('/course-import.json').then((r) => (r.ok ? r.json() : null)).then((incoming) => {
    if (!Array.isArray(incoming) || !incoming.length || !courseStoreEmpty()) return
    let s; try { s = JSON.parse(localStorage.getItem('atlas.course.v1')) || {} } catch { s = {} }
    if (!Array.isArray(s.courses)) s.courses = []
    s.courses.push(...incoming)
    localStorage.setItem('atlas.course.v1', JSON.stringify(s))
    render()
  }).catch(() => {})
}
// Same one-time seed for Equations: adopt a served formula sheet as its own
// column of eqlist cards, dropped beside the column that already holds the
// matching subject (anchor). The flag key is the guard — not the column's
// presence — so deleting the column doesn't resurrect it on the next load,
// and a second device that pulled the flag won't import a dup.
// ponytail: one sheet at a time; a multi-sheet queue is the upgrade path.
const EQ_IMPORT_FLAG = 'atlas.eqimport.v3'
if (localStorage.getItem(EQ_IMPORT_FLAG) === null) {
  fetch('/equations-import.json').then((r) => (r.ok ? r.json() : null)).then((imp) => {
    if (!imp?.title || !Array.isArray(imp.sections) || !imp.sections.length) return
    if (localStorage.getItem(EQ_IMPORT_FLAG) !== null) return // a pull landed it while we fetched
    let page
    try { page = JSON.parse(localStorage.getItem('atlas.page.equations.v1')) } catch { /* corrupted → fresh */ }
    if (!page || !Array.isArray(page.rows)) page = { v: 1, rows: [] }
    const col = { id: uid('c'), sections: [{ id: uid('s'), title: imp.title, lines: imp.sections.map((sec) => ({
      id: uid('l'), widgets: [{ id: uid('w'), kind: 'eqlist', title: sec.title, items: sec.items }],
    })) }] }
    const re = imp.anchor ? new RegExp(imp.anchor, 'i') : null
    const labels = (s) => [s.title, ...(s.lines || []).flatMap((l) => (l.widgets || []).map((w) => w.title))]
    // An earlier import of this same sheet may already be on the page — drop
    // it so bumping the flag re-places rather than duplicates.
    for (const row of page.rows) row.cols = (row.cols || []).filter((c) => !(c.sections || []).some((s) => s.title === imp.title))
    page.rows = page.rows.filter((r) => (r.cols || []).length)
    let placed = false
    if (re) for (const row of page.rows) {
      const at = (row.cols || []).findIndex((c) => (c.sections || []).some((s) => labels(s).some((t) => re.test(String(t || '')))))
      if (at > -1) { row.cols.splice(at + 1, 0, col); placed = true; break }
    }
    if (!placed) {
      if (!page.rows.length) page.rows.push({ id: uid('r'), cols: [] })
      page.rows[0].cols.push(col)
    }
    localStorage.setItem('atlas.page.equations.v1', JSON.stringify(page))
    localStorage.setItem(EQ_IMPORT_FLAG, imp.title)
    render()
  }).catch(() => {})
}
window.addEventListener('hashchange', render)
if (!location.hash) location.replace('#/dashboard')
setDevMode(isDevMode()) // sync html.dev-mode class on boot
render()
// Let first-load entrance animations finish, then disable replays on re-render.
setTimeout(() => document.documentElement.classList.add('ready'), 750)
