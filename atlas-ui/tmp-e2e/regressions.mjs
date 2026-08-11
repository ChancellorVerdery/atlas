import { chromium } from 'playwright';
const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","cols":[
   {"id":"c-1","lines":[{"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"A","text":"aa"},{"id":"w-b","kind":"card","title":"B","text":"bb"}]}]},
   {"id":"c-2","lines":[{"id":"l-3","widgets":[{"id":"w-d","kind":"card","title":"D","text":"dd"}]}]}]}]};
const out = [];
const check = (name, ok, detail = '') => out.push({ name, ok, detail });
const browser = await chromium.launch({ headless: true });

async function fresh(fixture) {
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => { localStorage.setItem('atlas.devMode', '1'); localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true })); }); // dev widgets in palette; offline auth bypasses the login gate
  if (fixture) await context.addInitScript((fx) => localStorage.setItem('atlas.page.v1', JSON.stringify(fx)), fixture);
  const page = await context.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('http://localhost:5173/', { waitUntil: 'load' });
  await page.waitForSelector('#customize', { timeout: 10000 }); // app shell rendered (async boot)
  return { context, page, errs };
}

// 1. Selection drag from a textarea must NOT move the widget
{
  const { context, page, errs } = await fresh(FIXTURE);
  await page.click('#customize');
  const ta = page.locator('.pwidget[data-widget-id="w-a"] .pw-field--text');
  await ta.fill('hello world text');
  await page.evaluate(() => {
    const el = document.querySelector('.pwidget[data-widget-id="w-a"] .pw-field--text');
    el.focus(); el.setSelectionRange(0, 5);
  });
  const box = await ta.boundingBox();
  const target = await page.locator('.pwidget[data-widget-id="w-d"]').boundingBox();
  await page.mouse.move(box.x + 20, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 30, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  const l1 = st.rows[0].cols[0].sections[0].lines[0].widgets.map((w) => w.id);
  check('selection drag does not move widget', JSON.stringify(l1) === '["w-a","w-b"]' && st.rows[0].cols.length === 2, `l1=${JSON.stringify(l1)} cols=${st.rows[0].cols.length} errs=${errs.join('|')}`);
  await context.close();
}

// 2. Stale move target must not delete the widget (restore, not vanish)
{
  const { context, page } = await fresh(FIXTURE);
  await page.click('#customize');
  const result = await page.evaluate(async () => {
    const m = await import('/src/page/model.js');
    const page1 = m.loadPage();
    m.moveWidget(page1, 'w-a', { type: 'beside', lineId: 'l-GONE', index: 0 }); // stale line id
    const after = JSON.parse(localStorage.getItem('atlas.page.v1'));
    const inMem = page1.rows[0].cols[0].sections[0].lines[0].widgets.map((w) => w.id);
    const stored = after.rows[0].cols[0].sections[0].lines[0].widgets.map((w) => w.id);
    return { inMem, stored };
  });
  check('stale move target restores widget', JSON.stringify(result.inMem) === '["w-a","w-b"]' && JSON.stringify(result.stored) === '["w-a","w-b"]', JSON.stringify(result));
  await context.close();
}

// 3. Corrupt payloads must render without pageerror
{
  const corrupts = [
    {"v":1,"rows":[{"id":"r","cols":[{"id":"c","lines":[{"id":"l","widgets":[{"id":"w","kind":"list","title":"T"}]}]}]}]},   // list w/o items
    {"v":1,"rows":[{"id":"r","cols":[{"id":"c","lines":[{"id":"l","widgets":[null,{"id":"w2","kind":"card","title":"OK","text":"t"}]}]}]}]}, // null widget
    {"v":1,"rows":[{"id":"r","cols":[{"id":"c","lines":[{"id":"l","widgets":"ab"}]}]}]},                                     // widgets is a string
    {"v":1,"rows":[{"id":"r","cols":[{"id":"c","lines":[{"id":"l","widgets":[{"id":"w","title":"nokind"}]}]}]}]},            // unknown kind
    {"v":1,"rows":[{"cols":[{"lines":[{"widgets":[{"kind":"graph","title":"G"}]}]}]}]},                                      // missing ids + graph w/o points
  ];
  let allOk = true, details = [];
  for (let i = 0; i < corrupts.length; i++) {
    const { context, page, errs } = await fresh(corrupts[i]);
    await page.waitForTimeout(300);
    const hasContent = await page.evaluate(() => !!document.getElementById('content').innerHTML.trim());
    if (errs.length || !hasContent) { allOk = false; details.push(`#${i}: errs=${errs.join('|')} content=${hasContent}`); }
    await context.close();
  }
  check('corrupt payloads render without errors', allOk, details.join(' ; '));
}

// 4. Ghost cleared when cursor exits #content directly from over a widget
{
  const { context, page } = await fresh(FIXTURE);
  await page.click('#customize');
  const pal = await page.locator('.palette__item[data-kind="card"]').boundingBox();
  const wa = await page.locator('.pwidget[data-widget-id="w-a"]').boundingBox();
  await page.mouse.move(pal.x + 20, pal.y + 10);
  await page.mouse.down();
  await page.mouse.move(pal.x + 40, pal.y + 30, { steps: 3 });
  await page.mouse.move(wa.x + wa.width * 0.4, wa.y + wa.height / 2, { steps: 8 }); // over widget: ghost appears
  await page.waitForTimeout(150);
  const ghostBefore = await page.evaluate(() => !!document.querySelector('.drop-ghost'));
  // exit content leftward from directly over the widget (into the sidebar)
  await page.mouse.move(120, wa.y + wa.height / 2, { steps: 6 });
  await page.waitForTimeout(200);
  const ghostAfter = await page.evaluate(() => document.querySelectorAll('.drop-ghost').length);
  await page.mouse.up();
  check('ghost cleared on child-exit of content', ghostBefore && ghostAfter === 0, `before=${ghostBefore} after=${ghostAfter}`);
  await context.close();
}

// 5. CSS: card pre-wrap + textarea resize none; in-row right-edge strip creates a new column
{
  const { context, page } = await fresh(FIXTURE);
  const preWrap = await page.evaluate(() => getComputedStyle(document.querySelector('.card__body')).whiteSpace);
  await page.click('#customize');
  const resize = await page.evaluate(() => getComputedStyle(document.querySelector('.pw-field--text')).resize);
  check('card body pre-wrap + textarea resize none', preWrap === 'pre-wrap' && resize === 'none', `whiteSpace=${preWrap} resize=${resize}`);
  // edge strip: drop at 10px inside the row's right edge -> new col at end
  const row = await page.evaluate(() => { const r = document.querySelector('.prow[data-row-id="r-1"]').getBoundingClientRect(); return { right: r.right, cy: r.top + r.height / 2 }; });
  const pal = await page.locator('.palette__item[data-kind="list"]').boundingBox();
  await page.mouse.move(pal.x + 20, pal.y + 10);
  await page.mouse.down();
  await page.mouse.move(pal.x + 40, pal.y + 30, { steps: 3 });
  await page.mouse.move(row.right - 10, row.cy, { steps: 12 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.v1')));
  const cols = st.rows[0].cols;
  check('in-row right edge strip -> new col at end', cols.length === 3 && cols[2].sections[0].lines[0].widgets[0].kind === 'list', `cols=${cols.length} last=${cols[2]?.sections?.[0]?.lines?.[0]?.widgets?.[0]?.kind}`);
  await context.close();
}

await browser.close();
let fail = 0;
for (const c of out) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`); if (!c.ok) fail++; }
process.exit(fail ? 1 : 0);
