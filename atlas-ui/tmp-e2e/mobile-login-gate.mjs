// The login gate on a phone. Deliberately seeds NO auth, so the gate is what
// renders — which is exactly why the main mobile sweep cannot cover this: that
// one seeds atlas.auth.v1 to get past the gate.
//
// index.html ships the app shell as static markup, so if body.is-mobile is not
// applied before the gate paints, a phone shows the desktop two-column shell
// (248px sidebar on a 402px screen) until the moment it signs in.
// Run: node tmp-e2e/mobile-login-gate.mjs
import { webkit } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const b = await webkit.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, hasTouch: true })
await ctx.addInitScript(() => { window.__ATLAS_NATIVE__ = { platform: 'ios' } })
const page = await ctx.newPage()
// networkidle, not domcontentloaded: the stylesheet is a separate asset in the
// built bundle and measuring before it lands reports unstyled block geometry.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await page.waitForSelector('.auth-offline', { timeout: 15000 })
await page.waitForTimeout(400)

const m = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth
  const side = document.querySelector('.sidebar')?.getBoundingClientRect()
  const main = document.querySelector('.main')?.getBoundingClientRect()
  const offscreen = [...document.querySelectorAll('button,a[href],input')].filter((el) => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    if (r.width < 1 || r.height < 1) return false
    return !(r.right <= 0 || r.left >= vw) && (r.right > vw + 1 || r.left < -1)
  }).map((el) => ({ text: (el.innerText || '').trim().slice(0, 24), right: Math.round(el.getBoundingClientRect().right) }))
  return {
    vw,
    isMobile: document.body.classList.contains('is-mobile'),
    isNativeIOS: document.body.classList.contains('is-native-ios'),
    sidebarW: Math.round(side?.width || 0),
    sidebarLeft: Math.round(side?.left ?? 0),
    mainW: Math.round(main?.width || 0),
    appCols: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
    sidebarPos: side ? getComputedStyle(document.querySelector('.sidebar')).position : '',
    docScrollsSideways: document.documentElement.scrollWidth > vw + 1,
    offscreen,
  }
})

console.log(JSON.stringify(m, null, 1))
ok(m.isMobile, 'body.is-mobile is set before the login gate paints')
ok(m.isNativeIOS, 'body.is-native-ios is set before the login gate paints')
// The desktop shell is `248px 1fr`; a phone must be a single track.
ok(!/\d+px\s+\d/.test(m.appCols), `.app is a single column, not the desktop two-track grid (got "${m.appCols}")`)
ok(m.sidebarPos === 'fixed', `sidebar is an overlay drawer, not a grid track (position: ${m.sidebarPos})`)
ok(m.sidebarLeft <= -1 || m.sidebarW === 0 || m.sidebarLeft >= m.vw,
  `sidebar is parked off-canvas (left=${m.sidebarLeft} w=${m.sidebarW})`)
ok(!m.docScrollsSideways, 'the login screen does not scroll sideways')
ok(m.offscreen.length === 0, `no controls off the right edge (found ${m.offscreen.length}: ${m.offscreen.map((o) => o.text).join(', ')})`)

await b.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
