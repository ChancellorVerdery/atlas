// src/sync.js — Atlas sync client (vanilla ES module, browser, no deps).
// Inbox WS: we send {reqId, code, payload}. Outbox WS: server pushes
// {type:'sync.update', key, value}. Results {reqId, ok, data|error} may
// arrive on EITHER socket, so both feed one shared route() + pending map.

// Direct HTTPS to the backend on the Atlas server (cloudflared terminates TLS,
// host caddy routes to the WS services); set localStorage 'atlas.backend' to
// override. The useful override is an SSH-tunnel fallback for when the public
// door is down — {"inbox":"ws://localhost:8100","outbox":"ws://localhost:8101"},
// matching the loopback ports atlas-backend/docker-compose.yml publishes.
// A stale override silently sends every device to a dead endpoint, so clear it
// rather than leaving one set.
const DEFAULTS = {
  inbox: 'wss://sync.myatlasapp.net/inbox',
  outbox: 'wss://sync.myatlasapp.net/outbox',
}
const PLUGINS = new Set(['calendar', 'canvas', 'course', 'email', 'gym', 'ladder', 'sleep', 'work'])
// atlas.ai.v1 holds API keys — device-local only, same as auth/devMode/backend.
const NEVER_PUSH = new Set(['atlas.auth.v1', 'atlas.devMode', 'atlas.backend', 'atlas.ai.v1'])
const REQUEST_TIMEOUT = 30_000
const PUSH_DEBOUNCE = 400
// A failed push (rate-limited, timed out) used to wait for the NEXT reconnect
// to retry — on a healthy socket that's never, so the value sat queued for
// days while the server kept serving the stale copy it should have replaced.
// Retry on a timer instead; 15s clears the inbox's 10s rate-limit window.
const PUSH_RETRY = 15_000
// Gap between queued pushes when the queue flushes. The inbox allows 60
// messages per connection per 10s, and a boot-time flush fired as one burst
// rode on top of boot traffic — the tail got rejected 'rate limited' and
// those keys starved (deletes that never reached the server).
const FLUSH_SPACING = 250
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
// Keys with a flushPushes() timer already scheduled. Both sockets' hello acks
// call flushPushes() independently (inbox and outbox each ack on every
// connect), so a single ordinary reconnect fires it twice in quick
// succession; a flapping connection fires it many times. Without this guard
// every queued key got a duplicate setTimeout per overlapping call, so the
// same key could go out as two (or more) concurrent sync.request()s — wasted
// inbox rate-limit budget for no reason, since flushPushes already re-reads
// the queue at fire time and a second scheduled run for the same key can
// never send anything the first run wouldn't have.
const flushScheduled = new Set()
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

// 'online' has to mean BOTH sockets are usable, not just the inbox. A request
// goes OUT on the inbox but its result comes BACK on the outbox, and the server
// drops a reply whose outbox session isn't registered yet — so anything fired
// on the inbox ack alone (a boot-time refreshGoogleStatus, a queued push) was
// sent into a void and died on its own timeout. The two sockets hello-ack
// independently, so whichever lands second is the moment we're really online.
function markOnline() {
  if (sockets.inbox?.readyState !== WebSocket.OPEN) return
  if (want.outbox && !outboxReady) return
  setStatus('online')
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
      if (msg.ok) { markOnline(); flushPushes() }
      const waiters = outboxHelloWaiters
      outboxHelloWaiters = []
      for (const resolve of waiters) resolve()
      return
    }
    if (msg.ok) { markOnline(); flushPushes() }
    const waiters = helloWaiters
    helloWaiters = []
    for (const resolve of waiters) resolve({ ok: !!msg.ok, userId: msg.userId, email: msg.email, error: msg.error })
    return
  }
  if (msg.type === 'sync.update') {
    // Record BEFORE the listeners run: they write the value into localStorage,
    // and the write hook's push must base itself on the revision that value
    // actually came from, not the one this device had a moment ago.
    noteRev(msg.key, msg.rev)
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
    // Losing the outbox means results can no longer reach us, so we aren't
    // 'online' any more — and saying so is what re-arms the status listeners
    // for when it comes back.
    else { outboxReady = false; if (currentStatus === 'online') setStatus('connecting') }
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
  return { code: 'page.save', payload: { storageKey: key, value, baseRev: revs.get(key) ?? 0 } }
}

