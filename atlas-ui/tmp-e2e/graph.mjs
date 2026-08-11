// Graph plugin suite. Three layers:
//   0. real middleware endpoints (plain fetch — graph/file/build/traversal guard)
//   A/B. browser with /graph-api faked at page.route (no Finder dialogs, no builds)
//   C. real end-to-end: live dir + real graphify rebuild + SSE update
// Headless always. The Finder picker and reveal are never really invoked.
import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name, extra = '') => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const GTEST = (process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp/gtest'

// ---- 0. real middleware --------------------------------------------------------
{
  console.log('0. middleware (real)')
  const g = await fetch(`${BASE}/graph-api/graph?dir=${encodeURIComponent(GTEST)}`).then((r) => r.json())
  ok(g.nodes?.length >= 9 && g.links?.length >= 6, `graph.json served (${g.nodes?.length} nodes)`)
  ok(g.nodes.every((n) => 'source_file' in n && 'community' in n), 'nodes carry source_file + community')
  const missing = await fetch(`${BASE}/graph-api/graph?dir=${encodeURIComponent(GTEST + '/notes')}`)
  ok(missing.status === 404 && (await missing.json()).needsBuild, 'unbuilt dir → 404 needsBuild')
  const file = await fetch(`${BASE}/graph-api/file?dir=${encodeURIComponent(GTEST)}&path=notes/index.md`).then((r) => r.text())
  ok(file.includes('# Project Atlas'), 'file endpoint serves contents')
  const esc404 = await fetch(`${BASE}/graph-api/file?dir=${encodeURIComponent(GTEST)}&path=../../../../etc/hosts`)
  ok(esc404.status === 404, 'path traversal blocked')
  const bad = await fetch(`${BASE}/graph-api/graph?dir=/definitely/not/here`)
  ok(bad.status === 400, 'nonexistent dir rejected')
  const built = await fetch(`${BASE}/graph-api/build?dir=${encodeURIComponent(GTEST)}`, { method: 'POST' })
  ok(built.ok && (await built.json()).ok, 'headless graphify build succeeds')
}

// ---- fixtures + fake api for browser parts ------------------------------------
const FIX = {
  nodes: [
    { id: 'na', label: 'alpha.md', source_file: 'notes/alpha.md', file_type: 'document', community: 0 },
    { id: 'nb', label: 'Beta heading', source_file: 'notes/beta.md', file_type: 'document', community: 0 },
    { id: 'c1', label: 'x.js', source_file: 'src/x.js', file_type: 'code', community: 1 },
    { id: 'c2', label: 'run()', source_file: 'src/x.js', file_type: 'code', community: 1, type: 'function' },
  ],
  links: [
    { source: 'na', target: 'nb', relation: 'links_to' },
    { source: 'c1', target: 'c2', relation: 'contains' },
    { source: 'na', target: 'c1', relation: 'mentions' },
  ],
}
const FIX2 = { nodes: [...FIX.nodes, { id: 'nc', label: 'gamma.md', source_file: 'notes/gamma.md', file_type: 'document', community: 0 }], links: FIX.links }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function installFake(page, state) {
  return page.route('**/graph-api/**', (route) => {
    const u = new URL(route.request().url())
    state.calls.push(u.pathname + '?' + u.searchParams.toString())
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) })
    if (u.pathname === '/graph-api/graph') return json(state.updated ? FIX2 : FIX)
    if (u.pathname === '/graph-api/build') return json({ ok: true })
    if (u.pathname === '/graph-api/events')
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${state.nextEvent}\n\n` })
    if (u.pathname === '/graph-api/reveal') { state.revealed.push(u.searchParams.get('path')); return json({ ok: true }) }
    if (u.pathname === '/graph-api/file') {
      const p = u.searchParams.get('path')
      if (p.endsWith('.png')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
      return route.fulfill({ status: 200, contentType: 'text/markdown', body: '# Alpha Note\n\nHello **world**.\n\n<script>window.pwned=1</script>' })
    }
    return json({ error: 'unhandled ' + u.pathname }, 500)
  })
}

const browser = await chromium.launch({ headless: true })

// ---- A. no directory chosen -----------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}')) // login gate

  await page.goto(`${BASE}/#/graph`)
  await page.waitForSelector('.gf-empty')
  console.log('A. unconfigured')
  ok(await page.locator('#title').innerText() === 'Graph', 'topbar label says Graph')
  ok(await page.locator('.nav__item', { hasText: 'Graph' }).count() === 1, 'Graph appears in sidebar nav')
  ok((await page.locator('.gf-empty').innerText()).includes('graphify'), 'empty state explains the plugin')
  ok(await page.locator('#customize').isHidden(), 'Customize button hidden on graph page')
  ok(await page.locator('[data-gf="pick"]').count() >= 1, 'Choose folder button present')
  await ctx.close()
}

