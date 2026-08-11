import { chromium } from 'playwright'
const BASE = 'http://localhost:5173'
const b = await chromium.launch({ headless: true })
const page = await (await b.newContext({ viewport: { width: 1680, height: 950 } })).newPage()
await page.addInitScript(() => {
  localStorage.setItem('atlas.devMode', '1')
  localStorage.setItem('atlas.course.v1', JSON.stringify({
    terms: [
      { key: 'fall-2025', season: 'fall', year: 2025, current: false },
      { key: 'spring-2026', season: 'spring', year: 2026, current: true },
    ],
    disabledTerms: ['summer-2027'],
    settings: { maxCredits: 15, summerMax: 6, strategy: 'soonest-summer' },
    courses: [
      { id: 'c1', code: 'CALC 1', title: 'Calculus I', credits: 4, prereqs: [], coreqs: [], preOrCo: [], summerOk: false, term: 'fall-2025' },
      { id: 'c0', code: 'ENGL 1', title: 'English Comp', credits: 3, prereqs: [], coreqs: [], preOrCo: [], summerOk: false, term: 'fall-2025' },
      { id: 'c2', code: 'PROG 1', title: 'Programming I', credits: 3, prereqs: [], coreqs: [], preOrCo: [], summerOk: false, term: 'spring-2026' },
      { id: 'c3', code: 'CALC 2', title: 'Calculus II', credits: 4, prereqs: ['CALC 1'], coreqs: [], preOrCo: [], summerOk: true, term: null },
      { id: 'c4', code: 'PROG 2', title: 'Programming II', credits: 3, prereqs: ['PROG 1'], coreqs: [], preOrCo: [], summerOk: false, term: null },
      { id: 'c5', code: 'DS', title: 'Data Structures', credits: 3, prereqs: ['PROG 2', 'CALC 2'], coreqs: [], preOrCo: [], summerOk: false, term: null },
      { id: 'c6', code: 'DS LAB', title: 'Data Structures Lab', credits: 1, prereqs: [], coreqs: ['DS'], preOrCo: [], summerOk: false, term: null },
      { id: 'c7', code: 'ALGO', title: 'Algorithms', credits: 3, prereqs: ['DS'], coreqs: [], preOrCo: [], summerOk: false, term: null },
    ],
  }))
})
await page.goto(`${BASE}/#/course`)
await page.waitForSelector('.cp-panel')
await page.screenshot({ path: 'tmp-e2e/course-planner.png', clip: { x: 230, y: 0, width: 1450, height: 900 } })
await page.goto(`${BASE}/#/course/explore`)
await page.waitForSelector('.cp-svg')
await page.waitForTimeout(200)
await page.screenshot({ path: 'tmp-e2e/course-map.png', clip: { x: 230, y: 0, width: 1450, height: 900 } })
console.log('saved both')
await b.close()
