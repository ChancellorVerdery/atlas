// App shell: router, sidebar nav, dashboard (the page of widgets), settings,
// and the topbar title/crumb. Two routes only — everything renders from here.
// Customize mode (src/page/customize.js) live-edits the page in place.

import { loadPage, findWidget, uid } from './page/model.js'
import { renderPageInto, observeCharts, renderMath, fitEquations, pageHasHiddenAll } from './page/view.js'
import { enterCustomize, exitCustomize, paletteHTML } from './page/customize.js'
import { PAGES, pageById, activePages, saveNavOrder } from './page/pages.js'
import { isPluginEnabled } from './page/plugins.js'
import { startPrefetch } from './page/prefetch.js'
import { pluginsSettingsHTML, bindPlugins } from './page/pluginsui.js'
import { bindGym, renderGymSettings } from './page/gymui.js'
import { renderEmailPage } from './page/emailui.js'
import { renderCalendarPage } from './page/calendarui.js'
import { bindCanvas, renderCanvasSettings } from './page/canvasui.js'
import { bindWork, renderWorkSettings } from './page/workui.js'
import { renderLadderPage, renderLadderSettings } from './page/ladderui.js'
import { bindSleep, renderSleepSettings } from './page/sleepui.js'
import { renderCoursePage, renderCourseMap, renderCourseSettings } from './page/courseui.js'
import { renderNotesPage } from './page/notesui.js'
import { renderStudyPage } from './page/studyui.js'
import { renderFlashcardsPage } from './page/flashcardsui.js'
import { loadEmail, isConnected, connectGmail, disconnectGmail, refreshGoogleStatus } from './page/email.js'
import { PRESETS, CUSTOM, loadTheme, saveTheme, applyTheme, resolve, logoDataURL } from './page/theme.js'
import { openThemeModal } from './page/themeui.js'
import { loadAI, saveAI, connectedProviders, isProviderConnected, maskKey } from './page/ai.js'

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
let kbEnabled = false
const isMathField = (el) => !!el?.closest?.('math-field')
function setKbEnabled(on) {
  if (kbEnabled === on) return
  kbEnabled = on
  document.getElementById('mathkbd-toggle')?.classList.toggle('is-active', on)
  if (on) { if (isMathField(document.activeElement)) window.mathVirtualKeyboard.show() }
  else window.mathVirtualKeyboard.hide()
}
document.addEventListener('focusin', (e) => {
  if (kbEnabled && isMathField(e.target)) window.mathVirtualKeyboard.show()
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
{
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
      <span class="set-row__sub">Applies everywhere — pages, widgets, the logo, and the app icon. Custom sets the scheme's own colours; light mode uses its own surfaces and keeps the accent.</span>
    </div>
    <div class="set-theme">
      <div class="set-theme__row">
        <span class="set-theme__modes">${mode('dark', 'Dark')}${mode('light', 'Light')}</span>
        <img class="set-theme__logo" src="${esc(logoDataURL(t))}" alt="" width="40" height="40">
      </div>
      <div class="set-theme__presets">
        ${Object.entries(PRESETS).map(([id, p]) => swatch(id, p)).join('')}
        ${swatch(CUSTOM, {
          label: 'Custom…',
          panel: t.custom[t.mode === 'light' ? 'lightPanel' : 'darkPanel'],
          accent: t.custom.accent, signal: t.custom.signal,
        })}
      </div>
    </div>
  </div>`
}

// AI connections: which providers this device holds a key for, a
// primary/secondary preference, and per-capability overrides. Storage lives
// in page/ai.js; this just renders + wires it, same split as theme.js/themeui.js.
const AI_PROVIDER_LABEL = { claude: 'Claude', openai: 'OpenAI' }
const aiProviderOptions = (connected, value, noneLabel) =>
  `<option value="">${esc(noneLabel)}</option>` +
  connected.map((id) => `<option value="${id}"${value === id ? ' selected' : ''}>${esc(AI_PROVIDER_LABEL[id])}</option>`).join('')

const aiConnectionsHTML = () => {
  const s = loadAI()
  const connected = connectedProviders(s)
  const providerRow = (id, label) => {
    const on = isProviderConnected(id, s)
    const key = s.providers[id]?.apiKey
    // Claude offers OAuth too, but there's no registered OAuth client to send
    // users through yet — stub it rather than block on it; the API key path
    // below is the one that actually works today.
    // ponytail: swap this for a real "Connect with Claude" OAuth flow once
    // Atlas has somewhere to register a client id / redirect URI.
    const oauthBtn = id === 'claude'
      ? `<button type="button" class="gym-btn gym-btn--ghost" disabled title="Not wired up yet — connect with an API key below.">Connect with Claude (coming soon)</button>`
      : ''
    return `<div class="ai-conn__row">
      <div class="ai-conn__meta">
        <span class="ai-conn__name">${esc(label)}</span>
        <span class="ai-conn__status${on ? '' : ' ai-conn__status--off'}">${on ? `Connected ${esc(maskKey(key))}` : 'Not connected'}</span>
      </div>
      <div class="ai-conn__actions">
        ${on
          ? `<button type="button" class="gym-btn gym-btn--ghost" data-act="ai-disconnect" data-provider="${id}">Disconnect</button>`
          : `<input type="password" class="pw-field ai-conn__field" id="ai-key-${id}" placeholder="API key" autocomplete="off" spellcheck="false">
             <button type="button" class="gym-btn" data-act="ai-connect" data-provider="${id}">Connect</button>`}
        ${oauthBtn}
      </div>
    </div>`
  }
  return `<div class="set-row set-row--ai">
    <div class="set-row__meta">
      <span class="set-row__name">AI connections</span>
      <span class="set-row__sub">Connect Claude and/or OpenAI, then choose a primary (and optional secondary), or override which one Studying and Notes use. Keys stay on this device — they never sync to the Atlas server.</span>
    </div>
    <div class="ai-conn">
      ${providerRow('claude', 'Claude')}
      ${providerRow('openai', 'OpenAI')}
      <div class="ai-conn__prefs${connected.length ? '' : ' is-disabled'}">
        <label class="ai-conn__pref">Primary
          <select class="pw-field pw-field--select" data-act="ai-primary"${connected.length ? '' : ' disabled'}>${aiProviderOptions(connected, s.primary, 'None')}</select>
        </label>
        <label class="ai-conn__pref">Secondary
          <select class="pw-field pw-field--select" data-act="ai-secondary"${connected.length ? '' : ' disabled'}>${aiProviderOptions(connected, s.secondary, 'None')}</select>
        </label>
        <label class="ai-conn__pref">Studying
          <select class="pw-field pw-field--select" data-act="ai-cap" data-cap="study"${connected.length ? '' : ' disabled'}>${aiProviderOptions(connected, s.perCapability.study, 'Use primary')}</select>
        </label>
        <label class="ai-conn__pref">Notes
          <select class="pw-field pw-field--select" data-act="ai-cap" data-cap="notes"${connected.length ? '' : ' disabled'}>${aiProviderOptions(connected, s.perCapability.notes, 'Use primary')}</select>
        </label>
      </div>
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
    const label = SETTINGS_TABS.find(([t]) => t === r.tab)[1]
    setHead('Settings', `Atlas / Settings / ${label}`)
    content.innerHTML = r.tab === 'appearance' ? `<div class="page">${themeSettingsHTML()}</div>`
      : r.tab === 'plugins' ? `<div class="page page--plugins">${pluginsSettingsHTML()}</div>`
      : accountsHTML()
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
    // Empty state also when every widget on the board belongs to a disabled
    // plugin — otherwise the page renders as unexplained blank space.
    if ((!page.rows.length || pageHasHiddenAll(page)) && !customizing) content.innerHTML = emptyDash(r.def)
    else {
      const anchor = captureScrollAnchor(content)
      renderPageInto(content, page, customizing, r.def.storageKey)
      restoreScrollAnchor(content, anchor)
    }
  }
  const cbtn = document.getElementById('customize')
  if (cbtn) cbtn.style.display = r.name === 'page' && r.def.full ? 'none' : ''
}

document.body.addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')
  if (act) {
    // main.js owns the sign-out (clears the auth key, then reloads); it also
    // resolves fine offline, where sync.request rejects instead of hanging.
    if (act.dataset.act === 'logout') { window.atlasLogout?.(); return }
    if (act.dataset.act === 'customize') { setCustomizing(!customizing); return }
    if (act.dataset.act === 'toggle-mathkbd') { setKbEnabled(!kbEnabled); return }
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
    if (act.dataset.act === 'ai-connect') {
      const id = act.dataset.provider
      const input = document.getElementById(`ai-key-${id}`)
      const key = input?.value.trim()
      if (!key) return
      const s = loadAI()
      s.providers[id] = { ...s.providers[id], apiKey: key }
      if (!s.primary) s.primary = id // first connected provider becomes primary by default
      saveAI(s)
      render()
      return
    }
    if (act.dataset.act === 'ai-disconnect') {
      const id = act.dataset.provider
      const s = loadAI()
      s.providers[id] = {}
      if (s.primary === id) s.primary = null
      if (s.secondary === id) s.secondary = null
      if (s.perCapability.study === id) s.perCapability.study = null
      if (s.perCapability.notes === id) s.perCapability.notes = null
      saveAI(s)
      render()
      return
    }
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

// Live accent preview: the picker fires this continuously while dragging, so
// apply without saving or re-rendering — a rerender would close the picker.
// The backup file picker (change bubbles, so this catches the re-rendered input).
document.body.addEventListener('change', (e) => {
  if (e.target.id === 'import-file' && e.target.files?.length) {
    importData(e.target.files[0])
    e.target.value = '' // let the same file be re-picked if the user retries
    return
  }
  const act = e.target.dataset.act
  if (act === 'ai-primary' || act === 'ai-secondary' || act === 'ai-cap') {
    const s = loadAI()
    const val = e.target.value || null
    if (act === 'ai-primary') s.primary = val
    else if (act === 'ai-secondary') s.secondary = val
    else s.perCapability[e.target.dataset.cap] = val
    saveAI(s)
    render()
  }
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
bindSleep(render) // sleep widget interactions (log nights/naps, quality stars, delete)
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
// First visit to an ENABLED plugin's board page gets its ready-made starter
// (key absent = never seeded; an intentionally emptied board stays empty).
// Runs at boot and again whenever a plugin is enabled in Settings, so a
// freshly-enabled plugin lands with a usable board instead of a blank page.
// The work one-time appends live here too: gated on work being on, so their
// flags can't burn before the board exists.
function seedStarters() {
  const seed = (id, key, starter) => {
    if (isPluginEnabled(id) && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(starter))
  }
  seed('canvas', 'atlas.page.canvas.v1', CANVAS_STARTER)
  seed('work', 'atlas.page.work.v1', WORK_STARTER)
  seed('sleep', 'atlas.page.sleep.v1', SLEEP_STARTER)
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
seedStarters()
bindPlugins(render, seedStarters) // Settings → Plugins toggles + zip install
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
// ponytail: import seeds only run while their plugin is on at boot — enabling
// one later picks the import up on the next reload, which is fine for a
// one-time convenience path.
if (isPluginEnabled('gym')) {
  if (gymStoreEmpty()) {
    fetch('/gym-import.json').then((r) => (r.ok ? r.json() : null)).then((g) => {
      if (g && gymStoreEmpty()) {
        localStorage.setItem('atlas.gym.v1', JSON.stringify(g))
        seedGymLayout()
        render()
      }
    }).catch(() => {})
  } else seedGymLayout()
}

// Same one-time seed for the Course Planner: with no classes yet, adopt a
// served course list (e.g. a degree checksheet import). Non-destructive —
// keeps any terms/settings already present; the empty-store check makes it
// self-disabling once classes exist.
const courseStoreEmpty = () => {
  try { const c = JSON.parse(localStorage.getItem('atlas.course.v1')); return !c || !c.courses?.length } catch { return true }
}
if (isPluginEnabled('course') && courseStoreEmpty()) {
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
if (isPluginEnabled('equations') && localStorage.getItem(EQ_IMPORT_FLAG) === null) {
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
// Cached remote data landed for a plugin the user is already looking at.
window.addEventListener('atlas:prefetched', render)
if (!location.hash) location.replace('#/dashboard')
render()
// Let first-load entrance animations finish, then disable replays on re-render.
setTimeout(() => document.documentElement.classList.add('ready'), 750)
// Pull each enabled plugin's remote data in the background, a couple at a time,
// so Canvas and Mail are already populated when they are opened.
startPrefetch(isPluginEnabled)
