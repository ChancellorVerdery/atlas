// E2E: moving existing widgets, row reorder, deletion. Headless only.
import { chromium } from 'playwright';
const colLines = (c) => c.sections.flatMap((sec) => sec.lines); // cols hold sections now
import { isDeepStrictEqual } from 'node:util';

const URL = (process.env.ATLAS_BASE || 'http://localhost:5173') + '/';
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
function check(name, ok, detail) { results.push({ check: name, ok: !!ok, detail: ok ? '' : (detail || 'failed') }); }

async function fresh(browser, errors, label) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => { localStorage.setItem('atlas.devMode', '1'); localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true })); }); // dev widgets in palette; offline auth bypasses the login gate // default 1280x720 puts r-2's handle offscreen
  await context.addInitScript((fx) => {
    localStorage.setItem('atlas.page.v1', JSON.stringify(fx));
    window.__dragstarts = 0;
    document.addEventListener('dragstart', () => { window.__dragstarts++; }, true);
  }, FIXTURE);
  const page = await context.newPage();
  page.on('console', m => { if (m.type() === 'error') errors.push(`[${label}] console: ${m.text()}`); });
  page.on('pageerror', e => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.goto(URL);
  await page.waitForSelector('.pwidget[data-widget-id="w-a"]');
  await page.click('#customize');
  await page.waitForSelector('body.customizing');
  await page.waitForSelector('.palette');
  return { context, page };
}

const state = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
const box = async (page, sel) => {
  const b = await page.locator(sel).boundingBox();
  if (!b) throw new Error('no bounding box for ' + sel);
  return b;
};

