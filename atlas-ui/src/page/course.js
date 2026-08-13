// Course Planner plugin — data + degree-route scheduler. Pure data/localStorage
// (UI lives in courseui.js). The user records past + current semesters with the
// classes taken, plus the remaining required classes — each with credit hours,
// prerequisites (must be an EARLIER term) and corequisites (SAME term or
// earlier — a class in both buckets simply needs to satisfy both), and whether
// it's offered in summer. The scheduler lays out the route to finish,
// respecting a per-term credit cap, summer availability, and disabled terms,
// under one of three strategies.

const KEY = 'atlas.course.v1'
const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const isObj = (o) => o !== null && typeof o === 'object'

export const SEASONS = ['spring', 'summer', 'fall']
export const SEASON_LABEL = { spring: 'Spring', summer: 'Summer', fall: 'Fall' }
const seasonOrder = { spring: 0, summer: 1, fall: 2 }
export const STRATEGIES = [
  ['soonest-summer', 'Graduate soonest (use summers)'],
  ['soonest-optional-summer', 'Soonest — summers only if they save a term'],
  ['even', 'Lighter, even load'],
]

export const termKey = (season, year) => `${season}-${year}`
export const parseTerm = (key) => { const [season, year] = String(key).split('-'); return { season, year: Number(year) } }
export const termLabel = (key) => { const { season, year } = parseTerm(key); return `${SEASON_LABEL[season] || season} ${year}` }
export const termRank = (key) => { const { season, year } = parseTerm(key); return year * 3 + (seasonOrder[season] ?? 0) }
export function nextTermKey(key) {
  const { season, year } = parseTerm(key)
  const i = seasonOrder[season]
  return i === 2 ? termKey('spring', year + 1) : termKey(SEASONS[i + 1], year) // fall→next spring; spring→summer→fall
}
// The academic term containing a date (used only when the user has no terms yet)
export function currentTermKey(now = new Date()) {
  const m = now.getMonth() // 0-based
  const season = m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'fall' // Jan–May spring, Jun–Aug summer, Sep–Dec fall
  return termKey(season, now.getFullYear())
}

