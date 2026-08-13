// Flashcards plugin — data layer + spaced repetition. Split out of Study
// (2026-08): each tab is a course's card deck, scheduled on the 1-3-7-14-21
// ladder. Store atlas.flashcards.v1 rides page.save sync as a raw string
// (sync.js encodePush) — no backend changes. Fully independent from
// atlas.study.v1: its own tabs/courses, never written to by this plugin.
//
// One-time migration: the first load after this plugin ships seeds
// atlas.flashcards.v1 from whatever card data already lives in
// atlas.study.v1 (one flashcards tab per study tab, same name, cards intact
// — box/due SRS state included), so nothing already scheduled is lost. After
// that first write the two stores never touch each other again.

import { uid, fixEscapes } from './study.js'

const KEY = 'atlas.flashcards.v1'
const STUDY_KEY = 'atlas.study.v1'

// ---- store ------------------------------------------------------------------

export function normCard(c) {
  return {
    id: typeof c?.id === 'string' && c.id ? c.id : uid('c'),
    front: fixEscapes(c?.front),
    back: fixEscapes(c?.back),
    box: Math.min(Math.max(Math.trunc(+c?.box) || 0, 0), LADDER.length - 1),
    due: typeof c?.due === 'string' ? c.due : '', // '' = due now
  }
}

function normTab(t) {
  return {
    id: typeof t?.id === 'string' && t.id ? t.id : uid('t'),
    name: String(t?.name ?? 'Course'),
    cards: (Array.isArray(t?.cards) ? t.cards : []).map(normCard),
  }
}

// One-time seed from Study's card data. Guarded on the flashcards key being
// absent — runs at most once, ever, per browser: idempotent by construction
// (a second call sees the key already written and no-ops), and never reads
// or writes atlas.study.v1's own key, so Study is untouched either way.
function migrateFromStudy() {
  if (localStorage.getItem(KEY) !== null) return // already migrated (or real flashcards data exists)
  if (localStorage.getItem(STUDY_KEY) === null) return // nothing to migrate from yet — stay unseeded
  let study
  try { study = JSON.parse(localStorage.getItem(STUDY_KEY)) } catch { study = null }
  const tabs = (Array.isArray(study?.tabs) ? study.tabs : []).map((t) => normTab({ name: t?.name, cards: t?.cards }))
  localStorage.setItem(KEY, JSON.stringify({ tabs, active: tabs[0]?.id || '' }))
}

export function loadFlashcards() {
  migrateFromStudy()
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  const out = { tabs: (Array.isArray(s.tabs) ? s.tabs : []).map(normTab), active: typeof s.active === 'string' ? s.active : '' }
  if (!out.tabs.some((t) => t.id === out.active)) out.active = out.tabs[0]?.id || ''
  return out
}

export function saveFlashcards(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

export const newTab = (name) => normTab({ name })

// ---- spaced repetition ------------------------------------------------------

// Graduated ladder: a miss repeats tomorrow (box 0); each consecutive correct
// promotes one box. Cap = 21 days: Cepeda et al. (2008) put the optimal review
// gap at ~10–20% of the retention interval — for a semester exam 6–16 weeks
// out that's ~8–22 days, and 21 d was their observed optimum at the 70-day
// horizon. A 21-day cap also keeps every card at 4+ spaced retrievals per
// semester, the condition under which expanding schedules beat uniform ones
// (Latimier et al. 2021 meta-analysis).
export const LADDER = [1, 3, 7, 14, 21]

export const localToday = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return localToday(new Date(y, m - 1, d + n))
}

export const dueCards = (tab, today = localToday()) => tab.cards.filter((c) => !c.due || c.due <= today)

// Missed → back to box 0, see it tomorrow. Correct → next box, out
// LADDER[box] days. A same-session recovery after a miss must NOT call this
// again — the miss already demoted the card (the UI just clears its queue).
export function gradeCard(card, correct, today = localToday()) {
  if (!correct) { card.box = 0; card.due = addDays(today, 1); return }
  card.box = Math.min((card.box || 0) + 1, LADDER.length - 1)
  card.due = addDays(today, LADDER[card.box])
}
