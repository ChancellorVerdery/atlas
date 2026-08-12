// Signs the console's Docker tab in to Portainer so you don't face a third
// login after the SSH-key gate and the console's basic auth.
//
// The session cookie is minted here and attached server-side to every proxied
// request; the browser never receives Portainer credentials and never holds a
// Portainer session of its own. That also sidesteps the cookie Portainer sets
// (SameSite=Strict), which a browser will not send inside the console's iframe
// anyway — a big part of why the Docker tab asked for a login again.
//
// SAFE ONLY BEHIND THE OUTER LAYERS. This removes Portainer's own login, so
// whatever can reach this port has full control of the Docker socket — which is
// root on the box. It must stay bound to loopback, reachable only as /docker/
// on the console, behind caddy's basic auth and the SSH-key gate. See the :80
// block in Caddyfile.template; never publish 9002 by any other route.
import http from 'node:http'
import net from 'node:net'

const COOKIE = 'portainer_api_key'

// Portainer's own token lasts 8h; refresh well before that so a long-lived tab
// never lands on an expired one mid-request.
const REFRESH_MS = 6 * 60 * 60_000

export function startPortainerAuth({
  port = Number(process.env.PORTAINER_PROXY_PORT || 9002),
  upstream = { host: '127.0.0.1', port: Number(process.env.PORTAINER_PORT || 9000) },
  username = process.env.PORTAINER_USER,
  password = process.env.PORTAINER_PASS,
} = {}) {
  let token = null
  let mintedAt = 0
  let inflight = null

  const base = `http://${upstream.host}:${upstream.port}`

  async function mint() {
    const r = await fetch(`${base}/api/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Username: username, Password: password }),
    })
    if (!r.ok) throw new Error(`portainer auth failed: ${r.status}`)
    const { jwt } = await r.json()
    if (!jwt) throw new Error('portainer auth returned no jwt')
    return jwt
  }

  // One mint at a time: a cold start behind an iframe fires a burst of parallel
  // requests, and each one racing to authenticate would be pointless load.
  async function sessionToken(force = false) {
    if (!force && token && Date.now() - mintedAt < REFRESH_MS) return token
    if (!inflight) {
      inflight = mint()
        .then((t) => { token = t; mintedAt = Date.now(); return t })
        .catch((err) => { token = null; throw err })
        .finally(() => { inflight = null })
    }
    return inflight
  }

  // Drop any Portainer cookie the browser sent — a stale one from a previous
  // session would otherwise sit in front of ours and 401.
  const withSession = (headers, jwt) => {
    const kept = String(headers.cookie || '')
      .split(';').map((c) => c.trim())
      .filter((c) => c && !c.startsWith(`${COOKIE}=`))
    return { ...headers, cookie: [...kept, `${COOKIE}=${jwt}`].join('; ') }
  }

  const server = http.createServer(async (req, res) => {
    let jwt
    try {
      jwt = await sessionToken()
    } catch (err) {
      // Fall through unauthenticated rather than break the tab: Portainer will
      // show its own login, which is the pre-existing behaviour.
      console.error('portainer-auth: could not mint a session —', err.message)
      jwt = null
    }

    const send = (useJwt, retried) => {
      const p = http.request({
        host: upstream.host, port: upstream.port, method: req.method, path: req.url,
        headers: useJwt ? withSession(req.headers, useJwt) : req.headers,
      }, async (pr) => {
        // A 401 means the token died early (a Portainer restart, a password
        // change). Mint a fresh one and replay once before giving up.
        if (pr.statusCode === 401 && useJwt && !retried) {
          pr.resume()
          try { return send(await sessionToken(true), true) } catch { /* fall through */ }
        }
        // Never let Portainer's own Set-Cookie reach the browser; the session is
        // ours to manage, and a leaked one would outlive the outer auth.
        const headers = { ...pr.headers }
        delete headers['set-cookie']
        res.writeHead(pr.statusCode || 502, headers)
        pr.pipe(res)
      })
      p.on('error', () => {
        if (res.headersSent) return res.destroy()
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('Portainer is not running right now.')
      })
      req.pipe(p)
    }
    send(jwt, false)
  })

  // Portainer speaks WebSocket for container consoles and live stats.
  server.on('upgrade', async (req, socket, head) => {
    let jwt = null
    try { jwt = await sessionToken() } catch { /* proxy unauthenticated */ }
    const headers = jwt ? withSession(req.headers, jwt) : req.headers
    const up = net.connect(upstream.port, upstream.host, () => {
      up.write(
        `${req.method} ${req.url} HTTP/1.1\r\n`
        + Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')
        + '\r\n\r\n')
      if (head?.length) up.write(head)
      socket.pipe(up).pipe(socket)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })

  server.listen(port, '127.0.0.1', () => {
    console.log(`portainer-auth on 127.0.0.1:${port} -> ${base}`
      + (username && password ? '' : ' (NO CREDENTIALS SET — passing through to Portainer\'s own login)'))
  })
  return server
}

// Standalone entry point, so it can run on its own if it ever needs to.
if (import.meta.url === `file://${process.argv[1]}`) startPortainerAuth()
