// Atlas UI API host — the handlers that used to run only inside the Mac's
// Vite/Electron process, now served from the Atlas server.
//
// Reached from the internet as https://sync.myatlasapp.net/uiapi/<prefix>/...
// (cloudflared -> host caddy :8090 -> 127.0.0.1:8102 -> here). The Mac's local
// host reverse-proxies its own /canvas-proxy and /finance-api prefixes here, so
// every client path and every persisted URL keeps its original shape.
//
// NOT built on lib/runner.js serveHttp: that is POST-only, matches routes by
// exact string (so any query string 404s), and concatenates the body as a
// string, which corrupts binary. Canvas responses are GETs with query strings
// and may be binary.
import http from 'node:http'
import { userForToken } from '../lib/session.js'
import { appAssets } from './uiapi/app.js'
import { canvasProxy } from './uiapi/canvas.js'
import { notesSync } from './uiapi/notes.js'
import { plaidApi } from './uiapi/plaid.js'

const PORT = Number(process.env.PORT || 80)

// Same mounting contract as connect (and as the Mac's electron/host.js): the
// handler sees req.url with its prefix stripped, matched on a path boundary so
// '/canvas-proxyfoo' can never route to '/canvas-proxy'.
const ROUTES = [
  { prefix: '/canvas-proxy', handler: canvasProxy },
  { prefix: '/finance-api', handler: plaidApi },
  // The built web bundle for the Swift shells' self-updater — static files,
  // but token-gated like everything else here.
  { prefix: '/app', handler: appAssets },
  // The synced notes folder: the server side of the device<->server file sync.
  { prefix: '/notes-sync', handler: notesSync },
]

function mount(req) {
  const url = req.url || '/'
  for (const { prefix, handler } of ROUTES) {
    if (url !== prefix && !url.startsWith(prefix + '/') && !url.startsWith(prefix + '?')) continue
    req.originalUrl = url
    const rest = url.slice(prefix.length)
    req.url = rest.startsWith('/') ? rest : '/' + rest
    return handler
  }
  return null
}

// Deliberately no health path, no public routes, and no CORS headers of any
// kind: a hostile page in a browser must not be able to reach this at all, and
// an unauthenticated caller learns nothing from a 401 with an empty body.
//
// The session token rides X-Atlas-Token, never Authorization — canvas.js sends
// `Authorization: Bearer <Canvas PAT>` and the proxy forwards that header
// verbatim to Canvas. Reusing Authorization would ship the Atlas session token
// to instructure.com.
const server = http.createServer(async (req, res) => {
  try {
    const token = req.headers['x-atlas-token']
    const who = typeof token === 'string' ? await userForToken(token) : null
    if (!who) {
      // Checked before the body is read, so an unauthenticated caller cannot
      // make this process buffer anything.
      res.writeHead(401).end()
      req.destroy()
      return
    }
    const handler = mount(req)
    if (!handler) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unknown uiapi route' }))
      return
    }
    req.atlasUser = who // available to handlers that need per-user scoping
    await handler(req, res)
  } catch (e) {
    console.error('uiapi:', e)
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: String((e && e.message) || e) }))
  }
})

export { mount, ROUTES, server }

// Only bind when run as the entry point, so test/uiapi.check.mjs can import
// mount() without opening a port (same pattern as the plugin mappers).
if (process.argv[1] && process.argv[1].endsWith('uiapi.js')) {
  server.listen(PORT, () => console.log(`uiapi service up on ${PORT}`))
}
