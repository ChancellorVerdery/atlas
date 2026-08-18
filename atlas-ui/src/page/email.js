// Email plugin — data layer. Real Gmail REST API, but every call is PROXIED
// through the Atlas backend's google service: the OAuth client secret and the
// tokens live server-side and never reach the browser. This module only holds
// Atlas-side UI state (pins, nav visibility, split position) plus a cached
// connected/address flag refreshed from the server.
// Pins are Atlas-local by design; "important" maps to the Gmail star.

import { sync } from '../sync.js'
import { isNative } from '../platform.js'

const KEY = 'atlas.email.v1'

export function loadEmail() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (!Array.isArray(s.pinned)) s.pinned = []
  if (typeof s.splitPct !== 'number') s.splitPct = 42
  if (!Array.isArray(s.accounts)) s.accounts = [] // cached connected addresses (primary first)
  return s
}
export function saveEmail(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

// Connection is server-side per user; `connected`/`address`/`accounts` are a
// local cache (refreshed by refreshGoogleStatus) so the many synchronous
// isConnected() guards stay synchronous. The email mapper does not persist these.
export const isConnected = (s = loadEmail()) => !!s.connected
export const connectedAccounts = (s = loadEmail()) => s.accounts || []

// The account a bare API call uses. 'all' and unknown addresses fall back to
// the server's primary (address omitted from the wire). Set by the UI's
// account switcher; module-level so every api() call sees it without plumbing.
let activeAccount = null
export const setActiveAccount = (addr) => { activeAccount = addr && addr !== 'all' ? addr : null }
export const getActiveAccount = () => activeAccount

// Pull the authoritative connection status from the backend and update the
// local cache. Call at boot / when a Google-backed page opens; returns the
// server view (or null when offline, leaving the cache untouched).
export async function refreshGoogleStatus() {
  try {
    const d = await sync.request('google.auth.status', {})
    const s = loadEmail()
    s.connected = !!d.connected
    s.accounts = Array.isArray(d.accounts) ? d.accounts : (d.address ? [d.address] : [])
    if (d.address) s.address = d.address
    else delete s.address
    if (activeAccount && !s.accounts.includes(activeAccount)) activeAccount = null // account gone → primary
    saveEmail(s)
    return d
  } catch { return null }
}

// ---- OAuth (Google Identity Services, code flow → server-side exchange) ----

let gisLoading
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve()
  gisLoading ||= new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = 'https://accounts.google.com/gsi/client'
    el.onload = resolve
    el.onerror = () => reject(new Error('Could not load Google sign-in.'))
    document.head.appendChild(el)
  })
  return gisLoading
}

// GIS runs with only the (non-secret) client id to obtain an auth CODE; the
// backend exchanges it for tokens using the secret and stores them. One
// connection covers Gmail + Calendar (scopes come from the server).
export async function connectGmail() {
  // Native shell: GIS popups force a fresh Google login (no cookies in the
  // WKWebView). Instead open the auth URL in the SYSTEM browser via a loopback
  // redirect, so the user reuses their real Google session (no re-login/2FA).
  if (isNative()) return connectGmailNative()
  const cfg = await sync.request('google.config', {})
  if (!cfg.configured) throw new Error('Google isn’t configured on the Atlas server yet.')
  await loadGis()
  const code = await new Promise((resolve, reject) => {
    window.google.accounts.oauth2.initCodeClient({
      client_id: cfg.clientId,
      scope: cfg.scopes,
      ux_mode: 'popup',
      callback: (r) => (r?.code ? resolve(r.code) : reject(new Error(r?.error_description || r?.error || 'Sign-in was cancelled.'))),
      error_callback: (e) => reject(new Error(e?.message || 'Sign-in was cancelled.')),
    }).requestCode()
  })
  const d = await sync.request('google.auth.exchange', { code })
  const s = loadEmail()
  s.connected = true
  if (d.address) s.address = d.address
  s.accounts = Array.isArray(d.accounts) ? d.accounts : (d.address ? [d.address] : s.accounts)
  saveEmail(s)
  return d.address
}

// Native loopback OAuth. The auth request and the code→token exchange MUST use
// the same redirect_uri; the native shell intercepts a navigation to it and
// hands us (provider, code, state) via window.__atlasOAuthCallback. We return a
// promise that resolves only after the exchange + status refresh, so the caller's
// existing `connectGmail().then(rerenderApp)` fires at the right moment.
// ponytail: if the user abandons the system-browser prompt the callback never
// fires and this promise never settles — no timeout; the connect screen just
// stays until they retry. Add an AbortSignal/timeout if that proves confusing.
// `localhost`, not `127.0.0.1`: the Cloud console rejects a raw-IP redirect that
// carries a path, while localhost URIs are exempt from BOTH the https-only rule
// and the no-raw-IP rule, so they may keep the path. LocalServer binds IPv4 only
// but matches on path alone, so the callback still lands (localhost resolves to
// ::1 and 127.0.0.1; browsers fall back to the one that answers).
const NATIVE_REDIRECT = 'http://localhost:5180/oauth/google/callback'

