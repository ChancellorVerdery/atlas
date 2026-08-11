import { chromium } from 'playwright';
const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","cols":[
   {"id":"c-1","lines":[{"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"A","text":"aa"}]}]},
   {"id":"c-2","lines":[{"id":"l-2","widgets":[{"id":"w-d","kind":"graph","graphType":"bar","title":"G","xLabel":"","yLabel":"","points":[{"label":"Mon","value":10},{"label":"Tue","value":30}]}]}]}]},
 {"id":"r-2","cols":[
   {"id":"c-3","lines":[{"id":"l-3","widgets":[{"id":"w-c","kind":"card","title":"C","text":"cc"}]}]}]}]};
const out = [];
const check = (n, ok, d = '') => out.push({ name: n, ok, detail: d });
const browser = await chromium.launch({ headless: true });
async function session() {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1300 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
  await context.addInitScript((fx) => { if (!localStorage.getItem('atlas.page.v1')) localStorage.setItem('atlas.page.v1', JSON.stringify(fx)); }, FIXTURE);
  const page = await context.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'load' });
  await page.click('#customize');
  await page.waitForSelector('.prow-hresize');
  return { context, page, errs };
}
const geom = (page, rowId = 'r-1') => page.evaluate((rid) => {
  const c = document.getElementById('content');
  const cs = getComputedStyle(c);
  const pool = c.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const row = document.querySelector(`.prow[data-row-id="${rid}"]`).getBoundingClientRect();
  const mount = document.querySelector('.chart-mount')?.getBoundingClientRect();
  return { pool, rowH: row.height, rowBottom: row.bottom, mountH: mount?.height };
}, rowId);
async function dragHeight(page, rowId, targetH, jitter = 0) {
  const bar = await page.locator(`.prow[data-row-id="${rowId}"] .prow-hresize`).boundingBox();
  const g = await geom(page, rowId);
  const dy = targetH + jitter - g.rowH;
  const cx = bar.x + bar.width / 2, cy = bar.y + bar.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(cx, cy + (dy * i) / 8); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(250);
}
// 1. snap to 1/2 of the content-area height (aim 15px past), persists + view mode + chart grows
{
  const { context, page, errs } = await session();
  const g0 = await geom(page);
  await dragHeight(page, 'r-1', (g0.pool * 2) / 3, 15);
  const g = await geom(page);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  check('row snaps to 2/3 pool', Math.abs(g.rowH - (g0.pool * 2) / 3) < 2, `rowH=${g.rowH} target=${((g0.pool * 2) / 3).toFixed(0)}`);
  check('stored height ~2/3 pool', Math.abs(st.rows[0].height - (g0.pool * 2) / 3) < 2, `h=${st.rows[0].height} errs=${errs.join('|')}`);
  check('chart grew past its 220px floor', g.mountH > 260, `mountH=${g.mountH}`);
  await page.reload({ waitUntil: 'load' });
  const g2 = await geom(page);
  check('survives reload (view mode)', Math.abs(g2.rowH - (g0.pool * 2) / 3) < 3, `rowH=${g2.rowH}`);
  await context.close();
}
// 2. free height (no snap) at 0.45 pool; then dragging below content floors without clipping
{
  const { context, page } = await session();
  const g0 = await geom(page);
  await dragHeight(page, 'r-1', g0.pool * 0.62);
  const g1 = await geom(page);
  check('free height ~0.62 pool (no snap)', Math.abs(g1.rowH - g0.pool * 0.62) < 4, `rowH=${g1.rowH} target=${(g0.pool * 0.62).toFixed(0)}`);
  await dragHeight(page, 'r-1', 60); // way below the graph's natural height
  const g2 = await geom(page);
  const clip = await page.evaluate(() => {
    const row = document.querySelector('.prow[data-row-id="r-1"]').getBoundingClientRect();
    const mount = document.querySelector('.chart-mount').getBoundingClientRect();
    return mount.bottom - row.bottom;
  });
  check('below-content drag floors at content height (no clipping)', g2.rowH >= 240 && clip < 1, `rowH=${g2.rowH} clipOverhang=${clip.toFixed(1)}`);
  await context.close();
}
// 3. snap to 1/3 and stored on the right row only
{
  const { context, page } = await session();
  const g0 = await geom(page);
  await dragHeight(page, 'r-2', g0.pool / 3, -14);
  const g = await geom(page, 'r-2');
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  check('second row snaps to pool/3', Math.abs(g.rowH - g0.pool / 3) < 2, `rowH=${g.rowH}`);
  check('only r-2 got a height', st.rows[1].height > 0 && st.rows[0].height == null, `h1=${st.rows[0].height} h2=${st.rows[1].height}`);
  await context.close();
}
await browser.close();
let fail = 0;
for (const c of out) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`); if (!c.ok) fail++; }
process.exit(fail ? 1 : 0);
