// Sleep plugin UI: widget bodies (tonight's bedtime, sleep log, hours/night
// chart, debt/night chart) and the sleep-scoped Settings tab. Data + debt
// math live in sleep.js.

import {
  loadSleep, saveSleep, addLog, removeLog, dateKey, hmToMin, minToHM, durText,
  debtSeries, currentDebt, bedtimePlan, nightMinutesFor,
} from './sleep.js'
import { barChart, lineChart } from './chart.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const SL_KINDS = ['slbedtime', 'sllog', 'slhours', 'sldebt']

const time12 = (hm) => {
  const m = hmToMin(hm)
  if (m == null) return ''
  const h = Math.floor(m / 60) % 12 || 12
  return `${h}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`
}
const shortDate = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`
// "7:30" or "90" → minutes
const parseDur = (v) => {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(v).trim())
  if (m) return Number(m[1]) * 60 + Number(m[2])
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}
// Lenient clock-time entry → 'HH:MM' (24h) | null. The native <input type=time>
// was hostile to typing (segment-based, no free text), so these are plain text
// fields that accept "23:00", "2300", "11:30pm", "11 pm", "7am", "7".
const parseTime = (v) => {
  const t = String(v || '').trim().toLowerCase().replace(/\s+/g, '')
  const m = /^(\d{1,2}):?(\d{2})?(am|pm|a|p)?$/.exec(t)
  if (!m) return null
  let h = +m[1]
  const min = m[2] ? +m[2] : 0
  const ap = m[3]?.[0]
  if (min > 59) return null
  if (ap) {
    if (h < 1 || h > 12) return null
    if (ap === 'p' && h !== 12) h += 12
    if (ap === 'a' && h === 12) h = 0
  }
  if (h > 23) return null
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
}
const stars = (n) => '★'.repeat(n)

// per-widget session state (log-form type + quality) — not persisted
const ui = new Map()
const st = (id) => {
  if (!ui.has(id)) ui.set(id, { type: 'night', quality: 0 })
  return ui.get(id)
}

// ---- widget bodies ----------------------------------------------------------

export function sleepWidgetHTML(w, cz) {
  const s = loadSleep()
  const head = (t) => `<p class="gym-head">${t}</p>`

  if (w.kind === 'slbedtime') {
    const p = bedtimePlan(s)
    const debtLine = p.debt > 0
      ? `${durText(p.debt)} sleep debt · +${p.extra} min tonight (of ${durText(Math.ceil(p.debt * s.ratio))} to fully recoup)`
      : 'No sleep debt — right on schedule.'
    return head('Tonight') + `<div class="gym-big gym-big--num">${time12(p.bed)}</div>
      <p class="gym-sub">Sleep to <strong>${time12(p.wake)}</strong> for ${durText(s.prefMin + p.extra)} of sleep</p>
      <p class="gym-sub sl-debtline${p.debt > 0 ? ' sl-debtline--owed' : ''}">${debtLine}</p>`
  }

  if (w.kind === 'slhours') {
    return head('Hours per night') + `<div class="chart-mount" data-widget-id="${esc(w.id)}"></div>`
  }
  if (w.kind === 'sldebt') {
    return head('Sleep debt') + `<div class="chart-mount" data-widget-id="${esc(w.id)}"></div>`
  }

  // sllog — nights + naps entry form and recent entries
  const state = st(w.id)
  const isNap = state.type === 'nap'
  const starBtns = [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" class="sl-star${state.quality >= n ? ' is-on' : ''}" data-sl-star="${n}" data-wid="${esc(w.id)}" title="Quality ${n}/5" aria-label="Quality ${n} of 5">★</button>`).join('')
  const form = cz ? '' : `<div class="wk-add sl-add" data-wid="${esc(w.id)}">
    <select class="pw-field sl-type" data-sl-type data-wid="${esc(w.id)}" aria-label="Entry type">
      <option value="night"${isNap ? '' : ' selected'}>Night</option>
      <option value="nap"${isNap ? ' selected' : ''}>Nap</option>
    </select>
    <input class="pw-field wk-datein sl-date" type="date" value="${dateKey()}" title="${isNap ? 'Nap date' : 'Morning you woke up'}" aria-label="Date">
    ${isNap
      ? `<input class="pw-field wk-num sl-dur" type="text" inputmode="numeric" placeholder="h:mm" title="Nap length" aria-label="Nap length (h:mm)">`
      : `<input class="pw-field wk-num sl-bed" type="text" inputmode="numeric" placeholder="11:30 PM" title="Bed time — type e.g. 11:30pm, 2330, or 23:00" aria-label="Bed time">
         <input class="pw-field wk-num sl-wake" type="text" inputmode="numeric" placeholder="7:00 AM" title="Wake time — type e.g. 7am, 700, or 07:00" aria-label="Wake time">`}
    <span class="sl-stars">${starBtns}</span>
    <button type="button" class="gym-btn" data-sl-act="add">Add</button>
  </div>`
  const recent = [...s.logs].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1)).slice(0, 8)
  const rows = recent.map((l) => `<div class="wk-row" data-log-id="${esc(l.id)}">
    <span class="wk-date">${shortDate(l.date)}</span>
    <span class="wk-time">${l.type === 'nap'
      ? `nap · ${durText(l.minutes)}`
      : `${time12(l.start)}–${time12(l.end)} · ${durText(l.minutes)}`}${l.quality ? ` <span class="sl-q">${stars(l.quality)}</span>` : ''}</span>
    <span></span>
    ${cz ? '' : `<button type="button" class="pw-item-remove" data-sl-act="del" data-id="${esc(l.id)}" title="Delete entry">×</button>`}
  </div>`).join('')
  return head('Sleep log') + form +
    (rows ? `<div class="wk-rows">${rows}</div>` : `<p class="gym-empty">No sleep logged yet — log last night above.</p>`)
}

