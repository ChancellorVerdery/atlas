import { defineConfig } from 'vite'
import { MIDDLEWARES } from './server/middlewares.js'

// The local API handlers live in server/middlewares.js so the Electron app can
// mount the same ones without a dev server. Here they are just wrapped in the
// Vite plugin shape; `use(prefix, handler)` strips the prefix, which is what
// the handlers expect.
const asPlugin = ({ prefix, handler }) => ({
  name: `atlas${prefix}`,
  configureServer(server) { server.middlewares.use(prefix, handler) },
  configurePreviewServer(server) { server.middlewares.use(prefix, handler) },
})

// base: './' keeps asset paths relative so the built dist loads from any path.
export default defineConfig({
  base: './',
  server: { port: 5173, strictPort: true },
  plugins: MIDDLEWARES.map(asPlugin),
})