export function loadCourse() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (!Array.isArray(s.courses)) s.courses = []
  s.courses = s.courses.filter((c) => isObj(c) && c.id).map((c) => ({
    id: c.id,
    code: String(c.code || '').trim(),
    title: String(c.title || '').trim(),
    credits: Number.isFinite(Number(c.credits)) && Number(c.credits) >= 0 ? Number(c.credits) : 3,
    prereqs: cleanRefs(c.prereqs),
    coreqs: cleanRefs(c.coreqs),
    summerOk: !!c.summerOk,
    term: typeof c.term === 'string' && c.term ? c.term : null, // past/current term key, or null = still to take
  }))
  if (!Array.isArray(s.terms)) s.terms = []
  const seen = new Set()
  s.terms = s.terms
    .filter((t) => isObj(t) && SEASONS.includes(t.season) && Number.isFinite(Number(t.year)))
    .map((t) => ({ key: termKey(t.season, Number(t.year)), season: t.season, year: Number(t.year), current: !!t.current }))
    .filter((t) => !seen.has(t.key) && seen.add(t.key))
    .sort((a, b) => termRank(a.key) - termRank(b.key))
  // at most one current term (the latest wins if several were flagged)
  const currents = s.terms.filter((t) => t.current)
  if (currents.length > 1) for (const t of currents.slice(0, -1)) t.current = false
  if (!Array.isArray(s.disabledTerms)) s.disabledTerms = []
  s.disabledTerms = s.disabledTerms.filter((k) => typeof k === 'string')
  if (!isObj(s.settings)) s.settings = {}
  const g = s.settings
  if (!Number.isFinite(Number(g.maxCredits)) || g.maxCredits <= 0) g.maxCredits = 15
  if (!Number.isFinite(Number(g.summerMax)) || g.summerMax < 0) g.summerMax = Math.min(9, g.maxCredits)
  if (!STRATEGIES.some(([k]) => k === g.strategy)) g.strategy = 'soonest-summer'
  return s
}
const cleanRefs = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : [])
export function saveCourse(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

// ---- CRUD ------------------------------------------------------------------

export function addTerm(s, { season, year, current }) {
  if (!SEASONS.includes(season) || !Number.isFinite(Number(year))) return null
  const key = termKey(season, Number(year))
  if (s.terms.some((t) => t.key === key)) return s.terms.find((t) => t.key === key)
  if (current) s.terms.forEach((t) => { t.current = false })
  const t = { key, season, year: Number(year), current: !!current }
  s.terms.push(t)
  s.terms.sort((a, b) => termRank(a.key) - termRank(b.key))
  saveCourse(s)
  return t
}
export function setCurrentTerm(s, key) {
  s.terms.forEach((t) => { t.current = t.key === key })
  saveCourse(s)
}
export function removeTerm(s, key) {
  s.terms = s.terms.filter((t) => t.key !== key)
  for (const c of s.courses) if (c.term === key) c.term = null // its classes fall back to "to take"
  saveCourse(s)
}
export function addCourse(s, { code, title, credits, prereqs, coreqs, summerOk, term }) {
  const c = {
    id: uid('c'), code: String(code || '').trim(), title: String(title || '').trim(),
    credits: Number.isFinite(Number(credits)) && Number(credits) >= 0 ? Number(credits) : 3,
    prereqs: cleanRefs(prereqs), coreqs: cleanRefs(coreqs),
    summerOk: !!summerOk, term: term || null,
  }
  if (!c.code && !c.title) return null
  s.courses.push(c)
  saveCourse(s)
  return c
}
export function updateCourse(s, id, patch) {
  const c = s.courses.find((x) => x.id === id)
  if (!c) return null
  if ('code' in patch) c.code = String(patch.code || '').trim()
  if ('title' in patch) c.title = String(patch.title || '').trim()
  if ('credits' in patch) c.credits = Number.isFinite(Number(patch.credits)) && Number(patch.credits) >= 0 ? Number(patch.credits) : c.credits
  if ('prereqs' in patch) c.prereqs = cleanRefs(patch.prereqs)
  if ('coreqs' in patch) c.coreqs = cleanRefs(patch.coreqs)
  if ('summerOk' in patch) c.summerOk = !!patch.summerOk
  if ('term' in patch) c.term = patch.term || null
  saveCourse(s)
  return c
}
export function removeCourse(s, id) {
  s.courses = s.courses.filter((x) => x.id !== id)
  saveCourse(s)
}
export function setSetting(s, key, value) {
  if (key === 'maxCredits' || key === 'summerMax') s.settings[key] = Math.max(0, Number(value) || 0)
  else if (key === 'strategy' && STRATEGIES.some(([k]) => k === value)) s.settings.strategy = value
  saveCourse(s)
}
export function toggleDisabledTerm(s, key) {
  s.disabledTerms = s.disabledTerms.includes(key) ? s.disabledTerms.filter((k) => k !== key) : [...s.disabledTerms, key]
  saveCourse(s)
}

// ---- scheduler -------------------------------------------------------------
// Greedy critical-path packing: walk terms forward; in each, fill up to the
// credit cap with the eligible classes that gate the most downstream work,
// pulling a class's same-term corequisites in as an atomic group.
// ponytail: greedy heuristic, not an ILP — near-optimal for real course DAGs,
// and it never violates a prereq/coreq/cap; upgrade to an optimizer only if a
// real plan comes out visibly worse than a human's.

const norm = (x) => String(x || '').trim().toLowerCase()

export function scheduleDegree(s, now = new Date()) {
  const byId = new Map(s.courses.map((c) => [c.id, c]))
  const byCode = new Map()
  for (const c of s.courses) if (c.code) byCode.set(norm(c.code), c)
  const idOf = (ref) => byCode.get(norm(ref))?.id
  // resolve requirement code-refs to ids that exist in the plan (unknown refs
  // are dropped — a class can't wait on something the user never entered)
  const preOf = (c) => c.prereqs.map(idOf).filter(Boolean)
  const coOf = (c) => c.coreqs.map(idOf).filter(Boolean) // same-or-earlier

  // downstream weight: how much work is gated behind a class (longer = do sooner)
  const dependents = new Map(s.courses.map((c) => [c.id, []]))
  for (const c of s.courses) for (const r of [...preOf(c), ...coOf(c)]) dependents.get(r)?.push(c.id)
  const depthMemo = new Map()
  const depthOf = (id, seen = new Set()) => {
    if (depthMemo.has(id)) return depthMemo.get(id)
    if (seen.has(id)) return 0 // cycle guard
    seen.add(id)
    const d = 1 + (dependents.get(id) || []).reduce((m, x) => Math.max(m, depthOf(x, seen)), 0)
    seen.delete(id)
    depthMemo.set(id, d)
    return d
  }

  const disabled = new Set(s.disabledTerms)
  const donePrior = new Set(s.courses.filter((c) => c.term).map((c) => c.id)) // past+current → before term 1
  const startCursor = s.terms.length ? s.terms[s.terms.length - 1].key : prevTermKey(currentTermKey(now))
  const remaining = s.courses.filter((c) => !c.term)
  const g = s.settings
  const capFor = (key) => (parseTerm(key).season === 'summer' ? Number(g.summerMax) : Number(g.maxCredits))

  // one packing run over generated future terms
  const runPlan = ({ useSummers, capScale = 1 }) => {
    const prior = new Set(donePrior)
    let rem = [...remaining].sort((a, b) => (depthOf(b.id) - depthOf(a.id)) || (b.credits - a.credits) || norm(a.code).localeCompare(norm(b.code)))
    const remSet = new Set(rem.map((c) => c.id))
    const terms = []
    let cursor = startCursor
    for (let guard = 0; rem.length && guard < 60; guard++) {
      cursor = nextTermKey(cursor)
      const season = parseTerm(cursor).season
      if (disabled.has(cursor)) continue
      if (season === 'summer' && !useSummers) continue
      const cap = Math.max(0, Math.round(capFor(cursor) * capScale))
      const picked = []
      let credits = 0
      let added = true
      while (added) {
        added = false
        for (const c of rem) {
          if (picked.includes(c)) continue
          // atomic group = c + its unmet same-or-earlier coreqs still to-take.
          // Members already scheduled THIS term satisfy the coreq (same term),
          // so only the not-yet-picked ones actually get added.
          const group = groupClosure(c, { coOf, prior, remSet, byId })
          const newOnes = group.filter((x) => !picked.includes(x))
          if (!newOnes.length) continue
          if (!newOnes.every((x) => preOf(x).every((r) => prior.has(r)))) continue // prereqs must be earlier
          if (season === 'summer' && !newOnes.every((x) => x.summerOk)) continue // summer offering
          const addCred = newOnes.reduce((t, x) => t + x.credits, 0)
          if (credits + addCred > cap) continue
          for (const x of newOnes) { picked.push(x); credits += x.credits }
          added = true
        }
      }
      if (picked.length) {
        terms.push({ key: cursor, ...parseTerm(cursor), courseIds: picked.map((c) => c.id), credits })
        for (const c of picked) { prior.add(c.id); remSet.delete(c.id) }
        rem = rem.filter((c) => remSet.has(c.id))
      }
    }
    return { terms, unplaceable: rem.map((c) => c.id) }
  }

  let plan
  if (g.strategy === 'even') {
    const soonest = runPlan({ useSummers: false })
    if (soonest.unplaceable.length) plan = runPlan({ useSummers: true }) // couldn't finish w/o summers → use them
    else {
      // spread the same number of terms with a lighter per-term cap — but the
      // scaled cap can fall below one big class's credits, so if the light plan
      // can't place everything, keep the full-cap plan rather than failing.
      const totalRem = remaining.reduce((t, c) => t + c.credits, 0)
      const target = Math.ceil(totalRem / Math.max(1, soonest.terms.length))
      const light = runPlan({ useSummers: false, capScale: Math.min(1, target / Number(g.maxCredits)) })
      plan = light.unplaceable.length ? soonest : light
    }
  } else if (g.strategy === 'soonest-optional-summer') {
    const withS = runPlan({ useSummers: true })
    const without = runPlan({ useSummers: false })
    const finishRank = (p) => (p.unplaceable.length ? Infinity : (p.terms.length ? termRank(p.terms[p.terms.length - 1].key) : -Infinity))
    plan = finishRank(withS) < finishRank(without) ? withS : without // summers only if they finish strictly earlier
  } else {
    plan = runPlan({ useSummers: true })
  }

  // full board: user terms (past/current) + planned future terms, chronological
  const userTerms = s.terms.map((t) => ({
    key: t.key, season: t.season, year: t.year, current: t.current, kind: t.current ? 'current' : 'past',
    courseIds: s.courses.filter((c) => c.term === t.key).map((c) => c.id),
  }))
  const planned = plan.terms.map((t) => ({ ...t, current: false, kind: 'future' }))
  const board = [...userTerms, ...planned].sort((a, b) => termRank(a.key) - termRank(b.key))
  for (const t of board) t.credits = t.courseIds.reduce((sum, id) => sum + (byId.get(id)?.credits || 0), 0)

  // prereq/coreq edges for the board (only between courses that are placed)
  const termOfCourse = new Map()
  for (const t of board) for (const id of t.courseIds) termOfCourse.set(id, t.key)
  const edges = []
  for (const c of s.courses) {
    for (const [kind, ids] of [['prereq', preOf(c)], ['coreq', coOf(c)]]) {
      for (const r of ids) {
        if (termOfCourse.has(r) && termOfCourse.has(c.id)) edges.push({ from: r, to: c.id, kind })
      }
    }
  }
  const warnings = []
  if (plan.unplaceable.length) {
    const names = plan.unplaceable.map((id) => byId.get(id)?.code || byId.get(id)?.title || id)
    warnings.push(`Couldn't place: ${names.join(', ')} — check for missing prerequisites or a prerequisite cycle.`)
  }
  const termsToFinish = plan.terms.length
  const gradTerm = board.length ? board[board.length - 1].key : null
  return { board, edges, unplaceable: plan.unplaceable, warnings, termsToFinish, gradTerm }
}

// c plus the still-to-take corequisites (same-or-earlier) that aren't already
// satisfied by an earlier term — those must share c's term, so they schedule
// as one unit. Recurses through the coreq chain; cycle-safe via the set.
function groupClosure(c, { coOf, prior, remSet, byId }) {
  const group = new Set([c.id])
  const stack = [c]
  while (stack.length) {
    const x = stack.pop()
    for (const r of coOf(x)) {
      if (prior.has(r) || group.has(r) || !remSet.has(r)) continue // satisfied earlier, seen, or not a to-take course
      group.add(r)
      stack.push(byId.get(r))
    }
  }
  return [...group].map((id) => byId.get(id))
}

const prevTermKey = (key) => {
  const { season, year } = parseTerm(key)
  const i = seasonOrder[season]
  return i === 0 ? termKey('fall', year - 1) : termKey(SEASONS[i - 1], year)
}
