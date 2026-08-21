// Customize mode on a phone. It is a whole second interaction mode — palette,
// per-widget delete/resize chrome, row and section controls — and nothing else
// in this suite enters it, so none of that UI has ever been measured at phone
// width. Same audit as the sweep, applied with body.customizing on.
// Run: node tmp-e2e/mobile-customize.mjs
import { webkit } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
const PLUGINS = ['calendar', 'canvas', 'email', 'equations', 'formal', 'flashcards',
  'gym', 'ladder', 'notes', 'sleep', 'study', 'work']
// Widget-model pages only: the "full" plugins (Email, Calendar, Notes, Study,
// Flashcards, Ladder) render their own window and have no palette.
const ROUTES = ['dashboard', 'gym', 'canvas', 'work', 'sleep', 'equations', 'formal']

const SEED = {
  'atlas.gym.v1': { v: 1, workouts: [{ id: 'gw1', name: 'Push' }], exercises: [{ id: 'ge1', workoutId: 'gw1', name: 'Bench' }],
    logs: [], completions: [], plan: { type: 'cycle', weekly: {}, cycle: { order: ['gw1'], position: 0 }, overrides: {} },
    unit: 'lbs', address: '', defaultDuration: 75 },
  'atlas.work.v1': { v: 1, wage: 15.5, tipPosition: true, shifts: [] },
  'atlas.sleep.v1': { v: 1, log: [] },
  'atlas.equations.v1': { v: 1, cards: [{ id: 'e1', title: 'Euler', latex: 'e^{i\\pi}+1=0' }] },
}

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
  await p.waitForTimeout(1300)

  const entered = await p.evaluate(() => {
    const btn = [...document.querySelectorAll('button,a')]
      .find((e) => /customize/i.test(e.innerText || e.getAttribute('aria-label') || ''))
    if (!btn) return false
    btn.click()
    return true
  })
  if (!entered) { console.log(`-- ${r}: no Customize control found`); await p.close(); continue }
  await p.waitForTimeout(1200)

  const m = await p.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const inX = (el) => { for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) { const o = getComputedStyle(n).overflowX; if (o === 'auto' || o === 'scroll') return true } return false }
    const sel = (el) => { const b = []; for (let n = el; n && n !== document.body && b.length < 3; n = n.parentElement) { const c = (typeof n.className === 'string' && n.className) ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : ''; b.unshift(n.tagName.toLowerCase() + c) } return b.join(' > ') }
    const off = [...document.querySelectorAll('button,a[href],select,input,textarea,[role="button"],.palette__item')].filter((el) => {
      const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false
      const q = el.getBoundingClientRect(); if (q.width < 1 || q.height < 1) return false
      if (inX(el)) return false
      return !(q.right <= 0 || q.left >= vw) && (q.right > vw + 1 || q.left < -1)
    }).map((el) => `${sel(el)} "${(el.innerText || '').trim().slice(0, 20)}" right=${Math.round(el.getBoundingClientRect().right)}`)
    const pal = document.querySelector('.palette')
    return {
      customizing: document.body.classList.contains('customizing'),
      sideways: document.documentElement.scrollWidth > vw + 1,
      scrollW: document.documentElement.scrollWidth, vw,
      paletteVisible: pal ? pal.getBoundingClientRect().width > 1 : false,
      paletteRight: pal ? Math.round(pal.getBoundingClientRect().right) : null,
      off: [...new Set(off)].slice(0, 6),
    }
  })
  const problem = m.sideways || m.off.length || (m.paletteRight != null && m.paletteRight > m.vw + 1)
  if (problem) {
    bad++
    console.log(`XX ${r}  customizing=${m.customizing} sideways=${m.sideways} (${m.scrollW}>${m.vw}) palette=${m.paletteVisible} paletteRight=${m.paletteRight}`)
    for (const o of m.off) console.log(`     offscreen: ${o}`)
  } else {
    console.log(`ok ${r}  customizing=${m.customizing} palette=${m.paletteVisible}`)
  }
  await p.close()
}
await b.close()
console.log(`\ncustomize mode at 375px: ${bad} of ${ROUTES.length} routes with problems`)
process.exit(bad ? 1 : 0)