let ghostSeen = false;
// Human cadence (one move per ~16ms): headless Chromium's drag controller
// drops trailing dragovers from instantaneous bursts — see memory note.
async function dragTo(page, fx, fy, tx, ty) {
  await page.mouse.move(fx, fy);
  await page.mouse.down();
  for (let i = 1; i <= 14; i++) {
    await page.mouse.move(fx + ((tx - fx) * i) / 14, fy + ((ty - fy) * i) / 14);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(120);
  ghostSeen = await page.evaluate(() => !!document.querySelector('.drop-ghost'));
  await page.mouse.up();
  await page.waitForTimeout(200);
}

function allWidgetIds(s) {
  const ids = [];
  for (const r of s.rows) for (const c of r.cols) for (const l of colLines(c)) for (const w of l.widgets) ids.push(w.id);
  return ids;
}
function findLineOf(s, wid) {
  for (const r of s.rows) for (const c of r.cols) for (const l of colLines(c))
    if (l.widgets.some(w => w.id === wid)) return { row: r, col: c, line: l };
  return null;
}

const errors = [];
const browser = await chromium.launch({ headless: true });
try {
  // ---------- 1. MOVE w-c onto w-d right zone ----------
  {
    const { context, page } = await fresh(browser, errors, 'move');
    const bc = await box(page, '.pwidget[data-widget-id="w-c"]');
    const bd = await box(page, '.pwidget[data-widget-id="w-d"]');
    // NOTE: a card's geometric center is its textarea; the app intentionally
    // blocks drags started from edit fields (text selection). Grab the widget
    // chrome at (centerX, top+8) instead.
    await dragTo(page, bc.x + bc.width / 2, bc.y + 8,
                 bd.x + bd.width * 0.94, bd.y + bd.height / 2);
    const s = await state(page);
    const loc = findLineOf(s, 'w-c');
    const l3 = loc && loc.line;
    const okLine = !!l3 && l3.id === 'l-3' && JSON.stringify(l3.widgets.map(w => w.id)) === JSON.stringify(['w-d', 'w-c']);
    check('1a move: w-c in l-3 after w-d', okLine,
      `expected l-3=[w-d,w-c]; got w-c in line ${l3 ? l3.id : 'none'} widgets=${JSON.stringify(l3 ? l3.widgets.map(w=>w.id) : null)} (ghostSeen=${ghostSeen}, dragstarts=${await page.evaluate(() => window.__dragstarts)}) full=${JSON.stringify(s)}`);
    const c1 = s.rows.find(r => r.id === 'r-1')?.cols.find(c => c.id === 'c-1');
    check('1b move: l-2 pruned, c-1 has one line', c1 && colLines(c1).length === 1 && colLines(c1)[0].id === 'l-1',
      `c-1 lines = ${JSON.stringify(c1 ? colLines(c1).map(l => l.id) : null)}`);
    const ids = allWidgetIds(s);
    check('1c move: w-c exactly once, no duplicate ids',
      ids.filter(i => i === 'w-c').length === 1 && new Set(ids).size === ids.length,
      `widget ids = ${JSON.stringify(ids)}`);
    await context.close();
  }

  // ---------- 2. Self-drop no-op ----------
  {
    const { context, page } = await fresh(browser, errors, 'selfdrop');
    const baseline = await state(page); // post-migration shape, minted ids persisted
    const bb = await box(page, '.pwidget[data-widget-id="w-b"]');
    const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
    // Grab widget chrome (top edge; center is an edit field which blocks
    // drags by design), wander off, then drop on w-b's own center.
    await page.mouse.move(cx, bb.y + 8);
    await page.mouse.down();
    await page.mouse.move(cx + 40, bb.y + 20, { steps: 6 });
    await page.mouse.move(cx, cy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const drags = await page.evaluate(() => window.__dragstarts);
    const s = await state(page);
    check('2 self-drop: drag fired and JSON unchanged',
      drags >= 1 && isDeepStrictEqual(s, baseline),
      `dragstarts=${drags}; equal=${isDeepStrictEqual(s, baseline)}; got=${JSON.stringify(s)}`);
    await context.close();
  }

  // ---------- 3. Move last widget of a column into row gap ----------
  {
    const { context, page } = await fresh(browser, errors, 'rowgap');
    const bd = await box(page, '.pwidget[data-widget-id="w-d"]');
    const b1 = await box(page, '.prow[data-row-id="r-1"]');
    const b2 = await box(page, '.prow[data-row-id="r-2"]');
    const gapY = (b1.y + b1.height + b2.y) / 2;
    const gapX = b1.x + b1.width / 2;
    await dragTo(page, bd.x + bd.width / 2, bd.y + bd.height / 2, gapX, gapY);
    const s = await state(page);
    const rowIds = s.rows.map(r => r.id);
    const okCount = s.rows.length === 3 && rowIds[0] === 'r-1' && rowIds[2] === 'r-2';
    const r1 = s.rows[0], mid = s.rows[1];
    const okR1 = r1 && r1.cols.length === 1 && r1.cols[0].id === 'c-1';
    const okMid = mid && mid.id !== 'r-1' && mid.id !== 'r-2' && mid.cols.length === 1 &&
      colLines(mid.cols[0]).length === 1 && colLines(mid.cols[0])[0].widgets.length === 1 &&
      colLines(mid.cols[0])[0].widgets[0].id === 'w-d' && colLines(mid.cols[0])[0].widgets[0].kind === 'graph';
    check('3 move to row gap: new row at index 1 with w-d, c-2 pruned',
      okCount && okR1 && okMid,
      `rows=${JSON.stringify(rowIds)}; r-1 cols=${JSON.stringify(r1 ? r1.cols.map(c=>c.id) : null)}; ghostSeen=${ghostSeen}; full=${JSON.stringify(s)}`);
    await context.close();
  }

  // ---------- 4. Row reorder via handle ----------
  {
    const { context, page } = await fresh(browser, errors, 'reorder');
    const bh = await box(page, '.prow[data-row-id="r-2"] .prow-handle');
    const b1 = await box(page, '.prow[data-row-id="r-1"]');
    // drop above r-1's vertical center -> index 0
    await dragTo(page, bh.x + bh.width / 2, bh.y + bh.height / 2,
                 bh.x + bh.width / 2, b1.y + 6);
    const s = await state(page);
    const jsonOrder = s.rows.map(r => r.id);
    const domOrder = await page.$$eval('.prow', els => els.map(e => e.dataset.rowId));
    check('4 row reorder: [r-2, r-1] in JSON and DOM',
      JSON.stringify(jsonOrder) === JSON.stringify(['r-2', 'r-1']) &&
      JSON.stringify(domOrder) === JSON.stringify(['r-2', 'r-1']),
      `json=${JSON.stringify(jsonOrder)} dom=${JSON.stringify(domOrder)} ghostSeen=${ghostSeen}`);
    await context.close();
  }

  // ---------- 5 + 6. Deletion cascade, then Done ----------
  {
    const { context, page } = await fresh(browser, errors, 'delete');
    const del = async (wid) => {
      await page.click(`.pwidget[data-widget-id="${wid}"] .pw-delete`);
      await page.waitForTimeout(120);
    };

    await del('w-b');
    let s = await state(page);
    let l1 = findLineOf(s, 'w-a');
    check('5a delete w-b: l-1 has only w-a',
      l1 && l1.line.id === 'l-1' && l1.line.widgets.length === 1 && l1.line.widgets[0].id === 'w-a',
      `l-1 widgets=${JSON.stringify(l1 ? l1.line.widgets.map(w=>w.id) : null)}`);

    await del('w-a');
    s = await state(page);
    const c1 = s.rows.find(r => r.id === 'r-1')?.cols.find(c => c.id === 'c-1');
    check('5b delete w-a: l-1 pruned, l-2 (w-c) remains',
      c1 && colLines(c1).length === 1 && colLines(c1)[0].id === 'l-2' &&
      colLines(c1)[0].widgets.length === 1 && colLines(c1)[0].widgets[0].id === 'w-c',
      `c-1 lines=${JSON.stringify(c1 ? colLines(c1).map(l=>l.id) : null)} full=${JSON.stringify(s)}`);

    await del('w-c');
    await del('w-d');
    s = await state(page);
    check('5c delete w-c,w-d: r-1 gone',
      s.rows.length === 1 && s.rows[0].id === 'r-2',
      `rows=${JSON.stringify(s.rows.map(r=>r.id))}`);

    await del('w-e');
    s = await state(page);
    const emptyDrop = await page.locator('.page-empty-drop').isVisible().catch(() => false);
    const stillCustomizing = await page.evaluate(() => document.body.classList.contains('customizing'));
    check('5d delete w-e: page empty, .page-empty-drop visible, still customizing',
      s.rows.length === 0 && emptyDrop && stillCustomizing,
      `rows=${s.rows.length} emptyDrop=${emptyDrop} customizing=${stillCustomizing}`);

    // 6. Done -> view mode empty state
    await page.click('#customize');
    await page.waitForTimeout(150);
    const customizingOff = await page.evaluate(() => !document.body.classList.contains('customizing'));
    const emptyVisible = await page.locator('.empty').isVisible().catch(() => false);
    check('6 Done on empty page: view mode .empty visible',
      customizingOff && emptyVisible,
      `customizingOff=${customizingOff} emptyVisible=${emptyVisible} contentHTML=${(await page.locator('#content').innerHTML()).slice(0,300)}`);
    await context.close();
  }
} catch (e) {
  check('script ran to completion', false, e.stack || String(e));
} finally {
  await browser.close();
}

check('no console/page errors', errors.length === 0, errors.join(' | ').slice(0, 800));
console.log(JSON.stringify({ pass: results.every(r => r.ok), results }, null, 2));
