// App shell: router, sidebar nav, dashboard (the page of widgets), settings,
// and the topbar title/crumb. Two routes only — everything renders from here.
// Customize mode (src/page/customize.js) live-edits the page in place.

import { sync } from './sync.js'
import { loadPage, loadPageMobile, pageKeyFor, findWidget } from './page/model.js'
import { renderPageInto, observeCharts, renderMath, fitEquations, pageHasHiddenAll } from './page/view.js'
import { enterCustomize, exitCustomize, paletteHTML } from './page/customize.js'
import { PAGES, pageById, activePages, saveNavOrder } from './page/pages.js'
import { isPluginEnabled, loadPlugins, setPluginEnabled } from './page/plugins.js'
import { startPrefetch } from './page/prefetch.js'
import { pluginsSettingsHTML, bindPlugins } from './page/pluginsui.js'
import { bindGym, renderGymSettings } from './page/gymui.js'
import { renderEmailPage } from './page/emailui.js'
import { renderCalendarPage } from './page/calendarui.js'
import { bindCanvas, renderCanvasSettings } from './page/canvasui.js'
import { bindWork, renderWorkSettings } from './page/workui.js'
import { renderLadderPage, renderLadderSettings } from './page/ladderui.js'
import { bindSleep, renderSleepSettings } from './page/sleepui.js'
import { bindFormal } from './page/formalui.js'
import { renderCoursePage, renderCourseMap, renderCourseSettings } from './page/courseui.js'
import { renderNotesPage, startNotesSyncLoop } from './page/notesui.js'
import { renderStudyPage } from './page/studyui.js'
import { renderFlashcardsPage } from './page/flashcardsui.js'
import { renderPrintSheet } from './page/eqprintui.js'
import { loadEmail, isConnected, connectGmail, disconnectGmail, refreshGoogleStatus, primeGoogleConfig } from './page/email.js'
import { PRESETS, CUSTOM, loadTheme, saveTheme, applyTheme, resolve, logoDataURL, effectiveMode } from './page/theme.js'
import { openThemeModal } from './page/themeui.js'
import { loadAI, isClaudeConnected, beginClaudeOAuth, completeClaudeOAuth, disconnectClaude } from './page/ai.js'
import { isMobile, initPlatform } from './platform.js'

// Widgetless plugins that own the whole content area (registry: full:true).
const FULL_PAGES = { email: renderEmailPage, calendar: renderCalendarPage, ladder: renderLadderPage, course: renderCoursePage, notes: renderNotesPage, study: renderStudyPage, flashcards: renderFlashcardsPage }
// Plugin-scoped settings tabs (registry: settings:'<key>').
const SETTINGS_PAGES = { gym: renderGymSettings, canvas: renderCanvasSettings, work: renderWorkSettings, ladder: renderLadderSettings, sleep: renderSleepSettings, course: renderCourseSettings }
// Second full-window tab per plugin (registry: explore:true|'<tab label>').
const EXPLORE_PAGES = { course: renderCourseMap }
const exploreLabel = (def) => (typeof def.explore === 'string' ? def.explore : 'Explore')

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const ICONS = {
  dashboard: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  gym: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="9" width="3" height="6" rx="1"/><rect x="18.5" y="9" width="3" height="6" rx="1"/><rect x="5.5" y="7" width="3" height="10" rx="1"/><rect x="15.5" y="7" width="3" height="10" rx="1"/><line x1="8.5" y1="12" x2="15.5" y2="12"/></svg>',
  email: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7.5 8.5 6 8.5-6"/></svg>',
  calendar: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>',
  canvas: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4 2 9l10 5 10-5z"/><path d="M6 11.8V16c0 1.4 2.7 2.8 6 2.8s6-1.4 6-2.8v-4.2"/><path d="M22 9v5"/></svg>',
  work: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7"/><path d="M3 12.5h18"/><path d="M12 11v3"/></svg>',
  ladder: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="16" y2="21"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
  equations: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13.5h3l2.5 6L13 4.5h8"/><path d="M14.5 12l6 8M20.5 12l-6 8"/></svg>',
  sleep: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/><path d="M14.5 5.5h4l-4 4h4"/></svg>',
  formal: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10v9.5h13V10"/><path d="M10 19.5v-5h4v5"/></svg>',
  course: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6.5 12 3l9 3.5-9 3.5z"/><path d="M7 8.5V14c0 1.3 2.2 2.5 5 2.5s5-1.2 5-2.5V8.5"/><line x1="21" y1="6.5" x2="21" y2="12"/></svg>',
  notes: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h11l3.5 3.5v13.5a0.5 0.5 0 0 1-0.5 0.5H5a0.5 0.5 0 0 1-0.5-0.5v-16a0.5 0.5 0 0 1 0.5-0.5z"/><path d="M15.5 3.5V7.5h4"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13.5" y2="15"/></svg>',
  study: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6.3C10.4 4.9 8.4 4.2 5.8 4.2c-1.1 0-2.2.15-3.3.5V19c1.1-.35 2.2-.5 3.3-.5 2.6 0 4.6.7 6.2 2.1 1.6-1.4 3.6-2.1 6.2-2.1 1.1 0 2.2.15 3.3.5V4.7c-1.1-.35-2.2-.5-3.3-.5-2.6 0-4.6.7-6.2 2.1z"/><line x1="12" y1="6.3" x2="12" y2="20.6"/></svg>',
  flashcards: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="7" width="15" height="11" rx="2"/><path d="M3.5 5.5A2 2 0 0 1 5 4.7h11.5"/><line x1="8.5" y1="12.5" x2="16.5" y2="12.5"/></svg>',
  settings: '<svg class="nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="8.5" x2="20" y2="8.5"/><line x1="4" y1="15.5" x2="20" y2="15.5"/><circle cx="9" cy="8.5" r="2.4"/><circle cx="15" cy="15.5" r="2.4"/></svg>',
}

// Settings is three pages, not one long scroll: who you are, how it looks,
// what's turned on.
const SETTINGS_TABS = [['accounts', 'Accounts'], ['appearance', 'Appearance'], ['plugins', 'Plugins']]
// The tab used to be called "customize" — keep old #/settings/customize links
// (bookmarks, synced hashes) resolving to the same page under its new name.
const TAB_ALIASES = { customize: 'appearance' }