// The config is fetched AHEAD of the click (primeGoogleConfig, called when a
// page showing a Connect button renders). On iOS an `await` between the tap and
// window.open loses the user-gesture and the system browser silently never
// opens — so the click path must reach window.open with zero awaits.
let googleCfg = null
export async function primeGoogleConfig() {
  try { googleCfg = await sync.request('google.config', {}) } catch { /* offline: the click re-fetches */ }
  return googleCfg
}

const googleAuthURL = (cfg, state) =>
  'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: NATIVE_REDIRECT,
    response_type: 'code',
    scope: Array.isArray(cfg.scopes) ? cfg.scopes.join(' ') : cfg.scopes,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  })

function connectGmailNative() {
  const state = crypto.randomUUID?.() || Math.random().toString(36).slice(2)
  const settled = new Promise((resolve, reject) => {
    window.__atlasOAuthCallback = async (provider, code, cbState) => {
      if (provider !== 'google') return
      try {
        if (cbState !== state) throw new Error('Sign-in could not be verified. Please try again.')
        const d = await sync.request('google.auth.exchange', { code, redirect_uri: NATIVE_REDIRECT })
        await refreshGoogleStatus() // authoritative cache update (connected/address/accounts)
        resolve(d.address)
      } catch (e) { reject(e) }
    }
  })
  // The native shell routes accounts.google.com to the system browser.
  if (googleCfg?.configured) {
    window.open(googleAuthURL(googleCfg, state), '_blank') // same tick as the tap
    return settled
  }
  // Not primed (offline at render, or a page that doesn't prime): fetch then
  // open. Works on macOS; on iOS this is the gesture-losing path, so priming
  // is what makes the button reliable there.
  return primeGoogleConfig().then((cfg) => {
    if (!cfg?.configured) throw new Error('Google isn’t configured on the Atlas server yet.')
    window.open(googleAuthURL(cfg, state), '_blank')
    return settled
  })
}

// Disconnect one account (by address) or, with no argument, all of them.
export function disconnectGmail(address) {
  // Best-effort server revoke + delete; update the local cache immediately so
  // the UI reflects the change without waiting on the round trip.
  sync.request('google.auth.disconnect', address ? { account: address } : {}).catch(() => {})
  const s = loadEmail()
  if (address) {
    s.accounts = (s.accounts || []).filter((a) => a !== address)
    if (s.address === address) s.address = s.accounts[0] || undefined
    if (activeAccount === address) activeAccount = null
  } else {
    s.accounts = []
    delete s.address
  }
  if (!s.accounts.length) delete s.connected
  saveEmail(s)
  return s.accounts
}

// ---- Gmail REST ----------------------------------------------------------

export class AuthError extends Error {}

// Shared by every Google-backed plugin (gmail + calendar endpoints). The
// backend attaches the token, refreshes it as needed, calls Google, and
// returns the JSON — so the access token never touches the browser.
// ponytail: each call is one WS round trip through the google service; the
// N+1 thread hydrations run in parallel but add a hop. Batch server-side if
// mail feels slow.
export async function authedFetch(url, { method = 'GET', body } = {}, account) {
  try {
    // account: an explicit address routes to that mailbox; omitted/'all' falls
    // back to the module's active account (and the server's primary for null).
    const acct = account && account !== 'all' ? account : activeAccount
    return await sync.request('google.api', { method, url, body, account: acct || undefined })
  } catch (e) {
    const m = String((e && e.message) || '')
    // The google service tags auth/scope failures so they surface the reconnect
    // UI instead of a generic error.
    if (m.startsWith('auth:') || m.startsWith('scope:')) throw new AuthError(m.replace(/^\w+:\s*/, ''))
    throw e
  }
}

const api = (path, opts, account) => authedFetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, opts, account)

const META = 'format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date'

// Merge per-account result pages into one date-sorted list. 'all' view can't
// carry a single pageToken (each account paginates independently), so it shows
// the first page from every account and offers no "load more".
// ponytail: first-page-per-account cap in the All view; wire per-account tokens
// if the merged list needs deeper paging.
const byDateDesc = (a, b) => b.date - a.date

