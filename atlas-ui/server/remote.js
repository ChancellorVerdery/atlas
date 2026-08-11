// Reverse proxy from the app's local host to the Atlas server's uiapi service.
//
// This is what lets a handler MOVE to the server without anything else in the
// app changing. The client keeps fetching root-relative same-origin paths
// ('/canvas-proxy/...'), the Electron host still owns those prefixes, and any
// URL persisted in synced user data still resolves — only what sits behind the
// prefix changed. Swapping the entry in MIDDLEWARES is the whole migration.
//
// node:https rather than global fetch on purpose: undici's 300s default
// bodyTimeout would silently kill a long-running call, and streaming the
// response through avoids buffering large Canvas payloads in memory.
import https from 'node:https'

const DEFAULT_BASE = 'https://sync.myatlasapp.net/uiapi'

// The Atlas session token, handed over by the page at boot (the browser has it
// in localStorage; this Node process does not). Kept in memory only — writing it
// to disk would outlive the session it belongs to.
let sessionToken = null
export const setSessionToken = (t) => { sessionToken = typeof t === 'string' && t ? t : null }
export const hasSessionToken = () => !!sessionToken

// Hop-by-hop headers must not be forwarded (RFC 7230 6.1); connection/upgrade in
// particular would confuse the far end.
const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
])

export function remote(prefix, base = process.env.ATLAS_UIAPI_BASE || DEFAULT_BASE) {
  const target = new URL(base)
  return (req, res) => {
    if (!sessionToken) {
      // Offline mode, or the page has not handed the token over yet. A clear
      // status beats a confusing proxy error — these routes genuinely cannot
      // work without a session.
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Atlas server unavailable: not signed in on this device.' }))
      return
    }
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP.has(k.toLowerCase())) headers[k] = v
    }
    // The session token rides its own header. Any client Authorization header
    // (the Canvas PAT) passes through untouched — reusing Authorization here
    // would ship this token to instructure.com.
    headers['x-atlas-token'] = sessionToken
    headers.host = target.host

    // req.url arrives already stripped of the mount prefix, so put it back:
    // the server mounts the identical prefixes and must see the same shape.
    const path = target.pathname.replace(/\/$/, '') + prefix + (req.url || '/')

    const up = https.request(
      { hostname: target.hostname, port: target.port || 443, method: req.method, path, headers },
      (r) => {
        const out = {}
        for (const [k, v] of Object.entries(r.headers)) {
          if (!HOP.has(k.toLowerCase())) out[k] = v
        }
        res.writeHead(r.statusCode || 502, out)
        r.pipe(res)
      },
    )
    up.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `Atlas server unreachable: ${err.message}` }))
    })
    req.pipe(up)
  }
}
