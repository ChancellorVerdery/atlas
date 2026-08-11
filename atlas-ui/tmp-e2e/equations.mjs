import { chromium } from 'playwright';
const out = [];
const check = (n, ok, d = '') => out.push({ name: n, ok, detail: d });
const browser = await chromium.launch({ headless: true });
// Headless-only quirk: CDP text insertion doesn't reach MathLive's shadow
// keyboard sink until a key MathLive handles directly on keydown fires —
// '(' (smart fence) does, deterministically, and re-anchors the pipeline.
// Anchor with '(' + Backspace, then type for real. Keydown events themselves
// always arrive (verified); real OS keyboards don't have this problem.
async function typeMath(page, mfLocator, text) {
  await page.evaluate(() => document.fonts.ready);
  await mfLocator.click();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.type('(', { delay: 30 });
    if (await mfLocator.evaluate((el) => el.value.length > 0)) break;
    await page.waitForTimeout(60);
  }
  await page.keyboard.press('Backspace'); // remove the fence — field is empty and anchored
  await page.keyboard.type(text, { delay: 40 });
}

const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
const page = await context.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'load' });

// 1. nav + empty equations page
await page.click('a[href="#/equations"]');
await page.waitForTimeout(300);
const empty = await page.evaluate(() => ({
  title: document.querySelector('.empty__title')?.textContent,
  head: document.getElementById('title')?.textContent,
}));
check('equations page reachable from nav, own empty state', empty.head === 'Equations' && /equations page is empty/.test(empty.title || ''), JSON.stringify(empty));

// 2. restricted palette
await page.click('#customize');
await page.waitForSelector('.palette__item');
const eqKinds = await page.$$eval('.palette__item', (els) => els.map((e) => e.dataset.kind));
check('equations palette restricted to equation widgets', JSON.stringify(eqKinds) === '["eqcard","eqlist"]', JSON.stringify(eqKinds));

