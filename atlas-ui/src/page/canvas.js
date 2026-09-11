// Canvas plugin — data layer. Talks to the Canvas LMS REST API through the
// dev server's /canvas-proxy middleware (Canvas sends no CORS headers, so the
// browser can't call it directly). Auth = personal access token the user
// creates in Canvas → Account → Settings, stored locally with the host.
// GPA: Canvas gives per-course percentages/letters but no credit hours or
// grade points — credits and previous semesters live in this store.

const KEY = 'atlas.canvas.v1'

export function loadCanvas() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (typeof s.host !== 'string') s.host = ''
  if (typeof s.token !== 'string') s.token = ''
  if (s.scale !== 'letters') s.scale = 'plusminus'
  if (!s.credits || typeof s.credits !== 'object') s.credits = {} // courseId → hours
  if (!Array.isArray(s.semesters)) s.semesters = [] // {id, name, gpa, credits}
  if (!Array.isArray(s.dismissed)) s.dismissed = [] // "courseId:assignmentId" hidden overdue
  if (!Array.isArray(s.hiddenCourses)) s.hiddenCourses = [] // courseIds excluded from every widget
  if (!s.labels || typeof s.labels !== 'object') s.labels = {} // courseId → {nick, code} (user-set, Atlas-local)
  if (!s.scales || typeof s.scales !== 'object') s.scales = {} // courseId → "A 90, B 80" custom cutoffs
  if (!s.scaleModes || typeof s.scaleModes !== 'object') s.scaleModes = {} // courseId → 'plusminus' | 'letters'
  return s
}

// The user can set a per-course nickname and a per-course code in Atlas (Canvas's
// own course_code like 'MATH-1241-001' is ugly). The widgets render every course
// in one of two modes, all-or-nothing: NICK shows the nickname, CODE shows the
// code (user's, else Canvas's course_code).
//
// The full Canvas name is the LAST resort, never an early one: UNCC's is the raw
// SIS title ('202680-MEGR-2141-Engineering Mechanics I-005-006-XLS2112202680_
// Combined'), which blows out every tag it lands in. A nickname set in Canvas
// itself counts as a nickname here — Canvas returns it in `name` and moves the
// real title to `original_name`, so `original_name` present means `name` is
// already nicknamed.
const canvasNick = (c) => (c.original_name ? c.name : null)
export const courseNick = (c, labels = loadCanvas().labels) =>
  labels[c.id]?.nick || canvasNick(c) || c.course_code || c.name
// CODE mode exists to make labels SHORTER when they overflow their tag. Canvas's
// course_code is only sometimes short: UNCC returns 'MEGR-3111-004-14239' for a
// plain section but '202680-MEGR-2141-Engineering Mechanics I-005-006-XLS2112
// 202680_Combined' for a cross-listed one — three times longer than the name it
// replaces. Falling to it blindly is what put those strings on screen. Take the
// user's code when set, else whichever of course_code / the nick label is
// actually shorter.
export const courseCodeOf = (c, labels = loadCanvas().labels) => {
  const own = labels[c.id]?.code
  if (own) return own
  const nick = courseNick(c, labels)
  return c.course_code && c.course_code.length < nick.length ? c.course_code : nick
}
export const courseLabel = (c, mode = 'nick', labels = loadCanvas().labels) =>
  (mode === 'code' ? courseCodeOf(c, labels) : courseNick(c, labels))
export function saveCanvas(s) { localStorage.setItem(KEY, JSON.stringify(s)) }
export const canvasConnected = (s = loadCanvas()) => !!(s.host && s.token)

// ---- API (GET-only, paginated) ----------------------------------------------

async function pageFetch(url, token) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (r.status === 401) throw new Error('Canvas rejected the token — generate a new one in Canvas → Account → Settings.')
  if (!r.ok) throw new Error(`Canvas error ${r.status}: ${(await r.text()).slice(0, 200)}`)
  return r
}

export async function capiAll(path, maxPages = 5) {
  const s = loadCanvas()
  if (!canvasConnected(s)) throw new Error('Not connected to Canvas.')
  const out = []
  let url = `/canvas-proxy/${s.host}/api/v1${path}`
  for (let i = 0; i < maxPages && url; i++) {
    const r = await pageFetch(url, s.token)
    const body = await r.json()
    if (Array.isArray(body)) out.push(...body)
    else return body
    const link = r.headers.get('X-Canvas-Link') || ''
    const next = link.split(',').find((p) => p.includes('rel="next"'))?.match(/<([^>]+)>/)?.[1]
    url = next ? next.replace(/^https?:\/\/[^/]+/, `/canvas-proxy/${s.host}`) : null
  }
  return out
}

