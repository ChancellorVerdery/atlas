// Work plugin UI: widget bodies (shift log, income tracker, tip share
// calculator) and the work-scoped Settings tab. Data lives in work.js.

import {
  loadWork, saveWork, todayKey, fmtTime, isOpen, shiftHours, shiftEnd, shiftEarned,
  addShift, closeShift, updateShift, removeShift, projectedEnd, parseClock, parseHM, PERIODS, incomeFor, tipShare,
  rangeFor, setRange, addUpcoming, removeUpcoming, setUpcomingGcal,
} from './work.js'
import { ensureCalendar, createEvent, deleteEvent, tz } from './calendar.js'
import { isConnected } from './email.js'
import { confirmDelete } from './confirm.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const WK_KINDS = ['wkincome', 'wkshifts', 'wktipshare', 'wkupcoming', 'wkhistory']

const HISTORY_PAGE = 10 // logged shifts per page in the history widget

const money = (n) => '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fmtH = (n) => (Math.round(n * 100) / 100).toString()
const toHM = (n) => {
  const total = Math.round(n * 60)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
const shortDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`

// closed shifts, newest first (stable within a date, so same-day shifts keep entry order)
const loggedShifts = (s) =>
  [...s.shifts].filter((sh) => !isOpen(sh)).sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))

// per-widget session state (income range, tip-share inputs) — not persisted
const ui = new Map()
const st = (id, init) => {
  if (!ui.has(id)) ui.set(id, init())
  return ui.get(id)
}

// closed shifts currently flipped into their edit form (session-only)
const editingShifts = new Set()

// ---- widget bodies ----------------------------------------------------------

export function workWidgetHTML(w, cz) {
  const s = loadWork()
  const head = (t) => `<p class="gym-head">${t}</p>`

  // one logged/open shift row — shared by the shift log and the history widget
  const row = (sh) => {
    const h = shiftHours(sh)
    if (isOpen(sh)) {
      const proj = projectedEnd(s, sh)
      return `<div class="wk-row wk-row--open" data-shift-id="${esc(sh.id)}">
        <span class="wk-date">${shortDate(sh.date)}</span>
        <span class="wk-time">${fmtTime(sh.start)} → ${proj ? `~${fmtTime(proj)} <span class="wk-proj">proj.</span>` : '<span class="wk-proj">on the clock</span>'}</span>
        ${cz ? '' : `<input class="pw-field wk-num wk-out" type="time" aria-label="Actual out time" title="Out time" value="${esc(proj || '')}">
        <input class="pw-field wk-num wk-hours-out" type="text" inputmode="numeric" placeholder="or h:mm" aria-label="Total time worked" title="…or total time worked, e.g. 6:30 (used instead of the out time)">
        ${s.tips ? `<input class="pw-field wk-num wk-tips-in" type="number" min="0" step="0.01" placeholder="tips" aria-label="Tips">` : ''}
        <button type="button" class="gym-btn" data-wk-act="clock-out" data-id="${esc(sh.id)}">Log shift</button>`}
      </div>`
    }
    if (!cz && editingShifts.has(sh.id)) {
      return `<div class="wk-row wk-row--open" data-shift-id="${esc(sh.id)}">
        <input class="pw-field wk-num wk-edit-date" type="date" value="${esc(sh.date)}" aria-label="Date">
        <input class="pw-field wk-num wk-edit-start" type="time" value="${esc(sh.start)}" aria-label="Start time">
        <input class="pw-field wk-num wk-edit-end" type="time" value="${esc(sh.end)}" aria-label="End time">
        <input class="pw-field wk-num wk-edit-hours" type="text" inputmode="numeric" placeholder="or h:mm" value="${sh.hours != null ? esc(toHM(sh.hours)) : ''}" aria-label="Total time worked" title="…or total time worked, e.g. 6:30 (used instead of the out time)">
        ${s.tips ? `<input class="pw-field wk-num wk-edit-tips" type="number" min="0" step="0.01" placeholder="tips" value="${esc(sh.tips || '')}" aria-label="Tips">` : ''}
        <button type="button" class="gym-btn" data-wk-act="save-shift" data-id="${esc(sh.id)}">Save</button>
        <button type="button" class="pw-item-remove" data-wk-act="cancel-edit" data-id="${esc(sh.id)}" title="Cancel edit">×</button>
      </div>`
    }
    const end = shiftEnd(sh)
    return `<div class="wk-row" data-shift-id="${esc(sh.id)}">
      <span class="wk-date">${shortDate(sh.date)}</span>
      <span class="wk-time">${sh.start && end ? `${fmtTime(sh.start)}–${fmtTime(end)}` : ''} ${h != null ? `· ${toHM(h)}` : ''}</span>
      <span class="wk-earned">${money(shiftEarned(sh))}${s.tips && sh.tips ? ` <span class="wk-proj">(${money(sh.tips)} tips)</span>` : ''}</span>
      ${cz ? '' : `<button type="button" class="gym-btn gym-btn--sm" data-wk-act="edit-shift" data-id="${esc(sh.id)}" title="Edit shift">Edit</button>
      <button type="button" class="pw-item-remove" data-wk-act="del-shift" data-id="${esc(sh.id)}" title="Delete shift">×</button>`}
    </div>`
  }

  if (w.kind === 'wkincome') {
    const range = rangeFor(s, w.id)
    const inc = incomeFor(s, range)
    const pills = PERIODS.map(([k, label]) =>
      `<button type="button" class="wk-pill${k === range ? ' is-on' : ''}" data-wk-range="${k}" data-wid="${esc(w.id)}">${label}</button>`).join('')
    return head('Income') + `<div class="wk-pills">${pills}</div>
      <div class="gym-big gym-big--num">${money(inc.earned)}</div>
      <p class="gym-sub">${fmtH(inc.hours)}h · ${inc.count} shift${inc.count === 1 ? '' : 's'}${s.tips ? ` · ${money(inc.tips)} tips` : ''}${inc.hours ? ` · ${money(inc.earned / inc.hours)}/h` : ''}</p>`
  }

  if (w.kind === 'wktipshare') {
    if (!s.tips) return head('Tip share') + `<p class="gym-empty">Enable tip positions in Work → Settings to use the tip share calculator.</p>`
    const state = st(w.id, () => ({ pool: '', people: [{ name: '', hours: '' }, { name: '', hours: '' }] }))
    const rows = state.people.map((p, i) => `<div class="wk-ts-row" data-wid="${esc(w.id)}" data-i="${i}">
      <input class="pw-field" data-wk-ts="name" placeholder="Name" value="${esc(p.name)}" aria-label="Person name">
      <input class="pw-field wk-num" data-wk-ts="hours" type="text" inputmode="numeric" placeholder="h:mm" value="${esc(p.hours)}" aria-label="Hours worked" title="Hours worked — e.g. 6:30">
      <span class="wk-ts-share" data-ts-share></span>
      <button type="button" class="pw-item-remove" data-wk-act="ts-del" data-wid="${esc(w.id)}" data-i="${i}" title="Remove person">×</button>
    </div>`).join('')
    return head('Tip share') + `<div class="wk-ts" data-ts-wid="${esc(w.id)}">
      <div class="wk-ts-row wk-ts-row--pool" data-wid="${esc(w.id)}">
        <span class="wk-ts-poollabel">Tip pool</span>
        <input class="pw-field wk-num" data-wk-ts="pool" type="number" min="0" step="0.01" placeholder="0.00" value="${esc(state.pool)}" aria-label="Tip pool total">
        <span class="wk-ts-share" data-ts-total></span>
      </div>
      ${rows}
      <button type="button" class="pw-add-item" data-wk-act="ts-add" data-wid="${esc(w.id)}">+ Add person</button>
      <p class="gym-sub">Split weighted by hours worked.</p>
    </div>`
  }

  if (w.kind === 'wkupcoming') {
    const rows = [...s.upcoming]
      .sort((a, b) => (a.date === b.date ? (a.start < b.start ? -1 : 1) : a.date < b.date ? -1 : 1))
      .map((sh) => `<div class="wk-row" data-up-id="${esc(sh.id)}">
        <span class="wk-date">${shortDate(sh.date)}</span>
        <span class="wk-time">${fmtTime(sh.start)}–${fmtTime(sh.end)}${sh.endMode === 'auto' ? ' <span class="wk-proj" title="End predicted from your past shifts on this weekday">auto end</span>' : ''}${sh.gcalId ? '' : ' <span class="wk-proj">not on calendar</span>'}</span>
        ${cz ? '<span></span>' : `<button type="button" class="gym-btn gym-btn--sm" data-wk-act="log-upcoming" data-id="${esc(sh.id)}" title="${s.openEnded ? 'Clock in — this shift moves to your log; clock out later for the real end and tips' : 'Log this shift as worked with its scheduled times'}">Log</button>`}
        ${cz ? '' : `<button type="button" class="pw-item-remove" data-wk-act="del-upcoming" data-id="${esc(sh.id)}" title="Remove shift">×</button>`}
      </div>`).join('')
    const endTitle = s.openEnded
      ? 'End time — your estimate, or leave blank to predict it from your past shifts on that weekday'
      : 'End time'
    const form = cz ? '' : `<div class="wk-add">
      <input class="pw-field wk-datein" type="date" value="${todayKey()}" aria-label="Shift date">
      <input class="pw-field wk-num wk-up-start" type="text" inputmode="numeric" placeholder="start" aria-label="Start time" title="Start time — e.g. 9, 9am, 17:00">
      <input class="pw-field wk-num wk-up-end" type="text" inputmode="numeric" placeholder="end" aria-label="End time" title="${endTitle}">
      <button type="button" class="gym-btn" data-wk-act="add-upcoming">Add</button>
    </div>
    <p class="wk-up-msg gym-sub" role="status" hidden></p>`
    return head('Upcoming shifts') + form +
      (rows ? `<div class="wk-rows">${rows}</div>` : `<p class="gym-empty">No upcoming shifts scheduled.</p>`) +
      `<p class="gym-sub">Shifts land in their own “Atlas Work” calendar, and the Ladder planner blocks them.${s.openEnded ? ' Open-ended shift? Leave the end blank — it’s estimated from your history.' : ''}</p>`
  }

  if (w.kind === 'wkhistory') {
    const all = loggedShifts(s)
    if (!all.length) return head('Shift history') + `<p class="gym-empty">No logged shifts yet.</p>`
    const pages = Math.ceil(all.length / HISTORY_PAGE)
    const state = st(w.id, () => ({ page: 0 }))
    state.page = Math.min(Math.max(state.page, 0), pages - 1) // deletions can shrink past the last page
    const from = state.page * HISTORY_PAGE
    const shown = all.slice(from, from + HISTORY_PAGE)
    return head('Shift history') +
      `<div class="wk-rows wk-rows--log">${shown.map(row).join('')}</div>
      <div class="wk-page">
        <button type="button" class="gym-btn gym-btn--sm" data-wk-act="pg" data-wid="${esc(w.id)}" data-d="-1" ${state.page ? '' : 'disabled'} title="Newer shifts">‹</button>
        <span class="gym-sub">${from + 1}–${from + shown.length} of ${all.length}</span>
        <button type="button" class="gym-btn gym-btn--sm" data-wk-act="pg" data-wid="${esc(w.id)}" data-d="1" ${state.page < pages - 1 ? '' : 'disabled'} title="Older shifts">›</button>
      </div>`
  }

  // wkshifts — the shift log + entry form (last 3 only; the history widget pages the rest)
  const open = [...s.shifts].filter((sh) => isOpen(sh)).sort((a, b) => (a.date < b.date ? 1 : -1))
  const closed = loggedShifts(s).slice(0, 3)
  const form = cz ? '' : `<div class="wk-add">
    <input class="pw-field wk-datein" type="date" value="${todayKey()}" aria-label="Shift date">
    <input class="pw-field wk-num wk-startin" type="time" aria-label="Start time" title="Start time">
    <input class="pw-field wk-num wk-endin" type="time" aria-label="End time" title="End time${s.openEnded ? ' (optional — leave blank to stay on the clock)' : ''}">
    <span class="wk-or">or</span>
    <input class="pw-field wk-num wk-hoursin" type="text" inputmode="numeric" pattern="[0-9]{1,3}:[0-5][0-9]" placeholder="h:mm" title="Hours worked, e.g. 6:30" aria-label="Hours worked (h:mm)">
    ${s.tips ? `<input class="pw-field wk-num wk-tipsin" type="number" min="0" step="0.01" placeholder="tips" aria-label="Tips earned">` : ''}
    <button type="button" class="gym-btn" data-wk-act="add-shift">Add</button>
  </div>`
  return head('Shifts') + form +
    (open.length || closed.length
      ? `<div class="wk-rows wk-rows--log">${open.map(row).join('')}${closed.map(row).join('')}</div>`
      : `<p class="gym-empty">No shifts yet — log your first one above.</p>`)
}

// ---- interactions ------------------------------------------------------------

let rerenderApp = null

export function bindWork(rerender) {
  rerenderApp = rerender
  document.body.addEventListener('click', onWorkClick)
  document.body.addEventListener('input', onWorkInput)
}

async function onWorkClick(e) {
  const pill = e.target.closest('[data-wk-range]')
  if (pill) {
    setRange(loadWork(), pill.dataset.wid, pill.dataset.wkRange)
    rerenderApp?.()
    return
  }
  const act = e.target.closest('[data-wk-act]')
  if (!act) return
  const s = loadWork()
  const a = act.dataset.wkAct
  if (a === 'add-shift') {
    const box = act.closest('.wk-add')
    const start = box.querySelector('.wk-startin').value
    const end = box.querySelector('.wk-endin').value
    const hours = box.querySelector('.wk-hoursin').value
    if (!start && !hours) return
    if (start && !end && !s.openEnded) return // needs the open-ended setting
    addShift(s, { date: box.querySelector('.wk-datein').value, start, end, hours, tips: box.querySelector('.wk-tipsin')?.value })
    rerenderApp?.()
  } else if (a === 'clock-out') {
    const row = act.closest('.wk-row')
    const end = row.querySelector('.wk-out').value
    const hours = row.querySelector('.wk-hours-out')?.value.trim()
    if (!end && !hours) return
    closeShift(s, act.dataset.id, { end, hours, tips: row.querySelector('.wk-tips-in')?.value })
    rerenderApp?.()
  } else if (a === 'del-shift') {
    if (!(await confirmDelete('Delete this shift?'))) return
    removeShift(loadWork(), act.dataset.id)
    rerenderApp?.()
  } else if (a === 'edit-shift') {
    editingShifts.add(act.dataset.id)
    rerenderApp?.()
  } else if (a === 'save-shift') {
    const row = act.closest('.wk-row')
    updateShift(s, act.dataset.id, {
      date: row.querySelector('.wk-edit-date').value,
      start: row.querySelector('.wk-edit-start').value,
      end: row.querySelector('.wk-edit-end').value,
      hours: row.querySelector('.wk-edit-hours').value,
      tips: row.querySelector('.wk-edit-tips')?.value,
    })
    editingShifts.delete(act.dataset.id)
    rerenderApp?.()
  } else if (a === 'cancel-edit') {
    editingShifts.delete(act.dataset.id)
    rerenderApp?.()
  } else if (a === 'add-upcoming') {
    const box = act.closest('.wk-add')
    const msg = box.parentElement.querySelector('.wk-up-msg')
    const say = (t) => { if (msg) { msg.textContent = t; msg.hidden = !t } }
    const date = box.querySelector('.wk-datein').value
    const startRaw = box.querySelector('.wk-up-start').value.trim()
    const endRaw = box.querySelector('.wk-up-end').value.trim()
    const start = parseClock(startRaw)
    const end = endRaw ? parseClock(endRaw) : ''
    // Tell the user why nothing happened instead of silently no-op'ing.
    if (!date) return say('Pick a date.')
    if (!start) return say(startRaw ? `Couldn’t read “${startRaw}” — try 9, 9am, or 17:00.` : 'Add a start time.')
    if (endRaw && !end) return say(`Couldn’t read “${endRaw}” — try 5pm or 17:00.`)
    if (!end && !s.openEnded) return say('Add an end time, or turn on open-ended shifts in Work settings to predict it.')
    const sh = addUpcoming(s, { date, start, end })
    if (!sh) return say('No past shifts on that weekday yet — type an end time this once.')
    say('')
    rerenderApp?.()
    pushShiftToCalendar(sh).then(() => rerenderApp?.()).catch(() => {}) // stays local ("not on calendar") on failure
  } else if (a === 'log-upcoming') {
    const sh = s.upcoming.find((x) => x.id === act.dataset.id)
    if (!sh) return
    // Open-ended jobs: log as an open (clocked-in) shift so the real end +
    // tips are captured on clock-out. Fixed-schedule jobs: log completed with
    // the planned times. Only drop it from upcoming once it's actually logged.
    const logged = addShift(s, { date: sh.date, start: sh.start, end: s.openEnded ? '' : sh.end })
    if (!logged) return
    removeUpcoming(s, sh.id)
    rerenderApp?.()
    if (sh.gcalId && s.calId) deleteEvent(s.calId, sh.gcalId).catch(() => {})
  } else if (a === 'del-upcoming') {
    if (!(await confirmDelete('Remove this shift?'))) return
    const s2 = loadWork()
    const sh = s2.upcoming.find((x) => x.id === act.dataset.id)
    removeUpcoming(s2, act.dataset.id)
    rerenderApp?.()
    if (sh?.gcalId && s2.calId) deleteEvent(s2.calId, sh.gcalId).catch(() => {})
  } else if (a === 'pg') {
    const state = st(act.dataset.wid, () => ({ page: 0 }))
    state.page = Math.max(0, state.page + Number(act.dataset.d)) // upper bound is clamped at render
    rerenderApp?.()
  } else if (a === 'ts-add' || a === 'ts-del') {
    const state = st(act.dataset.wid, () => ({ pool: '', people: [] }))
    if (a === 'ts-add') state.people.push({ name: '', hours: '' })
    else state.people.splice(Number(act.dataset.i), 1)
    rerenderApp?.()
  }
}

// Auto-push a scheduled shift to the dedicated "Atlas Work" Google calendar
// (created on first use). Overnight shifts (end ≤ start) end the next day.
async function pushShiftToCalendar(sh) {
  const s = loadWork()
  if (!isConnected()) return
  if (!s.calId) {
    s.calId = await ensureCalendar('Atlas Work')
    saveWork(s)
  }
  const endDate = sh.end > sh.start ? sh.date : (() => {
    const d = new Date(sh.date + 'T12:00:00')
    d.setDate(d.getDate() + 1)
    return todayKey(d)
  })()
  const ev = await createEvent(s.calId, {
    summary: 'Work',
    start: { dateTime: `${sh.date}T${sh.start}:00`, timeZone: tz },
    end: { dateTime: `${endDate}T${sh.end}:00`, timeZone: tz },
  })
  setUpcomingGcal(loadWork(), sh.id, ev.id)
}

// Tip-share inputs recalc in place (no rerender — that would drop focus).
function onWorkInput(e) {
  const el = e.target.closest('[data-wk-ts]')
  if (!el) return
  const row = el.closest('.wk-ts-row')
  const state = st(row.dataset.wid, () => ({ pool: '', people: [] }))
  const f = el.dataset.wkTs
  if (f === 'pool') state.pool = el.value
  else state.people[Number(row.dataset.i)][f] = el.value
  const box = el.closest('.wk-ts')
  const shares = tipShare(state.pool, state.people)
  box.querySelectorAll('.wk-ts-row[data-i]').forEach((r, i) => {
    r.querySelector('[data-ts-share]').textContent = shares[i] ? money(shares[i].share) : ''
  })
  const total = state.people.reduce((t, p) => t + (parseHM(p.hours) || 0), 0)
  box.querySelector('[data-ts-total]').textContent = total ? `${toHM(total)} total` : ''
}

// ---- work settings tab ---------------------------------------------------------

export function renderWorkSettings(container, rerender) {
  const s = loadWork()
  const sw = (key, on) => `<button type="button" class="switch${on ? ' is-on' : ''}" role="switch" aria-checked="${on}" data-wk-set="${key}"><span class="switch__dot"></span></button>`
  container.innerHTML = `<div class="page gym-settings">
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Hourly wage</span>
        <span class="set-row__sub">Applies to new shifts — past shifts keep the wage they were logged at.</span></div>
      <input class="pw-field wk-num" id="wk-wage" type="number" min="0" step="0.25" value="${esc(s.wage || '')}" placeholder="0.00" aria-label="Hourly wage">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Tip position</span>
        <span class="set-row__sub">Shifts also ask for tips, income counts them, and the tip share calculator unlocks.</span></div>
      ${sw('tips', s.tips)}
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Work address</span>
        <span class="set-row__sub">Used by the Ladder planner for drive times to and from your shifts.</span></div>
      <input class="pw-field" id="wk-address" value="${esc(s.address)}" placeholder="Street, city…" aria-label="Work address">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Job type</span>
        <span class="set-row__sub">Shift (serving, on-call): the Ladder never routes you home or to the office mid-shift — you're locked in. Salary/desk: between events during the day, the Ladder assumes you head back to the office.</span></div>
      <select class="pw-field" id="wk-jobtype" aria-label="Job type">
        <option value="shift"${s.jobType === 'shift' ? ' selected' : ''}>Shift (e.g. serving)</option>
        <option value="salary"${s.jobType === 'salary' ? ' selected' : ''}>Salary / desk</option>
      </select>
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Open-ended shifts</span>
        <span class="set-row__sub">For jobs with no set out time (serving, on-call): clock in with just a start time — Atlas projects your out time from past shifts on that weekday, rounded up to 15 minutes.</span></div>
      ${sw('open', s.openEnded)}
    </div>
  </div>`
  container.onclick = (e) => {
    const el = e.target.closest('[data-wk-set]')
    if (!el) return
    const s2 = loadWork()
    if (el.dataset.wkSet === 'tips') s2.tips = !s2.tips
    else s2.openEnded = !s2.openEnded
    saveWork(s2)
    renderWorkSettings(container, rerender)
    rerender?.()
  }
  container.querySelector('#wk-jobtype').onchange = (e) => {
    const s2 = loadWork()
    s2.jobType = e.target.value === 'salary' ? 'salary' : 'shift'
    saveWork(s2)
    rerender?.()
  }
  container.oninput = (e) => {
    const s2 = loadWork()
    if (e.target.id === 'wk-wage') { s2.wage = Number(e.target.value) || 0; saveWork(s2) }
    else if (e.target.id === 'wk-address') { s2.address = e.target.value; saveWork(s2) }
  }
}