function route() {
  const h = location.hash.replace(/^#\/?/, '')
  const [id, sub] = h.split('/')
  if (id === 'settings') {
    const tab = TAB_ALIASES[sub] || sub
    return { name: 'settings', tab: SETTINGS_TABS.some(([t]) => t === tab) ? tab : 'accounts' }
  }
  let def = pageById(id) || PAGES[0]
  // A disabled plugin's page routes to the dashboard (stale link, synced
  // hash, or the plugin was just toggled off while open). Rewrite the hash
  // too: plugin modules (e.g. study's document-level keydown) sniff
  // location.hash to decide they're active, so a stale hash would let a
  // disabled plugin's handlers repaint the page over the dashboard.
  if (def.id !== 'dashboard' && !isPluginEnabled(def.id)) {
    def = PAGES[0]
    location.replace('#/dashboard') // triggers one extra, idempotent render
  }
  // Course Planner is desktop-only (activePages drops it from the mobile nav);
  // a stale #/course hash must not still land on it on a phone.
  if (isMobile() && def.id === 'course') {
    def = PAGES[0]
    location.replace('#/dashboard')
  }
  const subName = (def.settings && sub === 'settings') ? 'settings' : (def.explore && sub === 'explore') ? 'explore' : null
  return { name: 'page', def, sub: subName }
}

// Who's signed in, for the Settings account row. {token,userId,email} normally,
// {offline:true} when the login gate was skipped.
const authState = () => {
  try { return JSON.parse(localStorage.getItem('atlas.auth.v1')) || {} } catch { return {} }
}

// ---- math keyboard corner control -----------------------------------------
// One toggle, next to Customize, replaces the per-field keyboard/menu
// buttons that used to live in every math-field's corner (Chancellor:
// "instead of the menu and math keyboard in every text box, put them in the
// corner of the screen next to the customize button"). Every math-field
// (Equations widgets AND Study — view.js's tuneMathFields tunes both, and
// they share the one window.mathVirtualKeyboard singleton) mounts with
// math-virtual-keyboard-policy="manual", so MathLive never auto-shows it —
// this toggle's focus/blur wiring is the only thing that calls show()/hide().
// OFF: never shows, even with the caret in a field. ON: shows the moment a
// math-field is focused, hides the moment focus leaves one (clicking
// straight from field A into field B keeps it open — see the focusout
// handler's relatedTarget check).
// The math keyboard (and its toggle) belong only to the pages that actually
// mount math-fields — Study, Flashcards, Notes, Equations. Everywhere else the
// toggle is hidden and the keyboard never shows, even with a caret parked in
// some stray input, so it can't leak onto pages that have no equations.
const MATHKBD_PAGES = new Set(['study', 'flashcards', 'notes', 'equations'])
const mathAllowed = () => MATHKBD_PAGES.has(route().def?.id)
let kbEnabled = false
const isMathField = (el) => !!el?.closest?.('math-field')
function setKbEnabled(on) {
  if (kbEnabled === on) return
  kbEnabled = on
  document.getElementById('mathkbd-toggle')?.classList.toggle('is-active', on)
  if (on) { if (mathAllowed() && isMathField(document.activeElement)) window.mathVirtualKeyboard.show() }
  else window.mathVirtualKeyboard.hide()
}
document.addEventListener('focusin', (e) => {
  // Mobile uses the native Apple keyboard only — the virtual math keyboard
  // never shows there, so it can't cover the native one.
  if (kbEnabled && !isMobile() && mathAllowed() && isMathField(e.target)) window.mathVirtualKeyboard.show()
})
document.addEventListener('focusout', (e) => {
  if (!isMathField(e.target)) return
  const next = e.relatedTarget || document.activeElement
  if (!isMathField(next)) window.mathVirtualKeyboard.hide()
})
// Mirrors the Customize button's own markup/placement (index.html) — built
// here instead of there because index.html is the one shared shell file this
// pass doesn't own. Always visible (unlike #customize, which hides on
// widgetless full-window plugins — see render()'s cbtn block): Study is one
// of those full-window plugins and it mounts math-fields too, so the toggle
// can't be gated on Customize being available.
// Mobile skips the toggle entirely — the native Apple keyboard is the only
// keyboard there (see the focusin gate and render()'s visibility check).
{
  // ponytail: always create the toggle; render()'s visibility check and the
  // focusin gate hide/disable it on mobile — so a desktop window that started
  // narrow (mobile) then widened past 820px still gets it without a reload.
  const actions = document.querySelector('.topbar__actions')
  if (actions) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.id = 'mathkbd-toggle'
    btn.className = 'action-btn'
    btn.dataset.act = 'toggle-mathkbd'
    btn.title = 'Math keyboard'
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="2.2"/><line x1="6" y1="10.3" x2="6" y2="10.3"/><line x1="9.7" y1="10.3" x2="9.7" y2="10.3"/><line x1="13.4" y1="10.3" x2="13.4" y2="10.3"/><line x1="17.1" y1="10.3" x2="17.1" y2="10.3"/><line x1="6" y1="14.8" x2="17.5" y2="14.8"/></svg><span>Math keys</span>`
    actions.insertBefore(btn, actions.firstChild)
  }
}

// ---- print sheet corner control (Equations only) --------------------------
// Sits LEFT of Math keys (Chancellor, 2026-09-08: "next to math keys (on the
// left)"). Built here like the keyboard toggle; render() shows it only on the
// equations board itself, on desktop — the workbench is a three-pane layout.
{
  const actions = document.querySelector('.topbar__actions')
  if (actions) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.id = 'eqprint-toggle'
    btn.className = 'action-btn'
    btn.dataset.act = 'toggle-eqprint'
    btn.title = 'Print an equation sheet'
    btn.style.display = 'none'
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 9V4h10v5"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6H7z"/></svg><span>Print sheet</span>`
    actions.insertBefore(btn, document.getElementById('mathkbd-toggle') || actions.firstChild)
  }
}

