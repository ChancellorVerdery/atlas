// Picking a different workout than the rotation planned must STICK.
//
// gym.js stores it as a date-keyed override (plan.overrides['YYYY-MM-DD']), so
// it should survive a reload, a re-render, and the sync round trip. This drives
// the real picker in the real widget and then reloads.
//
// Offline mode first: no sync at all, so a failure here is purely client-side.
// Run: node tmp-e2e/gym-override.mjs
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || process.argv[2] || 'http://localhost:5173'
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}`) } }

const gym = {
  v: 1,
  workouts: [
    { id: 'gw-push', name: 'Push' },
    { id: 'gw-pull', name: 'Pull' },
    { id: 'gw-legs', name: 'Legs' },
  ],
  exercises: [
    { id: 'ge-bench', workoutId: 'gw-push', name: 'Bench Press' },
    { id: 'ge-row', workoutId: 'gw-pull', name: 'Barbell Row' },
    { id: 'ge-squat', workoutId: 'gw-legs', name: 'Squat' },
  ],
  logs: [], completions: [],
  plan: {
    type: 'cycle',
    weekly: {},
    cycle: { order: ['gw-push', 'gw-pull', 'gw-legs'], position: 0 }, // plan says Push
    overrides: {}, extras: {},
  },
  unit: 'lbs', address: '', hours: {},
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })

// Registered FIRST so it wraps setItem before anything else writes, and sits
// UNDER main.js's own hook (its origSetItem captures this wrapper).
await ctx.addInitScript(() => {
  const orig = localStorage.setItem.bind(localStorage)
  window.__gymWrites = []
  localStorage.setItem = (k, v) => {
    if (k === 'atlas.gym.v1') {
      let ov = '?'
      try { ov = JSON.stringify(JSON.parse(v).plan.overrides) } catch {}
      window.__gymWrites.push({ ov, stack: new Error().stack.split('\n').slice(2, 7).join(' | ') })
    }
    orig(k, v)
  }
})

await ctx.addInitScript((g) => {
  // addInitScript runs on EVERY navigation. Seed only once, or the reload below
  // quietly restores the fixture and the test proves nothing.
  if (localStorage.getItem('atlas.gym.v1')) return
  localStorage.setItem('atlas.auth.v1', '{"offline":true}')
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { gym: true }, installed: {} }))
  localStorage.setItem('atlas.gym.v1', JSON.stringify(g))
  localStorage.setItem('atlas.page.gym.v1', JSON.stringify({
    v: 1,
    rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'gymcurrent' }] }] }] }] }],
  }))
}, gym)

const page = await ctx.newPage()
const overrideOf = () => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('atlas.gym.v1')).plan.overrides } catch { return null }
})
const bigText = () => page.locator('.gym-big').first().innerText().catch(() => '(none)')
const pickValue = () => page.locator('.gym-pick-sel').first().inputValue().catch(() => '(no picker)')

await page.goto(BASE + '/#/gym')
await page.waitForSelector('.gym-pick-sel', { timeout: 10000 })

console.log('1. the plan picked Push (cycle position 0)')
console.log(`   heading: ${await bigText()} | picker: ${await pickValue()}`)
ok(await pickValue() === '', 'picker starts on "Today: as planned"')

console.log('2. choose Legs instead')
await page.locator('.gym-pick-sel').first().selectOption('gw-legs')
await page.waitForTimeout(800)
const ovAfter = await overrideOf()
console.log(`   heading: ${await bigText()} | picker: ${await pickValue()} | stored: ${JSON.stringify(ovAfter)}`)
ok(Object.values(ovAfter || {})[0] === 'gw-legs', 'the choice was written to plan.overrides')
ok(await pickValue() === 'gw-legs', 'the picker still shows Legs after the re-render')
ok((await bigText()).includes('Legs'), 'the widget heading switched to Legs')

const pre = await page.evaluate(() => window.__gymWrites)
console.log(`   writes to atlas.gym.v1 so far: ${pre.length}`)
for (const w of pre) console.log(`     overrides=${w.ov}\n       ${w.stack.replace(/https?:\/\/[^/]+/g, '')}`)

console.log('3. reload — the choice must still be there')
await page.reload()
await page.waitForSelector('.gym-pick-sel', { timeout: 10000 })
console.log(`   heading: ${await bigText()} | picker: ${await pickValue()} | stored: ${JSON.stringify(await overrideOf())}`)
const writes = await page.evaluate(() => window.__gymWrites)
console.log(`   writes to atlas.gym.v1 during this load: ${writes.length}`)
for (const w of writes) console.log(`     overrides=${w.ov}\n       ${w.stack.replace(/https?:\/\/[^/]+/g, '')}`)
ok(await pickValue() === 'gw-legs', 'picker still on Legs after a reload')
ok((await bigText()).includes('Legs'), 'heading still Legs after a reload')

await ctx.close()
await browser.close()
console.log(`\ngym-override: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
