// Headless check of the console Git board against a synthetic branchy repo
// (11 commits, 2 merges, 1 unmerged branch) served on the forwarded :7683.
// Asserts DAG layout, click-through detail, and pan/zoom — then shoots it.
import { chromium } from 'playwright'
import { strictEqual, ok } from 'node:assert'

const URL = 'http://localhost:7683/'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } })
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
await page.goto(URL)
await page.waitForSelector('.card', { timeout: 10000 })

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS', name) }
  catch (e) { fail++; console.log('FAIL', name, '-', e.message) }
}

const cards = await page.$$eval('.card', (n) => n.map((c) => ({
  ver: c.querySelector('.ver').textContent,
  subj: c.querySelector('.subj').textContent,
})))

await check('all 11 commits render', () => strictEqual(cards.length, 11))
await check('newest is v11, oldest is v1', () => {
  strictEqual(cards[0].ver, 'v11')
  strictEqual(cards[cards.length - 1].ver, 'v1')
})
await check('v1 is the initial commit', () => ok(cards[cards.length - 1].subj.includes('v1 initial'), cards[cards.length - 1].subj))

// Lane assignment: branches must not collapse onto the mainline lane.
const lanes = await page.$$eval('#wires circle', (n) => n.map((c) => +c.getAttribute('cx')))
await check('every commit has a node', () => strictEqual(lanes.length, 11))
await check('branches occupy distinct lanes', () => {
  const distinct = new Set(lanes)
  ok(distinct.size >= 3, `only ${distinct.size} distinct lane positions: ${[...distinct]}`)
})

// 11 commits: the root has no parent, 8 have one, 2 merges have two → 12 links
// Row pitch has to clear the rendered card height, or each card clips the
// author/date line of the one above it.
await check('cards do not overlap', async () => {
  const boxes = await page.$$eval('.card', (n) => n.map((c) => {
    const r = c.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom }
  }))
  boxes.sort((a, b) => a.top - b.top)
  for (let i = 1; i < boxes.length; i++) {
    ok(boxes[i].top >= boxes[i - 1].bottom - 0.5,
      `card ${i} starts at ${boxes[i].top.toFixed(1)} but the one above ends at ${boxes[i - 1].bottom.toFixed(1)}`)
  }
})
await check('edge count = parent links (12)', async () => {
  const edges = await page.$$eval('#wires path', (n) => n.length)
  strictEqual(edges, 12)
})
await check('lane changes render as curves', async () => {
  const curved = await page.$$eval('#wires path', (n) => n.filter((p) => p.getAttribute('d').includes('C')).length)
  ok(curved >= 4, `only ${curved} curved edges`)
})

await check('clicking a merge opens its details', async () => {
  await page.click('.card:has-text("v6 merge feature")')
  await page.waitForSelector('#panel.on', { timeout: 5000 })
  // the panel opens before the detail fetch resolves — wait for the content
  await page.waitForFunction(() => document.querySelector('#ptitle')?.textContent.includes('v6'), null, { timeout: 5000 })
  const title = await page.locator('#ptitle').innerText()
  ok(title.includes('v6'), `panel title: ${title}`)
  const sub = await page.locator('#psub').innerText()
  ok(/^[0-9a-f]{7} · Tester/.test(sub), `panel sub: ${sub}`)
})
await check('a linear commit shows changed files and a diff', async () => {
  await page.click('.card:has-text("v9 after the merge")')
  await page.waitForFunction(() => document.querySelector('#ptitle')?.textContent.includes('v9'), null, { timeout: 5000 })
  // innerText is the RENDERED text and .sect is text-transform:uppercase
  const body = (await page.locator('#pbody').innerText()).toLowerCase()
  ok(body.includes('1 file changed'), `files line missing: ${body.slice(0, 120)}`)
  ok(body.includes('c.txt'), 'changed path missing')
  await page.waitForSelector('pre.diff', { timeout: 5000 })
  ok((await page.locator('pre.diff').innerText()).includes('+1'), 'diff body missing the added line')
})

