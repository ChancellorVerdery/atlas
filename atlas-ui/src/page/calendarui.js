// Calendar plugin — the page (month / week / day views) and two dashboard
// widgets (agenda + view-only mini month). Widgetless-style full window like
// Email, sharing the same Google connection. All mutations hit the real
// Google Calendar API; recurring instances arrive expanded from the server.

import { loadEmail, saveEmail, isConnected, connectGmail, AuthError } from './email.js'
import { cachedValue, writeCache } from './datacache.js'
import {
  loadCal, saveCal, listCalendars, listEvents, getEvent, createEvent, patchEvent,
  deleteEvent, respondToEvent, tz, dateStr, parseDateLocal, addDays, startOfDay,
  startOfWeek, sameDay, evStart, evEnd, isAllDay, RRULE_DAYS, DAY_NAMES,
  buildRRule, describeRRule, nthWeekdayOf, rruleSetUntil,
  rruleByDays, rruleSetByDay, firstWeekdayOnOrAfter,
} from './calendar.js'

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Event descriptions can be HTML — often a whole Outlook/Exchange document
// (<html><head>…<body>…). Escaping it dumps the raw tags on screen; injecting
// it raw is unsafe AND its inline colors (e.g. color:rgb(0,0,0)) go invisible
// on the dark theme. So: parse, strip scripts + all presentational attributes,
// and render just the readable body.
const NOTES_HTML = /<[a-z!/][\s\S]*>/i
const PRESENTATIONAL = /^(on|style|class|color|bgcolor|background|align|valign|width|height|face|dir|lang)/i
function cleanNotes(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('script,iframe,object,embed,link,meta,style,form,title,base,noscript').forEach((n) => n.remove())
  for (const n of doc.body.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      if (PRESENTATIONAL.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name)
    }
  }
  return doc.body
}
// HTML for the view modal (sanitized, theme-safe); plain text otherwise.
function renderNotes(desc) {
  if (!NOTES_HTML.test(desc)) return esc(desc).replace(/\n/g, '<br>')
  return cleanNotes(desc).innerHTML.trim() || esc(desc)
}
// Plain text for the editor textarea — so you edit "Fretwell 306", not markup.
function notesToText(desc) {
  if (!NOTES_HTML.test(desc)) return desc
  const body = cleanNotes(desc)
  body.querySelectorAll('br').forEach((n) => n.replaceWith('\n'))
  body.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6').forEach((n) => n.append('\n'))
  return body.textContent.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const I = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const ICON = {
  panel: I('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>'),
  prev: I('<path d="m14 6-6 6 6 6"/>'),
  next: I('<path d="m10 6 6 6-6 6"/>'),
  cal: I('<rect x="3" y="5" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/>'),
}

const HOUR_PX = 44
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

const st = {
  view: 'month', cursor: startOfDay(new Date()),
  cals: [], events: [], loading: false, seq: 0,
}
let rootEl = null
let rerenderApp = null
let edCtx = null

const q = (sel) => rootEl?.querySelector(sel)
const hiddenCals = () => loadCal().hiddenCals
const visibleCals = () => st.cals.filter((c) => !hiddenCals().includes(c.id))

const pad = (n) => String(n).padStart(2, '0')
const fmtTime = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const shortTime = (d) => {
  const h = d.getHours() % 12 || 12
  return `${h}${d.getMinutes() ? ':' + pad(d.getMinutes()) : ''}${d.getHours() < 12 ? 'a' : 'p'}`
}
const fmtDay = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })

// ---- entry -----------------------------------------------------------------