// The queue OUTLIVES the process. It used to be a bare in-memory Map, which
// meant an edit made while the socket was down — or one still inside its 400ms
// debounce when the app was closed — simply evaporated, and the next launch
// applied the server's older copy straight over it. That is the "I deleted a
// widget and after relaunch it was back" shape: nothing errored, the write just
// never left the device, and then the stale server copy won.
//
// NOT an 'atlas.' key on purpose: pushKey ignores anything without that prefix,
// so persisting the queue can never enqueue itself, and the backup/export
// filters skip it too (same trick as atlasLastUser / atlasNotesSync).
const PENDING_KEY = 'atlasPendingPushes'

// Per-key revision, the client half of profile.js's compare-and-swap. Every
// push carries the revision this device believed it was editing; the server
// takes the write only if that is still the stored one. Without it, sync was
// "last ARRIVAL wins", and an arrival can be arbitrarily old — a queue that sat
// on a phone for a week still overwrote everything, then fanned the stale copy
// out to every device. That is the shape behind "the page refreshed and my new
// equation sheet was gone" and "appearance changes don't save".
//
// Not an 'atlas.' key, same as PENDING_KEY: pushKey ignores anything without
// that prefix, so the bookkeeping can never sync itself, and the backup/export
// filters skip it.
const REV_KEY = 'atlasRevs'
const revs = new Map()

function loadRevs() {
  try {
    const o = JSON.parse(localStorage.getItem(REV_KEY))
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (Number.isInteger(v)) revs.set(k, v)
  } catch { /* corrupt — start from 0, which is what a first-ever push sends */ }
}
function persistRevs() {
  try { localStorage.setItem(REV_KEY, JSON.stringify(Object.fromEntries(revs))) }
  catch { /* quota or private mode: the in-memory map still works this session */ }
}
// Only ever moves forward. A late reply carrying an older rev must not walk the
// map backwards, or the next push would base itself on a revision that has been
// superseded and get refused forever.
function noteRev(key, rev) {
  if (!Number.isInteger(rev) || rev <= (revs.get(key) ?? -1)) return
  revs.set(key, rev)
  persistRevs()
}
if (typeof localStorage !== 'undefined') loadRevs()

function loadPending() {
  try {
    const o = JSON.parse(localStorage.getItem(PENDING_KEY))
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (typeof v === 'string') offlinePushes.set(k, v)
  } catch { /* corrupt queue — start empty rather than refuse to boot */ }
}
function persistPending() {
  try {
    if (!offlinePushes.size) localStorage.removeItem(PENDING_KEY)
    else localStorage.setItem(PENDING_KEY, JSON.stringify(Object.fromEntries(offlinePushes)))
  } catch { /* quota or private mode: the in-memory queue still works this session */ }
}
if (typeof localStorage !== 'undefined') loadPending()

// Anything still queued when this session STARTED holds a local value the
// server has not seen. It stays protected for the whole session, not just
// until it drains: the flush happens on the hello ack and the pull is a
// separate round trip, so by the time sync.pull.all is answered the queue is
// usually already empty — and the guard would be looking at nothing exactly
// when it was needed. Once the flush lands, the server's copy matches ours
// anyway, so keeping the key skipped costs nothing.
const bootPending = new Set(offlinePushes.keys())

const queuePush = (key, raw) => { offlinePushes.set(key, raw); persistPending() }
const unqueuePush = (key, raw) => {
  // Only drop it if a NEWER value hasn't replaced it while this one was in
  // flight, or the newer edit would never be sent.
  if (offlinePushes.get(key) === raw) { offlinePushes.delete(key); persistPending() }
}