// 3. drop an equation card, type math with shortcuts
const pal = await page.locator('.palette__item[data-kind="eqcard"]').boundingBox();
const content = await page.locator('#content').boundingBox();
await page.mouse.move(pal.x + 20, pal.y + 10);
await page.mouse.down();
const tx = content.x + content.width / 2, ty = content.y + content.height / 2;
for (let i = 1; i <= 12; i++) { await page.mouse.move(pal.x + 20 + ((tx - pal.x - 20) * i) / 12, pal.y + 10 + ((ty - pal.y - 10) * i) / 12); await page.waitForTimeout(16); }
await page.mouse.up();
await page.waitForTimeout(400);
const mf = page.locator('math-field');
check('equation card dropped with a math field', await mf.count() === 1);
await typeMath(page, mf, 'sqrt2');                  // sqrt → √ with caret inside, then the 2 lands under the radical
await page.keyboard.press('ArrowRight');            // step out of the radical
await page.keyboard.type('+x^2', { delay: 40 });    // ^ → superscript slot
await page.keyboard.press('ArrowRight');
await page.keyboard.type('+cos(y)', { delay: 40 }); // cos → \cos
await page.waitForTimeout(300);
const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.equations.v1')));
const latex = stored?.rows?.[0]?.cols?.[0]?.sections?.[0]?.lines?.[0]?.widgets?.[0]?.latex || '';
check('typing sqrt builds \\sqrt{2}', /\\sqrt\{?2/.test(latex), `latex=${latex}`);
check('typing ^ builds a power', /x\^\{?2/.test(latex), `latex=${latex}`);
check('typing cos builds \\cos', /\\cos/.test(latex), `latex=${latex}`);

// spacebar must insert a horizontal space (MathLive disables it by default)
await page.keyboard.press('ArrowRight');
await page.keyboard.type(' y', { delay: 40 });
await page.waitForTimeout(200);
const latexSp = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.equations.v1')).rows[0].cols[0].sections[0].lines[0].widgets[0].latex);
check('spacebar inserts a space in equations', /\\;y/.test(latexSp), `latex=${latexSp}`);

// 3b. virtual keyboard: floating panel, restricted layouts, draggable
await page.evaluate(() => window.mathVirtualKeyboard.show());
await page.waitForTimeout(600);
const kb = await page.evaluate(() => {
  const b = document.querySelector('.ML__keyboard .MLK__backdrop');
  const r = b?.getBoundingClientRect();
  return {
    rect: r ? { x: r.x, y: r.y, w: r.width, bottom: r.bottom } : null,
    tabs: document.querySelector('.MLK__toolbar')?.textContent.replace(/\s+/g, ''),
    vw: innerWidth, vh: innerHeight,
  };
});
check('keyboard floats as a panel (not full-width dock)', kb.rect && kb.rect.w <= 724 && kb.rect.x > 40 && kb.rect.bottom < kb.vh - 5, JSON.stringify(kb.rect));
check('alphabetic + numeric layouts removed', kb.tabs && !kb.tabs.includes('123') && !/abc/i.test(kb.tabs) && kb.tabs.includes('αβγ'), kb.tabs);
check('calc layer tab present (integrals, sums, derivatives, matrices)', kb.tabs.includes('∫Σ∂'), kb.tabs);
{
  const bar = await page.evaluate(() => { const t = document.querySelector('.MLK__toolbar').getBoundingClientRect(); return { x: t.x + t.width / 2, y: t.y + t.height / 2 }; });
  await page.mouse.move(bar.x, bar.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(bar.x - (150 * i) / 8, bar.y - (90 * i) / 8); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(200);
  const moved = await page.evaluate(() => document.querySelector('.ML__keyboard .MLK__backdrop').getBoundingClientRect().x);
  check('keyboard panel drags by its toolbar', Math.abs(moved - (kb.rect.x - 150)) < 12, `x ${kb.rect.x} -> ${moved}`);
}
// 3c. calc layer: definite integral, sum, product, nth root, matrix and
// friends all sit as direct taps — no long-press needed to find them.
{
  await page.locator('.layer-switch:visible', { hasText: '∫Σ∂' }).click();
  await page.waitForTimeout(200);
  const vals = await page.evaluate(() =>
    [...document.querySelectorAll('.MLK__keycap')].filter((k) => k.offsetParent !== null).map((k) => k.dataset.keycapValue));
  check('calc layer has 10 keys', vals.length === 10, JSON.stringify(vals));
  check('definite integral key inserts the bounded template directly', vals[0] === '\\int_{#?}^{#?}#?\\,\\mathrm{d}#?', vals[0]);
  check('summation key with bounds', vals[1] === '\\sum_{#?}^{#?}#?', vals[1]);
  check('product key with bounds', vals[2] === '\\prod_{#?}^{#?}#?', vals[2]);
  check('nth root key (not just square root)', vals.includes('\\sqrt[#?]{#?}'), JSON.stringify(vals));
  check('matrix key (impossible to type without knowing the LaTeX environment)', vals.some((v) => v.includes('pmatrix')), JSON.stringify(vals));
  check('binomial coefficient key', vals.includes('\\binom{#?}{#?}'), JSON.stringify(vals));

  // no calc keycap's rendered label may overflow its cell or spill past the
  // panel's bottom edge (the tall-label clipping bug: display-style \sum with
  // stacked limits was ~71px in a 42px cell, cut off by the rounded overflow).
  const clip = await page.evaluate(() => {
    const bd = document.querySelector('.MLK__backdrop').getBoundingClientRect();
    const keys = [...document.querySelectorAll('.MLK__keycap')].filter((k) => k.offsetParent !== null);
    return keys.map((k) => {
      const cell = k.getBoundingClientRect();
      const inner = k.querySelector('.ML__latex, .ML__base') || k.firstElementChild;
      const ir = inner?.getBoundingClientRect();
      return { val: (k.dataset.keycapValue || '').slice(0, 14), overflowsCell: ir ? ir.height > cell.height + 2 : false, belowPanel: ir ? ir.bottom > bd.bottom + 1 : false };
    });
  });
  check('no calc key label overflows its cell', clip.every((c) => !c.overflowsCell), JSON.stringify(clip.filter((c) => c.overflowsCell)));
  check('no calc key label is clipped by the panel bottom', clip.every((c) => !c.belowPanel), JSON.stringify(clip.filter((c) => c.belowPanel)));

  await page.locator('.MLK__keycap:visible').first().click(); // tap the definite integral key for real
  await page.waitForTimeout(200);
  const afterLatex = await mf.evaluate((el) => el.getValue('latex'));
  check('tapping the key actually inserts a definite integral with bounds', /\\int_\{.*\}\^\{.*\}/.test(afterLatex), afterLatex);
}
await page.evaluate(() => window.mathVirtualKeyboard.hide());
await page.waitForTimeout(300);

// 4. title edit + view-mode render
await page.locator('.pwidget--eqcard .pw-field--title').fill('Pythagoras-ish');
await page.waitForTimeout(150);
await page.click('#customize'); // Done
await page.waitForTimeout(400);
const view = await page.evaluate(() => ({
  title: document.querySelector('.pwidget--eqcard .card__title')?.textContent,
  mathNodes: document.querySelectorAll('.pwidget--eqcard .eq-render *').length,
  fields: document.querySelectorAll('math-field').length,
}));
check('view mode renders static math (no editor)', view.title === 'Pythagoras-ish' && view.mathNodes > 3 && view.fields === 0, JSON.stringify(view));

// 5. eqcard modal shows the equation large
await page.click('.pwidget--eqcard');
await page.waitForTimeout(200);
const modal = await page.evaluate(() => ({
  open: !!document.getElementById('app-modal'),
  math: document.querySelectorAll('#app-modal .modal__math .eq-render *').length,
}));
check('clicking equation card opens math modal', modal.open && modal.math > 3, JSON.stringify(modal));
await page.keyboard.press('Escape');

// 5b. long equations scale to fit instead of scrolling
{
  const LONG = 'x^2+y^2+z^2+a^2+b^2+c^2+d^2+e^2+f^2+g^2+h^2+i^2+j^2=r^2+\\sin(\\theta)+\\cos(\\phi)+\\sum_{n=1}^{100}\\frac{1}{n^2}';
  await page.evaluate((latex) => {
    const p = JSON.parse(localStorage.getItem('atlas.page.equations.v1'));
    p.rows[0].cols[0].sections[0].lines[0].widgets[0].latex = latex; // the eqcard widget
    localStorage.setItem('atlas.page.equations.v1', JSON.stringify(p));
  }, LONG);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.pwidget--eqcard .eq-render');
  await page.waitForTimeout(300);
  const measure = () => page.evaluate(() => {
    const el = document.querySelector('.pwidget--eqcard .eq-render');
    const inner = el.querySelector('.eq-render__inner');
    const wr = el.getBoundingClientRect(), ir = inner.getBoundingClientRect();
    return {
      overflowX: getComputedStyle(el).overflowX,
      fitsHoriz: ir.right <= wr.right + 1,
      fitsVert: ir.bottom <= wr.bottom + 1,
      transform: inner.style.transform,
    };
  });
  const fit = await measure();
  check('long equation never scrolls (overflow:hidden, not auto/scroll)', fit.overflowX === 'hidden', JSON.stringify(fit));
  check('long equation fits horizontally in its card', fit.fitsHoriz, JSON.stringify(fit));
  check('long equation fits vertically (no clipped/invisible content)', fit.fitsVert, JSON.stringify(fit));

  await page.setViewportSize({ width: 720, height: 800 }); // narrower container → re-fit smaller
  await page.waitForTimeout(400);
  const fit2 = await measure();
  check('re-fits smaller when its container shrinks (ResizeObserver wiring)', fit2.transform !== fit.transform && fit2.fitsHoriz && fit2.fitsVert, `before=${fit.transform} after=${JSON.stringify(fit2)}`);
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.waitForTimeout(400);

  // restore a short latex — section 6 relies on this widget's bounding box
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('atlas.page.equations.v1'));
    p.rows[0].cols[0].sections[0].lines[0].widgets[0].latex = 'a^2+b^2=c^2';
    localStorage.setItem('atlas.page.equations.v1', JSON.stringify(p));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.pwidget--eqcard .eq-render');
  await page.waitForTimeout(300);
}

// 6. equation list: add/edit items, view render
await page.click('#customize');
await page.waitForSelector('.palette__item[data-kind="eqlist"]');
const pal2 = await page.locator('.palette__item[data-kind="eqlist"]').boundingBox();
const w1 = await page.locator('.pwidget--eqcard').boundingBox();
await page.mouse.move(pal2.x + 20, pal2.y + 10);
await page.mouse.down();
const t2x = w1.x + w1.width * 0.9, t2y = w1.y + w1.height / 2; // beside the card
for (let i = 1; i <= 12; i++) { await page.mouse.move(pal2.x + 20 + ((t2x - pal2.x - 20) * i) / 12, pal2.y + 10 + ((t2y - pal2.y - 10) * i) / 12); await page.waitForTimeout(16); }
await page.mouse.up();
await page.waitForTimeout(400);
const list = page.locator('.pwidget--eqlist');
check('equation list dropped', await list.count() === 1);
await list.locator('.pw-eq-name').first().fill('Euler');
await typeMath(page, list.locator('math-field').first(), 'e^(ipi)+1=0');
await page.waitForTimeout(200);
await list.locator('.pw-add-item').click();
await page.waitForTimeout(300);
const rows = await page.locator('.pwidget--eqlist .pw-eq-row').count();
check('add equation adds a row', rows === 2, `rows=${rows}`);
const st2 = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.page.equations.v1')));
const items = /"name":"Euler"/.test(JSON.stringify(st2)) && /e\^/.test(JSON.stringify(st2)) && /\\pi/.test(JSON.stringify(st2));
check('list item name + latex persisted', !!items, JSON.stringify(st2).slice(0, 600));
await page.click('#customize'); // Done
await page.waitForTimeout(300);
const lview = await page.evaluate(() => ({
  names: [...document.querySelectorAll('.pw-eqlist__name')].map((e) => e.textContent),
  math: document.querySelectorAll('.pw-eqlist__item .eq-render').length,
}));
check('list view renders names + math', lview.names[0] === 'Euler' && lview.math === 2, JSON.stringify(lview));

// 6b. reorder equation-list items by dragging the row grip
await page.click('#customize');
await page.waitForSelector('.pwidget--eqlist .pw-eq-grip');
const namesBefore = await page.$$eval('.pwidget--eqlist .pw-eq-name', (els) => els.map((e) => e.value));
const grip = await page.locator('.pwidget--eqlist .pw-eq-row[data-index="0"] .pw-eq-grip').boundingBox();
const row2 = await page.locator('.pwidget--eqlist .pw-eq-row[data-index="1"]').boundingBox();
await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
await page.mouse.down();
let sawDragStyle = false, sawShiftAnim = false;
const targetY = row2.y + row2.height * 0.8; // well past the second row's midpoint
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + ((targetY - grip.y - grip.height / 2) * i) / 12);
  await page.waitForTimeout(20);
  const st = await page.evaluate(() => ({
    dragging: !!document.querySelector('.pw-eq-row.is-eq-dragging')?.style.transform,
    anim: [...document.querySelectorAll('.pw-eq-row:not(.is-eq-dragging)')].some((r) => r.style.transition.includes('transform')),
  }));
  sawDragStyle ||= st.dragging; sawShiftAnim ||= st.anim;
}
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(300);
check('dragged row follows cursor, displaced row animates', sawDragStyle && sawShiftAnim, `drag=${sawDragStyle} anim=${sawShiftAnim}`);
const namesAfter = await page.$$eval('.pwidget--eqlist .pw-eq-name', (els) => els.map((e) => e.value));
const stOrder = await page.evaluate(() => {
  const st = JSON.parse(localStorage.getItem('atlas.page.equations.v1'));
  const all = [];
  for (const r of st.rows) for (const c of r.cols) for (const sec of c.sections) for (const l of sec.lines) for (const w of l.widgets) if (w.kind === 'eqlist') all.push(...w.items.map((x) => x.name));
  return all;
});
check('grip drag swaps order in DOM + storage',
  namesAfter[0] === namesBefore[1] && namesAfter[1] === namesBefore[0] && JSON.stringify(stOrder) === JSON.stringify(namesAfter),
  `before=${namesBefore} after=${namesAfter} stored=${stOrder}`);
