// SSH-key gate. Fronts the hostnames that should only be reachable by someone
// who already holds a key this box trusts — the Mac's dev server and the
// console — and hands the browser a 24h token once they prove it.
//
// Why signatures and not a password: the key is already the credential for this
// machine, it never leaves the laptop, and there is no new secret to store or
// rotate. `ssh-keygen -Y sign` is on every machine that can already SSH here.
//
// Runs with host networking so it can reach both upstreams on loopback.
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { verifySignature, parseSignature, issueToken, tokenValid } from '../lib/sshsig.js'
import { startPortainerAuth } from './portainer-auth.js'

const PORT = Number(process.env.GATE_PORT || 8099)
const NAMESPACE = 'atlas-gate' // baked into the signature; ties it to this use
const COOKIE = 'atlas_gate'
const KEYS_FILE = process.env.GATE_KEYS || '/keys/authorized_keys'
// Only affects the example command shown on the page — the gate accepts any key
// in KEYS_FILE regardless. Named for the key that actually exists on the Mac;
// `id_ed25519` was a wrong guess that made the printed command fail outright.
const KEY_HINT = process.env.GATE_KEY_HINT || '~/.ssh/homeserver'
// A restart invalidates outstanding tokens unless a secret is supplied. That is
// the safe default: better a re-sign than a token signed with a key nobody set.
const SECRET = process.env.GATE_SECRET || crypto.randomBytes(32).toString('hex')

// host -> where it goes. Anything not listed is refused outright, so a stray
// DNS record can't turn the gate into an open proxy.
const UPSTREAM = {
  'dev.myatlasapp.net': { host: '127.0.0.1', port: 5173, name: 'the dev server' },
  // Portainer, Adminer, the git board and the terminal all live under this one
  // host as paths (/docker, /db, /git, /shell). portainer.myatlasapp.net used
  // to be a second way in, published straight to caddy with no basic auth; it
  // has been removed from cloudflared rather than gated, so there is one door.
  'console.myatlasapp.net': { host: '127.0.0.1', port: 80, name: 'the console' },
}

const allowedKeys = () => {
  try { return fs.readFileSync(KEYS_FILE, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#')) }
  catch { return [] }
}

// One-shot nonces, so a captured signature can't be replayed.
const nonces = new Map()
setInterval(() => {
  const now = Date.now()
  for (const [n, exp] of nonces) if (exp < now) nonces.delete(n)
}, 60_000).unref()

// An hour, not ten minutes: the flow is "read the page, switch to a terminal,
// maybe go find the right machine", and a challenge going stale mid-task is
// indistinguishable from the signature being rejected.
const NONCE_TTL_MS = 60 * 60_000

const newNonce = () => {
  const n = crypto.randomBytes(18).toString('base64url')
  nonces.set(n, Date.now() + NONCE_TTL_MS)
  return n
}

const cookieOf = (req) =>
  Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => {
    const i = c.indexOf('=')
    return i < 0 ? [c.trim(), ''] : [c.slice(0, i).trim(), c.slice(i + 1).trim()]
  }))[COOKIE]

