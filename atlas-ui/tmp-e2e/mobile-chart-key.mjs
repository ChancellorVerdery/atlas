// Regression: charts must draw on a phone as well as on desktop.
//
// Was broken:
// renderer.js loads the mobile board from `storageKey + '.mobile'` but hands
// renderPageInto the DESKTOP storageKey, so view.js's activeKey names the wrong
// board. drawChart then does findWidget(loadPage(activeKey), id) with an id that
// only exists in the mobile board, gets undefined, and returns before drawing.
// No error, no console warning — just an empty box.
//
// The two boards below carry DIFFERENT widget ids, which is the real-world case
// (mobile seeds its own layout and then diverges). Seeding both with the same
// ids is what masks this.
// Run: node tmp-e2e/mobile-chart-key.mjs
import { webkit } from 'playwright'

const BASE = 'http://localhost:5173'

const GYM = {
  v: 1,
  workouts: [{ id: 'gw-push', name: 'Push' }],
  exercises: [{ id: 'ge-b', workoutId: 'gw-push', name: 'Bench Press' }],
  logs: Array.from({ length: 6 }, (_, i) => ({
    exerciseId: 'ge-b', side: null, date: `2026-08-${String(2 + i * 3).padStart(2, '0')}`,
    sets: [{ weight: 60 + i * 2.5, reps: 8 }],
  })),
  completions: [], plan: { type: 'cycle', weekly: {}, cycle: { order: ['gw-push'], position: 0 }, overrides: {} },
  unit: 'lbs', address: '', defaultDuration: 75,
}

const board = (wid) => ({ v: 1, rows: [
  { id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [
    { id: 'l1', widgets: [{ id: wid, kind: 'gymscoregraph' }] },
  ] }] }] },
] })

const run = async (label, viewport, native) => {
  const b = await webkit.launch({ headless: true })
  const ctx = await b.newContext({ viewport, deviceScaleFactor: native ? 3 : 1, hasTouch: !!native })
  await ctx.addInitScript(({ gym, desk, mob, native }) => {
    localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
    localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { gym: true }, installed: {} }))
    localStorage.setItem('atlas.gym.v1', JSON.stringify(gym))
    localStorage.setItem('atlas.page.gym.v1', JSON.stringify(desk))
    localStorage.setItem('atlas.page.gym.v1.mobile', JSON.stringify(mob))
    if (native) window.__ATLAS_NATIVE__ = { platform: 'ios' }
  }, { gym: GYM, desk: board('w-desktop-graph'), mob: board('w-mobile-graph'), native })

  const page = await ctx.newPage()
  await page.goto(`${BASE}/#/gym`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)

  const r = await page.evaluate(() => {
    const mount = document.querySelector('.chart-mount')
    const rect = mount?.getBoundingClientRect()
    const svg = mount?.querySelector('svg')
    return {
      mounts: document.querySelectorAll('.chart-mount').length,
      mountId: mount?.dataset.widgetId || null,
      mountW: Math.round(rect?.width || 0), mountH: Math.round(rect?.height || 0),
      drew: !!svg,
      marked: mount?.dataset.chart || null, // drawChart sets this only on success
    }
  })
  await b.close()
  return { label, ...r }
}

const desktop = await run('desktop 1440x900', { width: 1440, height: 900 }, false)
const phone = await run('iPhone 402x874 (native ios)', { width: 402, height: 874 }, true)

for (const r of [desktop, phone]) {
  console.log(`\n=== ${r.label} ===`)
  console.log(`   chart mounts: ${r.mounts}, widget id on mount: ${r.mountId}`)
  console.log(`   mount box:    ${r.mountW}x${r.mountH}  (a zero box would be a different bug)`)
  console.log(`   ${r.drew ? 'ok' : 'XX'} SVG drawn: ${r.drew}   data-chart marker: ${r.marked ?? '(none)'}`)
}

const ok = desktop.drew && phone.drew && desktop.marked && phone.marked
console.log(`\n${ok ? 'PASS' : 'FAIL'}: desktop draws=${desktop.drew}, phone draws=${phone.drew}`)
if (!phone.drew) console.log('  phone drew nothing — activeKey is naming the desktop board again (renderer.js)')
process.exit(ok ? 0 : 1)