// ---- charts (drawn via view.js's chart-mount ResizeObserver) -----------------

export function sleepHoursChartSVG(w, h) {
  const s = loadSleep()
  const days = Math.max(s.windowDays, 7)
  const pts = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const mins = nightMinutesFor(s, dateKey(d))
    pts.push({ label: shortDate(dateKey(d)), value: mins == null ? 0 : Math.round((mins / 60) * 10) / 10 })
  }
  if (!pts.some((p) => p.value > 0)) return '<p class="gym-empty">Log some nights to see this chart.</p>'
  return barChart(pts, { w, h, yLabel: 'Hours slept', xLabel: `Goal: ${durText(s.prefMin)} per night` })
}

export function sleepDebtChartSVG(w, h) {
  const s = loadSleep()
  const series = debtSeries(s)
  const pts = series.map((p) => ({ label: shortDate(p.date), value: Math.round((p.debt / 60) * 10) / 10 }))
  if (!s.logs.length) return '<p class="gym-empty">Log some nights to see your sleep debt.</p>'
  return lineChart(pts, { w, h, yLabel: 'Sleep debt (hours)', xLabel: `${s.windowDays}-day window · ${s.ratio}× recovery` })
}

// ---- interactions ------------------------------------------------------------

let rerenderApp = null

export function bindSleep(rerender) {
  rerenderApp = rerender
  document.body.addEventListener('click', onSleepClick)
  document.body.addEventListener('change', onSleepChange)
}

function onSleepClick(e) {
  const star = e.target.closest('[data-sl-star]')
  if (star) {
    const state = st(star.dataset.wid)
    const n = Number(star.dataset.slStar)
    state.quality = state.quality === n ? 0 : n // click the same star again to clear
    // repaint in place — a rerender would drop the half-filled form
    star.closest('.sl-stars').querySelectorAll('.sl-star').forEach((b, i) => b.classList.toggle('is-on', i < state.quality))
    return
  }
  const act = e.target.closest('[data-sl-act]')
  if (!act) return
  const s = loadSleep()
  if (act.dataset.slAct === 'add') {
    const box = act.closest('.sl-add')
    const state = st(box.dataset.wid)
    const added = addLog(s, {
      type: state.type,
      date: box.querySelector('.sl-date').value,
      start: parseTime(box.querySelector('.sl-bed')?.value),
      end: parseTime(box.querySelector('.sl-wake')?.value),
      minutes: parseDur(box.querySelector('.sl-dur')?.value ?? ''),
      quality: state.quality,
    })
    if (!added) return
    state.quality = 0
    rerenderApp?.()
  } else if (act.dataset.slAct === 'del') {
    removeLog(s, act.dataset.id)
    rerenderApp?.()
  }
}