const page = (nonce, err) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Atlas — sign in with your SSH key</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#090b11; color:#e9e7df;
         font:15px/1.55 -apple-system,'Segoe UI',sans-serif; padding:24px }
  .card { width:min(620px,100%); background:#0e1219; border:1px solid rgba(202,214,242,.15);
          border-radius:16px; padding:26px 28px }
  h1 { font-size:19px; margin:0 0 6px } p { color:#9aa0ad; margin:0 0 16px }
  pre { background:#070910; border:1px solid rgba(202,214,242,.12); border-radius:10px;
        padding:12px 14px; overflow-x:auto; font:12.5px/1.5 ui-monospace,monospace; color:#e0b15c }
  textarea { width:100%; height:150px; background:#070910; color:#e9e7df; border-radius:10px;
             border:1px solid rgba(202,214,242,.15); padding:10px 12px; font:12px/1.45 ui-monospace,monospace }
  button { margin-top:12px; background:linear-gradient(180deg,#e0b15c,#b9863a); color:#14100a; border:0;
           border-radius:10px; padding:10px 18px; font-weight:600; font-size:14px; cursor:pointer }
  .err { color:#e08c8c; min-height:1.4em; margin:10px 0 0; font-size:13px }
  .hint { font-size:12.5px; color:#7d8494; margin:-6px 0 12px }
  .hint code { color:#9aa0ad }
  #copy { margin:0 8px 0 0; padding:3px 10px; font-size:12px; font-weight:500; background:none;
          color:#9aa0ad; border:1px solid rgba(202,214,242,.22); border-radius:7px; vertical-align:baseline }
  #copy:hover { color:#e9e7df; border-color:rgba(202,214,242,.4) }
</style>
<div class="card">
  <h1>Sign in with your SSH key</h1>
  <p>Run this on a machine whose key can already reach the Atlas server, then paste what it prints. The token it gives your browser lasts 24 hours.</p>
  <pre id="cmd">printf %s '${nonce}' | ssh-keygen -Y sign -f ${KEY_HINT} -n ${NAMESPACE} -</pre>
  <p class="hint"><button type="button" id="copy">Copy command</button>
  Any key this server already trusts works — change the <code>-f</code> path if you use a different one.
  Nothing secret leaves your machine: this prints a signature, not your key.</p>
  <p class="hint">Paste the whole block it prints, <code>-----BEGIN</code> and <code>-----END</code> lines included.
  Each challenge is good once — if you get an error, re-run the command with the
  <em>new</em> value shown above rather than pasting the previous signature again.</p>
  <form method="POST" action="/_gate/verify">
    <input type="hidden" name="nonce" value="${nonce}">
    <textarea name="sig" placeholder="-----BEGIN SSH SIGNATURE-----" spellcheck="false" autofocus></textarea>
    <p class="err">${err || ''}</p>
    <button type="submit">Unlock for 24 hours</button>
  </form>
</div>
<script>
  document.getElementById('copy').onclick = async (e) => {
    try {
      await navigator.clipboard.writeText(document.getElementById('cmd').textContent)
      e.target.textContent = 'Copied'
      setTimeout(() => { e.target.textContent = 'Copy command' }, 1500)
    } catch { e.target.textContent = 'Select it manually' }
  }
</script>`

const challenge = (res, err) => {
  res.writeHead(err ? 401 : 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(page(newNonce(), err))
}

function proxy(req, res, up) {
  const p = http.request({
    host: up.host, port: up.port, method: req.method, path: req.url,
    headers: { ...req.headers, 'x-forwarded-proto': 'https' },
  }, (pr) => {
    res.writeHead(pr.statusCode || 502, pr.headers)
    pr.pipe(res)
  })
  p.on('error', () => {
    res.writeHead(502, { 'content-type': 'text/plain' })
    res.end(`${up.name} isn't running right now.`)
  })
  req.pipe(p)
}

const server = http.createServer((req, res) => {
  const host = String(req.headers.host || '').split(':')[0]
  const up = UPSTREAM[host]
  if (!up) { res.writeHead(404, { 'content-type': 'text/plain' }).end('unknown host'); return }

  if (req.method === 'POST' && req.url === '/_gate/verify') {
    let body = ''
    req.on('data', (c) => { body += c; if (body.length > 20_000) req.destroy() })
    req.on('end', () => {
      const form = new URLSearchParams(body)
      const nonce = form.get('nonce') || ''
      const sig = form.get('sig') || ''
      // one shot: consumed whether or not it verifies
      const known = nonces.delete(nonce)
      if (!known) {
        challenge(res, 'That challenge was already used, expired, or predates a gate restart. '
          + 'Re-run the command with the new value above — pasting the same signature again will not work.')
        return
      }
      if (!verifySignature(sig, nonce, NAMESPACE, allowedKeys())) {
        // Separate the "you pasted something that is not a signature" case from
        // "you signed with the wrong key": they need completely different fixes.
        const parsed = parseSignature(sig)
        challenge(res, !parsed
          ? 'That does not look like an SSH signature. Paste the whole block, including the BEGIN and END lines.'
          : parsed.namespace !== NAMESPACE
            ? `That signature was made for "${parsed.namespace}", not "${NAMESPACE}" — check the -n flag.`
            : 'That signature is valid, but it was made by a key this server does not trust.')
        return
      }
      res.writeHead(302, {
        location: '/',
        // Domain-wide: one signature unlocks every gated hostname, rather than
        // making you sign again moving from the console to the dev server.
        'set-cookie': `${COOKIE}=${issueToken(SECRET)}; Domain=.myatlasapp.net; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`,
      })
      res.end()
    })
    return
  }

  if (!tokenValid(cookieOf(req), SECRET)) { challenge(res); return }
  proxy(req, res, up)
})

// Vite's HMR (and anything else) speaks WebSocket; the token is checked on the
// upgrade too, or the socket would be a way straight past the gate.
server.on('upgrade', (req, socket, head) => {
  const host = String(req.headers.host || '').split(':')[0]
  const up = UPSTREAM[host]
  if (!up || !tokenValid(cookieOf(req), SECRET)) { socket.destroy(); return }
  const upstream = net.connect(up.port, up.host, () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n')
    if (head?.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
  socket.on('error', () => upstream.destroy())
})

server.listen(PORT, '127.0.0.1', () =>
  console.log(`gate up on 127.0.0.1:${PORT} for ${Object.keys(UPSTREAM).join(', ')}` +
    (process.env.GATE_SECRET ? '' : ' (no GATE_SECRET set — tokens die on restart)')))

// Same process, separate listener: caddy's :9001 block sends Portainer traffic
// here so the Docker tab arrives already signed in.
startPortainerAuth()