// ---- B. faked api: render, card, preview, reveal, filters, modes, live update ----
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}')) // login gate

  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  const state = { calls: [], revealed: [], updated: false, nextEvent: 'watching' }
  await installFake(page, state)
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1') // exposes window.__gf test hook
    if (!localStorage.getItem('atlas.graph.v1')) localStorage.setItem('atlas.graph.v1', JSON.stringify({ dir: '/fake/project', mode: '2d', mdOnly: false }))
  })
  await page.goto(`${BASE}/#/graph`)
  await page.waitForSelector('.gf-stage canvas')
  console.log('B1. 2D render')
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('nodes'))
  ok((await page.locator('#gf-status').innerText()).includes('4 nodes · 3 links'), 'status shows node/link counts')
  ok((await page.locator('.gf-dir').innerText()) === 'project', 'toolbar shows the folder name')

  console.log('B2. node card (bottom-left)')
  // vis stabilizes hidden, then physics goes off — board is static from then on
  await page.waitForFunction(() => window.__gf?.network && window.__gf.network.physics.options.enabled === false, null, { timeout: 30000 })
  const bWait = Date.now()
  while (!state.calls.some((c) => c.startsWith('/graph-api/build')) && Date.now() - bWait < 15000) await sleep(200)
  await sleep(500) // deferred-rebuild refresh (DataSet diff, positions kept)
  await page.evaluate(() => window.__gf.network.fit({ animation: false }))
  await sleep(250)
  const pt = await page.evaluate(() => {
    const net = window.__gf.network
    const d = net.canvasToDOM(net.getPositions(['na']).na)
    const r = document.querySelector('.gf-stage canvas').getBoundingClientRect()
    return { x: r.x + d.x, y: r.y + d.y }
  })
  await page.mouse.move(pt.x, pt.y) // hover first — vis resolves clicks via hover (graph.html does the same)
  await sleep(300)
  await page.mouse.click(pt.x, pt.y)
  await page.waitForSelector('.gf-card:not([hidden])')
  ok((await page.locator('.gf-card__title').innerText()) === 'alpha.md', 'clicking a node opens its card')
  const cardBox = await page.locator('.gf-card').boundingBox()
  const stageBox = await page.locator('.gf-stage').boundingBox()
  ok(cardBox.x < stageBox.x + 40 && cardBox.y + cardBox.height > stageBox.y + stageBox.height - 40, 'card sits bottom-left of the graph')
  ok((await page.locator('.gf-card__file').innerText()) === 'notes/alpha.md', 'card shows the source file')

  console.log('B3. preview + reveal')
  await page.click('[data-gf="preview"]')
  await page.waitForSelector('.gf-overlay .cv-annbody h1')
  ok((await page.locator('.gf-overlay .cv-annbody h1').innerText()) === 'Alpha Note', 'markdown preview renders formatted')
  ok((await page.locator('.gf-overlay .cv-annbody').innerText()).includes('world'), 'markdown body rendered')
  ok(await page.evaluate(() => window.pwned) === undefined, 'scripts stripped from markdown preview')
  await page.click('[data-gf="overlay-close"]')
  await page.waitForSelector('.gf-overlay', { state: 'detached' })
  await page.click('[data-gf="reveal"]')
  await page.waitForFunction(() => true)
  await sleep(150)
  ok(state.revealed.includes('notes/alpha.md'), 'reveal calls the Finder endpoint with the node path')

  console.log('B4. markdown filter')
  await page.click('[data-gf="md"][data-v="1"]')
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('2 nodes'))
  ok((await page.locator('#gf-status').innerText()).includes('2 nodes · 1 links'), 'markdown-only keeps md nodes + their links')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.graph.v1')).mdOnly) === true, 'filter persisted')
  await page.click('[data-gf="md"][data-v=""]')
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('4 nodes'))
  ok(true, 'back to all files')

  console.log('B5. 3D mode')
  await page.click('[data-gf="mode"][data-v="3d"]')
  await page.waitForTimeout(2500) // three.js dynamic import + first frame
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.graph.v1')).mode) === '3d', '3D mode persisted')
  ok(await page.locator('.gf-stage canvas').count() >= 1, '3D canvas mounted')
  ok(!errs.some((e) => /webgl|three/i.test(e)), `no 3D errors (${errs.join(' | ').slice(0, 120)})`)
  await page.click('[data-gf="mode"][data-v="2d"]')
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('4 nodes'))
  ok(true, 'switches back to 2D')

  console.log('B6. live update via SSE')
  state.updated = true
  state.nextEvent = 'updated' // EventSource reconnects (~3s) and receives it
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('5 nodes'), null, { timeout: 15000 })
  ok(true, 'directory change event refreshes the graph in place (4 → 5 nodes)')
  ok(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 200)})`)
  await ctx.close()
}

// ---- B7. dashboard widget --------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}')) // login gate

  const state = { calls: [], revealed: [], updated: false, nextEvent: 'watching' }
  await installFake(page, state)
  await page.addInitScript(() => {
    if (!localStorage.getItem('atlas.graph.v1')) localStorage.setItem('atlas.graph.v1', JSON.stringify({ dir: '/fake/project', mode: '2d', mdOnly: false }))
    if (!localStorage.getItem('atlas.page.v1')) localStorage.setItem('atlas.page.v1', JSON.stringify({
      v: 1, rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'gfgraph' }] }] }] }] }],
    }))
  })
  await page.goto(`${BASE}/#/dashboard`)
  await page.waitForSelector('.pwidget--gfgraph canvas')
  console.log('B7. dashboard widget')
  ok(true, 'widget hydrates with a live canvas')
  const box = await page.locator('.gf-wmount').boundingBox()
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForFunction(() => location.hash === '#/graph')
  ok(true, 'clicking the widget jumps to the Graph page')
  await ctx.close()

  // no directory chosen → pointer note instead of a canvas
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page2 = await ctx2.newPage()
  await page2.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}')) // login gate

  await page2.addInitScript(() => {
    if (!localStorage.getItem('atlas.page.v1')) localStorage.setItem('atlas.page.v1', JSON.stringify({
      v: 1, rows: [{ id: 'r1', cols: [{ id: 'c1', sections: [{ id: 's1', lines: [{ id: 'l1', widgets: [{ id: 'w1', kind: 'gfgraph' }] }] }] }] }],
    }))
  })
  await page2.goto(`${BASE}/#/dashboard`)
  await page2.waitForSelector('[data-gf-widget]')
  await page2.waitForFunction(() => document.querySelector('[data-gf-widget]')?.textContent.includes('Graph page'))
  ok(true, 'widget without a directory points to the Graph page')
  await ctx2.close()
}

