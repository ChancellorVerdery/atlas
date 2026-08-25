// Reordering the rotation must not change WHICH workout is current.
//
// plan.cycle.position is an array INDEX, so swapping two entries hands "current"
// to whichever workout slid into that slot — you move your day and the app now
// says a different one is today. Same for removing an entry above the current
// one, which shifts everything down under a fixed index.
// Run: node tmp-e2e/gym-cycle-reorder.mjs
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || process.argv[2] || 'http://localhost:5173'
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}`) } }

const gym = {
  v: 1,
  workouts: [{ id: 'gw-push', name: 'Push' }, { id: 'gw-pull', name: 'Pull' }, { id: 'gw-legs', name: 'Legs' }],
  exercises: [], logs: [], completions: [],
  plan: {
    type: 'cycle', weekly: {},
    cycle: { order: ['gw-push', 'gw-pull', 'gw-legs'], position: 1 }, // current = Pull
    overrides: {}, extras: {},
  },
  unit: 'lbs', address: '', hours: {},
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
await ctx.addInitScript((g) => {
  if (localStorage.getItem('atlas.gym.v1')) return
  localStorage.setItem('atlas.auth.v1', '{"offline":true}')
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { gym: true }, installed: {} }))
  localStorage.setItem('atlas.gym.v1', JSON.stringify(g))
}, gym)

const page = await ctx.newPage()
const state = () => page.evaluate(() => {
  const g = JSON.parse(localStorage.getItem('atlas.gym.v1'))
  const names = { 'gw-push': 'Push', 'gw-pull': 'Pull', 'gw-legs': 'Legs' }
  return {
    order: g.plan.cycle.order.map((id) => names[id]),
    position: g.plan.cycle.position,
    current: names[g.plan.cycle.order[g.plan.cycle.position]],
  }
})

await page.goto(BASE + '/#/gym/settings')
await page.waitForSelector('.gym-cycle-row', { timeout: 10000 })

console.log('start:', JSON.stringify(await state()))
ok((await state()).current === 'Pull', 'Pull is the current workout')

console.log('1. move Pull (the current one) later in the rotation')
// row index 1 = Pull; its ↓ button
await page.locator('.gym-cycle-row').nth(1).locator('[data-gym-set="cycle-down"]').click()
await page.waitForTimeout(500)
const afterMove = await state()
console.log('   after:', JSON.stringify(afterMove))
ok(afterMove.order.join(',') === 'Push,Legs,Pull', 'the order changed as asked')
ok(afterMove.current === 'Pull', `current is still Pull, not whatever slid into slot 1 (got ${afterMove.current})`)

console.log('2. remove a workout ABOVE the current one')
await page.locator('.gym-cycle-row').nth(0).locator('[data-gym-set="cycle-remove"]').click()
await page.waitForTimeout(500)
const afterRemove = await state()
console.log('   after:', JSON.stringify(afterRemove))
ok(afterRemove.order.join(',') === 'Legs,Pull', 'Push was removed')
ok(afterRemove.current === 'Pull', `current is still Pull after the list shifted (got ${afterRemove.current})`)

await ctx.close()
await browser.close()
console.log(`\ngym-cycle-reorder: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
