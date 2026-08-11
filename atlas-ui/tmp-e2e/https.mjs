// wss-through-caddy check: handshake + hello on both sockets, and a real
// login-path probe (auth.login with bogus creds must round-trip an error).
// Logs every socket event so a hang shows WHERE it hung.
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
const out = await page.evaluate(async () => {
  const events = []
  const helloOn = (url) => new Promise((resolve, reject) => {
    const tag = url.split('/').pop()
    const ws = new WebSocket(url)
    const t = setTimeout(() => reject(new Error(tag + ': timeout, readyState=' + ws.readyState + ' events=' + JSON.stringify(events))), 15000)
    ws.onerror = () => events.push(tag + ':error')
    ws.onclose = (ev) => events.push(tag + ':close:' + ev.code)
    ws.onopen = () => { events.push(tag + ':open'); ws.send(JSON.stringify({ type: 'hello', sessionId: String(Math.random()) })) }
    ws.onmessage = (ev) => { clearTimeout(t); events.push(tag + ':msg'); resolve({ ws, msg: JSON.parse(ev.data) }) }
  })
  const inbox = await helloOn('wss://sync.myatlasapp.net/inbox')
  const outbox = await helloOn('wss://sync.myatlasapp.net/outbox')
  const login = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('login probe: timeout')), 15000)
    inbox.ws.onmessage = (ev) => { clearTimeout(t); resolve(JSON.parse(ev.data)) }
    inbox.ws.send(JSON.stringify({ reqId: 'r1', code: 'auth.login', payload: { email: 'nobody@example.com', password: 'wrong' } }))
  })
  return { events, inboxHello: inbox.msg, outboxHello: outbox.msg, login }
})
await browser.close()

console.log(JSON.stringify(out, null, 2))
const ok = out.inboxHello.type === 'hello' && out.outboxHello.type === 'hello'
  && out.login.reqId === 'r1' && out.login.ok === false
console.log(ok ? 'PASS' : 'FAIL')
process.exit(ok ? 0 : 1)
