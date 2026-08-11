// Does an edit made in the DESKTOP app reach the database?
//
// This drives the real Electron window over CDP (not a browser standing in for
// it), signs up, writes through the hooked setItem, then wipes every local
// atlas.* key and reloads. With the cache gone the app has nothing to render
// from but the server, so the value coming back proves it round-tripped through
// Postgres rather than sitting in localStorage.
//
// Spends 2 auth calls (signup + the re-login the reload performs with the token).
// Run: node tmp-e2e/electron-db.mjs
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { strictEqual, ok } from 'node:assert'

const PORT = 9333
const stamp = Date.now()
const EMAIL = `electron-${stamp}@test.local`
const MARKER = `written-in-electron-${stamp}`
let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message.split('\n')[0]) }
}

// .pathname would keep the %20 from "Atlas V4" and spawn would fail.
const APP_DIR = fileURLToPath(new URL('..', import.meta.url))
const electronBin = execFileSync('node', ['-p', 'require("electron")'], {
  cwd: APP_DIR,
}).toString().trim()

const proc = spawn(electronBin, ['.', '--smoke-hold', `--remote-debugging-port=${PORT}`], {
  cwd: APP_DIR,
  stdio: ['ignore', 'pipe', 'pipe'],
})
proc.stderr.on('data', () => {}) // Electron chatters on stderr; not our signal

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('electron never reported ready')), 40000)
  proc.stdout.on('data', (b) => {
    if (b.toString().includes('ATLAS_HOLD_READY')) { clearTimeout(timer); resolve() }
  })
  proc.on('exit', (c) => reject(new Error(`electron exited early (${c})`)))
})

let browser
try {
  await ready
  // The CDP endpoint settles a moment after the window does.
  for (let i = 0; i < 20 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`) }
    catch { await new Promise((r) => setTimeout(r, 500)) }
  }
  if (!browser) throw new Error('could not attach to electron over CDP')
  const page = browser.contexts()[0].pages()[0]

  await check('desktop app reaches the login gate', async () => {
    await page.waitForSelector('.auth-card', { timeout: 20000 })
  })

  await check('signup from the desktop app', async () => {
    // Programmatic clicks, not page.click(): the window is deliberately hidden
    // (no visible browser on this machine), and a hidden Electron window never
    // receives synthesized OS input — measured, the toggle button's own label
    // never changed. This still runs the app's real handlers in the real
    // renderer; only the OS input layer is bypassed, which is not what we test.
    await page.evaluate((email) => {
      const set = (sel, v) => {
        const el = document.querySelector(sel)
        el.value = v
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      document.querySelector('.auth-toggle').click()
      set('.auth-input[name="email"]', email)
      set('.auth-input[name="password"]', 'correct-horse-9')
      document.querySelector('.auth-submit').click()
    }, EMAIL)
    const done = await Promise.race([
      page.waitForSelector('#nav a', { timeout: 30000 }).then(() => 'booted').catch(() => 'timeout'),
      page.waitForFunction(() => {
        const e = document.querySelector('.auth-error')
        return e && !e.hidden && e.textContent ? e.textContent : null
      }, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null),
    ])
    if (done !== 'booted') throw new Error(`gate said: ${done}`)
  })

  await check('an edit in the desktop app is accepted locally', async () => {
    await page.evaluate((m) => {
      localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { gym: true }, installed: {} }))
      localStorage.setItem('atlas.study.v1', JSON.stringify({ marker: m }))
    }, MARKER)
    await page.waitForTimeout(2500) // 400ms push debounce + server round trip
    const got = await page.evaluate(() => localStorage.getItem('atlas.study.v1'))
    ok(got.includes(MARKER))
  })

  await check('the edit is in the database, not just the cache', async () => {
    // Drop every cached atlas.* key but the credentials. Nothing local remains
    // to render from, so whatever comes back came from the server.
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage))
        if (k.startsWith('atlas.') && k !== 'atlas.auth.v1') localStorage.removeItem(k)
    })
    await page.reload()
    await page.waitForSelector('#nav a', { timeout: 30000 })
    const got = await page.evaluate(() => localStorage.getItem('atlas.study.v1'))
    ok((got || '').includes(MARKER), `marker did not come back from the database: ${got}`)
    const labels = await page.$$eval('#nav .nav__item .nav__label', (n) => n.map((x) => x.textContent))
    ok(labels.includes('Gym'), `plugin state did not come back either — nav: ${labels.join(',')}`)
  })

  await check('the local APIs are served by the app itself', async () => {
    const status = await page.evaluate(() => fetch('/study-api/jobs').then((r) => r.status))
    strictEqual(status, 200)
  })
} catch (e) {
  fail++
  console.log('FAIL harness -', e.message)
} finally {
  try { await browser?.close() } catch {}
  proc.kill('SIGTERM')
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
