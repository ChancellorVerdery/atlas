import { chromium } from 'playwright';
const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","cols":[
   {"id":"c-1","lines":[{"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"A","text":"aa"}]}]},
   {"id":"c-2","lines":[{"id":"l-2","widgets":[{"id":"w-b","kind":"card","title":"B","text":"bb"}]}]}]},
 {"id":"r-2","cols":[
   {"id":"c-3","lines":[{"id":"l-3","widgets":[{"id":"w-c","kind":"list","title":"C","items":["x"]}]}]}]}]};
const out = [];
const check = (n, ok, d = '') => out.push({ name: n, ok, detail: d });
const browser = await chromium.launch({ headless: true });
async function session() {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
  await context.addInitScript((fx) => { if (!localStorage.getItem('atlas.page.v1')) localStorage.setItem('atlas.page.v1', JSON.stringify(fx)); }, FIXTURE);
  const page = await context.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'load' });
  await page.click('#customize');
  await page.waitForSelector('.prow-resize');
  return { context, page, errs };
}
const geom = (page) => page.evaluate(() => {
  const root = document.querySelector('.page-root').getBoundingClientRect();
  const r1 = document.querySelector('.prow[data-row-id="r-1"]').getBoundingClientRect();
  const r2 = document.querySelector('.prow[data-row-id="r-2"]').getBoundingClientRect();
  return { rootW: root.width, r1W: r1.width, r2W: r2.width, frac1: r1.width / root.width, frac2: r2.width / root.width };
});
async function dragRowEdge(page, rowId, fracOfRoot, jitter = 0) {
  const bar = await page.locator(`.prow[data-row-id="${rowId}"] .prow-resize`).boundingBox();
  const g = await geom(page);
  const dx = (g.rootW * fracOfRoot + jitter) - (rowId === 'r-1' ? g.r1W : g.r2W);
  const cx = bar.x + bar.width / 2, cy = bar.y + bar.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(cx + (dx * i) / 8, cy); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(200);
}
// 1. snap to 1/2 (aim 15px wide of it), other row untouched, persists, view matches
{
  const { context, page, errs } = await session();
  await dragRowEdge(page, 'r-1', 0.5, 15);
  const g = await geom(page);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  check('row snaps to 1/2', Math.abs(g.frac1 - 0.5) < 0.005, `frac=${g.frac1.toFixed(3)}`);
  check('stored width 50', st.rows[0].width === 50, `w=${st.rows[0].width} errs=${errs.join('|')}`);
  check('other row untouched (full)', Math.abs(g.frac2 - 1) < 0.005 && st.rows[1].width == null, `frac2=${g.frac2.toFixed(3)} w2=${st.rows[1].width}`);
  await page.reload({ waitUntil: 'load' });
  const g2 = await geom(page);
  check('survives reload (view mode)', Math.abs(g2.frac1 - 0.5) < 0.005, `frac=${g2.frac1.toFixed(3)}`);
  await context.close();
}
// 2. free width (no snap) at 0.42 of the page; then col bar still works inside the narrow row
{
  const { context, page } = await session();
  await dragRowEdge(page, 'r-1', 0.42);
  const g = await geom(page);
  check('free row width 0.42', Math.abs(g.frac1 - 0.42) < 0.02, `frac=${g.frac1.toFixed(3)}`);
  // section resize inside the narrowed row still snaps against the PAIR
  const bar = await page.locator('.pcol-resize').boundingBox();
  const pair = await page.evaluate(() => {
    const l = document.querySelector('.pcol[data-col-id="c-1"]').getBoundingClientRect().width;
    const r = document.querySelector('.pcol[data-col-id="c-2"]').getBoundingClientRect().width;
    return { l, r };
  });
  const target = (pair.l + pair.r) / 3 + 12 - pair.l;
  const cx = bar.x + bar.width / 2, cy = bar.y + bar.height / 2;
  await page.mouse.move(cx, cy); await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(cx + (target * i) / 6, cy); await page.waitForTimeout(16); }
  await page.mouse.up(); await page.waitForTimeout(200);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  const [a, b] = st.rows[0].cols.map((c) => c.width);
  check('section bar inside narrow row snaps to pair third', Math.abs(a / (a + b) - 1 / 3) < 0.005, `shares=${a},${b}`);
  await context.close();
}
// 3. snap back to full width near the page edge
{
  const { context, page } = await session();
  await dragRowEdge(page, 'r-1', 0.42);
  await dragRowEdge(page, 'r-1', 1, -18); // 18px short of full — inside snap radius
  const g = await geom(page);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  check('snaps back to full', Math.abs(g.frac1 - 1) < 0.005 && st.rows[0].width === 100, `frac=${g.frac1.toFixed(3)} w=${st.rows[0].width}`);
  await context.close();
}
// 4. quarter + third snapping
{
  const { context, page } = await session();
  await dragRowEdge(page, 'r-1', 1 / 3, 14);
  const a = await geom(page);
  await dragRowEdge(page, 'r-1', 3 / 4, -14);
  const b = await geom(page);
  check('row snaps to 1/3', Math.abs(a.frac1 - 1 / 3) < 0.005, `frac=${a.frac1.toFixed(3)}`);
  check('row snaps to 3/4', Math.abs(b.frac1 - 0.75) < 0.005, `frac=${b.frac1.toFixed(3)}`);
  await context.close();
}
await browser.close();
let fail = 0;
for (const c of out) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`); if (!c.ok) fail++; }
process.exit(fail ? 1 : 0);
