// Two things that are cheap to get wrong and expensive to get wrong:
//
// 1. Changing the notes root MUST clear the sync snapshot. The snapshot
//    describes the OLD folder, so keeping it makes every file in that folder
//    look locally deleted on the next pass — and the reconciler would
//    faithfully propagate those deletes to the server and every other device.
//    This is the difference between "I moved my notes folder" and "all my
//    notes are gone everywhere".
// 2. The Apple Notes picker tree must come up collapsed and remember what was
//    opened, like the vault tree.
import { chromium } from 'playwright'

const BASE = process.env.ATLAS_BASE || 'http://localhost:5173'
let passed = 0, failed = 0
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name}`) } }

const TREE = { dirs: ['Classes', 'Classes/Thermo'], notes: [{ path: 'Classes/Thermo/a.md', mtime: 1 }, { path: 'top.md', mtime: 2 }] }
const APPLE = [{
  account: 'iCloud',
  folders: [
    { name: 'Notes', id: 'f1', notes: [{ id: 'n1', title: 'Lecture 1' }] },
    { name: 'Archive', id: 'f2', notes: [{ id: 'n2', title: 'Old thing' }] },
  ],
}]

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
const page = await ctx.newPage()

const jsonRoute = (obj) => (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) })
await page.route('**/notes-api/tree*', jsonRoute(TREE))
await page.route('**/notes-api/apple-tree*', jsonRoute(APPLE))
await page.route('**/notes-api/pick*', jsonRoute({ path: '/tmp/a-different-folder' }))
await page.route('**/notes-sync/**', jsonRoute({ rev: 0, files: [] }))
await page.route('**/graph-api/file*', (r) => r.fulfill({ status: 200, contentType: 'text/plain', body: '# stub' }))

await page.addInitScript(() => {
  const seed = (k, v) => { if (!localStorage.getItem(k)) localStorage.setItem(k, v) }
  seed('atlas.auth.v1', '{"offline":true}')
  seed('atlas.plugins.v1', JSON.stringify({ enabled: { notes: true }, installed: {} }))
  seed('atlas.notes.v1', JSON.stringify({ dir: '/tmp/original-folder', lastSubdir: '', openDirs: ['Classes'] }))
  // The upload modal (and so the Apple Notes picker) is gated on a connected
  // AI account; nothing in this probe ever calls it.
  seed('atlas.ai.v1', JSON.stringify({ providers: { claude: { oauth: { access: 'stub-token', expires: Date.now() + 36e5 } } } }))
  // A snapshot from the ORIGINAL folder — exactly what must not survive.
  seed('atlasNotesSync', JSON.stringify({ rev: 7, files: { 'Classes/Thermo/a.md': { sha256: 'abc', mtime: 1 }, 'top.md': { sha256: 'def', mtime: 2 } } }))
})

const snap = () => page.evaluate(() => localStorage.getItem('atlasNotesSync'))
const openDirs = () => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('atlas.notes.v1')).openDirs } catch { return null } })

await page.goto(`${BASE}/#/notes`)
await page.waitForSelector('details.nt-dir', { timeout: 15000 })

console.log('1. the snapshot exists before the folder changes')
// The page syncs as soon as it opens, so the snapshot may already have been
// rewritten — what matters is that one EXISTS to be destroyed by step 2.
ok((await snap()) !== null, 'a snapshot for the original folder exists')
ok((await openDirs() || []).includes('Classes'), 'seeded open folder is present')

console.log('2. changing the notes root clears it (the mass-delete guard)')
await page.click('[data-nt="pick"]')
await page.waitForFunction(() => {
  try { return JSON.parse(localStorage.getItem('atlas.notes.v1')).dir === '/tmp/a-different-folder' } catch { return false }
}, null, { timeout: 8000 }).catch(() => {})
ok(await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.notes.v1')).dir) === '/tmp/a-different-folder', 'the new folder was stored')
// Not "the snapshot is null": the re-render immediately syncs the NEW folder
// and writes a fresh one, which is correct. The invariant is that nothing the
// OLD folder recorded survives — those entries are what would be replayed as
// deletions.
const after = await snap()
const stale = after ? Object.values(JSON.parse(after).files || {}).filter((f) => f.sha256 === 'abc' || f.sha256 === 'def') : []
ok(stale.length === 0, `no entry from the old folder survived (found ${stale.length})`)
ok(after === null || JSON.parse(after).rev !== 7, 'the old revision cursor is gone')
ok((await openDirs() || []).length === 0, 'the old folder\'s expanded-state was dropped too')

console.log('3. the Apple Notes picker tree starts collapsed')
await page.click('[data-nt="new"]').catch(() => {})
await page.waitForTimeout(300)
const appleBtn = page.locator('[data-nt="up-apple"]')
if (await appleBtn.count()) {
  await appleBtn.click()
  await page.waitForSelector('details.nt-dir[data-dir^="apple:"]', { timeout: 10000 })
  const dirs = await page.$$eval('details.nt-dir[data-dir^="apple:"]', (els) => els.map((e) => ({ dir: e.dataset.dir, open: e.open })))
  ok(dirs.length >= 3, `apple tree rendered ${dirs.length} nodes`)
  ok(dirs.every((d) => !d.open), 'every Apple Notes folder starts collapsed')
  ok(dirs.some((d) => d.dir === 'apple:iCloud/Notes'), 'nested Apple folders are keyed by account/folder')

  console.log('4. expanding an Apple folder is remembered')
  await page.click('details.nt-dir[data-dir="apple:iCloud"] > summary')
  await page.waitForTimeout(250)
  const saved = await openDirs()
  ok((saved || []).includes('apple:iCloud'), 'the Apple account node was stored under its namespaced key')
  ok(!(saved || []).includes('iCloud'), 'and it cannot collide with a vault folder of the same name')
} else {
  console.log('  (Apple picker button unavailable in this build — skipped)')
}

await ctx.close()
await browser.close()
console.log(`\nnotes-root-apple: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
