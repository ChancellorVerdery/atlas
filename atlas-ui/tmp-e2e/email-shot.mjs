// Screenshot pass for the email plugin (headless, fake Gmail API).
import { chromium } from 'playwright'
const OUT = (process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp'
const BASE = 'http://localhost:5173'
const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url')

const D = Date.now()
const mk = (id, tid, from, subject, html, text, date, labels) => ({
  id, threadId: tid, labelIds: labels, snippet: text.slice(0, 90), internalDate: String(date),
  payload: { mimeType: 'multipart/alternative', headers: [
    { name: 'From', value: from }, { name: 'To', value: 'chance@example.com' },
    { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@x>` } ],
    parts: [ { mimeType: 'text/plain', body: { data: b64u(text) } }, ...(html ? [{ mimeType: 'text/html', body: { data: b64u(html) } }] : []) ] },
})
const threads = new Map([
  ['t1', { id: 't1', messages: [mk('m1', 't1', 'Ada Lovelace <ada@analytical.example>', 'Engine schematics for the new mill',
    '<h2 style="margin:0 0 8px">Analytical Engine — Mill Revision</h2><p>The <b>carry-anticipation</b> gears are ready for review. Full drawings attached below; the punched-card reader now supports <i>conditional branching</i>.</p><ul><li>Store: 1,000 numbers at 40 digits</li><li>Mill: four operations, parallel carry</li><li>Output: printer, curve plotter, bell</li></ul><p>— Ada</p>',
    'The carry-anticipation gears are ready for review.', D - 40 * 60e3, ['INBOX', 'UNREAD'])] }],
  ['t2', { id: 't2', messages: [
    mk('m2a', 't2', 'Grace Hopper <grace@navy.example>', 'Compiler notes', '', 'First draft of the A-0 system notes.', D - 2 * 86400e3, ['INBOX']),
    mk('m2b', 't2', 'Grace Hopper <grace@navy.example>', 'Re: Compiler notes', '<p>A ship in port is safe, but that is not what ships are built for. <b>Nanoseconds matter.</b></p>', 'Nanoseconds matter.', D - 86400e3, ['INBOX', 'STARRED'])] }],
  ['t3', { id: 't3', messages: [mk('m3', 't3', 'Atlas Weekly <digest@atlas.example>', 'Your week in review', '', 'Three workouts completed, two equations added.', D - 3 * 86400e3, ['INBOX'])] }],
  ['t4', { id: 't4', messages: [mk('m4', 't4', 'Margaret Hamilton <mh@apollo.example>', 'Priority displays', '', 'The 1201 alarm handling is in.', D - 4 * 86400e3, ['INBOX'])] }],
])
const labels = [...['INBOX', 'STARRED', 'SENT', 'DRAFT', 'SPAM', 'TRASH'].map((id) => ({ id, name: id, type: 'system' })),
  { id: 'Label_1', name: 'Receipts', type: 'user', labelListVisibility: 'labelShow' }]

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
await page.route('https://gmail.googleapis.com/**', (route) => {
  const u = new URL(route.request().url())
  const path = u.pathname.replace('/gmail/v1/users/me/', '')
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
  if (path === 'profile') return json({ emailAddress: 'chance@example.com' })
  if (path === 'labels') return json({ labels })
  if (path === 'threads') {
    const l = u.searchParams.get('labelIds')
    const list = [...threads.values()].filter((t) => !l || t.messages.some((m) => m.labelIds.includes(l)))
    return json({ threads: list.map((t) => ({ id: t.id })) })
  }
  const m = path.match(/^threads\/([^/]+)$/)
  if (m) return json(threads.get(m[1]))
  if (path === 'drafts') return json({ drafts: [] })
  return json({})
})
await page.addInitScript(() => {
  localStorage.setItem('atlas.email.v1', JSON.stringify({
    clientId: 'test.apps.googleusercontent.com',
    token: { access_token: 'tok', expires_at: Date.now() + 3600e3 },
    address: 'chance@example.com', pinned: ['t4'], splitPct: 40,
  }))
})
await page.goto(`${BASE}/#/email`)
await page.waitForSelector('.mail-row')
await page.click('.mail-row[data-thread-id="t1"]')
await page.waitForSelector('.mail-frame')
await new Promise((r) => setTimeout(r, 600))
await page.screenshot({ path: `${OUT}/email-inbox.png` })
await page.click('[data-mail="compose"]')
await page.click('.mc-body')
await page.keyboard.type('Drafting a note with the ')
await page.click('.mail-tool[data-cmd="bold"]')
await page.keyboard.type('rich text')
await page.click('.mail-tool[data-cmd="bold"]')
await page.keyboard.type(' toolbar.')
await page.fill('.mc-to', 'ada@analytical.example')
await page.fill('.mc-subject', 'Re: gears')
await page.screenshot({ path: `${OUT}/email-compose.png` })
await page.click('[data-mc="close"]')
await page.click('[data-mail="toggle-nav"]')
await page.screenshot({ path: `${OUT}/email-nav-hidden.png` })

// connect card + settings (fresh context, no token)
const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 } })
const p2 = await ctx2.newPage()
await p2.goto(`${BASE}/#/email`)
await p2.waitForSelector('.mail-connect')
await p2.screenshot({ path: `${OUT}/email-connect.png` })
await p2.goto(`${BASE}/#/settings`)
await p2.waitForSelector('#gmail-client-id')
await p2.screenshot({ path: `${OUT}/email-settings.png` })
await browser.close()
console.log('shots done')
