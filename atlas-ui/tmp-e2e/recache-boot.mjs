// Does a normal launch REFRESH the device cache, or does it just repaint last
// launch's copy forever?
//
// Warm-cache boot, Google already connected (the steady state after the user
// has connected once), Email + Calendar enabled, and a DAY-OLD atlasCache.*
// entry seeded for each. The boot prefetch (src/page/prefetch.js) is supposed
// to fetch and rewrite those. This measures whether it does.
//
// No backend: window.WebSocket is a fake modelling the real split (inbox out,
// outbox back, outbox trails) with realistic latency.
// Run: node tmp-e2e/recache-boot.mjs
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
const ADDR = 'alex.morgan@example.com'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok   ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const browser = await chromium.launch({ headless: true })

async function launch({ connectedLocally, warmCache = true, route = 'dashboard', statusLagMs = 0, serverConnected = true }) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  await ctx.addInitScript(({ addr, connectedLocally, warmCache, statusLagMs, serverConnected }) => {
    const USER = 'user-1'
    const DAY = 86_400_000
    localStorage.setItem('atlas.auth.v1', JSON.stringify({ token: 't', userId: USER, email: addr }))
    localStorage.setItem('atlasLastUser', USER)
    if (warmCache) {
      localStorage.setItem('atlas.plugins.v1', JSON.stringify({ enabled: { email: true, calendar: true }, installed: {} }))
      localStorage.setItem('atlas.page.v1', JSON.stringify({ v: 1, rows: [] }))
    }
    localStorage.setItem('atlas.email.v1', JSON.stringify({
      pinned: [], splitPct: 42,
      ...(connectedLocally ? { connected: true, address: addr, accounts: [addr] } : {}),
    }))
    localStorage.setItem('atlas.calendar.v1', JSON.stringify({ hiddenCals: [], view: 'month' }))

    // Yesterday's cache, with content that is obviously not what the server has now.
    const stale = (k, v) => localStorage.setItem('atlasCache.' + k, JSON.stringify({ at: Date.now() - DAY, value: v }))
    stale(`email.threads.${addr}.INBOX`, { threads: [{ id: 'stale', subject: 'STALE SUBJECT', from: 'x', date: 1, snippet: '', count: 1, _account: addr }], nextPageToken: null })
    stale('calendar.cals', [{ id: 'primary', summary: 'STALE CALENDAR', backgroundColor: '#111' }])

    // ---- fake sync backend -------------------------------------------------
    const INBOX_OPEN = 600, OUTBOX_LAG = 600, RTT = 120
    const out = { sock: null, acked: false }
    window.__calls = []            // every google.api url the app asked for
    window.__dropped = 0

    class FakeWS {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3
      constructor(url) {
        this.url = url
        this.isInbox = !/outbox/.test(url)
        this.readyState = 0
        if (!this.isInbox) out.sock = this
        setTimeout(() => { this.readyState = 1; this.onopen && this.onopen() },
          this.isInbox ? INBOX_OPEN : INBOX_OPEN + OUTBOX_LAG)
      }
      deliver(obj) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }) }
      reply(obj) {
        if (out.sock && out.acked && out.sock.readyState === 1) out.sock.deliver(obj)
        else window.__dropped++
      }
      send(raw) {
        let m; try { m = JSON.parse(raw) } catch { return }
        if (m.type === 'hello') {
          if (!this.isInbox) out.acked = true
          return this.deliver({ type: 'hello', ok: true, userId: USER, email: addr })
        }
        if (!m.reqId) return
        let data = {}
        if (m.code === 'sync.pull.all') {
          // The email mapper drops connected/address/accounts — the server copy
          // genuinely has no Google connection fields in it.
          data = { states: {
            'atlas.email.v1': JSON.stringify({ pinned: [], splitPct: 42 }),
            'atlas.calendar.v1': JSON.stringify({ hiddenCals: [], view: 'month' }),
            'atlas.plugins.v1': JSON.stringify({ enabled: { email: true, calendar: true }, installed: {} }),
            'atlas.page.v1': JSON.stringify({ v: 1, rows: [] }),
          } }
        } else if (m.code === 'google.auth.status') {
          data = serverConnected ? { connected: true, address: addr, accounts: [addr] } : { connected: false, accounts: [] }
        } else if (m.code === 'google.config') {
          data = { clientId: 'x.apps.googleusercontent.com', scopes: 's', configured: true }
        } else if (m.code === 'google.api') {
          const url = m.payload?.url || ''
          window.__calls.push(url)
          if (url.includes('calendarList')) data = { items: [{ id: 'primary', summary: 'FRESH CALENDAR', backgroundColor: '#222' }] }
          else if (url.includes('/events?')) data = { items: [{ id: 'ev1', summary: 'FRESH EVENT', start: { dateTime: new Date().toISOString() }, end: { dateTime: new Date().toISOString() } }] }
          else if (/\/threads\?/.test(url)) data = { threads: [{ id: 'fresh1' }] }
          else if (/\/threads\//.test(url)) data = { id: 'fresh1', messages: [{ id: 'm1', internalDate: String(Date.now()), snippet: 'FRESH SNIPPET', labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'FRESH SUBJECT' }, { name: 'From', value: 'a@b.c' }] } }] }
        }
        const lag = m.code === 'google.auth.status' ? RTT + statusLagMs : RTT
        setTimeout(() => this.reply({ reqId: m.reqId, ok: true, data }), lag)
      }
      close() { this.readyState = 3; if (!this.isInbox) out.acked = false; this.onclose && this.onclose() }
    }
    window.WebSocket = FakeWS
  }, { addr: ADDR, connectedLocally, warmCache, statusLagMs: statusLagMs || 0, serverConnected })

  const page = await ctx.newPage()
  await page.goto(`${BASE}/#/${route}`)
  return { ctx, page }
}