export const whoAmI = () => capiAll('/users/self')

export async function fetchCanvasData() {
  const courses = (await capiAll('/courses?enrollment_state=active&include[]=total_scores&include[]=term&per_page=50'))
    .filter((c) => c.name && !c.access_restricted_by_date && (c.enrollments || []).some((e) => e.type === 'student'))
  const groupLists = await Promise.all(courses.map((c) =>
    capiAll(`/courses/${c.id}/assignment_groups?include[]=assignments&include[]=submission&per_page=50`).catch(() => [])))
  const ctx = courses.map((c) => `context_codes[]=course_${c.id}`).join('&')
  const announcements = courses.length
    ? await capiAll(`/announcements?${ctx}&per_page=40`).catch(() => []) : []
  const todos = await capiAll('/users/self/todo?per_page=40').catch(() => [])
  return {
    courses,
    groups: Object.fromEntries(courses.map((c, i) => [c.id, groupLists[i]])),
    announcements,
    todos,
  }
}

// ---- grade helpers -------------------------------------------------------------

export function courseScore(c) {
  const e = (c.enrollments || []).find((x) => x.type === 'student')
  return { pct: e?.computed_current_score ?? null, letter: e?.computed_current_grade || null }
}

const CUTS = [[93, 'A'], [90, 'A-'], [87, 'B+'], [83, 'B'], [80, 'B-'], [77, 'C+'], [73, 'C'], [70, 'C-'], [67, 'D+'], [63, 'D'], [60, 'D-'], [0, 'F']]
const POINTS = { A: 4, 'A-': 3.7, 'B+': 3.3, B: 3, 'B-': 2.7, 'C+': 2.3, C: 2, 'C-': 1.7, 'D+': 1.3, D: 1, 'D-': 0.7, F: 0 }

// scale 'plusminus' → A-, B+ … ; scale 'letters' → plain A/B/C/D/F.
export function pctToLetter(pct, scale) {
  if (pct == null || Number.isNaN(pct)) return null
  const letter = CUTS.find(([cut]) => pct >= cut)[1]
  return scale === 'letters' ? letter[0] : letter
}
export const letterPoints = (letter) => (letter in POINTS ? POINTS[letter] : POINTS[letter?.[0]] ?? null)

// A class whose professor grades on a different curve gets its own cutoffs,
// typed in Canvas → Settings as "A 90, B 80, C 70, D 60" (any order, +/- fine).
// ponytail: a text field rather than a per-letter grid — it takes any scale
// including ± ones, and an unparseable string just falls back to the global one.
export function parseScale(text) {
  const cuts = []
  for (const m of String(text ?? '').matchAll(/([A-F][+-]?)\s*:?\s*(\d{1,3}(?:\.\d+)?)/gi)) {
    const letter = m[1].toUpperCase()
    if (letterPoints(letter) == null) continue // drops 'E' and anything else off the ladder
    cuts.push([Number(m[2]), letter])
  }
  if (!cuts.length) return null
  cuts.sort((a, b) => b[0] - a[0])
  if (cuts[cuts.length - 1][0] > 0) cuts.push([0, 'F']) // everything under the lowest cutoff fails
  return cuts
}
export const cutsToLetter = (pct, cuts) => cuts.find(([cut]) => pct >= cut)?.[1] ?? 'F'
export const courseScale = (s, courseId) => parseScale(s.scales?.[courseId])

// Which letter LADDER a course is graded on — whether A- and B+ exist at all.
// Distinct from `scales` above: cutoffs say where the boundaries sit, this says
// whether the grade that comes out carries a +/- and therefore whether it is
// worth 4.0 or 3.7. Departments differ on this inside one transcript (a class
// graded straight A/B/C/D/F next to one that isn't), and the setting used to be
// global, so the whole GPA had to be computed on whichever ladder was wrong for
// the other half of the courses. An unset course inherits the global scale.
export const courseScaleMode = (s, courseId) => {
  const m = s.scaleModes?.[courseId]
  return m === 'letters' || m === 'plusminus' ? m : s.scale
}

