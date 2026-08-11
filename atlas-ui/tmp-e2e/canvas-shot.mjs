// Screenshot pass for the canvas plugin (headless, fake Canvas API).
import { chromium } from 'playwright'
const OUT = (process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp'
const now = Date.now()
const dueIn = (d) => new Date(now + d * 86400e3).toISOString()
const sub = (score, submitted = true) => ({ score, submitted_at: submitted ? dueIn(-1) : null, workflow_state: score != null ? 'graded' : submitted ? 'submitted' : 'unsubmitted' })

const COURSES = [
  { id: 101, name: 'Orgo II', original_name: 'Organic Chemistry II', course_code: 'CHEM 302', enrollments: [{ type: 'student', computed_current_score: 94.2, computed_current_grade: 'A' }] },
  { id: 102, name: 'Linear Algebra', course_code: 'MATH 220', enrollments: [{ type: 'student', computed_current_score: 88.4, computed_current_grade: 'B+' }] },
  { id: 103, name: 'Modern Physics', course_code: 'PHYS 310', enrollments: [{ type: 'student', computed_current_score: 91.0, computed_current_grade: 'A-' }] },
]
const GROUPS = {
  101: [
    { id: 1, name: 'Tests', position: 1, group_weight: 40, assignments: [
      { id: 9001, name: 'Midterm 1 — Stereochemistry', points_possible: 100, due_at: dueIn(-21), submission: sub(91) },
      { id: 9002, name: 'Midterm 2 — Carbonyls', points_possible: 100, due_at: dueIn(9), submission: sub(null, false) },
    ] },
    { id: 2, name: 'Quizzes', position: 2, group_weight: 30, assignments: [
      { id: 9003, name: 'Quiz 1 — Nomenclature', points_possible: 10, due_at: dueIn(-16), submission: sub(9.5) },
      { id: 9004, name: 'Quiz 2 — SN1/SN2', points_possible: 10, due_at: dueIn(-9), submission: sub(7) },
      { id: 9005, name: 'Quiz 3 — Eliminations', points_possible: 10, due_at: dueIn(2), submission: sub(null, false) },
    ] },
    { id: 3, name: 'Assignments', position: 3, group_weight: 30, assignments: [
      { id: 9006, name: 'Lab report — Distillation', points_possible: 50, due_at: dueIn(-11), submission: sub(46) },
      { id: 9007, name: 'Problem set 4', points_possible: 20, due_at: dueIn(-3), submission: sub(null, false) },
      { id: 9008, name: 'Mechanism essay draft', points_possible: 30, due_at: dueIn(5), submission: sub(null, true) },
    ] },
  ],
  102: [
    { id: 4, name: 'Homework', position: 1, group_weight: 0, assignments: [
      { id: 9101, name: 'HW 6 — Eigenvalues', points_possible: 20, due_at: dueIn(-12), submission: sub(18) },
      { id: 9102, name: 'HW 7 — Diagonalization', points_possible: 20, due_at: dueIn(-1), submission: sub(null, false) },
      { id: 9103, name: 'HW 8 — SVD', points_possible: 20, due_at: dueIn(4), submission: sub(null, false) },
    ] },
  ],
  103: [
    { id: 5, name: 'Problem sets', position: 1, group_weight: 60, assignments: [
      { id: 9201, name: 'PS 5 — Special relativity', points_possible: 40, due_at: dueIn(3), submission: sub(null, false) },
    ] },
    { id: 6, name: 'Labs', position: 2, group_weight: 40, assignments: [
      { id: 9202, name: 'Photoelectric effect lab', points_possible: 50, due_at: dueIn(-6), submission: sub(47) },
    ] },
  ],
}
const ANNOUNCEMENTS = [
  { id: 501, title: 'Midterm 2 room change', context_code: 'course_101', posted_at: dueIn(-0.5),
    message: '<p>Midterm 2 moves to <b>Auditorium B</b> — same time. Bring your model kits; <i>no calculators needed</i>.</p><p>— Prof. Alvarez</p>' },
  { id: 502, title: 'Office hours shifted this week', context_code: 'course_102', posted_at: dueIn(-1.2), message: '<p>Tuesday 3–5 instead of Monday.</p>' },
  { id: 503, title: 'Lab safety recert due', context_code: 'course_103', posted_at: dueIn(-2.5), message: '<p>Complete the recert module before Friday\'s lab.</p>' },
]
const TODOS = [
  { type: 'submitting', context_name: 'Organic Chemistry II', assignment: { name: 'Problem set 4', due_at: dueIn(-3) } },
  { type: 'submitting', context_name: 'Modern Physics', assignment: { name: 'PS 5 — Special relativity', due_at: dueIn(3) } },
]

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1150 } })
await page.route('**/canvas-proxy/**', (route) => {
  const path = new URL(route.request().url()).pathname.replace(/^\/canvas-proxy\/[^/]+\/api\/v1/, '')
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
  if (path === '/users/self') return json({ id: 1, name: 'Chance V' })
  if (path === '/courses') return json(COURSES)
  const m = path.match(/^\/courses\/(\d+)\/assignment_groups$/)
  if (m) return json(GROUPS[m[1]] || [])
  if (path === '/announcements') return json(ANNOUNCEMENTS)
  if (path === '/users/self/todo') return json(TODOS)
  return json([])
})
await page.addInitScript(() => {
  if (!localStorage.getItem('atlas.canvas.v1')) localStorage.setItem('atlas.canvas.v1', JSON.stringify({
    host: 'school.instructure.com', token: 'tok', scale: 'plusminus',
    credits: { 101: 4, 102: 3, 103: 4 },
    semesters: [{ id: 's1', name: 'Fall 2025', gpa: 3.62, credits: 15 }, { id: 's2', name: 'Spring 2026', classes: [
      { id: 'c1', name: 'Calculus III', grade: 'A-', credits: 4 },
      { id: 'c2', name: 'Intro Philosophy', grade: 'A', credits: 3 },
      { id: 'c3', name: 'Physics I', grade: 'B+', credits: 4 },
      { id: 'c4', name: 'Composition', grade: 'A-', credits: 3 },
    ] }],
    dismissed: [],
  }))
})
await page.goto('http://localhost:5173/#/canvas')
await page.waitForSelector('.cv-pill')
await page.waitForTimeout(1000)
await page.screenshot({ path: `${OUT}/canvas-board.png`, fullPage: false })
await page.locator('[data-cv-widget="cvannounce"] .cv-ann').first().click()
await page.waitForSelector('.cv-overlay')
await page.waitForTimeout(400)
await page.screenshot({ path: `${OUT}/canvas-announcement.png` })
await page.click('[data-cv-x="close"]')
await page.click('.page-tab:has-text("Settings")')
await page.waitForSelector('#cv-host')
await page.waitForSelector('[data-cv-credit]')
await page.waitForTimeout(700)
await page.screenshot({ path: `${OUT}/canvas-settings.png` })
await browser.close()
console.log('shots done')