// ---- D. performance tuning: bounded simulation + position merge + large-graph cap ----
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}')) // login gate

  const state = { calls: [], revealed: [], updated: false, nextEvent: 'watching' }
  await installFake(page, state)
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('atlas.graph.v1', JSON.stringify({ dir: '/fake/project', mode: '2d', mdOnly: false }))
  })
  await page.goto(`${BASE}/#/graph`)
  await page.waitForSelector('.gf-stage canvas')
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('nodes'))
  console.log('D1. static board — graph.html physics config')
  await page.waitForFunction(() => window.__gf?.network && window.__gf.network.physics.options.enabled === false, null, { timeout: 30000 })
  const cfg = await page.evaluate(() => {
    const o = window.__gf.network.physics.options
    return { enabled: o.enabled, solver: o.solver, spring: o.forceAtlas2Based.springLength, avoid: o.forceAtlas2Based.avoidOverlap }
  })
  ok(cfg.enabled === false, 'physics OFF after stabilization — board is static')
  ok(cfg.solver === 'forceAtlas2Based', `graph.html solver in use (${cfg.solver})`)
  ok(cfg.spring === 120 && cfg.avoid === 0.8, `graph.html FA2 params verbatim (spring ${cfg.spring}, avoidOverlap ${cfg.avoid})`)

  console.log('D2. live refresh preserves node positions (no reset-to-spiral jitter)')
  const before = await page.evaluate(() => window.__gf.network.getPositions(['na']).na)
  state.updated = true
  state.nextEvent = 'updated'
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('5 nodes'), null, { timeout: 15000 })
  const after = await page.evaluate(() => window.__gf.network.getPositions(['na']).na)
  const drift = Math.hypot(after.x - before.x, after.y - before.y)
  ok(drift < 0.01, `existing node position survives a live refresh (drift ${drift.toFixed(2)}px)`)
  await ctx.close()
}

