// Canvas plugin suite — the Canvas REST API is faked at the network layer
// (requests go to the same-origin /canvas-proxy path, intercepted before the
// dev server sees them), so the real fetch/parse/render/GPA code runs.
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const now = Date.now()
const iso = (offsetDays, h = 23) => new Date(now + offsetDays * 86400e3 + h * 0).toISOString()
const dueIn = (days) => new Date(now + days * 86400e3).toISOString()

const sub = (score, submitted = true) => ({ score, submitted_at: submitted ? iso(-1) : null, workflow_state: score != null ? 'graded' : submitted ? 'submitted' : 'unsubmitted' })
const COURSES = [
  { id: 101, name: 'Physics II Lab', original_name: 'Organic Chemistry', course_code: 'CHEM 301', enrollments: [{ type: 'student', computed_current_score: 95.0, computed_current_grade: 'A' }] },
  { id: 102, name: 'Linear Algebra', course_code: 'MATH 220', enrollments: [{ type: 'student', computed_current_score: 88.0, computed_current_grade: 'B+' }] },
]
const GROUPS = {
  101: [
    { id: 1, name: 'Tests', position: 1, group_weight: 40, assignments: [
      { id: 9001, name: 'Midterm 1', points_possible: 100, due_at: dueIn(-20), submission: sub(88), html_url: 'https://school.instructure.com/courses/101/assignments/9001', description: '<p>Covers <b>chapters 1–4</b>.</p><script>document.body.dataset.cvpwned2="1"</script>' },
      { id: 9002, name: 'Midterm 2', points_possible: 100, due_at: dueIn(10), submission: sub(null, false), html_url: 'https://school.instructure.com/courses/101/assignments/9002', description: '<p>Bring a calculator.</p>' },
    ] },
    { id: 2, name: 'Quizzes', position: 2, group_weight: 30, assignments: [
      { id: 9003, name: 'Quiz 1', points_possible: 10, due_at: dueIn(-15), submission: sub(9) },
      { id: 9004, name: 'Quiz 2', points_possible: 10, due_at: dueIn(-8), submission: sub(7) },
      { id: 9005, name: 'Quiz 3', points_possible: 10, due_at: dueIn(2), submission: sub(null, false) },
    ] },
    { id: 3, name: 'Assignments', position: 3, group_weight: 30, assignments: [
      { id: 9006, name: 'Lab report 1', points_possible: 50, due_at: dueIn(-10), submission: sub(45) },
      { id: 9007, name: 'Problem set 2', points_possible: 20, due_at: dueIn(-3), submission: sub(null, false) },
      { id: 9008, name: 'Essay draft', points_possible: 30, due_at: dueIn(5), submission: sub(null, true) },
    ] },
  ],
  102: [
    { id: 4, name: 'Homework', position: 1, group_weight: 0, assignments: [
      { id: 9101, name: 'HW 1', points_possible: 20, due_at: dueIn(-12), submission: sub(18) },
      { id: 9102, name: 'HW 2', points_possible: 20, due_at: dueIn(-1), submission: sub(null, false) },
    ] },
  ],
}
const ANNOUNCEMENTS = [
  { id: 501, title: 'Exam room change', context_code: 'course_101', posted_at: iso(-1),
    message: '<p>Midterm moved to <b>Hall B</b>.</p><script>document.body.dataset.cvpwned="1"</script>' },
  { id: 502, title: 'Office hours shifted', context_code: 'course_102', posted_at: iso(-2), message: '<p>Now Tuesdays.</p>' },
]
const TODOS = [{ type: 'submitting', context_name: 'Organic Chemistry', course_id: 101, assignment: { id: 9007, name: 'Problem set 2', due_at: dueIn(-3), points_possible: 20, html_url: 'https://school.instructure.com/courses/101/assignments/9007', description: '<p>Show all work.</p>' } }]

