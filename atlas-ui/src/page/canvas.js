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
  return s
}

// The user can set a per-course nickname and a per-course code in Atlas (Canvas's
// own course_code like 'MATH-1241-001' is ugly). The widgets render every course
// in one of two modes, all-or-nothing: NICK shows the nickname (user's, else the
// Canvas name), CODE shows the code (user's, else Canvas's course_code).
export const courseNick = (c, labels = loadCanvas().labels) => labels[c.id]?.nick || c.name
export const courseCodeOf = (c, labels = loadCanvas().labels) => labels[c.id]?.code || c.course_code || c.name
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
  if (pct != null) return cuts ? cutsToLetter(pct, cuts) : pctToLetter(pct, s.scale)
  if (letter) return s.scale === 'letters' && !cuts ? letter[0] : letter
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
