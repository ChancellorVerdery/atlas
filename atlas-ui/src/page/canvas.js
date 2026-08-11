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
  return s
}

// When the user set a nickname in Canvas, the API returns it as `name` and
// moves the real name to `original_name` — prefer the nickname everywhere,
// falling back to the short course code for compact spots.
export const courseLabel = (c) => (c.original_name ? c.name : c.course_code || c.name)
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

export const courseCredits = (s, courseId) => {
  const n = Number(s.credits[courseId])
  return Number.isFinite(n) && n > 0 ? n : 3 // ponytail: 3-credit default until the user sets real hours
}

export function courseLetter(c, scale) {
  const { pct, letter } = courseScore(c)
  if (pct != null) return pctToLetter(pct, scale)
  if (letter) return scale === 'letters' ? letter[0] : letter
  return null
}

export function semesterGPA(courses, s = loadCanvas()) {
  let pts = 0, cr = 0
  for (const c of courses) {
    const p = letterPoints(courseLetter(c, s.scale))
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