await check('scroll zooms', async () => {
  const before = await page.$eval('#viewport', (v) => v.style.transform)
  await page.mouse.move(700, 500)
  await page.mouse.wheel(0, -400)
  await page.waitForTimeout(100)
  const after = await page.$eval('#viewport', (v) => v.style.transform)
  ok(before !== after, `transform unchanged: ${after}`)
  const k = parseFloat(after.match(/scale\(([\d.]+)\)/)[1])
  ok(k > 0.15 && k <= 3, `scale outside clamp: ${k}`)
})
// Coordinates must come from the stage's live box: the detail panel is open by
// now, so the stage is ~460px narrower than the viewport and fixed pixel
// coordinates land inside the panel instead of the board.
const stageBox = async () => page.$eval('#stage', (s) => {
  const r = s.getBoundingClientRect()
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }
})
await check('drag pans', async () => {
  const { cx, cy } = await stageBox()
  const before = await page.$eval('#viewport', (v) => v.style.transform)
  await page.mouse.move(cx, cy); await page.mouse.down()
  await page.mouse.move(cx - 140, cy - 90, { steps: 8 }); await page.mouse.up()
  ok(before !== (await page.$eval('#viewport', (v) => v.style.transform)), 'pan did not move the viewport')
})
// Cards cover most of the board — dragging from one must pan, not dead-zone.
await check('drag starting on a card still pans', async () => {
  await page.click('#fit')            // the pan above pushed the top card under the header
  await page.waitForTimeout(100)
  const mid = Math.floor(cards.length / 2)
  const box = await page.locator('.card').nth(mid).boundingBox()
  const st = await page.$eval('#stage', (s) => {
    const r = s.getBoundingClientRect()
    return { l: r.left, t: r.top, r: r.right, b: r.bottom }
  })
  const px = box.x + box.width / 2, py = box.y + box.height / 2
  // Prove we're actually pressing on the board, not the header or the panel —
  // that mistake is exactly what made this check fail twice before.
  ok(px > st.l && px < st.r && py > st.t && py < st.b, `card centre (${px},${py}) outside stage ${JSON.stringify(st)}`)
  const hit = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y)
    return { isCard: !!el?.closest('.card'), inStage: !!el?.closest('#stage') }
  }, [px, py])
  ok(hit.isCard && hit.inStage, `point does not land on a card inside the stage: ${JSON.stringify(hit)}`)

  const before = await page.$eval('#viewport', (v) => v.style.transform)
  await page.mouse.move(px, py); await page.mouse.down()
  await page.mouse.move(px - 120, py + 70, { steps: 8 }); await page.mouse.up()
  ok(before !== (await page.$eval('#viewport', (v) => v.style.transform)), 'dragging from a card did not pan')
})
// …and a click that doesn't move must still select, not be eaten by the pan.
await check('click on a card still selects it', async () => {
  await page.click('.card:has-text("v2 second on main")')
  await page.waitForFunction(() => document.querySelector('#ptitle')?.textContent.includes('v2'), null, { timeout: 5000 })
  ok((await page.locator('#ptitle').innerText()).includes('v2'))
})
await check('Fit resets the view', async () => {
  await page.click('#fit')
  await page.waitForTimeout(100)
  // the browser normalises the serialised transform to "translate(12px, 12px)"
  const t = (await page.$eval('#viewport', (v) => v.style.transform)).replace(/\s+/g, '')
  ok(t.includes('translate(12px,12px)'), `fit transform: ${t}`)
})

await check('no page errors', () => strictEqual(errs.join('; '), ''))

await page.click('#fit')
await page.waitForTimeout(150)
await page.screenshot({ path: '~/.claude/jobs/b33ffdaa/tmp/gitboard-branches.png' })
await browser.close()
console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail ? 1 : 0)
