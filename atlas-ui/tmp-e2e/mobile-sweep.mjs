// Mobile layout sweep. Real WebKit (the engine the iOS shell runs) at iPhone
// metrics, with the native flag injected so isMobile()/is-native-ios take the
// exact code path the phone takes — not a narrow-desktop approximation.
//
// The signal is deliberately narrow, because a broad "anything that overflows"
// audit drowns in intentional cases (ellipsis clipping, off-canvas drawers,
// scrollable tables). What it reports:
//   1. the page scrolling sideways at all
//   2. an INTERACTIVE element sitting partly or wholly outside the viewport —
//      a control you cannot reach is unambiguously broken
//   3. an interactive element mostly eaten by an overflow:hidden ancestor
//   4. tap targets under Apple's 44pt minimum (separate, lower-priority bucket)
//
// Run: node tmp-e2e/mobile-sweep.mjs [--json out.json] [--shots dir]
import { webkit } from 'playwright'
import fs from 'node:fs'

// ATLAS_BASE lets a second checkout point this at its own dev server —
// vite is strictPort, so parallel agents cannot share 5173.
const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
const argv = process.argv.slice(2)
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : null
const shotDir = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null
if (shotDir) fs.mkdirSync(shotDir, { recursive: true })

// Every route a phone can reach: 13 pages (Course Planner is desktop-only and
// the router redirects it), 5 plugin settings tabs, 3 global settings tabs.
const ROUTES = [
  ['dashboard', '#/dashboard'],
  ['gym', '#/gym'], ['gym-settings', '#/gym/settings'],
  ['email', '#/email'],
  ['calendar', '#/calendar'],
  ['canvas', '#/canvas'], ['canvas-settings', '#/canvas/settings'],
  ['work', '#/work'], ['work-settings', '#/work/settings'],
  ['ladder', '#/ladder'], ['ladder-settings', '#/ladder/settings'],
  ['sleep', '#/sleep'], ['sleep-settings', '#/sleep/settings'],
  ['equations', '#/equations'],
  ['notes', '#/notes'],
  ['study', '#/study'],
  ['flashcards', '#/flashcards'],
  ['formal', '#/formal'],
  ['settings-accounts', '#/settings/accounts'],
  ['settings-appearance', '#/settings/appearance'],
  ['settings-plugins', '#/settings/plugins'],
]

const PLUGINS = ['calendar', 'canvas', 'course', 'email', 'equations', 'formal',
  'flashcards', 'gym', 'ladder', 'notes', 'sleep', 'study', 'work']

// Enough data that pages render their real furniture instead of empty states —
// an empty page hides exactly the overflow bugs this is looking for.
const line = (id, widgets) => ({ id: `l-${id}`, widgets })
const DASH_BOARD = { v: 1, rows: [
  { id: 'r-d1', title: 'Today', cols: [{ id: 'c-d1', sections: [{ id: 's-d1', lines: [
    line('d1', [{ id: 'w-card', kind: 'card', title: 'A note to self', text: 'Remember the tip-out sheet before close.' }]),
    line('d2', [{ id: 'w-list', kind: 'list', title: 'Errands', items: ['Lab report', 'Refill protein', 'Text landlord about formal deposit'] }]),
    line('d3', [{ id: 'w-graph', kind: 'graph', title: 'Weekly hours', graphType: 'line', xLabel: 'day', yLabel: 'hrs',
      points: [{ label: 'Mon', value: 6 }, { label: 'Tue', value: 4 }, { label: 'Wed', value: 8 }, { label: 'Thu', value: 5 }, { label: 'Fri', value: 9 }] }]),
    line('d4', [{ id: 'w-gymcur', kind: 'gymcurrent' }]),
    line('d5', [{ id: 'w-gymgraph', kind: 'gymscoregraph' }]),
    line('d6', [{ id: 'w-wkinc', kind: 'wkincome' }]),
    line('d7', [{ id: 'w-slhrs', kind: 'slhours' }]),
    line('d8', [{ id: 'w-eq', kind: 'eqcard', title: 'Gauss', latex: '\\oint \\vec{E}\\cdot d\\vec{A} = \\frac{Q}{\\epsilon_0}' }]),
    line('d9', [{ id: 'w-calag', kind: 'calagenda' }]),
    line('d10', [{ id: 'w-cvup', kind: 'cvupcoming' }]),
  ] }] }] },
] }