const cacheEntry = (page, key) => page.evaluate((k) => {
  try { return JSON.parse(localStorage.getItem('atlasCache.' + k)) } catch { return null }
}, key)

const DAY = 86_400_000
const isFresh = (e) => !!e && Date.now() - e.at < 60_000

// ---------------------------------------------------------------------------
console.log('\nA. warm boot, Google connected in the local cache (the steady state)')
{
  const { ctx, page } = await launch({ connectedLocally: true })
  await page.waitForTimeout(6000) // sockets up ~1.2s, prefetch fires on hydrate

  const mail = await cacheEntry(page, `email.threads.${ADDR}.INBOX`)
  const cals = await cacheEntry(page, 'calendar.cals')
  const calls = await page.evaluate(() => window.__calls)
  console.log(`   google.api calls: ${calls.length}${calls.length ? ' → ' + calls.map((u) => u.replace(/^https:\/\/[^/]+/, '')).slice(0, 4).join(' | ') : ''}`)
  console.log(`   mail cache age: ${mail ? Math.round((Date.now() - mail.at) / 1000) + 's' : 'absent'}; subject: ${mail?.value?.threads?.[0]?.subject}`)
  console.log(`   cals cache age: ${cals ? Math.round((Date.now() - cals.at) / 1000) + 's' : 'absent'}; summary: ${cals?.value?.[0]?.summary}`)

  ok(calls.length > 0, 'the boot prefetch actually hit the Google API')
  ok(isFresh(mail), 'mail cache was REWRITTEN this launch (not still a day old)')
  ok(mail?.value?.threads?.[0]?.subject === 'FRESH SUBJECT', 'mail cache holds the server\'s current data')
  ok(isFresh(cals), 'calendar cache was REWRITTEN this launch')
  ok(cals?.value?.[0]?.summary === 'FRESH CALENDAR', 'calendar cache holds the server\'s current data')
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\nB. warm boot on a device whose local copy has no Google flags')
console.log('   (a fresh device, or any boot where the pull landed first)')
{
  const { ctx, page } = await launch({ connectedLocally: false })
  await page.waitForTimeout(6000)

  const connected = await page.evaluate(() => { try { return !!JSON.parse(localStorage.getItem('atlasGoogle')).connected } catch { return null } })
  const mail = await cacheEntry(page, `email.threads.${ADDR}.INBOX`)
  const cals = await cacheEntry(page, 'calendar.cals')
  const calls = await page.evaluate(() => window.__calls)
  console.log(`   connected flag after boot: ${connected}`)
  console.log(`   google.api calls: ${calls.length}`)
  console.log(`   mail cache age: ${mail ? Math.round((Date.now() - mail.at) / 1000) + 's' : 'absent'}`)
  console.log(`   cals cache age: ${cals ? Math.round((Date.now() - cals.at) / 1000) + 's' : 'absent'}`)

  ok(connected === true, 'the server view was adopted (Email/Calendar are usable)')
  ok(calls.length > 0, 'the boot prefetch still ran once the status landed')
  ok(isFresh(mail), 'mail cache was rewritten')
  ok(isFresh(cals), 'calendar cache was rewritten')
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\nC. launch straight onto the Mail page (the user\'s actual path)')
{
  const { ctx, page } = await launch({ connectedLocally: true, route: 'email' })
  await page.waitForTimeout(9000)

  const mail = await cacheEntry(page, `email.threads.${ADDR}.INBOX`)
  const body = await page.evaluate(() => document.body.innerText)
  const calls = await page.evaluate(() => window.__calls)
  console.log(`   google.api calls: ${calls.length}`)
  console.log(`   mail cache age: ${mail ? Math.round((Date.now() - mail.at) / 1000) + 's' : 'absent'}; subject: ${mail?.value?.threads?.[0]?.subject}`)
  console.log(`   on screen: connect-gate=${body.includes('Connect your Gmail') || body.includes('Reconnect Gmail')} stale=${body.includes('STALE SUBJECT')} fresh=${body.includes('FRESH SUBJECT')}`)

  ok(!body.includes('Connect your Gmail'), 'Mail did not sit on the Connect gate')
  ok(isFresh(mail), 'mail cache was rewritten while the page was open')
  ok(body.includes('FRESH SUBJECT') && !body.includes('STALE SUBJECT'), 'the list on screen shows current mail, not last launch\'s')
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\nD. launch straight onto the Calendar page')
{
  const { ctx, page } = await launch({ connectedLocally: true, route: 'calendar' })
  await page.waitForTimeout(9000)

  const cals = await cacheEntry(page, 'calendar.cals')
  const evKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('atlasCache.calendar.events.')))
  const body = await page.evaluate(() => document.body.innerText)
  console.log(`   cals cache age: ${cals ? Math.round((Date.now() - cals.at) / 1000) + 's' : 'absent'}; summary: ${cals?.value?.[0]?.summary}`)
  console.log(`   event-range cache keys: ${evKeys.length}`)
  console.log(`   on screen: connect-gate=${body.includes('Connect') && body.includes('Google')} fresh-event=${body.includes('FRESH EVENT')}`)

  ok(!/Connect your Gmail|Reconnect Gmail/.test(body), 'Calendar did not sit on the Connect gate')
  ok(isFresh(cals), 'calendar list cache was rewritten')
  ok(evKeys.length > 0, 'an event range was cached for this view')
  ok(body.includes('FRESH EVENT'), 'the grid shows the server\'s current events')
  await ctx.close()
}


// ---------------------------------------------------------------------------
console.log('\nE. same launch, but the Google-status reply is slower than the profile pull')
console.log('   (google.auth.status does a DB read + token check; sync.pull.all is a warm read)')
{
  const { ctx, page } = await launch({ connectedLocally: true, statusLagMs: 900 })
  await page.waitForTimeout(9000)

  const connected = await page.evaluate(() => { try { return !!JSON.parse(localStorage.getItem('atlasGoogle')).connected } catch { return null } })
  const mail = await cacheEntry(page, `email.threads.${ADDR}.INBOX`)
  const cals = await cacheEntry(page, 'calendar.cals')
  const calls = await page.evaluate(() => window.__calls)
  console.log(`   connected flag after boot: ${connected}`)
  console.log(`   google.api calls: ${calls.length}`)
  console.log(`   mail cache age: ${mail ? Math.round((Date.now() - mail.at) / 1000) + 's' : 'absent'}; subject: ${mail?.value?.threads?.[0]?.subject}`)
  console.log(`   cals cache age: ${cals ? Math.round((Date.now() - cals.at) / 1000) + 's' : 'absent'}; summary: ${cals?.value?.[0]?.summary}`)

  ok(calls.length > 0, 'the boot prefetch still ran')
  ok(isFresh(mail), 'mail cache was rewritten (not still yesterday\'s)')
  ok(isFresh(cals), 'calendar cache was rewritten')
  await ctx.close()
}

// ---------------------------------------------------------------------------
console.log('\nF. Mail page, slow Google-status reply')
{
  const { ctx, page } = await launch({ connectedLocally: true, route: 'email', statusLagMs: 900 })
  await page.waitForTimeout(9000)
  const body = await page.evaluate(() => document.body.innerText)
  const mail = await cacheEntry(page, `email.threads.${ADDR}.INBOX`)
  console.log(`   on screen: connect-gate=${/Connect your Gmail|Reconnect Gmail/.test(body)} stale=${body.includes('STALE SUBJECT')} fresh=${body.includes('FRESH SUBJECT')}`)
  console.log(`   mail cache age: ${mail ? Math.round((Date.now() - mail.at) / 1000) + 's' : 'absent'}`)
  ok(!/Connect your Gmail|Reconnect Gmail/.test(body), 'Mail did not fall back to the Connect gate')
  ok(isFresh(mail), 'mail cache was rewritten')
  await ctx.close()
}


// ---------------------------------------------------------------------------
console.log('\nG. the Google connection must never sit in a key the pull can overwrite')
{
  const { ctx, page } = await launch({ connectedLocally: true, statusLagMs: 900 })
  await page.waitForTimeout(6000)
  const leaked = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('atlas.') && /"(connected|accounts)":/.test(localStorage.getItem(k) || '')))
  const local = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('atlasGoogle')) } catch { return null } })
  console.log(`   synced keys carrying connection fields: ${leaked.join(',') || 'none'}`)
  console.log(`   atlasGoogle: connected=${local?.connected} accounts=${(local?.accounts || []).length}`)
  ok(leaked.length === 0, 'no atlas.* (synced) key carries connected/accounts')
  ok(local?.connected === true, 'the device-local copy survived the boot pull')
  await ctx.close()
}


// ---------------------------------------------------------------------------
console.log('\nH. the gate must still appear when the connection is genuinely gone')
console.log('   (device cache says connected, server says no — the server wins)')
{
  const { ctx, page } = await launch({ connectedLocally: true, route: 'email', serverConnected: false })
  await page.waitForTimeout(7000)
  const body = await page.evaluate(() => document.body.innerText)
  const local = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('atlasGoogle')) } catch { return null } })
  console.log(`   atlasGoogle.connected: ${local?.connected}`)
  console.log(`   on screen: connect-gate=${/Connect your Gmail|Reconnect Gmail/.test(body)}`)
  ok(local?.connected === false, 'the stale local flag was corrected to disconnected')
  ok(/Connect your Gmail|Reconnect Gmail/.test(body), 'Mail shows the Connect gate')
  await ctx.close()
}


await browser.close()
console.log(`\nrecache-boot: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