// ---- D3. large-graph cap: truncate + visibly report it, never silently ---------------
{
  const BIG_N = 2500, CAP = 1500
  const bigNodes = Array.from({ length: BIG_N }, (_, i) => ({ id: 'n' + i, label: 'n' + i, source_file: null, file_type: null, community: i % 6 }))
  const bigLinks = Array.from({ length: BIG_N - 1 }, (_, i) => ({ source: 'n0', target: 'n' + (i + 1), relation: 'ref' })) // hub + spokes → clear degree ranking
  const FIX_BIG = { nodes: bigNodes, links: bigLinks }

  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}')) // login gate

  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  const state = { calls: [] }
  await page.route('**/graph-api/**', (route) => {
    const u = new URL(route.request().url())
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (u.pathname === '/graph-api/graph') return json(FIX_BIG)
    if (u.pathname === '/graph-api/events') return route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: watching\n\n' })
    return json({ error: 'unhandled ' + u.pathname }, 500)
  })
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    // conditional: D4 reloads this same page after changing maxNodes via the
    // UI — an unconditional set would stomp that persisted change back to
    // the fixture default on every reload.
    if (!localStorage.getItem('atlas.graph.v1')) localStorage.setItem('atlas.graph.v1', JSON.stringify({ dir: '/fake/huge', mode: '2d', mdOnly: false }))
  })
  await page.goto(`${BASE}/#/graph`)
  await page.waitForSelector('.gf-stage canvas')
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('nodes'), null, { timeout: 15000 })
  console.log('D3. large graph is capped and the cap is reported, not hidden')
  const status = await page.locator('#gf-status').innerText()
  ok(status.includes(`showing top ${CAP} of ${BIG_N} by connections`), `status reports the truncation (${status})`)
  const shown = await page.evaluate(() => window.__gf.nodesDS.length)
  ok(shown === CAP, `renderer actually holds the capped count (${shown})`)

  console.log('D3b. 3D mode on a large (>500 node) graph applies its size-gated tweaks without a runtime error')
  await page.click('[data-gf="mode"][data-v="3d"]')
  await page.waitForTimeout(2500) // three.js dynamic import + first frame
  ok(await page.locator('.gf-stage canvas').count() >= 1, '3D canvas mounted for the large graph')
  ok(errs.length === 0, `no runtime errors switching to 3D past the 500-node gate (${errs.join(' | ').slice(0, 200)})`)
  await page.click('[data-gf="mode"][data-v="2d"]')
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('nodes'), null, { timeout: 15000 })

  console.log('D4. user-defined max nodes')
  ok(await page.locator('[data-gf="maxnodes"]').inputValue() === '1500', 'toolbar shows the default max-nodes value (1500)')
  await page.fill('[data-gf="maxnodes"]', '300')
  await page.locator('[data-gf="maxnodes"]').blur() // fires change
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('showing top 300'), null, { timeout: 10000 })
  ok(true, 'lowering max nodes re-caps the live graph in place')
  ok(await page.evaluate(() => window.__gf.nodesDS.length) === 300, 'renderer now holds exactly the new cap (300)')
  ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.graph.v1')).maxNodes) === 300, 'max-nodes setting persisted')
  await page.reload()
  await page.waitForSelector('.gf-stage canvas')
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('showing top 300'), null, { timeout: 15000 })
  await page.waitForFunction(() => !!window.__gf?.network, null, { timeout: 10000 })
  ok(await page.locator('[data-gf="maxnodes"]').inputValue() === '300', 'persisted value re-populates the input after reload')
  ok(await page.evaluate(() => window.__gf.nodesDS.length) === 300, 'persisted cap re-applies after reload, not reset to 1500')
  ok(errs.length === 0, `no page errors across the whole large-graph section (${errs.join(' | ').slice(0, 200)})`)
  await ctx.close()
}

