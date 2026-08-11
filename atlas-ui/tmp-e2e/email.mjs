// Email plugin suite — the Gmail REST API is faked at the network layer
// (page.route), so the app's real fetch/parse/render/action code runs
// end-to-end. Headless always. Human-cadence mouse for the split drag.
import { chromium } from 'playwright'

const BASE = 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- fake Gmail backend ----------------------------------------------------

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url')
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8')

let msgSeq = 100
function mkMsg(id, threadId, { from, to = 'chance@example.com', subject, html, text = 'plain body', date, labels }) {
  return {
    id, threadId,
    labelIds: [...labels],
    snippet: (text || '').slice(0, 90),
    internalDate: String(date),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@mail.example>` },
      ],
      parts: [
        { mimeType: 'text/plain', body: { data: b64u(text) } },
        ...(html ? [{ mimeType: 'text/html', body: { data: b64u(html) } }] : []),
      ],
    },
  }
}

function freshState() {
  const D = Date.now()
  const threads = new Map()
  const put = (id, msgs) => threads.set(id, { id, messages: msgs })
  put('t1', [mkMsg('m1', 't1', {
    from: 'Ada Lovelace <ada@analytical.example>', subject: 'Engine schematics',
    html: '<h1 id="mail-h1">Analytical Engine</h1><p>Full <b>HTML</b> body renders here.</p><script>document.body.dataset.pwned="1"</script>',
    text: 'Analytical Engine — plain fallback', date: D - 3600e3, labels: ['INBOX', 'UNREAD'],
  })])
  put('t2', [
    mkMsg('m2a', 't2', { from: 'Grace Hopper <grace@navy.example>', subject: 'Compiler notes', text: 'First message', date: D - 86400e3 * 2, labels: ['INBOX'] }),
    mkMsg('m2b', 't2', { from: 'Grace Hopper <grace@navy.example>', subject: 'Re: Compiler notes', text: 'Nanoseconds matter.', date: D - 86400e3, labels: ['INBOX'] }),
  ])
  put('t3', [mkMsg('m3', 't3', { from: 'Store <shop@example.com>', subject: 'Your receipt', text: 'Receipt #42', date: D - 86400e3 * 3, labels: ['Label_1'] })])
  put('t4', [mkMsg('m4', 't4', { from: 'Totally Real Bank <x@scam.example>', subject: 'You won', text: 'Click here', date: D - 86400e3 * 4, labels: ['SPAM'] })])
  put('t5', [mkMsg('m5', 't5', { from: 'Old News <news@example.com>', subject: 'Stale newsletter', text: 'Old stuff', date: D - 86400e3 * 5, labels: ['TRASH'] })])
  put('t6', [mkMsg('m6', 't6', { from: 'chance@example.com', to: 'friend@example.com', subject: 'My sent one', text: 'Hi friend', date: D - 86400e3 * 6, labels: ['SENT'] })])
  put('td1', [mkMsg('md1', 'td1', { from: 'chance@example.com', to: 'draft-to@example.com', subject: 'Half-written idea', text: 'Draft body here', date: D - 7200e3, labels: ['DRAFT'] })])
  return {
    threads,
    drafts: new Map([['dr1', 'md1']]), // draftId → message id
    sends: [], log: [], draftSeq: 10,
    labels: [
      ...['INBOX', 'STARRED', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD'].map((id) => ({ id, name: id, type: 'system' })),
      { id: 'Label_1', name: 'Receipts', type: 'user', labelListVisibility: 'labelShow' },
    ],
  }
}

const threadLabels = (t) => new Set(t.messages.flatMap((m) => m.labelIds))
const lastDate = (t) => Math.max(...t.messages.map((m) => Number(m.internalDate)))

function parseRaw(raw) {
  const txt = unb64u(raw)
  const [head, ...bodyParts] = txt.split('\r\n\r\n')
  const h = (name) => head.split('\r\n').find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ':'))?.slice(name.length + 1).trim() || ''
  let body = bodyParts.join('\r\n\r\n')
  try { body = Buffer.from(body.replace(/\s/g, ''), 'base64').toString('utf8') } catch {}
  return { to: h('To'), cc: h('Cc'), subject: h('Subject'), inReplyTo: h('In-Reply-To'), body }
}

function installFake(page, S) {
  return page.route('https://gmail.googleapis.com/**', (route) => {
    const req = route.request()
    const u = new URL(req.url())
    const path = u.pathname.replace('/gmail/v1/users/me/', '')
    const method = req.method()
    const post = () => JSON.parse(req.postData() || '{}')
    const json = (obj, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj ?? {}) })
    S.log.push(`${method} ${path}${u.search}`)

    if (path === 'profile') return json({ emailAddress: 'chance@example.com' })
    if (path === 'labels') return json({ labels: S.labels })

    if (path === 'threads' && method === 'GET') {
      const label = u.searchParams.get('labelIds')
      const q = u.searchParams.get('q')
      let list = [...S.threads.values()]
      if (label) list = list.filter((t) => threadLabels(t).has(label))
      else if (q?.includes('-in:inbox')) list = list.filter((t) => { const L = threadLabels(t); return !['INBOX', 'SPAM', 'TRASH', 'SENT', 'DRAFT'].some((x) => L.has(x)) })
      if (label !== 'TRASH' && label !== 'SPAM') list = list.filter((t) => { const L = threadLabels(t); return !(L.has('TRASH') && label !== 'TRASH') && !(L.has('SPAM') && label !== 'SPAM') })
      list.sort((a, b) => lastDate(b) - lastDate(a))
      return json({ threads: list.map((t) => ({ id: t.id, snippet: '' })) })
    }
    let m
    if ((m = path.match(/^threads\/([^/]+)\/modify$/)) && method === 'POST') {
      const t = S.threads.get(m[1]); if (!t) return json({ error: 'nf' }, 404)
      const { addLabelIds = [], removeLabelIds = [] } = post()
      for (const msg of t.messages) msg.labelIds = [...new Set([...msg.labelIds.filter((l) => !removeLabelIds.includes(l)), ...addLabelIds])]
      return json({ id: t.id })
    }
    if ((m = path.match(/^threads\/([^/]+)\/trash$/)) && method === 'POST') {
      const t = S.threads.get(m[1])
      for (const msg of t.messages) msg.labelIds = [...new Set([...msg.labelIds.filter((l) => l !== 'INBOX' && l !== 'SPAM'), 'TRASH'])]
      return json({ id: t.id })
    }
    if ((m = path.match(/^threads\/([^/]+)\/untrash$/)) && method === 'POST') {
      const t = S.threads.get(m[1])
      for (const msg of t.messages) msg.labelIds = [...new Set([...msg.labelIds.filter((l) => l !== 'TRASH'), 'INBOX'])]
      return json({ id: t.id })
    }
    if ((m = path.match(/^threads\/([^/]+)$/)) && method === 'GET') {
      const t = S.threads.get(m[1])
      return t ? json(t) : json({ error: 'nf' }, 404)
    }
    if ((m = path.match(/^threads\/([^/]+)$/)) && method === 'DELETE') {
      S.threads.delete(m[1])
      return route.fulfill({ status: 204, body: '' })
    }

    if (path === 'drafts' && method === 'GET') {
      const drafts = [...S.drafts.entries()].map(([id, msgId]) => {
        const t = [...S.threads.values()].find((th) => th.messages.some((x) => x.id === msgId))
        return { id, message: { id: msgId, threadId: t.id } }
      })
      return json({ drafts })
    }
    if (path === 'drafts' && method === 'POST') {
      const { to, subject, body } = parseRaw(post().message.raw)
      const id = `dr${++S.draftSeq}`, msgId = `mdr${S.draftSeq}`, threadId = `tdr${S.draftSeq}`
      S.threads.set(threadId, { id: threadId, messages: [mkMsg(msgId, threadId, { from: 'chance@example.com', to, subject, html: body, date: Date.now(), labels: ['DRAFT'] })] })
      S.drafts.set(id, msgId)
      return json({ id, message: { id: msgId, threadId } })
    }
    if (path === 'drafts/send' && method === 'POST') {
      const { id } = post()
      const msgId = S.drafts.get(id)
      const t = [...S.threads.values()].find((th) => th.messages.some((x) => x.id === msgId))
      for (const msg of t.messages) if (msg.id === msgId) msg.labelIds = ['SENT']
      S.drafts.delete(id)
      S.sends.push({ viaDraft: id })
      return json({ id: `sent-${id}` })
    }
    if ((m = path.match(/^drafts\/([^/]+)$/))) {
      const id = m[1]
      const msgId = S.drafts.get(id)
      const t = msgId && [...S.threads.values()].find((th) => th.messages.some((x) => x.id === msgId))
      if (method === 'GET') return json({ id, message: t.messages.find((x) => x.id === msgId) })
      if (method === 'DELETE') {
        S.drafts.delete(id)
        if (t) S.threads.delete(t.id)
        return route.fulfill({ status: 204, body: '' })
      }
      if (method === 'PUT') {
        const parsed = parseRaw(post().message.raw)
        const msg = t.messages.find((x) => x.id === msgId)
        msg.payload.headers = [
          { name: 'From', value: 'chance@example.com' }, { name: 'To', value: parsed.to },
          { name: 'Subject', value: parsed.subject }, { name: 'Message-ID', value: `<${msgId}@mail.example>` },
        ]
        S.log.push(`PUT-DRAFT ${id} subject=${parsed.subject}`)
        return json({ id, message: { id: msgId, threadId: t.id } })
      }
    }
    if (path === 'messages/send' && method === 'POST') {
      const b = post()
      S.sends.push({ threadId: b.threadId || null, ...parseRaw(b.raw) })
      return json({ id: `msent${++msgSeq}` })
    }
    return json({ error: `unhandled ${method} ${path}` }, 500)
  })
}

// ---- suite -------------------------------------------------------------------

const browser = await chromium.launch({ headless: true })

// A. no token → connect card
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/#/email`)
  await page.waitForSelector('.mail-connect')
  console.log('A. unconnected')
  ok(await page.locator('#title').innerText() === 'Email', 'topbar label says Email')
  ok(await page.locator('.mail-connect__title').innerText() === 'Connect your Gmail', 'connect card shown')
  ok(await page.locator('.mail-connect a[href="#/settings"]').count() >= 1, 'points to Settings when no client ID')
  ok(await page.locator('#customize').isHidden(), 'Customize button hidden on email page')
  ok(await page.locator('.nav__item', { hasText: 'Email' }).count() === 1, 'Email appears in sidebar nav')
  await page.goto(`${BASE}/#/settings`)
  await page.waitForSelector('#gmail-client-id')
  ok(await page.locator('#gmail-client-id').count() === 1, 'settings has client ID field')
  ok(await page.locator('[data-act="gmail-connect"]').count() === 1, 'settings has Connect button')
  await ctx.close()
}

