// The Mac-only local APIs as a bare Node process — the sidecar the Swift macOS
// app spawns. The Swift shell owns the page origin (127.0.0.1:5180) and splices
// /graph-api, /notes-api and /study-api over to this port; static files and the
// /canvas-proxy//finance-api server proxies are the shell's own job, so the
// remote() entries in MIDDLEWARES are mounted here but never receive traffic.
import http from 'node:http'
import { MIDDLEWARES } from './middlewares.js'

// 0 = any free port. The Swift shell reads the actual port back from the
// SIDECAR_PORT= line we print, so two instances never collide on a fixed port.
// PORT can still pin it (tests, manual runs).
const PORT = Number(process.env.PORT || 0)

// Same mounting contract as electron/host.js: prefix stripped from req.url,
// original kept on req.originalUrl, matched on a path boundary.
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

const server = http.createServer((req, res) => {
  const handler = mount(req)
  const miss = () => {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'unhandled local api route' }))
  }
  if (handler) handler(req, res, miss)
  else miss()
})

// Loopback only — these handlers can read local files and run the claude CLI.
// Without this handler an EADDRINUSE would crash on an unhandled 'error' event.
server.on('error', (e) => {
  console.error(`atlas sidecar: listen failed: ${e.code || e.message}`)
  process.exit(1)
})
server.listen(PORT, '127.0.0.1', () => {
  const port = server.address().port
  // The Swift shell parses this exact line to learn where to splice.
  console.log(`SIDECAR_PORT=${port}`)
  console.log(`atlas sidecar up on 127.0.0.1:${port}`)
})

// Die with the parent: the Swift app wires our stdin to a pipe it never writes;
// when the app exits (even force-killed) the pipe closes and we leave too,
// instead of lingering as an orphan holding the port.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
process.stdin.resume()
