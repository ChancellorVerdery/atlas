// Measures mean inter-community centroid distance on a 4-cluster fixture.
import { chromium } from 'playwright'
const BASE = 'http://localhost:5173'
const nodes = [], links = []
for (let c = 0; c < 4; c++) {
  for (let i = 0; i < 8; i++) {
    nodes.push({ id: `c${c}n${i}`, label: `n${i}`, source_file: `f${c}${i}.md`, file_type: 'document', community: c })
    if (i) links.push({ source: `c${c}n0`, target: `c${c}n${i}`, relation: 'links', confidence: 'EXTRACTED' })
  }
}
// one weak bridge between communities so it's one connected graph
links.push({ source: 'c0n0', target: 'c1n0', relation: 'links' }, { source: 'c1n0', target: 'c2n0', relation: 'links' }, { source: 'c2n0', target: 'c3n0', relation: 'links' })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.route('**/graph-api/**', (route) => {
  const u = new URL(route.request().url())
  const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
  if (u.pathname === '/graph-api/graph') return json({ nodes, links })
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
await page.waitForFunction(() => window.__gf?.graph && window.__gf.graph.graphData().nodes.every((n) => n.x !== undefined), null, { timeout: 20000 })
await page.waitForTimeout(5000) // full settle
const spread = await page.evaluate(() => {
  const ns = window.__gf.graph.graphData().nodes
  const cent = {}
  for (const n of ns) { (cent[n.community] ??= { x: 0, y: 0, k: 0 }); cent[n.community].x += n.x; cent[n.community].y += n.y; cent[n.community].k++ }
  const cs = Object.values(cent).map((c) => ({ x: c.x / c.k, y: c.y / c.k }))
  let sum = 0, m = 0
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) { sum += Math.hypot(cs[i].x - cs[j].x, cs[i].y - cs[j].y); m++ }
  return sum / m
})
console.log('mean inter-community centroid distance:', spread.toFixed(1))
await browser.close()