// drag it back up
const gripB = await page.locator('.pwidget--eqlist .pw-eq-row[data-index="1"] .pw-eq-grip').boundingBox();
const row1B = await page.locator('.pwidget--eqlist .pw-eq-row[data-index="0"]').boundingBox();
await page.mouse.move(gripB.x + gripB.width / 2, gripB.y + gripB.height / 2);
await page.mouse.down();
const backY = row1B.y + row1B.height * 0.2;
for (let i = 1; i <= 12; i++) { await page.mouse.move(gripB.x + gripB.width / 2, gripB.y + gripB.height / 2 + ((backY - gripB.y - gripB.height / 2) * i) / 12); await page.waitForTimeout(20); }
await page.mouse.up();
await page.waitForTimeout(300);
const namesBack = await page.$$eval('.pwidget--eqlist .pw-eq-name', (els) => els.map((e) => e.value));
const clean = await page.evaluate(() => [...document.querySelectorAll('.pw-eq-row')].every((r) => !r.style.transform) && !document.querySelector('.is-eq-dragging'));
check('drag back restores order, no leftover transforms', JSON.stringify(namesBack) === JSON.stringify(namesBefore) && clean, `back=${namesBack} clean=${clean}`);
await page.click('#customize'); // Done
await page.waitForTimeout(200);

