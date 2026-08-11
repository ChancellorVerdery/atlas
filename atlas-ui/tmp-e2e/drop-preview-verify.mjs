// Verify live drop preview (ghost) behavior — headless, real mouse drags.
import { chromium } from 'playwright';

const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","cols":[
   {"id":"c-1","lines":[
     {"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"A","text":"aa"},{"id":"w-b","kind":"card","title":"B","text":"bb"}]},
     {"id":"l-2","widgets":[{"id":"w-c","kind":"card","title":"C","text":"cc"}]}]},
   {"id":"c-2","lines":[
     {"id":"l-3","widgets":[{"id":"w-d","kind":"graph","graphType":"bar","title":"D","xLabel":"Day","yLabel":"N","points":[{"label":"Mon","value":10},{"label":"Tue","value":30},{"label":"Wed","value":20}]}]}]}]},
 {"id":"r-2","cols":[
   {"id":"c-3","lines":[
     {"id":"l-4","widgets":[{"id":"w-e","kind":"list","title":"E","items":["one","two"]}]}]}]}]};

const results = [];
const check = (name, ok, detail = '') => results.push({ check: name, ok: !!ok, detail });

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual(a[k], b[k]));
  }
  return false;
}

const ghostInfo = (page) => page.evaluate(() => {
  const ghosts = [...document.querySelectorAll('.drop-ghost')];
  if (!ghosts.length) return { count: 0 };
  const g = ghosts[0];
  const p = g.parentElement;
  return {
    count: ghosts.length,
    parentClass: p ? p.className : null,
    parentIsPline: !!p && p.classList.contains('pline'),
    parentIsPcol: !!p && p.classList.contains('pcol'),
    parentIsPageRoot: !!p && p.classList.contains('page-root'),
    parentLineId: p ? p.getAttribute('data-line-id') : null,
    parentColId: p ? p.getAttribute('data-col-id') : null,
    index: p ? Array.prototype.indexOf.call(p.children, g) : -1,
    isBand: g.classList.contains('drop-ghost--band'),
  };
});

const transformState = (page) => page.evaluate(() => {
  const bad = [...document.querySelectorAll('.pwidget')]
    .filter(el => el.style.transform && el.style.transform !== 'none')
    .map(el => `${el.getAttribute('data-widget-id')}:${el.style.transform}`);
  return bad;
});

// Move to (x,y) then micro-jiggle with pauses so the app's rAF-throttled
// dragover handler definitely processes coordinates at (effectively) this
// point. Real browsers re-fire dragover on a ~350ms timer while stationary;
// CDP-synthesized drags do not, so without this the last move can be
// swallowed by the rafPending throttle and resolution goes one step stale.
async function hoverAt(page, x, y) {
  await page.mouse.move(x, y, { steps: 12 });
  for (const [dx, dy] of [[1, 0], [-1, 1], [0, -1], [0, 0]]) {
    await page.waitForTimeout(70);
    await page.mouse.move(x + dx, y + dy);
  }
  await page.waitForTimeout(280);
}

const box = async (page, sel) => {
  const b = await page.locator(sel).first().boundingBox();
  if (!b) throw new Error('no box for ' + sel);
  return b;
};

const browser = await chromium.launch({ headless: true });