// ---- E. settle-then-freeze: pinning + deferred revalidation -----------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}')) // login gate
  const state = { calls: [], revealed: [], updated: false, nextEvent: 'watching' }
  await installFake(page, state)
  await page.addInitScript(() => {
    localStorage.setItem('atlas.devMode', '1')
    localStorage.setItem('atlas.graph.v1', JSON.stringify({ dir: '/fake/dir', mode: '2d', mdOnly: false, maxNodes: 1500 }))
  })
  await page.goto(`${BASE}/#/graph`)
  await page.waitForSelector('.gf-stage canvas')
  console.log('E. settle-then-freeze (static layout)')
  // the revalidation rebuild is deferred until the layout exists: with warmup
  // the settle is synchronous, so "after settle" ≈ right after first paint —
  // assert ORDER (graph fetched+laid out before any build), not wall-clock.
  await page.waitForFunction(() => window.__gf?.network, null, { timeout: 10000 })
  const t0 = Date.now()
  while (!state.calls.some((c) => c.startsWith('/graph-api/build')) && Date.now() - t0 < 20000) await sleep(200)
  const firstGraph = state.calls.findIndex((c) => c.startsWith('/graph-api/graph'))
  const firstBuild = state.calls.findIndex((c) => c.startsWith('/graph-api/build'))
  ok(firstGraph !== -1 && firstBuild > firstGraph, `revalidation rebuild deferred until after layout (graph@${firstGraph} < build@${firstBuild})`)
  // static board: stabilization done → physics OFF (graph.html behavior)
  await page.waitForFunction(() => window.__gf.network.physics.options.enabled === false, null, { timeout: 30000 })
  ok(true, 'physics disabled after stabilization — board is static')
  // node dots carry graphify's degree-based size (base radius 10)
  ok(await page.evaluate(() => window.__gf.nodesDS.get('na').size >= 10), 'nodes sized by degree like graph.html')
  // a live refresh (rebuild landing via SSE) must not scatter the settled layout
  const before = await page.evaluate(() => window.__gf.network.getPositions(['na']).na)
  state.updated = true
  state.nextEvent = 'updated' // EventSource reconnects (~3s) and receives it
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('5 nodes'), null, { timeout: 15000 })
  const after = await page.evaluate(() => window.__gf.network.getPositions(['na']).na)
  const drift = Math.hypot(after.x - before.x, after.y - before.y)
  ok(drift < 0.01, `settled node did not move on live refresh (drift ${drift.toFixed(4)}px)`)
  // graphify.html drag behavior (physics off): only the dragged node moves —
  // neither its own community nor any other node follows
  {
    await page.evaluate(() => window.__gf.network.fit({ animation: false }))
    await sleep(250)
    const grab = await page.evaluate(() => {
      const net = window.__gf.network
      const pos = net.getPositions()
      const d = net.canvasToDOM(pos.na)
      const r = document.querySelector('.gf-stage canvas').getBoundingClientRect()
      return { sx: d.x + r.x, sy: d.y + r.y, na: pos.na, nb: pos.nb, c1: pos.c1 }
    })
    await page.mouse.move(grab.sx, grab.sy)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(grab.sx + i * 15, grab.sy + i * 8)
    await sleep(400)
    const mid = await page.evaluate(() => window.__gf.network.getPositions())
    await page.mouse.up()
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
    ok(d(mid.na, grab.na) > 20, `dragged node follows the pointer (moved ${d(mid.na, grab.na).toFixed(1)}px)`)
    ok(d(mid.nb, grab.nb) < 0.01 && d(mid.c1, grab.c1) < 0.01,
      `no other node moves during a drag (nb ${d(mid.nb, grab.nb).toFixed(4)}px, c1 ${d(mid.c1, grab.c1).toFixed(4)}px)`)
  }

  // 3D parity: same size rule via cbrt — nodeVal must be size³
  await page.click('[data-gf="mode"][data-v="3d"]')
  await page.waitForFunction(() => {
    const g = window.__gf?.graph
    try { return g && g.graphData().nodes.length && !!g.renderer } catch { return false }
  }, null, { timeout: 20000 })
  ok(await page.evaluate(() => {
    const g = window.__gf.graph
    const n = g.graphData().nodes[0]
    return Math.abs(g.nodeVal()(n) - n.size ** 3) < 1e-9
  }), '3D nodeVal = size³ (renders same radius as 2D)')
  ok(await page.evaluate(() => !!window.__gf.graph.d3Force('collide')), '3D collision force installed')
  await ctx.close()
}

