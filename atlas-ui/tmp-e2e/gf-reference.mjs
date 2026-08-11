// Screenshot the REAL graphify graph.html for visual comparison.
import { chromium } from 'playwright'
const OUT = (process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp'
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto('file://~/Desktop/graphify-out/graph.html')
await page.waitForSelector('#graph canvas', { timeout: 30000 })
await page.waitForTimeout(12000) // stabilization (2850 nodes)
await page.screenshot({ path: `${OUT}/graphify-reference.png` })
// zoom in a bit for node-level detail
await page.mouse.move(560, 450)
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -400); await page.waitForTimeout(200) }
await page.waitForTimeout(500)
await page.screenshot({ path: `${OUT}/graphify-reference-zoom.png` })
console.log('reference shots done')
await browser.close()
