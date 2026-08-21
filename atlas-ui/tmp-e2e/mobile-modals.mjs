// Modal + dropdown sweep. The static sweep only sees a page at rest; this one
// opens things. For every route it clicks each candidate opener in turn, and if
// a modal appears, measures whether the modal and its controls actually fit a
// phone — then closes it and moves on.
//
// Openers are discovered, not hand-listed, so a plugin gaining a button is
// covered without editing this file. Destructive labels are skipped: deleting
// the thing you are about to open removes the rest of the page's openers.
// Run: node tmp-e2e/mobile-modals.mjs [--json out.json]
import { webkit } from 'playwright'
import fs from 'node:fs'

// ATLAS_BASE lets a second checkout point this at its own dev server —
// vite is strictPort, so parallel agents cannot share 5173.
const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null

const ROUTES = [
  ['dashboard', '#/dashboard'], ['gym', '#/gym'], ['gym-settings', '#/gym/settings'],
  ['email', '#/email'], ['calendar', '#/calendar'], ['canvas', '#/canvas'],
  ['canvas-settings', '#/canvas/settings'], ['work', '#/work'], ['work-settings', '#/work/settings'],
  ['ladder', '#/ladder'], ['ladder-settings', '#/ladder/settings'], ['sleep', '#/sleep'],
  ['sleep-settings', '#/sleep/settings'], ['equations', '#/equations'], ['notes', '#/notes'],
  ['study', '#/study'], ['flashcards', '#/flashcards'], ['formal', '#/formal'],
  ['settings-accounts', '#/settings/accounts'], ['settings-appearance', '#/settings/appearance'],
  ['settings-plugins', '#/settings/plugins'],
]

const PLUGINS = ['calendar', 'canvas', 'course', 'email', 'equations', 'formal',
  'flashcards', 'gym', 'ladder', 'notes', 'sleep', 'study', 'work']

const SEED = {
  'atlas.gym.v1': {
    v: 1,
    workouts: [{ id: 'gw-push', name: 'Push' }, { id: 'gw-pull', name: 'Pull' }],
    exercises: [{ id: 'ge-b', workoutId: 'gw-push', name: 'Barbell Bench Press', target: '3×8' }],
    logs: [{ exerciseId: 'ge-b', side: null, date: '2026-08-20', sets: [{ weight: 60, reps: 8 }] }],
    completions: [{ workoutId: 'gw-push', date: '2026-08-20', ts: Date.now() - 86400000, start: '17:00', end: '18:15' }],
    plan: { type: 'cycle', weekly: {}, cycle: { order: ['gw-push', 'gw-pull'], position: 0 }, overrides: {} },
    unit: 'lbs', address: '', defaultDuration: 75,
  },
  'atlas.work.v1': { v: 1, wage: 15.5, tipPosition: true, shifts: [{ id: 'sh-1', date: '2026-08-20', hours: '6:30', tips: '92.50' }] },
  'atlas.sleep.v1': { v: 1, log: [{ date: '2026-08-20', sleep: '23:30', wake: '07:15' }] },
  'atlas.equations.v1': { v: 1, cards: [{ id: 'eq-1', title: 'Euler', latex: 'e^{i\\pi}+1=0' }] },
  'atlas.email.v1': { connected: true, address: 'audit@example.com', accounts: ['audit@example.com'], pinned: [], splitPct: 42 },
  'atlas.canvas.v1': { host: 'uncc.instructure.com', token: 'layout-audit-not-a-real-token', scale: 'plusminus', credits: {}, semesters: [], dismissed: [], hiddenCourses: [], labels: {}, scales: {} },
  'atlas.ai.v1': { providers: { claude: { oauth: { access: 'layout-audit-not-a-real-token', expires: 4102444800000 } } } },
}

const SKIP_LABEL = /delete|remove|sign out|log ?out|disconnect|reset|clear|start fresh|uninstall|×|✕/i

const b = await webkit.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, hasTouch: true })
await ctx.addInitScript(({ plugins, seed }) => {
  localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true }))
  localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: Object.fromEntries(plugins.map((p) => [p, true])), installed: {} }))
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, JSON.stringify(v))
  window.__ATLAS_NATIVE__ = { platform: 'ios' }
}, { plugins: PLUGINS, seed: SEED })