// ---- C. real end-to-end: live rebuild on directory change -------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}')) // login gate

  await page.addInitScript((dir) => {
    if (!localStorage.getItem('atlas.graph.v1')) localStorage.setItem('atlas.graph.v1', JSON.stringify({ dir, mode: '2d', mdOnly: false }))
  }, GTEST)
  await page.goto(`${BASE}/#/graph`)
  await page.waitForSelector('.gf-stage canvas')
  await page.waitForFunction(() => document.getElementById('gf-status')?.textContent.includes('nodes'))
  console.log('C. real graphify + watch')
  const before = await page.evaluate(() => Number(document.getElementById('gf-status').textContent.match(/(\d+) nodes/)[1]))
  ok(before >= 9, `real graph rendered (${before} nodes)`)
  // touch the real directory → fs.watch → debounce → headless rebuild → SSE update
  fs.writeFileSync(`${GTEST}/notes/delta.md`, '# Delta\nA brand new note linking [[index]].\n')
  try {
    await page.waitForFunction(
      (n) => Number(document.getElementById('gf-status')?.textContent.match(/(\d+) nodes/)?.[1] || 0) > n,
      before, { timeout: 60000 },
    )
    const after = await page.evaluate(() => Number(document.getElementById('gf-status').textContent.match(/(\d+) nodes/)[1]))
    ok(after > before, `graph updated live after a file was added (${before} → ${after} nodes)`)
  } finally {
    fs.rmSync(`${GTEST}/notes/delta.md`, { force: true })
  }
  await ctx.close()
}

await browser.close()
console.log(`\ngraph: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