export function renderCalendarPage(root, rerender) {
  rootEl = root
  rerenderApp = rerender
  st.seq++
  const s = loadEmail()
  if (!isConnected(s)) { renderConnect(s); return }
  const cs = loadCal()
  st.view = cs.view
  st.cursor = startOfDay(new Date())
  root.innerHTML = `
    <div class="cal">
      <div class="cal-top">
        <button type="button" class="mail-iconbtn" data-cal="toggle-nav" title="Show or hide calendars" aria-label="Show or hide calendars">${ICON.panel}</button>
        <button type="button" class="mail-btn mail-btn--ghost" data-cal="today">Today</button>
        <button type="button" class="mail-iconbtn" data-cal="prev" title="Previous" aria-label="Previous">${ICON.prev}</button>
        <button type="button" class="mail-iconbtn" data-cal="next" title="Next" aria-label="Next">${ICON.next}</button>
        <span class="cal-top__label" id="cal-label"></span>
        <nav class="cal-views">
          ${['month', 'week', 'day'].map((v) => `<button type="button" class="cal-view-pill" data-cal-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}
        </nav>
        <button type="button" class="mail-btn mail-btn--primary" data-cal="new">New event</button>
      </div>
      <div class="cal-body${cs.navHidden ? ' nav-hidden' : ''}">
        <aside class="cal-nav" id="cal-nav"><p class="mail-nav__head">Calendars</p></aside>
        <section class="cal-grid" id="cal-grid"><p class="mail-list__empty">Loading…</p></section>
      </div>
    </div>`
  root.onclick = onClick
  renderToolbar()
  loadAll()
}

function renderConnect(s) {
  const expired = !!s.address
  rootEl.innerHTML = `
    <div class="mail-connect">
      <div class="mail-connect__mark">${ICON.cal}</div>
      <h2 class="mail-connect__title">${expired ? 'Reconnect Google' : 'Connect Google Calendar'}</h2>
      <p class="mail-connect__text">${expired
        ? `The session for <strong>${esc(s.address)}</strong> has expired (or hasn't granted calendar access yet). Reconnect to sync.`
        : 'Uses the same Google connection as Email — one sign-in grants both. Your credentials stay on the Atlas server.'}</p>
      <button type="button" class="mail-btn mail-btn--primary" data-cal="connect">${expired ? 'Reconnect' : 'Connect Google'}</button>
      <p class="mail-connect__err" id="cal-connect-err"></p>
    </div>`
  rootEl.onclick = (e) => {
    if (!e.target.closest('[data-cal="connect"]')) return
    connectGmail().then(() => rerenderApp()).catch((err) => {
      const el = document.getElementById('cal-connect-err')
      if (el) el.textContent = err.message
    })
  }
}

// ---- data flow ----------------------------------------------------------------

async function guard(fn) {
  try { await fn() } catch (err) {
    if (err instanceof AuthError) {
      // Server-side token lapsed/revoked: flip the local cache to disconnected
      // (keep address for the expired-session splash).
      const s = loadEmail()
      s.connected = false
      saveEmail(s)
      rerenderApp()
      return
    }
    toast(err.message || String(err))
  }
}

function toast(msg, ok = false) {
  rootEl?.querySelector('.mail-toast')?.remove()
  const t = document.createElement('div')
  t.className = 'mail-toast' + (ok ? ' mail-toast--ok' : '')
  t.textContent = msg
  rootEl?.appendChild(t)
  setTimeout(() => t.remove(), ok ? 2200 : 6000)
}

function rangeFor(view, cursor) {
  if (view === 'month') {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1)
    const min = startOfWeek(first)
    return { min, max: addDays(min, 42) }
  }
  if (view === 'week') { const min = startOfWeek(cursor); return { min, max: addDays(min, 7) } }
  return { min: startOfDay(cursor), max: addDays(startOfDay(cursor), 1) }
}

const CAL_CACHE = 'calendar.cals'
// Keyed by the exact range, so a cached month can never be painted as another.
const evCacheKey = (min, max) => `calendar.events.${+min}.${+max}`
// The calendar list is still fetched once per session; this only tracks whether
// that has happened, so seeding st.cals from cache does not suppress it.
let calsFetched = false

// Fetch + decorate one range across the visible calendars. Shared by the page
// loader and the boot prefetch so both cache the identical shape.
async function fetchRange(cals, min, max) {
  const hidden = hiddenCals()
  const lists = await Promise.all(cals.filter((c) => !hidden.includes(c.id)).map((c) =>
    listEvents(c.id, min, max).then((evs) => evs.map((e) => ({ ...e, _color: c.backgroundColor || '#e0b15c', _calName: c.summaryOverride || c.summary })))))
  const events = lists.flat().sort((a, b) => evStart(a) - evStart(b))
  events.forEach((e, i) => { e._k = i })
  return events
}

function loadAll() {
  const seq = ++st.seq
  st.loading = true
  const { min, max } = rangeFor(st.view, st.cursor)
  // Draw last launch's copy for this range immediately; the fetch below
  // replaces it once it lands.
  if (!st.cals.length) {
    const cals = cachedValue(CAL_CACHE)
    if (cals) st.cals = cals
  }
  const cached = cachedValue(evCacheKey(min, max))
  if (cached) { st.events = cached; st.loading = false }
  renderSidebar(); renderGrid()
  guard(async () => {
    if (!calsFetched) {
      st.cals = await listCalendars()
      calsFetched = true
      writeCache(CAL_CACHE, st.cals)
    }
    if (seq !== st.seq) return
    renderSidebar()
    const events = await fetchRange(st.cals, min, max)
    if (seq !== st.seq) return
    st.events = events
    writeCache(evCacheKey(min, max), events)
    st.loading = false
    renderGrid()
  })
}

// Boot prefetch: this month, on the calendars the user actually shows.
export async function warmCalendar() {
  if (!isConnected()) return
  try {
    const cals = await listCalendars()
    writeCache(CAL_CACHE, cals)
    const { min, max } = rangeFor('month', startOfDay(new Date()))
    writeCache(evCacheKey(min, max), await fetchRange(cals, min, max))
  } catch { /* prefetch is best-effort */ }
}

// ---- toolbar / sidebar -----------------------------------------------------------

function renderToolbar() {
  const label = q('#cal-label')
  if (!label) return
  const c = st.cursor
  if (st.view === 'month') label.textContent = `${MONTHS[c.getMonth()]} ${c.getFullYear()}`
  else if (st.view === 'day') label.textContent = c.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  else {
    const a = startOfWeek(c), b = addDays(a, 6)
    const sameM = a.getMonth() === b.getMonth()
    label.textContent = `${MONTHS[a.getMonth()].slice(0, 3)} ${a.getDate()} – ${sameM ? '' : MONTHS[b.getMonth()].slice(0, 3) + ' '}${b.getDate()}, ${b.getFullYear()}`
  }
  for (const p of rootEl.querySelectorAll('.cal-view-pill')) p.classList.toggle('is-active', p.dataset.calView === st.view)
}

function renderSidebar() {
  const el = q('#cal-nav')
  if (!el) return
  const hidden = hiddenCals()
  el.innerHTML = `<p class="mail-nav__head">Calendars</p>` + st.cals.map((c) => `
    <label class="cal-src" style="--evc:${esc(c.backgroundColor || '#e0b15c')}">
      <input type="checkbox" data-cal-toggle="${esc(c.id)}"${hidden.includes(c.id) ? '' : ' checked'}>
      <span class="cal-src__box"></span>
      <span class="cal-src__name">${esc(c.summaryOverride || c.summary)}</span>
    </label>`).join('')
}

// ---- grids ---------------------------------------------------------------------

const coversDay = (e, day) => evStart(e) < addDays(day, 1) && evEnd(e) >= day
const needsRsvp = (e) => (e.attendees || []).some((a) => a.self && a.responseStatus === 'needsAction')

function chipHTML(e, day) {
  const ad = isAllDay(e) || !sameDay(evStart(e), evEnd(e))
  return `<button type="button" class="cal-chip${ad ? ' cal-chip--fill' : ''}${needsRsvp(e) ? ' cal-chip--rsvp' : ''}" data-k="${e._k}" style="--evc:${esc(e._color)}" title="${esc(e.summary || '(no title)')}">
    <span class="cal-chip__t">${esc(e.summary || '(no title)')}</span>${ad ? '' : `<span class="cal-chip__time">${shortTime(evStart(e))}</span>`}
  </button>`
}

function renderGrid() {
  const el = q('#cal-grid')
  if (!el) return
  renderToolbar()
  if (st.loading) { el.innerHTML = `<p class="mail-list__empty">Loading…</p>`; return }
  if (st.view === 'month') el.innerHTML = monthHTML()
  else el.innerHTML = weekHTML(st.view === 'week' ? Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(st.cursor), i)) : [startOfDay(st.cursor)])
  const scroll = el.querySelector('.cal-week__scroll')
  if (scroll) scroll.scrollTop = 7 * HOUR_PX - 6
}

function monthHTML() {
  const today = startOfDay(new Date())
  const first = new Date(st.cursor.getFullYear(), st.cursor.getMonth(), 1)
  const start = startOfWeek(first)
  const cells = []
  for (let i = 0; i < 42; i++) {
    const day = addDays(start, i)
    const evs = st.events.filter((e) => coversDay(e, day))
      .sort((a, b) => (isAllDay(b) - isAllDay(a)) || (evStart(a) - evStart(b)))
    const shown = evs.slice(0, 3)
    cells.push(`
      <div class="cal-cell${day.getMonth() !== st.cursor.getMonth() ? ' cal-cell--other' : ''}${sameDay(day, today) ? ' cal-cell--today' : ''}" data-date="${dateStr(day)}">
        <button type="button" class="cal-cell__num" data-cal-day="${dateStr(day)}">${day.getDate()}</button>
        ${shown.map((e) => chipHTML(e, day)).join('')}
        ${evs.length > 3 ? `<button type="button" class="cal-more" data-cal-day="${dateStr(day)}">+${evs.length - 3} more</button>` : ''}
      </div>`)
  }
  return `<div class="cal-month">
    <div class="cal-month__head">${DAY_NAMES.map((d) => `<span>${d.slice(0, 3)}</span>`).join('')}</div>
    <div class="cal-month__grid">${cells.join('')}</div>
  </div>`
}

// Greedy column assignment inside overlap clusters so simultaneous events share width.
function layoutDay(items) {
  items.sort((a, b) => a.s - b.s || b.e - a.e)
  const out = []
  let cluster = [], colEnds = [], clusterEnd = -1
  const flush = () => { for (const it of cluster) it.n = colEnds.length; out.push(...cluster); cluster = []; colEnds = [] }
  for (const it of items) {
    if (cluster.length && it.s >= clusterEnd) flush()
    let c = colEnds.findIndex((end) => end <= it.s)
    if (c === -1) { c = colEnds.length; colEnds.push(0) }
    colEnds[c] = it.e
    it.col = c
    cluster.push(it)
    clusterEnd = Math.max(clusterEnd, it.e)
  }
  flush()
  return out
}

function weekHTML(days) {
  const today = startOfDay(new Date())
  const isStrip = (e) => isAllDay(e) || !sameDay(evStart(e), evEnd(e))
  const gutter = Array.from({ length: 24 }, (_, h) =>
    `<div class="cal-hour">${h === 0 ? '' : `${h % 12 || 12} ${h < 12 ? 'AM' : 'PM'}`}</div>`).join('')
  const heads = days.map((d) =>
    `<div class="cal-colhead${sameDay(d, today) ? ' is-today' : ''}"><button type="button" class="cal-colhead__num" data-cal-day="${dateStr(d)}">${d.getDate()}</button><span>${DAY_NAMES[d.getDay()].slice(0, 3)}</span></div>`).join('')
  const allday = days.map((d) => `
    <div class="cal-allday-col" data-date="${dateStr(d)}">
      ${st.events.filter((e) => isStrip(e) && coversDay(e, d)).map((e) => chipHTML(e, d)).join('')}
    </div>`).join('')
  const cols = days.map((d) => {
    const items = st.events
      .filter((ev) => !isStrip(ev) && sameDay(evStart(ev), d))
      .map((ev) => {
        const s0 = evStart(ev), e0 = evEnd(ev)
        const s = s0.getHours() * 60 + s0.getMinutes()
        return { ev, s, e: Math.max(e0.getHours() * 60 + e0.getMinutes(), s + 20) }
      })
    const laid = layoutDay(items)
    const blocks = laid.map(({ ev, s, e, col, n }) => {
      const bh = Math.max(20, ((e - s) / 60) * HOUR_PX - 2)
      return `
      <button type="button" class="cal-block${bh <= 35 ? ' cal-block--tight' : ''}${needsRsvp(ev) ? ' cal-chip--rsvp' : ''}" data-k="${ev._k}" style="--evc:${esc(ev._color)};top:${(s / 60) * HOUR_PX}px;height:${bh}px;left:calc(${(col * 100) / n}% + 1px);width:calc(${100 / n}% - 3px)">
        <span class="cal-block__time">${fmtTime(evStart(ev))}</span><span class="cal-block__t">${esc(ev.summary || '(no title)')}</span>
      </button>`
    }).join('')
    const now = new Date()
    const nowLine = sameDay(d, today)
      ? `<div class="cal-now" style="top:${((now.getHours() * 60 + now.getMinutes()) / 60) * HOUR_PX}px"></div>` : ''
    return `<div class="cal-day-col" data-date="${dateStr(d)}">${blocks}${nowLine}</div>`
  }).join('')
  return `<div class="cal-week">
    <div class="cal-week__heads"><div class="cal-gutter"></div>${heads}</div>
    <div class="cal-week__allday"><div class="cal-gutter">all-day</div>${allday}</div>
    <div class="cal-week__scroll"><div class="cal-week__grid"><div class="cal-gutter cal-gutter--hours">${gutter}</div>${cols}</div></div>
  </div>`
}

// ---- event view modal ------------------------------------------------------------

function closeOverlay() {
  rootEl?.querySelector('.cal-overlay')?.remove()
  document.removeEventListener('keydown', onCalEsc)
}
function onCalEsc(e) { if (e.key === 'Escape') closeOverlay() }
function openOverlay(html) {
  closeOverlay()
  const o = document.createElement('div')
  o.className = 'modal-overlay cal-overlay'
  o.innerHTML = `<div class="cal-panel">${html}</div>`
  rootEl.appendChild(o)
  o.addEventListener('click', (e) => { if (e.target === o) closeOverlay() })
  document.addEventListener('keydown', onCalEsc)
  return o
}

function eventTimeText(e) {
  const s = evStart(e), en = evEnd(e)
  if (isAllDay(e)) return sameDay(s, en) ? `All day · ${fmtDay(s)}` : `All day · ${fmtDay(s)} – ${fmtDay(en)}`
  if (sameDay(s, en)) return `${fmtDay(s)} · ${fmtTime(s)} – ${fmtTime(en)}`
  return `${fmtDay(s)} ${fmtTime(s)} – ${fmtDay(en)} ${fmtTime(en)}`
}

const RSVP_LABEL = { accepted: 'Going', declined: 'Not going', tentative: 'Maybe', needsAction: 'Not answered' }

function openView(k) {
  const e = st.events.find((x) => x._k === k)
  if (!e) return
  const self = (e.attendees || []).find((a) => a.self)
  const rsvp = self ? `
    <div class="cal-rsvp">
      <span class="cal-field__label">Going?</span>
      ${['accepted', 'tentative', 'declined'].map((r) => `
        <button type="button" class="mail-btn mail-btn--ghost${self.responseStatus === r ? ' is-on' : ''}" data-cal-rsvp="${r}" data-k="${k}">
          ${{ accepted: 'Yes', tentative: 'Maybe', declined: 'No' }[r]}
        </button>`).join('')}
    </div>` : ''
  const guests = (e.attendees || []).length ? `
    <div class="cal-field"><span class="cal-field__label">Guests</span>
      <div>${e.attendees.map((a) => `<div class="cal-guest"><span class="cal-guest__dot cal-guest__dot--${esc(a.responseStatus || 'needsAction')}"></span>${esc(a.displayName || a.email)}${a.organizer ? ' · organizer' : ''} <span class="cal-guest__st">${RSVP_LABEL[a.responseStatus] || ''}</span></div>`).join('')}</div>
    </div>` : ''
  const rule = e.recurrence?.[0] || (e.recurringEventId ? 'series' : null)
  openOverlay(`
    <div class="cal-panel__head">
      <span class="cal-panel__dot" style="--evc:${esc(e._color)}"></span>
      <h2 class="cal-panel__title">${esc(e.summary || '(no title)')}</h2>
      <button type="button" class="mail-iconbtn" data-cal-x="close" aria-label="Close">✕</button>
    </div>
    <p class="cal-panel__when">${eventTimeText(e)}</p>
    ${e.recurringEventId || e.recurrence ? `<p class="cal-panel__rule">↻ ${esc(e.recurrence ? describeRRule(e.recurrence[0]) : 'Repeats — part of a series')}</p>` : ''}
    <p class="cal-panel__cal">${esc(e._calName || '')}</p>
    ${e.location ? `<div class="cal-field"><span class="cal-field__label">Where</span><span>${esc(e.location)}</span></div>` : ''}
    ${e.description ? `<div class="cal-field"><span class="cal-field__label">Notes</span><span class="cal-desc">${renderNotes(e.description)}</span></div>` : ''}
    ${guests}${rsvp}
    <div class="cal-panel__foot" id="cal-view-foot">
      <button type="button" class="mail-btn" data-cal-x="edit" data-k="${k}">Edit</button>
      <button type="button" class="mail-btn mail-btn--ghost" data-cal-x="delete" data-k="${k}">Delete</button>
    </div>`)
}

// Recurring events get a scope step: this occurrence, this weekday, or the series.
function askScope(verb, k) {
  const foot = rootEl.querySelector('#cal-view-foot')
  if (!foot) return
  const ev = st.events.find((y) => y._k === Number(k))
  // "All Wednesdays" only makes sense when editing (forking a weekday out).
  const weekdayBtn = verb === 'Edit' && ev
    ? `<button type="button" class="mail-btn" data-cal-scope="weekday" data-verb="${verb}" data-k="${k}">All ${DAY_NAMES[evStart(ev).getDay()]}s</button>` : ''
  foot.innerHTML = `
    <span class="cal-field__label">${verb} which?</span>
    <button type="button" class="mail-btn" data-cal-scope="one" data-verb="${verb}" data-k="${k}">This event</button>
    ${weekdayBtn}
    ${verb === 'Delete' ? `<button type="button" class="mail-btn" data-cal-scope="following" data-verb="${verb}" data-k="${k}">This &amp; following</button>` : ''}
    <button type="button" class="mail-btn" data-cal-scope="all" data-verb="${verb}" data-k="${k}">All events</button>
    <button type="button" class="mail-btn mail-btn--ghost" data-cal-x="close">Cancel</button>`
}

function doDelete(e, scope) {
  guard(async () => {
    if (scope === 'following') {
      // Truncate the master series just before this occurrence (Google's own
      // "this and following" semantics); earlier occurrences stay put.
      const master = await getEvent(e._calId, e.recurringEventId)
      const until = addDays(startOfDay(evStart(e)), -1)
      if (until < startOfDay(evStart(master))) {
        await deleteEvent(e._calId, e.recurringEventId) // first occurrence → whole series goes
      } else {
        const recurrence = (master.recurrence || []).map((r) =>
          r.startsWith('RRULE:') ? rruleSetUntil(r, until, isAllDay(master)) : r)
        await patchEvent(e._calId, e.recurringEventId, { recurrence })
      }
    } else {
      await deleteEvent(e._calId, scope === 'all' ? e.recurringEventId : e.id)
    }
    closeOverlay()
    toast(scope === 'following' ? 'This and following events deleted.' : 'Event deleted.', true)
    loadAll()
  })
}

// ---- editor -------------------------------------------------------------------

function dowChecks(selected) {
  return RRULE_DAYS.map((code, i) => `
    <label class="cal-dow"><input type="checkbox" value="${code}"${selected.includes(code) ? ' checked' : ''}><span>${'SMTWTFS'[i]}</span></label>`).join('')
}

function openEditor(init) {
  // init: {mode:'create'|'edit', e?, scope?, day?, hour?}
  const create = init.mode === 'create'
  const e = init.e
  edCtx = {
    mode: init.mode, scope: init.scope || null,
    weekday: init.weekday || null,
    calId: e?._calId || visibleCals()[0]?.id || st.cals[0]?.id,
    eventId: init.scope === 'all' || init.scope === 'weekday' ? (e.recurringEventId || e.id) : e?.id,
    attendees: e?.attendees || [],
    hadRule: !!e?.recurrence,
    // Preserve an untouched HTML note: the textarea shows the text version;
    // if that's saved back unchanged, we send the ORIGINAL html, not the text.
    descOrig: e?.description || '',
    descSeed: notesToText(e?.description || ''),
  }
  const day = init.day || (e ? evStart(e) : st.cursor)
  const allDay = e ? isAllDay(e) : false
  const s = e ? evStart(e) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), init.hour ?? 9)
  const en = e ? (isAllDay(e) ? evEnd(e) : new Date(evEnd(e))) : new Date(s.getTime() + 3600e3)
  const rule = e?.recurrence?.find((r) => r.startsWith('RRULE:')) || ''
  const rget = (kk) => rule.match(new RegExp(`${kk}=([^;]+)`))?.[1]
  const freq = (rget('FREQ') || 'none').toLowerCase()
  const byDays = (rget('BYDAY') || '').split(',').filter((x) => /^[A-Z]{2}$/.test(x))
  const monthlyMode = freq === 'monthly' && rget('BYDAY') ? 'weekday' : 'date'
  const until = rget('UNTIL')
  if (init.scope === 'weekday') { edCtx.masterRule = rule; edCtx.masterStart = s }
  // Weekday-fork locks the recurrence (it IS "every <weekday>"), so no rule editor.
  const showRule = init.scope === 'weekday' ? false : (create || init.scope === 'all' || (!e?.recurringEventId && !e?.recurrence) || edCtx.hadRule)
  openOverlay(`
    <div class="cal-panel__head">
      <h2 class="cal-panel__title">${create ? 'New event' : 'Edit event'}${init.scope === 'one' ? ' · this occurrence' : init.scope === 'all' ? ' · all events' : init.scope === 'weekday' ? ` · all ${DAY_NAMES[RRULE_DAYS.indexOf(init.weekday)]}s` : ''}</h2>
      <button type="button" class="mail-iconbtn" data-cal-x="close" aria-label="Close">✕</button>
    </div>
    <input id="ed-title" class="mail-compose__field cal-ed-title" placeholder="Title" value="${esc(e?.summary || '')}">
    <div class="cal-ed-grid">
      <label class="cal-field__label" for="ed-cal">Calendar</label>
      <select id="ed-cal" class="pw-field"${create ? '' : ' disabled'}>
        ${st.cals.filter((c) => c.accessRole !== 'reader' || c.id === edCtx.calId).map((c) => `<option value="${esc(c.id)}"${c.id === edCtx.calId ? ' selected' : ''}>${esc(c.summaryOverride || c.summary)}</option>`).join('')}
      </select>
      <span class="cal-field__label">All day</span>
      <label class="gym-check cal-allday-check"><input type="checkbox" id="ed-allday"${allDay ? ' checked' : ''}> All-day event</label>
      <label class="cal-field__label" for="ed-start-date">Starts</label>
      <div class="cal-ed-when"><input type="date" id="ed-start-date" class="pw-field" value="${dateStr(s)}"><input type="time" id="ed-start-time" class="pw-field cal-time" value="${pad(s.getHours())}:${pad(s.getMinutes())}"></div>
      <label class="cal-field__label" for="ed-end-date">Ends</label>
      <div class="cal-ed-when"><input type="date" id="ed-end-date" class="pw-field" value="${dateStr(en)}"><input type="time" id="ed-end-time" class="pw-field cal-time" value="${pad(en.getHours())}:${pad(en.getMinutes())}"></div>
      ${showRule ? `
      <label class="cal-field__label" for="ed-freq">Repeats</label>
      <select id="ed-freq" class="pw-field">
        ${['none', 'daily', 'weekly', 'monthly'].map((f) => `<option value="${f}"${freq === f ? ' selected' : ''}>${f[0].toUpperCase() + f.slice(1)}</option>`).join('')}
      </select>
      <span class="cal-field__label cal-rule-row cal-rule-weekly"></span>
      <div class="cal-dows cal-rule-row cal-rule-weekly">${dowChecks(byDays.length ? byDays : [RRULE_DAYS[s.getDay()]])}</div>
      <span class="cal-field__label cal-rule-row cal-rule-monthly"></span>
      <div class="cal-rule-row cal-rule-monthly">
        <label class="gym-check"><input type="radio" name="ed-monthly" value="date"${monthlyMode === 'date' ? ' checked' : ''}> <span id="ed-monthly-date-label">On day ${s.getDate()}</span></label>
        <label class="gym-check"><input type="radio" name="ed-monthly" value="weekday"${monthlyMode === 'weekday' ? ' checked' : ''}> <span id="ed-monthly-wd-label">On the ${nthWeekdayOf(s).label} ${DAY_NAMES[s.getDay()]}</span></label>
      </div>
      <label class="cal-field__label cal-rule-row" for="ed-ends">Ends</label>
      <div class="cal-ed-when cal-rule-row">
        <select id="ed-ends" class="pw-field"><option value="never"${until ? '' : ' selected'}>Never</option><option value="on"${until ? ' selected' : ''}>On date</option></select>
        <input type="date" id="ed-until" class="pw-field" value="${until ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : ''}">
      </div>` : ''}
      <label class="cal-field__label" for="ed-guests">Guests</label>
      <input id="ed-guests" class="pw-field" placeholder="emails, comma separated" value="${esc((e?.attendees || []).filter((a) => !a.self || !a.organizer).map((a) => a.email).join(', '))}">
      <label class="cal-field__label" for="ed-location">Where</label>
      <input id="ed-location" class="pw-field" value="${esc(e?.location || '')}">
      <label class="cal-field__label" for="ed-desc">Notes</label>
      <textarea id="ed-desc" class="pw-field" rows="2">${esc(notesToText(e?.description || ''))}</textarea>
    </div>
    <div class="cal-panel__foot">
      <button type="button" class="mail-btn mail-btn--primary" data-cal-x="save">Save</button>
      <button type="button" class="mail-btn mail-btn--ghost" data-cal-x="close">Cancel</button>
      <span class="mail-compose__status" id="ed-status"></span>
    </div>`)
  const o = rootEl.querySelector('.cal-overlay')
  o.addEventListener('change', (ev2) => {
    if (['ed-freq', 'ed-allday', 'ed-ends', 'ed-start-date'].includes(ev2.target.id)) syncEditorUI()
  })
  syncEditorUI()
}

function syncEditorUI() {
  const o = rootEl.querySelector('.cal-overlay')
  if (!o) return
  const freq = o.querySelector('#ed-freq')?.value || 'none'
  const allDay = o.querySelector('#ed-allday').checked
  for (const el of o.querySelectorAll('.cal-rule-weekly')) el.style.display = freq === 'weekly' ? '' : 'none'
  for (const el of o.querySelectorAll('.cal-rule-monthly')) el.style.display = freq === 'monthly' ? '' : 'none'
  const endsRows = o.querySelectorAll('.cal-rule-row:not(.cal-rule-weekly):not(.cal-rule-monthly)')
  for (const el of endsRows) el.style.display = freq === 'none' ? 'none' : ''
  // A repeating event's occurrences are same-day, so the recurrence rule owns the
  // end date — hide the per-event end date and let save pin it to the start date.
  // In weekday-fork scope the recurrence owns BOTH dates (it's "every <weekday>"),
  // so hide the start date too and keep only the editable times.
  const weekdayScope = edCtx?.scope === 'weekday'
  const endDateEl = o.querySelector('#ed-end-date')
  if (endDateEl) endDateEl.style.display = (freq !== 'none' || weekdayScope) ? 'none' : ''
  const startDateEl = o.querySelector('#ed-start-date')
  if (startDateEl) startDateEl.style.display = weekdayScope ? 'none' : ''
  const untilEl = o.querySelector('#ed-until')
  if (untilEl) untilEl.style.display = o.querySelector('#ed-ends')?.value === 'on' ? '' : 'none'
  for (const el of o.querySelectorAll('input[type="time"]')) el.style.display = allDay ? 'none' : ''
  // monthly labels track the start date
  const sd = parseDateLocal(o.querySelector('#ed-start-date').value || dateStr(new Date()))
  const dl = o.querySelector('#ed-monthly-date-label')
  if (dl) dl.textContent = `On day ${sd.getDate()}`
  const wl = o.querySelector('#ed-monthly-wd-label')
  if (wl) wl.textContent = `On the ${nthWeekdayOf(sd).label} ${DAY_NAMES[sd.getDay()]}`
}

function saveEditor() {
  const o = rootEl.querySelector('.cal-overlay')
  const val = (id) => o.querySelector('#' + id)?.value
  const status = o.querySelector('#ed-status')
  const allDay = o.querySelector('#ed-allday').checked
  const repeating = (o.querySelector('#ed-freq')?.value || 'none') !== 'none'
  // Repeating events are same-day per occurrence: the end date follows the start.
  const sd = val('ed-start-date'), ed = repeating ? sd : (val('ed-end-date') || sd)
  if (!sd) { status.textContent = 'Pick a start date.'; return }
  let start, end
  if (allDay) {
    start = { date: sd }
    end = { date: dateStr(addDays(parseDateLocal(ed < sd ? sd : ed), 1)) } // API end is exclusive
  } else {
    const stime = val('ed-start-time') || '09:00', etime = val('ed-end-time') || '10:00'
    start = { dateTime: `${sd}T${stime}:00`, timeZone: tz }
    end = { dateTime: `${ed}T${etime}:00`, timeZone: tz }
    if (new Date(`${ed}T${etime}:00`) <= new Date(`${sd}T${stime}:00`)) { status.textContent = 'End must be after start.'; return }
  }
  const descVal = val('ed-desc') || ''
  const description = descVal === edCtx.descSeed ? edCtx.descOrig : descVal // keep untouched HTML notes intact
  const body = { summary: val('ed-title') || '(no title)', location: val('ed-location') || '', description, start, end }
  const freqEl = o.querySelector('#ed-freq')
  if (freqEl) {
    const rule = buildRRule({
      freq: freqEl.value,
      byDays: [...o.querySelectorAll('.cal-dows input:checked')].map((x) => x.value),
      monthlyMode: o.querySelector('input[name="ed-monthly"]:checked')?.value || 'date',
      start: parseDateLocal(sd),
      untilDate: o.querySelector('#ed-ends')?.value === 'on' && val('ed-until') ? parseDateLocal(val('ed-until')) : null,
      allDay,
    })
    if (rule) body.recurrence = [rule]
    else if (edCtx.hadRule) body.recurrence = []
  }
  const emails = (val('ed-guests') || '').split(',').map((x) => x.trim()).filter((x) => x.includes('@'))
  if (emails.length || edCtx.attendees.length) {
    body.attendees = emails.map((em) => edCtx.attendees.find((a) => a.email === em) || { email: em })
    // keep ourselves on the guest list when editing an invite we're part of
    const self = edCtx.attendees.find((a) => a.self)
    if (self && !body.attendees.some((a) => a.self)) body.attendees.push(self)
  }
  status.textContent = 'Saving…'
  guard(async () => {
    if (edCtx.scope === 'weekday') {
      // Fork this weekday out of the series: create a new weekly-on-<weekday>
      // series carrying the edits, then drop that day from the master's BYDAY.
      const wd = edCtx.weekday
      const first = firstWeekdayOnOrAfter(edCtx.masterStart, wd)
      const fdate = dateStr(first)
      let fStart, fEnd
      if (allDay) { fStart = { date: fdate }; fEnd = { date: dateStr(addDays(first, 1)) } }
      else {
        const stime = val('ed-start-time') || '09:00', etime = val('ed-end-time') || '10:00'
        fStart = { dateTime: `${fdate}T${stime}:00`, timeZone: tz }
        fEnd = { dateTime: `${fdate}T${etime}:00`, timeZone: tz }
      }
      const forked = { ...body, start: fStart, end: fEnd, recurrence: [rruleSetByDay(edCtx.masterRule, [wd])] }
      await createEvent(edCtx.calId, forked, false)
      await patchEvent(edCtx.calId, edCtx.eventId, { recurrence: [rruleSetByDay(edCtx.masterRule, rruleByDays(edCtx.masterRule).filter((d) => d !== wd))] }, false)
      closeOverlay()
      toast(`All ${DAY_NAMES[RRULE_DAYS.indexOf(wd)]}s updated — now their own series.`, true)
      loadAll()
      return
    }
    if (edCtx.mode === 'create') await createEvent(val('ed-cal'), body, emails.length > 0)
    else await patchEvent(edCtx.calId, edCtx.eventId, body, emails.length > 0)
    closeOverlay()
    toast('Event saved.', true)
    loadAll()
  })
}

// ---- clicks -------------------------------------------------------------------

function onClick(e) {
  const x = e.target.closest('[data-cal-x]')
  if (x) {
    const k = Number(x.dataset.k)
    const ev = st.events.find((y) => y._k === k)
    if (x.dataset.calX === 'close') closeOverlay()
    if (x.dataset.calX === 'save') saveEditor()
    if (x.dataset.calX === 'edit') { ev.recurringEventId ? askScope('Edit', k) : openEditor({ mode: 'edit', e: ev }) }
    if (x.dataset.calX === 'delete') {
      if (ev.recurringEventId) askScope('Delete', k)
      else if (confirm('Delete this event?')) doDelete(ev, 'one')
    }
    return
  }
  const scope = e.target.closest('[data-cal-scope]')
  if (scope) {
    const ev = st.events.find((y) => y._k === Number(scope.dataset.k))
    if (scope.dataset.verb === 'Delete') doDelete(ev, scope.dataset.calScope)
    else if (scope.dataset.calScope === 'weekday') {
      // Fork this weekday into its own series — only valid for weekly events that
      // repeat on more than one weekday (else "all Wednesdays" == "all events").
      guard(async () => {
        const master = await getEvent(ev._calId, ev.recurringEventId)
        const rule = master.recurrence?.find((r) => r.startsWith('RRULE:')) || ''
        const wd = RRULE_DAYS[evStart(ev).getDay()]
        const days = rruleByDays(rule)
        if (!/FREQ=WEEKLY/.test(rule) || !days.includes(wd) || days.length < 2) {
          toast(`“All ${DAY_NAMES[evStart(ev).getDay()]}s” only applies to weekly events that repeat on more than one weekday.`)
          return
        }
        openEditor({ mode: 'edit', e: { ...master, _calId: ev._calId, id: ev.recurringEventId }, scope: 'weekday', weekday: wd })
      })
    } else if (scope.dataset.calScope === 'all') {
      // edit the series master so the rule + first occurrence are the source of truth
      guard(async () => {
        const master = await getEvent(ev._calId, ev.recurringEventId)
        openEditor({ mode: 'edit', e: { ...master, _calId: ev._calId, id: ev.recurringEventId }, scope: 'all' })
      })
    } else openEditor({ mode: 'edit', e: ev, scope: 'one' })
    return
  }
  const rsvp = e.target.closest('[data-cal-rsvp]')
  if (rsvp) {
    const ev = st.events.find((y) => y._k === Number(rsvp.dataset.k))
    guard(async () => {
      await respondToEvent(ev._calId, ev.recurringEventId || ev.id, rsvp.dataset.calRsvp)
      closeOverlay()
      toast('Response sent.', true)
      loadAll()
    })
    return
  }
  if (e.target.closest('.cal-overlay')) return
  const chip = e.target.closest('[data-k]')
  if (chip) { openView(Number(chip.dataset.k)); return }
  const dayBtn = e.target.closest('[data-cal-day]')
  if (dayBtn) {
    st.cursor = parseDateLocal(dayBtn.dataset.calDay)
    setView('day')
    return
  }
  const act = e.target.closest('[data-cal]')
  if (act) {
    const a = act.dataset.cal
    if (a === 'toggle-nav') {
      const s = loadCal()
      s.navHidden = !s.navHidden
      saveCal(s)
      q('.cal-body')?.classList.toggle('nav-hidden', s.navHidden)
    }
    if (a === 'today') { st.cursor = startOfDay(new Date()); loadAll() }
    if (a === 'prev' || a === 'next') {
      const dir = a === 'next' ? 1 : -1
      if (st.view === 'month') st.cursor = new Date(st.cursor.getFullYear(), st.cursor.getMonth() + dir, 1)
      else st.cursor = addDays(st.cursor, dir * (st.view === 'week' ? 7 : 1))
      loadAll()
    }
    if (a === 'new') openEditor({ mode: 'create', day: st.cursor })
    return
  }
  const pill = e.target.closest('[data-cal-view]')
  if (pill) { setView(pill.dataset.calView); return }
  const toggle = e.target.closest('[data-cal-toggle]')
  if (toggle) {
    const s = loadCal()
    const id = toggle.dataset.calToggle
    s.hiddenCals = toggle.checked ? s.hiddenCals.filter((x) => x !== id) : [...s.hiddenCals, id]
    saveCal(s)
    loadAll()
    return
  }
  // empty grid space → quick create at that spot
  const col = e.target.closest('.cal-day-col')
  if (col) {
    const rect = col.getBoundingClientRect()
    const hour = Math.max(0, Math.min(23, Math.floor((e.clientY - rect.top) / HOUR_PX)))
    openEditor({ mode: 'create', day: parseDateLocal(col.dataset.date), hour })
    return
  }
  const cell = e.target.closest('.cal-cell')
  if (cell) openEditor({ mode: 'create', day: parseDateLocal(cell.dataset.date), hour: 9 })
}

function setView(v) {
  st.view = v
  const s = loadCal()
  s.view = v
  saveCal(s)
  loadAll()
}

// ---- dashboard widgets -----------------------------------------------------------

export const CAL_KINDS = ['calagenda', 'calmonth']

export function calWidgetHTML(w) {
  const now = new Date()
  const head = w.kind === 'calagenda' ? 'Upcoming' : `${MONTHS[now.getMonth()]} ${now.getFullYear()}`
  return `<p class="gym-head">${head}</p><div class="cal-wmount" data-cal-widget="${w.kind === 'calagenda' ? 'agenda' : 'month'}"><p class="cal-wnote">Loading…</p></div>`
}

let widgetCache = null // { at, promise } — dashboards re-render often; don't re-hit the API each time
function widgetData() {
  if (widgetCache && Date.now() - widgetCache.at < 120e3) return widgetCache.promise
  const min = startOfWeek(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
  const max = addDays(min, 42)
  const promise = (async () => {
    const cals = await listCalendars()
    const hidden = loadCal().hiddenCals
    const lists = await Promise.all(cals.filter((c) => !hidden.includes(c.id)).map((c) =>
      listEvents(c.id, min, max).then((evs) => evs.map((e) => ({ ...e, _color: c.backgroundColor || '#e0b15c' })))))
    return lists.flat().sort((a, b) => evStart(a) - evStart(b))
  })()
  widgetCache = { at: Date.now(), promise }
  promise.catch(() => { widgetCache = null })
  return promise
}

function agendaHTML(events) {
  const today = startOfDay(new Date())
  const upcoming = events.filter((e) => evEnd(e) >= today && evStart(e) < addDays(today, 14)).slice(0, 8)
  if (!upcoming.length) return `<p class="cal-wnote">Nothing scheduled in the next two weeks.</p>`
  let lastDay = ''
  return upcoming.map((e) => {
    const s = evStart(e)
    const dayLabel = fmtDay(s)
    const headr = dayLabel !== lastDay ? `<p class="cal-aghead">${sameDay(s, today) ? 'Today' : dayLabel}</p>` : ''
    lastDay = dayLabel
    return `${headr}<div class="cal-agrow"><span class="cal-agdot" style="--evc:${esc(e._color)}"></span><span class="cal-agtime">${isAllDay(e) ? 'All day' : fmtTime(s)}</span><span class="cal-agtitle">${esc(e.summary || '(no title)')}</span></div>`
  }).join('')
}

function miniMonthHTML(events) {
  const today = startOfDay(new Date())
  const first = new Date(today.getFullYear(), today.getMonth(), 1)
  const start = startOfWeek(first)
  let cells = ''
  for (let i = 0; i < 42; i++) {
    const day = addDays(start, i)
    const dots = events.filter((e) => coversDay(e, day)).slice(0, 3)
    cells += `<div class="cal-mini__cell${day.getMonth() !== today.getMonth() ? ' is-other' : ''}${sameDay(day, today) ? ' is-today' : ''}">
      <span>${day.getDate()}</span><span class="cal-mini__dots">${dots.map((e) => `<i style="--evc:${esc(e._color)}"></i>`).join('')}</span>
    </div>`
  }
  return `<div class="cal-mini">${'SMTWTFS'.split('').map((c) => `<div class="cal-mini__head">${c}</div>`).join('')}${cells}</div>`
}

// Widgets render as placeholders in the sync page render; this fills them.
export function hydrateCalWidgets(contentEl) {
  const mounts = contentEl.querySelectorAll('[data-cal-widget]')
  if (!mounts.length) return
  if (!isConnected()) {
    for (const m of mounts) m.innerHTML = `<p class="cal-wnote">Connect Google in Settings to see your calendar.</p>`
    return
  }
  widgetData().then((events) => {
    for (const m of contentEl.querySelectorAll('[data-cal-widget]')) {
      m.innerHTML = m.dataset.calWidget === 'agenda' ? agendaHTML(events) : miniMonthHTML(events)
    }
  }).catch((err) => {
    for (const m of contentEl.querySelectorAll('[data-cal-widget]')) m.innerHTML = `<p class="cal-wnote">${esc(err.message)}</p>`
  })
}