function sendPush(key, raw) {
  const enc = encodePush(key, raw)
  if (!enc) return // unparseable data store — don't sync garbage
  // Recorded BEFORE the attempt, cleared only once the server has acked. A
  // value that exists only in an in-flight request is lost if the process dies
  // mid-request — which on a phone is just "the user closed the app".
  queuePush(key, raw)
  const ws = sockets.inbox
  if (currentStatus !== 'online' || !ws || ws.readyState !== WebSocket.OPEN) return
  sync.request(enc.code, enc.payload)
    .then((data) => {
      unqueuePush(key, raw)
      noteRev(key, data?.rev)
      // Refused: the store moved on since the revision this device was editing,
      // so what we just tried to send is the OLD copy. Adopt the server's
      // instead of retrying — retrying is precisely how a week-old queue used
      // to win. The value is handed to the same listeners a live broadcast
      // goes to, so the page updates rather than silently disagreeing with the
      // store it will read on the next render.
      if (data?.stale && data.value !== undefined) {
        for (const cb of updateCbs) { try { cb(key, data.value) } catch { /* listener error is not ours */ } }
      }
    })
    .catch(() => scheduleFlush()) // stays queued — retry on the timer, not the next reconnect
}

let flushTimer = null
function scheduleFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => { flushTimer = null; flushPushes() }, PUSH_RETRY)
}

function flushPushes() {
  // Paced, not a burst. Each send re-reads the queue at fire time: a newer
  // value replacing the snapshot's mid-flush must win, and re-sending the
  // snapshot's raw would silently re-queue the OLD value over it.
  // Skip a key that's already got a run scheduled: this fires once per hello
  // ack, and inbox + outbox both ack on every connect, so an unguarded loop
  // would double-schedule (or worse, on a flapping connection) every queued
  // key. See flushScheduled above.
  let i = 0
  for (const key of [...offlinePushes.keys()]) {
    if (flushScheduled.has(key)) continue
    flushScheduled.add(key)
    setTimeout(() => {
      flushScheduled.delete(key)
      const raw = offlinePushes.get(key)
      if (raw != null) sendPush(key, raw)
    }, FLUSH_SPACING * i++)
  }
}

// Keys whose local value has not been confirmed by the server yet. main.js
// refuses to apply the server's copy over these on boot: the pull would
// otherwise undo the very edit that is still waiting to be sent.
const pendingKeys = () => new Set([...bootPending, ...offlinePushes.keys(), ...debounces.keys()])

// Narrower live-update guard: does this key hold a local write the server has
// not acked (debounced or queued)? Deliberately excludes bootPending — that
// set protects the boot-time pull and never drains, and a broadcast landing
// hours later is real news from another device, not the boot race.
const hasPendingWrite = (key) => offlinePushes.has(key) || debounces.has(key)

// Flush debounced writes when the page goes away. beforeunload alone is not
// enough: WKWebView does not reliably fire it when the app is terminated, and
// iOS Safari often skips it too — pagehide/visibilitychange are the ones that
// actually run. sendPush persists first, so even a hard kill keeps the value.
if (typeof addEventListener === 'function') {
  const flushDebounced = () => {
    const pendingPushes = [...debounces]
    debounces.clear()
    for (const [key, { timer, raw }] of pendingPushes) {
      clearTimeout(timer)
      sendPush(key, raw)
    }
  }
  addEventListener('beforeunload', flushDebounced)
  addEventListener('pagehide', flushDebounced)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => { if (document.hidden) flushDebounced() })
  }
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

  pullAll() {
    return sync.request('sync.pull.all').then(d => {
      // Absent on a server older than the compare-and-swap: leave the map alone
      // and every push keeps sending baseRev 0, which that server ignores.
      if (d?.revs) for (const [k, v] of Object.entries(d.revs)) noteRev(k, v)
      return d.states
    })
  },
  importAll(dataMap) { return sync.request('sync.import', { data: dataMap }) },

  onUpdate(cb) { updateCbs.push(cb) },
  onStatus(cb) { statusCbs.push(cb) },
  pendingKeys,
  hasPendingWrite,
  revFor: (key) => revs.get(key) ?? 0,
  get status() { return currentStatus },
}
