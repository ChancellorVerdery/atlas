// Verify the four over-widget drop zones (left/right/top/bottom of w-a) with REAL mouse drags.
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

const ORIG_IDS = new Set(['w-a','w-b','w-c','w-d','w-e']);
const results = [];

function record(check, ok, detail) {
  results.push({ check, ok, ...(detail ? { detail } : {}) });
}

function collectWidgetIds(json) {
  const ids = [];
  for (const r of json.rows) for (const c of r.cols) for (const sec of c.sections) for (const l of sec.lines) for (const w of l.widgets) ids.push(w.id);
  return ids;
}

async function domStructure(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('#content .prow')].map(r => ({
      id: r.dataset.rowId,
      cols: [...r.querySelectorAll('.pcol')].map(c => ({
        id: c.dataset.colId,
        lines: [...c.querySelectorAll('.pline')].map(l => ({
          id: l.dataset.lineId,
          widgets: [...l.querySelectorAll('.pwidget')].map(w => w.dataset.widgetId)
        }))
      }))
    }));
  });
}

function jsonStructure(json) {
  return json.rows.map(r => ({
    id: r.id,
    cols: r.cols.map(c => ({
      id: c.id,
      lines: c.sections.flatMap(sec => sec.lines).map(l => ({ id: l.id, widgets: l.widgets.map(w => w.id) }))
    }))
  }));
}

async function runScenario(browser, name, targetPointFn, assertFn) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
  await context.addInitScript((fx) => {
    localStorage.setItem('atlas.page.v1', JSON.stringify(fx));
  }, FIXTURE);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  let detail = '';
  let ok = false;
  try {
    await page.goto('http://localhost:5173', { waitUntil: 'load' });
    await page.waitForSelector('.pwidget[data-widget-id="w-a"]', { timeout: 5000 });
    await page.click('#customize');
    await page.waitForSelector('body.customizing', { timeout: 5000 });
    const palette = page.locator('.palette__item[data-kind="card"]');
    await palette.waitFor({ timeout: 5000 });
    await palette.scrollIntoViewIfNeeded(); // long palette: nav growth can push it below the fold
    const src = await palette.boundingBox();
    const wa = await page.locator('.pwidget[data-widget-id="w-a"]').boundingBox();
    if (!src || !wa) throw new Error('missing bounding boxes: palette=' + JSON.stringify(src) + ' w-a=' + JSON.stringify(wa));

    const { x: tx, y: ty } = targetPointFn(wa);
    const sx = src.x + src.width / 2, sy = src.y + src.height / 2;

    // Real mouse HTML5 drag
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 6, sy + 6, { steps: 3 });   // cross drag threshold -> dragstart
    await page.mouse.move((sx + tx) / 2, (sy + ty) / 2, { steps: 10 });
    await page.mouse.move(tx, ty, { steps: 10 });
    await page.mouse.move(tx, ty);                          // settle exactly on target
    await page.mouse.up();
    await page.waitForTimeout(300);

    const stored = await page.evaluate(() => localStorage.getItem('atlas.page.v1'));
    const json = JSON.parse(stored);

    const problems = [];

    // scenario-specific structural assertions
    const structProblem = assertFn(json);
    if (structProblem) problems.push(structProblem);

    // no duplicate widget ids
    const ids = collectWidgetIds(json);
    const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dup.length) problems.push('duplicate widget ids: ' + JSON.stringify(dup));

    // a new widget must exist (drag actually happened)
    const newIds = ids.filter((id) => !ORIG_IDS.has(id));
    if (ids.length !== 6 || newIds.length !== 1) {
      problems.push(`expected 6 widgets with exactly 1 new id, got ${ids.length} widgets, new=${JSON.stringify(newIds)}; full ids=${JSON.stringify(ids)}`);
    }

    // DOM matches persisted JSON
    const dom = await domStructure(page);
    const js = jsonStructure(json);
    if (JSON.stringify(dom) !== JSON.stringify(js)) {
      problems.push('DOM/localStorage mismatch: DOM=' + JSON.stringify(dom) + ' JSON=' + JSON.stringify(js));
    }

    // console errors
    if (consoleErrors.length) problems.push('console errors: ' + JSON.stringify(consoleErrors));

    ok = problems.length === 0;
    detail = problems.join(' | ');
  } catch (e) {
    ok = false;
    detail = 'exception: ' + (e && e.message ? e.message : String(e));
    if (consoleErrors.length) detail += ' | console errors: ' + JSON.stringify(consoleErrors);
  } finally {
    await context.close();
  }
  record(name, ok, detail || undefined);
}

