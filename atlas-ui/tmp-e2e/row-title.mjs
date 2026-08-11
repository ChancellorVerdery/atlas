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
await page.waitForSelector('.prow-title-input');

// 1. every row gets a title input; type into r-1's char by char — focus retained, live-saved
const inputs = await page.$$eval('.prow-title-input', (els) => els.length);
check('one title input per row', inputs === 2, `n=${inputs}`);
const field = page.locator('.prow[data-row-id="r-1"] .prow-title-input');
await field.click();
await field.pressSequentially('Key Metrics', { delay: 25 });
const focusOk = await page.evaluate(() => document.activeElement?.classList.contains('prow-title-input'));
const st1 = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
check('typing keeps focus', focusOk === true);
check('title live-saved to the right row', st1.rows[0].title === 'Key Metrics' && st1.rows[1].title == null, `t1=${st1.rows[0].title} t2=${st1.rows[1].title}`);

// 2. view mode: titled row shows h2, untitled row shows none
await page.click('#customize'); // Done
await page.waitForTimeout(200);
const view = await page.evaluate(() => ({
  h1: document.querySelector('.prow[data-row-id="r-1"] .prow-title')?.textContent,
  h2: !!document.querySelector('.prow[data-row-id="r-2"] .prow-title'),
  inputs: document.querySelectorAll('.prow-title-input').length,
}));
check('view mode renders the title', view.h1 === 'Key Metrics', `h1=${view.h1}`);
check('untitled row shows no title element', view.h2 === false && view.inputs === 0, `h2=${view.h2} inputs=${view.inputs}`);

// 3. persists across reload; escaping is safe
await page.reload({ waitUntil: 'load' });
const t = await page.evaluate(() => document.querySelector('.prow[data-row-id="r-1"] .prow-title')?.textContent);
check('survives reload', t === 'Key Metrics', `t=${t}`);
await page.click('#customize');
await page.locator('.prow[data-row-id="r-2"] .prow-title-input').fill('<img src=x onerror=alert(1)>');
await page.waitForTimeout(100);
await page.click('#customize');
await page.waitForTimeout(200);
const xss = await page.evaluate(() => {
  const el = document.querySelector('.prow[data-row-id="r-2"] .prow-title');
  return { text: el?.textContent, hasImg: !!el?.querySelector('img') };
});
check('titles are escaped (no HTML injection)', xss.text === '<img src=x onerror=alert(1)>' && !xss.hasImg, JSON.stringify(xss));
// 4. section titles: input per section, live-save to the right col, conditional view render
await page.reload({ waitUntil: 'load' });
await page.click('#customize');
await page.waitForSelector('.psec-title-input');
const secInputs = await page.$$eval('.psec-title-input', (els) => els.length);
check('one title input per section', secInputs === 2, `n=${secInputs}`);
const sfield = page.locator('.pcol[data-col-id="c-1"] .psec-title-input');
await sfield.click();
await sfield.pressSequentially('Finance', { delay: 25 });
const st2 = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
const c1 = st2.rows[0].cols[0].sections[0], c2 = st2.rows[1].cols[0].sections[0];
check('section title live-saved to the right col', c1.title === 'Finance' && c2.title == null, `c1=${c1.title} c2=${c2.title}`);
await page.click('#customize'); // Done
await page.waitForTimeout(200);
const secView = await page.evaluate(() => ({
  t1: document.querySelector('.pcol[data-col-id="c-1"] .psec-title')?.textContent,
  t2: !!document.querySelector('.pcol[data-col-id="c-2"] .psec-title'),
  inputs: document.querySelectorAll('.psec-title-input').length,
}));
check('view renders section title only when set', secView.t1 === 'Finance' && !secView.t2 && secView.inputs === 0, JSON.stringify(secView));
await page.reload({ waitUntil: 'load' });
const t2v = await page.evaluate(() => document.querySelector('.pcol[data-col-id="c-1"] .psec-title')?.textContent);
check('section title survives reload', t2v === 'Finance', `t=${t2v}`);
check('no console errors', errs.length === 0, errs.join('|'));
await browser.close();
let fail = 0;
for (const c of out) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`); if (!c.ok) fail++; }
process.exit(fail ? 1 : 0);
