// E2E: empty-space drop zones via real mouse drags (headless).
import { chromium } from 'playwright';
const colLines = (c) => c.sections.flatMap((sec) => sec.lines); // cols hold sections now

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

function rectsIn(page, sels) {
  return page.evaluate((sels) => {
    const out = {};
    for (const [key, sel] of Object.entries(sels)) {
      const el = document.querySelector(sel);
      if (!el) { out[key] = null; continue; }
      const r = el.getBoundingClientRect();
      out[key] = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    }
    return out;
  }, sels);
}

async function dragPaletteTo(page, x, y) {
  const src = await page.locator('.palette__item[data-kind="list"]').boundingBox();
  const sx = src.x + src.width / 2, sy = src.y + src.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 12, sy + 12, { steps: 4 });
  await page.mouse.move(x, y, { steps: 20 });
  await page.mouse.move(x + 1, y, { steps: 2 }); // extra dragover at target
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(200);
}

const getState = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));

async function scenario(name, fn) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 1300 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
  await context.addInitScript((fx) => localStorage.setItem('atlas.page.v1', JSON.stringify(fx)), FIXTURE);
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  try {
    await page.goto('http://localhost:5173/', { waitUntil: 'load' });
    await page.waitForSelector('.pwidget[data-widget-id="w-e"]');
    await page.click('#customize');
    await page.waitForSelector('.palette__item[data-kind="list"]');
    const r = await fn(page);
    if (errors.length) results.push({ check: name, ok: false, detail: 'console errors: ' + errors.join(' | ') + (r.ok ? '' : ' ; also: ' + r.detail) });
    else results.push({ check: name, ok: r.ok, detail: r.detail || '' });
  } catch (e) {
    results.push({ check: name, ok: false, detail: 'exception: ' + e.message + (errors.length ? ' ; console: ' + errors.join(' | ') : '') });
  }
  await context.close();
}

let browser;

// ---- checks ----
const j = (o) => JSON.stringify(o);