const reqs = []
function installFake(page) {
  return page.route('**/canvas-proxy/**', (route) => {
    const req = route.request()
    const u = new URL(req.url())
    reqs.push({ url: u.pathname + u.search, auth: req.headers()['authorization'] })
    const path = u.pathname.replace(/^\/canvas-proxy\/[^/]+\/api\/v1/, '')
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (path === '/users/self') return json({ id: 1, name: 'Chance V' })
    if (path === '/courses') return json(COURSES)
    let m
    if ((m = path.match(/^\/courses\/(\d+)\/assignment_groups$/))) return json(GROUPS[m[1]] || [])
    if (path === '/announcements') return json(ANNOUNCEMENTS)
    if (path === '/users/self/todo') return json(TODOS)
    return json([])
  })
}

const CONNECTED = {
  host: 'school.instructure.com', token: 'tok-123', scale: 'plusminus',
  credits: { 101: 4, 102: 3 }, semesters: [{ id: 's1', name: 'Fall 2025', gpa: 3.5, credits: 15 }], dismissed: [],
}

const browser = await chromium.launch({ headless: true })

// A. unconnected + settings connect flow
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
  const page = await ctx.newPage()
  await installFake(page)
  await page.goto(`${BASE}/#/canvas`)
  await page.waitForSelector('.cv-mount')
  console.log('A. unconnected + connect')
  ok(await page.locator('#title').innerText() === 'Canvas', 'topbar label says Canvas')
  ok(await page.locator('.nav__item', { hasText: 'Canvas' }).count() === 1, 'Canvas in sidebar nav')
  ok(await page.locator('.page-tab', { hasText: 'Settings' }).count() === 1, 'Canvas has a Settings tab')
  ok(await page.locator('.cv-mount').count() === 8, 'starter board seeds all 8 widgets')
  ok((await page.locator('.cv-mount').first().innerText()).includes('Connect Canvas'), 'widgets point to settings when unconnected')
  await page.click('.page-tab:has-text("Settings")')
  await page.waitForSelector('#cv-host')
  await page.fill('#cv-host', 'https://school.instructure.com/')
  await page.fill('#cv-token', 'tok-123')
  await page.click('[data-cv-set="connect"]')
  await page.waitForFunction(() => document.querySelector('#cv-conn-status')?.textContent.includes('Connected as'))
  ok(true, 'Save & test verifies the token (Connected as Chance V)')
  await page.waitForSelector('[data-cv-credit="101"]')
  ok(await page.locator('[data-cv-credit]').count() === 2, 'credit-hours inputs listed per course')
  const authed = reqs.find((r) => r.url.includes('/users/self'))
  ok(authed && authed.auth === 'Bearer tok-123' && authed.url.startsWith('/canvas-proxy/school.instructure.com/api/v1'), 'requests go through the proxy with the bearer token')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.canvas.v1')).host) === 'school.instructure.com', 'host normalized (protocol/slash stripped)')
  await ctx.close()
}

