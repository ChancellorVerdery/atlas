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

// Binds to a random free port on the loopback interface only — these handlers
// have no authentication and can read local files and run the claude CLI, so
// they must never be reachable from the network.
export function startHost() {
  const server = http.createServer((req, res) => {
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
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` })
    })
  })
}

export const distExists = () => fs.existsSync(path.join(DIST, 'index.html'))
