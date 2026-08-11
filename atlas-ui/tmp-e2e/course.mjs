// Course Planner suite — data is all local. Headless.
import { chromium } from 'playwright'
const BASE = 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (c, n, x = '') => { c ? (passed++, console.log('  ok ' + n)) : (failed++, console.log('  FAIL ' + n + ' ' + x)) }
const browser = await chromium.launch({ headless: true })

// A small CS-ish plan: CALC1 done in fall 2025; current spring 2026 has PROG1;
// remaining CALC2 (needs CALC1), PROG2 (needs PROG1), DS (needs PROG2+CALC2),
// LAB (coreq DS, summer-ok).
const SEED = () => {
  localStorage.setItem('atlas.devMode', '1')
  localStorage.setItem('atlas.course.v1', JSON.stringify({
    terms: [
      { key: 'fall-2025', season: 'fall', year: 2025, current: false },
      { key: 'spring-2026', season: 'spring', year: 2026, current: true },
    ],
    disabledTerms: [],
    settings: { maxCredits: 15, summerMax: 6, strategy: 'soonest-summer' },
    courses: [
      { id: 'c1', code: 'CALC1', title: 'Calculus I', credits: 4, prereqs: [], coreqs: [], preOrCo: [], summerOk: false, term: 'fall-2025' },
      { id: 'c2', code: 'PROG1', title: 'Programming I', credits: 3, prereqs: [], coreqs: [], preOrCo: [], summerOk: false, term: 'spring-2026' },
      { id: 'c3', code: 'CALC2', title: 'Calculus II', credits: 4, prereqs: ['CALC1'], coreqs: [], preOrCo: [], summerOk: true, term: null },
      { id: 'c4', code: 'PROG2', title: 'Programming II', credits: 3, prereqs: ['PROG1'], coreqs: [], preOrCo: [], summerOk: false, term: null },
      { id: 'c5', code: 'DS', title: 'Data Structures', credits: 3, prereqs: ['PROG2', 'CALC2'], coreqs: [], preOrCo: [], summerOk: false, term: null },
      { id: 'c6', code: 'LAB', title: 'DS Lab', credits: 1, prereqs: [], coreqs: ['DS'], preOrCo: [], summerOk: true, term: null },
    ],
  }))
}

// A. two pages: Planner (entry) at #/course, Map (board) at #/course/explore
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.addInitScript(SEED)
  await page.goto(`${BASE}/#/course`)
  await page.waitForSelector('.cp-panel')
  console.log('A. planner + map pages')
  ok(await page.locator('#title').innerText() === 'Course Planner', 'topbar says Course Planner')
  ok(await page.locator('.cp-row').count() === 6, 'planner page shows the classes table')
  ok(await page.locator('.cp-svg').count() === 0, 'no board on the planner page')
  const tabs = await page.locator('.page-tab').allInnerTexts()
  ok(tabs.includes('Map') && tabs.includes('Settings'), `tab bar offers Map + Settings (${tabs.join(' | ')})`)
  // "Calculate route" jumps to the Map tab
  await page.click('[data-cp="calc"]')
  await page.waitForSelector('.cp-svg')
  ok(page.url().includes('/course/explore'), 'Calculate route opens the Map page')
  const boxes = await page.locator('.cp-box').count()
  ok(boxes === 6, `all 6 classes drawn as boxes (got ${boxes})`)
  ok(await page.locator('.cp-ribbon--prereq').count() >= 3, 'prereq ribbons drawn')
  ok(await page.locator('.cp-ribbon--coreq').count() >= 1, 'coreq ribbon drawn (LAB↔DS)')
  // box height ∝ credits: CALC2 (4cr) taller than LAB (1cr)
  const h = async (code) => page.evaluate((c) => { const g = [...document.querySelectorAll('.cp-box')].find((b) => b.querySelector('.cp-box__code')?.textContent === c); return g ? Number(g.querySelector('.cp-box__bg').getAttribute('height')) : null }, code)
  ok(await h('CALC2') > await h('LAB'), 'a 4-credit box is taller than a 1-credit box')
  ok(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 200)})`)
  await ctx.close()
}

// B. the route respects prerequisites (CALC2 after fall-2025, DS after both)
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(SEED)
  await page.goto(`${BASE}/#/course/explore`)
  await page.waitForSelector('.cp-svg')
  console.log('B. computed route')
  const sched = await page.evaluate(() => window.__cp)
  const termOf = (code) => { const cc = sched.courseByCode[code]; for (const t of sched.board) if (cc && t.courseIds.includes(cc)) return t.key; return null }
  ok(!!sched && sched.board.length >= 3, 'schedule exposed for tests')
  const rank = (k) => { const [s, y] = k.split('-'); return Number(y) * 3 + ({ spring: 0, summer: 1, fall: 2 })[s] }
  ok(rank(termOf('DS')) > rank(termOf('CALC2')) && rank(termOf('DS')) > rank(termOf('PROG2')), 'DS lands after both its prereqs', `${termOf('DS')} vs ${termOf('CALC2')}/${termOf('PROG2')}`)
  ok(termOf('LAB') === termOf('DS'), 'LAB joins DS in the same term (its coreq pulls it in)', `${termOf('LAB')} vs ${termOf('DS')}`)
  await ctx.close()
}

// C. click a box → modal with prereqs
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(SEED)
  await page.goto(`${BASE}/#/course/explore`)
  await page.waitForSelector('.cp-svg')
  console.log('C. class modal')
  await page.evaluate(() => { const g = [...document.querySelectorAll('.cp-box')].find((b) => b.querySelector('.cp-box__code')?.textContent === 'DS'); g.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await page.waitForSelector('.cp-modal')
  const txt = await page.locator('.cp-modal').innerText()
  ok(txt.includes('Data Structures'), 'modal shows the class title')
  ok(txt.includes('PROG2') && txt.includes('CALC2'), 'modal lists both prerequisites')
  await page.locator('.cp-modal__x').click()
  ok(await page.locator('.cp-modal').count() === 0, 'modal closes')
  await ctx.close()
}

// D. add a class from the bar; toggle a summer off
{
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(SEED)
  await page.goto(`${BASE}/#/course`)
  await page.waitForSelector('.cp-panel')
  console.log('D. edits (planner page)')
  const before = await page.locator('.cp-row').count()
  await page.click('[data-cp="add-class"]')
  await page.waitForFunction((n) => document.querySelectorAll('.cp-row').length === n + 1, before, { timeout: 8000 })
  ok(await page.locator('.cp-row').count() === before + 1, 'a new class row appears')
  // toggle a summer off → it lands in disabledTerms
  const sumBox = page.locator('.cp-summer input[data-cp="toggle-summer"]').first()
  const key = await sumBox.getAttribute('data-key')
  await sumBox.uncheck()
  await page.waitForTimeout(150)
  ok(await page.evaluate(() => JSON.parse(localStorage['atlas.course.v1']).disabledTerms.length) >= 1, `disabling a summer records it (${key})`)
  await ctx.close()
}

await browser.close()
console.log(`\ncourse: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
