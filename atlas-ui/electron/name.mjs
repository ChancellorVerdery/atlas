// Name the app "Atlas" in the dock.
//
// Running unpackaged means macOS reads the name off Electron's own bundle, so
// hovering the dock icon says "Electron" no matter what app.setName() does —
// that call renames menus and paths, not the bundle. This rewrites the two
// Info.plist keys the dock actually reads.
//
// It edits node_modules, so it re-runs from the `app` npm scripts: idempotent,
// and an `npm ci` that wipes the change just gets it back on the next launch.
// ponytail: the durable fix is packaging the app with its own bundle id and
// Info.plist — do that when there's a distributable .app to ship.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const APP = fileURLToPath(new URL('../node_modules/electron/dist/Electron.app', import.meta.url))
const PLIST = `${APP}/Contents/Info.plist`
const NAME = 'Atlas'

if (process.platform !== 'darwin' || !fs.existsSync(PLIST)) process.exit(0)

const plist = (cmd) => execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, PLIST], { encoding: 'utf8' }).trim()

let changed = false
for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
  let current = null
  try { current = plist(`Print :${key}`) } catch { /* key absent — add it */ }
  if (current === NAME) continue
  plist(current === null ? `Add :${key} string ${NAME}` : `Set :${key} ${NAME}`)
  changed = true
}

if (changed) {
  // The bundle's mtime is what invalidates LaunchServices' cached name.
  fs.utimesSync(APP, new Date(), new Date())
  console.log(`atlas: named the dev Electron bundle "${NAME}"`)
}