// Mobile navigator drawer: a hamburger in the topbar slides the sidebar in
// (body.nav-open, styled by CSS this pass doesn't own); a scrim behind it, or
// any navigation, closes it. Built here rather than in the shared index.html.
{
  const topbar = document.querySelector('.topbar')
  if (topbar) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.id = 'nav-toggle'
    btn.className = 'nav-toggle'
    btn.setAttribute('aria-label', 'Menu')
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="20" y2="17"/></svg>`
    topbar.insertBefore(btn, topbar.firstChild)
  }
  const scrim = document.createElement('div')
  scrim.className = 'nav-scrim'
  document.body.appendChild(scrim)
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
  else {
    // Leaving Customize auto-closes the math keyboard (and, via the blur,
    // any field ☰ menu left open — MathLive closes those on the field
    // losing focus, the same as any other dropdown) rather than leaving it
    // stranded on-screen over a page that no longer has editable fields.
    if (isMathField(document.activeElement)) document.activeElement.blur()
    exitCustomize()
    setKbEnabled(false)
  }
  render()
}

// ---- print sheet mode (Equations only) ------------------------------------
// A page-level mode like customizing: while on, the content area shows the
// print workbench (src/page/eqprintui.js) instead of the board, until Done,
// the topbar toggle, or navigating anywhere else.
let printing = false
function setPrinting(on) {
  if (printing === on) return
  if (on && customizing) setCustomizing(false) // one mode at a time (this re-renders the board first)
  printing = on
  document.getElementById('eqprint-toggle')?.classList.toggle('is-active', on)
  render()
}

// ---- card modal (click a card to see its full, untruncated content) ------

function syncModalAspect() {
  const m = document.querySelector('#app-modal .modal')
  // .modal--fit opts out: that modal sizes to its own content instead of
  // being forced into the window's shape (see openModal's `fit` option).
  if (m && !m.classList.contains('modal--fit')) m.style.aspectRatio = `${window.innerWidth} / ${window.innerHeight}`
}

// `fit: true` skips the window-aspect lock for modals whose content has to
// stay fully visible without internal scrolling (the theme editor) rather
// than being squeezed into whatever shape the window happens to be.
function openModal(title, body, { fit = false } = {}) {
  closeModal()
  const o = document.createElement('div')
  o.className = 'modal-overlay'
  o.id = 'app-modal'
  o.innerHTML = `<div class="modal${fit ? ' modal--fit' : ''}" role="dialog" aria-modal="true">
    <h2 class="modal__title">${esc(title)}</h2>
    <div class="modal__body">${body}</div>
  </div>`
  document.body.appendChild(o)
  syncModalAspect() // no-op for modal--fit — its CSS sizes to content instead
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

// `reorderable` marks the plugin-page rows draggable for nav reordering
// (behavior: reorder plugins in the navigator) — Settings stays fixed, it's
// not a plugin/page order concern.
const navItem = (hash, label, icon, active, reorderable) =>
  `<a class="nav__item${active ? ' is-active' : ''}" href="#/${hash}"${reorderable ? ` draggable="true" data-page-id="${esc(hash)}"` : ''}>${icon}<span class="nav__label">${esc(label)}</span><span class="nav__dot"></span></a>`

// Customize hides the plugin list and shows the widget palette in its place
// (in #nav) — exiting restores it, both driven by the same `customizing`
// flag render() already tracks. Settings lives in its own fixed footer
// (#sidebar-foot) instead, so it stays reachable in both modes without
// duplicating its markup into the palette branch.
function renderNav(r) {
  const head = document.getElementById('nav-head')
  if (head) head.textContent = customizing ? 'Widgets' : 'Navigate'
  document.getElementById('nav').innerHTML = customizing
    ? paletteHTML(r.def)
    : activePages().map((p) => navItem(p.id, p.label, ICONS[p.id] || ICONS.dashboard, r.def?.id === p.id, true)).join('')
  const foot = document.getElementById('sidebar-foot')
  if (foot) foot.innerHTML = navItem('settings', 'Settings', ICONS.settings, r.name === 'settings', false)
}

// ---- nav reorder (drag rows; persists to atlas.navOrder.v1, which syncs
// automatically like any atlas.* key — see sync.js's encodePush) -----------
// Wired once on #nav (the element itself is static across renders; only its
// innerHTML changes) rather than Customize-gated: Customize hides #nav's row
// markup entirely in favor of the widget palette (see renderNav), so there's
// nothing to drag there anyway — the rows only exist while not customizing.
let navDragId = null
function onNavDragStart(e) {
  const item = e.target.closest('.nav__item[data-page-id]')
  if (!item) { navDragId = null; return }
  navDragId = item.dataset.pageId
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', navDragId) // Firefox won't start a drag with an empty data store
  requestAnimationFrame(() => item.classList.add('is-dragging'))
}
function onNavDragOver(e) {
  if (!navDragId) return
  const item = e.target.closest('.nav__item[data-page-id]')
  if (!item || item.dataset.pageId === navDragId) return
  e.preventDefault()
  const nav = document.getElementById('nav')
  const dragged = nav.querySelector(`.nav__item[data-page-id="${navDragId}"]`)
  if (!dragged) return
  const r = item.getBoundingClientRect()
  const before = e.clientY < r.top + r.height / 2
  nav.insertBefore(dragged, before ? item : item.nextElementSibling)
}
function onNavDrop(e) {
  if (!navDragId) return
  e.preventDefault()
  const order = [...document.getElementById('nav').querySelectorAll('.nav__item[data-page-id]')].map((a) => a.dataset.pageId)
  saveNavOrder(order)
  navDragId = null
  render()
}
function onNavDragEnd() {
  document.getElementById('nav')?.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'))
  navDragId = null
}
{
  const nav = document.getElementById('nav')
  nav.addEventListener('dragstart', onNavDragStart)
  nav.addEventListener('dragover', onNavDragOver)
  nav.addEventListener('drop', onNavDrop)
  nav.addEventListener('dragend', onNavDragEnd)
}

const emptyDash = (def) => `
  <div class="empty">
    <div class="empty__mark"><svg viewBox="0 0 64 64" width="58" height="58" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><circle cx="32" cy="32" r="25" opacity="0.35"/><circle cx="32" cy="32" r="18" opacity="0.2"/><path d="M32 7 35.6 28.4 57 32 35.6 35.6 32 57 28.4 35.6 7 32 28.4 28.4Z"/><circle cx="32" cy="32" r="3"/></svg></div>
    <h2 class="empty__title">Your ${esc(def.label.toLowerCase())} page is empty</h2>
    <p class="empty__text">Hit Customize to add widgets.</p>
    <span class="empty__tag">${esc(def.id)}</span>
  </div>`

// One scheme drives the whole app: every rule reads the custom properties this
// writes, and the logo (hence the app icon) is drawn from the same values.
const themeSettingsHTML = () => {
  const t = loadTheme()
  const c = resolve(t)
  // The scheme's own surface is previewed inside the swatch, never behind the
  // label — the label has to stay readable in whatever mode is current.
  const swatch = (id, p) => `
    <button type="button" class="set-theme__preset${t.preset === id ? ' is-on' : ''}"
            data-act="theme-preset" data-preset="${esc(id)}" title="${esc(p.label)}">
      <span class="set-theme__chip" style="background:${esc(p.panel)}">
        <span class="set-theme__dot" style="background:${esc(p.accent)}"></span>
        <span class="set-theme__dot set-theme__dot--sm" style="background:${esc(p.signal)}"></span>
      </span>
      <span class="set-theme__label">${esc(p.label)}</span>
    </button>`
  const mode = (id, label) => `
    <button type="button" class="set-theme__mode${t.mode === id ? ' is-on' : ''}" data-act="theme-mode" data-mode="${id}">${label}</button>`
  return `<div class="set-row">
    <div class="set-row__meta">
      <span class="set-row__name">Colour scheme</span>
      <span class="set-row__sub">Applies everywhere — pages, widgets, the logo, and the app icon. Auto follows your device's light/dark setting. Custom sets the scheme's own colours.</span>
    </div>
    <div class="set-theme">
      <div class="set-theme__row">
        <span class="set-theme__modes">${mode('dark', 'Dark')}${mode('light', 'Light')}${mode('auto', 'Auto')}</span>
        <img class="set-theme__logo" src="${esc(logoDataURL(t))}" alt="" width="40" height="40">
      </div>
      <div class="set-theme__presets">
        ${Object.entries(PRESETS).map(([id, p]) => swatch(id, p)).join('')}
        ${swatch(CUSTOM, {
          label: 'Custom',
          panel: t.custom[effectiveMode(t.mode) === 'light' ? 'lightPanel' : 'darkPanel'],
          accent: t.custom.accent, signal: t.custom.signal,
        })}
      </div>
    </div>
  </div>`
}

// AI connection: a single Claude link, authorized through the user's own
// Claude subscription via OAuth. Storage + the OAuth calls live in page/ai.js;
// this just renders + wires it, same split as theme.js/themeui.js.
const aiConnectionsHTML = () => {
  const on = isClaudeConnected(loadAI())
  return `<div class="set-row set-row--ai">
    <div class="set-row__meta">
      <span class="set-row__name">AI connection</span>
      <span class="set-row__sub">Studying and Notes run on your own Claude subscription. Connecting opens Claude in your browser to authorize Atlas; the token stays on this device and never syncs to the Atlas server.</span>
    </div>
    <div class="ai-conn">
      <div class="ai-conn__row">
        <div class="ai-conn__meta">
          <span class="ai-conn__name">Claude</span>
          <span class="ai-conn__status${on ? '' : ' ai-conn__status--off'}">${on ? 'Connected — your Claude subscription' : 'Not connected'}</span>
        </div>
        <div class="ai-conn__actions">
          ${on
            ? `<button type="button" class="gym-btn gym-btn--ghost" data-act="ai-disconnect">Disconnect</button>`
            : `<button type="button" class="gym-btn" data-act="ai-oauth-start">Connect with Claude</button>`}
        </div>
      </div>
      ${on ? '' : `<div class="ai-conn__oauth" id="ai-oauth"${claudeOAuthAwaiting ? '' : ' hidden'}>
        <input type="text" class="pw-field ai-conn__field" id="ai-oauth-code" placeholder="Paste the code from your browser" autocomplete="off" spellcheck="false">
        <button type="button" class="gym-btn" data-act="ai-oauth-finish">Finish</button>
        <span class="ai-conn__status ai-conn__status--off" id="ai-oauth-err"></span>
      </div>`}
    </div>
  </div>`
}

// Accounts: the identities Atlas talks to, and the data that belongs to them.
const accountsHTML = () => {
  const auth = authState()
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
    <div class="set-row set-row--gmail">
      <div class="set-row__meta">
        <span class="set-row__name">Google account</span>
        <span class="set-row__sub" id="gmail-status">${em.address
          ? isConnected(em) ? 'Connected — the Email and Calendar pages sync with this account.' : 'Session expired — reconnect to keep syncing.'
          : 'Sign in with Google to connect Gmail and Calendar. The client secret and tokens stay on the Atlas server — never in this browser.'}</span>
      </div>
      <div class="set-gmail">${gmail}</div>
    </div>
    ${aiConnectionsHTML()}
    ${localStorage.getItem('atlas.devMode') === '1' ? `<div class="set-row">
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
    </div>` : ''}
    <div class="set-row">
      <div class="set-row__meta">
        <span class="set-row__name">Account</span>
        <span class="set-row__sub">${auth.offline
          ? 'Working offline — this device isn’t signed in, so nothing syncs. Leaving offline mode returns to the login screen; the data on this device stays put.'
          : `Signed in as ${esc(auth.email || 'your account')}. Signing out returns to the login screen — your data stays on this device and on the server.`}</span>
      </div>
      <button type="button" class="gym-btn gym-btn--ghost" data-act="logout">${auth.offline ? 'Leave offline mode' : 'Log out'}</button>
    </div>
  </div>`
}

