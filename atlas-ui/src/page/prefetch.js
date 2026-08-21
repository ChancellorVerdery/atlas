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
// Fallback ceiling only — see startPrefetch(), which races this against the
// 'atlas:hydrated' event and normally starts on that instead, well under this.
// Kept at 1500ms rather than shortened: on the common warm-cache boot, render()
// has already returned by the time this timer is even armed (main.js awaits
// bootApp() — which imports and fully evaluates renderer.js, running its
// startPrefetch() call — before firing the background sync), so this length is
// no longer "time for first paint." It is now purely how long a live sync pull
// gets before plugin fetches join it on the wire. Shortening it would start
// competing with an in-flight sync on a slow connection — the exact interference
// this delay exists to prevent — for no benefit on a fast one, since the event
// already wins that race.
const START_DELAY_MS = 1500

// A resumed app re-hydrates — main.js dispatches 'atlas:hydrated' again when the
// page becomes visible — and that has to re-warm, or a phone (which suspends
// and resumes rather than cold-booting) keeps painting the cache it warmed on
// whatever day it was last launched. warmEmail and warmCalendar have no
// freshness guard of their own, so this interval is the only thing standing
// between app-switching and a refetch storm.
const WARM_MIN_MS = 60e3

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
//
// Fires on whichever comes first: the fixed `delay`, or main.js's
// 'atlas:hydrated' (dispatched once the warm-cache boot's background sync
// pull lands — see hydrateInBackground() in main.js). That event is the
// actual signal this delay was only ever estimating, so racing it starts the
// warm as soon as it's safe rather than after a fixed guess — while the timer
// still guarantees a start on a cold boot, an offline session, or a dead sync
// tunnel, where the event never comes at all.
export function startPrefetch(isEnabled, { tasks = TASKS, delay = START_DELAY_MS, warmEvery = WARM_MIN_MS } = {}) {
  if (started) return
  started = true
  const due = tasks.filter((t) => isEnabled(t.plugin))
  if (!due.length) return
  // Replaces the old one-shot `fired` flag: the first pass always runs (0 is
  // longer ago than any interval), and everything after it is rate-limited
  // rather than refused outright.
  let lastWarm = 0
  const go = () => {
    if (Date.now() - lastWarm < warmEvery) return
    lastWarm = Date.now()
    clearTimeout(timer)
    runLimited(
      due.map((t) => async () => {
        const warm = await t.load()
        if (typeof warm === 'function') await warm()
      }),
      { limit: CONCURRENCY, gapMs: GAP_MS },
    ).then(() => window.dispatchEvent(new CustomEvent('atlas:prefetched')))
  }
  const timer = setTimeout(go, delay)
  // Deliberately NOT { once: true } any more: every later hydrate is a resume,
  // and re-warming on it is the point. `warmEvery` is what keeps that safe.
  window.addEventListener('atlas:hydrated', go)
}
