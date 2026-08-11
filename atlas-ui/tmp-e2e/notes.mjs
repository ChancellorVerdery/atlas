// Notes plugin suite. Layers:
//   0. real middleware (plain fetch): tree walk, save + originals dedup,
//      409 collision, traversal guard, keyless convert error
//   A. browser, no folder chosen — empty state
//   B. browser against the REAL middleware for tree/read/save, with only
//      /notes-api/convert faked (no API key needed): read a note, follow a
//      wiki-link, dangling-link status, full upload → queue → review → save
//      flow (background queue: convert closes the modal, a card with a
//      progress bar tracks the job, nav dot stays lit on other pages).
// Headless always; the Finder picker is never invoked.
import { chromium } from 'playwright'
import fs from 'node:fs'
import path from 'node:path'

const BASE = 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name, extra = '') => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) } }

const FIX = (process.env.CLAUDE_JOB_DIR || '/tmp') + '/tmp/nt-fixture'
fs.rmSync(FIX, { recursive: true, force: true })
fs.mkdirSync(path.join(FIX, 'Physics'), { recursive: true })
fs.writeFileSync(path.join(FIX, 'Physics', 'Waves.md'), '# Waves\n\nSee [[Optics]] and [[Thermodynamics]].\n')
fs.writeFileSync(path.join(FIX, 'Optics.md'), '# Optics\n\nLight stuff.\n')
const WIDE_EQ = '$$E_{total} = ' + Array.from({ length: 30 }, (_, i) => `\\frac{K q_{${i + 1}}}{r_{${i + 1}}^2}`).join(' + ') + '$$'
fs.writeFileSync(path.join(FIX, 'Charge.md'), `# Charge\n\nCoulomb's law:\n\n$$F = \\frac{K |q_1 q_2|}{r^2}$$\n\nA wide superposition that used to scroll:\n\n${WIDE_EQ}\n\nElementary charge $e = 1.6 \\times 10^{-19}$ C.\n\nDots normalization: $q_1, q_2, \\dots, q_n$ and $$E_1 + E_2 + \\dots + E_n$$\n\nLaTeX delimiters: \\( F = ma \\) and \\[ E = mc^2 \\]\n\n---\n**Originals:** ![[scan.png]]\n`)

// ---- 0. real middleware ------------------------------------------------------------
{
  console.log('0. middleware (real)')
  const tree = await fetch(`${BASE}/notes-api/tree?dir=${encodeURIComponent(FIX)}`).then((r) => r.json())
  ok(tree.dirs.includes('Physics'), 'tree lists directories')
  ok(tree.notes.some((n) => n.path === 'Physics/Waves.md') && tree.notes.some((n) => n.path === 'Optics.md'), 'tree lists notes recursively')

  const saveBody = {
    dir: FIX, subdir: 'Physics/Labs', filename: 'Lab 1', markdown: '# Lab 1\n\nBody.',
    uploads: [
      { name: 'photo.png', data: Buffer.from('a').toString('base64') },
      { name: 'photo.png', data: Buffer.from('b').toString('base64') }, // same name → dedup
    ],
  }
  const saved = await fetch(`${BASE}/notes-api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(saveBody) }).then((r) => r.json())
  ok(saved.ok && saved.path === 'Physics/Labs/Lab 1.md', `save writes into a new subdir (${saved.path})`)
  const md = fs.readFileSync(path.join(FIX, 'Physics/Labs/Lab 1.md'), 'utf8')
  ok(md.includes('![[photo.png]]') && md.includes('![[photo-2.png]]'), 'Originals block embeds the deduped upload names')
  ok(fs.existsSync(path.join(FIX, 'note uploads', 'photo.png')) && fs.existsSync(path.join(FIX, 'note uploads', 'photo-2.png')), 'originals written to "note uploads"')

  const dup = await fetch(`${BASE}/notes-api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...saveBody, uploads: [] }) })
  ok(dup.status === 409, 'saving over an existing note → 409')
  const escp = await fetch(`${BASE}/notes-api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: FIX, subdir: '../../escape', filename: 'x', markdown: 'x' }) })
  ok(escp.status === 400, 'subdir traversal blocked')
  const slashname = await fetch(`${BASE}/notes-api/save`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: FIX, subdir: '', filename: '../sneaky', markdown: 'x' }) }).then((r) => r.json())
  ok(slashname.ok && fs.existsSync(path.join(FIX, '..-sneaky.md')), 'slashes in filename neutralized, not traversed')
  const treeSkip = await fetch(`${BASE}/notes-api/tree?dir=${encodeURIComponent(FIX)}`).then((r) => r.json())
  ok(!treeSkip.dirs.includes('note uploads'), '"note uploads" excluded from the tree')

  // convert() shells out to the `claude` CLI (subscription) — real runs are
  // slow and burn quota, so the suite only checks the route's dir guard fires
  // before any Claude call. The full convert→preview→save flow is covered in
  // section B with /notes-api/convert faked; live conversion is verified by hand.
  const convBad = await fetch(`${BASE}/notes-api/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: '/definitely/not/here', text: 'hi' }) })
  ok(convBad.status === 400, 'convert validates the dir before doing any work')
}

