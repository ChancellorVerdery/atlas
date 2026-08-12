// Atlas desktop shell.
//
// The window is a thin frame around the same web app; all state still lives in
// the Postgres database behind wss://sync.myatlasapp.net, reached over the
// existing WebSocket sync client. localStorage is this device's cache of that
// database — writes go through the hooked setItem and push to the server, so
// edits made here land in the database like they do in the browser.
import { app, BrowserWindow, shell, nativeImage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { startHost, distExists } from './host.js'

// --smoke boots everything without showing a window, prints a report and exits.
// --smoke-hold boots the same hidden window and stays up, so a test driving
// Electron over CDP gets the real app rather than a browser approximation.
// Menus, ~/Library paths and app.getName(). The dock's hover label comes from
// the bundle instead — electron/name.mjs, run by the npm scripts, sets that.
app.setName('Atlas')

const SMOKE = process.argv.includes('--smoke')
const HOLD = process.argv.includes('--smoke-hold')
const HEADLESS = SMOKE || HOLD

let host = null
let lastIcon = null // the applied icon, so the smoke run can prove it landed

// The colour scheme lives in the page, so the icon is drawn there and sent
// down. macOS takes it on the dock; elsewhere it's the window icon.
function setAppIcon(dataUrl, win) {
  const img = nativeImage.createFromDataURL(String(dataUrl || ''))
  if (img.isEmpty()) return
  if (app.dock) app.dock.setIcon(img)
  else win?.setIcon(img)
  lastIcon = img
}

async function createWindow() {
  if (!distExists()) {
    console.error('atlas: dist/ is missing — run `npm run build` first')
    app.exit(1)
    return
  }
  let win // assigned below; the icon can arrive before the page finishes loading
  host = await startHost({ onIcon: (png) => setAppIcon(png, win) })

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false, // revealed on ready-to-show so the first paint isn't a white flash
    backgroundColor: '#090b11', // --bg, so the frame matches before CSS lands
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false, // the page is ordinary web content; it gets no Node
      sandbox: true,
    },
  })

  if (!HEADLESS) win.once('ready-to-show', () => win.show())

  // Google's sign-in popup has to stay in-app: the code flow posts its result
  // back to the opener window, which a handoff to the system browser breaks.
  // Everything else a link points at belongs in the user's real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/accounts\.google\.com\//.test(url)) return { action: 'allow' }
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // Same rule for in-place navigation: the app itself never leaves its origin.
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(host.origin)) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) shell.openExternal(url)
    }
  })

  await win.loadURL(host.origin + '/')

  if (SMOKE) await runSmoke(win)
  if (HOLD) console.log('ATLAS_HOLD_READY ' + host.origin)
}

// The name macOS actually shows: read from the running bundle, not from us.
function readBundleName() {
  try {
    // exe lives in Electron.app/Contents/MacOS/, the plist one level up
    const plist = fs.readFileSync(path.resolve(path.dirname(app.getPath('exe')), '..', 'Info.plist'), 'utf8')
    return plist.match(/<key>CFBundleName<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? '(unset)'
  } catch { return '(unreadable)' }
}

// Proves the three things that make this a standalone app rather than a viewer
// pointed at a dev server: the bundle is served by our own host, the local API
// handlers are mounted, and the app actually booted.
async function runSmoke(win) {
  const out = { ok: true, checks: [] }
  const check = (name, pass, detail = '') => {
    out.checks.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`)
    if (!pass) out.ok = false
  }
  // Poll rather than sample once: a signed-in boot waits on the sync connect
  // before the shell renders, so the first frame can be legitimately empty.
  const waitFor = async (js, ms = 10_000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) {
      if (await win.webContents.executeJavaScript(js)) return true
      await new Promise((r) => setTimeout(r, 150))
    }
    return false
  }
  try {
    const booted = await waitFor(
      `!!(document.querySelector('.auth-card') || document.querySelector('#nav a'))`)
    check('app boots from the local host', booted)

    const title = await win.webContents.executeJavaScript(`document.title`)
    check('bundle served by the electron host', !!title, `title=${JSON.stringify(title)}`)

    // The page's origin is what Google matches against the OAuth client's
    // authorized JavaScript origins, so a drifting port breaks sign-in.
    const origin = await win.webContents.executeJavaScript(`location.origin`)
    check(host.port === 5180
      ? 'page origin is the registered one'
      : 'page origin matches this host (5180 was busy — another Atlas is up)',
    origin === host.origin, origin)

    const jobs = await win.webContents.executeJavaScript(
      `fetch('/study-api/jobs').then(r => r.status)`)
    check('local API mounted (/study-api/jobs)', jobs === 200, `status=${jobs}`)

    const proxied = await win.webContents.executeJavaScript(
      `fetch('/graph-api/nope').then(r => r.status).catch(() => 'threw')`)
    check('unknown local API route answers', proxied !== 'threw', `status=${proxied}`)

    // The colour scheme reaches the dock: the page rasterises its themed logo
    // and posts the PNG here. Canvas would refuse a tainted image, so this also
    // proves the SVG data URL is origin-clean.
    await new Promise((done) => {
      const t0 = Date.now()
      const tick = () => (lastIcon || Date.now() - t0 > 5000 ? done() : setTimeout(tick, 100))
      tick()
    })
    check('themed app icon reached the shell', !!lastIcon && lastIcon.getSize().width === 512,
      lastIcon ? `${lastIcon.getSize().width}px` : 'never arrived')

    // …and a different scheme produces a different icon. pushAppIcon takes a
    // scheme without storing it, so this proves the path without touching the
    // user's saved colours.
    const before = lastIcon?.toDataURL()
    await win.webContents.executeJavaScript(
      `window.atlasTheme.pushAppIcon({ preset: 'rose', accent: '#22ff88' })`)
    let repainted = false
    for (const t0 = Date.now(); Date.now() - t0 < 5000 && !repainted;) {
      repainted = !!lastIcon && lastIcon.toDataURL() !== before
      if (!repainted) await new Promise((r) => setTimeout(r, 100))
    }
    check('a scheme change repaints the icon', repainted)

    // What the dock shows on hover comes from the bundle, not app.setName().
    const bundleName = readBundleName()
    check('the app is named Atlas', app.getName() === 'Atlas' && bundleName === 'Atlas',
      `app=${app.getName()} bundle=${bundleName}`)
    await win.webContents.executeJavaScript(`window.atlasTheme.pushAppIcon()`) // back to theirs
  } catch (e) {
    check('smoke run', false, e.message)
  }
  console.log(out.checks.join('\n'))
  console.log(out.ok ? '\nSMOKE OK' : '\nSMOKE FAILED')
  app.exit(out.ok ? 0 : 1)
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  host?.server.close()
  if (process.platform !== 'darwin') app.quit()
})

// macOS: clicking the dock icon after closing every window reopens one.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