// 7. storage separation + dashboard palette gains equation kinds
const dashBefore = await page.evaluate(() => localStorage.getItem('atlas.page.v1'));
await page.click('a[href="#/dashboard"]');
await page.waitForTimeout(300);
await page.click('#customize');
await page.waitForSelector('.palette__item');
const dashKinds = await page.$$eval('.palette__item', (els) => els.map((e) => e.dataset.kind));
check('dashboard palette includes equation widgets', JSON.stringify(dashKinds) === '["card","list","graph","eqcard","eqlist","gymcurrent","gymnext","gymscore","gymscoregraph","gymexercises","gymvolume","calagenda","calmonth","cvgradebook","cvupcoming","cvannounce","cvoverdue","cvgpa","cvsemesters","cvcourses","cvtodo","wkincome","wkshifts","wktipshare","wkupcoming","gfgraph","fintopspend","finrecent","fincategory","finsubs","finaccounts","finincexp","finbudget","finnetworth","finanomaly","slbedtime","sllog","slhours","sldebt"]', JSON.stringify(dashKinds));
const cats = await page.$$eval('.palette__cat', (els) => els.map((e) => e.textContent));
check('palette grouped by plugin (dev mode on)', JSON.stringify(cats) === '["Developer","Equations","Gym","Calendar","Canvas","Work","Graph","Finances","Sleep"]', JSON.stringify(cats));
const dashAfter = await page.evaluate(() => localStorage.getItem('atlas.page.v1'));
check('equation edits never touched dashboard storage', dashBefore === dashAfter);

