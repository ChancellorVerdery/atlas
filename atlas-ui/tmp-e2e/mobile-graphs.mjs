// Are the charts actually drawn on a phone? A chart that fails to size renders
// as a silent empty box — no console error, nothing the layout sweep can see —
// so this measures the SVGs themselves and compares phone against desktop.
// Same page, same data, same engine: any difference is a mobile bug.
// Run: node tmp-e2e/mobile-graphs.mjs
import { webkit } from 'playwright'

const BASE = 'http://localhost:5173'

const GYM = {
  v: 1,
  workouts: [{ id: 'gw-push', name: 'Push' }, { id: 'gw-pull', name: 'Pull' }],
  exercises: [{ id: 'ge-b', workoutId: 'gw-push', name: 'Bench Press', target: '3×8' }],
  logs: Array.from({ length: 8 }, (_, i) => ({
    exerciseId: 'ge-b', side: null,
    date: `2026-0${i < 4 ? 7 : 8}-${String(2 + i * 3).padStart(2, '0')}`,
    sets: [{ weight: 60 + i * 2.5, reps: 8 }, { weight: 62.5 + i * 2.5, reps: 6 }],
  })),
  completions: Array.from({ length: 8 }, (_, i) => ({
    workoutId: 'gw-push', date: `2026-0${i < 4 ? 7 : 8}-${String(2 + i * 3).padStart(2, '0')}`,
    ts: Date.now() - (8 - i) * 86400000, start: '17:00', end: '18:15',
  })),
  plan: { type: 'cycle', weekly: {}, cycle: { order: ['gw-push', 'gw-pull'], position: 0 }, overrides: {} },
  unit: 'lbs', address: '', defaultDuration: 75,
}

// A board carrying every chart-bearing widget kind, so one page exercises them all.
const GYM_BOARD = { v: 1, rows: [
  { id: 'r1', title: 'Charts', cols: [
    { id: 'c1', sections: [{ id: 's1', lines: [
      { id: 'l1', widgets: [{ id: 'w-scoregraph', kind: 'gymscoregraph' }] },
      { id: 'l2', widgets: [{ id: 'w-vol', kind: 'gymvolume' }] },
      { id: 'l3', widgets: [{ id: 'w-score', kind: 'gymscore' }] },
    ] }] },
  ] },
] }

const probe = async (label, viewport, native) => {
  const b = await webkit.launch({ headless: true })
  const ctx = await b.newContext({ viewport, deviceScaleFactor: native ? 3 : 1, hasTouch: !!native })
  await ctx.addInitScript(({ gym, board, native }) => {
    localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
    localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { gym: true }, installed: {} }))
    localStorage.setItem('atlas.gym.v1', JSON.stringify(gym))
    // Mobile keeps its own board (model.js mobileKey), so seeding only the
    // desktop key leaves the phone seeding a starter layout instead — which is
    // how a first pass "measured" zero charts that were simply never placed.
    localStorage.setItem('atlas.page.gym.v1', JSON.stringify(board))
    localStorage.setItem('atlas.page.gym.v1.mobile', JSON.stringify(board))
    if (native) window.__ATLAS_NATIVE__ = { platform: 'ios' }
  }, { gym: GYM, board: GYM_BOARD, native })

  const page = await b.contexts()[0].newPage ? await ctx.newPage() : await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => { if (!/WebSocket/.test(e.message)) errs.push('PAGEERROR: ' + e.message) })
  await page.goto(`${BASE}/#/gym`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500) // ResizeObserver redraw settles

  const svgs = await page.evaluate(() => [...document.querySelectorAll('.pwidget svg')].map((s) => {
    const r = s.getBoundingClientRect()
    const host = s.closest('.pwidget')
    const hr = host?.getBoundingClientRect()
    // Data marks, not chrome: a chart with axes but no polyline/bars drew nothing.
    const marks = s.querySelectorAll('polyline,path[d]:not([d=""]),rect.bar,circle').length
    return {
      kind: host?.dataset?.kind || host?.getAttribute('data-kind') || '?',
      w: Math.round(r.width), h: Math.round(r.height),
      hostW: Math.round(hr?.width || 0), hostH: Math.round(hr?.height || 0),
      viewBox: s.getAttribute('viewBox') || '',
      marks,
      textCount: s.querySelectorAll('text').length,
    }
  }))
  await b.close()
  return { label, svgs, errs: [...new Set(errs)] }
}

const desktop = await probe('desktop 1440x900', { width: 1440, height: 900 }, false)
const phone = await probe('iPhone 402x874 (native ios)', { width: 402, height: 874 }, true)

for (const r of [desktop, phone]) {
  console.log(`\n=== ${r.label} ===`)
  if (!r.svgs.length) console.log('   NO SVGs RENDERED AT ALL')
  for (const s of r.svgs) {
    const bad = s.w < 2 || s.h < 2 || s.marks === 0
    console.log(`   ${bad ? 'XX' : 'ok'} ${s.kind.padEnd(14)} svg ${s.w}x${s.h}  host ${s.hostW}x${s.hostH}  ` +
      `viewBox="${s.viewBox}"  marks=${s.marks} labels=${s.textCount}`)
  }
  for (const e of r.errs) console.log(`   error: ${e.slice(0, 160)}`)
}

const summarise = (r) => r.svgs.filter((s) => s.w < 2 || s.h < 2 || s.marks === 0).length
console.log(`\ndesktop broken: ${summarise(desktop)}/${desktop.svgs.length}`)
console.log(`phone   broken: ${summarise(phone)}/${phone.svgs.length}`)
