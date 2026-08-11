// Canvas REST proxy. Canvas sends no CORS headers, so the browser cannot call
// it directly; this forwards /canvas-proxy/<host>/<path> to https://<host>/<path>.
// Moved here from the Mac (atlas-ui/server/middlewares.js) — same code, now that
// the caller is authenticated by services/uiapi.js before it ever runs.
//
// The Canvas PAT arrives in the request's Authorization header and is forwarded
// verbatim; it is never stored here. Note that the Atlas SESSION token uses a
// different header (X-Atlas-Token) precisely so it is not shipped to Canvas.

// The target host comes out of the URL, so it is allowlisted, not merely
// pattern-matched: unrestricted, this is an open HTTPS forwarder carrying a
// caller-chosen Authorization header, and it sits on stack_default with reach
// to postgres, adminer, portainer and the home LAN.
//
// Two real shapes: Canvas SaaS (<school>.instructure.com) and self-hosted under
// the school's own domain. The live setting is instructure.charlotte.edu, which
// a bare *.instructure.com rule rejects outright — verified against the stored
// value rather than assumed. Anchored both ends so
// `uncc.instructure.com.attacker.net` cannot pass.
const HOST_OK = [
  /^[a-z0-9][a-z0-9-]*\.instructure\.com$/,
  /^instructure\.[a-z0-9][a-z0-9-]*\.edu$/,
]
const EXTRA_HOSTS = new Set((process.env.CANVAS_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean))
export const allowedHost = (h) => {
  const host = String(h).toLowerCase()
  return HOST_OK.some((re) => re.test(host)) || EXTRA_HOSTS.has(host)
}

export async function canvasProxy(req, res) {
  const m = (req.url || '').match(/^\/([a-zA-Z0-9.-]+)(\/.*)$/)
  if (!m || req.method !== 'GET') { res.statusCode = 400; res.end('bad canvas-proxy request'); return }
  if (!allowedHost(m[1])) { res.statusCode = 403; res.end('canvas-proxy: host not allowed'); return }
  try {
    const r = await fetch(`https://${m[1]}${m[2]}`, {
      headers: req.headers.authorization ? { Authorization: req.headers.authorization } : {},
      redirect: 'follow',
    })
    res.statusCode = r.status
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/json')
    const link = r.headers.get('link')
    if (link) res.setHeader('X-Canvas-Link', link) // pagination survives the hop
    res.end(Buffer.from(await r.arrayBuffer()))
  } catch (err) {
    res.statusCode = 502
    res.end(JSON.stringify({ errors: [{ message: `proxy: ${err.message}` }] }))
  }
}