// Backup = every atlas.* localStorage key. Restore REPLACES all current atlas.*
// data (a true restore, not a merge — keys absent from the backup are cleared),
// after a confirm, then reloads so every plugin re-reads its store.
// Dev-only now: the Backup & restore set-row only renders when
// atlas.devMode === '1', so these are inert (no UI to trigger them) otherwise.
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
  if (r.name === 'settings') {
    el.innerHTML = SETTINGS_TABS.map(([id, label]) =>
      `<a class="page-tab${r.tab === id ? ' is-active' : ''}" href="#/settings/${id}">${label}</a>`).join('')
    return
  }
  if (r.name !== 'page' || (!r.def.settings && !r.def.explore)) { el.innerHTML = ''; return }
  el.innerHTML = `
    <a class="page-tab${!r.sub ? ' is-active' : ''}" href="#/${r.def.id}">${r.def.full ? esc(r.def.label) : 'Board'}</a>
    ${r.def.explore ? `<a class="page-tab${r.sub === 'explore' ? ' is-active' : ''}" href="#/${r.def.id}/explore">${esc(exploreLabel(r.def))}</a>` : ''}
    ${r.def.settings ? `<a class="page-tab${r.sub === 'settings' ? ' is-active' : ''}" href="#/${r.def.id}/settings">Settings</a>` : ''}`
}

