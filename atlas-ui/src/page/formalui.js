// Formal plugin UI: the House widget (one house per widget). Capacity math +
// solver live in formal.js. Rooms are cards that flow side by side; beds are
// dragged in from a bed palette (icons sized to real mattress widths), and a
// placed bed is removed by clicking it. Couches are room items like beds, so
// a living room is just a room of couches.
//
// The only headcount input is the DATES slider (0 → the house's couple
// capacity). Fill policy: every couple gets its own room while couple-capable
// rooms last (privacy beats headcount — couples share only when they
// outnumber those rooms), couples take the cheapest rooms in stag spots, and
// every other room packs brothers. Each room card shows who's actually in it
// ("1 couple" / "3 brothers"); the widget footer shows the totals. Price per
// brother divides by THIS house's current brother count.
//
// A widget's house lives on the widget itself (w.house) in the page model, so
// every House widget is independent; add a house by adding another widget in
// Customize. Editing happens in view mode; customize mode shows a compact
// summary so the widget stays draggable.

import {
  normalizeHouse, normalizeRoom, uid,
  ITEM_TYPES, roomCouples, roomBrothers, houseMax, fillHouse,
  normalizeExpense, normalizeExpenses, expenseTotal, expenseTotals,
} from './formal.js'
import { loadPage, savePage, findWidget } from './model.js'
import { PAGES, pageById } from './pages.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const FM_KINDS = ['fmhouses', 'fmexpenses']

const money = (n) => '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const pl = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const ITEM_LABELS = { king: 'K', queen: 'Q', full: 'F', twin: 'T', futon: 'Fu', sleeper: 'SS', couch: 'C' }
const ITEM_TITLES = {
  king: 'King — 1 couple or 2 brothers',
  queen: 'Queen — 1 couple or 2 brothers',
  full: 'Full — 1 couple or 2 brothers',
  twin: 'Twin — 1 brother',
  futon: 'Futon — 1 brother, unused in a couples room',
  sleeper: 'Sofa sleeper — 2 brothers, never a couple',
  couch: 'Couch — 1 brother, never a couple',
}

