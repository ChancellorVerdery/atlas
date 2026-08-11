import { chromium } from 'playwright';
const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","cols":[
   {"id":"c-1","lines":[{"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"A","text":"aa"}]}]},
   {"id":"c-2","lines":[{"id":"l-2","widgets":[{"id":"w-b","kind":"card","title":"B","text":"bb"}]}]}]}]};
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
  await page.waitForSelector('.pcol-resize');
  return { context, page, errs };
}
const widths = (page) => page.evaluate(() => {
  const l = document.querySelector('.pcol[data-col-id="c-1"]').getBoundingClientRect().width;
  const r = document.querySelector('.pcol[data-col-id="c-2"]').getBoundingClientRect().width;
  return { l, r, ratio: l / (l + r) };
});
async function dragBarTo(page, fracOfPair, jitter = 0) {
  const bar = await page.locator('.pcol-resize').boundingBox();
  const w = await widths(page);
  const pair = w.l + w.r;
  const targetX = bar.x + bar.width / 2 - (w.l - (pair * fracOfPair + jitter));
  await page.mouse.move(bar.x + bar.width / 2, bar.y + bar.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(bar.x + bar.width / 2 + ((targetX - bar.x - bar.width / 2) * i) / 8, bar.y + bar.height / 2);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);
}

// 1. snap to 1/3 from 15px away
{
  const { context, page, errs } = await session();
  await dragBarTo(page, 1 / 3, 15); // aim 15px right of the exact third — inside the 26px radius
  const w = await widths(page);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  const [c1, c2] = st.rows[0].cols.map((c) => c.width);
  check('snaps to 1/3 (customize DOM, small scaffold skew ok)', Math.abs(w.ratio - 1 / 3) < 0.012, `ratio=${w.ratio.toFixed(3)}`);
  check('persists grow shares ~ 1:2', Math.abs(c1 / (c1 + c2) - 1 / 3) < 0.005, `widths=${c1},${c2} errs=${errs.join('|')}`);
  await page.reload({ waitUntil: 'load' });
  const w2 = await widths(page);
  check('survives reload', Math.abs(w2.ratio - 1 / 3) < 0.012, `ratio=${w2.ratio.toFixed(3)}`);
  await page.click('#customize'); // exit to view mode
  await page.waitForTimeout(200);
  const w3 = await widths(page);
  check('view mode matches (gap vs bars)', Math.abs(w3.ratio - 1 / 3) < 0.01, `ratio=${w3.ratio.toFixed(3)}`);
  await context.close();
}
// 2. free position far from all fractions
{
  const { context, page } = await session();
  await dragBarTo(page, 0.42);
  const w = await widths(page);
  check('free resize (no snap) lands at 0.42', Math.abs(w.ratio - 0.42) < 0.02, `ratio=${w.ratio.toFixed(3)}`);
  await context.close();
}
// 3. snap to 1/2 from 20px away + widgets untouched by the bar drag
{
  const { context, page } = await session();
  await dragBarTo(page, 0.42); // move off-center first
  await dragBarTo(page, 1 / 2, -20);
  const w = await widths(page);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  const ids = st.rows[0].cols.flatMap((c) => c.sections.flatMap((sec) => sec.lines).flatMap((l) => l.widgets.map((x) => x.id)));
  check('snaps back to 1/2', Math.abs(w.ratio - 0.5) < 0.005, `ratio=${w.ratio.toFixed(3)}`);
  check('bar drag never moves widgets', JSON.stringify(ids) === '["w-a","w-b"]', JSON.stringify(ids));
  await context.close();
}
// 4. snap to 1/4 and 3/4
{
  const { context, page } = await session();
  await dragBarTo(page, 1 / 4, 12);
  const a = await widths(page);
  await dragBarTo(page, 3 / 4, -12);
  const b = await widths(page);
  check('snaps to 1/4 (stored exact, DOM skew ok)', Math.abs(a.ratio - 0.25) < 0.012, `ratio=${a.ratio.toFixed(3)}`);
  check('snaps to 3/4 (stored exact, DOM skew ok)', Math.abs(b.ratio - 0.75) < 0.012, `ratio=${b.ratio.toFixed(3)}`);
  const st4 = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  const [x1, x2] = st4.rows[0].cols.map((c) => c.width);
  check('stored shares exactly 3:1', Math.abs(x1 / (x1 + x2) - 0.75) < 0.001, `widths=${x1},${x2}`);
  await context.close();
}
await browser.close();
let fail = 0;
for (const c of out) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`); if (!c.ok) fail++; }
process.exit(fail ? 1 : 0);
