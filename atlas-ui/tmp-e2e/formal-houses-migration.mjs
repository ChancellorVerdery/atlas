// Formal: the legacy "houses" migration must run at most once per device.
//
// The bug it guards: the migration used to be self-disabling only on `houses`
// having been stripped from atlas.formal.v1. That strip is a separate write,
// and if the server keeps handing `houses` back, the migration re-fired on
// EVERY launch and re-inserted a House widget the user had deleted.
//
// Run: node tmp-e2e/formal-houses-migration.mjs   (needs the dev server on 5173)
import { chromium } from 'playwright'

const HOUSE = { id: 'h-legacy', name: 'Legacy House', link: '', price: 4200, couches: 2, rooms: [] }
const seed = () => ({
  'atlas.auth.v1': JSON.stringify({ offline: true }),
  'atlas.plugins.v1': JSON.stringify({ enabled: { formal: true }, installed: {} }),
  'atlas.formal.v1': JSON.stringify({ brothers: 0, houses: [HOUSE] }),
  'atlas.page.formal.v1': JSON.stringify({ v: 1, rows: [] }),
})

const widgetIds = (board) => {
  const out = []
  for (const r of board?.rows || []) for (const c of r.cols || []) for (const s of c.sections || [])
    for (const l of s.lines || []) for (const w of l.widgets || []) out.push(w.id)
  return out
}

async function run({ clearFlag }) {
  const b = await chromium.launch({ headless: true })
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript((kv) => {
    if (!localStorage.getItem('atlas.auth.v1')) for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v)
  }, seed())
  const pg = await ctx.newPage()

  // 1. first load: the migration legitimately runs and adopts the legacy house
  await pg.goto('http://localhost:5173/#/formal', { waitUntil: 'domcontentloaded' })
  // wait for the app module to have evaluated, rather than guessing a delay
  await pg.waitForFunction(() => localStorage.getItem('atlas.formal.housesMigrated') === '1', null, { timeout: 10000 })
  const afterMigrate = widgetIds(await pg.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.formal.v1'))))

  // 2. the user deletes that widget, and the server hands `houses` back
  await pg.evaluate(({ house, clearFlag }) => {
    localStorage.setItem('atlas.page.formal.v1', JSON.stringify({ v: 1, rows: [] }))
    localStorage.setItem('atlas.formal.v1', JSON.stringify({ brothers: 0, houses: [house] }))
    if (clearFlag) localStorage.removeItem('atlas.formal.housesMigrated')
  }, { house: HOUSE, clearFlag })

  // 3. relaunch
  await pg.reload({ waitUntil: 'domcontentloaded' })
  await pg.waitForFunction(() => !!document.querySelector('#content'), null, { timeout: 10000 })
  await pg.waitForTimeout(700) // let any late re-seed/migration write land
  const afterReload = widgetIds(await pg.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.formal.v1'))))
  const flag = await pg.evaluate(() => localStorage.getItem('atlas.formal.housesMigrated'))
  await b.close()
  return { afterMigrate, afterReload, flag }
}

const guarded = await run({ clearFlag: false })
const unguarded = await run({ clearFlag: true }) // simulates the pre-fix behaviour

let bad = 0
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) bad++ }

check(guarded.afterMigrate.length === 1, `first load migrates the legacy house (got ${JSON.stringify(guarded.afterMigrate)})`)
check(guarded.flag === '1', 'the migration records its one-time flag')
check(guarded.afterReload.length === 0, `a deleted House widget STAYS deleted across a relaunch (got ${JSON.stringify(guarded.afterReload)})`)
// sensitivity: without the flag the old behaviour is still reproducible, so the
// test above is really testing the guard and not something else.
check(unguarded.afterReload.length === 1, `sensitivity: with the flag cleared the widget does come back (got ${JSON.stringify(unguarded.afterReload)})`)

console.log(bad ? `\n${bad} check(s) failed` : '\nformal-houses-migration: all checks passed')
process.exit(bad ? 1 : 0)
