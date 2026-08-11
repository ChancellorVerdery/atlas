// Work plugin — data layer, all local. Shifts are entered as clock times OR a
// plain hours number; each shift snapshots the hourly wage at entry so a
// raise never rewrites history. With "open-ended shifts" on, a shift can be
// clocked in without an out time — the expected out time is projected from
// past shifts (same weekday + similar in-time), rounded up to 15 minutes.

const KEY = 'atlas.work.v1'

export function loadWork() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (!Number.isFinite(Number(s.wage))) s.wage = 0
  s.tips = !!s.tips // tip positions toggle
  s.openEnded = !!s.openEnded // shifts may be logged with no out time
  if (!Array.isArray(s.shifts)) s.shifts = [] // {id, date, start, end, hours, tips, wage}
  if (!s.ranges || typeof s.ranges !== 'object') s.ranges = {} // widgetId → selected income period, persisted across reload
  if (!Array.isArray(s.upcoming)) s.upcoming = [] // scheduled future shifts {id, date, start, end, gcalId}
  if (typeof s.address !== 'string') s.address = '' // workplace, used by the Ladder planner for drive times
  if (typeof s.calId !== 'string') s.calId = '' // the dedicated "Atlas Work" Google calendar id
  return s
}
export function saveWork(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

export const rangeFor = (s, widgetId) => PERIODS.some(([k]) => k === s.ranges[widgetId]) ? s.ranges[widgetId] : 'week'
export function setRange(s, widgetId, period) {
  s.ranges[widgetId] = period
  saveWork(s)
}

const uid = () => 's' + Math.random().toString(36).slice(2, 9)

// ---- time helpers ----------------------------------------------------------

export const toMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
const toHHMM = (min) => `${String(Math.floor((min % 1440) / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`

// overnight shifts wrap: 22:00 → 04:00 is 6h
export function spanHours(start, end) {
  const a = toMin(start), b = toMin(end)
  if (a == null || b == null) return null
  return ((b - a + 1440) % 1440) / 60
}

// Duration entry ("6:30" = 6h30m), for shifts logged without clock times.
// A bare number ("6.5") still parses, so old data and pasted values work.
export function parseHM(s) {
  s = String(s ?? '').trim()
  if (!s) return null
  const m = /^(\d{1,3}):([0-5]?\d)$/.exec(s)
  if (m) return Number(m[1]) + Number(m[2]) / 60
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// Lenient clock entry → "HH:MM" (or null). Accepts "9", "9:5", "0900",
// "9am", "5pm", "5:30 pm", "17:00" — native <input type=time> is fiddly to
// type into, so the upcoming-shift form uses plain text + this parser.
export const parseClock = (v) => {
  const t = String(v || '').trim().toLowerCase().replace(/\s+/g, '')
  if (!t) return null
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

export const fmtTime = (hhmm) => {
  const m = toMin(hhmm)
  if (m == null) return ''
  const h12 = Math.floor(m / 60) % 12 || 12
  return `${h12}:${String(m % 60).padStart(2, '0')} ${m < 720 ? 'AM' : 'PM'}`
}

export const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const dow = (dateKey) => new Date(dateKey + 'T12:00:00').getDay()

// ---- shifts ----------------------------------------------------------------

export const isOpen = (sh) => !!sh.start && !sh.end && sh.hours == null

export const shiftHours = (sh) => {
  if (sh.start && sh.end) return spanHours(sh.start, sh.end)
  return Number.isFinite(Number(sh.hours)) && sh.hours !== null && sh.hours !== '' ? Number(sh.hours) : null
}

// Out time for display: an explicit end, else start + duration when a shift
// was logged/closed by total hours (h:mm) instead of a clock-out time.
export const shiftEnd = (sh) => {
  if (sh.end) return sh.end
  const h = shiftHours(sh)
  return sh.start && h != null ? toHHMM((toMin(sh.start) + Math.round(h * 60)) % 1440) : ''
}

export const shiftEarned = (sh) => {
  const h = shiftHours(sh)
  return (h ?? 0) * (Number(sh.wage) || 0) + (Number(sh.tips) || 0)
}

export function addShift(s, { date, start, end, hours, tips }) {
  const sh = {
    id: uid(),
    date: date || todayKey(),
    start: start || '',
    end: end || '',
    hours: start ? null : parseHM(hours),
    tips: Number(tips) || 0,
    wage: Number(s.wage) || 0,
  }
  if (isOpen(sh) && !s.openEnded) return null // open shift needs the setting on
  s.shifts.push(sh)
  saveWork(s)
  return sh
}

// Close an open shift by EITHER an out time (end) or a total time worked
// (hours, entered h:mm). A total-time entry wins when present: it sets sh.hours
// and clears end, so shiftHours reads the duration directly.
export function closeShift(s, id, { end, hours, tips }) {
  const sh = s.shifts.find((x) => x.id === id)
  if (!sh) return
  const h = parseHM(hours)
  if (h != null) { sh.hours = h; sh.end = '' }
  else if (end) { sh.end = end; sh.hours = null }
  if (tips !== undefined && tips !== '') sh.tips = Number(tips) || 0
  saveWork(s)
}

export function removeShift(s, id) {
  s.shifts = s.shifts.filter((x) => x.id !== id)
  saveWork(s)
}

// Projected out time for an open shift: average duration of past closed
// shifts on the same weekday with a similar in-time (±90 min), widening to
// same weekday, then any timed shift. Rounded UP to the next 15 minutes.
export function projectedEnd(s, sh) {
  const a = toMin(sh.start)
  if (a == null) return null
  const closed = s.shifts.filter((x) => x.id !== sh.id && x.start && x.end)
  const sameDay = closed.filter((x) => dow(x.date) === dow(sh.date))
  const near = sameDay.filter((x) => Math.abs(toMin(x.start) - a) <= 90)
  const pool = near.length ? near : sameDay.length ? sameDay : closed
  if (!pool.length) return null
  const avg = pool.reduce((t, x) => t + spanHours(x.start, x.end), 0) / pool.length
  const endMin = Math.ceil((a + avg * 60) / 15) * 15
  return toHHMM(endMin)
}

// ---- upcoming (scheduled) shifts ----------------------------------------------
// Local records; workui pushes them to the "Atlas Work" Google calendar and
// stores the resulting event id here so deletion can clean up both sides.

// end is optional when open-ended shifts are on: a typed end is the user's own
// estimate (endMode 'est'); left blank, the end is predicted from past shift
// lengths on that weekday with a similar start time (endMode 'auto' — the same
// projection clock-outs use). Either way the record carries a concrete end, so
// the calendar push needs no special casing.
export function addUpcoming(s, { date, start, end }) {
  if (!date || !start) return null
  let endMode = 'est'
  if (!end) {
    if (!s.openEnded) return null
    end = projectedEnd(s, { date, start })
    if (!end) return null // no shift history to predict from — type an estimate
    endMode = 'auto'
  }
  const sh = { id: uid(), date, start, end, endMode, gcalId: '' }
  s.upcoming.push(sh)
  saveWork(s)
  return sh
}
export function removeUpcoming(s, id) {
  s.upcoming = s.upcoming.filter((x) => x.id !== id)
  saveWork(s)
}
export function setUpcomingGcal(s, id, gcalId) {
  const sh = s.upcoming.find((x) => x.id === id)
  if (sh) { sh.gcalId = gcalId; saveWork(s) }
}

// ---- income periods ---------------------------------------------------------

export const PERIODS = [['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['all', 'All time']]

export function periodStart(period, now = new Date()) {
  const d = new Date(now)
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // Monday
  else if (period === 'month') d.setDate(1)
  else if (period === 'year') { d.setMonth(0); d.setDate(1) }
  else return ''
  return todayKey(d)
}

export function incomeFor(s, period) {
  const from = periodStart(period)
  let earned = 0, hours = 0, tips = 0, count = 0
  for (const sh of s.shifts) {
    if (sh.date < from || isOpen(sh)) continue
    earned += shiftEarned(sh)
    hours += shiftHours(sh) ?? 0
    tips += Number(sh.tips) || 0
    count++
  }
  return { earned, hours, tips, count }
}

// ---- tip share (weighted by hours) ------------------------------------------

export function tipShare(pool, people) {
  // hours are entered h:mm ("6:30"); parseHM also accepts a bare number
  const hrs = (p) => parseHM(p.hours) || 0
  const total = people.reduce((t, p) => t + hrs(p), 0)
  if (!total || !(Number(pool) > 0)) return []
  return people.map((p) => ({ ...p, share: (Number(pool) * hrs(p)) / total }))
}