// 8. customize exits when switching pages
const czBefore = await page.evaluate(() => document.body.classList.contains('customizing'));
await page.click('a[href="#/equations"]');
await page.waitForTimeout(300);
const cz = await page.evaluate(() => ({
  customizing: document.body.classList.contains('customizing'),
  palettes: document.querySelectorAll('.palette').length,
  label: document.querySelector('#customize span')?.textContent,
}));
check('switching pages exits customize cleanly', czBefore === true && !cz.customizing && cz.palettes === 0 && cz.label === 'Customize', JSON.stringify(cz));

// 9. reload: equations persist and render
await page.reload({ waitUntil: 'load' });
await page.goto('http://localhost:5173/#/equations', { waitUntil: 'load' });
await page.waitForTimeout(500);
const persisted = await page.evaluate(() => document.querySelectorAll('.eq-render').length);
check('equations survive reload', persisted >= 3, `renders=${persisted}`);
// 10. dev mode OFF: developer widgets hidden from the palette entirely
{
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 } }); // NO devMode
  const p2 = await ctx2.newPage();
  await p2.goto('http://localhost:5173/#/dashboard', { waitUntil: 'load' });
  await p2.click('#customize');
  await p2.waitForSelector('.palette');
  const offKinds = await p2.$$eval('.palette__item', (els) => els.map((e) => e.dataset.kind));
  const offCats = await p2.$$eval('.palette__cat', (els) => els.map((e) => e.textContent));
  check('dev mode off hides developer widgets', JSON.stringify(offKinds) === '["eqcard","eqlist","gymcurrent","gymnext","gymscore","gymscoregraph","gymexercises","gymvolume","calagenda","calmonth","cvgradebook","cvupcoming","cvannounce","cvoverdue","cvgpa","cvsemesters","cvcourses","cvtodo","wkincome","wkshifts","wktipshare","wkupcoming","gfgraph","fintopspend","finrecent","fincategory","finsubs","finaccounts","finincexp","finbudget","finnetworth","finanomaly","slbedtime","sllog","slhours","sldebt"]' && JSON.stringify(offCats) === '["Equations","Gym","Calendar","Canvas","Work","Graph","Finances","Sleep"]', `kinds=${offKinds} cats=${offCats}`);
  await ctx2.close();
}
check('no console errors anywhere', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close();
let fail = 0;
for (const c of out) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`); if (!c.ok) fail++; }
process.exit(fail ? 1 : 0);
