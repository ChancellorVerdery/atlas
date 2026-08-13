// The built web-app bundle, served to the native shells' updater: the Swift
// app fetches /app/manifest.json, compares builtAt against the copy it is
// running, and downloads the changed files. deploy: atlas-apple/deploy-assets.sh
// rsyncs atlas-ui/dist (manifest included) into the app-dist volume; files are
// read per request, so a deploy is visible immediately with no restart.
//
// Sits behind uiapi's token gate like every other route here — the updater only
// runs after the page has shared its session token — so this adds no
// unauthenticated surface.
import fs from 'node:fs'
import path from 'node:path'

export function appAssets(req, res) {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'GET only' }))
    return
  }
  let rel
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname) }
  catch { res.writeHead(400).end(); return }

  // Read at request time so the check can point it at a fixture dir.
  const root = path.resolve(process.env.APP_DIST || '/app-dist')
  // resolve() collapses any '..' before the containment check, same guard as
  // the Mac host's static server.
  const file = path.resolve(root, '.' + rel)
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403).end()
    return
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }
    res.writeHead(200, {
      'content-type': rel.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      'content-length': buf.length,
    })
    res.end(buf)
  })
}
