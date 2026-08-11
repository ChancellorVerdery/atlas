import { defineConfig } from 'vite'
import { MIDDLEWARES } from './server/middlewares.js'
import { setSessionToken } from './server/remote.js'

// The local API handlers live in server/middlewares.js so the Electron app can
// mount the same ones without a dev server. Here they are just wrapped in the
// Vite plugin shape; `use(prefix, handler)` strips the prefix, which is what
// the handlers expect.
const asPlugin = ({ prefix, handler }) => ({
  name: `atlas${prefix}`,
  configureServer(server) { server.middlewares.use(prefix, handler) },
  configurePreviewServer(server) { server.middlewares.use(prefix, handler) },
})

// The page hands its Atlas session token down so the proxied prefixes can
// authenticate to the server — the same contract electron/host.js implements,
// so dev and the packaged app behave identically.
const sessionRoute = (req, res, next) => {
  if (req.url !== '/local/session') return next()
  if (req.method === 'DELETE') { setSessionToken(null); res.writeHead(204).end(); return }
  if (req.method !== 'POST') return next()
  let body = ''
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy() })
  req.on('end', () => {
    try { setSessionToken(JSON.parse(body).token) } catch { /* ignore malformed */ }
    res.writeHead(204).end()
  })
}
const sessionPlugin = {
  name: 'atlas-local-session',
  configureServer(server) { server.middlewares.use(sessionRoute) },
  configurePreviewServer(server) { server.middlewares.use(sessionRoute) },
}

// base: './' keeps asset paths relative so the built dist loads from any path.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  plugins: [sessionPlugin, ...MIDDLEWARES.map(asPlugin)],
})
