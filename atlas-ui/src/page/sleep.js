// Sleep plugin — data layer. Nights and naps are logged locally; sleep debt
// is a rolling window (windowDays): each logged day's shortfall vs the
// preferred amount adds debt, oversleep repays it at the user's recovery
// ratio (1h of debt costs ratio hours of extra sleep to clear), debt never
// goes negative (you can't pre-sleep), and days that scroll out of the
// window drop off entirely. Days with NO log are carried, not counted — a
// forgotten log isn't a short night.

const KEY = 'atlas.sleep.v1'
const isObj = (o) => o !== null && typeof o === 'object'
export const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export const dateKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// 'HH:MM' → minutes since midnight | null
export const hmToMin = (t) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim())
  return m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null
}
export const minToHM = (min) => {
  const m = ((min % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
// minutes → "7:30" duration text
export const durText = (min) => `${Math.floor(min / 60)}:${String(Math.round(min) % 60).padStart(2, '0')}`

export function loadSleep() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (!Number.isFinite(s.prefMin) || s.prefMin <= 0) s.prefMin = 480 // 8h
  if (hmToMin(s.bedtime) == null) s.bedtime = '23:00'
  if (!Number.isInteger(s.windowDays) || s.windowDays < 1) s.windowDays = 7
  if (!Number.isFinite(s.ratio) || s.ratio < 1) s.ratio = 1.2
  if (!Number.isFinite(s.napCredit) || s.napCredit < 0 || s.napCredit > 100) s.napCredit = 50
  if (!Number.isInteger(s.recoverNights) || s.recoverNights < 1) s.recoverNights = 3
  if (!Array.isArray(s.logs)) s.logs = []
  s.logs = s.logs.filter((l) => isObj(l) && l.id && l.date && Number.isFinite(l.minutes) && l.minutes > 0)
  return s
}
export function saveSleep(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

// Nights: date = the morning you woke up; duration from bed/wake times
// (cross-midnight safe). Naps: date + duration. quality 1–5 optional.
export function addLog(s, { type, date, start, end, minutes, quality }) {
  const l = { id: uid('sl'), type: type === 'nap' ? 'nap' : 'night', date }
  if (l.type === 'night') {
    const a = hmToMin(start), b = hmToMin(end)
    if (a == null || b == null) return null
    l.start = minToHM(a)
    l.end = minToHM(b)
    l.minutes = ((b - a) + 1440) % 1440
  } else {
    l.minutes = Math.round(Number(minutes))
  }
  if (!l.date || !(l.minutes > 0)) return null
  const q = Math.round(Number(quality))
  if (q >= 1 && q <= 5) l.quality = q
  s.logs.push(l)
  saveSleep(s)
  return l
}
export function removeLog(s, id) {
  s.logs = s.logs.filter((l) => l.id !== id)
  saveSleep(s)
}

// Credited sleep for one calendar day: nights at full value, naps at the
// user's nap-credit percentage. null = nothing logged that day at all.
export function creditedFor(s, day) {
  const logs = s.logs.filter((l) => l.date === day)
  if (!logs.length) return null
  return logs.reduce((t, l) => t + (l.type === 'nap' ? (l.minutes * s.napCredit) / 100 : l.minutes), 0)
}

// Rolling debt over the window ending today (a night's date is its wake-up
// morning, so "last night" lands on today). Recomputed from zero at the
// window start every time — that's what makes old days drop off for free.
// → [{ date, slept: minutes|null, debt: minutes }], oldest → newest
export function debtSeries(s, now = new Date()) {
  const out = []
  let debt = 0
  for (let i = s.windowDays - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const day = dateKey(d)
    const slept = creditedFor(s, day)
    if (slept != null) {
      const diff = slept - s.prefMin
      if (diff < 0) debt += -diff
      else debt = Math.max(0, debt - diff / s.ratio)
    }
    out.push({ date: day, slept, debt: Math.round(debt) })
  }
  return out
}

export const currentDebt = (s, now = new Date()) => {
  const series = debtSeries(s, now)
  return series.length ? series[series.length - 1].debt : 0
}

// Tonight's plan: bedtime is the user's anchor; the recommended wake time
// floats = bedtime + preferred sleep + tonight's share of the debt recoup
// (debt × ratio spread over recoverNights, rounded up to 5 min).
export function bedtimePlan(s, now = new Date()) {
  const debt = currentDebt(s, now)
  const extra = debt > 0 ? Math.ceil((debt * s.ratio) / s.recoverNights / 5) * 5 : 0
  const bedMin = hmToMin(s.bedtime)
  return { bed: s.bedtime, extra, debt, wake: minToHM(bedMin + s.prefMin + extra) }
}

// Night sleep per day for the hours graph (naps excluded — it's "hours per
// night"; the debt graph is where naps participate, via creditedFor).
export function nightMinutesFor(s, day) {
  const nights = s.logs.filter((l) => l.date === day && l.type === 'night')
  return nights.length ? nights.reduce((t, l) => t + l.minutes, 0) : null
}
