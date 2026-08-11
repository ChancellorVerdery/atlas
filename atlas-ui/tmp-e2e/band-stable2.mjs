import { chromium } from 'playwright';
const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","cols":[{"id":"c-1","lines":[{"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"A","text":"aa"}]}]}]},
 {"id":"r-2","cols":[{"id":"c-3","lines":[{"id":"l-4","widgets":[{"id":"w-e","kind":"list","title":"E","items":["one","two"]}]}]}]}]};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
await context.addInitScript((fx) => localStorage.setItem('atlas.page.v1', JSON.stringify(fx)), FIXTURE);
const page = await context.newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'load' });
await page.click('#customize');
const g = await page.evaluate(() => {
  const r1 = document.querySelector('.prow[data-row-id="r-1"]').getBoundingClientRect();
  const r2 = document.querySelector('.prow[data-row-id="r-2"]').getBoundingClientRect();
  return { gapY: (r1.bottom + r2.top) / 2, cx: (r1.left + r1.right) / 2 };
});
// human-cadence move: interpolate positions, dispatch one move per ~16ms
async function humanMove(toX, toY, fromX, fromY, ms = 350) {
  const n = Math.max(2, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(fromX + ((toX - fromX) * i) / n, fromY + ((toY - fromY) * i) / n);
    await page.waitForTimeout(16);
  }
}
const pal = await page.locator('.palette__item[data-kind="card"]').boundingBox();
const sx = pal.x + 20, sy = pal.y + 10;
await page.mouse.move(sx, sy);
await page.mouse.down();
await humanMove(g.cx, g.gapY, sx, sy, 400); // drag to the gap between rows
await page.waitForTimeout(500);
const before = await page.evaluate(() => {
  const gh = document.querySelector('.drop-ghost');
  return gh && { parent: gh.parentElement.className.split(' ')[0], idx: [...gh.parentElement.children].indexOf(gh), band: gh.classList.contains('drop-ghost--band'), top: Math.round(gh.getBoundingClientRect().top), bottom: Math.round(gh.getBoundingClientRect().bottom) };
});
await humanMove(g.cx, g.gapY + 45, g.cx, g.gapY, 150); // chase 45px INTO the visible band
await page.waitForTimeout(500);
const after = await page.evaluate(() => {
  const gh = document.querySelector('.drop-ghost');
  return gh && { parent: gh.parentElement.className.split(' ')[0], idx: [...gh.parentElement.children].indexOf(gh), band: gh.classList.contains('drop-ghost--band') };
});
await page.mouse.up();
await page.waitForTimeout(250);
const rows = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')).rows.map((r) => r.cols[0].sections[0].lines[0].widgets[0].kind + ':' + (r.id || 'new')));
console.log('band at gap  :', JSON.stringify(before));
console.log('after chase  :', JSON.stringify(after));
console.log('rows on drop :', JSON.stringify(rows));
// 'before' is informational: headless Chromium delivers no trailing dragover at a
// stationary boundary point, so the settled preview there is exercised by
// drop-preview-verify.mjs instead. What matters: once the cursor moves into the
// visible band, the band relocates correctly, HOLDS (no repel), and drop commits it.
const ok = after && after.parent === 'page-root' && after.idx === 1 && after.band && rows.length === 3 && rows[1].startsWith('card');
console.log(ok ? 'PASS: band appears between rows, holds while chased, drop commits row at index 1' : 'FAIL');
await browser.close();
process.exit(ok ? 0 : 1);
