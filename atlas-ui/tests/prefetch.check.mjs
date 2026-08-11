// The boot prefetch exists to stop plugin data arriving late; the limiter
// exists to stop it all arriving at once. The whole point is the concurrency
// bound, so that is what gets asserted — with fake tasks, so this runs in node
// with no browser and no network.
// Run: node tests/prefetch.check.mjs
import { runLimited, startPrefetch } from '../src/page/prefetch.js'
import { strictEqual, ok } from 'node:assert'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// A task that reports how many of its peers are running alongside it.
const tracker = () => {
  const s = { live: 0, peak: 0, ran: 0, order: [] }
  const task = (id, ticks = 2) => async () => {
    s.live++
    s.peak = Math.max(s.peak, s.live)
    s.order.push(id)
    for (let i = 0; i < ticks; i++) await Promise.resolve() // yield, deterministically
    s.live--
    s.ran++
    return id
  }
  return { s, task }
}

await check('never runs more than `limit` tasks at once', async () => {
  const { s, task } = tracker()
  await runLimited(Array.from({ length: 12 }, (_, i) => task(i, 3)), { limit: 2 })
  strictEqual(s.ran, 12, 'every task must still run')
  strictEqual(s.peak, 2, `peak concurrency was ${s.peak}, expected 2`)
})

await check('a limit of 1 serialises completely', async () => {
  const { s, task } = tracker()
  await runLimited(Array.from({ length: 5 }, (_, i) => task(i, 4)), { limit: 1 })
  strictEqual(s.peak, 1)
  strictEqual(s.order.join(','), '0,1,2,3,4', 'a serial pool must preserve order')
})

await check('a limit above the task count does not stall', async () => {
  const { s, task } = tracker()
  const out = await runLimited([task('a'), task('b')], { limit: 8 })
  strictEqual(s.ran, 2)
  strictEqual(out.length, 2)
})

await check('one failing task never stops the others', async () => {
  const { s, task } = tracker()
  const boom = async () => { throw new Error('canvas is down') }
  const out = await runLimited([task(1), boom, task(2), boom, task(3)], { limit: 2 })
  strictEqual(s.ran, 3, 'healthy tasks must still complete')
  strictEqual(out.filter((r) => r.ok).length, 3)
  strictEqual(out.filter((r) => !r.ok).length, 2)
  ok(out.find((r) => !r.ok).err.message.includes('canvas'))
})

await check('the gap is awaited between tasks, not after the last one', async () => {
  const { task } = tracker()
  let sleeps = 0
  const sleep = async () => { sleeps++ }
  await runLimited([task(1), task(2), task(3)], { limit: 1, gapMs: 5, sleep })
  strictEqual(sleeps, 2, '3 serial tasks means 2 gaps, not 3')
})

await check('empty task list resolves rather than hanging', async () => {
  strictEqual((await runLimited([], { limit: 2 })).length, 0)
})

await check('disabled plugins are never fetched for', async () => {
  const loaded = []
  const tasks = [
    { plugin: 'canvas', load: () => { loaded.push('canvas'); return Promise.resolve(() => {}) } },
    { plugin: 'email', load: () => { loaded.push('email'); return Promise.resolve(() => {}) } },
  ]
  // startPrefetch schedules on a timer; delay 0 plus a macrotask wait runs it.
  globalThis.window = { dispatchEvent() {} }
  globalThis.CustomEvent = class { constructor(t) { this.type = t } }
  startPrefetch((p) => p === 'canvas', { tasks, delay: 0 })
  await new Promise((r) => setTimeout(r, 20))
  strictEqual(loaded.join(','), 'canvas', `loaded: ${loaded.join(',') || '(none)'}`)
})

await check('startPrefetch only ever runs once', async () => {
  const loaded = []
  const tasks = [{ plugin: 'canvas', load: () => { loaded.push('x'); return Promise.resolve(() => {}) } }]
  // The module-level guard was already tripped by the previous check, so a
  // second call must be a no-op — a re-render must not re-trigger a fetch storm.
  startPrefetch(() => true, { tasks, delay: 0 })
  await new Promise((r) => setTimeout(r, 20))
  strictEqual(loaded.length, 0)
})

console.log(failures ? `\n${failures} failed` : '\nprefetch.check: all good')
process.exit(failures ? 1 : 0)