// ---------- Context 1: standard fixture ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
  await ctx.addInitScript(f => localStorage.setItem('atlas.page.v1', JSON.stringify(f)), FIXTURE);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto('http://localhost:5173');
  await page.waitForSelector('.pwidget[data-widget-id="w-a"]');
  await page.click('#customize');
  await page.waitForSelector('body.customizing');
  await page.waitForSelector('.palette__item[data-kind="card"]');
  const baselineModel = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1'))); // post-migration shape

  // Pre-drag geometry (matches the app's dragstart snapshot)
  const pal = await box(page, '.palette__item[data-kind="card"]');
  const wa = await box(page, '.pwidget[data-widget-id="w-a"]');
  const content = await box(page, '#content');
  const sidebar = await box(page, '.sidebar');
  const rowBoxes = await page.$$eval('.prow', els => els.map(e => {
    const r = e.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }));

  // ---- Start real mouse drag from palette card item ----
  await page.mouse.move(pal.x + pal.width / 2, pal.y + pal.height / 2);
  await page.mouse.down();
  await page.mouse.move(pal.x + pal.width / 2 + 12, pal.y + pal.height / 2 + 6, { steps: 4 });

  // 1. hover w-a LEFT zone
  await hoverAt(page, wa.x + wa.width * 0.3, wa.y + wa.height / 2);
  let g = await ghostInfo(page);
  check('1a. exactly one ghost on w-a left hover', g.count === 1, g.count === 1 ? '' : `ghost count=${g.count}`);
  check('1b. ghost is child of .pline[data-line-id=l-1]', g.parentIsPline && g.parentLineId === 'l-1',
    `parentClass=${g.parentClass} lineId=${g.parentLineId}`);
  check('1c. ghost at DOM index 0 (before w-a)', g.index === 0, `index=${g.index}`);
  const waNow = await box(page, '.pwidget[data-widget-id="w-a"]');
  check('1d. w-a shifted right to make room', waNow.x > wa.x + 1,
    `pre x=${wa.x.toFixed(1)} now x=${waNow.x.toFixed(1)}`);

  // 2. same drag → w-a BOTTOM zone (use pre-drag snapshot coords)
  await hoverAt(page, wa.x + wa.width / 2, wa.y + wa.height * 0.92);
  g = await ghostInfo(page);
  check('2a. exactly one ghost on w-a bottom hover', g.count === 1, g.count === 1 ? '' : `ghost count=${g.count}`);
  check('2b. ghost is band child of c-1\'s section (.psec)', g.parentClass === 'psec' && g.isBand,
    `parentClass=${g.parentClass} band=${g.isBand}`);

  // 3. move outside #content (over sidebar, below palette)
  const outPt = { x: sidebar.x + sidebar.width / 2, y: sidebar.y + sidebar.height - 40 };
  await hoverAt(page, outPt.x, outPt.y);
  g = await ghostInfo(page);
  check('3. ghost removed when cursor leaves #content', g.count === 0, `ghost count=${g.count}`);

  // 4. gap between rows r-1 and r-2
  const gapY = (rowBoxes[0].y + rowBoxes[0].height + rowBoxes[1].y) / 2;
  await hoverAt(page, content.x + content.width / 2, gapY);
  g = await ghostInfo(page);
  check('4a. ghost reappears in row gap', g.count === 1, `ghost count=${g.count}`);
  check('4b. ghost is band child of .page-root at index 1', g.parentIsPageRoot && g.isBand && g.index === 1,
    `parentIsPageRoot=${g.parentIsPageRoot} band=${g.isBand} index=${g.index}`);

  // 5. release OUTSIDE #content → cancelled drag
  await hoverAt(page, outPt.x, outPt.y);
  await page.mouse.up();
  await page.waitForTimeout(320);
  g = await ghostInfo(page);
  check('5a. 0 ghosts after cancelled drag', g.count === 0, `ghost count=${g.count}`);
  const dragging = await page.evaluate(() => document.querySelectorAll('.is-dragging').length);
  check('5b. no .is-dragging after cancel', dragging === 0, `.is-dragging count=${dragging}`);
  const badTf1 = await transformState(page);
  check('5c. no inline transforms on .pwidget after cancel', badTf1.length === 0, badTf1.join(', '));
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  check('5d. localStorage unchanged after cancelled drag', deepEqual(stored, baselineModel),
    deepEqual(stored, FIXTURE) ? '' : `stored=${JSON.stringify(stored)}`);

  // 6. fresh drag palette → w-e right zone, DROP
  const we = await box(page, '.pwidget[data-widget-id="w-e"]');
  const pal2 = await box(page, '.palette__item[data-kind="card"]');
  await page.mouse.move(pal2.x + pal2.width / 2, pal2.y + pal2.height / 2);
  await page.mouse.down();
  await page.mouse.move(pal2.x + pal2.width / 2 + 12, pal2.y + pal2.height / 2 + 6, { steps: 4 });
  await hoverAt(page, we.x + we.width * 0.92, we.y + we.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(320);
  const after = await page.evaluate(() => {
    const data = JSON.parse(localStorage.getItem('atlas.page.v1'));
    let n = 0; const l4 = [];
    for (const r of data.rows) for (const c of r.cols) for (const sec of c.sections) for (const l of sec.lines) {
      n += l.widgets.length;
      if (l.id === 'l-4') l4.push(...l.widgets.map(w => w.kind + ':' + w.id));
    }
    return { total: n, dom: document.querySelectorAll('.pwidget').length, l4 };
  });
  check('6a. drop added widget (5 → 6)', after.total === 6 && after.dom === 6,
    `stored total=${after.total} dom=${after.dom} l4=${after.l4.join(',')}`);
  g = await ghostInfo(page);
  check('6b. 0 ghosts after drop', g.count === 0, `ghost count=${g.count}`);
  const badTf2 = await transformState(page);
  check('6c. no leftover inline transforms after drop', badTf2.length === 0, badTf2.join(', '));

  check('console: no errors (fixture context)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------- Context 2: empty page ----------
{
  // Try truly cleared localStorage first; fall back to rows:[] if the app seeds demo content.
  let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => localStorage.setItem('atlas.devMode', '1'));
  let page = await ctx.newPage();
  let errors = [];
  const hook = (p) => {
    p.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    p.on('pageerror', e => errors.push(String(e)));
  };
  hook(page);
  await page.goto('http://localhost:5173');
  await page.waitForSelector('#customize');
  await page.click('#customize');
  await page.waitForSelector('body.customizing');
  let emptyDrop = await page.$('.page-empty-drop');
  if (!emptyDrop) {
    await ctx.close();
    ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(() => localStorage.setItem('atlas.devMode', '1'));
    await ctx.addInitScript(() => localStorage.setItem('atlas.page.v1', JSON.stringify({ v: 1, rows: [] })));
    page = await ctx.newPage();
    errors = [];
    hook(page);
    await page.goto('http://localhost:5173');
    await page.waitForSelector('#customize');
    await page.click('#customize');
    await page.waitForSelector('body.customizing');
    emptyDrop = await page.$('.page-empty-drop');
  }
  check('E0. .page-empty-drop present on empty page in customize', !!emptyDrop, emptyDrop ? '' : 'no .page-empty-drop found');
  if (emptyDrop) {
    await page.waitForSelector('.palette__item[data-kind="list"]');
    const pal = await box(page, '.palette__item[data-kind="list"]');
    const ed = await box(page, '.page-empty-drop');
    await page.mouse.move(pal.x + pal.width / 2, pal.y + pal.height / 2);
    await page.mouse.down();
    await page.mouse.move(pal.x + pal.width / 2 + 12, pal.y + pal.height / 2 + 6, { steps: 4 });
    await hoverAt(page, ed.x + ed.width / 2, ed.y + ed.height / 2);
    const isOver = await page.evaluate(() => {
      const el = document.querySelector('.page-empty-drop');
      return el ? el.classList.contains('is-over') : null;
    });
    check('E1. .page-empty-drop gains .is-over on hover', isOver === true, `is-over=${isOver}`);
    await page.mouse.up();
    await page.waitForTimeout(320);
    const state = await page.evaluate(() => ({
      rows: JSON.parse(localStorage.getItem('atlas.page.v1')).rows.length,
      domRows: document.querySelectorAll('.prow').length,
      widgets: document.querySelectorAll('.pwidget').length,
    }));
    check('E2. drop on empty page creates a row', state.rows === 1 && state.domRows === 1 && state.widgets === 1,
      `stored rows=${state.rows} dom rows=${state.domRows} widgets=${state.widgets}`);
  } else {
    check('E1. .page-empty-drop gains .is-over on hover', false, 'skipped: no empty-drop');
    check('E2. drop on empty page creates a row', false, 'skipped: no empty-drop');
  }
  check('console: no errors (empty-page context)', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
process.exitCode = results.every(r => r.ok) ? 0 : 1;
