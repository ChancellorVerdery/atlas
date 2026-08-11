// Ladder plugin — the planner's data layer and scheduling engine. Pulls fixed
// commitments (Google Calendar events, scheduled work shifts), flexes sleep
// around them (full-length nights that shift; short only when pinned), chains
// the user's location through the day to insert drive-time blocks (OSRM
// routing + Nominatim geocoding — free OSM services, no keys), then places
// flexible blocks (gym from the Gym plan, meals, user flex events) into the
// free gaps. Read-only toward Google Calendar: the planner never pushes.
//
// All block times are ms epochs; a block crossing midnight stays ONE block —
// the UI draws day lines across it rather than splitting it.

import { isConnected } from './email.js'
import { listCalendars, listEvents, evStart, evEnd, isAllDay } from './calendar.js'
import { loadGym, plannedWorkoutFor, workoutDuration, DAYS as GYM_DAYS } from './gym.js'
const gymDayKey = (d) => GYM_DAYS[(d.getDay() + 6) % 7] // mon-first, matches gym.js's own weekday keys
import { loadWork } from './work.js'
import { loadSleep, currentDebt } from './sleep.js'

const KEY = 'atlas.ladder.v1'
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const isObj = (o) => o !== null && typeof o === 'object'

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export function loadLadder() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (typeof s.home !== 'string') s.home = ''
  if (!/^\d{2}:\d{2}$/.test(s.wake || '')) s.wake = '07:00'
  // Bedtime lives in the Sleep plugin now — the planner reads it from there.
  delete s.bed
  if (!Number.isInteger(s.windowDays) || s.windowDays < 1 || s.windowDays > 31) s.windowDays = 7
  if (!Number.isFinite(Number(s.buffer)) || s.buffer < 0) s.buffer = 5 // minutes added around every drive
  if (!Array.isArray(s.meals)) {
    s.meals = [
      { id: uid('lm'), name: 'Breakfast', pref: '08:00', duration: 30, enabled: true },
      { id: uid('lm'), name: 'Lunch', pref: '12:30', duration: 45, enabled: true },
      { id: uid('lm'), name: 'Dinner', pref: '18:30', duration: 45, enabled: true },
    ]
  }
  s.meals = s.meals.filter(isObj)
  // kind 'week' (anywhere in the window) | 'day' (a specific date) | 'recur' (a
  // weekday, every week) | 'attached' (paired to an anchor) | 'set' (a fixed
  // event: a specific date + start/end clock time, immovable like a calendar
  // event but created here, so sleep and everything flexible plan around it)
  if (!Array.isArray(s.flex)) s.flex = []
  s.flex = s.flex.filter((f) => isObj(f) && f.id && f.title && Number(f.minutes) > 0)
  if (!isObj(s.geo)) s.geo = {} // address (lowercased) → {lat, lon} | null (null = geocode failed, cached)
  if (!isObj(s.drives)) s.drives = {} // "lat,lon>lat,lon" → minutes
  // Re-round on every load, not just when freshly fetched: a cache HIT
  // returns whatever's stored verbatim (routeMinutes never re-touches it),
  // so a value cached before this rounding rule existed — or from any other
  // path — would silently stay un-rounded forever otherwise. Idempotent: an
  // already-rounded value is unchanged.
  for (const k of Object.keys(s.drives)) {
    if (Number.isFinite(s.drives[k])) s.drives[k] = Math.ceil(s.drives[k] / 5) * 5
  }
  // Location aliases: map text found in an event's location OR title to a real
  // address. Campus-style locations ("Fretwell 306") either don't geocode or —
  // worse — geocode to the wrong place entirely; an alias pins them down once.
  // Lenient filter (id only): a row being typed in Settings is half-empty and
  // must survive the next loadLadder; aliasFor() skips incomplete rows.
  if (!Array.isArray(s.aliases)) s.aliases = [] // {id, match, address}
  s.aliases = s.aliases.filter((a) => isObj(a) && a.id)
  // Calendar push: each block type routes to its own Google calendar ("folder")
  // so the ladder never crowds the primary one. calIds caches the created ids;
  // pushed maps a day (YYYY-MM-DD) → the events created for it, so a day can be
  // re-pushed (replace) or removed (delete) cleanly.
  if (!isObj(s.calIds)) s.calIds = { gym: '', drives: '', ladder: '' }
  if (!isObj(s.pushed)) s.pushed = {} // dateKey → [{ calId, id }]
  return s
}
export function saveLadder(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

// kind 'attached' pairs the event to another block's front or back edge —
// anchor is either "tag:<blockType>" (every gym session / shift / calendar
// event) or "id:<planBlockId>" (one specific upcoming event). place decides
// where it happens: 'home' (the drive home gets pulled in between), 'same'
// (at the anchor's location), or 'none'.
export function addFlex(s, { title, minutes, kind, date, start, end, weekday, side, anchor, anchorLabel, place }) {
  const f = { id: uid('lf'), title: title.trim(), minutes: Math.round(Number(minutes)), kind }
  if (kind === 'day') f.date = date
  if (kind === 'recur') f.weekday = Number(weekday)
  if (kind === 'set') {
    // A fixed event: date + clock start/end. minutes is derived so the block's
    // duration/label math and the flex-validity filter both work unchanged.
    const a = hmToMin(start), b = hmToMin(end)
    if (!date || a == null || b == null || !(b > a)) return null
    f.date = date; f.start = start; f.end = end; f.minutes = b - a
  }
  if (kind === 'attached') {
    f.side = side === 'before' ? 'before' : 'after'
    f.place = ['home', 'same'].includes(place) ? place : 'none'
    if (typeof anchor !== 'string') return null
    if (anchor.startsWith('tag:')) f.anchorTag = anchor.slice(4)
    else if (anchor.startsWith('series:')) { f.anchorSeries = anchor.slice(7); f.anchorLabel = anchorLabel || '' }
    else if (anchor.startsWith('id:')) { f.anchorId = anchor.slice(3); f.anchorLabel = anchorLabel || '' }
    else return null
  }
  if (!f.title || !(f.minutes > 0)) return null
  if (kind === 'day' && !f.date) return null
  s.flex.push(f)
  saveLadder(s)
  return f
}
export function removeFlex(s, id) {
  s.flex = s.flex.filter((f) => f.id !== id)
  saveLadder(s)
}

// First alias whose match text appears in `text` (case-insensitive substring).
export function aliasFor(s, text) {
  if (!text) return null
  const t = String(text).toLowerCase()
  const hit = s.aliases.find((a) => a.match && a.address && t.includes(a.match.toLowerCase()))
  return hit ? hit.address : null
}

// ---- time helpers ---------------------------------------------------------------

const MIN = 60000
export const hmToMin = (hm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const atTime = (dayMs, minutes) => dayMs + minutes * MIN
export const dateKey = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ---- geocoding + routing (OpenStreetMap: Nominatim + OSRM, cached forever) -------

async function geocode(s, address) {
  const key = address.trim().toLowerCase()
  if (!key) return null
  if (key in s.geo) return s.geo[key]
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`)
    const j = await r.json()
    // Only a real result ARRAY is definitive. A rate-limit/error payload is an
    // object — caching that as null would permanently mark a good address as
    // unfindable. Skip the cache and let the next build retry.
    // ponytail: no request throttling — a cold build with many new addresses
    // may trip Nominatim's 1 req/s limit once; those retry on the next build.
    if (!Array.isArray(j)) return null
    s.geo[key] = j[0] ? { lat: Number(j[0].lat), lon: Number(j[0].lon) } : null
  } catch {
    return null // transient network failure — don't cache, retry next build
  }
  saveLadder(s)
  return s.geo[key]
}

// minutes of driving between two coordinates (no buffer) — rounded UP to the
// nearest 5 (never down: a raw 23-min route becomes a reserved 25, not 20).
async function routeMinutes(s, a, b) {
  const r4 = (n) => n.toFixed(4)
  const key = `${r4(a.lat)},${r4(a.lon)}>${r4(b.lat)},${r4(b.lon)}`
  if (key in s.drives) return s.drives[key]
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`)
    const j = await r.json()
    if (j?.routes?.[0]?.duration == null) return null
    s.drives[key] = Math.ceil(j.routes[0].duration / 60 / 5) * 5
    saveLadder(s)
    return s.drives[key]
  } catch {
    return null
  }
}