const browser = await chromium.launch({ headless: true })

// ---- A. no folder chosen ------------------------------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}')) // login gate
  await page.goto(`${BASE}/#/notes`)
  await page.waitForSelector('.gf-empty')
  console.log('A. unconfigured')
  ok(await page.locator('#title').innerText() === 'Notes', 'topbar label says Notes')
  ok(await page.locator('.nav__item', { hasText: 'Notes' }).count() === 1, 'Notes appears in sidebar nav')
  ok(await page.locator('[data-nt="pick"]').count() >= 1, 'Choose folder button present')
  ok(await page.locator('#customize').isHidden(), 'Customize button hidden on notes page')
  await ctx.close()
}

// ---- B. browser + real middleware (convert faked) -------------------------------------
{
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.addInitScript(() => localStorage.setItem('atlas.auth.v1', '{"offline":true}'))
  await page.addInitScript((dir) => localStorage.setItem('atlas.notes.v1', JSON.stringify({ dir, lastSubdir: '' })), FIX)
  // delayed so the converting state (progress bar, nav dot, "Queued" second
  // job) is observable before the job flips to ready
  await page.route('**/notes-api/convert', async (route) => {
    await new Promise((r) => setTimeout(r, 1500))
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ title: 'Photosynthesis Basics', markdown: '---\ndate: 2026-07-09\nsource: text\n---\n\n# Photosynthesis\n\nRelates to [[Optics]] and [[Cell Biology]].\n\n$$6 CO_2 + 6 H_2O \\rightarrow C_6H_{12}O_6$$' }),
    })
  })

  await page.goto(`${BASE}/#/notes`)
  await page.waitForSelector('.nt-note')
  console.log('B1. browser + read path')
  ok(await page.locator('.nt-note').count() >= 3, 'tree renders the fixture notes')
  await page.click('.nt-note[data-path="Physics/Waves.md"]')
  await page.waitForSelector('.nt-md h1')
  ok(await page.locator('.nt-view__title').innerText() === 'Waves', 'note opens in the viewer')
  ok(await page.locator('.nt-wiki[data-target="Optics"]').count() === 1, 'wiki-link rendered as a link')

  console.log('B1b. math renders, fits, and stays left-aligned; original scan omitted')
  await page.click('.nt-note[data-path="Charge.md"]')
  await page.waitForSelector('.nt-md .eq-render__inner')
  ok(await page.locator('.nt-md .eq-render').count() >= 2, 'block math ($$…$$) renders as math markup')
  ok(await page.locator('.nt-md .nt-math').count() >= 1, 'inline math ($…$) renders as math markup')
  // fitEquations scales a wide equation so its VISUAL box fits the container
  // (transform doesn't change scrollWidth, so measure the rendered rect).
  const fit = await page.evaluate(() =>
    [...document.querySelectorAll('.nt-md .eq-render')].map((o) => o.clientWidth - o.querySelector('.eq-render__inner').getBoundingClientRect().width))
  ok(fit.every((slack) => slack >= -1), `every equation fits its container, none scroll (min slack ${Math.min(...fit).toFixed(1)}px)`)
  const scaled = await page.evaluate(() =>
    [...document.querySelectorAll('.nt-md .eq-render__inner')].some((i) => /scale\(0/.test(i.style.transform)))
  ok(scaled, 'the wide equation was scaled down to fit (not left to scroll)')
  const align = await page.evaluate(() => {
    const inner = document.querySelector('.nt-md .eq-render__inner')
    return inner.getBoundingClientRect().left - inner.closest('.eq-render').getBoundingClientRect().left
  })
  ok(align < 4, `block math is left-aligned, not centered (offset ${align.toFixed(1)}px)`)
  const chargeText = await page.locator('.nt-md').innerText()
  ok(!chargeText.includes('$$') && !chargeText.includes('\\frac'), 'raw LaTeX delimiters/commands gone from the rendered note')
  ok(chargeText.includes('…') && !chargeText.includes('dots'), '\\dots normalized to a real ellipsis (mathlive lacks \\dots)')
  ok(!chargeText.includes('\\(') && !chargeText.includes('( F = ma )') && !chargeText.includes('[ E = mc^2 ]'), '\\(…\\) and \\[…\\] delimiters render as math, not literal text')
  ok(await page.locator('.nt-md .eq-render').count() >= 4, 'the \\[…\\] block joined the block-math renders')
  ok(await page.locator('.nt-md img').count() === 0, 'the original scan is NOT displayed under the note')
  ok(!chargeText.includes('Originals'), 'the Originals block is stripped from the viewer')
  await page.click('.nt-note[data-path="Physics/Waves.md"]')
  await page.waitForFunction(() => document.querySelector('.nt-view__title')?.textContent === 'Waves')

  console.log('B2. wiki-link navigation')
  await page.click('.nt-wiki[data-target="Optics"]')
  await page.waitForFunction(() => document.querySelector('.nt-view__title')?.textContent === 'Optics')
  ok(true, 'clicking a wiki-link jumps to that note')
  ok(await page.locator('.nt-note[data-path="Optics.md"]').evaluate((el) => el.classList.contains('is-open')), 'tree selection follows')
  await page.click('.nt-note[data-path="Physics/Waves.md"]')
  await page.waitForFunction(() => document.querySelector('.nt-view__title')?.textContent === 'Waves')
  await page.click('.nt-wiki[data-target="Thermodynamics"]')
  await page.waitForFunction(() => document.getElementById('nt-status')?.textContent.includes('Thermodynamics'))
  ok(true, 'dangling wiki-link reports "no note yet" instead of navigating')

  console.log('B3. upload → queue → background convert → review → save')
  await page.click('[data-nt="new"]')
  await page.waitForSelector('.nt-overlay')
  await page.fill('[data-nt-field="text"]', 'photosynthesis basics: light reactions, calvin cycle')
  await page.click('[data-nt="up-convert"]')
  await page.waitForSelector('.nt-overlay', { state: 'detached' })
  ok(true, 'Convert closes the modal immediately (no blocking)')
  await page.waitForSelector('.nt-qcard')
  ok((await page.locator('.nt-qstatus').innerText()).includes('Converting'), 'queue card shows converting status')
  ok(await page.locator('.nt-qcard .nt-qbar .nt-qfill').count() === 1, 'queue card has a progress bar')
  await page.waitForTimeout(1100) // ticker runs at 500ms
  const width = await page.evaluate(() => parseFloat(document.querySelector('.nt-qfill')?.style.width))
  ok(width > 0, `progress bar advances while converting (${width}%)`)
  await page.goto(`${BASE}/#/`) // leave the notes page mid-convert
  await page.waitForSelector('.nav__item.is-busy', { timeout: 3000 })
  ok(true, 'nav dot on Notes stays lit from other pages while converting')
  await page.goto(`${BASE}/#/notes`)
  await page.waitForSelector('[data-nt="q-review"]')
  ok((await page.locator('.nt-qstatus').innerText()).includes('Ready'), 'finished job holds for review (not auto-saved)')
  ok((await page.locator('.nt-qlabel').innerText()) === 'Photosynthesis Basics', 'card label updates to the converted title')
  await page.click('[data-nt="q-review"]')
  await page.waitForSelector('[data-nt-field="filename"]')
  ok(await page.locator('[data-nt-field="filename"]').inputValue() === 'Photosynthesis Basics', 'preview prefills the filename from the model title')
  ok((await page.locator('.nt-prevmd').innerText()).includes('Photosynthesis'), 'rendered preview shows the markdown')
  ok(await page.locator('.nt-prevmd .nt-wiki').count() >= 2, 'wiki-links render inside the preview')
  ok(await page.locator('.nt-prevmd .eq-render').count() >= 1, 'math renders in the pre-save preview')
  await page.click('[data-nt="up-raw"]')
  const raw = await page.locator('[data-nt-field="markdown"]').inputValue()
  ok(raw.startsWith('---\ndate:'), 'raw view shows frontmatter for editing')
  await page.fill('[data-nt-field="markdown"]', raw + '\n\nEdited by hand.')
  await page.fill('[data-nt-field="filename"]', 'Photosynthesis')
  await page.click('[data-nt="up-save"]')
  await page.waitForSelector('.nt-overlay', { state: 'detached' })
  await page.waitForFunction(() => document.querySelector('.nt-view__title')?.textContent === 'Photosynthesis')
  ok(true, 'save closes the modal and opens the new note')
  ok(await page.locator('.nt-qcard').count() === 0, 'saved job leaves the queue')
  ok(await page.locator('.nav__item.is-busy').count() === 0, 'nav dot clears once the queue is empty')
  const savedMd = fs.readFileSync(path.join(FIX, 'Photosynthesis.md'), 'utf8')
  ok(savedMd.includes('Edited by hand.'), 'raw edits made it to disk')
  ok(await page.locator('.nt-note[data-path="Photosynthesis.md"]').count() === 1, 'tree refreshed with the new note')

  console.log('B4. collision → rename (edits survive closing the review)')
  await page.click('[data-nt="new"]')
  await page.waitForSelector('.nt-overlay')
  await page.fill('[data-nt-field="text"]', 'same again')
  await page.click('[data-nt="up-convert"]')
  await page.waitForSelector('[data-nt="q-review"]')
  await page.click('[data-nt="q-review"]')
  await page.waitForSelector('[data-nt-field="filename"]')
  await page.fill('[data-nt-field="filename"]', 'Photosynthesis') // taken
  await page.click('[data-nt="up-save"]')
  await page.waitForSelector('.nt-error')
  ok((await page.locator('.nt-error').innerText()).includes('already exists'), '409 surfaces inline, inputs intact')
  await page.click('[data-nt="up-close"]') // close without saving…
  await page.waitForSelector('.nt-overlay', { state: 'detached' })
  ok(await page.locator('.nt-qcard').count() === 1, 'unsaved job stays in the queue')
  await page.click('[data-nt="q-review"]') // …and reopen
  await page.waitForSelector('[data-nt-field="filename"]')
  ok(await page.locator('[data-nt-field="filename"]').inputValue() === 'Photosynthesis', 'filename edit survived closing the review')
  await page.fill('[data-nt-field="filename"]', 'Photosynthesis 2')
  await page.click('[data-nt="up-save"]')
  await page.waitForSelector('.nt-overlay', { state: 'detached' })
  ok(fs.existsSync(path.join(FIX, 'Photosynthesis 2.md')), 'rename then save succeeds')

  console.log('B5. multiple jobs queue sequentially')
  for (const txt of ['first queued note', 'second queued note']) {
    await page.click('[data-nt="new"]')
    await page.waitForSelector('.nt-overlay')
    await page.fill('[data-nt-field="text"]', txt)
    await page.click('[data-nt="up-convert"]')
    await page.waitForSelector('.nt-overlay', { state: 'detached' })
  }
  ok(await page.locator('.nt-qcard').count() === 2, 'both jobs queued as cards')
  const statuses = await page.locator('.nt-qstatus').allInnerTexts()
  ok(statuses.some((s) => s.includes('Converting')) && statuses.includes('Queued'), `one converts, the other waits (${statuses.join(' / ')})`)
  await page.waitForFunction(() => document.querySelectorAll('[data-nt="q-review"]').length === 2, null, { timeout: 15000 })
  ok(true, 'both jobs finish one after the other')
  await page.click('.nt-qcard [data-nt="q-remove"]')
  ok(await page.locator('.nt-qcard').count() === 1, 'dismissing a ready job removes its card')
  await page.click('.nt-qcard [data-nt="q-remove"]')
  ok(await page.locator('.nt-qcard').count() === 0 && await page.locator('.nav__item.is-busy').count() === 0, 'queue empties and the nav dot clears')

  ok(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 200)})`)
  await ctx.close()
}

await browser.close()
fs.rmSync(FIX, { recursive: true, force: true })
console.log(`\nnotes: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
