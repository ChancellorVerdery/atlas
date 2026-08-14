// Ladder plugin UI: a continuous vertical timeline. Time flows down through
// the whole window; each midnight is a line drawn ACROSS the page — an event
// spanning midnight stays one card and the line crosses it at the proportional
// spot. The time→pixel map is piecewise-linear: mostly linear (sparse stretches
// look like clock time), but a tightly-packed region gets its y-axis EXPANDED
// so every card clears a readable minimum instead of overlapping into a pile.

import { loadLadder, saveLadder, addFlex, updateFlex, removeFlex, setGapOverride, buildPlan, dateKey, WEEKDAYS } from './ladder.js'
import { ensureCalendar, createEvent, deleteEvent, tz } from './calendar.js'
import { isConnected } from './email.js'
import { confirmDelete } from './confirm.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const MIN = 60000
const PPM = 0.75 // px per minute → 1080px per day (the baseline, sparse rate)
// Below this, a card's own title line (12.5px text + 4px padding top/bottom +
// 1px border top/bottom) starts getting clipped by overflow:hidden. The y-map
// guarantees every block's span maps to at least this many pixels — a dense
// cluster stretches the axis rather than letting any card fall below it.
const MIN_CARD_H = 24

// Piecewise-linear time→pixel map for one plan. Baseline is PPM everywhere (so
// open stretches of the day render exactly like linear clock time), but any run
// of blocks so tight that they'd each fall under MIN_CARD_H gets that region
// stretched until every block clears the floor. Monotonic, so ordering and the
// midnight-line-through-a-card geometry are preserved; a block's own height is
// then simply y(end) − y(start), always ≥ MIN_CARD_H, no per-card fudging.
function buildYMap(blocks, windowStart, windowEnd) {
  const times = new Set([windowStart, windowEnd])
  const spans = []
  for (const b of blocks) {
    const s = Math.max(b.start, windowStart), e = Math.min(b.end, windowEnd)
    if (e <= s) continue
    times.add(s); times.add(e)
    spans.push({ s, e })
  }
  const T = [...times].sort((a, z) => a - z)
  const m = T.length
  const idx = new Map(T.map((t, i) => [t, i]))
  const endsAt = new Map() // boundary index → [start indices of blocks ending there]
  for (const sp of spans) {
    const hi = idx.get(sp.e)
    ;(endsAt.get(hi) || endsAt.set(hi, []).get(hi)).push(idx.get(sp.s))
  }
  const Y = new Array(m)
  Y[0] = 0
  for (let i = 1; i < m; i++) {
    Y[i] = Y[i - 1] + ((T[i] - T[i - 1]) / MIN) * PPM // never compressed below clock rate
    for (const lo of endsAt.get(i) || []) Y[i] = Math.max(Y[i], Y[lo] + MIN_CARD_H)
  }
  const y = (t) => {
    if (t <= T[0]) return Y[0] + ((t - T[0]) / MIN) * PPM
    if (t >= T[m - 1]) return Y[m - 1] + ((t - T[m - 1]) / MIN) * PPM
    let lo = 0, hi = m - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= t) lo = mid; else hi = mid }
    return Y[lo] + ((t - T[lo]) / (T[hi] - T[lo])) * (Y[hi] - Y[lo])
  }
  return { y, total: Y[m - 1] }
}
const time12 = (ms) => {
  const d = new Date(ms)
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}
// compact: must fit the 56px time gutter so it never overlaps a card that
// crosses midnight (the label sits right where such a card's body is)
const dayLabel = (ms) => {
  const d = new Date(ms)
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getMonth() + 1}/${d.getDate()}`
}

// "2:00" or "90" → minutes
const parseDur = (v) => {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(v).trim())
  if (m) return Number(m[1]) * 60 + Number(m[2])
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

let seq = 0 // render generation — a stale async plan must not paint over a newer one
// Editing an existing flex/set event reuses the add bar: its fields prefill
// from the event, the Add button becomes Save, and a Cancel button appears.
// Cleared on save, cancel, or navigating away.
let editingId = null

export function renderLadderPage(root, rerender) {
  const s = loadLadder()
  const mySeq = ++seq
  // ef = the flex entry being edited, if any — prefills the bar below.
  const ef = editingId ? s.flex.find((f) => f.id === editingId) : null
  if (editingId && !ef) editingId = null // its block/day fell out of the window or was deleted
  const anchorVal = ef ? (ef.anchorTag ? `tag:${ef.anchorTag}` : ef.anchorSeries ? `series:${ef.anchorSeries}` : ef.anchorId ? `id:${ef.anchorId}` : '') : ''
  const sel = (v, cur) => v === cur ? ' selected' : ''
  root.innerHTML = `<div class="lad">
    <div class="lad-bar">
      <input class="pw-field lad-title" id="lad-new-title" placeholder="Flexible event, e.g. Project work" aria-label="Event title" value="${esc(ef ? ef.title : '')}">
      <input class="pw-field wk-num" id="lad-new-dur" placeholder="h:mm" title="Duration (h:mm or minutes)" aria-label="Duration" value="${ef && ef.kind !== 'set' ? esc(ef.minutes) : ''}">
      <select class="pw-field" id="lad-new-kind" aria-label="When">
        <option value="week"${sel('week', ef?.kind || 'week')}>Anytime this window</option>
        <option value="day"${sel('day', ef?.kind)}>Specific day</option>
        <option value="recur"${sel('recur', ef?.kind)}>Every week on…</option>
        <option value="attached"${sel('attached', ef?.kind)}>Attached to…</option>
        <option value="set"${sel('set', ef?.kind)}>Set event (fixed time)</option>
      </select>
      <input class="pw-field" id="lad-new-date" type="date" value="${esc(ef?.date || dateKey(Date.now()))}" hidden aria-label="Day">
      <input class="pw-field wk-num" id="lad-new-start" type="time" value="${esc(ef?.start || '')}" hidden aria-label="Start time" title="Start time">
      <input class="pw-field wk-num" id="lad-new-end" type="time" value="${esc(ef?.end || '')}" hidden aria-label="End time" title="End time">
      <input class="pw-field lad-addr" id="lad-new-addr" placeholder="Address (optional — for drive time)" value="${esc(ef?.addr || '')}" hidden aria-label="Address">
      <select class="pw-field" id="lad-new-weekday" hidden aria-label="Weekday">
        ${WEEKDAYS.map((d, i) => `<option value="${i}"${sel(i, ef?.weekday)}>${d}</option>`).join('')}
      </select>
      <select class="pw-field" id="lad-new-side" hidden aria-label="Attach side" title="Pair to the front or the back of the anchor">
        <option value="after"${sel('after', ef?.side || 'after')}>After</option>
        <option value="before"${sel('before', ef?.side)}>Before</option>
      </select>
      <select class="pw-field" id="lad-new-anchor" hidden aria-label="Anchor event" title="What this event is paired to" data-want="${esc(anchorVal)}"></select>
      <select class="pw-field" id="lad-new-place" hidden aria-label="Where it happens" title="Where the paired block happens — 'at home'/'at the office' pulls that drive in between">
        <option value="home"${sel('home', ef?.place || 'home')}>at home</option>
        <option value="office"${sel('office', ef?.place)}>at the office</option>
        <option value="same"${sel('same', ef?.place)}>at the same place</option>
        <option value="none"${sel('none', ef?.place)}>no place</option>
      </select>
      <button type="button" class="gym-btn" data-lad="add">${ef ? 'Save changes' : 'Add'}</button>
      <button type="button" class="gym-btn lad-cancel-edit" data-lad="cancel-edit"${ef ? '' : ' hidden'}>Cancel</button>
      <button type="button" class="gym-btn lad-push-all" data-lad="push-all" title="Push every day of the plan to your Google calendars">Push all to calendar</button>
      <span class="gf-status" id="lad-status">Planning…</span>
    </div>
    <div class="lad-notices" id="lad-notices"></div>
    <div class="lad-scroll"><div class="lad-canvas" id="lad-canvas"></div></div>
  </div>`

  const kindSel = root.querySelector('#lad-new-kind')
  const syncKindVisibility = () => {
    const k = kindSel.value
    root.querySelector('#lad-new-date').hidden = !(k === 'day' || k === 'set')
    root.querySelector('#lad-new-start').hidden = k !== 'set'
    root.querySelector('#lad-new-end').hidden = k !== 'set'
    root.querySelector('#lad-new-addr').hidden = k !== 'set'
    root.querySelector('#lad-new-dur').hidden = k === 'set' // a set event's length is its start→end, not a duration
    root.querySelector('#lad-new-weekday').hidden = k !== 'recur'
    root.querySelector('#lad-new-title').placeholder = k === 'set' ? 'Set event, e.g. Dentist' : 'Flexible event, e.g. Project work'
    for (const id of ['lad-new-side', 'lad-new-anchor', 'lad-new-place']) root.querySelector('#' + id).hidden = k !== 'attached'
  }
  kindSel.onchange = syncKindVisibility
  syncKindVisibility() // also applies when editing preloads a non-default kind
  root.onclick = async (e) => {
    const el = e.target.closest('[data-lad]')
    if (!el) return
    if (el.dataset.lad === 'add') {
      const title = root.querySelector('#lad-new-title').value
      const kind = root.querySelector('#lad-new-kind').value
      const minutes = parseDur(root.querySelector('#lad-new-dur').value)
      if (!title.trim() || (kind !== 'set' && !minutes)) return
      const anchorSel = root.querySelector('#lad-new-anchor')
      const fields = {
        title, minutes, kind,
        date: root.querySelector('#lad-new-date').value,
        start: root.querySelector('#lad-new-start').value,
        end: root.querySelector('#lad-new-end').value,
        addr: root.querySelector('#lad-new-addr').value,
        weekday: root.querySelector('#lad-new-weekday').value,
        side: root.querySelector('#lad-new-side').value,
        anchor: anchorSel.value,
        anchorLabel: anchorSel.selectedOptions[0]?.textContent || '',
        place: root.querySelector('#lad-new-place').value,
      }
      const saved = editingId ? updateFlex(loadLadder(), editingId, fields) : addFlex(loadLadder(), fields)
      if (saved) { editingId = null; renderLadderPage(root, rerender) }
    } else if (el.dataset.lad === 'cancel-edit') {
      editingId = null
      renderLadderPage(root, rerender)
    } else if (el.dataset.lad === 'edit-flex') {
      editingId = el.dataset.id
      renderLadderPage(root, rerender)
    } else if (el.dataset.lad === 'del-flex') {
      if (!(await confirmDelete('Remove this flexible event?'))) return
      if (editingId === el.dataset.id) editingId = null
      removeFlex(loadLadder(), el.dataset.id)
      renderLadderPage(root, rerender)
    } else if (el.dataset.lad === 'push-day') {
      pushDays([el.dataset.day], root, rerender)
    } else if (el.dataset.lad === 'remove-day') {
      removeDayFromCalendar(el.dataset.day, root, rerender)
    } else if (el.dataset.lad === 'push-all') {
      const days = lastPlan ? [...Array(lastPlan.days).keys()].map((i) => dateKey(lastPlan.windowStart + i * 86400000)) : []
      pushDays(days, root, rerender)
    }
  }
  root.onchange = (e) => {
    const el = e.target.closest('[data-lad="gap-override"]')
    if (!el) return
    setGapOverride(loadLadder(), el.dataset.id, el.value)
    renderLadderPage(root, rerender)
  }

  buildPlan().then((plan) => {
    if (seq !== mySeq || !root.isConnected) return // navigated away / re-rendered
    if (localStorage.getItem('atlas.devMode') === '1') window.__ladder = plan // test hook
    drawPlan(root, plan, s)
  }).catch((err) => {
    const st = root.querySelector('#lad-status')
    if (st) st.textContent = err.message
  })
}

function drawPlan(root, plan, s) {
  const canvas = root.querySelector('#lad-canvas')
  const status = root.querySelector('#lad-status')
  const notices = root.querySelector('#lad-notices')
  if (!canvas) return
  lastPlan = plan // the calendar-push buttons read the latest plan from here

  // anchor choices for "Attached to…": every-instance tags + the window's
  // actual upcoming events, straight from the plan just built
  const anchorSel = root.querySelector('#lad-new-anchor')
  if (anchorSel) {
    // sleep anchoring is the "every sleep" tag (a nightly routine); listing all
    // 7 identical "Sleep" blocks as specific events would just be clutter.
    const specific = plan.blocks.filter((b) => ['cal', 'shift', 'gym', 'set'].includes(b.type) && !b.attached)
    // auto-detected recurring calendar events: one entry per series (Google's
    // recurringEventId), so you pair to EVERY occurrence, not one instance
    const series = new Map()
    for (const b of plan.blocks) if (b.type === 'cal' && b.recurringId && !series.has(b.recurringId)) series.set(b.recurringId, b.title)
    // keep = whatever's already selected (re-render after a push, etc); want =
    // the value an edit-in-progress wants prefilled (set once by
    // renderLadderPage, consumed here since the options don't exist yet then)
    const keep = anchorSel.value || anchorSel.dataset.want
    anchorSel.innerHTML = `<optgroup label="Every…">
        <option value="tag:gym">every gym session</option>
        <option value="tag:shift">every work shift</option>
        <option value="tag:cal">every calendar event</option>
        <option value="tag:sleep">every sleep</option>
      </optgroup>
      ${series.size ? `<optgroup label="Every recurring event">
        ${[...series].map(([id, title]) => `<option value="series:${esc(id)}">every “${esc(title)}”</option>`).join('')}
      </optgroup>` : ''}
      <optgroup label="One specific event">
        ${specific.map((b) => `<option value="id:${esc(b.id)}">${esc(b.title)} · ${esc(dayLabel(b.start))} ${time12(b.start)}</option>`).join('')}
      </optgroup>`
    if (keep && [...anchorSel.options].some((o) => o.value === keep)) anchorSel.value = keep
    delete anchorSel.dataset.want
  }
  const { y, total } = buildYMap(plan.blocks, plan.windowStart, plan.windowEnd)
  if (window.__ladder === plan) window.__ladder.y = y // test hook: query mapped positions
  canvas.style.height = `${total}px`

  const flexById = new Map(loadLadder().flex.map((f) => [f.id, f]))
  const pushedMap = loadLadder().pushed || {}
  let html = ''

  // hour marks every 3h + day boundary lines with date labels, plus each day's
  // calendar buttons: push that day (or re-push to update), and — once pushed —
  // remove it from the calendars again.
  for (let d = 0; d < plan.days; d++) {
    const day = plan.windowStart + d * 86400000
    const dk = dateKey(day)
    const isPushed = (pushedMap[dk] || []).length > 0
    html += `<div class="lad-daylabel" style="top:${y(day) + 4}px">${esc(dayLabel(day))}</div>`
    html += `<div class="lad-daybtns" style="top:${y(day) + 2}px">
      <button type="button" class="lad-daybtn${isPushed ? ' is-pushed' : ''}" data-lad="push-day" data-day="${dk}" title="${isPushed ? 'Update this day on your calendars' : 'Push this day to your calendars'}">${isPushed ? '↻ update' : '＋ calendar'}</button>
      ${isPushed ? `<button type="button" class="lad-daybtn lad-daybtn--rm" data-lad="remove-day" data-day="${dk}" title="Remove this day from your calendars">✕ remove</button>` : ''}
    </div>`
    if (d > 0) html += `<div class="lad-dayline" style="top:${y(day)}px"></div>`
    for (let h = 3; h < 24; h += 3) {
      html += `<div class="lad-hour" style="top:${y(day + h * 3600000)}px">${h % 12 || 12}${h < 12 ? 'am' : 'pm'}</div>`
    }
  }

  for (const b of plan.blocks) {
    // The y-map already guarantees every block's span is ≥ MIN_CARD_H pixels
    // (dense regions were stretched to make room), so a card is simply its
    // mapped top→bottom — no per-card min-height fudging or anchoring, and a
    // drive's bottom lands exactly on its destination's top by construction.
    const top = y(Math.max(b.start, plan.windowStart))
    const h = y(Math.min(b.end, plan.windowEnd)) - top
    const dur = Math.round((b.end - b.start) / MIN)
    const durTxt = dur >= 60 ? `${Math.floor(dur / 60)}:${String(dur % 60).padStart(2, '0')}` : `${dur}m`
    if (b.type === 'sleep') {
      html += `<div class="lad-sleep" style="top:${top}px;height:${h}px"><span>Sleep</span><span class="lad-sleep__time">${time12(b.start)} – ${time12(b.end)} · ${durTxt}</span></div>`
      continue
    }
    if (b.type === 'drive') {
      // An independent block in its own right: full card, own borders. It
      // still ends exactly where its destination starts (adjacent, not fused)
      // and carries the destination's accent + name so the pairing is obvious.
      // Always one line, so it shows in full regardless of how thin it is.
      // b.start..b.end already spans drive+cushion (the block IS that whole
      // window), so the plain time range shown here already includes it —
      // no separate "+N min cushion" arithmetic needed in the label itself.
      // A settings-defined destination (toPlace) collapses to its place word;
      // "home" reads "drive home" (no "to"), work/gym read "drive to …".
      const place = b.toPlace || (b.toType === 'sleep' ? 'home' : null)
      const dest = place === 'home' ? 'home' : place === 'work' ? 'to work' : place === 'gym' ? 'to the gym' : `to ${esc(b.toTitle)}`
      const destName = place === 'home' ? 'home' : place === 'work' ? 'work' : place === 'gym' ? 'the gym' : esc(b.toTitle)
      // Gaps whose choice was actually decided (gapId set — the leg that
      // arrives at the real next block, not a synthetic there-and-back "out"
      // leg) get a small override control: force wait/home/office/straight,
      // or clear back to Auto. Reads/writes s.gapOverrides via setGapOverride.
      const gapCtl = b.gapId ? `<select class="lad-gap-ovr" data-lad="gap-override" data-id="${esc(b.gapId)}" title="Override how this gap between events is spent">
        <option value=""${b.gapForced ? '' : ' selected'}>Auto · ${esc(b.gapChoice)}</option>
        <option value="wait"${b.gapForced && b.gapChoice === 'wait' ? ' selected' : ''}>Wait there</option>
        <option value="home"${b.gapForced && b.gapChoice === 'home' ? ' selected' : ''}>Go home</option>
        <option value="office"${b.gapForced && b.gapChoice === 'office' ? ' selected' : ''}>Go to office</option>
        <option value="straight"${b.gapForced && b.gapChoice === 'straight' ? ' selected' : ''}>Straight there</option>
      </select>` : ''
      html += `<div class="lad-card lad-card--drive lad-drive--to-${esc(b.toType)}${gapCtl ? ' lad-card--drive-ovr' : ''}" style="top:${top}px;height:${h}px" title="Drive ${destName} · ${time12(b.start)}–${time12(b.end)} (${b.mins} min drive + ${b.minutes - b.mins} min cushion)">
        <span class="lad-card__title">${time12(b.start)} – ${time12(b.end)} drive ${dest}</span>${gapCtl}</div>`
      continue
    }
    const editable = b.flexId && flexById.has(b.flexId)
    const compact = h < 34
    // The delete × sits dead-center on the y-axis for a short (compact) card —
    // .lad-card__x's plain top:4px offset looks fine on a normal-height card
    // (anchored by the title line near the top) but on a card barely taller
    // than the button itself, that fixed offset pushes it visibly off-center
    // and can even clip it against the card's overflow:hidden bottom edge.
    const del = editable
      ? `<button type="button" class="pw-item-remove lad-card__x${compact ? ' lad-card__x--mid' : ''}" data-lad="del-flex" data-id="${esc(b.flexId)}" title="Remove flexible event">×</button>` : ''
    // Calendar cards show their event's location; red when it couldn't be
    // geocoded (so the user knows to add an alias in Settings). The happy-path
    // line needs room; the NOT-FOUND warning always shows, even on short cards.
    const loc = b.type === 'cal' && b.place && (h >= 48 || !b.loc)
      ? `<span class="lad-card__loc${b.loc ? '' : ' lad-card__loc--bad'}"${b.loc ? '' : ' title="Address not found — add a location alias in Ladder → Settings for drive times"'}>◦ ${esc(b.place)}${b.loc ? '' : ' · not found'}</span>` : ''
    // paired (attached) blocks say what they're tied to. Their time is worth
    // showing even on a compact card — unlike a fixed calendar event, an
    // attached block's time is COMPUTED (it rides the anchor + any drive leg),
    // so it's the one thing about the card you can't already guess.
    const pair = b.attached ? `⧉ ` : ''
    const pairTip = b.attached ? ` — attached ${esc(b.side)} “${esc(b.anchorTitle)}”` : ''
    const compactAttachedTime = compact && b.attached ? ` · ${time12(b.start)}–${time12(b.end)}` : ''
    // Editable cards (anything created within the Ladder — flex/day/recur/
    // week/attached/set) open the add bar pre-filled for editing on click;
    // the delete × (its own data-lad) still wins when that's what's clicked.
    const editAttr = editable ? ` data-lad="edit-flex" data-id="${esc(b.flexId)}"` : ''
    html += `<div class="lad-card lad-card--${esc(b.type)}${b.attached ? ' lad-card--attached' : ''}${editable ? ' lad-card--editable' : ''}" style="top:${top}px;height:${h}px"${editAttr} title="${esc(b.title)} · ${time12(b.start)}–${time12(b.end)}${b.place ? ` · ${esc(b.place)}` : ''}${pairTip}${editable ? ' — click to edit' : ''}">
      ${del}
      <span class="lad-card__title">${pair}${esc(b.title)}${compactAttachedTime}</span>
      ${compact ? '' : `<span class="lad-card__time">${time12(b.start)} – ${time12(b.end)} · ${durTxt}${b.attached ? ` · with ${esc(b.anchorTitle)}` : ''}</span>`}
      ${loc}
    </div>`
  }

  const now = Date.now()
  if (now > plan.windowStart && now < plan.windowEnd) {
    html += `<div class="lad-nowline" style="top:${y(now)}px"></div>`
  }
  canvas.innerHTML = html

  const flexCount = plan.blocks.filter((b) => b.type === 'flex' || b.type === 'meal' || b.type === 'gym').length
  if (status) {
    // flashMsg carries a one-shot result ("Pushed 3 days…") across the re-render
    // that follows a calendar push, since that rebuild resets the status line.
    status.textContent = `${plan.days} days · ${plan.blocks.filter((b) => b.type !== 'sleep' && b.type !== 'drive').length} blocks · ${flexCount} placed${flashMsg ? ` · ${flashMsg}` : ''}`
    status.classList.add('is-live')
    flashMsg = null
  }
  if (notices) {
    notices.innerHTML =
      (plan.unplaced.length ? `<p class="lad-notice lad-notice--warn">Couldn't fit: ${plan.unplaced.map((u) => `${esc(u.title)} (${u.minutes}m, ${esc(u.when)})`).join(' · ')}</p>` : '') +
      (plan.warnings.length ? `<p class="lad-notice">${plan.warnings.map(esc).join(' · ')}</p>` : '')
  }
  // scroll to now (or the window start if now is outside it)
  const scroll = root.querySelector('.lad-scroll')
  if (scroll && now > plan.windowStart) scroll.scrollTop = Math.max(0, y(now) - 160)
}

