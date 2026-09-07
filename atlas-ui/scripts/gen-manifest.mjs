// Writes dist/manifest.json — the version identity the Swift app's updater
// compares against the server's copy to decide whether newer web assets exist.
// Runs after `npm run build` (build.sh and deploy-assets.sh both call it), so
// the manifest is baked into the app bundle AND shipped to the server.
import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('gen-manifest: dist/index.html missing — run `npm run build` first')
  process.exit(1)
}

// Dotfiles are skipped, files and directories alike. Vite emits none, so every
// dot-entry that turns up in dist/ is host litter — .DS_Store is the one that
// actually happens (the repo root already has one). Without this, it was hashed
// into the manifest, and the manifest's file list is what every device
// downloads: a Finder artifact shipped to every phone. Skipping it here also
// makes deploy-assets.sh sweep it, since the sweeper's keep-list IS this list
// (the tar it ships is unfiltered and would otherwise leave it on the server).
// If Atlas ever needs a real dot-path in the bundle (.well-known/... for an
// app-site association, say), this is the line to revisit — there is none today.
const files = []
const skippedDot = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.name.startsWith('.')) skippedDot.push(path.relative(DIST, p).split(path.sep).join('/'))
    else if (e.isDirectory()) walk(p)
    else if (e.name !== 'manifest.json') {
      const buf = fs.readFileSync(p)
      files.push({
        path: path.relative(DIST, p).split(path.sep).join('/'),
        size: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
      })
    }
  }
})(DIST)
files.sort((a, b) => (a.path < b.path ? -1 : 1))

// builtAt decides which copy wins on a device; version is just the dir name
// and the human-readable label, so a -dirty suffix is fine there.
//
// Both git commands run from the UI SOURCE root, not DIST. dist/ is gitignored,
// and `git status --porcelain` does not report ignored paths, so asking it from
// inside dist/ always answered "clean": -dirty could never appear, and a bundle
// built from uncommitted edits still stamped a bare commit sha. That is exactly
// backwards for the deploy-and-iterate loop, where the version echoed by
// deploy-assets.sh and logged by the Swift updater is the only thing saying
// which code a device is actually running.
// Scoped to the build's real inputs rather than the whole directory, so an
// unrelated dirty artifact (graphify-out/, study-figures/) cannot pin every
// future build to -dirty and make the marker meaningless the other way.
const SRC_ROOT = fileURLToPath(new URL('../', import.meta.url))
const BUILD_INPUTS = ['src', 'index.html', 'vite.config.js', 'package.json', 'package-lock.json']
let version = 'dev'
try {
  version = execSync('git rev-parse --short HEAD', { cwd: SRC_ROOT }).toString().trim()
  if (execSync(`git status --porcelain -- ${BUILD_INPUTS.join(' ')}`, { cwd: SRC_ROOT }).toString().trim())
    version += '-dirty'
} catch { /* not a git checkout — keep 'dev' */ }

fs.writeFileSync(
  path.join(DIST, 'manifest.json'),
  JSON.stringify({ version, builtAt: Date.now(), files }, null, 1),
)
console.log(`manifest.json: ${version}, ${files.length} files`)
// Loud, not silent: skipping is right, but a build quietly dropping paths is
// how you lose a real asset without noticing.
if (skippedDot.length) console.log(`gen-manifest: skipped ${skippedDot.length} dot-path(s): ${skippedDot.join(', ')}`)