export async function listThreads({ labelIds, q, pageToken, account } = {}) {
  if (account === 'all') {
    const accts = connectedAccounts()
    const pages = await Promise.all(accts.map((a) => listThreads({ labelIds, q, account: a }).catch(() => ({ threads: [] }))))
    return { threads: pages.flatMap((p) => p.threads).sort(byDateDesc), nextPageToken: null }
  }
  const p = new URLSearchParams({ maxResults: '25' })
  if (labelIds) p.set('labelIds', labelIds)
  if (q) p.set('q', q)
  if (pageToken) p.set('pageToken', pageToken)
  const res = await api(`threads?${p}`, undefined, account)
  // threads.list only returns ids — hydrate headers per thread for the list.
  const threads = await Promise.all((res.threads || []).map((t) => api(`threads/${t.id}?${META}`, undefined, account)))
  return { threads: threads.map((t) => ({ ...threadSummary(t), _account: account || null })), nextPageToken: res.nextPageToken || null }
}

const hdr = (m, name) => m?.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
const fromName = (v) => {
  const m = v.match(/^\s*"?([^"<]+?)"?\s*</)
  return (m ? m[1].trim() : v.replace(/<[^>]*>/g, '').trim()) || v
}

export function threadSummary(t) {
  const msgs = t.messages || []
  const last = msgs[msgs.length - 1]
  const labels = new Set(msgs.flatMap((m) => m.labelIds || []))
  return {
    id: t.id,
    subject: hdr(msgs[0], 'Subject') || '(no subject)',
    from: fromName(hdr(last, 'From')),
    date: Number(last?.internalDate) || 0,
    snippet: last?.snippet || '',
    count: msgs.length,
    unread: labels.has('UNREAD'),
    starred: labels.has('STARRED'),
    inInbox: labels.has('INBOX'),
    inSpam: labels.has('SPAM'),
    inTrash: labels.has('TRASH'),
    isDraft: labels.has('DRAFT'),
  }
}

export const getThreadSummary = (id, account) =>
  api(`threads/${id}?${META}`, undefined, account).then((t) => ({ ...threadSummary(t), _account: account || null }))

export async function getThread(id, account) {
  const t = await api(`threads/${id}?format=full`, undefined, account)
  return { id: t.id, summary: { ...threadSummary(t), _account: account || null }, messages: (t.messages || []).map(parseMessage) }
}

export function parseMessage(m) {
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds || [],
    from: hdr(m, 'From'),
    to: hdr(m, 'To'),
    cc: hdr(m, 'Cc'),
    subject: hdr(m, 'Subject'),
    messageId: hdr(m, 'Message-ID') || hdr(m, 'Message-Id'),
    references: hdr(m, 'References'),
    date: Number(m.internalDate) || 0,
    ...extractBody(m.payload),
  }
}

function decodeB64url(data) {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}
function collectParts(part, out) {
  if (!part) return
  if (part.parts) part.parts.forEach((p) => collectParts(p, out))
  else if (part.body?.data) out.push(part)
}
// ponytail: cid: inline images are not fetched (needs attachments.get) — they
// show as broken images; remote images load normally.
export function extractBody(payload) {
  const flat = []
  collectParts(payload, flat)
  const find = (mt) => flat.find((p) => (p.mimeType || '').toLowerCase().startsWith(mt))
  const h = find('text/html')
  const t = find('text/plain')
  return { html: h ? decodeB64url(h.body.data) : '', text: t ? decodeB64url(t.body.data) : '' }
}

// ---- actions (two-way: these modify the real mailbox) ---------------------

// Every mutation carries `account` so it lands in the right mailbox — critical
// in the merged "all" view, where adjacent rows belong to different accounts.
export const modifyThread = (id, addLabelIds = [], removeLabelIds = [], account) =>
  api(`threads/${id}/modify`, { method: 'POST', body: { addLabelIds, removeLabelIds } }, account)
export const archiveThread = (id, account) => modifyThread(id, [], ['INBOX'], account)
export const unarchiveThread = (id, account) => modifyThread(id, ['INBOX'], [], account)
export const spamThread = (id, account) => modifyThread(id, ['SPAM'], ['INBOX'], account)
export const unspamThread = (id, account) => modifyThread(id, ['INBOX'], ['SPAM'], account)
export const setStarred = (id, on, account) => modifyThread(id, on ? ['STARRED'] : [], on ? [] : ['STARRED'], account)
export const markRead = (id, account) => modifyThread(id, [], ['UNREAD'], account)
export const trashThread = (id, account) => api(`threads/${id}/trash`, { method: 'POST' }, account)
export const untrashThread = (id, account) => api(`threads/${id}/untrash`, { method: 'POST' }, account)
export const deleteThreadForever = (id, account) => api(`threads/${id}`, { method: 'DELETE' }, account)