// ---- pushing the plan to Google Calendar ------------------------------------
// Each block type routes to its own calendar ("folder") so the plan never
// crowds the primary one. Synced blocks (cal events, work shifts) are NEVER
// pushed — they're already on the calendar; re-pushing would duplicate them.
let lastPlan = null   // latest built plan, set by drawPlan — buttons read it
let flashMsg = null   // one-shot status suffix that survives the next re-render

const PUSHABLE = new Set(['sleep', 'gym', 'meal', 'flex', 'set', 'drive'])
const CAL_NAME = { gym: 'Atlas Gym', drives: 'Atlas Drives', ladder: 'Atlas Ladder' }
// gym is the only pushed anchor type with its own folder, so a block attached
// to a gym session rides into the gym calendar; everything else → ladder.
const folderKey = (b) => b.type === 'drive' ? 'drives'
  : (b.type === 'gym' || (b.attached && String(b.anchorId || '').startsWith('gym-'))) ? 'gym'
  : 'ladder'

const isoLocal = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`
}
const summaryFor = (b) => {
  if (b.type === 'sleep') return 'Sleep'
  if (b.type === 'drive') {
    const place = b.toPlace || (b.toType === 'sleep' ? 'home' : null)
    return place === 'home' ? 'Drive home' : place === 'work' ? 'Drive to work' : place === 'gym' ? 'Drive to the gym' : `Drive to ${b.toTitle}`
  }
  return b.title
}
const setStatus = (root, txt) => { const st = root.querySelector('#lad-status'); if (st) st.textContent = txt }

async function ensureCals(s, needed) {
  let changed = false
  for (const k of needed) if (!s.calIds[k]) { s.calIds[k] = await ensureCalendar(CAL_NAME[k]); changed = true }
  if (changed) saveLadder(s)
}
async function deletePushed(s, dayKey) {
  for (const { calId, id } of s.pushed[dayKey] || []) await deleteEvent(calId, id).catch(() => {})
  delete s.pushed[dayKey]
}

async function pushDays(dayKeys, root, rerender) {
  if (!isConnected()) { setStatus(root, 'Connect Google in Email settings to push to your calendar.'); return }
  if (!lastPlan || !dayKeys.length) return
  setStatus(root, 'Pushing to calendar…')
  try {
    // group each day's pushable blocks (by their start day — a night's sleep
    // rides with the day you go to bed)
    const byDay = new Map(dayKeys.map((d) => [d, []]))
    for (const b of lastPlan.blocks) {
      if (!PUSHABLE.has(b.type)) continue
      const d = dateKey(b.start)
      if (byDay.has(d)) byDay.get(d).push(b)
    }
    const s = loadLadder()
    const needed = new Set()
    for (const blocks of byDay.values()) for (const b of blocks) needed.add(folderKey(b))
    await ensureCals(s, needed)
    for (const [day, blocks] of byDay) {
      await deletePushed(s, day) // replace, never duplicate on re-push
      const created = []
      for (const b of blocks) {
        const calId = s.calIds[folderKey(b)]
        const ev = await createEvent(calId, {
          summary: summaryFor(b),
          start: { dateTime: isoLocal(b.start), timeZone: tz },
          end: { dateTime: isoLocal(b.end), timeZone: tz },
        })
        created.push({ calId, id: ev.id })
      }
      s.pushed[day] = created
    }
    saveLadder(s)
    flashMsg = `pushed ${dayKeys.length} day${dayKeys.length === 1 ? '' : 's'} to calendar`
  } catch (err) {
    flashMsg = `couldn't push — ${err.message}`
  }
  renderLadderPage(root, rerender)
}

