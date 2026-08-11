// Calendar plugin — data layer over the Google Calendar REST API, sharing the
// email plugin's Google connection (one token, gmail + calendar scopes).
// Local store holds only Atlas UI state: which calendars are hidden, the last
// view, and sidebar visibility. Recurring events are expanded server-side
// (singleEvents=true), so instances arrive ready to place on a grid.

import { authedFetch } from './email.js'

const KEY = 'atlas.calendar.v1'

export function loadCal() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (!Array.isArray(s.hiddenCals)) s.hiddenCals = []
  if (!['month', 'week', 'day'].includes(s.view)) s.view = 'month'
  return s
}
export function saveCal(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

const enc = encodeURIComponent
const api = (path, opts) => authedFetch(`https://www.googleapis.com/calendar/v3/${path}`, opts)

export const listCalendars = () =>
  api('users/me/calendarList?maxResults=100').then((r) => (r.items || []).filter((c) => !c.deleted && !c.hidden))

export async function listEvents(calId, timeMin, timeMax) {
  const p = new URLSearchParams({
    singleEvents: 'true', orderBy: 'startTime', maxResults: '2500',
    timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(),
  })
  const r = await api(`calendars/${enc(calId)}/events?${p}`)
  // _calId lets the UI patch/delete/respond without re-deriving the calendar.
  return (r.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({ ...e, _calId: calId }))
}

// Find-or-create a dedicated calendar by name (e.g. "Atlas Work" for pushed
// shifts) so plugin events never land in the user's primary calendar.
export async function ensureCalendar(summary) {
  const existing = (await api('users/me/calendarList?maxResults=100')).items || []
  const found = existing.find((c) => c.summary === summary && !c.deleted)
  if (found) return found.id
  const created = await api('calendars', { method: 'POST', body: { summary } })
  return created.id
}

export const getEvent = (calId, id) => api(`calendars/${enc(calId)}/events/${enc(id)}`)
export const createEvent = (calId, body, notify) =>
  api(`calendars/${enc(calId)}/events${notify ? '?sendUpdates=all' : ''}`, { method: 'POST', body })
export const patchEvent = (calId, id, body, notify) =>
  api(`calendars/${enc(calId)}/events/${enc(id)}${notify ? '?sendUpdates=all' : ''}`, { method: 'PATCH', body })
export const deleteEvent = (calId, id) => api(`calendars/${enc(calId)}/events/${enc(id)}`, { method: 'DELETE' })

// RSVP: flip our own attendee entry. Google notifies the organizer.
export async function respondToEvent(calId, eventId, responseStatus) {
  const ev = await getEvent(calId, eventId)
  const attendees = (ev.attendees || []).map((a) => (a.self ? { ...a, responseStatus } : a))
  return patchEvent(calId, eventId, { attendees }, true)
}

// ---- date helpers (shared by page + widgets) --------------------------------

export const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
export const dateStr = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const parseDateLocal = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d) }
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
export const startOfWeek = (d) => addDays(startOfDay(d), -d.getDay())
export const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export const evStart = (e) => (e.start?.dateTime ? new Date(e.start.dateTime) : parseDateLocal(e.start.date))
// All-day ends are exclusive in the API; make them inclusive for display math.
export const evEnd = (e) => (e.end?.dateTime ? new Date(e.end.dateTime) : addDays(parseDateLocal(e.end.date), -1))
export const isAllDay = (e) => !!e.start?.date

// ---- recurrence --------------------------------------------------------------

export const RRULE_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const NTH = ['first', 'second', 'third', 'fourth', 'fifth']

// The nth-weekday slot of a date within its month: "3TU", or "-1TU" when it's
// the last such weekday of the month (matches Google's own composer).
export function nthWeekdayOf(d) {
  const nth = Math.floor((d.getDate() - 1) / 7) + 1
  const isLast = d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  return { code: `${isLast && nth >= 4 ? -1 : nth}${RRULE_DAYS[d.getDay()]}`, label: isLast && nth >= 4 ? 'last' : NTH[nth - 1] }
}

// BYDAY helpers for the "edit all <weekday>s" fork: a weekly series that repeats
// on several weekdays can have one weekday split off into its own series.
export const rruleByDays = (rule) => (rule.match(/BYDAY=([^;]+)/)?.[1] || '').split(',').filter(Boolean)
export const rruleSetByDay = (rule, days) => (/BYDAY=[^;]*/.test(rule)
  ? rule.replace(/BYDAY=[^;]*/, `BYDAY=${days.join(',')}`) : `${rule};BYDAY=${days.join(',')}`)
// First occurrence of `rruleDay` (e.g. 'WE') on or after the series start.
export function firstWeekdayOnOrAfter(start, rruleDay) {
  const d = startOfDay(start)
  d.setDate(d.getDate() + ((RRULE_DAYS.indexOf(rruleDay) - d.getDay() + 7) % 7))
  return d
}

// Truncate a rule at end-of-day `untilDate` (local): occurrences after it stop.
// Strips any COUNT/UNTIL first — Google rejects rules carrying both.
export function rruleSetUntil(rule, untilDate, allDay) {
  const u = allDay
    ? dateStr(untilDate).replace(/-/g, '')
    : new Date(untilDate.getFullYear(), untilDate.getMonth(), untilDate.getDate(), 23, 59, 59).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return `${rule.replace(/;(UNTIL|COUNT)=[^;]*/g, '')};UNTIL=${u}`
}

export function buildRRule({ freq, byDays, monthlyMode, start, untilDate, allDay }) {
  if (!freq || freq === 'none') return null
  let r
  if (freq === 'daily') r = 'FREQ=DAILY'
  else if (freq === 'weekly') r = `FREQ=WEEKLY;BYDAY=${(byDays?.length ? byDays : [RRULE_DAYS[start.getDay()]]).join(',')}`
  else if (monthlyMode === 'weekday') r = `FREQ=MONTHLY;BYDAY=${nthWeekdayOf(start).code}`
  else r = `FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}`
  if (untilDate) r = rruleSetUntil(r, untilDate, allDay)
  return `RRULE:${r}`
}

export function describeRRule(rrule) {
  if (!rrule) return ''
  const get = (k) => rrule.match(new RegExp(`${k}=([^;]+)`))?.[1]
  const freq = get('FREQ')
  const until = get('UNTIL')
  const untilTxt = until ? ` until ${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : ''
  if (freq === 'DAILY') return `Daily${untilTxt}`
  if (freq === 'WEEKLY') {
    const days = (get('BYDAY') || '').split(',').map((c) => DAY_NAMES[RRULE_DAYS.indexOf(c)]?.slice(0, 3)).filter(Boolean)
    return `Weekly on ${days.join(', ')}${untilTxt}`
  }
  if (freq === 'MONTHLY') {
    const byday = get('BYDAY')
    if (byday) {
      const m = byday.match(/^(-?\d)([A-Z]{2})$/)
      const n = m[1] === '-1' ? 'last' : NTH[Number(m[1]) - 1]
      return `Monthly on the ${n} ${DAY_NAMES[RRULE_DAYS.indexOf(m[2])]}${untilTxt}`
    }
    return `Monthly on day ${get('BYMONTHDAY')}${untilTxt}`
  }
  return rrule.replace(/^RRULE:/, '')
}
