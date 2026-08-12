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
  // 127.0.0.1, not the default: Vite otherwise binds ::1 only, and the reverse
  // SSH tunnel that publishes this at dev.myatlasapp.net forwards IPv4.
  // allowedHosts is Vite's host-header check — the tunnel arrives as that name.
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
    allowedHosts: ['dev.myatlasapp.net'],
    // the page is served over https through the tunnel, so HMR has to dial
    // wss:443 rather than the local port it would guess
    hmr: { clientPort: 443, protocol: 'wss', host: 'dev.myatlasapp.net' },
  },
  plugins: [sessionPlugin, ...MIDDLEWARES.map(asPlugin)],
})
