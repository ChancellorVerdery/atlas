// Email plugin — the page. Widgetless: it owns the whole content area.
// Three panes: folder nav (collapsible), thread list, and the viewer, with a
// draggable split bar between list and viewer. All actions are two-way — they
// modify the real Gmail mailbox. Pinning is Atlas-local.

import {
  loadEmail, saveEmail, isConnected, connectGmail, AuthError,
  connectedAccounts, setActiveAccount,
  listThreads, listDrafts, getThread, getThreadSummary, listLabels,
  archiveThread, unarchiveThread, spamThread, unspamThread, setStarred,
  markRead, trashThread, untrashThread, deleteThreadForever,
  moveThread, createLabel, createFilter,
  getDraft, saveDraft, deleteDraft, sendDraft, sendMessage, buildMime,
  togglePin, pinnedIds, isPinned,
} from './email.js'
import { cachedValue, writeCache } from './datacache.js'

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const I = (d) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const ICON = {
  inbox: I('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 4h13a1 1 0 0 1 1 .8L22 12v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-7l2.5-7.2a1 1 0 0 1 1-.8z"/>'),
  pin: I('<path d="M12 17v5"/><path d="M9 3h6l-1 7 3 2v2H7v-2l3-2z"/>'),
  star: I('<path d="m12 3 2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.9 6.4 20l1.3-6.2L3 9.5l6.3-.7z"/>'),
  sent: I('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
  draft: I('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  archive: I('<rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>'),
  spam: I('<circle cx="12" cy="12" r="9"/><path d="M12 8v4"/><path d="M12 16h.01"/>'),
  trash: I('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/>'),
  label: I('<path d="M2 12V4h8l10 10-8 8z"/><circle cx="7" cy="9" r="1.5"/>'),
  panel: I('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/>'),
  refresh: I('<path d="M21 12a9 9 0 1 1-2.6-6.3"/><path d="M21 3v6h-6"/>'),
  mail: I('<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2.5 6.5 9.5 7 9.5-7"/>'),
}

const FOLDERS = [
  { id: 'INBOX', name: 'Inbox', icon: 'inbox', labelIds: 'INBOX' },
  { id: 'PINNED', name: 'Pinned', icon: 'pin', pinned: true },
  { id: 'STARRED', name: 'Important', icon: 'star', labelIds: 'STARRED' },
  { id: 'SENT', name: 'Sent', icon: 'sent', labelIds: 'SENT' },
  { id: 'DRAFT', name: 'Drafts', icon: 'draft', drafts: true },
  { id: 'ARCHIVE', name: 'Archive', icon: 'archive', q: '-in:inbox -in:spam -in:trash -in:sent -in:draft' },
  { id: 'SPAM', name: 'Spam', icon: 'spam', labelIds: 'SPAM' },
  { id: 'TRASH', name: 'Trash', icon: 'trash', labelIds: 'TRASH' },
]

const st = {
  folder: 'INBOX', account: 'all', threads: [], nextPageToken: null, loadingList: false,
  openId: null, open: null, loadingView: false,
  labels: {}, seq: 0, viewSeq: 0, // labels: the user labels of each account, by address
}

// The account a thread belongs to (merged "all" view mixes accounts per row).
const acctOf = (id) =>
  (st.open?.summary.id === id ? st.open.summary._account : null) ??
  st.threads.find((t) => t.id === id)?._account ?? null
let rootEl = null
let rerenderApp = null
let composeCtx = null

const q = (sel) => rootEl?.querySelector(sel)

// A label id is unique to the mailbox that owns it, so the merged view can't
// address one: shared folders are matched by name instead, which is what Gmail
// search does anyway.
const SHARED = 'shared:'
const sharedFolder = (name) => ({ id: SHARED + name, name, icon: 'label', q: `label:"${name.replace(/"/g, '')}"` })
const labelFolder = (l) => ({ id: l.id, name: l.name, icon: 'label', labelIds: l.id })

// What sits under one account in the nav. Gmail's system folders are the same
// in every mailbox; user labels are not, so "All inboxes" lists only the names
// every connected account has.
export function foldersFor(account, labels = {}, accts = []) {
  if (account !== 'all') return FOLDERS.concat((labels[account] || []).map(labelFolder))
  const sets = accts.map((a) => new Set((labels[a] || []).map((l) => l.name)))
  const common = sets.length ? [...sets[0]].filter((n) => sets.every((s) => s.has(n))).sort() : []
  return FOLDERS.concat(common.map(sharedFolder))
}

// Labels load after the first paint, so an id can outrun its list — keep
// serving it as a label rather than falling back to the inbox.
const folderDef = (fid) =>
  foldersFor(st.account, st.labels, connectedAccounts()).find((f) => f.id === fid) ||
  (fid.startsWith(SHARED) ? sharedFolder(fid.slice(SHARED.length)) : labelFolder({ id: fid, name: fid }))

// ---- entry -----------------------------------------------------------------

export function renderEmailPage(root, rerender) {
  rootEl = root
  rerenderApp = rerender
  st.seq++; st.viewSeq++
  st.openId = null; st.open = null
  const s = loadEmail()
  if (!isConnected(s)) { renderConnect(s); return }
  const accts = connectedAccounts(s)
  // 'all' only means something with several mailboxes; one account IS the view.
  if (accts.length === 1) st.account = accts[0]
  else if (st.account !== 'all' && !accts.includes(st.account)) st.account = 'all' // a removed account → back to all
  setActiveAccount(st.account)
  root.innerHTML = `
    <div class="mail">
      <div class="mail-top">
        <button type="button" class="mail-iconbtn" data-mail="toggle-nav" title="Show or hide folders" aria-label="Show or hide folders">${ICON.panel}</button>
        <span class="mail-top__folder" id="mail-folder-name">${esc(folderDef(st.folder).name)}</span>
        <button type="button" class="mail-iconbtn" data-mail="refresh" title="Refresh" aria-label="Refresh">${ICON.refresh}</button>
        <span class="mail-top__addr" title="${esc(st.account)}">${esc(st.account === 'all' ? 'All inboxes' : st.account)}</span>
        <button type="button" class="mail-btn mail-btn--primary" data-mail="compose">Compose</button>
      </div>
      <div class="mail-body${s.navHidden ? ' nav-hidden' : ''}">
        <aside class="mail-nav" id="mail-nav"></aside>
        <section class="mail-list" id="mail-list" style="flex-basis:${s.splitPct}%"></section>
        <div class="mail-split" id="mail-split" title="Drag to resize"></div>
        <section class="mail-view" id="mail-view"></section>
      </div>
    </div>`
  root.onclick = onClick
  root.onmousedown = (e) => { if (e.target.closest('#mail-split')) startSplit(e) }
  renderNav()
  renderView()
  loadFolder(st.folder)
  // Every account's labels, not just the active one: the nav shows them all,
  // and the shared list is an intersection. One failing mailbox must not blank
  // the others, so each is caught on its own.
  const missing = accts.filter((a) => !st.labels[a])
  if (missing.length) {
    Promise.all(missing.map((a) => listLabels(a)
      .then((ls) => { st.labels[a] = ls.filter((l) => l.type === 'user' && l.labelListVisibility !== 'labelHide') })
      .catch(() => { st.labels[a] = [] }))).then(renderNav)
  }
}

// The @-prefix of an address, for compact per-row badges ("chancellor").
const shortAddr = (a) => (a ? String(a).split('@')[0] : '')

function renderConnect(s) {
  const expired = !!s.address // was connected before; the token lapsed
  rootEl.innerHTML = `
    <div class="mail-connect">
      <div class="mail-connect__mark">${ICON.mail}</div>
      <h2 class="mail-connect__title">${expired ? 'Reconnect Gmail' : 'Connect your Gmail'}</h2>
      <p class="mail-connect__text">${expired
        ? `The session for <strong>${esc(s.address)}</strong> has expired. Sign in again to keep syncing.`
        : 'Sign in with Google to sync this page with your mailbox. One sign-in covers Gmail and Calendar; your credentials stay on the Atlas server.'}</p>
      <button type="button" class="mail-btn mail-btn--primary" data-mail="connect">${expired ? 'Reconnect' : 'Connect Gmail'}</button>
      <p class="mail-connect__err" id="mail-connect-err"></p>
    </div>`
  rootEl.onclick = (e) => {
    if (!e.target.closest('[data-mail="connect"]')) return
    connectGmail().then(() => rerenderApp()).catch((err) => {
      const el = document.getElementById('mail-connect-err')
      if (el) el.textContent = err.message
    })
  }
}

// ---- panes -----------------------------------------------------------------

// The nav IS the account switcher: each connected address is a heading with its
// own folders and labels beneath it, and "All inboxes" leads with what they
// share. One account keeps the plain folder list it always had.
export function navHTML(accts, account = st.account, folder = st.folder, labels = st.labels) {
  const item = (f, acct) => `
    <button type="button" class="mail-folder${account === acct && folder === f.id ? ' is-active' : ''}" data-mail-folder="${esc(f.id)}" data-mail-account="${esc(acct)}">
      ${ICON[f.icon] || ICON.label}<span>${esc(f.name)}</span>
    </button>`
  const rows = (acct) => {
    const list = foldersFor(acct, labels, accts)
    const i = list.findIndex((f) => f.icon === 'label') // labels always sort after the system folders
    const cell = (f) => item(f, acct)
    return i < 0 ? list.map(cell).join('')
      : list.slice(0, i).map(cell).join('') + `<p class="mail-nav__head">Labels</p>` + list.slice(i).map(cell).join('')
  }
  const group = (acct, name) => `
    <button type="button" class="mail-nav__acct${account === acct ? ' is-active' : ''}" data-mail-folder="INBOX" data-mail-account="${esc(acct)}" title="${esc(name)}">${esc(name)}</button>
    <div class="mail-nav__sub">${rows(acct)}</div>`
  return accts.length < 2
    ? rows(account)
    : group('all', 'All inboxes') + accts.map((a) => group(a, a)).join('')
}

function renderNav() {
  const el = q('#mail-nav')
  if (el) el.innerHTML = navHTML(connectedAccounts())
}

const decodeEnt = (s) => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value }
function fmtDate(ms) {
  if (!ms) return ''
  const d = new Date(ms), now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

function rowActs(t, pinned) {
  const a = [
    ['pin', pinned ? 'Unpin' : 'Pin', ICON.pin],
    ['star', t.starred ? 'Not important' : 'Flag as important', ICON.star],
  ]
  if (t.isDraft) a.push(['delete-draft', 'Discard draft', ICON.trash])
  else if (t.inTrash) a.push(['restore', 'Restore', ICON.archive], ['delete-forever', 'Delete forever', ICON.trash])
  else if (t.inSpam) a.push(['unspam', 'Not spam', ICON.inbox], ['trash', 'Delete', ICON.trash])
  else a.push([t.inInbox ? 'archive' : 'unarchive', t.inInbox ? 'Archive' : 'Move to inbox', t.inInbox ? ICON.archive : ICON.inbox], ['trash', 'Delete', ICON.trash])
  return a.map(([act, title, icon]) =>
    `<button type="button" class="mail-iconbtn${act === 'pin' && pinned ? ' is-on' : ''}${act === 'star' && t.starred ? ' is-on' : ''}" data-mail-act="${act}" data-id="${esc(t.id)}" title="${title}" aria-label="${title}">${icon}</button>`).join('')
}

function renderList() {
  const el = q('#mail-list')
  if (!el) return
  const name = q('#mail-folder-name')
  if (name) name.textContent = folderDef(st.folder).name
  if (st.loadingList && !st.threads.length) { el.innerHTML = `<p class="mail-list__empty">Loading…</p>`; return }
  const showAcct = st.account === 'all' && connectedAccounts().length > 1
  const ordered = [...st.threads].sort((a, b) => isPinned(b.id, b._account) - isPinned(a.id, a._account))
  if (!ordered.length) { el.innerHTML = `<p class="mail-list__empty">Nothing in ${esc(folderDef(st.folder).name)}.</p>`; return }
  el.innerHTML = ordered.map((t) => {
    const p = isPinned(t.id, t._account)
    return `
    <article class="mail-row${t.unread ? ' is-unread' : ''}${st.openId === t.id ? ' is-open' : ''}" data-thread-id="${esc(t.id)}"${t._account ? ` data-account="${esc(t._account)}"` : ''}${t.draftId ? ` data-draft-id="${esc(t.draftId)}"` : ''}>
      <div class="mail-row__top">
        <span class="mail-row__from">${esc(t.from || '(draft)')}</span>
        ${showAcct && t._account ? `<span class="mail-row__acct" title="${esc(t._account)}">${esc(shortAddr(t._account))}</span>` : ''}
        <span class="mail-row__date">${fmtDate(t.date)}</span>
      </div>
      <div class="mail-row__subj">
        ${p ? `<span class="mail-glyph mail-glyph--pin" title="Pinned">${ICON.pin}</span>` : ''}
        ${t.starred ? `<span class="mail-glyph mail-glyph--star" title="Important">${ICON.star}</span>` : ''}
        <span class="mail-row__subjtext">${esc(t.subject)}</span>
        ${t.count > 1 ? `<span class="mail-row__count">${t.count}</span>` : ''}
      </div>
      <div class="mail-row__snip">${esc(decodeEnt(t.snippet))}</div>
      <div class="mail-row__acts">${rowActs(t, p)}</div>
    </article>`
  }).join('') +
    (st.nextPageToken ? `<button type="button" class="mail-btn mail-btn--ghost mail-more" data-mail="load-more">Load more</button>` : '')
}

function msgFrame(msg) {
  const body = msg.html || `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${esc(msg.text)}</pre>`
  const doc = `<!doctype html><html><head><base target="_blank"><style>
    body{margin:0;padding:14px 16px;font:14px/1.55 -apple-system,'Segoe UI',sans-serif;color:#1c2330;background:#fff;word-break:break-word}
    img{max-width:100%;height:auto} a{color:#1a5dc8} blockquote{margin:0 0 0 6px;padding-left:10px;border-left:2px solid #ccc;color:#555}
  </style></head><body>${body}</body></html>`
  // sandbox with no allow-scripts: email HTML renders fully but cannot run JS.
  return `<iframe class="mail-frame" sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(doc)}"></iframe>`
}

// Auto-fit a message iframe to its content. Measuring once on `onload` isn't
// enough: long HTML with late-loading images/webfonts reflows *after* load, so
// a single measurement leaves the frame stuck at a too-small height (the inner
// scrollbar the user was seeing). Re-fit on each image load and via a
// ResizeObserver on the inner document; the >1px guard stops observer thrash.
function sizeFrame(fr) {
  const fit = () => {
    try {
      const d = fr.contentDocument
      if (!d) return
      const h = Math.min(Math.max(d.body?.scrollHeight || 0, d.documentElement?.scrollHeight || 0) + 10, 12000)
      if (h && Math.abs((parseFloat(fr.style.height) || 0) - h) > 1) fr.style.height = h + 'px'
    } catch { /* sandboxed edge cases */ }
  }
  const wire = () => {
    fit()
    try {
      const d = fr.contentDocument
      if (!d) return
      d.querySelectorAll('img').forEach((img) => { if (!img.complete) img.addEventListener('load', fit, { once: true }) })
      new ResizeObserver(fit).observe(d.body || d.documentElement)
    } catch { /* sandboxed edge cases */ }
  }
  fr.onload = wire
  // srcdoc frames can finish loading before onload is attached above.
  try { if (fr.contentDocument?.readyState === 'complete') wire() } catch { /* cross-origin guard */ }
}

function viewActs() {
  const t = st.open.summary
  const pinned = isPinned(t.id, t._account)
  const btn = (act, label, on = false) =>
    `<button type="button" class="mail-btn mail-btn--ghost${on ? ' is-on' : ''}" data-mail-act="${act}" data-id="${esc(t.id)}">${label}</button>`
  let acts = ''
  if (t.inTrash) acts = btn('restore', 'Restore') + btn('delete-forever', 'Delete forever')
  else if (t.inSpam) acts = btn('unspam', 'Not spam') + btn('trash', 'Delete')
  else acts = btn(t.inInbox ? 'archive' : 'unarchive', t.inInbox ? 'Archive' : 'Move to inbox') +
    `<button type="button" class="mail-btn mail-btn--ghost" data-mail="move-open" data-id="${esc(t.id)}">Move to…</button>` +
    btn('spam', 'Spam') + btn('trash', 'Delete')
  return btn('reply', 'Reply') + acts + btn('star', t.starred ? '★ Important' : '☆ Important', t.starred) + btn('pin', pinned ? 'Pinned' : 'Pin', pinned)
}

function renderView() {
  const el = q('#mail-view')
  if (!el) return
  if (!st.openId) {
    el.innerHTML = `<div class="mail-view__empty">${ICON.mail}<p>Select an email to read it here.</p></div>`
    return
  }
  if (st.loadingView || !st.open) { el.innerHTML = `<p class="mail-list__empty">Loading…</p>`; return }
  el.innerHTML = `
    <div class="mail-view__bar">${viewActs()}</div>
    <h2 class="mail-view__subject">${esc(st.open.summary.subject)}</h2>
    ${st.open.messages.map((m) => `
      <div class="mail-msg">
        <div class="mail-msg__head">
          <span class="mail-msg__from">${esc(m.from)}</span>
          <span class="mail-msg__meta">to ${esc(m.to || 'me')}${m.cc ? ` · cc ${esc(m.cc)}` : ''}</span>
          <span class="mail-msg__date">${fmtDate(m.date)}</span>
        </div>
        ${msgFrame(m)}
      </div>`).join('')}`
  el.scrollTop = 0
  for (const fr of el.querySelectorAll('.mail-frame')) sizeFrame(fr)
}

// ---- data flow ---------------------------------------------------------------

async function guard(fn) {
  try { await fn() } catch (err) {
    if (err instanceof AuthError) {
      // Server-side token lapsed/revoked: flip the local cache to disconnected
      // (keep address for the "session expired for <address>" splash).
      const s = loadEmail()
      s.connected = false
      saveEmail(s)
      rerenderApp()
      return
    }
    toast(err.message || String(err))
  }
}

function toast(msg, ok = false) {
  rootEl?.querySelector('.mail-toast')?.remove()
  const t = document.createElement('div')
  t.className = 'mail-toast' + (ok ? ' mail-toast--ok' : '')
  t.textContent = msg
  rootEl?.appendChild(t)
  setTimeout(() => t.remove(), ok ? 2200 : 6000)
}

async function fetchFolder(fid, pageToken) {
  const f = folderDef(fid)
  if (f.drafts) return listDrafts(pageToken, st.account)
  if (f.pinned) {
    // Pins span accounts, so each is fetched from the one it belongs to. In a
    // single-account view, only that account's pins are shown.
    const pins = pinnedIds().filter((p) => st.account === 'all' || p.account === st.account)
    const threads = (await Promise.all(pins.map((p) => getThreadSummary(p.id, p.account).catch(() => null)))).filter(Boolean)
    return { threads, nextPageToken: null }
  }
  return listThreads({ labelIds: f.labelIds, q: f.q, pageToken, account: st.account })
}

// Thread lists are cached per account+folder, so reopening Mail shows the last
// known inbox immediately instead of an empty list. Only the first page is kept
// — that is what is on screen before the user scrolls.
const threadCacheKey = (account, fid) => `email.threads.${account}.${fid}`

// Every nav entry carries the account whose section it sits in, so one click
// picks mailbox and folder together.
function selectFolder(fid, account) {
  if (account && account !== st.account) {
    st.account = account
    setActiveAccount(account)
    // A label id belongs to one mailbox; it means nothing in the next.
    if (!foldersFor(st.account, st.labels, connectedAccounts()).some((f) => f.id === fid)) fid = 'INBOX'
  }
  loadFolder(fid)
}

function loadFolder(fid) {
  st.folder = fid
  st.threads = []
  st.nextPageToken = null
  st.openId = null
  st.open = null
  st.loadingList = true
  const seq = ++st.seq
  // Last launch's copy of this exact mailbox, painted while the fetch runs.
  const cached = cachedValue(threadCacheKey(st.account, fid))
  if (cached?.threads?.length) {
    st.threads = cached.threads
    st.nextPageToken = cached.nextPageToken ?? null
    st.loadingList = false
  }
  renderNav(); renderList(); renderView()
  guard(async () => {
    const res = await fetchFolder(fid)
    if (seq !== st.seq) return
    st.threads = res.threads
    st.nextPageToken = res.nextPageToken
    st.loadingList = false
    writeCache(threadCacheKey(st.account, fid), { threads: res.threads, nextPageToken: res.nextPageToken })
    renderList()
  })
}

// Boot prefetch: the inbox, which is what Mail opens on.
export async function warmEmail() {
  if (!isConnected()) return
  const accts = connectedAccounts()
  const account = accts.length === 1 ? accts[0] : 'all' // the view Mail opens on
  try {
    const res = await listThreads({ labelIds: ['INBOX'], account })
    writeCache(threadCacheKey(account, 'INBOX'), { threads: res.threads, nextPageToken: res.nextPageToken })
  } catch { /* prefetch is best-effort */ }
}

function loadMore() {
  const seq = st.seq
  guard(async () => {
    const res = await fetchFolder(st.folder, st.nextPageToken)
    if (seq !== st.seq) return
    st.threads = st.threads.concat(res.threads)
    st.nextPageToken = res.nextPageToken
    renderList()
  })
}

function openThread(id) {
  const account = acctOf(id)
  st.openId = id
  st.open = null
  st.loadingView = true
  const seq = ++st.viewSeq
  renderList(); renderView()
  guard(async () => {
    const t = await getThread(id, account)
    if (seq !== st.viewSeq) return
    st.open = t
    st.loadingView = false
    renderView()
    const s = st.threads.find((x) => x.id === id)
    if (s?.unread) {
      s.unread = false
      t.summary.unread = false
      renderList()
      markRead(id, account).catch(() => {})
    }
  })
}

// Remove a thread from the current list (its action moved it out of this folder).
function dropFromList(id) {
  st.threads = st.threads.filter((t) => t.id !== id)
  if (st.openId === id) { st.openId = null; st.open = null; renderView() }
  renderList()
}
const summaryOf = (id) => {
  const t = st.threads.find((x) => x.id === id)
  return st.open?.summary.id === id ? [t, st.open.summary].filter(Boolean) : t ? [t] : []
}
const patch = (id, p) => summaryOf(id).forEach((t) => Object.assign(t, p))

function doAct(act, id) {
  const account = acctOf(id)
  guard(async () => {
    switch (act) {
      case 'pin': {
        const on = togglePin(id, account)
        if (!on && st.folder === 'PINNED') dropFromList(id)
        else { renderList(); if (st.openId === id) renderView() }
        toast(on ? 'Pinned — it floats to the top.' : 'Unpinned.', true)
        break
      }
      case 'star': {
        const t = st.threads.find((x) => x.id === id) || st.open?.summary
        const on = !t?.starred
        await setStarred(id, on, account)
        patch(id, { starred: on })
        if (!on && st.folder === 'STARRED') dropFromList(id)
        else { renderList(); if (st.openId === id) renderView() }
        break
      }
      case 'archive':
        await archiveThread(id, account)
        patch(id, { inInbox: false })
        if (st.folder === 'INBOX') dropFromList(id)
        else { renderList(); if (st.openId === id) renderView() }
        toast('Archived.', true)
        break
      case 'unarchive':
        await unarchiveThread(id, account)
        patch(id, { inInbox: true })
        if (st.folder === 'ARCHIVE') dropFromList(id)
        else { renderList(); if (st.openId === id) renderView() }
        toast('Moved to inbox.', true)
        break
      case 'spam':
        await spamThread(id, account)
        patch(id, { inSpam: true, inInbox: false })
        if (st.folder !== 'SPAM') dropFromList(id)
        toast('Marked as spam.', true)
        break
      case 'unspam':
        await unspamThread(id, account)
        patch(id, { inSpam: false, inInbox: true })
        if (st.folder === 'SPAM') dropFromList(id)
        toast('Not spam — moved to inbox.', true)
        break
      case 'trash':
        await trashThread(id, account)
        patch(id, { inTrash: true })
        if (st.folder !== 'TRASH') dropFromList(id)
        toast('Moved to trash.', true)
        break
      case 'restore':
        await untrashThread(id, account)
        patch(id, { inTrash: false })
        if (st.folder === 'TRASH') dropFromList(id)
        toast('Restored.', true)
        break
      case 'delete-forever':
        if (!confirm('Permanently delete this conversation? This cannot be undone.')) return
        await deleteThreadForever(id, account)
        dropFromList(id)
        toast('Deleted forever.', true)
        break
      case 'delete-draft': {
        const row = st.threads.find((x) => x.id === id)
        if (row?.draftId) await deleteDraft(row.draftId, account)
        dropFromList(id)
        toast('Draft discarded.', true)
        break
      }
      case 'reply':
        openReply()
        break
    }
  })
}

// ---- move to folder ---------------------------------------------------------

// "Alice Example <alice@x.com>" → "alice@x.com". Falls back to the raw string.
const emailAddr = (s = '') => { const m = String(s).match(/<([^>]+)>/); return (m ? m[1] : s).trim().toLowerCase() }
// The sender to build a rule from: newest non-draft message in the open thread.
function latestFrom() {
  const msgs = st.open?.messages || []
  return ([...msgs].reverse().find((m) => !m.labelIds?.includes('DRAFT')) || msgs[msgs.length - 1])?.from || ''
}

function closeMoveMenu() { rootEl?.querySelector('.mail-movemenu')?.remove() }

function openMoveMenu(id) {
  if (rootEl?.querySelector('.mail-movemenu')) { closeMoveMenu(); return }
  const bar = q('.mail-view__bar')
  if (!bar) return
  const addr = emailAddr(latestFrom())
  const folders = st.labels[acctOf(id)] || [] // this thread's own mailbox, not the active view's
  const menu = document.createElement('div')
  menu.className = 'mail-movemenu'
  menu.dataset.id = id
  menu.innerHTML = `
    <div class="mail-movemenu__head">Move to folder</div>
    ${addr ? `<label class="mail-movemenu__sender"><input type="checkbox" data-mm="sender"> Always file mail from <b>${esc(addr)}</b> here</label>` : ''}
    <div class="mail-movemenu__list">
      ${folders.map((l) => `<button type="button" class="mail-movemenu__item" data-mm-label="${esc(l.id)}">${ICON.label}<span>${esc(l.name)}</span></button>`).join('')}
      <button type="button" class="mail-movemenu__item mail-movemenu__new" data-mm-label="__new__">+ New folder…</button>
    </div>`
  menu.onclick = (e) => {
    const item = e.target.closest('[data-mm-label]')
    if (!item) return
    const sender = !!menu.querySelector('[data-mm="sender"]')?.checked
    doMove(id, item.dataset.mmLabel, sender)
  }
  bar.appendChild(menu)
}

function doMove(id, labelId, alsoSender) {
  const account = acctOf(id)
  guard(async () => {
    let lid = labelId
    if (labelId === '__new__') {
      const name = prompt('New folder name:')?.trim()
      if (!name) return
      // Labels are per-account, and st.labels is keyed the same way, so reuse
      // is decided inside the thread's own mailbox.
      const mine = st.labels[account]
      const existing = mine?.find((l) => l.name.toLowerCase() === name.toLowerCase())
      const lbl = existing || await createLabel(name, account)
      lid = lbl.id
      if (!existing && mine) { mine.push({ id: lbl.id, name: lbl.name }); renderNav() }
    }
    await moveThread(id, lid, account)
    patch(id, { inInbox: false })
    let note = 'Moved to folder.'
    if (alsoSender) {
      const addr = emailAddr(latestFrom())
      // The move already worked; a missing settings scope shouldn't lose it —
      // just tell the user the auto-rule needs a reconnect to gain that access.
      if (addr) try { await createFilter(addr, lid, account); note = `Moved — future mail from ${addr} will follow.` }
      catch (err) {
        if (err instanceof AuthError) note = 'Moved. Reconnect Google (Settings) to enable auto-filing by sender.'
        else throw err
      }
    }
    closeMoveMenu()
    if (st.folder !== lid) dropFromList(id)
    else renderList()
    toast(note, true)
  })
}

// ---- compose ----------------------------------------------------------------

const stripTags = (html) => { const t = document.createElement('template'); t.innerHTML = html; return t.content.textContent || '' }
function sanitizeHTML(html) {
  const t = document.createElement('template')
  t.innerHTML = html
  t.content.querySelectorAll('script,iframe,object,embed,link,meta,style').forEach((n) => n.remove())
  for (const n of t.content.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name)
    }
  }
  return t.innerHTML
}

