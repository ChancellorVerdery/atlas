// The notes folder tree used to render every <details> with a hardcoded `open`,
// so it came up fully expanded every single time and forgot anything you
// collapsed. Folders must now start CLOSED and remember what you left open.
//
// The tree is served by the dev server's /notes-api middleware, which needs a
// real notes folder on disk — so this intercepts that one request and supplies
// a fixed tree instead. Everything else is the real page.
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const TREE = {
  dirs: ['Classes', 'Classes/Thermo', 'Classes/Statics', 'Personal'],
  notes: [
    { path: 'Classes/Thermo/entropy.md' },
    { path: 'Classes/Statics/trusses.md' },
    { path: 'Personal/gym.md' },
    { path: 'loose.md' },
  ],
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()

await page.route('**/notes-api/tree*', (route) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TREE) }))
// The page reads a note as soon as one is opened; keep that quiet.
await page.route('**/graph-api/file*', (route) =>
  route.fulfill({ status: 200, contentType: 'text/plain', body: '# stub' }))

// addInitScript re-runs on every navigation, INCLUDING reload — seeding
// unconditionally would wipe the very state step 3 reloads to check.
await page.addInitScript(() => {
  const seed = (k, v) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v) }
  seed('atlas.auth.v1', '{"offline":true}')
  seed('atlas.plugins.v1', JSON.stringify({ enabled: { notes: true }, installed: {} }))
  seed('atlas.notes.v1', JSON.stringify({ dir: '/tmp/fake-notes', lastSubdir: '' }))
})

const dirState = () => page.$$eval('details.nt-dir', (els) =>
  els.map((e) => ({ dir: e.dataset.dir, open: e.open })))
const openDirs = () => page.evaluate(() => {
  try { return JSON.parse(localStorage.getItem('atlas.notes.v1')).openDirs } catch { return null }
})

await page.goto(`${BASE}/#/notes`)
await page.waitForSelector('details.nt-dir', { timeout: 15000 })

console.log('1. every folder starts collapsed')
let dirs = await dirState()
ok(dirs.length >= 4, `tree rendered ${dirs.length} folders`)
ok(dirs.every((d) => !d.open), 'no folder is expanded on first load')
ok(dirs.every((d) => !!d.dir), 'every folder carries its path key')
ok(dirs.some((d) => d.dir === 'Classes/Thermo'), 'nested folders are keyed by full path')

console.log('2. expanding one is remembered')
await page.click('details.nt-dir[data-dir="Classes"] > summary')
await page.waitForFunction(() => {
  try { return (JSON.parse(localStorage.getItem('atlas.notes.v1')).openDirs || []).includes('Classes') } catch { return false }
}, null, { timeout: 5000 }).catch(() => {})
ok((await openDirs() || []).includes('Classes'), 'the open folder was written to the store')
// A nested one too, to prove the path key (not the bare name) is what's stored.
await page.click('details.nt-dir[data-dir="Classes/Thermo"] > summary')
await page.waitForTimeout(200)
ok((await openDirs() || []).includes('Classes/Thermo'), 'the nested folder stored its full path')

console.log('3. it survives a reload — and only those two are open')
await page.reload()
await page.waitForSelector('details.nt-dir', { timeout: 15000 })
dirs = await dirState()
const open = dirs.filter((d) => d.open).map((d) => d.dir).sort()
ok(JSON.stringify(open) === JSON.stringify(['Classes', 'Classes/Thermo']), `exactly the two reopened (got ${JSON.stringify(open)})`)
ok(dirs.find((d) => d.dir === 'Personal')?.open === false, 'an untouched folder is still collapsed')

console.log('4. collapsing is remembered too (the half that a default-open tree can never do)')
await page.click('details.nt-dir[data-dir="Classes/Thermo"] > summary')
await page.waitForTimeout(200)
ok(!(await openDirs() || []).includes('Classes/Thermo'), 'collapsing removed it from the store')
await page.reload()
await page.waitForSelector('details.nt-dir', { timeout: 15000 })
dirs = await dirState()
ok(dirs.find((d) => d.dir === 'Classes/Thermo')?.open === false, 'still collapsed after reload')
ok(dirs.find((d) => d.dir === 'Classes')?.open === true, 'its parent stayed open')

await ctx.close()
await browser.close()
console.log(`\nnotes-tree-state: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