export const courseCredits = (s, courseId) => {
  const n = Number(s.credits[courseId])
  return Number.isFinite(n) && n > 0 ? n : 3 // ponytail: 3-credit default until the user sets real hours
}

// A course's own scale wins over the global one — and over Canvas's letter,
// which is computed with the scheme the professor put in Canvas (the thing
// being overridden here).
export function courseLetter(c, s = loadCanvas()) {
  const { pct, letter } = courseScore(c)
  const cuts = courseScale(s, c.id)
  const mode = courseScaleMode(s, c.id)
  // The ladder is applied LAST, so the two per-course settings compose: custom
  // cutoffs decide which band a percentage lands in, the ladder decides whether
  // that band keeps its +/-. Without this a course with both set would report
  // an A- on a ladder that has no A-.
  if (pct != null) {
    const l = cuts ? cutsToLetter(pct, cuts) : pctToLetter(pct, mode)
    return mode === 'letters' && l ? l[0] : l
  }
  if (letter) return mode === 'letters' && !cuts ? letter[0] : letter
  return null
}

export function semesterGPA(courses, s = loadCanvas()) {
  let pts = 0, cr = 0
  for (const c of courses) {
    const p = letterPoints(courseLetter(c, s))
    if (p == null) continue
    const hours = courseCredits(s, c.id)
    pts += p * hours
    cr += hours
  }
  return cr ? { gpa: pts / cr, credits: cr } : null
}

// A previous semester is either entered as an overall GPA + credits, or as a
// list of classes {name, grade, credits} from which both are computed.
export function semesterValue(sem) {
  if (Array.isArray(sem.classes) && sem.classes.length) {
    let pts = 0, cr = 0
    for (const cl of sem.classes) {
      const p = letterPoints(cl.grade)
      const h = Number(cl.credits)
      if (p == null || !Number.isFinite(h) || h <= 0) continue
      pts += p * h
      cr += h
    }
    return cr ? { gpa: pts / cr, credits: cr } : null
  }
  const g = Number(sem.gpa), h = Number(sem.credits)
  return Number.isFinite(g) && Number.isFinite(h) && h > 0 ? { gpa: g, credits: h } : null
}

export function overallGPA(courses, s = loadCanvas()) {
  let pts = 0, cr = 0
  for (const sem of s.semesters) {
    const v = semesterValue(sem)
    if (v) { pts += v.gpa * v.credits; cr += v.credits }
  }
  const cur = semesterGPA(courses, s)
  if (cur) { pts += cur.gpa * cur.credits; cr += cur.credits }
  return cr ? { gpa: pts / cr, credits: cr } : null
}

// ---- local grade model ---------------------------------------------------------
// Canvas hands over `computed_current_score` but no way to ask "what would it be
// without assignment X" — which is what the gradebook's ▲/▼ shows. So this
// re-derives Canvas's current score from the assignment groups: graded, non-
// excused submissions only, group weights when the course applies them, and each
// group's drop rules. Where the two disagree Canvas is right and the arrows are
// hidden rather than shown wrong (see courseEffects).

const countsNow = (a) => a.submission?.score != null && !a.submission.excused && !a.omit_from_final_grade && a.grading_type !== 'not_graded'

// Canvas's drop_lowest/drop_highest keep the subset that maximises (or minimises)
// Σscore/Σpossible — NOT the N lowest percentages, which is wrong once point
// values differ. The optimal ratio q* is the root of F(q) = Σ(score − q·possible)
// over the best subset, which is decreasing in q; bisect for it, then the kept
// set is the top-`keep` by (score − q*·possible). Same shape as Canvas's
// GradeCalculator#drop_pointed. `fixed` (never_drop, zero-point) always stays.
function keepBest(items, fixed, keep, lowest) {
  if (items.length <= keep) return items
  const sign = lowest ? -1 : 1 // dropping the highest = keeping the worst ratio
  const rank = (q) => items.slice().sort((a, b) => sign * ((b.score - q * b.possible) - (a.score - q * a.possible))).slice(0, keep)
  const F = (q) => [...fixed, ...rank(q)].reduce((t, s) => t + s.score - q * s.possible, 0)
  let lo = Math.min(0, ...items.map((s) => s.score / s.possible)), hi = Math.max(1, ...items.map((s) => s.score / s.possible)) + 1
  for (let i = 0; i < 50 && hi - lo > 1e-9; i++) {
    const mid = (lo + hi) / 2
    if (F(mid) > 0) lo = mid; else hi = mid
  }
  return rank((lo + hi) / 2)
}