// ---- scroll anchoring (Customize entry + every in-Customize rerender) -----
// Entering Customize (and every in-Customize rerender — drag/drop, inline
// edits all call ctx.rerender(), which is just render()) rebuilds #content
// from scratch, and Customize renders MORE structure than view mode
// (disabled-plugin stubs, kept for drag/drop DOM↔model index parity — see
// view.js's widgetHTML). That extra structure above the fold pushes whatever
// the user was looking at further down, reading as a jump. Fix: note which
// widget currently sits at the content viewport's top edge and its pixel
// offset from that edge, let the rebuild happen, then scroll so the SAME
// widget (matched by data-widget-id) lands at that same offset again.
// ponytail: captured fresh from the live DOM immediately before every
// rebuild rather than cached across calls — so repeated rerenders (dragging)
// each correct from truth instead of drifting or fighting a stale anchor.
function captureScrollAnchor(contentEl) {
  const top = contentEl.getBoundingClientRect().top
  for (const el of contentEl.querySelectorAll('[data-widget-id]')) {
    const r = el.getBoundingClientRect()
    if (r.bottom >= top) return { id: el.dataset.widgetId, offset: r.top - top }
  }
  return null
}
function restoreScrollAnchor(contentEl, anchor) {
  if (!anchor) return
  const el = contentEl.querySelector(`[data-widget-id="${CSS.escape(anchor.id)}"]`)
  if (!el) return
  const top = contentEl.getBoundingClientRect().top
  contentEl.scrollTop += (el.getBoundingClientRect().top - top) - anchor.offset
}

// Claude OAuth needs to open the consent URL on the SAME tick as the click —
// on iOS an `await` before window.open loses the user-gesture and the system
// browser never opens. So when the Accounts page renders and Claude isn't
// connected, mint the authorize URL ahead of time (beginClaudeOAuth also
// stashes the PKCE verifier+state locally, which completeClaudeOAuth reads),
// and the click handler opens the stashed URL synchronously.
let claudeOAuthStash = null
let claudeOAuthAwaiting = false // paste field stays shown across background re-renders
function precomputeClaudeOAuth() {
  if (isClaudeConnected(loadAI())) { claudeOAuthStash = null; claudeOAuthAwaiting = false; return }
  // Don't re-mint on every render: beginClaudeOAuth rotates the PKCE
  // verifier+state, which would invalidate a code the user is mid-way through
  // pasting when a background event (sync/hydrate/prefetch) triggers render().
  if (claudeOAuthStash) return
  beginClaudeOAuth().then((res) => { claudeOAuthStash = res }).catch(() => { claudeOAuthStash = null })
}

// Google's connected/accounts flags are a DEVICE-LOCAL cache of server state —
// the email mapper drops them, so connecting on one device tells the others
// nothing, and a stale cache makes Email/Calendar show their "Connect Google"
// page for an account that is in fact connected.
// Re-render only when the server view actually differs from what we drew, or
// render() would loop forever.
const googleSig = () => { const s = loadEmail(); return `${!!s.connected}|${(s.accounts || []).join(',')}` }
function refreshGoogleView() {
  const before = googleSig()
  return refreshGoogleStatus().then((d) => { if (d && googleSig() !== before) render() })
}

// The breadcrumb moves between two homes by breakpoint (setHead still writes it
// by #crumb id from wherever it lands): on mobile it's a direct .topbar child
// right after #nav-toggle so styles can put them on row 1 together; on desktop
// it sits inside .topbar__lead above the title. Same element, no duplication.
function placeCrumb() {
  const crumb = document.getElementById('crumb')
  const topbar = document.querySelector('.topbar')
  const lead = document.querySelector('.topbar__lead')
  if (!crumb || !topbar || !lead) return
  if (isMobile()) {
    const navBtn = document.getElementById('nav-toggle')
    if (crumb.parentElement !== topbar || crumb.previousElementSibling !== navBtn) {
      topbar.insertBefore(crumb, navBtn ? navBtn.nextSibling : topbar.firstChild)
    }
  } else if (crumb.parentElement !== lead || crumb !== lead.firstElementChild) {
    lead.insertBefore(crumb, lead.firstElementChild)
  }
}