const SEED = {
  'atlas.gym.v1': {
    v: 1,
    workouts: [{ id: 'gw-push', name: 'Push' }, { id: 'gw-pull', name: 'Pull' }, { id: 'gw-legs', name: 'Legs' }],
    exercises: [
      { id: 'ge-b', workoutId: 'gw-push', name: 'Barbell Bench Press', target: '3×8' },
      { id: 'ge-r', workoutId: 'gw-pull', name: 'Bent Over Row', target: '3×10', unilateral: true },
    ],
    logs: [{ exerciseId: 'ge-b', side: null, date: '2026-08-20', sets: [{ weight: 60, reps: 8 }, { weight: 65, reps: 6 }] }],
    completions: [{ workoutId: 'gw-push', date: '2026-08-20', ts: Date.now() - 86400000, start: '17:00', end: '18:15' }],
    plan: { type: 'cycle', weekly: {}, cycle: { order: ['gw-push', 'gw-pull', 'gw-legs'], position: 0 }, overrides: {} },
    unit: 'lbs', address: '123 Main St, Charlotte, NC', defaultDuration: 75,
  },
  'atlas.work.v1': {
    v: 1, wage: 15.5, tipPosition: true,
    shifts: [{ id: 'sh-1', date: '2026-08-20', hours: '6:30', tips: '92.50' }],
  },
  'atlas.sleep.v1': {
    v: 1, log: [{ date: '2026-08-20', sleep: '23:30', wake: '07:15' }],
  },
  'atlas.equations.v1': { v: 1, cards: [{ id: 'eq-1', title: 'Euler', latex: 'e^{i\\pi}+1=0' }] },
  // The connected flags are a LOCAL CACHE of server-side state (email.js,
  // canvas.js, ai.js), so seeding them is enough to render the real chrome.
  // Without this, Calendar/Email/Canvas/Study/Flashcards all show a connect
  // prompt and the sweep audits an empty page — which is how a first pass
  // missed the calendar toolbar entirely. The requests themselves still fail;
  // layout is what is being measured. No real credential is used.
  'atlas.email.v1': {
    connected: true, address: 'audit@example.com',
    accounts: ['audit@example.com', 'second@example.com'], pinned: [], splitPct: 42,
  },
  'atlas.canvas.v1': {
    host: 'uncc.instructure.com', token: 'layout-audit-not-a-real-token',
    scale: 'plusminus', credits: {}, semesters: [], dismissed: [], hiddenCourses: [], labels: {}, scales: {},
  },
  'atlas.ai.v1': { providers: { claude: { oauth: { access: 'layout-audit-not-a-real-token', expires: 4102444800000 } } } },
  // Study, Flashcards and Notes render course tabs / a file tree, so with no
  // tabs and no folder they paint an empty state and the sweep audits nothing.
  // A first pass scored all three as clean purely because they were blank.
  'atlas.study.v1': { tabs: [
    { id: 't-phys', name: 'Physics II', chat: [
      { role: 'you', text: 'Explain Gauss law' },
      { role: 'tutor', text: 'The flux through a closed surface is proportional to the enclosed charge.' }],
      questions: [{ id: 'q1', prompt: 'A point charge sits at the centre of a sphere. What is the flux?',
        choices: ['Zero', 'q over epsilon-nought', 'Proportional to the radius', 'Undefined'],
        answer: 1, category: 'Gauss', explanation: 'Flux depends only on enclosed charge.' }] },
    { id: 't-calc', name: 'Calculus III', chat: [], questions: [] },
  ], active: 't-phys' },
  'atlas.flashcards.v1': { tabs: [
    { id: 'f-phys', name: 'Physics II', cards: [
      { id: 'c1', front: 'Gauss law', back: 'Flux is proportional to enclosed charge', box: 0, due: '' },
      { id: 'c2', front: 'Coulomb constant', back: '8.99e9 N m^2 / C^2', box: 1, due: '' }] },
  ], active: 'f-phys' },
  'atlas.notes.v1': { dir: process.env.ATLAS_NOTES_DIR || '', lastSubdir: '', openDirs: ['Physics'] },
  // The dashboard seeds its mobile board from the desktop one, so with neither
  // seeded the LANDING PAGE audits as an empty state — the most widget-dense
  // page in the app, measuring nothing. Seed both keys with a mix of every
  // widget family (plain, chart, and one live view per plugin).
  'atlas.page.v1': DASH_BOARD,
  'atlas.page.v1.mobile': DASH_BOARD,
}