function openReply() {
  if (!st.open) return
  const last = [...st.open.messages].reverse().find((m) => !m.labelIds.includes('DRAFT')) || st.open.messages[st.open.messages.length - 1]
  const subj = st.open.summary.subject
  const quoted = (last.text || stripTags(last.html)).trim()
  openCompose({
    title: 'Reply',
    to: last.from,
    subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`,
    html: `<br><br><blockquote style="margin:0 0 0 6px;padding-left:10px;border-left:2px solid #999;color:#777">${esc(quoted).replace(/\n/g, '<br>')}</blockquote>`,
    threadId: st.open.id,
    account: st.open.summary._account, // reply from the account that received it
    inReplyTo: last.messageId,
    references: last.references,
  })
}

function openDraftCompose(draftId, account) {
  guard(async () => {
    const d = await getDraft(draftId, account)
    openCompose({
      title: 'Draft', draftId: d.id, threadId: d.message.threadId, account,
      to: d.message.to, cc: d.message.cc, subject: d.message.subject,
      html: sanitizeHTML(d.message.html) || esc(d.message.text).replace(/\n/g, '<br>'),
    })
  })
}

function closeCompose() {
  document.querySelector('.mail-compose')?.remove()
  composeCtx = null
}

function openCompose(init = {}) {
  closeCompose()
  const accts = connectedAccounts()
  // Which account sends: the one passed in (reply/draft), else the active
  // single-account view, else the primary.
  const from = init.account || (st.account !== 'all' ? st.account : accts[0]) || null
  composeCtx = { draftId: init.draftId || null, threadId: init.threadId || null, account: from, inReplyTo: init.inReplyTo || null, references: init.references || null }
  const fromField = accts.length > 1
    ? `<select class="mail-compose__field mc-from" aria-label="From account">
        ${accts.map((a) => `<option value="${esc(a)}"${a === from ? ' selected' : ''}>From: ${esc(a)}</option>`).join('')}
      </select>` : ''
  const p = document.createElement('div')
  p.className = 'mail-compose'
  p.innerHTML = `
    <div class="mail-compose__head">
      <span>${esc(init.title || 'New message')}</span>
      <button type="button" class="mail-iconbtn" data-mc="close" title="Close" aria-label="Close">✕</button>
    </div>
    ${fromField}
    <input class="mail-compose__field mc-to" placeholder="To" value="${esc(init.to || '')}" aria-label="To">
    <input class="mail-compose__field mc-cc" placeholder="Cc" value="${esc(init.cc || '')}" aria-label="Cc">
    <input class="mail-compose__field mc-subject" placeholder="Subject" value="${esc(init.subject || '')}" aria-label="Subject">
    <div class="mail-compose__body mc-body" contenteditable="true" aria-label="Message body"></div>
    <div class="mail-compose__tools">
      <button type="button" class="mail-tool" data-cmd="bold" title="Bold"><b>B</b></button>
      <button type="button" class="mail-tool" data-cmd="italic" title="Italic"><i>I</i></button>
      <button type="button" class="mail-tool" data-cmd="underline" title="Underline"><u>U</u></button>
      <button type="button" class="mail-tool" data-cmd="insertUnorderedList" title="Bulleted list">≔</button>
      <button type="button" class="mail-tool" data-cmd="createLink" title="Insert link">🔗</button>
      <button type="button" class="mail-tool" data-cmd="removeFormat" title="Clear formatting">T̶</button>
    </div>
    <div class="mail-compose__foot">
      <button type="button" class="mail-btn mail-btn--primary" data-mc="send">Send</button>
      <button type="button" class="mail-btn mail-btn--ghost" data-mc="save-draft">Save draft</button>
      <span class="mail-compose__status mc-status"></span>
      <button type="button" class="mail-btn mail-btn--ghost mail-compose__discard" data-mc="discard">Discard</button>
    </div>`
  p.querySelector('.mc-body').innerHTML = init.html || ''
  // mousedown would steal the selection from the editable body — the toolbar
  // must not take focus for execCommand to apply to the right range.
  p.addEventListener('mousedown', (e) => { if (e.target.closest('[data-cmd]')) e.preventDefault() })
  p.addEventListener('change', (e) => { if (e.target.closest('.mc-from')) composeCtx.account = e.target.value })
  p.addEventListener('click', (e) => {
    const tool = e.target.closest('[data-cmd]')
    if (tool) {
      const cmd = tool.dataset.cmd
      if (cmd === 'createLink') {
        const url = prompt('Link URL:')
        if (url) document.execCommand('createLink', false, url)
      } else document.execCommand(cmd)
      p.querySelector('.mc-body').focus()
      return
    }
    const act = e.target.closest('[data-mc]')?.dataset.mc
    if (act === 'close') closeCompose()
    if (act === 'send') sendCompose(p)
    if (act === 'save-draft') saveComposeDraft(p)
    if (act === 'discard') discardCompose()
  })
  ;(rootEl || document.body).appendChild(p)
  p.querySelector(init.to ? '.mc-body' : '.mc-to').focus()
}

const composeRaw = (p) => buildMime({
  to: p.querySelector('.mc-to').value.trim(),
  cc: p.querySelector('.mc-cc').value.trim(),
  subject: p.querySelector('.mc-subject').value.trim(),
  html: p.querySelector('.mc-body').innerHTML,
  inReplyTo: composeCtx.inReplyTo,
  references: composeCtx.references,
})

function sendCompose(p) {
  const to = p.querySelector('.mc-to').value.trim()
  const status = p.querySelector('.mc-status')
  if (!to) { status.textContent = 'Add a recipient first.'; p.querySelector('.mc-to').focus(); return }
  const btn = p.querySelector('[data-mc="send"]')
  btn.disabled = true
  status.textContent = 'Sending…'
  guard(async () => {
    const raw = composeRaw(p)
    if (composeCtx.draftId) {
      await saveDraft(composeCtx.draftId, raw, composeCtx.account)
      await sendDraft(composeCtx.draftId, composeCtx.account)
    } else await sendMessage(raw, composeCtx.threadId, composeCtx.account)
    closeCompose()
    toast('Sent.', true)
    if (st.folder === 'SENT' || st.folder === 'DRAFT') loadFolder(st.folder)
  }).finally(() => { if (document.contains(btn)) { btn.disabled = false; status.textContent = '' } })
}

function saveComposeDraft(p) {
  const status = p.querySelector('.mc-status')
  status.textContent = 'Saving…'
  guard(async () => {
    const res = await saveDraft(composeCtx.draftId, composeRaw(p), composeCtx.account)
    composeCtx.draftId = res.id
    status.textContent = 'Draft saved.'
    if (st.folder === 'DRAFT') loadFolder(st.folder)
  })
}

function discardCompose() {
  const draftId = composeCtx?.draftId
  const account = composeCtx?.account
  guard(async () => {
    if (draftId) await deleteDraft(draftId, account)
    closeCompose()
    if (draftId && st.folder === 'DRAFT') loadFolder(st.folder)
  })
}

// ---- split + events -----------------------------------------------------------

function startSplit(e) {
  e.preventDefault()
  const body = q('.mail-body'), list = q('#mail-list')
  if (!body || !list) return
  document.body.classList.add('is-mail-splitting')
  const move = (ev) => {
    const b = body.getBoundingClientRect(), l = list.getBoundingClientRect()
    const pct = Math.min(70, Math.max(18, ((ev.clientX - l.left) / b.width) * 100))
    list.style.flexBasis = pct + '%'
  }
  const up = () => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
    document.body.classList.remove('is-mail-splitting')
    const s = loadEmail()
    s.splitPct = parseFloat(list.style.flexBasis) || s.splitPct
    saveEmail(s)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

function onClick(e) {
  if (e.target.closest('.mail-compose')) return // compose handles its own clicks
  if (e.target.closest('.mail-movemenu')) return // the menu handles its own clicks
  // Any click outside an open move-menu (except its trigger) dismisses it.
  if (!e.target.closest('[data-mail="move-open"]')) closeMoveMenu()
  const act = e.target.closest('[data-mail-act]')
  if (act) { doAct(act.dataset.mailAct, act.dataset.id); return }
  const mail = e.target.closest('[data-mail]')
  if (mail) {
    const m = mail.dataset.mail
    if (m === 'move-open') { openMoveMenu(mail.dataset.id); return }
    if (m === 'toggle-nav') {
      const s = loadEmail()
      s.navHidden = !s.navHidden
      saveEmail(s)
      q('.mail-body')?.classList.toggle('nav-hidden', s.navHidden)
    }
    if (m === 'refresh') loadFolder(st.folder)
    if (m === 'compose') openCompose()
    if (m === 'load-more') loadMore()
    return
  }
  const folder = e.target.closest('[data-mail-folder]')
  if (folder) { selectFolder(folder.dataset.mailFolder, folder.dataset.mailAccount); return }
  const row = e.target.closest('.mail-row')
  if (row) {
    if (row.dataset.draftId) openDraftCompose(row.dataset.draftId, row.dataset.account || null)
    else openThread(row.dataset.threadId)
  }
}