(async () => {
  browser = await chromium.launch({ headless: true });

  // 1. Left padding strip of r-1 -> new column at index 0 of r-1
  await scenario('1 left-padding-strip -> new col at index 0 of r-1', async (page) => {
    const g = await rectsIn(page, { content: '#content', r1: '.prow[data-row-id="r-1"]' });
    await dragPaletteTo(page, g.content.left + 20, g.r1.cy);
    const st = await getState(page);
    const row = st.rows.find((r) => r.id === 'r-1');
    const c0 = row && row.cols[0];
    const okJson = row && row.cols.length === 3 && row.cols[1].id === 'c-1' && row.cols[2].id === 'c-2'
      && colLines(c0).length === 1 && colLines(c0)[0].widgets.length === 1 && colLines(c0)[0].widgets[0].kind === 'list';
    const okDom = await page.evaluate(() => {
      const cols = document.querySelectorAll('.prow[data-row-id="r-1"] > .prow-body > .pcol');
      return cols.length === 3 && !!cols[0].querySelector('.pline .pwidget--list');
    });
    return { ok: !!(okJson && okDom), detail: okJson && okDom ? '' : `json ok=${!!okJson} dom ok=${okDom}; r-1 cols=${j(row && row.cols.map((c) => ({ id: c.id, lines: colLines(c).map((l) => l.widgets.map((w) => w.kind)) })))}` };
  });

  // 2. Gutter between c-1 and c-2 -> new column at index 1
  await scenario('2 gutter c-1/c-2 -> new col at index 1 of r-1', async (page) => {
    const g = await rectsIn(page, { r1: '.prow[data-row-id="r-1"]', c1: '.pcol[data-col-id="c-1"]', c2: '.pcol[data-col-id="c-2"]' });
    const x = (g.c1.right + g.c2.left) / 2;
    await dragPaletteTo(page, x, g.r1.cy);
    const st = await getState(page);
    const row = st.rows.find((r) => r.id === 'r-1');
    const c1i = row && row.cols[1];
    const okJson = row && row.cols.length === 3 && row.cols[0].id === 'c-1' && row.cols[2].id === 'c-2'
      && colLines(c1i).length === 1 && colLines(c1i)[0].widgets.length === 1 && colLines(c1i)[0].widgets[0].kind === 'list';
    const okDom = await page.evaluate(() => {
      const cols = document.querySelectorAll('.prow[data-row-id="r-1"] > .prow-body > .pcol');
      return cols.length === 3 && !!cols[1].querySelector('.pline .pwidget--list');
    });
    return { ok: !!(okJson && okDom), detail: okJson && okDom ? '' : `gutter x used; r-1 cols=${j(row && row.cols.map((c) => ({ id: c.id, kinds: colLines(c).map((l) => l.widgets.map((w) => w.kind)) })))}` };
  });

  // 3. Tail below the shorter of c-1/c-2 -> new line appended to that column
  await scenario('3 tail below short column -> new line appended', async (page) => {
    const g = await page.evaluate(() => {
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
      const row = rect(document.querySelector('.prow[data-row-id="r-1"]'));
      const colInfo = (id) => {
        const col = document.querySelector(`.pcol[data-col-id="${id}"]`);
        const lines = col.querySelectorAll('.pline');
        const last = lines[lines.length - 1].getBoundingClientRect();
        const c = rect(col);
        return { cx: c.cx, contentBottom: last.bottom, nLines: lines.length };
      };
      return { row, c1: colInfo('c-1'), c2: colInfo('c-2'), wd: rect(document.querySelector('.pwidget[data-widget-id="w-d"]')) };
    });
    const shorterId = g.c1.contentBottom <= g.c2.contentBottom ? 'c-1' : 'c-2';
    const sh = shorterId === 'c-1' ? g.c1 : g.c2;
    const tail = g.row.bottom - sh.contentBottom;
    if (tail > 24) {
      const y = (sh.contentBottom + g.row.bottom) / 2;
      await dragPaletteTo(page, sh.cx, y);
      const st = await getState(page);
      const col = st.rows.find((r) => r.id === 'r-1').cols.find((c) => c.id === shorterId);
      const okJson = col && colLines(col).length === sh.nLines + 1 && colLines(col)[sh.nLines].widgets.length === 1 && colLines(col)[sh.nLines].widgets[0].kind === 'list';
      const okDom = await page.evaluate((id) => {
        const lines = document.querySelectorAll(`.pcol[data-col-id="${id}"] .pline`);
        return !!(lines.length && lines[lines.length - 1].querySelector('.pwidget--list'));
      }, shorterId);
      return { ok: !!(okJson && okDom), detail: okJson && okDom ? `tail drop on ${shorterId} (tail=${tail.toFixed(1)}px)` : `shorter=${shorterId} tail=${tail.toFixed(1)}px; col lines=${j(col && colLines(col).map((l) => l.widgets.map((w) => w.kind)))}` };
    }
    // fallback: equal heights -> bottom widget zone on w-d
    await dragPaletteTo(page, g.wd.cx, g.wd.bottom - 6);
    const st = await getState(page);
    const col = st.rows.find((r) => r.id === 'r-1').cols.find((c) => c.id === 'c-2');
    const okJson = col && colLines(col).length === 2 && colLines(col)[0].id === 'l-3' && colLines(col)[1].widgets[0].kind === 'list';
    return { ok: !!okJson, detail: okJson ? `NOTE: cols equal height (tail=${tail.toFixed(1)}px); asserted bottom widget zone on w-d instead -> new line below in c-2` : `fallback bottom-zone failed; c-2 lines=${j(col && colLines(col).map((l) => l.widgets.map((w) => w.kind)))}` };
  });

  // 4. Above first row -> new row at index 0
  await scenario('4 above first row -> new row at index 0', async (page) => {
    const g = await rectsIn(page, { content: '#content' });
    await dragPaletteTo(page, g.content.cx, g.content.top + 20);
    const st = await getState(page);
    const r0 = st.rows[0];
    const okJson = st.rows.length === 3 && st.rows[1].id === 'r-1' && st.rows[2].id === 'r-2'
      && r0.cols.length === 1 && colLines(r0.cols[0]).length === 1 && colLines(r0.cols[0])[0].widgets[0].kind === 'list';
    const okDom = await page.evaluate(() => {
      const rows = document.querySelectorAll('.page-root > .prow');
      return rows.length === 3 && !!rows[0].querySelector('.pwidget--list');
    });
    return { ok: !!(okJson && okDom), detail: okJson && okDom ? '' : `rows=${j(st.rows.map((r) => r.id))} first row=${j(r0 && r0.cols.map((c) => colLines(c).map((l) => l.widgets.map((w) => w.kind))))}` };
  });

  // 5. Gap between r-1 and r-2 -> new row at index 1
  await scenario('5 gap r-1/r-2 -> new row at index 1', async (page) => {
    const g = await rectsIn(page, { content: '#content', r1: '.prow[data-row-id="r-1"]', r2: '.prow[data-row-id="r-2"]' });
    const y = (g.r1.bottom + g.r2.top) / 2;
    await dragPaletteTo(page, g.content.cx, y);
    const st = await getState(page);
    const r1i = st.rows[1];
    const okJson = st.rows.length === 3 && st.rows[0].id === 'r-1' && st.rows[2].id === 'r-2'
      && r1i.cols.length === 1 && colLines(r1i.cols[0])[0].widgets[0].kind === 'list';
    const okDom = await page.evaluate(() => {
      const rows = document.querySelectorAll('.page-root > .prow');
      return rows.length === 3 && !!rows[1].querySelector('.pwidget--list');
    });
    return { ok: !!(okJson && okDom), detail: okJson && okDom ? '' : `gap y=${y.toFixed(1)}; rows=${j(st.rows.map((r) => r.id))}` };
  });

  // 6. Below last row -> new row appended at index 2
  await scenario('6 below last row -> new row at index 2', async (page) => {
    const g = await rectsIn(page, { content: '#content', r2: '.prow[data-row-id="r-2"]' });
    let y = g.r2.bottom + 40;
    // keep inside #content and the viewport so dragover/drop land on the app
    y = Math.min(y, g.content.bottom - 2, 948);
    if (y <= g.r2.bottom + 2) y = g.r2.bottom + 10;
    await dragPaletteTo(page, g.content.cx, y);
    const st = await getState(page);
    const r2i = st.rows[2];
    const okJson = st.rows.length === 3 && st.rows[0].id === 'r-1' && st.rows[1].id === 'r-2'
      && r2i && r2i.cols.length === 1 && colLines(r2i.cols[0])[0].widgets[0].kind === 'list';
    const okDom = await page.evaluate(() => {
      const rows = document.querySelectorAll('.page-root > .prow');
      return rows.length === 3 && !!rows[2].querySelector('.pwidget--list');
    });
    return { ok: !!(okJson && okDom), detail: okJson && okDom ? '' : `used y=${y.toFixed(1)} (r2.bottom=${g.r2.bottom.toFixed(1)}, content.bottom=${g.content.bottom.toFixed(1)}); rows=${j(st.rows.map((r) => r.id))}` };
  });

  await browser.close();
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.every((r) => r.ok) ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