// The board the visible widgets belong to (works on any widget page —
// Formal, Dashboard, …). Same hash→page resolution as renderer.js's route().
const pageKey = () => {
  const id = location.hash.replace(/^#\/?/, '').split('/')[0]
  return (pageById(id) || PAGES[0]).storageKey
}

// per-widget dates-slider position — session-only, like work's tip-share inputs
const ui = new Map()
const st = (id) => {
  if (!ui.has(id)) ui.set(id, { dates: 0 })
  return ui.get(id)
}

// ---- widget body ------------------------------------------------------------

const capText = (h) => {
  const m = houseMax(h)
  const extra = m.brothersWithCouches !== m.brothers ? ` (${m.brothersWithCouches} with couches)` : ''
  return `Up to <strong>${pl(m.couples, 'couple')}</strong> or <strong>${m.brothers} brothers</strong>${extra}`
}

// Who's actually in this room under the current fill.
const asgHTML = (room, fr, use) => {
  if (roomBrothers(room, use) === 0) return '<span class="fm-rasg">empty</span>'
  return fr.mode === 'couples'
    ? `<span class="fm-rasg fm-rasg--c">${fr.couples ? pl(fr.couples, 'couple') : 'unused'}</span>`
    : `<span class="fm-rasg">${pl(fr.brothers, 'brother')}</span>`
}

const totalsHTML = (f) =>
  `<strong>${pl(f.total, 'person').replace('persons', 'people')}</strong> · ${pl(f.brothers, 'brother')} · ${pl(f.dates, 'date')} · ${pl(f.couples, 'couple')} · ${pl(f.stags, 'stag')}`

const ppbText = (h, f) =>
  h.price > 0 && f.brothers > 0 ? `${money(h.price / f.brothers)} / brother` : ''

// One bed/couch icon. Placed icons carry data-fm-bi so a click removes them;
// palette icons carry data-fm-pal so a drag adds them.
const itemIcon = (t, attrs) =>
  `<span class="fm-bi fm-bi--${t}" ${attrs} title="${ITEM_TITLES[t]}">${ITEM_LABELS[t]}</span>`

function roomItemsHTML(r, use) {
  const icons = []
  for (const t of ITEM_TYPES) {
    const off = use?.[t] === false ? ' fm-bi--off' : ''
    for (let i = 0; i < r.beds[t]; i++) icons.push(`<span class="fm-bi fm-bi--${t}${off}" data-fm-bi="${t}" role="button" tabindex="0" aria-label="Remove ${t}" title="${ITEM_TITLES[t]}${off ? ' (disabled for this house)' : ''}">${ITEM_LABELS[t]}</span>`)
  }
  return icons.length ? icons.join('') : '<span class="fm-drophint">drop beds here</span>'
}

// Per-house switches for the surfaces you might not want people sleeping on.
// A chip only appears once the house actually has that surface placed.
const USE_TYPES = { futon: 'futons', sleeper: 'sofa sleepers', couch: 'couches' }
const itemCount = (h, t) => h.rooms.reduce((n, r) => n + r.beds[t], 0)
const usesHTML = (h) => `<span class="fm-uses">${Object.entries(USE_TYPES).filter(([t]) => itemCount(h, t) > 0).map(([t, lbl]) =>
  `<label class="fm-use${h.use[t] ? ' is-on' : ''}" title="Count ${lbl} in this house's capacity"><input type="checkbox" data-fm-use="${t}"${h.use[t] ? ' checked' : ''}>${lbl}</label>`).join('')}</span>`

// ---- expense tracker widget ---------------------------------------------------

const expFootHTML = (t) => {
  const s = expenseTotals(t)
  const split = t.brothers > 0 ? ` · ${money(s.perBrother)} / brother` : ''
  const owed = s.paid > 0 ? ` · paid ${money(s.paid)} · owed ${money(s.owed)}` : ''
  const cats = s.byCat.length > 1 ? `<br><span class="fmx-cats">${s.byCat.map(([c, v]) => `${esc(c)} ${money(v)}`).join(' · ')}</span>` : ''
  return `<strong>${money(s.total)}</strong>${split}${owed}${cats}`
}

function expItemHTML(it, t, wid) {
  const link = it.link ? `<a class="fm-open" href="${esc(it.link)}" target="_blank" rel="noopener" title="Open link">↗</a>` : ''
  const unit = it.per
    ? `<input class="pw-field fm-num fmx-n" data-fmx-field="people" type="number" min="0" step="1" value="${it.people || ''}" placeholder="${t.brothers || 'people'}" aria-label="People" title="People paying this price (blank = brothers)">`
    : `<input class="pw-field fm-num fmx-n" data-fmx-field="qty" type="number" min="1" step="1" value="${it.qty}" aria-label="Quantity" title="Quantity">`
  return `<div class="fmx-item${it.paid ? ' is-paid' : ''}" data-fmx-item="${esc(it.id)}">
    <div class="fmx-main">
      <input type="checkbox" class="fmx-paid" data-fmx-field="paid"${it.paid ? ' checked' : ''} title="Paid" aria-label="Paid">
      <input class="pw-field fmx-name" data-fmx-field="name" value="${esc(it.name)}" placeholder="Expense" aria-label="Expense name">
      <input class="pw-field fmx-cat" data-fmx-field="cat" value="${esc(it.cat)}" list="fmx-cats-${esc(wid)}" placeholder="category" aria-label="Category">
      <label class="fm-lab">$<input class="pw-field fm-num fmx-n" data-fmx-field="cost" type="number" min="0" step="any" value="${it.cost || ''}" placeholder="cost" aria-label="Cost"></label>
      <button type="button" class="fmx-per${it.per ? ' is-on' : ''}" data-fmx-act="toggle-per" title="Flat total × qty, or price per person × people">${it.per ? '/person ×' : '×'}</button>
      ${unit}
      <span class="fmx-rt" data-fmx-rt>${money(expenseTotal(it, t.brothers))}</span>
      <button type="button" class="pw-item-remove" data-fmx-act="del-item" title="Remove expense">×</button>
    </div>
    <div class="fmx-meta">
      <input class="pw-field fmx-link" data-fmx-field="link" value="${esc(it.link)}" placeholder="Link…" aria-label="Expense link">${link}
      <input class="pw-field fmx-note" data-fmx-field="note" value="${esc(it.note)}" placeholder="Note…" aria-label="Note">
    </div>
  </div>`
}

function expensesHTML(w, cz) {
  const t = normalizeExpenses(w.exp)
  const s = expenseTotals(t)
  if (cz) {
    return `<p class="gym-head">${esc(t.name || 'Expenses')}</p><p class="gym-sub">${pl(t.items.length, 'expense')} · ${money(s.total)}</p>`
  }
  const cats = [...new Set(t.items.map((i) => i.cat.trim()).filter(Boolean))]
  return `<div class="fm-house">
    <div class="fm-head">
      <input class="pw-field fm-name" data-fmx-tfield="name" value="${esc(t.name)}" placeholder="Expenses" aria-label="Tracker name">
      <label class="fm-lab fmx-bros">Brothers<input class="pw-field fm-num fmx-n" data-fmx-tfield="brothers" type="number" min="0" step="1" value="${t.brothers || ''}" aria-label="Brothers splitting the bill"></label>
    </div>
    <datalist id="fmx-cats-${esc(w.id)}">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
    <div class="fmx-items">${t.items.map((it) => expItemHTML(it, t, w.id)).join('')}</div>
    <button type="button" class="fm-addroom" data-fmx-act="add-item">+ Expense</button>
    <p class="fm-totals" data-fmx-foot>${expFootHTML(t)}</p>
  </div>`
}

export function formalWidgetHTML(w, cz) {
  if (w.kind === 'fmexpenses') return expensesHTML(w, cz)
  const h = normalizeHouse(w.house)
  if (cz) {
    // compact, non-interactive summary — keeps the widget draggable
    return `<p class="gym-head">${esc(h.name || 'House')}</p><p class="gym-sub">${capText(h)}</p>`
  }
  const state = st(w.id)
  const maxD = houseMax(h).couples
  state.dates = Math.min(state.dates, maxD)
  const f = fillHouse(h, state.dates)
  const link = h.link ? `<a class="fm-open" href="${esc(h.link)}" target="_blank" rel="noopener" title="Open listing">↗</a>` : ''
  // a disabled type stays draggable while the house has none placed — hiding
  // it too would make the type unreachable once its chip disappears
  const palette = ITEM_TYPES.filter((t) => h.use[t] !== false || itemCount(h, t) === 0).map((t) => itemIcon(t, `draggable="true" data-fm-pal="${t}"`)).join('')
  const rooms = h.rooms.map((r, ri) => `<div class="fm-roomcard" data-fm-room="${esc(r.id)}">
      <div class="fm-roomhead">
        <input class="fm-rname" data-fm-rname value="${esc(r.name)}" placeholder="Room ${ri + 1}" aria-label="Room name">
        <button type="button" class="pw-item-remove" data-fm-act="del-room" title="Remove room">×</button>
      </div>
      <div class="fm-roombeds">${roomItemsHTML(r, h.use)}</div>
      <span data-fm-rasg>${asgHTML(r, f.rooms[ri], h.use)}</span>
    </div>`).join('')
  return `<div class="fm-house">
    <div class="fm-head">
      <input class="pw-field fm-name" data-fm-field="name" value="${esc(h.name)}" placeholder="House name" aria-label="House name">
      <button type="button" class="fm-dup" data-fm-act="dup-house" title="Duplicate this house into a new widget">⧉</button>
    </div>
    <div class="fm-meta">
      <input class="pw-field fm-linkin" data-fm-field="link" value="${esc(h.link)}" placeholder="Listing link…" aria-label="House link">${link}
      <label class="fm-lab"><input class="pw-field fm-date" data-fm-field="dateFrom" type="date" value="${esc(h.dateFrom)}" aria-label="From date" title="From">–<input class="pw-field fm-date" data-fm-field="dateTo" type="date" value="${esc(h.dateTo)}" min="${esc(h.dateFrom)}" aria-label="To date" title="To"></label>
      <label class="fm-lab">$<input class="pw-field fm-num" data-fm-field="price" type="number" min="0" step="1" value="${h.price || ''}" placeholder="price" aria-label="House price"></label>
      <span class="fm-ppb" data-fm-ppb>${ppbText(h, f)}</span>
    </div>
    <div class="fm-palette">${palette}<span class="fm-palhint">drag a bed into a room · click a placed bed to remove it</span>${usesHTML(h)}</div>
    <div class="fm-rooms">${rooms}<button type="button" class="fm-addroom" data-fm-act="add-room">+ Room</button></div>
    <div class="fm-fit">
      <label class="fm-lab fm-lab--slider">Dates<input type="range" class="fm-fit-dates" min="0" max="${maxD}" value="${state.dates}" aria-label="Dates attending"><span class="fm-fit-dn" data-fm-dn>${state.dates}</span></label>
    </div>
    <p class="fm-totals" data-fm-totals>${totalsHTML(f)}</p>
  </div>`
}

// ---- interactions ------------------------------------------------------------

let rerenderApp = null
let dragType = null // bed type being dragged from a widget's palette

export function bindFormal(rerender) {
  rerenderApp = rerender
  document.body.addEventListener('click', onFormalClick)
  document.body.addEventListener('input', onFormalInput)
  document.addEventListener('dragstart', onDragStart)
  document.addEventListener('dragend', () => { dragType = null; clearOver() })
  document.body.addEventListener('dragover', onDragOver)
  document.body.addEventListener('dragleave', onDragLeave)
  document.body.addEventListener('drop', onDrop)
}

// load → normalize → mutate → save the one widget's house on the current board
function withHouse(el, fn) {
  const art = el.closest('.pwidget--fmhouses')
  if (!art) return null
  const page = loadPage(pageKey())
  const f = findWidget(page, art.dataset.widgetId)
  if (!f) return null
  const h = normalizeHouse(f.widget.house)
  fn(h)
  f.widget.house = h
  savePage(page)
  return h
}

// same load→mutate→save flow for an expense widget's tracker (w.exp)
function withExp(el, fn) {
  const art = el.closest('.pwidget--fmexpenses')
  if (!art) return null
  const page = loadPage(pageKey())
  const f = findWidget(page, art.dataset.widgetId)
  if (!f) return null
  const t = normalizeExpenses(f.widget.exp)
  fn(t)
  f.widget.exp = t
  savePage(page)
  return t
}

// ---- bed drag: palette icon → room card ----

function onDragStart(e) {
  const pal = e.target.closest?.('[data-fm-pal]')
  if (!pal) return
  dragType = pal.dataset.fmPal
  e.dataTransfer.effectAllowed = 'copy'
  e.dataTransfer.setData('text/plain', dragType) // Firefox needs a non-empty store
}

const clearOver = () => document.querySelectorAll('.fm-roomcard.is-over').forEach((el) => el.classList.remove('is-over'))

function onDragOver(e) {
  if (!dragType) return
  const card = e.target.closest('.fm-roomcard')
  if (!card) { clearOver(); return }
  e.preventDefault() // makes the card a valid drop target
  e.dataTransfer.dropEffect = 'copy'
  if (!card.classList.contains('is-over')) { clearOver(); card.classList.add('is-over') }
}

function onDragLeave(e) {
  if (dragType && !e.relatedTarget?.closest?.('.fm-roomcard')) clearOver()
}

function onDrop(e) {
  if (!dragType) return
  const card = e.target.closest('.fm-roomcard')
  clearOver()
  if (!card) return
  e.preventDefault()
  const roomId = card.dataset.fmRoom
  const t = dragType
  dragType = null
  const did = withHouse(card, (h) => {
    const room = h.rooms.find((r) => r.id === roomId)
    if (room) room.beds[t]++
  })
  if (did) rerenderApp?.()
}

// ---- clicks: add/remove room, click a placed bed to remove it ----

function onFormalClick(e) {
  const xact = e.target.closest('[data-fmx-act]')
  if (xact) {
    const a = xact.dataset.fmxAct
    const itemId = xact.closest('[data-fmx-item]')?.dataset.fmxItem
    const did = withExp(xact, (t) => {
      if (a === 'add-item') t.items.push(normalizeExpense({}))
      else if (a === 'del-item') t.items = t.items.filter((i) => i.id !== itemId)
      else if (a === 'toggle-per') {
        const it = t.items.find((i) => i.id === itemId)
        if (it) it.per = !it.per
      }
    })
    if (did) rerenderApp?.()
    return
  }
  const bi = e.target.closest('[data-fm-bi]')
  if (bi) {
    const roomId = bi.closest('[data-fm-room]').dataset.fmRoom
    const t = bi.dataset.fmBi
    const did = withHouse(bi, (h) => {
      const room = h.rooms.find((r) => r.id === roomId)
      if (room && room.beds[t] > 0) room.beds[t]--
    })
    if (did) rerenderApp?.()
    return
  }
  const act = e.target.closest('[data-fm-act]')
  if (!act) return
  const a = act.dataset.fmAct
  let did = null
  if (a === 'dup-house') {
    // deep-copy the house into a fresh widget right after this one (same line)
    const art = act.closest('.pwidget--fmhouses')
    const page = loadPage(pageKey())
    const f = findWidget(page, art.dataset.widgetId)
    if (!f) return
    const h = normalizeHouse(f.widget.house)
    h.rooms = h.rooms.map((r) => ({ ...r, beds: { ...r.beds }, id: uid('fr') }))
    if (h.name) h.name += ' copy'
    f.line.widgets.splice(f.wi + 1, 0, { id: uid('w'), kind: 'fmhouses', house: h })
    savePage(page)
    rerenderApp?.()
    return
  }
  if (a === 'add-room') did = withHouse(act, (h) => h.rooms.push(normalizeRoom({ id: uid('fr') })))
  else if (a === 'del-room') {
    const roomId = act.closest('[data-fm-room]').dataset.fmRoom
    did = withHouse(act, (h) => { h.rooms = h.rooms.filter((r) => r.id !== roomId) })
  } else return
  if (did) rerenderApp?.()
}

// Field/name/slider edits write straight to the widget's house (or session
// state) and refresh the derived text in place — a rerender would drop focus.
function onFormalInput(e) {
  const xart = e.target.closest('.pwidget--fmexpenses')
  if (xart) {
    const tf = e.target.dataset.fmxTfield
    const f = e.target.dataset.fmxField
    if (!tf && !f) return
    const itemId = e.target.closest('[data-fmx-item]')?.dataset.fmxItem
    const t = withExp(e.target, (t2) => {
      if (tf === 'brothers') t2.brothers = Math.max(0, Math.floor(Number(e.target.value) || 0))
      else if (tf) t2[tf] = e.target.value
      const it = t2.items.find((i) => i.id === itemId)
      if (!it || !f) return
      if (f === 'paid') it.paid = e.target.checked
      else if (f === 'cost') it.cost = Math.max(0, Number(e.target.value) || 0)
      else if (f === 'qty') it.qty = Math.max(1, Math.floor(Number(e.target.value) || 1))
      else if (f === 'people') it.people = Math.max(0, Math.floor(Number(e.target.value) || 0))
      else it[f] = e.target.value
    })
    if (t) refreshExpWidget(xart, t)
    return
  }
  const art = e.target.closest('.pwidget--fmhouses')
  if (!art) return

  const useT = e.target.dataset.fmUse
  if (useT) {
    // palette + placed icons + math all change — full rerender (checkbox click, no focus to lose)
    const did = withHouse(e.target, (h) => { h.use[useT] = e.target.checked })
    if (did) rerenderApp?.()
    return
  }
  const field = e.target.dataset.fmField
  if (field) {
    const h = withHouse(e.target, (h2) => {
      if (field === 'price') h2.price = Math.max(0, Number(e.target.value) || 0)
      else h2[field] = e.target.value
    })
    if (h) refreshWidget(art, h)
    return
  }
  if (e.target.hasAttribute('data-fm-rname')) {
    const roomId = e.target.closest('[data-fm-room]').dataset.fmRoom
    const h = withHouse(e.target, (h2) => {
      const room = h2.rooms.find((r) => r.id === roomId)
      if (room) room.name = e.target.value
    })
    if (h) return // names don't change the math — nothing else to refresh
  }
  if (e.target.classList.contains('fm-fit-dates')) {
    st(art.dataset.widgetId).dates = Math.floor(Number(e.target.value) || 0)
    const page = loadPage(pageKey())
    const f = findWidget(page, art.dataset.widgetId)
    if (f) refreshWidget(art, normalizeHouse(f.widget.house))
  }
}

// Repaint an expense widget's derived bits in place: row totals, paid dimming,
// people placeholders (they track the brothers count), and the footer.
function refreshExpWidget(art, t) {
  art.querySelectorAll('[data-fmx-item]').forEach((row) => {
    const it = t.items.find((i) => i.id === row.dataset.fmxItem)
    if (!it) return
    row.classList.toggle('is-paid', it.paid)
    const rt = row.querySelector('[data-fmx-rt]')
    if (rt) rt.textContent = money(expenseTotal(it, t.brothers))
    const people = row.querySelector('[data-fmx-field="people"]')
    if (people) people.placeholder = t.brothers || 'people'
  })
  const foot = art.querySelector('[data-fmx-foot]')
  if (foot) foot.innerHTML = expFootHTML(t)
}

// Recompute the fill and repaint every derived bit of one widget in place.
function refreshWidget(art, h) {
  const state = st(art.dataset.widgetId)
  const maxD = houseMax(h).couples
  state.dates = Math.min(state.dates, maxD)
  const f = fillHouse(h, state.dates)
  const q = (sel) => art.querySelector(sel)
  const slider = q('.fm-fit-dates')
  if (slider) { slider.max = maxD; slider.value = state.dates }
  const dn = q('[data-fm-dn]')
  if (dn) dn.textContent = state.dates
  const ppb = q('[data-fm-ppb]')
  if (ppb) ppb.textContent = ppbText(h, f)
  const to = q('[data-fm-field="dateTo"]')
  if (to) to.min = h.dateFrom // checkout can't precede check-in
  const totals = q('[data-fm-totals]')
  if (totals) totals.innerHTML = totalsHTML(f)
  art.querySelectorAll('[data-fm-rasg]').forEach((el, i) => {
    if (h.rooms[i] && f.rooms[i]) el.innerHTML = asgHTML(h.rooms[i], f.rooms[i], h.use)
  })
}