// B. token seeded + fake API
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  page.on('dialog', (d) => d.accept())
  const S = freshState()
  await installFake(page, S)
  await page.addInitScript(() => {
    localStorage.setItem('atlas.email.v1', JSON.stringify({
      clientId: 'test.apps.googleusercontent.com',
      token: { access_token: 'tok', expires_at: Date.now() + 3600e3 },
      address: 'chance@example.com', pinned: [], splitPct: 42,
    }))
  })
  await page.goto(`${BASE}/#/email`)
  await page.waitForSelector('.mail-row')

  console.log('B1. folders + list')
  const folders = await page.locator('.mail-folder span').allInnerTexts()
  ok(['Inbox', 'Pinned', 'Important', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash', 'Receipts'].every((f) => folders.includes(f)), `all folders + user label (${folders.join(',')})`)
  ok(await page.locator('.mail-row').count() === 2, 'inbox lists 2 threads')
  ok(await page.locator('.mail-row.is-unread .mail-row__from').first().innerText() === 'Ada Lovelace', 'unread row, parsed sender name')
  ok((await page.locator('.mail-row').nth(1).locator('.mail-row__count').innerText()) === '2', 'thread message count shown')

  console.log('B2. nav toggle')
  await page.click('[data-mail="toggle-nav"]')
  ok(await page.locator('.mail-nav').isHidden(), 'nav hidden after toggle')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.email.v1')).navHidden) === true, 'navHidden persisted')
  await page.click('[data-mail="toggle-nav"]')
  ok(await page.locator('.mail-nav').isVisible(), 'nav shown again')

  console.log('B3. open + HTML render')
  await page.click('.mail-row[data-thread-id="t1"]')
  await page.waitForSelector('.mail-view__subject')
  ok(await page.locator('.mail-view__subject').innerText() === 'Engine schematics', 'viewer subject')
  const frame = page.frameLocator('.mail-frame')
  ok(await frame.locator('#mail-h1').innerText() === 'Analytical Engine', 'HTML email renders in sandboxed frame')
  ok(await frame.locator('body').getAttribute('data-pwned') === null, 'scripts in email HTML do not run')
  await sleep(300)
  ok(await page.locator('.mail-row.is-unread').count() === 0, 'opened thread no longer unread in list')
  ok(S.log.some((l) => l.includes('threads/t1/modify')), 'markRead pushed to Gmail')

  console.log('B4. important (star) + pin')
  await page.click('.mail-view__bar [data-mail-act="star"]')
  await page.waitForFunction(() => document.querySelector('.mail-view__bar [data-mail-act="star"]')?.classList.contains('is-on'))
  ok(threadLabels(S.threads.get('t1')).has('STARRED'), 'star synced to Gmail (STARRED label)')
  await page.click('[data-mail-folder="STARRED"]')
  await page.waitForSelector('.mail-row')
  ok(await page.locator('.mail-row').count() === 1 && (await page.locator('.mail-row__subjtext').innerText()) === 'Engine schematics', 'Important folder lists starred thread')
  await page.click('[data-mail-folder="INBOX"]')
  await page.waitForSelector('.mail-row[data-thread-id="t2"]')
  await page.hover('.mail-row[data-thread-id="t2"]')
  await page.click('.mail-row[data-thread-id="t2"] [data-mail-act="pin"]')
  await page.waitForFunction(() => document.querySelector('.mail-row')?.dataset.threadId === 't2')
  ok(true, 'pinned thread floats to top of inbox')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.email.v1')).pinned).then((p) => p.includes('t2')), 'pin stored Atlas-local')
  ok(!threadLabels(S.threads.get('t2')).has('STARRED'), 'pin does not touch Gmail labels')
  await page.click('[data-mail-folder="PINNED"]')
  await page.waitForSelector('.mail-row')
  ok(await page.locator('.mail-row').count() === 1 && (await page.locator('.mail-row').getAttribute('data-thread-id')) === 't2', 'Pinned folder lists the pinned thread')

  console.log('B5. archive / unarchive')
  await page.click('[data-mail-folder="INBOX"]')
  await page.waitForSelector('.mail-row[data-thread-id="t1"]')
  await page.hover('.mail-row[data-thread-id="t1"]')
  await page.click('.mail-row[data-thread-id="t1"] [data-mail-act="archive"]')
  await page.waitForFunction(() => !document.querySelector('.mail-row[data-thread-id="t1"]'))
  ok(!threadLabels(S.threads.get('t1')).has('INBOX'), 'archive removed INBOX label in Gmail')
  await page.click('[data-mail-folder="ARCHIVE"]')
  await page.waitForSelector('.mail-row[data-thread-id="t1"]')
  ok(await page.locator('.mail-row').count() === 2, 'Archive folder shows archived + label-only threads')
  await page.click('.mail-row[data-thread-id="t1"]')
  await page.waitForSelector('.mail-view__bar')
  await page.click('.mail-view__bar [data-mail-act="unarchive"]')
  await page.waitForFunction(() => !document.querySelector('.mail-row[data-thread-id="t1"]'))
  ok(threadLabels(S.threads.get('t1')).has('INBOX'), 'unarchive restored INBOX label')

  console.log('B6. spam / not spam')
  await page.click('[data-mail-folder="SPAM"]')
  await page.waitForSelector('.mail-row[data-thread-id="t4"]')
  await page.hover('.mail-row[data-thread-id="t4"]')
  await page.click('.mail-row[data-thread-id="t4"] [data-mail-act="unspam"]')
  await page.waitForFunction(() => !document.querySelector('.mail-row[data-thread-id="t4"]'))
  ok(!threadLabels(S.threads.get('t4')).has('SPAM') && threadLabels(S.threads.get('t4')).has('INBOX'), 'not-spam moves thread to inbox in Gmail')
  await page.click('[data-mail-folder="INBOX"]')
  await page.waitForSelector('.mail-row[data-thread-id="t4"]')
  await page.click('.mail-row[data-thread-id="t4"]')
  await page.waitForSelector('.mail-view__bar')
  await page.click('.mail-view__bar [data-mail-act="spam"]')
  await page.waitForFunction(() => !document.querySelector('.mail-row[data-thread-id="t4"]'))
  ok(threadLabels(S.threads.get('t4')).has('SPAM'), 'mark-as-spam adds SPAM label')

  console.log('B7. trash / restore / delete forever')
  await page.hover('.mail-row[data-thread-id="t2"]')
  await page.click('.mail-row[data-thread-id="t2"] [data-mail-act="trash"]')
  await page.waitForFunction(() => !document.querySelector('.mail-row[data-thread-id="t2"]'))
  ok(threadLabels(S.threads.get('t2')).has('TRASH'), 'delete moved thread to trash')
  await page.click('[data-mail-folder="TRASH"]')
  await page.waitForSelector('.mail-row[data-thread-id="t2"]')
  await page.hover('.mail-row[data-thread-id="t2"]')
  await page.click('.mail-row[data-thread-id="t2"] [data-mail-act="restore"]')
  await page.waitForFunction(() => !document.querySelector('.mail-row[data-thread-id="t2"]'))
  ok(!threadLabels(S.threads.get('t2')).has('TRASH'), 'restore removed TRASH label')
  await page.hover('.mail-row[data-thread-id="t5"]')
  await page.click('.mail-row[data-thread-id="t5"] [data-mail-act="delete-forever"]')
  await page.waitForFunction(() => !document.querySelector('.mail-row[data-thread-id="t5"]'))
  ok(!S.threads.has('t5'), 'delete forever removed the thread permanently')

  console.log('B8. split resize')
  await page.click('[data-mail-folder="INBOX"]')
  await page.waitForSelector('.mail-row')
  const split = await page.locator('#mail-split').boundingBox()
  const before = (await page.locator('#mail-list').boundingBox()).width
  await page.mouse.move(split.x + 4, split.y + 300)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) { await page.mouse.move(split.x + 4 - i * 15, split.y + 300); await sleep(16) }
  await page.mouse.up()
  const after = (await page.locator('#mail-list').boundingBox()).width
  ok(before - after > 120, `drag bar narrows the list (${Math.round(before)} → ${Math.round(after)}px)`)
  const pct = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.email.v1')).splitPct)
  ok(pct < 40, `split position persisted (${pct.toFixed(1)}%)`)

  console.log('B9. compose, rich text, send')
  await page.click('[data-mail="compose"]')
  await page.waitForSelector('.mail-compose')
  await page.fill('.mc-to', 'bob@example.com')
  await page.fill('.mc-subject', 'Hi there')
  await page.click('.mc-body')
  await page.keyboard.type('Hello world', { delay: 15 })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.click('.mail-tool[data-cmd="bold"]')
  await page.click('[data-mc="send"]')
  await page.waitForFunction(() => !document.querySelector('.mail-compose'))
  const sent = S.sends.at(-1)
  ok(sent && sent.subject === 'Hi there' && sent.to === 'bob@example.com', 'send hit Gmail with headers intact')
  ok(/<(b|strong)>Hello world<\/(b|strong)>/.test(sent.body), `rich text formatting survives (${sent.body.slice(0, 60)})`)
  ok(await page.locator('.mail-toast--ok').isVisible(), 'sent toast confirms')

  console.log('B10. reply threads correctly')
  await page.click('.mail-row[data-thread-id="t2"]')
  await page.waitForSelector('.mail-view__bar')
  await page.click('.mail-view__bar [data-mail-act="reply"]')
  await page.waitForSelector('.mail-compose')
  ok((await page.inputValue('.mc-to')).includes('grace@navy.example'), 'reply prefills recipient')
  ok(await page.inputValue('.mc-subject') === 'Re: Compiler notes', 'reply prefills Re: subject')
  ok(await page.locator('.mc-body blockquote').count() === 1, 'original quoted in reply body')
  await page.click('.mc-body')
  await page.keyboard.press('Home')
  await page.keyboard.type('Agreed!', { delay: 10 })
  await page.click('[data-mc="send"]')
  await page.waitForFunction(() => !document.querySelector('.mail-compose'))
  const reply = S.sends.at(-1)
  ok(reply.threadId === 't2' && reply.inReplyTo === '<m2b@mail.example>', 'reply carries threadId + In-Reply-To')

  console.log('B11. drafts: list, edit, save, send, discard')
  await page.click('[data-mail-folder="DRAFT"]')
  await page.waitForSelector('.mail-row')
  ok(await page.locator('.mail-row__subjtext').innerText() === 'Half-written idea', 'drafts folder lists the draft')
  await page.click('.mail-row[data-draft-id="dr1"]')
  await page.waitForSelector('.mail-compose')
  ok(await page.inputValue('.mc-subject') === 'Half-written idea', 'clicking a draft opens it in compose')
  await page.fill('.mc-subject', 'Fully written idea')
  await page.click('[data-mc="save-draft"]')
  await page.waitForFunction(() => document.querySelector('.mc-status')?.textContent.includes('saved'))
  ok(S.log.some((l) => l.startsWith('PUT-DRAFT dr1 subject=Fully written idea')), 'save updates the Gmail draft')
  await page.click('[data-mc="send"]')
  await page.waitForFunction(() => !document.querySelector('.mail-compose'))
  ok(S.sends.at(-1)?.viaDraft === 'dr1' && !S.drafts.has('dr1'), 'sending a draft uses drafts.send')
  // new compose → save → discard deletes the created draft
  await page.click('[data-mail="compose"]')
  await page.waitForSelector('.mail-compose')
  await page.fill('.mc-to', 'x@example.com')
  await page.fill('.mc-subject', 'Scratch')
  await page.click('[data-mc="save-draft"]')
  await page.waitForFunction(() => document.querySelector('.mc-status')?.textContent === 'Draft saved.')
  ok(S.drafts.size === 1, 'save-draft on new compose creates a Gmail draft')
  await page.click('[data-mc="discard"]')
  await page.waitForFunction(() => !document.querySelector('.mail-compose'))
  ok(S.drafts.size === 0, 'discard deletes the draft')

  console.log('B12. user label folder')
  await page.click('[data-mail-folder="Label_1"]')
  await page.waitForSelector('.mail-row[data-thread-id="t3"]')
  ok(await page.locator('.mail-row__subjtext').innerText() === 'Your receipt', 'user label folder lists its threads')
  ok(await page.locator('#mail-folder-name').innerText() === 'Receipts', 'folder title shows label name')

  await ctx.close()
}