export const listLabels = (account) => api('labels', undefined, account).then((r) => r.labels || [])
// Move a thread into a folder = tag it with the label and drop it out of the inbox.
export const moveThread = (id, labelId, account) => modifyThread(id, [labelId], ['INBOX'], account)
export const createLabel = (name, account) =>
  api('labels', { method: 'POST', body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } }, account)
// Persistent server-side rule: future mail from `from` auto-files into the label
// (and skips the inbox). Needs the gmail.settings.basic scope — see google.js.
export const createFilter = (from, addLabelId, account) =>
  api('settings/filters', { method: 'POST', body: { criteria: { from }, action: { addLabelIds: [addLabelId], removeLabelIds: ['INBOX'] } } }, account)

// ---- drafts & send --------------------------------------------------------

export async function listDrafts(pageToken, account) {
  if (account === 'all') {
    const pages = await Promise.all(connectedAccounts().map((a) => listDrafts(null, a).catch(() => ({ threads: [] }))))
    return { threads: pages.flatMap((p) => p.threads).sort(byDateDesc), nextPageToken: null }
  }
  const p = new URLSearchParams({ maxResults: '25' })
  if (pageToken) p.set('pageToken', pageToken)
  const res = await api(`drafts?${p}`, undefined, account)
  const drafts = await Promise.all((res.drafts || []).map((d) => api(`drafts/${d.id}?${META}`, undefined, account)))
  return {
    threads: drafts.map((d) => ({ ...threadSummary({ id: d.message.threadId, messages: [d.message] }), draftId: d.id, isDraft: true, _account: account || null })),
    nextPageToken: res.nextPageToken || null,
  }
}
export const getDraft = (id, account) => api(`drafts/${id}?format=full`, undefined, account).then((d) => ({ id: d.id, message: parseMessage(d.message) }))
export const saveDraft = (draftId, raw, account) =>
  draftId ? api(`drafts/${draftId}`, { method: 'PUT', body: { message: { raw } } }, account)
          : api('drafts', { method: 'POST', body: { message: { raw } } }, account)
export const deleteDraft = (id, account) => api(`drafts/${id}`, { method: 'DELETE' }, account)
export const sendDraft = (id, account) => api('drafts/send', { method: 'POST', body: { id } }, account)
export const sendMessage = (raw, threadId, account) => api('messages/send', { method: 'POST', body: threadId ? { raw, threadId } : { raw } }, account)

// RFC 2822 message → base64url, HTML body. Compose is rich text, so the body
// is sent as text/html (every mail client renders it).
const b64 = (s) => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}
const b64url = (s) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const encHeader = (v) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${b64(v)}?=`)

export function buildMime({ to, cc, subject, html, inReplyTo, references }) {
  const lines = [`To: ${to}`]
  if (cc) lines.push(`Cc: ${cc}`)
  lines.push(`Subject: ${encHeader(subject || '')}`)
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`)
    lines.push(`References: ${[references, inReplyTo].filter(Boolean).join(' ')}`)
  }
  const body = b64(html).replace(/(.{76})/g, '$1\r\n')
  lines.push('MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', body)
  return b64url(lines.join('\r\n'))
}

// ---- pins (Atlas-local) ----------------------------------------------------

// Pins are Atlas-local. A thread id is only unique within its own mailbox, so
// each pin records its account too. Legacy pins were bare id strings — read
// them as belonging to the primary account.
const pinKey = (p) => (typeof p === 'string' ? p : `${p.account || ''} ${p.id}`)
export function togglePin(threadId, account) {
  const s = loadEmail()
  const key = `${account || ''} ${threadId}`
  const i = s.pinned.findIndex((p) => pinKey(p) === key || (typeof p === 'string' && p === threadId && !account))
  if (i >= 0) s.pinned.splice(i, 1)
  else s.pinned.unshift({ id: threadId, account: account || null })
  saveEmail(s)
  return i < 0
}
// [{id, account}] — legacy string entries are normalized to the primary account.
export function pinnedIds() {
  const s = loadEmail()
  const primary = s.accounts?.[0] || null
  return s.pinned.map((p) => (typeof p === 'string' ? { id: p, account: primary } : p))
}
export const isPinned = (threadId, account) => {
  const key = `${account || ''} ${threadId}`
  return loadEmail().pinned.some((p) => pinKey(p) === key || (typeof p === 'string' && p === threadId))
}
