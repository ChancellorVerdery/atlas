// Fixed-window rate limiter, in-memory per service instance. limiter() returns
// allow(key) -> boolean; keys are IPs or connection ids. A sweep interval keeps
// the map from growing without bound.
// ponytail: fixed window (not sliding/token-bucket) — burst at a window edge can
// hit 2x max; move to a token bucket if that ever matters.

export function limiter({ windowMs, max }) {
  const hits = new Map() // key -> {n, resetAt}
  setInterval(() => {
    const now = Date.now()
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k)
  }, windowMs).unref()
  return (key) => {
    const now = Date.now()
    let h = hits.get(key)
    if (!h || now > h.resetAt) hits.set(key, (h = { n: 0, resetAt: now + windowMs }))
    return ++h.n <= max
  }
}

// Client IP: Caddy sets X-Forwarded-For; tunnel/direct connections don't have
// it and fall back to the socket address. XFF is only spoofable from inside
// the container network or the loopback tunnel — both already trusted.
export const ipOf = (req) =>
  (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?'