// C. persistence — expired access token + refresh token → silent refresh, no reconnect card
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  const S = freshState()
  await installFake(page, S)
  const refreshCalls = []
  await page.route('https://www.googleapis.com/calendar/v3/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) }))
  await page.route('https://oauth2.googleapis.com/token', async (route) => {
    const body = new URLSearchParams(route.request().postData() || '')
    refreshCalls.push(Object.fromEntries(body))
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'fresh-tok', expires_in: 3600 }) })
  })
  await page.addInitScript(() => {
    if (!localStorage.getItem('atlas.email.v1')) localStorage.setItem('atlas.email.v1', JSON.stringify({
      clientId: 'test.apps.googleusercontent.com', clientSecret: 'shhh',
      token: { access_token: 'stale', expires_at: Date.now() - 1000, refresh_token: 'refresh-me' },
      address: 'chance@example.com', pinned: [], splitPct: 42,
    }))
  })
  await page.goto(`${BASE}/#/email`)
  await page.waitForSelector('.mail-row')
  console.log('C. silent refresh (persistence)')
  ok(await page.locator('.mail-connect').count() === 0, 'expired token + refresh token skips the connect card')
  ok(refreshCalls.some((c) => c.grant_type === 'refresh_token' && c.refresh_token === 'refresh-me' && c.client_secret === 'shhh'), 'token endpoint got a refresh_token grant')
  const tok = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.email.v1')).token)
  ok(tok.access_token === 'fresh-tok' && tok.expires_at > Date.now() && tok.refresh_token === 'refresh-me', 'new access token stored, refresh token kept')
  // reload = "update atlas" — still signed in, no popup
  await page.reload()
  await page.waitForSelector('.mail-row')
  ok(await page.locator('.mail-connect').count() === 0, 'still signed in after reload')
  await page.goto(`${BASE}/#/settings`)
  await page.waitForSelector('.set-row--gmail')
  ok((await page.locator('#gmail-status').innerText()).startsWith('Connected'), 'settings shows Connected, no Reconnect nag')
  ok(await page.locator('[data-act="gmail-connect"]').count() === 0, 'no Reconnect button while renewable')
  // calendar shares the token — its guard must also pass
  await page.goto(`${BASE}/#/calendar`)
  await page.waitForSelector('.cal-toolbar, .cal-connect', { timeout: 5000 }).catch(() => {})
  ok(await page.locator('.cal-connect, .mail-connect').count() === 0, 'calendar page also stays connected')
  await ctx.close()
}

await browser.close()
console.log(`\nemail: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
