// Warm each enabled plugin's remote data shortly after boot, so opening Canvas
// or Mail shows real data instead of a spinner.
//
// Bounded on purpose. Canvas alone fans out one request per course, Gmail lists
// threads then hydrates each, Calendar hits every visible calendar — starting
// them all at once competes with the first paint, with the sync pull, and with
// each other, which is exactly the lag this is supposed to remove. Two at a
// time with a gap between starts keeps the UI responsive while still finishing
// well before the user clicks anything.

// Bounded-concurrency pool. Exported and dependency-free so its behaviour can
// be tested without a browser or a network: `limit` workers pull from a shared
// queue, so at most `limit` tasks are ever in flight.
//
// Never rejects — a warm task failing (offline, revoked token, API hiccup) must
// leave the app exactly as it was, showing whatever cache it already had.
export async function runLimited(tasks, { limit = 2, gapMs = 0, sleep = defaultSleep } = {}) {
  const queue = tasks.slice()
  const results = []
  const worker = async () => {
    while (queue.length) {
      const task = queue.shift()
      try { results.push({ ok: true, value: await task() }) }
      catch (err) { results.push({ ok: false, err }) }
      if (gapMs && queue.length) await sleep(gapMs)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, limit) }, worker))
  return results
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CONCURRENCY = 2
const GAP_MS = 250
// Long enough for the first paint and the sync pull to land. Warming is a
// nicety; it must never be what the opening frame waits on.
const START_DELAY_MS = 1500

// Each entry names the plugin that owns it, so a disabled plugin is never
// fetched for. The module is imported lazily so a plugin the user does not have
// on is not even parsed. Every warm() self-guards on its own connectivity
// (Canvas token present, Google connected, ...) and resolves quietly if it
// cannot run.
const TASKS = [
  { plugin: 'canvas', load: () => import('./canvasui.js').then((m) => m.warmCanvas) },
  { plugin: 'email', load: () => import('./emailui.js').then((m) => m.warmEmail) },
  { plugin: 'calendar', load: () => import('./calendarui.js').then((m) => m.warmCalendar) },
]

let started = false

// Called once from renderer boot. `isEnabled` is injected rather than imported
// so this stays testable, and so the caller decides what "enabled" means.
export function startPrefetch(isEnabled, { tasks = TASKS, delay = START_DELAY_MS } = {}) {
  if (started) return
  started = true
  const due = tasks.filter((t) => isEnabled(t.plugin))
  if (!due.length) return
  setTimeout(() => {
    runLimited(
      due.map((t) => async () => {
        const warm = await t.load()
        if (typeof warm === 'function') await warm()
      }),
      { limit: CONCURRENCY, gapMs: GAP_MS },
    ).then(() => window.dispatchEvent(new CustomEvent('atlas:prefetched')))
  }, delay)
}
