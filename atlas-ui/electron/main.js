// Atlas desktop shell.
//
// The window is a thin frame around the same web app; all state still lives in
// the Postgres database behind wss://sync.myatlasapp.net, reached over the
// existing WebSocket sync client. localStorage is this device's cache of that
// database — writes go through the hooked setItem and push to the server, so
// edits made here land in the database like they do in the browser.
import { app, BrowserWindow, shell } from 'electron'
import { startHost, distExists } from './host.js'

// --smoke boots everything without showing a window, prints a report and exits.
// --smoke-hold boots the same hidden window and stays up, so a test driving
// Electron over CDP gets the real app rather than a browser approximation.
const SMOKE = process.argv.includes('--smoke')
const HOLD = process.argv.includes('--smoke-hold')
const HEADLESS = SMOKE || HOLD

let host = null

async function createWindow() {
  if (!distExists()) {
    console.error('atlas: dist/ is missing — run `npm run build` first')
    app.exit(1)
    return
  }
  host = await startHost()

  const win = new BrowserWindow({
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

// Proves the three things that make this a standalone app rather than a viewer
// pointed at a dev server: the bundle is served by our own host, the local API
// handlers are mounted, and the app actually booted.
async function runSmoke(win) {
  const out = { ok: true, checks: [] }
  const check = (name, pass, detail = '') => {
    out.checks.push(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' - ' + detail : ''}`)
    if (!pass) out.ok = false
  }
  try {
    const booted = await win.webContents.executeJavaScript(
      `!!(document.querySelector('.auth-card') || document.querySelector('#nav a'))`)
    check('app boots from the local host', booted)

    const title = await win.webContents.executeJavaScript(`document.title`)
    check('bundle served by the electron host', !!title, `title=${JSON.stringify(title)}`)

    // The page's origin is what Google matches against the OAuth client's
    // authorized JavaScript origins, so a drifting port breaks sign-in.
    const origin = await win.webContents.executeJavaScript(`location.origin`)
    check('page origin is the registered one', origin === 'http://127.0.0.1:5180', origin)

    const jobs = await win.webContents.executeJavaScript(
      `fetch('/study-api/jobs').then(r => r.status)`)
    check('local API mounted (/study-api/jobs)', jobs === 200, `status=${jobs}`)

    const proxied = await win.webContents.executeJavaScript(
      `fetch('/graph-api/nope').then(r => r.status).catch(() => 'threw')`)
    check('unknown local API route answers', proxied !== 'threw', `status=${proxied}`)
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
