// src/sync.js — Atlas sync client (vanilla ES module, browser, no deps).
// Inbox WS: we send {reqId, code, payload}. Outbox WS: server pushes
// {type:'sync.update', key, value}. Results {reqId, ok, data|error} may
// arrive on EITHER socket, so both feed one shared route() + pending map.

// Direct HTTPS to the backend on the Atlas server (cloudflared terminates TLS,
// host caddy routes to the WS services); set localStorage 'atlas.backend' to
// override — e.g. the old Oracle door {"inbox":"wss://150-230-179-46.sslip.io/inbox",
// "outbox":"wss://150-230-179-46.sslip.io/outbox"} or an SSH-tunnel fallback
// ({"inbox":"ws://localhost:8100","outbox":"ws://localhost:8101"}).
const DEFAULTS = {
  inbox: 'wss://sync.myatlasapp.net/inbox',
  outbox: 'wss://sync.myatlasapp.net/outbox',
}
const PLUGINS = new Set(['calendar', 'canvas', 'course', 'email', 'finance', 'graph', 'gym', 'ladder', 'sleep', 'work'])
const NEVER_PUSH = new Set(['atlas.auth.v1', 'atlas.devMode', 'atlas.backend'])
const REQUEST_TIMEOUT = 30_000
const PUSH_DEBOUNCE = 400
// How long connect() waits for the outbox hello before degrading gracefully:
// a dead outbox must delay boot briefly, never hang it. Kept well under
// main.js's 6s withTimeout so the boot deadline still covers the sum.
const OUTBOX_HELLO_TIMEOUT = 3000
const BACKOFF_MIN = 1000
const BACKOFF_MAX = 15_000

let token = null
let currentStatus = 'disconnected'
const sockets = { inbox: null, outbox: null }
const want = { inbox: false, outbox: false }
const backoffs = { inbox: BACKOFF_MIN, outbox: BACKOFF_MIN }
const pending = new Map()       // reqId → {resolve, reject, timer}
const offlinePushes = new Map() // storage key → latest raw value, flushed on reconnect
const debounces = new Map()     // storage key → {timer, raw} pending debounced push
const updateCbs = []
const statusCbs = []
let helloWaiters = []           // connect() resolvers awaiting the inbox hello ack
let outboxHelloWaiters = []     // connect() resolvers awaiting the outbox hello ack
let outboxReady = false         // outbox socket has been hello-acked (results can reach us)

// Endpoints are read lazily at (re)connect so 'atlas.backend' can change at runtime.
function endpoints() {
  try {
    const o = JSON.parse(localStorage.getItem('atlas.backend'))
    return { inbox: o.inbox || DEFAULTS.inbox, outbox: o.outbox || DEFAULTS.outbox }
  } catch { return { ...DEFAULTS } }
}

function setStatus(s) {
  if (s === currentStatus) return
  currentStatus = s
  for (const cb of statusCbs) { try { cb(s) } catch { /* listener error is not ours */ } }
}

function sendHello(ws) {
  try { ws.send(JSON.stringify({ type: 'hello', sessionId: sync.sessionId, token })) } catch { /* close handler reconnects */ }
}

// Shared by both sockets: hello acks, sync.update pushes, request results.
function route(ev, which) {
  let msg
  try { msg = JSON.parse(ev.data) } catch { return }
  if (msg.type === 'hello') {
    // A successful hello on EITHER socket flushes the offline queue: pushes
    // re-queued while the outbox was down (results lost) must not wait for the
    // inbox to bounce. sendPush re-queues safely if the inbox isn't online.
    // Status must flip to 'online' BEFORE the inbox-side flush, or sendPush
    // would just re-queue every value.
    if (which !== 'inbox') {
      outboxReady = !!msg.ok
      if (msg.ok) flushPushes()
      const waiters = outboxHelloWaiters
      outboxHelloWaiters = []
      for (const resolve of waiters) resolve()
      return
    }
    if (msg.ok) { setStatus('online'); flushPushes() }
    const waiters = helloWaiters
    helloWaiters = []
    for (const resolve of waiters) resolve({ ok: !!msg.ok, userId: msg.userId, email: msg.email, error: msg.error })
    return
  }
  if (msg.type === 'sync.update') {
    for (const cb of updateCbs) { try { cb(msg.key, msg.value) } catch { /* listener error is not ours */ } }
    return
  }
  const p = msg.reqId && pending.get(msg.reqId)
  if (!p) return
  pending.delete(msg.reqId)
  clearTimeout(p.timer)
  if (msg.ok) p.resolve(msg.data)
  else p.reject(new Error(msg.error || 'sync: request failed'))
}

function open(which) {
  if (!want[which] || sockets[which]) return
  if (which === 'inbox') setStatus('connecting')
  let ws
  try { ws = new WebSocket(endpoints()[which]) } catch { scheduleReopen(which); return }
  sockets[which] = ws
  ws.onopen = () => { backoffs[which] = BACKOFF_MIN; sendHello(ws) }
  ws.onmessage = ev => route(ev, which)
  ws.onerror = () => { try { ws.close() } catch { /* already closed */ } }
  ws.onclose = () => {
    if (sockets[which] !== ws) return
    sockets[which] = null
    if (which === 'inbox') setStatus('disconnected')
    else outboxReady = false
    scheduleReopen(which)
  }
}

// Exponential backoff: 1s doubling to 15s, retrying forever.
function scheduleReopen(which) {
  if (!want[which]) return
  const delay = backoffs[which]
  backoffs[which] = Math.min(backoffs[which] * 2, BACKOFF_MAX)
  setTimeout(() => open(which), delay)
}