let currentPageId = null
function render() {
  const r = route()
  // Leaving the page being customized exits customize, which re-renders.
  if (customizing && (r.name === 'settings' || r.sub || r.def.id !== currentPageId)) { setCustomizing(false); return }
  if (printing && (r.name !== 'page' || r.sub || r.def.id !== 'equations')) { setPrinting(false); return }
  closeModal() // a modal must not outlive the page it was opened over
  document.documentElement.dataset.page = r.name === 'settings' ? 'settings' : r.sub ? `${r.def.id}-${r.sub}` : r.def.id
  renderNav(r)
  renderPageTabs(r)
  placeCrumb() // keep the breadcrumb in its breakpoint-correct home each render
  const content = document.getElementById('content')
  if (r.name === 'settings') {
    const label = SETTINGS_TABS.find(([t]) => t === r.tab)[1]
    setHead('Settings', `Atlas / Settings / ${label}`)
    content.innerHTML = r.tab === 'appearance' ? `<div class="page">${themeSettingsHTML()}</div>`
      : r.tab === 'plugins' ? `<div class="page page--plugins">${pluginsSettingsHTML()}</div>`
      : accountsHTML()
    if (r.tab === 'accounts') { precomputeClaudeOAuth(); primeGoogleConfig(); refreshGoogleView() } // ready URLs for a synchronous window.open
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
    setHead(r.def.label, printing ? `${r.def.crumb} / Print sheet` : r.def.crumb)
    // Mobile keeps its own per-page board, seeded once (see starterFor): the
    // dashboard clones the user's current desktop layout, every other plugin
    // gets its app-default starter — then it diverges and CSS stacks it.
    const page = isMobile() ? loadPageMobile(r.def.storageKey, () => starterFor(r.def)) : loadPage(r.def.storageKey)
    // Empty state also when every widget on the board belongs to a disabled
    // plugin — otherwise the page renders as unexplained blank space.
    if (printing) renderPrintSheet(content, { page, onDone: () => setPrinting(false) })
    else if ((!page.rows.length || pageHasHiddenAll(page)) && !customizing) content.innerHTML = emptyDash(r.def)
    else {
      const anchor = captureScrollAnchor(content)
      // The key must name the board actually on screen: `page` above came from
      // the .mobile key on a phone, and view.js's drawChart re-reads the model
      // by this key to find each chart's widget. Passing the desktop key there
      // meant every chart lookup missed on mobile and silently drew nothing —
      // same trap customize.js documents at pageNow().
      renderPageInto(content, page, customizing, pageKeyFor(r.def.storageKey))
      restoreScrollAnchor(content, anchor)
    }
  }
  const cbtn = document.getElementById('customize')
  if (cbtn) cbtn.style.display = (r.name === 'page' && r.def.full) || printing ? 'none' : ''
  // The math keyboard toggle only exists on the pages that mount math-fields;
  // leaving one hides both the toggle and the keyboard itself.
  const mkbtn = document.getElementById('mathkbd-toggle')
  if (mkbtn) {
    // Mobile never gets the virtual math keyboard (native Apple keyboard only).
    const allowed = MATHKBD_PAGES.has(r.def?.id) && !isMobile() && !printing // the workbench mounts no math-fields
    mkbtn.style.display = allowed ? '' : 'none'
    if (!allowed) window.mathVirtualKeyboard.hide()
  }
  // Print sheet: only the equations board itself, only on desktop.
  const pbtn = document.getElementById('eqprint-toggle')
  if (pbtn) pbtn.style.display = r.name === 'page' && !r.sub && r.def?.id === 'equations' && !isMobile() ? '' : 'none'
}

document.body.addEventListener('click', (e) => {
  // Mobile drawer: the hamburger toggles it; the scrim closes it; tapping a
  // nav item closes it too (then falls through to normal <a> navigation).
  if (e.target.closest('#nav-toggle')) { document.body.classList.toggle('nav-open'); return }
  if (e.target.classList.contains('nav-scrim')) { document.body.classList.remove('nav-open'); return }
  if (e.target.closest('.nav__item')) document.body.classList.remove('nav-open')
  const act = e.target.closest('[data-act]')
  if (act) {
    // main.js owns the sign-out (clears the auth key, then reloads); it also
    // resolves fine offline, where sync.request rejects instead of hanging.
    if (act.dataset.act === 'logout') { window.atlasLogout?.(); return }
    if (act.dataset.act === 'customize') { setCustomizing(!customizing); return }
    if (act.dataset.act === 'toggle-mathkbd') { setKbEnabled(!kbEnabled); return }
    if (act.dataset.act === 'toggle-eqprint') { setPrinting(!printing); return }
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
    // Custom is a workspace, not a setting — eight colours, a wheel and a
    // slider don't belong in a settings row.
    if (act.dataset.act === 'theme-preset' && act.dataset.preset === CUSTOM) {
      openThemeModal(openModal, closeModal, render)
      return
    }
    if (act.dataset.act === 'theme-preset' || act.dataset.act === 'theme-mode') {
      const t = loadTheme()
      if (act.dataset.mode) t.mode = act.dataset.mode
      else t.preset = act.dataset.preset
      saveTheme(t)
      applyTheme(t)
      render()
      return
    }
    if (act.dataset.act === 'export-data') { exportData(); return }
    if (act.dataset.act === 'import-data') { document.getElementById('import-file')?.click(); return }
    if (act.dataset.act === 'ai-oauth-start') {
      // Open Claude's consent page (the native shell routes window.open to the
      // system browser), then reveal the paste-the-code field. The URL is
      // precomputed on render (precomputeClaudeOAuth) so window.open fires
      // SYNCHRONOUSLY on the click — iOS discards a window.open that follows an
      // await. Only if the precompute hasn't landed yet do we fall back to the
      // async path (which won't open the browser on iOS, but is the desktop
      // behaviour and a rare miss on mobile).
      if (claudeOAuthStash) {
        window.open(claudeOAuthStash.url)
        claudeOAuthAwaiting = true
        document.getElementById('ai-oauth')?.removeAttribute('hidden')
        return
      }
      act.disabled = true
      beginClaudeOAuth()
        .then((res) => {
          claudeOAuthStash = res
          window.open(res.url)
          claudeOAuthAwaiting = true
          document.getElementById('ai-oauth')?.removeAttribute('hidden')
        })
        .catch(() => {})
        .finally(() => { act.disabled = false })
      return
    }
    if (act.dataset.act === 'ai-oauth-finish') {
      const code = document.getElementById('ai-oauth-code')?.value.trim()
      const err = document.getElementById('ai-oauth-err')
      if (err) err.textContent = ''
      if (!code) return
      act.disabled = true
      completeClaudeOAuth(code)
        .then((ok) => {
          if (ok) { claudeOAuthAwaiting = false; claudeOAuthStash = null; render() }
          else { act.disabled = false; if (err) err.textContent = 'That code didn’t work — try again.' }
        })
        .catch((e) => { act.disabled = false; if (err) err.textContent = e?.message || 'Couldn’t connect. Try again.' })
      return
    }
    if (act.dataset.act === 'ai-disconnect') { claudeOAuthAwaiting = false; claudeOAuthStash = null; disconnectClaude(); render(); return }
  }
  if (customizing) return
  const r = route()
  const card = e.target.closest('.pwidget--card, .pwidget--eqcard')
  if (!card || r.name !== 'page') return
  const f = findWidget(loadPage(pageKeyFor(r.def.storageKey)), card.dataset.widgetId)
  if (!f) return
  // Cards show their full text; equation cards show the equation large.
  if (f.widget.kind === 'eqcard') openModal(f.widget.title, `<div class="modal__math">${renderMath(f.widget.latex)}</div>`)
  else openModal(f.widget.title, esc(f.widget.text))
})

