// The packaged app's own web host: serves the built dist/ and mounts the same
// local API handlers the Vite dev server used to own. This is what makes Atlas
// standalone — nothing here needs `vite` to be running.
//
// http://127.0.0.1 rather than file:// on purpose. The app fetches root-relative
// paths ('/study-api/chat'), which file:// cannot resolve, and sync.js calls
// crypto.randomUUID(), which needs a secure context — 127.0.0.1 counts as one.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MIDDLEWARES } from '../server/middlewares.js'
import { setSessionToken } from '../server/remote.js'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
}

// Reproduces connect's mounting contract, which the handlers were written
// against: the mount prefix is stripped from req.url before the handler runs,
// and the original is kept on req.originalUrl. Matching is on a path boundary
// so '/graph-apifoo' can never be routed to the '/graph-api' handler.
function mount(req) {
  const url = req.url || '/'
  for (const { prefix, handler } of MIDDLEWARES) {
    if (url !== prefix && !url.startsWith(prefix + '/') && !url.startsWith(prefix + '?')) continue
    req.originalUrl = url
    const rest = url.slice(prefix.length)
    req.url = rest.startsWith('/') ? rest : '/' + rest
    return handler
  }
  return null
}

function serveStatic(req, res) {
  let rel
  try { rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname) }
  catch { res.writeHead(400).end('bad request'); return }
  if (rel.endsWith('/')) rel += 'index.html'

  // resolve() collapses any '..' before the containment check, so a crafted
  // path cannot read outside dist/.
  const file = path.resolve(DIST, '.' + rel)
  if (file !== path.resolve(DIST) && !file.startsWith(DIST)) {
    res.writeHead(403).end('forbidden')
    return
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // Atlas routes on the hash, so every real route is '/' — a miss here is a
      // genuinely absent file, not a client route needing an index.html rewrite.
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // The window is the only client and it reloads on relaunch; caching a
      // stale bundle after a rebuild is a worse failure than re-reading a file.
      'cache-control': 'no-store',
    })
    res.end(buf)
  })
}

// Binds to the loopback interface only — these handlers have no authentication
// and can read local files and run the claude CLI, so they must never be
// reachable from the network.
//
// The port is FIXED because it is part of the app's origin, and Google checks
// that origin against the OAuth client's authorized JavaScript origins list
// (the sign-in popup posts the auth code back to this page). A random port
// would mean a new, unregistered origin on every launch.
const PORT = 5180

export function startHost({ onIcon } = {}) {
  const handle = (req, res) => {
    // The page owns the colour scheme, and the logo is drawn from it — so the
    // app icon can only come from the page. It rasterises the themed logo and
    // posts the PNG here; main.js puts it on the dock.
    if (req.url === '/local/icon' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 4_000_000) req.destroy() })
      req.on('end', () => {
        try { onIcon?.(JSON.parse(body).png) } catch { /* malformed — keep the old icon */ }
        res.writeHead(204).end()
      })
      return
    }
    // The page hands its Atlas session token down so proxied prefixes can
    // authenticate to the server. It lives in localStorage, which this Node
    // process cannot read; kept in memory only, never written to disk.
    // Same-origin and loopback-bound, so only this app's own page can post here.
    if (req.url === '/local/session' && (req.method === 'POST' || req.method === 'DELETE')) {
      if (req.method === 'DELETE') { setSessionToken(null); res.writeHead(204).end(); return }
      let body = ''
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
      req.on('end', () => {
        try { setSessionToken(JSON.parse(body).token) } catch { /* ignore malformed */ }
        res.writeHead(204).end()
      })
      return
    }
    const handler = mount(req)
    if (handler) {
      handler(req, res, () => {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unhandled local api route' }))
      })
      return
    }
    serveStatic(req, res)
  }

  // A fresh server per attempt: a failed listen() leaves its 'listening'
  // callback attached, so retrying on the same server resolves twice.
  const listen = (port) => new Promise((resolve, reject) => {
    const server = http.createServer(handle)
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port
      resolve({ server, port: p, origin: `http://127.0.0.1:${p}` })
    })
  })

  // ponytail: a second Atlas instance holds the port — fall back to any free
  // one so the app still runs; only Google sign-in breaks (unknown origin).
  return listen(PORT).catch((err) => {
    if (err.code !== 'EADDRINUSE') throw err
    console.warn(`atlas: port ${PORT} is busy — Google sign-in will be rejected on this launch`)
    return listen(0)
  })
}

export const distExists = () => fs.existsSync(path.join(DIST, 'index.html'))
