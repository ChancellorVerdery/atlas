import { chromium } from 'playwright';
const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","cols":[{"id":"c-1","lines":[{"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"A","text":"aa"}]}]}]},
 {"id":"r-2","cols":[{"id":"c-2","lines":[{"id":"l-2","widgets":[{"id":"w-b","kind":"card","title":"B","text":"bb"}]}]}]}]};
const out = [];
const check = (n, ok, d = '') => out.push({ name: n, ok, detail: d });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
await context.addInitScript((fx) => { if (!localStorage.getItem('atlas.page.v1')) localStorage.setItem('atlas.page.v1', JSON.stringify(fx)); }, FIXTURE);
const page = await context.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.click('#customize');
await page.waitForSelector('.prow-hresize');

const state = () => page.evaluate(() => ({
  scrollTop: document.getElementById('content').scrollTop,
  rowH: document.querySelector('.prow[data-row-id="r-2"]').getBoundingClientRect().height,
  contentBottom: document.getElementById('content').getBoundingClientRect().bottom,
}));

const bar = await page.locator('.prow[data-row-id="r-2"] .prow-hresize').boundingBox();
const s0 = await state();
const cx = bar.x + bar.width / 2;
await page.mouse.move(cx, bar.y + bar.height / 2);
await page.mouse.down();
// drag into the auto-scroll band (20px above the content's bottom edge) at human cadence
const targetY = s0.contentBottom - 20;
for (let i = 1; i <= 10; i++) {
  await page.mouse.move(cx, bar.y + ((targetY - bar.y) * i) / 10);
  await page.waitForTimeout(16);
}
const atEdge = await state();
await page.waitForTimeout(900); // HOLD still — the rAF loop should keep growing + scrolling
const afterHold = await state();
check('auto-scroll engaged (scrollTop grew)', afterHold.scrollTop > 20, `scrollTop=${afterHold.scrollTop}`);
check('row kept growing while pointer held still', afterHold.rowH > atEdge.rowH + 80, `atEdge=${atEdge.rowH.toFixed(0)} afterHold=${afterHold.rowH.toFixed(0)}`);
// move OUT of the band (up 200px) — growth must stop
await page.mouse.move(cx, targetY - 200, { steps: 5 });
await page.waitForTimeout(150);
const h1 = (await state()).rowH;
await page.waitForTimeout(400);
const h2 = (await state()).rowH;
check('leaving the band stops growth', Math.abs(h2 - h1) < 2, `h1=${h1.toFixed(0)} h2=${h2.toFixed(0)}`);
await page.mouse.up();
await page.waitForTimeout(250);
const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
const rendered = (await state()).rowH;
check('released height persisted', Math.abs(st.rows[1].height - rendered) < 3, `stored=${st.rows[1].height} rendered=${rendered.toFixed(0)}`);
check('no console errors', errs.length === 0, errs.join('|'));
await browser.close();
let fail = 0;
for (const c of out) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`); if (!c.ok) fail++; }
process.exit(fail ? 1 : 0);