// The backup file picker (change bubbles, so this catches the re-rendered input).
document.body.addEventListener('change', (e) => {
  if (e.target.id === 'import-file' && e.target.files?.length) {
    importData(e.target.files[0])
    e.target.value = '' // let the same file be re-picked if the user retries
    return
  }
})

// One-time cleanup of the pre-rebuild data model (widget-of-blocks + sizes).
localStorage.removeItem('atlas.customWidgets.v2')
localStorage.removeItem('atlas.widgetSize.v2')

// The Google connection lives server-side and is shared across this user's
// devices; refresh the local connected/address cache from the backend, then
// re-render so Settings/Email/Calendar reflect the true state.
// Calling this once here is a RACE we usually lose: sync.request rejects
// outright when the inbox socket isn't OPEN yet (sync.js), and on a cold launch
// it isn't — the WS still has a tunnel + TLS handshake to finish. The rejection
// is swallowed, so every Google page kept showing "Connect" for the whole
// session. Drive it off sync's own status instead, which fires when the socket
// is genuinely usable and again on every reconnect (sleep/wake, network change).
refreshGoogleView() // warm socket (in-app reload) can still win here
sync.onStatus((s) => { if (s === 'online') refreshGoogleView() })

// Notes folder <-> server convergence, while the notes page is on screen.
startNotesSyncLoop()

bindGym(render) // gym logging / complete / exercise-modal delegation (view mode)
bindCanvas() // canvas widget interactions (course pills, filters, dismissals)
bindWork(render) // work widget interactions (shifts, income range, tip share)
bindSleep(render) // sleep widget interactions (log nights/naps, quality stars, delete)
bindFormal(render) // formal widget interactions (rooms, bed drag/drop, fit-check slider)
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
const SLEEP_STARTER = { v: 1, rows: [
  { id: 'r-sl1', cols: [
    { id: 'c-sl1', width: 1.4, sections: [{ id: 's-sl1', lines: [{ id: 'l-sl1', widgets: [{ id: 'w-sllog', kind: 'sllog' }] }] }] },
    { id: 'c-sl2', sections: [{ id: 's-sl2', lines: [{ id: 'l-sl2', widgets: [{ id: 'w-slbed', kind: 'slbedtime' }] }] }] } ] },
  { id: 'r-sl2', title: 'Trends', cols: [
    { id: 'c-sl3', sections: [{ id: 's-sl3', lines: [{ id: 'l-sl3', widgets: [{ id: 'w-slhrs', kind: 'slhours' }] }] }] },
    { id: 'c-sl4', sections: [{ id: 's-sl4', lines: [{ id: 'l-sl4', widgets: [{ id: 'w-sldbt', kind: 'sldebt' }] }] }] } ] },
] }
const FORMAL_STARTER = { v: 1, rows: [
  { id: 'r-fm1', cols: [
    { id: 'c-fm1', sections: [{ id: 's-fm1', lines: [{ id: 'l-fm1', widgets: [{ id: 'w-fmh', kind: 'fmhouses', house: { name: '', link: '', price: 0, couches: 0, rooms: [{ id: 'fr-fm1', beds: { king: 0, queen: 0, full: 0, twin: 0, futon: 0 } }] } }] }] }] } ] },
] }
// Gym's board layout lives in the same starter map as the others so the mobile
// seedFn can seed a fresh Gym board from it too. (It used to also be seeded by
// the gym import seed, which is gone — see the note further down.)
const GYM_STARTER = { v: 1, rows: [
  { id: 'r-gym1', title: 'Today', cols: [
    { id: 'c-gym1', width: 1.4, sections: [{ id: 's-gym1', lines: [{ id: 'l-gym1', widgets: [{ id: 'w-gymcur', kind: 'gymcurrent' }] }] }] },
    { id: 'c-gym2', sections: [
      { id: 's-gym2', title: 'Coming up', lines: [{ id: 'l-gym2', widgets: [{ id: 'w-gymnext1', kind: 'gymnext' }] }, { id: 'l-gym3', widgets: [{ id: 'w-gymnext2', kind: 'gymnext' }] }] },
      { id: 's-gym3', lines: [{ id: 'l-gym4', widgets: [{ id: 'w-gymscore', kind: 'gymscore' }, { id: 'w-gymvol', kind: 'gymvolume' }] }] }] }] },
  { id: 'r-gym2', title: 'Progress', cols: [
    { id: 'c-gym3', sections: [{ id: 's-gym4', lines: [{ id: 'l-gym5', widgets: [{ id: 'w-gymex', kind: 'gymexercises' }, { id: 'w-gymgraph', kind: 'gymscoregraph' }] }] }] }] },
] }
// App-default starter boards keyed by page id — the single source used by both
// seedStarters (desktop first-run) and the mobile seedFn (starterFor) below.
const STARTERS = { gym: GYM_STARTER, canvas: CANVAS_STARTER, work: WORK_STARTER, sleep: SLEEP_STARTER, formal: FORMAL_STARTER }
// The mobile board seed for a page: the dashboard clones the user's CURRENT
// desktop dashboard once; every other page-model plugin gets its app-default
// starter; anything without one (e.g. Equations) falls back to cloning the
// desktop board. loadPageMobile deep-clones whatever this returns before
// storing, so handing back the shared STARTERS object (or a live loadPage
// result) is safe.
const starterFor = (def) =>
  def.id === 'dashboard' ? loadPage(def.storageKey) : (STARTERS[def.id] || loadPage(def.storageKey))