async function removeDayFromCalendar(dayKey, root, rerender) {
  setStatus(root, 'Removing from calendar…')
  try {
    const s = loadLadder()
    await deletePushed(s, dayKey)
    saveLadder(s)
    flashMsg = 'removed that day from calendar'
  } catch (err) {
    flashMsg = `couldn't remove — ${err.message}`
  }
  renderLadderPage(root, rerender)
}

// ---- settings tab ------------------------------------------------------------------

export function renderLadderSettings(container, rerender) {
  const s = loadLadder()
  container.innerHTML = `<div class="page gym-settings lad-settings">
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Home address</span>
        <span class="set-row__sub">Where each day starts and ends — the anchor for drive times.</span></div>
      <input class="pw-field lad-addr" data-lad-set="home" value="${esc(s.home)}" placeholder="Street, city…" aria-label="Home address">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Default wake time</span>
        <span class="set-row__sub">A fallback only — each morning’s real wake is your bedtime plus your sleep need, so it shifts when a late night or early event forces it. Bedtime and sleep length live in the Sleep plugin.</span></div>
      <input class="pw-field" type="time" data-lad-set="wake" value="${esc(s.wake)}" aria-label="Default wake time">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Planning window</span>
        <span class="set-row__sub">How many days ahead the planner schedules (rolling, starting today).</span></div>
      <input class="pw-field wk-num" type="number" min="1" max="31" data-lad-set="windowDays" value="${esc(s.windowDays)}" aria-label="Window days">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Drive-time cushion</span>
        <span class="set-row__sub">Minutes added to every drive — walking to the car, parking, elevators.</span></div>
      <input class="pw-field wk-num" type="number" min="0" step="1" data-lad-set="buffer" value="${esc(s.buffer)}" aria-label="Drive buffer minutes">
    </div>

    <p class="gym-group">Between-event travel (a gap can wait where you are, or send you home/to the office and back)</p>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Trip-home dwell floor</span>
        <span class="set-row__sub">A gap only routes you home or to the office if you'd actually get at least this much real time there, after both drive legs — otherwise the planner just keeps you where you are.</span></div>
      <input class="pw-field wk-num" type="number" min="0" step="5" data-lad-set="dwellFloorMin" value="${esc(s.dwellFloorMin)}" aria-label="Dwell floor minutes">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Round-trip drive cap</span>
        <span class="set-row__sub">The round trip home/to office must cost less than this share of the gap (0–1) to be worth it — e.g. 0.5 means under half the gap spent driving.</span></div>
      <input class="pw-field wk-num" type="number" min="0.05" max="1" step="0.05" data-lad-set="roundTripFrac" value="${esc(s.roundTripFrac)}" aria-label="Round-trip fraction cap">
    </div>
    <p class="gym-sub">Overrides per gap live right on its drive card in the timeline. Job type (shift vs. salary — shift never routes home/office mid-shift) is set in <a href="#/work/settings">Work → Settings</a>.</p>

    <p class="gym-group">Meals (flexible — placed near their preferred time)</p>
    ${s.meals.map((m) => `<div class="gym-add-row" data-meal-id="${esc(m.id)}">
      <input class="pw-field" data-lad-meal="name" value="${esc(m.name)}" aria-label="Meal name">
      <input class="pw-field" type="time" data-lad-meal="pref" value="${esc(m.pref)}" aria-label="Preferred time">
      <input class="pw-field wk-num" type="number" min="5" step="5" data-lad-meal="duration" value="${esc(m.duration)}" aria-label="Minutes">
      <label class="gym-check"><input type="checkbox" data-lad-meal="enabled"${m.enabled ? ' checked' : ''}> on</label>
      <button type="button" class="pw-item-remove" data-lad-set="meal-remove" data-id="${esc(m.id)}" title="Remove meal">×</button>
    </div>`).join('')}
    <div class="gym-add-row">
      <button type="button" class="gym-btn" data-lad-set="meal-add">+ Add meal</button>
    </div>

    <p class="gym-group">Location aliases (fix event locations that don't geocode)</p>
    <p class="gym-sub">When an event's location or title contains the match text, the planner uses your address instead — e.g. match “Fretwell” → your campus street address. Room-style locations often geocode wrong or not at all.</p>
    ${s.aliases.map((a) => `<div class="gym-add-row" data-alias-id="${esc(a.id)}">
      <input class="pw-field" data-lad-alias="match" value="${esc(a.match || '')}" placeholder="Text to match (e.g. Fretwell)" aria-label="Alias match text">
      <span class="wk-or">→</span>
      <input class="pw-field lad-addr" data-lad-alias="address" value="${esc(a.address || '')}" placeholder="Real address" aria-label="Alias address">
      <button type="button" class="pw-item-remove" data-lad-set="alias-remove" data-id="${esc(a.id)}" title="Remove alias">×</button>
    </div>`).join('')}
    <div class="gym-add-row">
      <button type="button" class="gym-btn" data-lad-set="alias-add">+ Add alias</button>
    </div>

    <p class="gym-group">Pulled from other plugins</p>
    <p class="gym-sub">Gym sessions: address, hours and historic durations from <a href="#/gym/settings">Gym → Settings</a>.
    Work shifts and address: <a href="#/work/settings">Work → Settings</a> and the Upcoming shifts widget.</p>
  </div>`

  container.onclick = (e) => {
    const el = e.target.closest('[data-lad-set]')
    if (!el) return
    const s2 = loadLadder()
    if (el.dataset.ladSet === 'meal-add') {
      s2.meals.push({ id: `lm-${Date.now().toString(36)}`, name: 'Meal', pref: '12:00', duration: 30, enabled: true })
      saveLadder(s2)
      renderLadderSettings(container, rerender)
    } else if (el.dataset.ladSet === 'meal-remove') {
      s2.meals = s2.meals.filter((m) => m.id !== el.dataset.id)
      saveLadder(s2)
      renderLadderSettings(container, rerender)
    } else if (el.dataset.ladSet === 'alias-add') {
      s2.aliases.push({ id: `la-${Date.now().toString(36)}`, match: '', address: '' })
      saveLadder(s2)
      renderLadderSettings(container, rerender)
    } else if (el.dataset.ladSet === 'alias-remove') {
      s2.aliases = s2.aliases.filter((a) => a.id !== el.dataset.id)
      saveLadder(s2)
      renderLadderSettings(container, rerender)
    }
  }
  container.oninput = (e) => {
    const s2 = loadLadder()
    const set = e.target.closest('[data-lad-set]')
    if (set && set.dataset.ladSet in s2) {
      const k = set.dataset.ladSet
      if (k === 'windowDays') s2[k] = Math.max(1, Number(set.value) || 0)
      else if (k === 'buffer' || k === 'dwellFloorMin') s2[k] = Math.max(0, Number(set.value) || 0)
      else if (k === 'roundTripFrac') s2[k] = Math.min(1, Math.max(0.05, Number(set.value) || 0))
      else s2[k] = set.value
      saveLadder(s2)
      return
    }
    const mealField = e.target.closest('[data-lad-meal]')
    if (mealField) {
      const m = s2.meals.find((x) => x.id === mealField.closest('[data-meal-id]').dataset.mealId)
      if (!m) return
      const f = mealField.dataset.ladMeal
      m[f] = f === 'enabled' ? mealField.checked : f === 'duration' ? Math.max(5, Number(mealField.value) || 30) : mealField.value
      saveLadder(s2)
      return
    }
    const aliasField = e.target.closest('[data-lad-alias]')
    if (aliasField) {
      const a = s2.aliases.find((x) => x.id === aliasField.closest('[data-alias-id]').dataset.aliasId)
      if (!a) return
      a[aliasField.dataset.ladAlias] = aliasField.value
      saveLadder(s2)
    }
  }
}
