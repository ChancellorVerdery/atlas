// Same question as gym-override.mjs, but with sync switched ON — because that
// is what actually runs on the phone and the Mac.
//
// The fake backend is FAITHFUL: gym.save stores whatever the client sends and
// sync.pull.all hands it straight back (the real mapper round-trips
// plan.overrides intact — verified separately), so anything that reverts here
// is the client losing it, not the server dropping it.
// Run: node tmp-e2e/gym-override-sync.mjs
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || process.argv[2] || 'http://localhost:5173'
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ok   ${name}`) } else { fail++; console.log(`  FAIL ${name}`) } }

const gym = {
  v: 1,
  workouts: [{ id: 'gw-push', name: 'Push' }, { id: 'gw-pull', name: 'Pull' }, { id: 'gw-legs', name: 'Legs' }],
  exercises: [{ id: 'ge-squat', workoutId: 'gw-legs', name: 'Squat' }],
  logs: [], completions: [],
  plan: {
    type: 'cycle', weekly: {},
    cycle: { order: ['gw-push', 'gw-pull', 'gw-legs'], position: 0 }, // plan says Push
    overrides: {}, extras: {},
  },
  unit: 'lbs', address: '', hours: {},
}
const board = { v: 1, rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'gymcurrent' }] }] }] }] }] }
const plugins = { enabled: { gym: true }, installed: {} }

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })

await ctx.addInitScript(({ gym, board, plugins }) => {
  if (!localStorage.getItem('atlas.gym.v1')) {
    localStorage.setItem('atlas.auth.v1', JSON.stringify({ token: 't', userId: 'u1', email: 'c@x.com' }))
    localStorage.setItem('atlasLastUser', 'u1')
    localStorage.setItem('atlas.plugins.v1', JSON.stringify(plugins))
    localStorage.setItem('atlas.gym.v1', JSON.stringify(gym))
    localStorage.setItem('atlas.page.gym.v1', JSON.stringify(board))
    localStorage.setItem('atlas.page.v1', JSON.stringify({ v: 1, rows: [] }))
  }

  // The "server". Survives reloads via sessionStorage so launch 2 sees what
  // launch 1 pushed, exactly like a real backend would.
  const load = () => { try { return JSON.parse(sessionStorage.getItem('__srv')) || {} } catch { return {} } }
  const save = (o) => sessionStorage.setItem('__srv', JSON.stringify(o))
  if (!sessionStorage.getItem('__srv')) {
    save({ 'atlas.gym.v1': gym, 'atlas.page.gym.v1': board, 'atlas.plugins.v1': plugins, 'atlas.page.v1': { v: 1, rows: [] } })
  }
  window.__saves = []

  const out = { sock: null, acked: false }
  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
    constructor(url) {
      this.url = url
      this.isInbox = !/outbox/.test(url)
      this.readyState = 0
      if (!this.isInbox) out.sock = this
      setTimeout(() => { this.readyState = 1; this.onopen && this.onopen() }, this.isInbox ? 300 : 600)
    }
    deliver(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }) }
    reply(o) { if (out.sock && out.acked && out.sock.readyState === 1) out.sock.deliver(o) }
    send(raw) {
      let m; try { m = JSON.parse(raw) } catch { return }
      if (m.type === 'hello') {
        if (!this.isInbox) out.acked = true
        return this.deliver({ type: 'hello', ok: true, userId: 'u1', email: 'c@x.com' })
      }
      if (!m.reqId) return
      let data = {}
      if (m.code === 'sync.pull.all') data = { states: load() }
      else if (m.code === 'gym.save') {
        const s = load(); s['atlas.gym.v1'] = m.payload.value; save(s)
        window.__saves.push(JSON.stringify(m.payload.value.plan.overrides))
      } else if (m.code === 'page.save') {
        const s = load(); s[m.payload.storageKey] = m.payload.value; save(s)
      }
      setTimeout(() => this.reply({ reqId: m.reqId, ok: true, data }), 60)
    }
    close() { this.readyState = 3; if (!this.isInbox) out.acked = false; this.onclose && this.onclose() }
  }
  window.WebSocket = FakeWS
}, { gym, board, plugins })

const page = await ctx.newPage()
const localOv = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('atlas.gym.v1')).plan.overrides } catch { return null } })
const serverOv = () => page.evaluate(() => { try { return JSON.parse(sessionStorage.getItem('__srv'))['atlas.gym.v1'].plan.overrides } catch { return null } })
const bigText = () => page.locator('.gym-big').first().innerText().catch(() => '(none)')
const pickValue = () => page.locator('.gym-pick-sel').first().inputValue().catch(() => '(no picker)')

await page.goto(BASE + '/#/gym')
await page.waitForSelector('.gym-pick-sel', { timeout: 10000 })
await page.waitForTimeout(1500) // let the boot pull land

console.log('1. plan picked Push; choose Legs instead')
await page.locator('.gym-pick-sel').first().selectOption('gw-legs')
await page.waitForTimeout(1500) // debounce (400ms) + round trip
console.log(`   heading: ${await bigText()} | local: ${JSON.stringify(await localOv())} | server: ${JSON.stringify(await serverOv())}`)
ok((await bigText()).includes('Legs'), 'widget switched to Legs')
ok(Object.values((await serverOv()) || {})[0] === 'gw-legs', 'the choice reached the server')

console.log('2. app backgrounded and reopened (resume re-hydrate pulls the profile)')
await page.evaluate(() => {
  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
  Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  document.dispatchEvent(new Event('visibilitychange'))
})
await page.waitForTimeout(2000)
console.log(`   heading: ${await bigText()} | picker: ${await pickValue()} | local: ${JSON.stringify(await localOv())}`)
ok(await pickValue() === 'gw-legs', 'still Legs after a resume pull')

console.log('3. next launch (fresh page load, server is the source of truth)')
await page.reload()
await page.waitForSelector('.gym-pick-sel', { timeout: 10000 })
await page.waitForTimeout(2500) // boot pull + applyStates
console.log(`   heading: ${await bigText()} | picker: ${await pickValue()} | local: ${JSON.stringify(await localOv())}`)
ok(await pickValue() === 'gw-legs', 'still Legs on the next launch')
ok((await bigText()).includes('Legs'), 'heading still Legs on the next launch')

await ctx.close()
await browser.close()
console.log(`\ngym-override-sync: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