// First visit to an ENABLED plugin's board page gets its ready-made starter
// (key absent = never seeded; an intentionally emptied board stays empty).
// Runs at boot and again whenever a plugin is enabled in Settings, so a
// freshly-enabled plugin lands with a usable board instead of a blank page.
// The work one-time appends live here too: gated on work being on, so their
// flags can't burn before the board exists.
function seedStarters() {
  const seed = (id, key) => {
    if (isPluginEnabled(id) && !localStorage.getItem(key) && STARTERS[id]) localStorage.setItem(key, JSON.stringify(STARTERS[id]))
  }
  seed('canvas', 'atlas.page.canvas.v1')
  seed('work', 'atlas.page.work.v1')
  seed('sleep', 'atlas.page.sleep.v1')
  seed('formal', 'atlas.page.formal.v1')
  // One-time appends for work boards seeded before these widgets existed.
  // Flag-guarded so deleting the widget later sticks.
  if (isPluginEnabled('work')) {
    for (const [flag, kind, row] of [
      ['atlas.work.upseeded', 'wkupcoming', { id: 'r-wkup', cols: [{ id: 'c-wkup', sections: [{ id: 's-wkup', lines: [{ id: 'l-wkup', widgets: [{ id: 'w-wkup2', kind: 'wkupcoming' }] }] }] }] }],
      ['atlas.work.histseeded', 'wkhistory', { id: 'r-wkhist', cols: [{ id: 'c-wkhist', sections: [{ id: 's-wkhist', lines: [{ id: 'l-wkhist', widgets: [{ id: 'w-wkhist2', kind: 'wkhistory' }] }] }] }] }],
    ]) {
      if (localStorage.getItem(flag)) continue
      try {
        const p = JSON.parse(localStorage.getItem('atlas.page.work.v1'))
        if (p?.rows?.length && !JSON.stringify(p).includes(`"${kind}"`)) {
          p.rows.push(row)
          localStorage.setItem('atlas.page.work.v1', JSON.stringify(p))
        }
      } catch { /* corrupted board — leave it to loadPage's normalizer */ }
      localStorage.setItem(flag, '1')
    }
  }
}
// Formal was retired from the app on 2026-08-12 and brought back on 2026-08-16
// with its data left untouched throughout. A profile that still holds that data
// gets the plugin switched back on the first time a build with formal in the
// registry sees it — otherwise the houses are there but the page is not.
// Guarded on the KEY's presence, not a truthy value, so flipping it off in
// Settings sticks. Runs again after hydration because a cold cache has none of
// these keys until the server's copy lands.
function restoreFormal() {
  if ('formal' in loadPlugins().enabled) return
  if (localStorage.getItem('atlas.formal.v1') || localStorage.getItem('atlas.page.formal.v1')) setPluginEnabled('formal', true)
}
restoreFormal()
seedStarters()
window.addEventListener('atlas:hydrated', () => { restoreFormal(); seedStarters() })
// One-time: houses entered under the original shared-store design move onto
// the widgets themselves (one house per widget). Data-less House widgets on
// the formal board adopt the legacy houses in order; leftovers get their own
// rows.
//
// Flag-guarded, exactly like the work one-time appends above — and NOT, as it
// was, self-disabling on `houses` having been stripped. That strip is a second
// independent setItem, and it only really disables this block if it lands
// server-side too. When it didn't, the server kept handing `houses` back on
// every pull and this ran again on every single launch, re-inserting a
// `w-fmmig*` House widget the user had deliberately deleted. That is the
// "deleting a widget in Formal doesn't persist" bug: the delete saved fine,
// and then this put a fresh copy back. The strip below stays (it keeps the
// store tidy); the flag is what makes the migration actually one-time.
const FORMAL_HOUSES_MIGRATED = 'atlas.formal.housesMigrated'
if (!localStorage.getItem(FORMAL_HOUSES_MIGRATED)) try {
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
  // Set even when there was nothing to migrate: a corrupt or house-less store
  // is still a finished migration, and retrying it forever is the whole bug.
  localStorage.setItem(FORMAL_HOUSES_MIGRATED, '1')
} catch { localStorage.setItem(FORMAL_HOUSES_MIGRATED, '1') /* corrupted legacy store — nothing to migrate */ }
bindPlugins(render, seedStarters) // Settings → Plugins toggles + zip install
// The one-time import seeds (gym / course / equations, added 2026-08-10 to
// carry data over from the pre-monorepo Atlas) are GONE, and deliberately.
//
// They fetched a fixture from public/ whenever the matching store looked empty
// and wrote it straight into localStorage — which the sync hook then pushed. On
// any device that booted with an empty store they raced the server pull and
// won every time: bootApp() imports this module (starting the fetch) BEFORE
// hydrateInBackground() even begins, and a 6KB local file always beats a
// WebSocket round trip. The gym one did a full setItem replace, so it
// overwrote the server's real gym blob with a fixture holding 0 logs,
// 0 completions and cycle position 0 — destroying logged workout history.
// Confirmed against the live database: the account's workouts were the
// fixture's own gw-import1..7 ids, with every log and completion gone.
//
// The migration they existed for finished on 2026-08-10. Re-running one could
// only ever destroy newer data, so the fixtures were deleted from public/ too.
// ponytail: if a future import is needed, it must run AFTER the first pull
// resolves and must merge rather than replace.
// Navigating closes the mobile drawer (a same-route nav tap is handled in the
// click delegate; this catches every other route change) before re-rendering.
window.addEventListener('hashchange', () => { document.body.classList.remove('nav-open'); render() })
// A plugin toggled, or the nav reordered, on another device syncs in live —
// re-render so the nav and gates follow immediately. Scoped to these two
// keys only: a blanket re-render on every synced write would drop input
// focus mid-typing.
window.addEventListener('atlas:sync-update', (e) => {
  if (e.detail?.key === 'atlas.plugins.v1' || e.detail?.key === 'atlas.navOrder.v1') render()
})
// Warm-cache boot paints from the local copy, then the server's state lands a
// moment later — re-render once so anything changed on another device appears
// without a manual reload.
window.addEventListener('atlas:hydrated', render)
// Ready the Google auth URL early so a Connect tap can open the system browser
// on the same tick (an await between tap and window.open is dropped by iOS).
window.addEventListener('atlas:hydrated', () => { primeGoogleConfig() })
// Cached remote data landed for a plugin the user is already looking at.
window.addEventListener('atlas:prefetched', render)
if (!location.hash) location.replace('#/dashboard')
// Stamp <body> with is-mobile / is-native-ios now (before first paint) and
// re-render whenever the viewport crosses the 820px breakpoint, so page-model
// pages swap to (or back from) their mobile board and the drawer chrome.
initPlatform(render)
render()
// Let first-load entrance animations finish, then disable replays on re-render.
setTimeout(() => document.documentElement.classList.add('ready'), 750)
// Pull each enabled plugin's remote data in the background, a couple at a time,
// so Canvas and Mail are already populated when they are opened.
startPrefetch(isPluginEnabled)
