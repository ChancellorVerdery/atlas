import { chromium } from 'playwright';
// OLD-shape fixture on purpose — also proves the migration path.
const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","cols":[
   {"id":"c-1","title":"Finance","lines":[
     {"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"A","text":"aa"},{"id":"w-b","kind":"card","title":"B","text":"bb"}]},
     {"id":"l-2","widgets":[{"id":"w-c","kind":"card","title":"C","text":"cc"}]}]},
   {"id":"c-2","lines":[
     {"id":"l-3","widgets":[{"id":"w-d","kind":"graph","graphType":"bar","title":"D","xLabel":"Day","yLabel":"N","points":[{"label":"Mon","value":10},{"label":"Tue","value":30}]}]}]}]}]};
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
  await page.waitForSelector('.psec');
  return { context, page, errs };
}
async function dragPaletteTo(page, kind, x, y) {
  const pal = await page.locator(`.palette__item[data-kind="${kind}"]`).boundingBox();
  await page.mouse.move(pal.x + 20, pal.y + 10);
  await page.mouse.down();
  const sx = pal.x + 20, sy = pal.y + 10;
  for (let i = 1; i <= 14; i++) { await page.mouse.move(sx + ((x - sx) * i) / 14, sy + ((y - sy) * i) / 14); await page.waitForTimeout(16); }
  // tiny wiggle so headless Chromium delivers a dragover AT the final spot
  await page.mouse.move(x + 2, y); await page.waitForTimeout(30);
  await page.mouse.move(x, y); await page.waitForTimeout(200);
  const ghost = await page.evaluate(() => {
    const g = document.querySelector('.drop-ghost');
    return g && { parent: g.parentElement.className.split(' ')[0], band: g.classList.contains('drop-ghost--band') };
  });
  await page.mouse.up();
  await page.waitForTimeout(250);
  return ghost;
}
const model = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));

// 0 + 1. migration renders; drop at section TOP edge band -> new section above
{
  const { context, page, errs } = await session();
  const mig = await model(page); // untouched until a mutation — read the rendered DOM instead
  const dom = await page.evaluate(() => ({
    secs: document.querySelectorAll('.pcol[data-col-id="c-1"] .psec').length,
    title: document.querySelector('.pcol[data-col-id="c-1"] .psec-title-input')?.value,
    widgets: document.querySelectorAll('.pwidget').length,
  }));
  check('old data migrates: 1 section per col, title moved down', dom.secs === 1 && dom.title === 'Finance' && dom.widgets === 4, JSON.stringify(dom) + ` errs=${errs.join('|')}`);
  const sec = await page.locator('.pcol[data-col-id="c-1"] .psec').boundingBox();
  const ghost = await dragPaletteTo(page, 'card', sec.x + sec.width / 2, sec.y + 8); // 8px inside the top edge
  const m = await model(page);
  const c1 = m.rows[0].cols[0];
  check('top edge band previews a band ghost in the column', ghost && ghost.parent === 'pcol' && ghost.band, JSON.stringify(ghost));
  check('drop creates new section ABOVE', c1.sections.length === 2 && c1.sections[0].lines[0].widgets[0].kind === 'card' && c1.sections[1].title === 'Finance', `sections=${c1.sections.length} first=${JSON.stringify(c1.sections[0].lines.map((l) => l.widgets.map((w) => w.id)))}`);
  check('row box unchanged (still one row, two cols)', m.rows.length === 1 && m.rows[0].cols.length === 2, `rows=${m.rows.length} cols=${m.rows[0].cols.length}`);
  await context.close();
}
// 2. drop at section BOTTOM edge band -> new section below
{
  const { context, page } = await session();
  const sec = await page.locator('.pcol[data-col-id="c-1"] .psec').boundingBox();
  await dragPaletteTo(page, 'list', sec.x + sec.width / 2, sec.y + sec.height - 8);
  const m = await model(page);
  const c1 = m.rows[0].cols[0];
  check('bottom edge band -> new section BELOW', c1.sections.length === 2 && c1.sections[0].title === 'Finance' && c1.sections[1].lines[0].widgets[0].kind === 'list', `sections=${JSON.stringify(c1.sections.map((s) => s.title || s.lines[0].widgets[0].kind))}`);
  await context.close();
}
// 3. deeper inside: widget top zone still adds a LINE to the SAME section
{
  const { context, page } = await session();
  const wa = await page.locator('.pwidget[data-widget-id="w-a"]').boundingBox();
  await dragPaletteTo(page, 'card', wa.x + wa.width / 2, wa.y + wa.height * 0.12);
  const m = await model(page);
  const c1 = m.rows[0].cols[0];
  check('widget top zone -> new line INSIDE the section', c1.sections.length === 1 && c1.sections[0].lines.length === 3, `sections=${c1.sections.length} lines=${c1.sections[0].lines.length}`);
  await context.close();
}
// 4. move an existing widget into another column's edge band -> stacked section there
{
  const { context, page } = await session();
  const wc = await page.locator('.pwidget[data-widget-id="w-c"]').boundingBox();
  const sec2 = await page.locator('.pcol[data-col-id="c-2"] .psec').boundingBox();
  // grab by the card's padding (its center is covered by edit fields, which
  // correctly refuse to start a widget drag)
  await page.mouse.move(wc.x + 12, wc.y + 12);
  await page.mouse.down();
  const sx = wc.x + 12, sy = wc.y + 12, tx = sec2.x + sec2.width / 2, ty = sec2.y + sec2.height - 8;
  for (let i = 1; i <= 14; i++) { await page.mouse.move(sx + ((tx - sx) * i) / 14, sy + ((ty - sy) * i) / 14); await page.waitForTimeout(16); }
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const m = await model(page);
  const c2 = m.rows[0].cols[1];
  const ids = new Set(JSON.stringify(m).match(/w-[a-z0-9]+/g));
  check('moved widget forms a stacked section in the other column', c2.sections.length === 2 && c2.sections[1].lines[0].widgets[0].id === 'w-c', `cols=${JSON.stringify(m.rows[0].cols)}`);
  check('no duplicate ids after move', ids.size === 4, `ids=${[...ids]}`);
  await context.close();
}
await browser.close();
let fail = 0;
for (const c of out) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`); if (!c.ok) fail++; }
process.exit(fail ? 1 : 0);