// Measures whatever overlay is currently open.
const MODAL_AUDIT = () => {
  const host = document.querySelector('#app-modal, .modal-backdrop, dialog[open]')
  const modal = document.querySelector('#app-modal .modal, .modal, dialog[open]')
  if (!modal) return null
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const mr = modal.getBoundingClientRect()
  const path = (el) => {
    const bits = []
    for (let n = el; n && n !== document.body && bits.length < 3; n = n.parentElement) {
      const cls = (n.className && typeof n.className === 'string') ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : ''
      bits.unshift(n.tagName.toLowerCase() + cls)
    }
    return bits.join(' > ')
  }
  const controls = []
  for (const el of modal.querySelectorAll('button,a[href],select,input,textarea,[role="button"]')) {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') continue
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) continue
    if (r.right > vw + 1 || r.left < -1) {
      controls.push({ sel: path(el), text: (el.innerText || el.value || '').trim().slice(0, 30), left: Math.round(r.left), right: Math.round(r.right) })
    }
  }
  return {
    modalSel: path(modal),
    w: Math.round(mr.width), h: Math.round(mr.height), vw, vh,
    left: Math.round(mr.left), right: Math.round(mr.right), top: Math.round(mr.top), bottom: Math.round(mr.bottom),
    widerThanScreen: mr.width > vw + 1,
    hangsOffLeft: mr.left < -1,
    hangsOffRight: mr.right > vw + 1,
    tallerThanScreen: mr.height > vh + 1,
    scrollsInternally: modal.scrollHeight > modal.clientHeight + 1,
    offscreenControls: controls,
    // A modal taller than the screen that cannot scroll is unusable: its
    // buttons are simply unreachable.
    unreachableBottom: mr.bottom > vh + 1 && modal.scrollHeight <= modal.clientHeight + 1,
  }
}

const findings = []
for (const [name, hash] of ROUTES) {
  const page = await ctx.newPage()
  page.on('pageerror', () => {})
  try {
    await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)

    const openers = await page.evaluate((skipSrc) => {
      const skip = new RegExp(skipSrc.slice(1, skipSrc.lastIndexOf('/')), 'i')
      const out = []
      const els = document.querySelectorAll('button,[role="button"],.gym-ex-row,.chart-mount[data-chart],.cal-chip,.pwidget--card,.pwidget--eqcard')
      for (const el of els) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        const text = (el.innerText || el.getAttribute('aria-label') || '').trim()
        if (skip.test(text)) continue
        out.push(text.slice(0, 32) || el.className.slice(0, 32))
      }
      return out.slice(0, 14)
    }, String(SKIP_LABEL))

    for (let i = 0; i < openers.length; i++) {
      // Re-resolve by index each time: opening/closing a modal re-renders.
      const opened = await page.evaluate((idx) => {
        const els = [...document.querySelectorAll('button,[role="button"],.gym-ex-row,.chart-mount[data-chart],.cal-chip,.pwidget--card,.pwidget--eqcard')]
          .filter((el) => {
            const cs = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0
          })
        const el = els[idx]
        if (!el) return false
        el.click()
        return true
      }, i).catch(() => false)
      if (!opened) continue
      await page.waitForTimeout(500)
      const m = await page.evaluate(MODAL_AUDIT).catch(() => null)
      if (m) {
        const bad = m.widerThanScreen || m.hangsOffLeft || m.hangsOffRight || m.unreachableBottom || m.offscreenControls.length
        if (bad) findings.push({ route: name, opener: openers[i], ...m })
        console.log(`   ${bad ? 'XX' : 'ok'} ${name}/"${openers[i]}" modal ${m.w}x${m.h} in ${m.vw}x${m.vh}` +
          `${m.widerThanScreen ? ' WIDER-THAN-SCREEN' : ''}${m.hangsOffRight ? ' OFF-RIGHT' : ''}` +
          `${m.hangsOffLeft ? ' OFF-LEFT' : ''}${m.unreachableBottom ? ' BOTTOM-UNREACHABLE' : ''}` +
          `${m.offscreenControls.length ? ` offscreen-controls:${m.offscreenControls.length}` : ''}`)
      }
      // Close whatever opened, then get back to a clean page.
      await page.keyboard.press('Escape').catch(() => {})
      await page.waitForTimeout(200)
      const still = await page.evaluate(() => !!document.querySelector('#app-modal .modal, .modal, dialog[open]')).catch(() => false)
      if (still) { await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200) }
    }
  } catch (e) {
    console.log(`!! ${name}: ${String(e).slice(0, 100)}`)
  }
  await page.close()
}
await b.close()

console.log(`\n=== ${findings.length} modal problems ===`)
for (const f of findings) {
  console.log(`\n[${f.route}] opened by "${f.opener}" — ${f.modalSel}`)
  console.log(`   ${f.w}x${f.h} at left=${f.left} right=${f.right} bottom=${f.bottom} in a ${f.vw}x${f.vh} viewport`)
  if (f.widerThanScreen) console.log(`   WIDER THAN THE SCREEN by ${f.w - f.vw}px`)
  if (f.hangsOffRight) console.log(`   hangs ${f.right - f.vw}px past the right edge`)
  if (f.hangsOffLeft) console.log(`   starts ${-f.left}px off the left edge`)
  if (f.unreachableBottom) console.log(`   bottom is ${f.bottom - f.vh}px below the fold and the modal does not scroll`)
  for (const c of f.offscreenControls) console.log(`   control offscreen: ${c.sel} "${c.text}" left=${c.left} right=${c.right}`)
}
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(findings, null, 1))