// key → {code, payload}, or null to skip. Plugin stores 'atlas.<p>.v1' get their
// own '<p>.save'; every other atlas.* key rides 'page.save' keyed by storageKey.
// Wire contract (mirrored by profile.js): ONLY the known plugin keys and the
// 'atlas.page.*' board keys are structured JSON on the wire — every other
// atlas.* key travels as its raw string, which profile stores verbatim as a
// flag. Parsing anything else here would hand profile an object it would
// otherwise String() into '[object Object]'.
function encodePush(key, raw) {
  const m = /^atlas\.(\w+)\.v1$/.exec(key)
  if (m && PLUGINS.has(m[1])) {
    try { return { code: m[1] + '.save', payload: { value: JSON.parse(raw) } } } catch { return null }
  }
  let value = raw
  if (/^atlas\.page(\.\w+)?\.v1$/.test(key)) {
    try { value = JSON.parse(raw) } catch { return null }
  }
  return { code: 'page.save', payload: { storageKey: key, value } }
}

function sendPush(key, raw) {
  const enc = encodePush(key, raw)
  if (!enc) return // unparseable data store — don't sync garbage
  const ws = sockets.inbox
  if (currentStatus !== 'online' || !ws || ws.readyState !== WebSocket.OPEN) {
    offlinePushes.set(key, raw)
    return
  }
  sync.request(enc.code, enc.payload).catch(() => {
    // Re-queue for the next reconnect, unless a newer value is already queued.
    if (!offlinePushes.has(key)) offlinePushes.set(key, raw)
  })
}

function flushPushes() {
  const queued = [...offlinePushes]
  offlinePushes.clear()
  for (const [key, raw] of queued) sendPush(key, raw)
}

// Best-effort flush on unload: a reload must not strand debounced pushes
// (e.g. renderer.js importData rewrites every key then reloads). Send them
// immediately — data buffered on an open WebSocket is flushed by the browser
// during the graceful close, so this usually lands even mid-navigation.
if (typeof addEventListener === 'function') {
  addEventListener('beforeunload', () => {
    const pendingPushes = [...debounces]
    debounces.clear()
    for (const [key, { timer, raw }] of pendingPushes) {
      clearTimeout(timer)
      sendPush(key, raw)
    }
  })
}

export const sync = {
  sessionId: crypto.randomUUID(),

  // Opens the inbox (and, once a token exists, the outbox) and says hello.
  // Safe to call again after login: re-hellos with the new token.
  // Resolves with the INBOX hello result, but also waits (bounded) for the
  // outbox hello: every non-auth result is delivered via the outbox, so
  // resolving before the outbox is registered would let the first pull.all
  // race a not-yet-registered socket and get silently dropped server-side.
  connect({ token: newToken } = {}) {
    if (newToken) token = newToken
    want.inbox = true
    if (token) want.outbox = true
    const inboxAck = new Promise(resolve => {
      helloWaiters.push(resolve)
      const inb = sockets.inbox
      if (inb && inb.readyState === WebSocket.OPEN) sendHello(inb)
      else open('inbox') // no-op if a connection attempt is already in flight
    })
    let outboxAck = Promise.resolve()
    if (want.outbox) {
      const out = sockets.outbox
      if (out && out.readyState === WebSocket.OPEN && outboxReady) {
        // Already hello-acked; the outbox ignores re-hellos on a registered
        // socket, so waiting for another ack here would only hit the timeout.
      } else {
        outboxAck = new Promise(resolve => {
          outboxHelloWaiters.push(resolve)
          if (out && out.readyState === WebSocket.OPEN) sendHello(out)
          else open('outbox')
          // Dead/slow outbox degrades gracefully: proceed after the deadline
          // (requests then reject via their own timeout instead of hanging).
          setTimeout(resolve, OUTBOX_HELLO_TIMEOUT)
        })
      }
    }
    // An inbox rejection (bad token) means the outbox will refuse us too — no
    // point waiting out its timer.
    return inboxAck.then(res => (res && res.ok ? outboxAck.then(() => res) : res))
  },

  request(code, payload) {
    return new Promise((resolve, reject) => {
      const ws = sockets.inbox
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error('sync: not connected'))
      const reqId = crypto.randomUUID()
      const timer = setTimeout(() => {
        pending.delete(reqId)
        reject(new Error('sync: timed out waiting for ' + code))
      }, REQUEST_TIMEOUT)
      pending.set(reqId, {
        resolve: data => {
          // Login/refresh responses carry the token every later hello needs.
          if (code.startsWith('auth.') && data && typeof data.token === 'string') token = data.token
          resolve(data)
        },
        reject,
        timer,
      })
      ws.send(JSON.stringify({ reqId, code, payload }))
    })
  },

  // Debounced 400ms per key; offline values queue (latest wins) and flush on reconnect.
  pushKey(key, rawValue) {
    if (typeof key !== 'string' || !key.startsWith('atlas.') || NEVER_PUSH.has(key)) return
    const prev = debounces.get(key)
    if (prev) clearTimeout(prev.timer)
    // The raw value rides along in the map so the beforeunload flush can send
    // pending pushes whose debounce timer hasn't fired yet.
    debounces.set(key, {
      raw: rawValue,
      timer: setTimeout(() => {
        debounces.delete(key)
        sendPush(key, rawValue)
      }, PUSH_DEBOUNCE),
    })
  },

  pullAll() { return sync.request('sync.pull.all').then(d => d.states) },
  importAll(dataMap) { return sync.request('sync.import', { data: dataMap }) },

  onUpdate(cb) { updateCbs.push(cb) },
  onStatus(cb) { statusCbs.push(cb) },
  get status() { return currentStatus },
}