const b = await webkit.launch({ headless: true })
// Defaults to iPhone 17 Pro; ATLAS_VP=375x667 checks the narrow end (SE/mini),
// which is where a layout that merely fits at 402 tends to give out.
const [VW, VH] = (process.env.ATLAS_VP || '402x874').split('x').map(Number)
const ctx = await b.newContext({
  viewport: { width: VW, height: VH },
  deviceScaleFactor: 3,
  hasTouch: true,
})
await ctx.addInitScript(({ plugins, seed }) => {
  localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({
    enabled: Object.fromEntries(plugins.map((p) => [p, true])), installed: {},
  }))
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, JSON.stringify(v))
  // The shell's own signal. Skipped for Notes: fetchTree branches on isNative()
  // and calls /icloud/notes/tree, which only the Swift LocalServer serves — a
  // dev server answers with its SPA fallback, so the tree never renders and the
  // route gets audited empty. body.is-mobile still applies at this width, which
  // is what the layout actually keys off; Notes-on-native is the simulator's job.
  if (!location.hash.startsWith('#/notes')) window.__ATLAS_NATIVE__ = { platform: 'ios' }
}, { plugins: PLUGINS, seed: SEED })

// Runs in the page. Returns findings for the CURRENT DOM, so it can be called
// again after opening a modal or a dropdown.
const AUDIT = () => {
  const vw = document.documentElement.clientWidth
  const INTERACTIVE = 'button,a[href],select,input,textarea,[role="button"],[data-gym-act],[data-cal],[data-cal-view]'
  const path = (el) => {
    const bits = []
    for (let n = el; n && n !== document.body && bits.length < 4; n = n.parentElement) {
      const cls = (n.className && typeof n.className === 'string')
        ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
      bits.unshift(n.tagName.toLowerCase() + cls)
    }
    return bits.join(' > ')
  }
  const vis = (el) => {
    const cs = getComputedStyle(el)
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0
  }
  const inXScroller = (el) => {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
    return false
  }

  const offscreen = [], clipped = [], small = []
  for (const el of document.body.querySelectorAll(INTERACTIVE)) {
    if (!vis(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    // A drawer parked entirely off-canvas is intentional; something straddling
    // the edge, or sitting just past it, is not.
    const fullyOff = r.right <= 0 || r.left >= vw
    if (!fullyOff && !inXScroller(el) && (r.right > vw + 1 || r.left < -1)) {
      offscreen.push({ sel: path(el), text: (el.innerText || el.value || '').trim().slice(0, 40),
        left: Math.round(r.left), right: Math.round(r.right), vw })
    }
    // Eaten by an overflow:hidden ancestor. Only flagged when MOST of the
    // control is gone — partial clipping is how ellipsis text is supposed to
    // work, and flagging that would bury the real findings.
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip') continue
      const a = n.getBoundingClientRect()
      const visW = Math.min(r.right, a.right) - Math.max(r.left, a.left)
      if (visW < r.width * 0.5) {
        clipped.push({ sel: path(el), by: path(n), text: (el.innerText || '').trim().slice(0, 40),
          shown: Math.max(0, Math.round(visW)), of: Math.round(r.width) })
        break
      }
    }
    if ((r.width < 44 || r.height < 44) && !inXScroller(el)) {
      small.push({ sel: path(el), text: (el.innerText || '').trim().slice(0, 30),
        w: Math.round(r.width), h: Math.round(r.height) })
    }
  }
  // Report the outermost offender only: if a container is already off-screen,
  // every control inside it is too, and one finding points at the fix.
  const outermost = (list) => list.filter((f, _, all) =>
    !all.some((o) => o !== f && f.sel.startsWith(o.sel + ' > ')))

  return {
    docScrollsSideways: document.documentElement.scrollWidth > vw + 1,
    scrollW: document.documentElement.scrollWidth,
    vw,
    offscreen: outermost(offscreen),
    clipped,
    smallTapTargets: small,
  }
}

const results = []
for (const [name, hash] of ROUTES) {
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message))
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' && !t.includes('vite') && !t.includes('WebSocket') && !t.includes('Failed to load resource')) errs.push(t)
  })
  try {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1600)
    const r = await page.evaluate(AUDIT)
    if (shotDir) await page.screenshot({ path: `${shotDir}/${name}.png`, fullPage: false })
    results.push({ route: name, hash, ...r, errors: [...new Set(errs)] })
    const bad = r.offscreen.length + r.clipped.length + (r.docScrollsSideways ? 1 : 0)
    console.log(`${bad ? 'XX' : 'ok'} ${name.padEnd(22)} ` +
      `${r.docScrollsSideways ? `sideways-scroll(${r.scrollW}>${r.vw}) ` : ''}` +
      `${r.offscreen.length ? `offscreen:${r.offscreen.length} ` : ''}` +
      `${r.clipped.length ? `clipped:${r.clipped.length} ` : ''}` +
      `${r.smallTapTargets.length ? `tiny:${r.smallTapTargets.length}` : ''}`)
  } catch (e) {
    results.push({ route: name, hash, fatal: String(e).slice(0, 200) })
    console.log(`!! ${name.padEnd(22)} ${String(e).slice(0, 120)}`)
  }
  await page.close()
}