// ---- gap arithmetic ---------------------------------------------------------------

// gaps: sorted, non-overlapping [{start, end}]
function subtract(gaps, start, end) {
  const out = []
  for (const g of gaps) {
    if (end <= g.start || start >= g.end) { out.push(g); continue }
    if (start > g.start) out.push({ start: g.start, end: start })
    if (end < g.end) out.push({ start: end, end: g.end })
  }
  return out
}
const fits = (g, dur, notBefore = -Infinity) => g.end - Math.max(g.start, notBefore) >= dur

function placeEarliest(gaps, dur, notBefore = -Infinity) {
  for (const g of gaps) if (fits(g, dur, notBefore)) return Math.max(g.start, notBefore)
  return null
}
// closest possible start to `pref` across all gaps
function placeNear(gaps, pref, dur, notBefore = -Infinity) {
  let best = null
  for (const g of gaps) {
    if (!fits(g, dur, notBefore)) continue
    const lo = Math.max(g.start, notBefore)
    const cand = Math.min(Math.max(pref, lo), g.end - dur)
    if (best == null || Math.abs(cand - pref) < Math.abs(best - pref)) best = cand
  }
  return best
}

// ---- the plan --------------------------------------------------------------------

// → { blocks, unplaced, warnings, windowStart, windowEnd, days }
export async function buildPlan(now = new Date()) {
  const s = loadLadder()
  const gym = loadGym()
  const work = loadWork()
  // The window starts TODAY. Today is planned like any other day — from wake to
  // bed, ignoring how much of it has already passed; the current-time line is
  // only a display overlay and never pushes placement forward (past-"now"
  // clamps were removed so a meal/flex/gym still lands at its natural slot even
  // if that slot is earlier than now).
  const windowStart = startOfDay(now)
  const days = s.windowDays
  const windowEnd = windowStart + days * 86400000
  const wakeMin = hmToMin(s.wake)
  const warnings = []
  const unplaced = []
  const blocks = []

  const homeLoc = s.home ? await geocode(s, s.home) : null
  if (s.home && !homeLoc) warnings.push(`Couldn't locate home address “${s.home}”.`)

  const dayMs = (i) => windowStart + i * 86400000

  // -- fixed: Google Calendar events (all calendars except Atlas Work — shifts
  // come from the Work store so they aren't double-counted)
  if (isConnected()) {
    try {
      const cals = (await listCalendars()).filter((c) => c.id !== work.calId && c.summary !== 'Atlas Work')
      const lists = await Promise.all(cals.map((c) => listEvents(c.id, new Date(windowStart), new Date(windowEnd)).catch(() => [])))
      for (const e of lists.flat()) {
        if (isAllDay(e)) continue // no clock time to block
        const start = evStart(e).getTime()
        const end = evEnd(e).getTime()
        if (end <= windowStart || start >= windowEnd || end <= start) continue
        // addr = what gets geocoded/chained: an alias hit on the location
        // (campus rooms → real address) beats the raw location; an event with
        // no location can still resolve through a title alias. place = the
        // human text shown on the card (the event's own location wording).
        const addr = aliasFor(s, e.location) || e.location || aliasFor(s, e.summary)
        // recurringEventId (present because listEvents expands series with
        // singleEvents=true) flags a repeating event even when only ONE instance
        // falls in the window — the anchor UI offers "every <title>" from it.
        blocks.push({ id: `cal-${e.id}`, type: 'cal', title: e.summary || '(untitled)', start, end, addr: addr || null, place: e.location || addr || null, loc: null, recurringId: e.recurringEventId || null })
      }
    } catch (err) {
      warnings.push(`Calendar unavailable: ${err.message}`)
    }
  } else warnings.push('Google Calendar not connected — planning without calendar events.')

  // -- fixed: scheduled work shifts (overnight end ≤ start wraps to next day)
  for (const sh of work.upcoming) {
    const day = new Date(sh.date + 'T00:00:00').getTime()
    const start = atTime(day, hmToMin(sh.start) ?? 0)
    let end = atTime(day, hmToMin(sh.end) ?? 0)
    if (end <= start) end += 86400000
    if (end <= windowStart || start >= windowEnd) continue
    blocks.push({ id: `shift-${sh.id}`, type: 'shift', title: 'Work', start, end, addr: work.address || null, loc: null })
  }

  // -- fixed: user-set events created here (immovable like a calendar event, but
  // local; no location, so no drive chaining — a set event just holds its slot)
  for (const f of s.flex) {
    if (f.kind !== 'set' || !f.date) continue
    const day = new Date(f.date + 'T00:00:00').getTime()
    const start = atTime(day, hmToMin(f.start) ?? 0)
    const end = atTime(day, hmToMin(f.end) ?? 0)
    if (end <= start || end <= windowStart || start >= windowEnd) continue
    blocks.push({ id: `set-${f.id}`, type: 'set', title: f.title, start, end, addr: null, loc: null, flexId: f.id })
  }

  // geocode fixed-block addresses (cached — usually instant)
  for (const b of blocks) {
    if (b.addr && !b.loc) {
      b.loc = await geocode(s, b.addr)
      if (!b.loc) warnings.push(`Couldn't locate “${b.addr}” (${b.title}) — no drive time for it.`)
    }
  }

  const attachedDefs = s.flex.filter((f) => f.kind === 'attached')

  // -- sleep: flexible around the hard commitments above. Calendar events and
  // shifts are immovable; each night keeps its full target length by SHIFTING —
  // bed pushes later after a late block (past the drive home and any routine
  // attached before sleep), or pulls earlier ahead of an early block when the
  // evening is free. Only when both ends are pinned does the night shrink, and
  // the loss is surfaced as sleep debt. Bedtime + target length BOTH come from
  // the Sleep plugin — the planner has no bedtime of its own. Target = the
  // plugin's preferred hours plus its debt-aware recoup share on the first
  // recoverNights nights (both default sanely with no logs: debt 0 → no extra).
  const sl = loadSleep()
  const prefBedMin = hmToMin(sl.bedtime) // loadSleep guarantees a valid value
  const extraMin = (() => {
    const debt = currentDebt(sl, now)
    return debt > 0 ? Math.ceil((debt * sl.ratio) / sl.recoverNights / 5) * 5 : 0
  })()
  const targetMinFor = (i) => sl.prefMin + (i >= 0 && i < sl.recoverNights ? extraMin : 0)
  // routines attached to sleep widen what the night needs on each side
  const isSleepAnchored = (f) => f.anchorTag === 'sleep' || (f.anchorId || '').startsWith('sleep-')
  let sleepExtraBefore = 0, sleepExtraAfter = 0
  for (const f of attachedDefs.filter(isSleepAnchored)) {
    if (f.side === 'before') sleepExtraBefore += f.minutes
    else sleepExtraAfter += f.minutes
  }
  const hardBlocks = blocks.filter((b) => b.type === 'cal' || b.type === 'shift' || b.type === 'set')
  // minutes that must stay free before bed after block h (drive home + evening
  // routine), and after wake before block m (morning routine + drive out)
  const preOf = async (h) => ((h.loc && homeLoc && h.addr !== s.home) ? (((await routeMinutes(s, h.loc, homeLoc)) ?? 0) + Number(s.buffer)) : 0) + sleepExtraBefore
  const postOf = async (m) => ((m.loc && homeLoc && m.addr !== s.home) ? (((await routeMinutes(s, homeLoc, m.loc)) ?? 0) + Number(s.buffer)) : 0) + sleepExtraAfter
  const hmText = (min) => min >= 60 ? `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}` : `${min}m`
  const nightEdge = {} // i → {bed, wake} (unclamped) — awakeGaps reads these
  for (let i = -1; i < days; i++) {
    const D = targetMinFor(i) * MIN
    const bedPref = prefBedMin > wakeMin ? atTime(dayMs(i), prefBedMin) : atTime(dayMs(i + 1), prefBedMin)
    // evening settle: any hard block in the first half of the night pushes bed
    // past its end + the room preOf reserves; repeat until stable
    const settle = async (cand) => {
      for (let guard = 0; guard < 10; guard++) {
        let next = cand
        for (const h of hardBlocks) {
          if (h.start > cand + D / 2) continue
          const edge = h.end + (await preOf(h)) * MIN
          if (edge > next) next = edge
        }
        if (next === cand) return cand
        cand = next
      }
      return cand
    }
    let bed = await settle(bedPref)
    // morning cap: the earliest hard block after bed, minus the room postOf reserves
    let cap = Infinity
    for (const m of hardBlocks) {
      if (m.start < bed) continue
      cap = Math.min(cap, m.start - (await postOf(m)) * MIN)
    }
    let wake = bed + D
    if (cap < wake) {
      // protect the full night first: pull bed earlier if the evening is free
      const pulled = await settle(cap - D)
      if (pulled < bed) bed = pulled
      wake = Math.min(bed + D, cap)
      if (wake <= bed) { // pinned from both sides with no room at all
        warnings.push(`No room to sleep the night into ${dateKey(cap)} — back-to-back commitments.`)
        continue
      }
      const lost = Math.round((D - (wake - bed)) / MIN)
      if (lost >= 5) warnings.push(`Short night into ${dateKey(wake)}: only ${hmText(Math.round((wake - bed) / MIN))} fits — +${hmText(lost)} sleep debt.`)
    }
    nightEdge[i] = { bed, wake }
    const start = Math.max(bed, windowStart)
    const end = Math.min(wake, windowEnd)
    if (end > start) blocks.push({ id: `sleep-${i}`, type: 'sleep', title: 'Sleep', start, end, addr: s.home || null, loc: homeLoc })
  }

  blocks.sort((a, b) => a.start - b.start)

  // location the chain is at, just before time t
  const locAt = (t) => {
    let cur = { loc: homeLoc, addr: s.home || 'home' }
    for (const b of blocks) {
      if (b.start >= t) break
      if (b.loc) cur = { loc: b.loc, addr: b.addr }
    }
    return cur
  }

  // awake gaps for one day, minus every existing block. The day runs from the
  // planned wake (last night's edge — which may have shifted) to tonight's bed.
  const awakeGaps = (i) => {
    const wakeAt = nightEdge[i - 1]?.wake ?? atTime(dayMs(i), wakeMin)
    const bedAt = nightEdge[i]?.bed ?? (prefBedMin > wakeMin ? atTime(dayMs(i), prefBedMin) : atTime(dayMs(i + 1), prefBedMin))
    let gaps = [{ start: Math.max(wakeAt, windowStart), end: Math.min(bedAt, windowEnd) }]
    for (const b of blocks) gaps = subtract(gaps, b.start, b.end)
    return gaps.filter((g) => g.end - g.start >= 5 * MIN)
  }

  // -- gym: place on planned-workout days, inside gym hours, drive-aware
  const gymLoc = gym.address ? await geocode(s, gym.address) : null
  if (gym.address && !gymLoc) warnings.push(`Couldn't locate gym address “${gym.address}”.`)
  // "Restructure so it all fits": events attached to gym sessions widen the
  // gap the gym itself needs, so the gym lands where its whole train fits.
  let gymExtraBefore = 0, gymExtraAfter = 0
  for (const f of attachedDefs.filter((x) => x.anchorTag === 'gym')) {
    let leg = 0
    if (f.place === 'home' && gymLoc && homeLoc) leg = ((await routeMinutes(s, gymLoc, homeLoc)) ?? 0) + Number(s.buffer)
    if (f.side === 'before') gymExtraBefore += f.minutes + (f.place === 'home' ? leg : 0)
    else gymExtraAfter += f.minutes + (f.place === 'home' ? leg : 0)
  }
  // -- attached events: paired to an anchor block's front or back edge; error
  // when an immovable block leaves no room for the pairing.
  const placeAttachments = async (defs) => {
    for (const f of defs) {
      const anchors = f.anchorId
        ? blocks.filter((b) => b.id === f.anchorId)
        : f.anchorSeries
          ? blocks.filter((b) => b.type === 'cal' && b.recurringId === f.anchorSeries && !b.attached)
          : blocks.filter((b) => b.type === f.anchorTag && !b.attached)
      if ((f.anchorId || f.anchorSeries) && !anchors.length) {
        warnings.push(`“${f.title}”: its anchor event isn't in this window.`)
        continue
      }
      for (const anchor of anchors) {
        const dur = f.minutes * MIN
        const addr = f.place === 'home' ? (s.home || null) : f.place === 'same' ? anchor.addr : null
        const loc = f.place === 'home' ? homeLoc : f.place === 'same' ? anchor.loc : null
        // the drive leg between anchor and this block, when it changes location
        let leg = 0
        if (f.place === 'home' && homeLoc && anchor.loc && anchor.addr !== s.home) {
          const mins = await routeMinutes(s, anchor.loc, homeLoc)
          if (mins != null) leg = (mins + Number(s.buffer)) * MIN
        }
        // stack outward past any attachment already paired to this anchor+side
        const siblings = blocks.filter((b) => b.attached && b.anchorId === anchor.id && b.side === f.side)
        let start, end
        if (f.side === 'before') {
          const edge = Math.min(anchor.start, ...siblings.map((b) => b.start))
          end = edge - (f.place === 'home' ? leg : 0)
          start = end - dur
        } else {
          const edge = Math.max(anchor.end, ...siblings.map((b) => b.end))
          start = edge + leg
          end = start + dur
        }
        // sleep and drives are soft (drives recompute below; a late cleanup can
        // run into the sleep band) — everything else is immovable: error.
        const hard = blocks.find((b) => b !== anchor && !['sleep', 'drive'].includes(b.type) && !siblings.includes(b) && start < b.end && end > b.start)
        if (hard) {
          unplaced.push({ title: f.title, minutes: f.minutes, when: dateKey(anchor.start) })
          warnings.push(`“${f.title}” can't fit ${f.side} “${anchor.title}” — “${hard.title}” is in the way.`)
          continue
        }
        blocks.push({ id: `att-${f.id}-${anchor.id}`, type: 'flex', attached: true, side: f.side, anchorId: anchor.id, anchorTitle: anchor.title, title: f.title, start, end, addr, loc, flexId: f.id })
        blocks.sort((a, b) => a.start - b.start)
      }
    }
  }

  // Attachments to already-fixed anchors (sleep/calendar/shift) place FIRST —
  // the gym is planner-placed, not hard-set, so its gap scan below routes
  // around them (a post-sleep morning routine pushes the gym later, instead of
  // the gym squatting at wake and erroring the routine out). Gym-anchored
  // attachments necessarily wait until gym blocks exist.
  const isGymAnchored = (f) => f.anchorTag === 'gym' || (f.anchorId || '').startsWith('gym-')
  await placeAttachments(attachedDefs.filter((f) => !isGymAnchored(f)))

  for (let i = 0; i < days; i++) {
    const w = plannedWorkoutFor(gym, new Date(dayMs(i) + 43200000), now)
    if (!w) continue
    const dur = workoutDuration(gym, w.id) * MIN
    const dayHours = gym.hours[gymDayKey(new Date(dayMs(i) + 43200000))] || {}
    const winStart = hmToMin(dayHours.open) != null ? atTime(dayMs(i), hmToMin(dayHours.open)) : -Infinity
    const winEnd = hmToMin(dayHours.close) != null ? atTime(dayMs(i), hmToMin(dayHours.close)) : Infinity
    let placed = false
    for (const g of awakeGaps(i)) {
      const from = locAt(g.start)
      const driveIn = (gymLoc && from.loc && (from.addr !== gym.address))
        ? ((await routeMinutes(s, from.loc, gymLoc)) ?? 0) + Number(s.buffer) : 0
      // The way OUT matters too, and it's a COMPOSED train, not one leg: after
      // the gym come its after-attachments (gymExtraAfter minutes — e.g. drive
      // home + a post-gym routine), and from wherever THAT ends (home, if any
      // attachment goes home; else the gym) the chain still has to drive to the
      // next located block (a class, a shift, sleep). Every piece must fit
      // before that block starts — min()-ing the legs instead of summing them
      // let long workouts overflow, drawing the drive-to-class over whatever
      // came before it ("Tight" warning + visual overlap). Reserving the full
      // train pushes the gym to a later gap instead — e.g. after the class.
      const nxt = blocks.filter((b) => b.loc && b.start >= g.end).sort((a, z) => a.start - z.start)[0]
      const trainEndsHome = attachedDefs.some((f) => f.anchorTag === 'gym' && f.side !== 'before' && f.place === 'home')
      const outFrom = trainEndsHome ? homeLoc : gymLoc
      const outFromAddr = trainEndsHome ? s.home : gym.address
      const outLeg = (outFrom && nxt && nxt.loc && nxt.addr !== outFromAddr)
        ? ((await routeMinutes(s, outFrom, nxt.loc)) ?? 0) + Number(s.buffer) : 0
      const startAt = Math.max(g.start + (driveIn + gymExtraBefore) * MIN, winStart)
      const gymEnd = startAt + dur
      if (gymEnd > winEnd) continue // gym hours
      if (gymEnd + gymExtraAfter * MIN > g.end) continue // train inside the gap
      if (nxt && gymEnd + (gymExtraAfter + outLeg) * MIN > nxt.start) continue // train + final leg before the next event
      blocks.push({ id: `gym-${i}`, type: 'gym', title: w.name, start: startAt, end: startAt + dur, addr: gym.address || null, loc: gymLoc })
      blocks.sort((a, b) => a.start - b.start)
      placed = true
      break
    }
    if (!placed) unplaced.push({ title: `${w.name} (gym)`, minutes: dur / MIN, when: dateKey(dayMs(i)) })
  }

  await placeAttachments(attachedDefs.filter(isGymAnchored))

  // -- drive pass: one drive block before every located block whose location
  // differs from where the chain currently is
  // A destination that IS one of the settings-defined places (home/work/gym)
  // gets that canonical name instead of the event's own title — "drive to the
  // gym", not "drive to Push day".
  const norm = (a) => String(a || '').trim().toLowerCase()
  const placeLabel = (addr) => {
    const a = norm(addr)
    if (!a) return null
    if (s.home && a === norm(s.home)) return 'home'
    if (work.address && a === norm(work.address)) return 'work'
    if (gym.address && a === norm(gym.address)) return 'gym'
    return null
  }
  // The drive home that leads into the bedtime sequence — the sleep block, or a
  // sleep-anchored evening routine pinned before it — is only worth showing when
  // it's actually part of getting to bed. If the last place you had to be ended
  // more than an hour before that drive would start, the evening is free time
  // (gym at noon, bed at midnight) and the drive is noise; drop it. A late last
  // event (work till 11:30) leaves ~no slack, so its drive home stays.
  const FREE_SLACK = 60 * MIN
  const intoBedtime = (b) => b.type === 'sleep' || (b.attached && b.side === 'before' && String(b.anchorId || '').startsWith('sleep-'))
  let cur = { loc: homeLoc, addr: s.home || 'home' }
  let curEnd = -Infinity // end of the last LOCATED block — when you were last somewhere
  let prevEnd = -Infinity
  const drives = []
  for (const b of blocks) {
    if (b.loc && cur.loc && b.addr !== cur.addr) {
      const mins = await routeMinutes(s, cur.loc, b.loc)
      if (mins != null) {
        const total = mins + Number(s.buffer)
        const dStart = b.start - total * MIN
        if (intoBedtime(b) && dStart - curEnd > FREE_SLACK) {
          // free evening → you drifted home on your own time, no scheduled drive
        } else {
          // toId/toType/toTitle bind the drive to the block it arrives at, so the
          // UI can attach it (same lane, destination accent, no gap). toPlace is
          // the canonical place word when the destination is a settings location.
          drives.push({ id: `drive-${b.id}`, type: 'drive', title: `Drive · ${mins}+${s.buffer} min`, start: dStart, end: b.start, minutes: total, mins, toId: b.id, toType: b.type, toTitle: b.title, toPlace: placeLabel(b.addr) })
          if (dStart < prevEnd) warnings.push(`Tight: the drive to “${b.title}” overlaps what's before it.`)
        }
      } else warnings.push(`No route found to “${b.title}”.`)
    }
    if (b.loc) { cur = { loc: b.loc, addr: b.addr }; curEnd = b.end }
    prevEnd = Math.max(prevEnd, b.end)
  }
  blocks.push(...drives)
  blocks.sort((a, b) => a.start - b.start)

  // -- flexible placement: meals → day/recurring flex → week flex. Placed at
  // each item's natural slot (meal pref time, earliest gap) with NO "not before
  // now" floor — today is planned like any other day.
  for (let i = 0; i < days; i++) {
    let gaps = awakeGaps(i)
    const day = dayMs(i)
    for (const m of s.meals) {
      if (!m.enabled) continue
      const pref = atTime(day, hmToMin(m.pref) ?? 720)
      const dur = Number(m.duration) * MIN
      const at = placeNear(gaps, pref, dur)
      if (at == null) { unplaced.push({ title: m.name, minutes: m.duration, when: dateKey(day) }); continue }
      blocks.push({ id: `meal-${m.id}-${i}`, type: 'meal', title: m.name, start: at, end: at + dur, mealId: m.id })
      gaps = subtract(gaps, at, at + dur)
    }
    const dayFlex = s.flex.filter((f) =>
      (f.kind === 'day' && f.date === dateKey(day)) ||
      (f.kind === 'recur' && f.weekday === new Date(day + 43200000).getDay()))
    for (const f of dayFlex) {
      const dur = f.minutes * MIN
      const at = placeEarliest(gaps, dur)
      if (at == null) { unplaced.push({ title: f.title, minutes: f.minutes, when: dateKey(day) }); continue }
      blocks.push({ id: `flex-${f.id}-${i}`, type: 'flex', title: f.title, start: at, end: at + dur, flexId: f.id })
      gaps = subtract(gaps, at, at + dur)
    }
  }
  // week-level flex: earliest fit anywhere in the window
  {
    let all = []
    for (let i = 0; i < days; i++) all = all.concat(awakeGaps(i))
    all.sort((a, b) => a.start - b.start)
    for (const f of s.flex.filter((x) => x.kind === 'week')) {
      const dur = f.minutes * MIN
      const at = placeEarliest(all, dur)
      if (at == null) { unplaced.push({ title: f.title, minutes: f.minutes, when: 'this window' }); continue }
      blocks.push({ id: `flex-${f.id}`, type: 'flex', title: f.title, start: at, end: at + dur, flexId: f.id })
      all = subtract(all, at, at + dur)
    }
  }

  blocks.sort((a, b) => a.start - b.start)
  return { blocks, unplaced, warnings, windowStart, windowEnd, days }
}