const browser = await chromium.launch({ headless: true });

// 1. LEFT zone -> insert in l-1 before w-a (index 0)
await runScenario(browser, 'left-zone: new widget at l-1 index 0 (before w-a)',
  (wa) => ({ x: wa.x + wa.width * 0.3, y: wa.y + wa.height / 2 }),
  (json) => {
    const l1 = json.rows[0]?.cols[0]?.sections?.[0]?.lines?.find(l => l.id === 'l-1');
    if (!l1) return 'l-1 missing: ' + JSON.stringify(jsonStructure(json));
    const ids = l1.widgets.map(w => w.id);
    if (ids.length !== 3 || ORIG_IDS.has(ids[0]) || ids[1] !== 'w-a' || ids[2] !== 'w-b') {
      return `expected l-1 = [new, w-a, w-b], got ${JSON.stringify(ids)}; page=${JSON.stringify(jsonStructure(json))}`;
    }
    return null;
  });

// 2. RIGHT zone -> insert in l-1 between w-a and w-b (index 1)
await runScenario(browser, 'right-zone: new widget at l-1 index 1 (between w-a and w-b)',
  (wa) => ({ x: wa.x + wa.width * 0.92, y: wa.y + wa.height / 2 }),
  (json) => {
    const l1 = json.rows[0]?.cols[0]?.sections?.[0]?.lines?.find(l => l.id === 'l-1');
    if (!l1) return 'l-1 missing: ' + JSON.stringify(jsonStructure(json));
    const ids = l1.widgets.map(w => w.id);
    if (ids.length !== 3 || ids[0] !== 'w-a' || ORIG_IDS.has(ids[1]) || ids[2] !== 'w-b') {
      return `expected l-1 = [w-a, new, w-b], got ${JSON.stringify(ids)}; page=${JSON.stringify(jsonStructure(json))}`;
    }
    return null;
  });

// 3. TOP zone -> new line in c-1 at index 0
await runScenario(browser, 'top-zone: new line in c-1 at index 0, l-1 slides to index 1',
  (wa) => ({ x: wa.x + wa.width / 2, y: wa.y + wa.height * 0.08 }),
  (json) => {
    const c1 = json.rows[0]?.cols?.find(c => c.id === 'c-1');
    if (!c1) return 'c-1 missing: ' + JSON.stringify(jsonStructure(json));
    const lines = c1.sections[0].lines.map(l => ({ id: l.id, widgets: l.widgets.map(w => w.id) }));
    const badShape = lines.length !== 3
      || lines[0].widgets.length !== 1 || ORIG_IDS.has(lines[0].widgets[0])
      || lines[1].id !== 'l-1' || JSON.stringify(lines[1].widgets) !== '["w-a","w-b"]'
      || lines[2].id !== 'l-2';
    if (badShape) {
      return `expected c-1 lines = [newLine(1 new widget), l-1[w-a,w-b], l-2], got ${JSON.stringify(lines)}`;
    }
    return null;
  });

// 4. BOTTOM zone -> new line in c-1 at index 1 (between l-1 and l-2)
await runScenario(browser, 'bottom-zone: new line in c-1 at index 1 (between l-1 and l-2)',
  (wa) => ({ x: wa.x + wa.width / 2, y: wa.y + wa.height * 0.92 }),
  (json) => {
    const c1 = json.rows[0]?.cols?.find(c => c.id === 'c-1');
    if (!c1) return 'c-1 missing: ' + JSON.stringify(jsonStructure(json));
    const lines = c1.sections[0].lines.map(l => ({ id: l.id, widgets: l.widgets.map(w => w.id) }));
    const badShape = lines.length !== 3
      || lines[0].id !== 'l-1' || JSON.stringify(lines[0].widgets) !== '["w-a","w-b"]'
      || lines[1].widgets.length !== 1 || ORIG_IDS.has(lines[1].widgets[0])
      || lines[2].id !== 'l-2';
    if (badShape) {
      return `expected c-1 lines = [l-1[w-a,w-b], newLine(1 new widget), l-2], got ${JSON.stringify(lines)}`;
    }
    return null;
  });

await browser.close();
console.log(JSON.stringify(results, null, 2));
process.exit(results.every(r => r.ok) ? 0 : 1);
