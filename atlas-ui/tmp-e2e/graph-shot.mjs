// Screenshot pass for the graph plugin (headless, real middleware + real graph).
import { chromium } from 'playwright'
const OUT = (process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp'
const DIR = OUT + '/gshot'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
await page.addInitScript((dir) => {
  localStorage.setItem('atlas.devMode', '1')
  if (!localStorage.getItem('atlas.graph.v1')) localStorage.setItem('atlas.graph.v1', JSON.stringify({ dir, mode: '2d', mdOnly: false }))
  if (!localStorage.getItem('atlas.page.v1')) localStorage.setItem('atlas.page.v1', JSON.stringify({
    v: 1, rows: [{ id: 'r1', title: 'Knowledge', cols: [
      { id: 'c1', width: 1.4, sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'gfgraph' }] }] }] },
      { id: 'c2', sections: [{ id: 's2', lines: [{ id: 'l2', widgets: [{ id: 'w2', kind: 'calagenda' }] }] }] },
    ] }],
  }))
}, DIR)
await page.route('https://www.googleapis.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }))
await page.goto('http://localhost:5173/#/graph')
await page.waitForSelector('.gf-stage canvas')
await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('nodes'))
await page.waitForTimeout(3500) // let the layout settle + zoomToFit
// open a node card
const pt = await page.evaluate(() => {
  const g = window.__gf.graph
  const n = g.graphData().nodes.find((x) => x.label === 'atlas.md') || g.graphData().nodes[0]
  const c = g.graph2ScreenCoords(n.x, n.y)
  const r = document.querySelector('.gf-stage canvas').getBoundingClientRect()
  return { x: r.x + c.x, y: r.y + c.y }
})
await page.mouse.click(pt.x, pt.y)
await page.waitForSelector('.gf-card:not([hidden])')
await page.screenshot({ path: `${OUT}/graph-2d.png` })
// preview modal
await page.click('[data-gf="preview"]')
await page.waitForSelector('.gf-overlay .cv-annbody, .gf-overlay .gf-prevtext')
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/graph-preview.png` })
await page.click('[data-gf="overlay-close"]')
// 3D
await page.click('[data-gf="mode"][data-v="3d"]')
await page.waitForTimeout(6000)
await page.screenshot({ path: `${OUT}/graph-3d.png` })
await browser.close()
console.log('shots done')
