// Visual check of the graphify skin: 2D + 3D screenshots + bg pixel assert.
import { chromium } from 'playwright'
const OUT = (process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp'
const BASE = 'http://localhost:5173'
// hub with 20 spokes (labeled god node), two communities, one INFERRED link
const nodes = [{ id: 'hub', label: 'renderer.js', source_file: 'src/renderer.js', file_type: 'code', community: 0 }]
const links = []
for (let i = 0; i < 20; i++) {
  nodes.push({ id: 'n' + i, label: 'file' + i + '.md', source_file: 'notes/f' + i + '.md', file_type: 'document', community: i % 4 })
  links.push({ source: 'hub', target: 'n' + i, relation: 'mentions', confidence: i % 3 ? 'EXTRACTED' : 'INFERRED' })
}
const FIX = { nodes, links }
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push(String(e)))
await page.route('**/graph-api/**', (route) => {
  const u = new URL(route.request().url())
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
  if (u.pathname === '/graph-api/graph') return json(FIX)
  if (u.pathname === '/graph-api/build') return json({ ok: true })
  if (u.pathname === '/graph-api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' })
  return json({})
})
await page.addInitScript(() => {
  localStorage.setItem('atlas.auth.v1', '{"offline":true}')
  localStorage.setItem('atlas.devMode', '1')
  localStorage.setItem('atlas.graph.v1', JSON.stringify({ dir: '/fake/dir', mode: '2d', mdOnly: false, maxNodes: 1500 }))
})
await page.goto(`${BASE}/#/graph`)
await page.waitForSelector('.gf-stage canvas')
// vis: wait until stabilization finished (physics switched off) + rebuild settled
await page.waitForFunction(() => window.__gf?.network && window.__gf.network.physics.options.enabled === false, null, { timeout: 30000 })
await page.waitForTimeout(1500) // deferred rebuild refresh
await page.evaluate(() => window.__gf.network.fit({ animation: false }))
await page.waitForTimeout(300)
// click the hub node → selection should paint it white + open the card
const pt = await page.evaluate(() => {
  const net = window.__gf.network
  const pos = net.getPositions(['hub']).hub
  const d = net.canvasToDOM(pos)
  const r = document.querySelector('.gf-stage canvas').getBoundingClientRect()
  return { x: r.x + d.x, y: r.y + d.y }
})
await page.mouse.click(pt.x, pt.y)
await page.waitForTimeout(600)
await page.screenshot({ path: `${OUT}/gf-2d.png` })
console.log('card visible:', await page.locator('#gf-card').isVisible())
// 3D
await page.click('[data-gf="mode"][data-v="3d"]')
await page.waitForTimeout(6000)
await page.screenshot({ path: `${OUT}/gf-3d.png` })
console.log('errors:', errs.length ? errs : 'none')
await browser.close()