// B. fully seeded
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
  const page = await ctx.newPage()
  await installFake(page)
  await page.addInitScript((s) => {
    if (!localStorage.getItem('atlas.canvas.v1')) localStorage.setItem('atlas.canvas.v1', JSON.stringify(s))
  }, CONNECTED)
  await page.goto(`${BASE}/#/canvas`)
  await page.waitForSelector('.cv-pill')

  console.log('B1. gradebook')
  const gb = page.locator('[data-cv-widget="cvgradebook"]')
  ok(await gb.locator('.cv-pill').count() === 2, 'course selector lists all courses')
  ok((await gb.locator('.cv-pill.is-active').innerText()) === 'Physics II Lab', 'first course selected, shown by its Canvas nickname')
  ok((await gb.locator('.cv-cgrade').innerText()) === '95.0% · A', 'course grade shown')
  const heads = await gb.locator('.cv-group__head').allInnerTexts()
  ok(heads.length === 3 && heads[0].includes('Tests') && heads[0].includes('40%'), `Tests category with 40% weight`)
  ok(heads[1].includes('Quizzes') && heads[1].includes('30%') && heads[2].includes('Assignments') && heads[2].includes('30%'), 'Quizzes 30% + Assignments 30%')
  ok((await gb.locator('.cv-arow').allInnerTexts()).some((t) => t.includes('Midterm 1') && t.includes('88/100')), 'assignments grouped with scores')
  const quizGroup = gb.locator('.cv-group', { hasText: 'Quizzes' })
  ok(await quizGroup.locator('.cv-trend.cv-up').count() === 1 && await quizGroup.locator('.cv-trend.cv-down').count() === 1, 'grade trend badges vs category average')
  ok(heads[1].includes('avg 80.0%'), 'category average shown')
  await gb.locator('.cv-pill', { hasText: 'MATH 220' }).click()
  await page.waitForFunction(() => document.querySelector('[data-cv-widget="cvgradebook"] .cv-pill.is-active')?.textContent === 'MATH 220')
  ok((await gb.locator('.cv-group__head').first().innerText()).includes('Homework'), 'switching course swaps the gradebook')
  ok(await gb.locator('.cv-weight').count() === 0, 'unweighted course hides weight badges')
  await gb.locator('.cv-pill', { hasText: 'Physics II Lab' }).click()
  // clicking a gradebook assignment opens the assignment modal
  await gb.locator('.cv-arow', { hasText: 'Midterm 1' }).click()
  await page.waitForSelector('.cv-overlay')
  ok((await page.locator('.cv-overlay .cal-panel__title').innerText()) === 'Midterm 1', 'gradebook item opens an assignment modal')
  ok((await page.locator('.cv-overlay .cv-status').innerText()).includes('88') && (await page.locator('.cv-overlay .cv-status').innerText()).includes('88%'), 'modal shows the score + percent')
  ok((await page.locator('.cv-overlay .cv-annbody b').innerText()) === 'chapters 1–4', 'modal renders the assignment description HTML')
  ok(await page.evaluate(() => document.body.dataset.cvpwned2) === undefined, 'scripts stripped from assignment description')
  ok(await page.locator('.cv-overlay a', { hasText: 'Open in Canvas' }).getAttribute('href') === 'https://school.instructure.com/courses/101/assignments/9001', 'modal links out to Canvas')
  ok(await page.locator('.cv-overlay a', { hasText: 'Open in Canvas' }).getAttribute('target') === '_blank', 'Canvas link opens in a new tab')
  await page.click('.cv-overlay [data-cv-x="close"]')
  await page.waitForSelector('.cv-overlay', { state: 'detached' })

  console.log('B2. upcoming')
  const up = page.locator('[data-cv-widget="cvupcoming"]')
  const upTexts = await up.locator('.cv-arow').allInnerTexts()
  ok(upTexts.length === 3 && upTexts.some((t) => t.includes('Midterm 2')) && upTexts.some((t) => t.includes('Quiz 3')), 'upcoming lists future assignments sorted')
  ok(upTexts.find((t) => t.includes('Essay draft'))?.includes('✓'), 'already-submitted upcoming gets a check')
  await up.locator('.cv-filter').selectOption('102')
  await page.waitForFunction(() => document.querySelector('[data-cv-widget="cvupcoming"]')?.textContent.includes('Nothing coming up'))
  ok(true, 'class filter narrows upcoming (MATH has nothing due)')
  await up.locator('.cv-filter').selectOption('all')
  await page.waitForSelector('[data-cv-widget="cvupcoming"] .cv-arow')
  await up.locator('.cv-arow', { hasText: 'Midterm 2' }).click()
  await page.waitForSelector('.cv-overlay')
  ok((await page.locator('.cv-overlay .cal-panel__title').innerText()) === 'Midterm 2', 'upcoming item opens an assignment modal')
  ok((await page.locator('.cv-overlay .cv-status').innerText()).toLowerCase().includes('not submitted'), 'modal shows not-submitted status for an upcoming item')
  ok((await page.locator('.cv-overlay .cal-panel__cal').innerText()).includes('100 pts'), 'modal shows points possible + due date')
  await page.click('.cv-overlay [data-cv-x="close"]')
  await page.waitForSelector('.cv-overlay', { state: 'detached' })

  console.log('B3. announcements')
  const an = page.locator('[data-cv-widget="cvannounce"]')
  ok(await an.locator('.cv-ann').count() === 2, 'announcements from all classes')
  await an.locator('.cv-filter').selectOption('101')
  await page.waitForFunction(() => document.querySelectorAll('[data-cv-widget="cvannounce"] .cv-ann').length === 1)
  ok(true, 'announcement class filter works')
  await an.locator('.cv-ann').click()
  await page.waitForSelector('.cv-overlay')
  ok(await page.locator('.cv-annbody b').innerText() === 'Hall B', 'announcement opens with formatted HTML')
  ok(await page.evaluate(() => document.body.dataset.cvpwned) === undefined, 'scripts stripped from announcement HTML')
  await page.click('[data-cv-x="close"]')

  console.log('B4. overdue + dismiss')
  const od = page.locator('[data-cv-widget="cvoverdue"]')
  const odTexts = await od.locator('.cv-arow').allInnerTexts()
  ok(odTexts.length === 2 && odTexts.some((t) => t.includes('Problem set 2')) && odTexts.some((t) => t.includes('HW 2')), 'overdue = past-due and unsubmitted only')
  ok(!odTexts.some((t) => t.includes('Midterm 1')), 'graded past assignments are not overdue')
  await od.locator('.cv-arow', { hasText: 'Problem set 2' }).locator('.cv-x').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-cv-widget="cvoverdue"] .cv-arow').length === 1)
  ok(true, 'x hides the overdue row (e.g. turned in on paper)')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.canvas.v1')).dismissed[0]) === '101:9007', 'dismissal persisted')
  ok((await od.locator('.cv-unhide').innerText()).includes('1 hidden'), 'hidden count with unhide')
  await page.reload()
  await page.waitForSelector('[data-cv-widget="cvoverdue"] .cv-arow')
  ok(!(await page.locator('[data-cv-widget="cvoverdue"]').innerText()).includes('Problem set 2'), 'dismissal survives reload')
  await page.locator('.cv-unhide').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-cv-widget="cvoverdue"] .cv-arow').length === 2)
  ok(true, 'unhide all restores dismissed rows')
  const nameXs = await page.$$eval('[data-cv-widget="cvoverdue"] .cv-aname', (els) => els.map((e) => e.getBoundingClientRect().x))
  ok(nameXs.length === 2 && Math.abs(nameXs[0] - nameXs[1]) < 1, `assignment names align across different-width class labels (${nameXs.map((x) => x.toFixed(1)).join(' vs ')})`)
  ok(await page.locator('[data-cv-widget="cvoverdue"] .cv-ctag').first().evaluate((e) => e.scrollWidth <= e.clientWidth + 1), 'long class labels show in full (no truncation)')

  console.log('B5. GPA math (±4.0 with credits)')
  const gpa = page.locator('[data-cv-widget="cvgpa"]')
  const nums = await gpa.locator('.cv-gpa__num').allInnerTexts()
  // ±: CHEM 95→A→4.0×4cr + MATH 88→B+→3.3×3cr = 25.9/7 = 3.70; overall (3.5×15 + 25.9)/22 = 3.56
  ok(nums[0] === '3.56' && nums[1] === '3.70', `overall 3.56 / semester 3.70 on the ± scale (got ${nums.join('/')})`)
  const sems = page.locator('[data-cv-widget="cvsemesters"]')
  const semTexts = await sems.locator('.cv-semrow').allInnerTexts()
  ok(semTexts.length === 2 && semTexts[0].includes('Fall 2025') && semTexts[0].includes('3.50'), 'semesters widget lists manual semesters')
  ok(semTexts[1].includes('Current (live)') && semTexts[1].includes('3.70'), 'semesters widget appends the live current row')

  console.log('B6. letters-only toggle')
  await page.click('.page-tab:has-text("Settings")')
  await page.waitForSelector('#cv-scale')
  await page.selectOption('#cv-scale', 'letters')
  await page.click('.page-tab:has-text("Board")')
  await page.waitForSelector('[data-cv-widget="cvgpa"] .cv-gpa__num')
  const nums2 = await page.locator('[data-cv-widget="cvgpa"] .cv-gpa__num').allInnerTexts()
  // letters: A→4×4 + 88→B→3×3 = 25/7 = 3.57; overall (52.5+25)/22 = 3.52
  ok(nums2[0] === '3.52' && nums2[1] === '3.57', `letters-only scale changes GPA (got ${nums2.join('/')})`)
  const cardLetters = await page.locator('.cv-card__letter').allInnerTexts()
  ok(cardLetters.join(',') === 'A,B', 'course cards show plain letters in letters mode')
  await page.click('.page-tab:has-text("Settings")')
  await page.waitForSelector('#cv-scale')
  await page.selectOption('#cv-scale', 'plusminus')
  await page.click('.page-tab:has-text("Board")')
  await page.waitForSelector('.cv-card__letter')
  ok((await page.locator('.cv-card__letter').allInnerTexts()).join(',') === 'A,B+', 'course cards show ± letters on the ± scale')

  console.log('B7. courses + todo widgets')
  const cards = await page.locator('.cv-card').allInnerTexts()
  ok(cards.length === 2 && cards[0].includes('95.0%') && cards[1].includes('88.0%'), 'course cards show current grades')
  ok((await page.locator('[data-cv-widget="cvtodo"]').innerText()).includes('Problem set 2'), 'to-do widget lists Canvas todo items')
  ok(await page.locator('[data-cv-widget="cvtodo"] .cv-ctag').first().innerText() === 'Physics II Lab', 'to-do rows carry the class label (nickname-aware)')
  await page.locator('[data-cv-widget="cvtodo"] .cv-arow', { hasText: 'Problem set 2' }).click()
  await page.waitForSelector('.cv-overlay')
  ok((await page.locator('.cv-overlay .cal-panel__title').innerText()) === 'Problem set 2', 'to-do item opens an assignment modal')
  ok((await page.locator('.cv-overlay .cal-panel__cal').innerText()).includes('Physics II Lab'), 'to-do modal shows the resolved course name (nickname-aware)')
  ok((await page.locator('.cv-overlay .cv-annbody').innerText()).includes('Show all work'), 'to-do modal shows the assignment description')
  await page.click('.cv-overlay [data-cv-x="close"]')
  await page.waitForSelector('.cv-overlay', { state: 'detached' })

  console.log('B8. settings: semesters editing')
  await page.click('.page-tab:has-text("Settings")')
  await page.waitForSelector('[data-cv-set="add-sem"]')
  await page.click('[data-cv-set="add-sem"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-sem-id]').length === 2)
  const newRow = page.locator('[data-sem-id]').nth(1)
  await newRow.locator('[data-cv-sem="name"]').fill('Spring 2026')
  await newRow.locator('[data-cv-sem="gpa"]').fill('3.8')
  await newRow.locator('[data-cv-sem="credits"]').fill('16')
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.canvas.v1')).semesters[1])
  ok(saved.name === 'Spring 2026' && saved.gpa === '3.8' && saved.credits === '16', 'new semester persists as typed')
  await newRow.locator('[data-cv-set="rm-sem"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-sem-id]').length === 1)
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.canvas.v1')).semesters.length) === 1, 'semester removal persists')

  console.log('B8b. semester built from classes')
  await page.click('[data-cv-set="add-sem"]')
  await page.waitForFunction(() => document.querySelectorAll('[data-sem-id]').length === 2)
  const clsSem = page.locator('[data-sem-id]').nth(1)
  await clsSem.locator('[data-cv-sem="name"]').fill('Summer 2026')
  await clsSem.locator('[data-cv-set="add-class"]').click()
  await page.waitForSelector('[data-class-id]')
  await clsSem.locator('[data-cv-set="add-class"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-class-id]').length === 2)
  const c1 = clsSem.locator('[data-class-id]').nth(0)
  await c1.locator('[data-cv-class="name"]').fill('Statics')
  await c1.locator('[data-cv-class="grade"]').selectOption('A')
  await c1.locator('[data-cv-class="credits"]').fill('3')
  const c2 = clsSem.locator('[data-class-id]').nth(1)
  await c2.locator('[data-cv-class="name"]').fill('Ethics')
  await c2.locator('[data-cv-class="grade"]').selectOption('B+')
  await c2.locator('[data-cv-class="credits"]').fill('4')
  ok(await clsSem.locator('[data-cv-sem="gpa"]').inputValue() === '3.60' &&
     await clsSem.locator('[data-cv-sem="credits"]').inputValue() === '7', 'semester GPA/credits computed live from classes')
  ok(await clsSem.locator('[data-cv-sem="gpa"]').isDisabled(), 'manual GPA locks while classes drive it')
  await page.click('.page-tab:has-text("Board")')
  await page.waitForSelector('.cv-semrow')
  const sumRow = (await page.locator('[data-cv-widget="cvsemesters"] .cv-semrow').allInnerTexts()).find((t) => t.includes('Summer 2026'))
  ok(sumRow && sumRow.includes('3.60') && sumRow.includes('7 cr · 2 classes'), 'semesters widget shows the computed semester')
  const numsB8 = await page.locator('[data-cv-widget="cvgpa"] .cv-gpa__num').allInnerTexts()
  ok(numsB8[0] === '3.57', `overall GPA includes the class-built semester (got ${numsB8[0]})`)
  await page.click('.page-tab:has-text("Settings")')
  await page.waitForSelector('[data-sem-id]')
  await page.locator('[data-sem-id]').nth(1).locator('[data-cv-set="rm-sem"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-sem-id]').length === 1)

  console.log('B10. nicknames + course enable/disable')
  await page.click('.page-tab:has-text("Settings")')
  await page.waitForSelector('[data-cv-course-on="101"]')
  const chemRow = page.locator('.cv-semedit', { has: page.locator('[data-cv-course-on="101"]') })
  ok((await chemRow.locator('.cv-credit-name').innerText()).includes('Physics II Lab') &&
     (await chemRow.locator('.cv-credit-orig').innerText()) === 'Organic Chemistry', 'settings shows nickname with the real name beside it')
  await page.locator('[data-cv-course-on="102"]').click()
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.canvas.v1')).hiddenCourses.map(String).includes('102')), 'disabled course persisted')
  await page.click('.page-tab:has-text("Board")')
  await page.waitForFunction(() => document.querySelectorAll('[data-cv-widget="cvgradebook"] .cv-pill').length === 1)
  ok(true, 'gradebook pills hide the disabled course')
  ok(!(await page.locator('[data-cv-widget="cvannounce"]').innerText()).includes('Office hours'), 'announcements from disabled course hidden')
  ok(await page.locator('[data-cv-widget="cvoverdue"] .cv-arow').count() === 1, 'overdue from disabled course hidden')
  ok(await page.locator('[data-cv-widget="cvupcoming"] .cv-filter option').count() === 2, 'class filters only list enabled courses')
  ok(await page.locator('.cv-card').count() === 1, 'course cards hide the disabled course')
  const nums3 = await page.locator('[data-cv-widget="cvgpa"] .cv-gpa__num').allInnerTexts()
  ok(nums3[0] === '3.61' && nums3[1] === '4.00', `GPA recomputes without the disabled course (got ${nums3.join('/')})`)
  await page.click('.page-tab:has-text("Settings")')
  await page.waitForSelector('[data-cv-course-on="102"]')
  await page.locator('[data-cv-course-on="102"]').click()
  await page.click('.page-tab:has-text("Board")')
  await page.waitForFunction(() => document.querySelectorAll('[data-cv-widget="cvgradebook"] .cv-pill').length === 2)
  ok(true, 're-enabling restores the course everywhere')

  console.log('B9. palette')
  await page.click('.page-tab:has-text("Board")')
  await page.waitForSelector('.cv-pill')
  await page.click('#customize')
  await page.waitForSelector('.palette')
  const cats = await page.locator('.palette__cat').allInnerTexts()
  ok(cats.length === 1 && cats[0].toLowerCase() === 'canvas', 'canvas page palette restricted to Canvas widgets')
  ok(await page.locator('.palette [data-kind]').count() === 8, 'all 8 canvas widgets in the palette')
  await page.click('#customize')
  await ctx.close()
}

await browser.close()
console.log(`\ncanvas: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
