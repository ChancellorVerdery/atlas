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

const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
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
let version = 'dev'
try {
  version = execSync('git rev-parse --short HEAD', { cwd: DIST }).toString().trim()
  if (execSync('git status --porcelain -- .', { cwd: DIST }).toString().trim()) version += '-dirty'
} catch { /* not a git checkout — keep 'dev' */ }

fs.writeFileSync(
  path.join(DIST, 'manifest.json'),
  JSON.stringify({ version, builtAt: Date.now(), files }, null, 1),
)
console.log(`manifest.json: ${version}, ${files.length} files`)