await b.close()

console.log('\n=== detail ===')
for (const r of results) {
  if (r.fatal) { console.log(`\n[${r.route}] FATAL ${r.fatal}`); continue }
  if (!r.docScrollsSideways && !r.offscreen.length && !r.clipped.length && !r.errors?.length) continue
  console.log(`\n[${r.route}] ${r.hash}`)
  if (r.docScrollsSideways) console.log(`   page scrolls sideways: ${r.scrollW}px of content in a ${r.vw}px viewport`)
  for (const o of r.offscreen) console.log(`   offscreen: ${o.sel} "${o.text}" left=${o.left} right=${o.right} vw=${o.vw}`)
  for (const c of r.clipped) console.log(`   clipped:   ${c.sel} "${c.text}" — ${c.shown}px of ${c.of}px shown, by ${c.by}`)
  for (const e of r.errors || []) console.log(`   error:     ${e.slice(0, 160)}`)
}

const totals = results.reduce((a, r) => ({
  sideways: a.sideways + (r.docScrollsSideways ? 1 : 0),
  offscreen: a.offscreen + (r.offscreen?.length || 0),
  clipped: a.clipped + (r.clipped?.length || 0),
  tiny: a.tiny + (r.smallTapTargets?.length || 0),
  fatal: a.fatal + (r.fatal ? 1 : 0),
}), { sideways: 0, offscreen: 0, clipped: 0, tiny: 0, fatal: 0 })
console.log(`\n=== totals over ${results.length} routes ===`)
console.log(`   pages scrolling sideways: ${totals.sideways}`)
console.log(`   offscreen controls:       ${totals.offscreen}`)
console.log(`   badly clipped controls:   ${totals.clipped}`)
console.log(`   sub-44pt tap targets:     ${totals.tiny}`)
console.log(`   routes that failed:       ${totals.fatal}`)

if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify(results, null, 1)); console.log(`\nwrote ${jsonOut}`) }