function onSleepChange(e) {
  const sel = e.target.closest('[data-sl-type]')
  if (sel) {
    st(sel.dataset.wid).type = sel.value === 'nap' ? 'nap' : 'night'
    rerenderApp?.() // swaps the form's time inputs for the duration field
    return
  }
  // Canonicalize a bed/wake field on blur so the user sees their entry
  // registered as a real time ("1130p" → "11:30 PM") instead of guessing.
  const tf = e.target.closest('.sl-bed, .sl-wake')
  if (tf && tf.value.trim()) {
    const hm = parseTime(tf.value)
    if (hm) tf.value = time12(hm)
    tf.classList.toggle('sl-bad', !hm)
  }
}

// ---- sleep settings tab --------------------------------------------------------

export function renderSleepSettings(container, rerender) {
  const s = loadSleep()
  container.innerHTML = `<div class="page gym-settings">
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Preferred sleep</span>
        <span class="set-row__sub">Your nightly target (h:mm). Nights shorter than this build sleep debt.</span></div>
      <input class="pw-field wk-num" id="sl-pref" value="${esc(durText(s.prefMin))}" placeholder="8:00" aria-label="Preferred sleep (h:mm)">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Preferred bedtime</span>
        <span class="set-row__sub">The anchor for tonight's plan — your wake time floats later when there's debt to recoup.</span></div>
      <input class="pw-field wk-num" id="sl-bedtime" type="time" value="${esc(s.bedtime)}" aria-label="Preferred bedtime">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Debt window</span>
        <span class="set-row__sub">Days of history that count toward sleep debt — a short night older than this drops off entirely.</span></div>
      <input class="pw-field wk-num" id="sl-window" type="number" min="1" max="30" step="1" value="${esc(s.windowDays)}" aria-label="Debt window (days)">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Recovery ratio</span>
        <span class="set-row__sub">Extra sleep needed to clear one hour of debt — 1.2 means an hour of debt takes 1:12 to recoup.</span></div>
      <input class="pw-field wk-num" id="sl-ratio" type="number" min="1" max="3" step="0.1" value="${esc(s.ratio)}" aria-label="Recovery ratio">
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Nap credit</span>
        <span class="set-row__sub">How much of a nap counts toward the day's sleep — nap sleep is lighter than night sleep.</span></div>
      <div class="set-suffix"><input class="pw-field wk-num" id="sl-napcredit" type="number" min="0" max="100" step="5" value="${esc(s.napCredit)}" aria-label="Nap credit percent"> %</div>
    </div>
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Recoup over</span>
        <span class="set-row__sub">Nights to spread debt repayment across — tonight's wake time only absorbs this fraction of the debt.</span></div>
      <div class="set-suffix"><input class="pw-field wk-num" id="sl-recover" type="number" min="1" max="14" step="1" value="${esc(s.recoverNights)}" aria-label="Recoup over (nights)"> nights</div>
    </div>
  </div>`
  container.oninput = (e) => {
    const s2 = loadSleep()
    const id = e.target.id
    if (id === 'sl-pref') { const m = parseDur(e.target.value); if (m) s2.prefMin = m }
    else if (id === 'sl-bedtime') { if (hmToMin(e.target.value) != null) s2.bedtime = e.target.value }
    else if (id === 'sl-window') { const n = Math.round(Number(e.target.value)); if (n >= 1) s2.windowDays = n }
    else if (id === 'sl-ratio') { const n = Number(e.target.value); if (n >= 1) s2.ratio = n }
    else if (id === 'sl-napcredit') { const n = Number(e.target.value); if (n >= 0 && n <= 100) s2.napCredit = n }
    else if (id === 'sl-recover') { const n = Math.round(Number(e.target.value)); if (n >= 1) s2.recoverNights = n }
    else return
    saveSleep(s2)
    rerender?.()
  }
}
