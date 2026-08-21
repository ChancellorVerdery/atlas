// Long-content stress. The main sweep seeds tidy short names, which is exactly
// the data that hides a layout bug — an unbroken 60-character workout name or a
// long email subject is what actually forces a row past the screen edge.
// Same audit as the sweep, different data.
// Run: node tmp-e2e/mobile-longcontent.mjs
import { webkit } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
const LONG = 'Incline Dumbbell Bench Press With Slow Eccentric Tempo And Pause'
const UNBROKEN = 'Supercalifragilisticexpialidociousworkoutnamewithnospaces'

const SEED = {
  'atlas.gym.v1': {
    v: 1,
    workouts: [{ id: 'gw-1', name: LONG }, { id: 'gw-2', name: UNBROKEN }],
    exercises: [
      { id: 'ge-1', workoutId: 'gw-1', name: LONG, target: '4×8-10 @ RPE 8.5' },
      { id: 'ge-2', workoutId: 'gw-1', name: UNBROKEN, target: '3×12', unilateral: true },
    ],
    logs: [{ exerciseId: 'ge-1', side: null, date: '2026-08-20', sets: [{ weight: 142.5, reps: 12 }] }],
    completions: [{ workoutId: 'gw-1', date: '2026-08-20', ts: Date.now() - 86400000, start: '17:00', end: '18:15' }],
    plan: { type: 'cycle', weekly: {}, cycle: { order: ['gw-1', 'gw-2'], position: 0 }, overrides: {} },
    unit: 'lbs', address: '4321 Something Very Long Boulevard Suite 1200, Charlotte, North Carolina 28262',
    defaultDuration: 75,
  },
  'atlas.work.v1': { v: 1, wage: 15.5, tipPosition: true, shifts: [{ id: 's1', date: '2026-08-20', hours: '10:30', tips: '1234.56' }] },
  'atlas.equations.v1': { v: 1, cards: [{ id: 'e1', title: LONG, latex: '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}' }] },
  'atlas.study.v1': { tabs: [{ id: 't1', name: LONG, chat: [{ role: 'tutor', text: UNBROKEN + ' ' + LONG }], questions: [] }], active: 't1' },
  'atlas.flashcards.v1': { tabs: [{ id: 'f1', name: LONG, cards: [{ id: 'c1', front: UNBROKEN, back: LONG, box: 0, due: '' }] }], active: 'f1' },
  'atlas.email.v1': { connected: true, address: 'averyveryverylongemailaddress@somelongdomainname.example.com', accounts: ['averyveryverylongemailaddress@somelongdomainname.example.com'], pinned: [], splitPct: 42 },
}

const ROUTES = ['dashboard', 'gym', 'gym/settings', 'work', 'work/settings', 'equations', 'study', 'flashcards', 'email', 'sleep/settings', 'ladder/settings']
const PLUGINS = ['calendar', 'canvas', 'email', 'equations', 'formal', 'flashcards', 'gym', 'ladder', 'notes', 'sleep', 'study', 'work']

const b = await webkit.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 3, hasTouch: true })
await ctx.addInitScript(({ plugins, seed }) => {
  localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: Object.fromEntries(plugins.map((p) => [p, true])), installed: {} }))
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, JSON.stringify(v))
  window.__ATLAS_NATIVE__ = { platform: 'ios' }
}, { plugins: PLUGINS, seed: SEED })

let bad = 0
for (const r of ROUTES) {
  const p = await ctx.newPage()
  await p.goto(`${BASE}/#/${r}`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1400)
  const m = await p.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const inX = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o === 'auto' || o === 'scroll') return true } return false }
    const off = [...document.querySelectorAll('button,a[href],select,input,textarea')].filter((el) => {
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false
      const q = el.getBoundingClientRect(); if (q.width < 1 || q.height < 1) return false
      if (inX(el)) return false
      return !(q.right <= 0 || q.left >= vw) && (q.right > vw + 1 || q.left < -1)
    }).map((el) => `${el.tagName}.${String(el.className).split(' ')[0]} "${(el.innerText || '').trim().slice(0, 18)}" right=${Math.round(el.getBoundingClientRect().right)}`)
    // Any element at all pushing the document wider than the screen.
    const widest = [...document.querySelectorAll('*')].filter((e) => !inX(e) && e.getBoundingClientRect().right > vw + 1)
      .map((e) => `${e.tagName}.${String(e.className).split(' ')[0]} right=${Math.round(e.getBoundingClientRect().right)}`)
    return { vw, sideways: document.documentElement.scrollWidth > vw + 1, scrollW: document.documentElement.scrollWidth, off, widest: [...new Set(widest)].slice(0, 5) }
  })
  if (m.sideways || m.off.length) {
    bad++
    console.log(`XX ${r}  sideways=${m.sideways} (${m.scrollW} > ${m.vw})`)
    for (const o of m.off) console.log(`     offscreen control: ${o}`)
    for (const w of m.widest) console.log(`     overflowing: ${w}`)
  } else console.log(`ok ${r}`)
  await p.close()
}
await b.close()
console.log(`\nlong-content stress at 375px: ${bad} of ${ROUTES.length} routes with problems`)
process.exit(bad ? 1 : 0)