// The assignments that count toward a group's current score after its drop rules.
export function keptAssignments(g, skip = null) {
  const graded = (g.assignments || []).filter((a) => countsNow(a) && a.id !== skip)
  const rules = g.rules || {}
  const never = new Set(rules.never_drop || [])
  const item = (a) => ({ a, score: a.submission.score, possible: a.points_possible })
  const fixed = graded.filter((a) => never.has(a.id) || !(a.points_possible > 0)).map(item)
  let pool = graded.filter((a) => !never.has(a.id) && a.points_possible > 0).map(item)
  let dropLow = rules.drop_lowest || 0, dropHigh = rules.drop_highest || 0
  if ((dropLow || dropHigh) && pool.length) {
    if (dropLow >= pool.length) dropLow = pool.length - 1 // Canvas keeps at least one
    if (dropLow + dropHigh >= pool.length) dropHigh = 0
    pool = keepBest(pool, fixed, pool.length - dropLow, false)
    pool = keepBest(pool, fixed, pool.length - dropHigh, true)
  }
  return [...fixed, ...pool].map((s) => s.a)
}

// Canvas's current score for a course, or null when nothing is graded yet.
// `skip` recomputes as if that assignment did not exist.
export function localScore(c, groups, skip = null) {
  const sums = groups.map((g) => {
    const kept = keptAssignments(g, skip)
    return { score: kept.reduce((t, a) => t + a.submission.score, 0), possible: kept.reduce((t, a) => t + a.points_possible, 0), weight: g.group_weight || 0 }
  })
  if (c.apply_assignment_group_weights) {
    const live = sums.filter((s) => s.possible > 0)
    const full = live.reduce((t, s) => t + s.weight, 0)
    if (!full) return null
    // weights summing past 100 let the grade exceed 100, as in Canvas
    return (live.reduce((t, s) => t + (s.score / s.possible) * s.weight, 0) / Math.min(full, 100)) * 100
  }
  const score = sums.reduce((t, s) => t + s.score, 0), possible = sums.reduce((t, s) => t + s.possible, 0)
  return possible > 0 ? (score / possible) * 100 : null
}

// assignmentId → how many points this assignment moved the course grade, for
// every assignment that currently counts; dropped ones map to null. Empty when
// the model can't be trusted: nothing graded, or it disagrees with Canvas's own
// number (a rule we don't model), in which case the UI shows no arrows.
export function courseEffects(c, groups) {
  const base = localScore(c, groups)
  const canvas = courseScore(c).pct
  if (base == null || (canvas != null && Math.abs(base - canvas) > 0.5)) return new Map()
  const out = new Map()
  for (const g of groups) {
    const kept = new Set(keptAssignments(g).map((a) => a.id))
    for (const a of (g.assignments || []).filter(countsNow)) {
      out.set(a.id, kept.has(a.id) ? base - (localScore(c, groups, a.id) ?? 0) : null)
    }
  }
  return out
}

// ≥10 points reads fine to one decimal; under that the second decimal is the
// whole story ("0.35" vs "0.4").
export const fmtEffect = (d) => Math.abs(d).toFixed(Math.abs(d) >= 10 ? 1 : 2)

// ---- assignment helpers ----------------------------------------------------------

export const dueDate = (a) => (a.due_at ? new Date(a.due_at) : null)
export const isSubmitted = (a) => !!(a.submission?.submitted_at || a.submission?.score != null || a.submission?.excused)
export const isOverdue = (a, now = new Date()) => {
  const d = dueDate(a)
  return !!d && d < now && !isSubmitted(a) && a.submission?.workflow_state !== 'graded'
}
export const overdueKey = (courseId, a) => `${courseId}:${a.id}`

export function dismissOverdue(courseId, a) {
  const s = loadCanvas()
  const k = overdueKey(courseId, a)
  if (!s.dismissed.includes(k)) s.dismissed.push(k)
  saveCanvas(s)
}
export function clearDismissed() {
  const s = loadCanvas()
  s.dismissed = []
  saveCanvas(s)
}
