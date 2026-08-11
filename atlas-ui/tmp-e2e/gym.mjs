import { chromium } from 'playwright';
const GYM = {"v":1,
 "plan":{"type":"cycle","weekly":{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null},"cycle":{"order":["gw-a","gw-b","gw-c"],"position":0}},
 "workouts":[{"id":"gw-a","name":"Chest & Back"},{"id":"gw-b","name":"Arms"},{"id":"gw-c","name":"Legs"}],
 "exercises":[
   {"id":"ge-1","workoutId":"gw-a","name":"Bench press","unilateral":false},
   {"id":"ge-2","workoutId":"gw-a","name":"DB row","unilateral":true},
   {"id":"ge-3","workoutId":"gw-b","name":"Curls","unilateral":false}],
 "logs":[
   {"id":"l1","exerciseId":"ge-1","date":"2026-06-01","side":null,"sets":[{"weight":100,"reps":5}]},
   {"id":"l2","exerciseId":"ge-1","date":"2026-06-15","side":null,"sets":[{"weight":105,"reps":5}]},
   {"id":"l3","exerciseId":"ge-3","date":"2026-06-01","side":null,"sets":[{"weight":20,"reps":10}]},
   {"id":"l4","exerciseId":"ge-3","date":"2026-06-15","side":null,"sets":[{"weight":20,"reps":10}]}],
 "completions":[]};
const wid = (k, n) => ({ id: `w-${k}${n || ''}`, kind: k });
const line = (n, ws) => ({ id: `l-${n}`, widgets: ws });
const PAGE = {"v":1,"rows":[
 {"id":"r-1","cols":[
   {"id":"c-1","sections":[{"id":"s-1","lines":[line('a',[wid('gymcurrent')])]}]},
   {"id":"c-2","sections":[
     {"id":"s-2","lines":[line('b',[wid('gymnext',1)]), line('c',[wid('gymnext',2)]), line('d',[wid('gymnext',3)])]},
     {"id":"s-3","lines":[line('e',[wid('gymscore'), wid('gymvolume')])]}]}]},
 {"id":"r-2","cols":[
   {"id":"c-3","sections":[{"id":"s-4","lines":[line('f',[wid('gymexercises'), wid('gymscoregraph')])]}]}]}]};
const out = [];
const check = (n, ok, d = '') => out.push({ name: n, ok, detail: d });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 1300 } });
await context.addInitScript(({ g, p }) => {
  localStorage.setItem('atlas.devMode', '1');
  if (!localStorage.getItem('atlas.gym.v1')) localStorage.setItem('atlas.gym.v1', JSON.stringify(g));
  if (!localStorage.getItem('atlas.page.gym.v1')) localStorage.setItem('atlas.page.gym.v1', JSON.stringify(p));
}, { g: GYM, p: PAGE });
const page = await context.newPage();
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(e.message));
await page.goto('http://localhost:5173/#/gym', { waitUntil: 'load' });
await page.waitForTimeout(600);
const gymStore = () => page.evaluate(() => JSON.parse(localStorage.getItem('atlas.gym.v1')));

// 1. nav + tabs
const shell = await page.evaluate(() => ({
  nav: [...document.querySelectorAll('.nav__item .nav__label')].map((e) => e.textContent),
  tabs: [...document.querySelectorAll('.page-tab')].map((e) => e.textContent.trim()),
  head: document.getElementById('title')?.textContent,
}));
check('gym in nav + Board/Settings tabs', shell.nav.includes('Gym') && JSON.stringify(shell.tabs) === '["Board","Settings"]' && shell.head === 'Gym', JSON.stringify(shell));

// 2. current workout + upcoming trio (same section shows successive entries)
const boards = await page.evaluate(() => ({
  current: document.querySelector('.pwidget--gymcurrent .gym-big')?.textContent,
  exTitles: [...document.querySelectorAll('.pwidget--gymcurrent .gym-ex-title')].map((e) => e.textContent.replace(/\s+L\/R$/, '').trim()),
  sides: [...document.querySelectorAll('.pwidget--gymcurrent .gym-side')].map((e) => e.textContent),
  next: [...document.querySelectorAll('.pwidget--gymnext .gym-big')].map((e) => e.textContent),
}));
check('current workout = cycle position 0', boards.current === 'Chest & Back', boards.current);
check('unilateral exercise shows L and R log rows', JSON.stringify(boards.sides) === '["L","R"]', JSON.stringify(boards.sides));
check('3 upcoming widgets in one section show successive workouts', JSON.stringify(boards.next) === '["Arms","Legs","Chest & Back"]', JSON.stringify(boards.next));

// 3. strength score (bench 116.67→122.5 = 105; curls flat = 100 → avg 102.5)
const score = await page.evaluate(() => document.querySelector('.pwidget--gymscore .gym-big--num')?.textContent);
check('general score = avg progress index (102.5)', score === '102.5', score);

// 4. score graph SVG drawn with a line
const graph = await page.evaluate(() => ({
  line: !!document.querySelector('.pwidget--gymscoregraph .chart__line'),
  labels: [...document.querySelectorAll('.pwidget--gymscoregraph .chart__xlab')].map((e) => e.textContent),
}));
check('strength graph renders line + dates', graph.line && graph.labels.length === 2, JSON.stringify(graph));

// 5. exercise list with indexes
const exList = await page.evaluate(() => [...document.querySelectorAll('.gym-ex-row')].map((r) => [r.querySelector('.gym-ex-name').textContent.trim(), r.querySelector('.gym-ex-idx').textContent]));
check('exercise list shows progress indexes', JSON.stringify(exList).includes('["Bench press","105"]') && JSON.stringify(exList).includes('["Curls","100"]') && JSON.stringify(exList).includes('—'), JSON.stringify(exList));

// 6. log sets: bilateral + each unilateral side independently
const benchRow = page.locator('.gym-log-row[data-ex-id="ge-1"]');
await benchRow.locator('.gym-w').fill('107.5');
await benchRow.locator('.gym-r').fill('5');
await benchRow.locator('[data-gym-act="log-set"]').click();
await page.waitForTimeout(300);
const rowL = page.locator('.gym-log-row[data-ex-id="ge-2"][data-side="L"]');
await rowL.locator('.gym-w').fill('30');
await rowL.locator('.gym-r').fill('10');
await rowL.locator('[data-gym-act="log-set"]').click();
await page.waitForTimeout(300);
let g1 = await gymStore();
const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; });
const benchLog = g1.logs.find((l) => l.exerciseId === 'ge-1' && l.date === today);
const lLog = g1.logs.find((l) => l.exerciseId === 'ge-2' && l.date === today && l.side === 'L');
const rLog = g1.logs.find((l) => l.exerciseId === 'ge-2' && l.date === today && l.side === 'R');
check('set logged with weight+reps', benchLog?.sets?.[0]?.weight === 107.5 && benchLog?.sets?.[0]?.reps === 5, JSON.stringify(benchLog));
check('unilateral L logged independently (no R entry)', lLog?.sets?.length === 1 && !rLog, JSON.stringify({ lLog, rLog }));
const chips = await page.evaluate(() => document.querySelector('.gym-log-row[data-ex-id="ge-1"] .gym-chips')?.textContent);
check('logged set shows as chip', /107\.5×5/.test(chips || ''), chips);

// 7. undo last set
await page.locator('.gym-log-row[data-ex-id="ge-1"] [data-gym-act="undo-set"]').click();
await page.waitForTimeout(250);
g1 = await gymStore();
check('undo removes the set', !g1.logs.find((l) => l.exerciseId === 'ge-1' && l.date === today), '');

// 8. weekly volume widget counts this week (L log of 30×10 = 300)
const vol = await page.evaluate(() => document.querySelector('.pwidget--gymvolume .gym-big--num')?.textContent);
check('volume widget sums this week', vol === '300', vol);

// 9. complete workout advances the cycle
await page.locator('[data-gym-act="complete"]').click();
await page.waitForTimeout(300);
g1 = await gymStore();
const after = await page.evaluate(() => ({
  current: document.querySelector('.pwidget--gymcurrent .gym-big')?.textContent,
  next: [...document.querySelectorAll('.pwidget--gymnext .gym-big')].map((e) => e.textContent),
}));
check('complete stamps + advances cycle', g1.completions.length === 1 && g1.plan.cycle.position === 1 && after.current === 'Arms' && after.next[0] === 'Legs', JSON.stringify({ pos: g1.plan.cycle.position, after }));

// 10. exercise modal: chart + history + edit
await page.click('.gym-ex-row[data-ex-id="ge-1"]');
await page.waitForTimeout(300);
const modal = await page.evaluate(() => ({
  open: !!document.getElementById('app-modal'),
  title: document.querySelector('#app-modal .modal__title')?.textContent,
  chart: !!document.querySelector('#app-modal .gym-modal-chart .chart__line'),
  histRows: document.querySelectorAll('#app-modal .gym-history tr').length,
}));
check('exercise modal: graph + set history', modal.open && modal.title === 'Bench press' && modal.chart && modal.histRows === 2, JSON.stringify(modal));
await page.locator('#app-modal .gym-edit-name').fill('Incline bench');
await page.locator('#app-modal .gym-edit-uni').check();
await page.locator('#app-modal .gym-edit-save').click();
await page.waitForTimeout(300);
g1 = await gymStore();
const e1 = g1.exercises.find((e) => e.id === 'ge-1');
const renamed = await page.evaluate(() => [...document.querySelectorAll('.gym-ex-name')].some((e) => e.textContent.includes('Incline bench')));
check('modal edit renames + toggles unilateral', e1.name === 'Incline bench' && e1.unilateral === true && renamed, JSON.stringify(e1));

// 11. customize palette on gym page: Gym plugin only
await page.click('#customize');
await page.waitForSelector('.palette__item');
const pal = await page.evaluate(() => ({
  kinds: [...document.querySelectorAll('.palette__item')].map((e) => e.dataset.kind),
  cats: [...document.querySelectorAll('.palette__cat')].map((e) => e.textContent),
}));
check('gym palette restricted + categorized', pal.kinds.every((k) => k.startsWith('gym')) && pal.kinds.length === 6 && JSON.stringify(pal.cats) === '["Gym"]', JSON.stringify(pal));
await page.click('#customize');
await page.waitForTimeout(200);

// 12. settings tab: plan editing, workout/exercise CRUD, cycle reorder
await page.click('.page-tab[href="#/gym/settings"]');
await page.waitForTimeout(300);
const set0 = await page.evaluate(() => ({
  planType: document.querySelector('[data-gym-set="plan-type"]')?.value,
  cycleRows: document.querySelectorAll('.gym-cycle-row').length,
  actions: getComputedStyle(document.querySelector('.topbar__actions')).display,
}));
check('settings tab renders cycle plan, customize hidden', set0.planType === 'cycle' && set0.cycleRows === 3 && set0.actions === 'none', JSON.stringify(set0));
// reorder cycle: move first entry down
await page.locator('.gym-cycle-row [data-gym-set="cycle-down"]').first().click();
await page.waitForTimeout(250);
g1 = await gymStore();
check('cycle reorder persists', JSON.stringify(g1.plan.cycle.order) === '["gw-b","gw-a","gw-c"]', JSON.stringify(g1.plan.cycle.order));
// add a workout + exercise
await page.locator('.gym-new-workout').fill('Shoulders');
await page.locator('[data-gym-set="workout-add"]').click();
await page.waitForTimeout(250);
const blk = page.locator('.gym-workout-block').last();
await blk.locator('.gym-new-ex').fill('Lateral raise');
await blk.locator('.gym-new-ex-uni').check();
await blk.locator('[data-gym-set="exercise-add"]').click();
await page.waitForTimeout(250);
g1 = await gymStore();
const sh = g1.workouts.find((w) => w.name === 'Shoulders');
const lr = g1.exercises.find((e) => e.name === 'Lateral raise');
check('settings adds workout + unilateral exercise', !!sh && lr?.workoutId === sh?.id && lr?.unilateral === true, JSON.stringify({ sh, lr }));
// switch plan to weekly and assign today's weekday
await page.selectOption('[data-gym-set="plan-type"]', 'weekly');
await page.waitForTimeout(250);
const dayKey = await page.evaluate(() => ['mon','tue','wed','thu','fri','sat','sun'][(new Date().getDay() + 6) % 7]);
await page.selectOption(`[data-gym-set="day"][data-day="${dayKey}"]`, sh.id);
await page.waitForTimeout(250);
await page.click('.page-tab[href="#/gym"]');
await page.waitForTimeout(400);
const weeklyNow = await page.evaluate(() => document.querySelector('.pwidget--gymcurrent .gym-big')?.textContent);
check('weekly plan drives current workout by weekday', weeklyNow === 'Shoulders', weeklyNow);

// 12b. kg/lbs toggle: canonical kg storage, converted display
await page.click('.page-tab[href="#/gym/settings"]');
await page.waitForTimeout(300);
await page.selectOption('[data-gym-set="unit"]', 'lbs');
await page.waitForTimeout(250);
await page.click('.page-tab[href="#/gym"]');
await page.waitForTimeout(400);
const lbsView = await page.evaluate(() => ({
  placeholder: document.querySelector('.gym-log-row .gym-w')?.placeholder,
  volLabel: document.querySelector('.pwidget--gymvolume .gym-sub')?.textContent,
  vol: document.querySelector('.pwidget--gymvolume .gym-big--num')?.textContent,
}));
check('lbs mode: inputs + volume convert', lbsView.placeholder === 'lbs' && /lbs × reps/.test(lbsView.volLabel) && lbsView.vol === '661.4', JSON.stringify(lbsView)); // 300kg → 661.4 lbs
// log 220.5 lbs → stored as ~100 kg
const anyRow = page.locator('.gym-log-row').first();
await anyRow.locator('.gym-w').fill('220.5');
await anyRow.locator('.gym-r').fill('5');
await anyRow.locator('[data-gym-act="log-set"]').click();
await page.waitForTimeout(300);
const gU = await gymStore();
const exId = await page.evaluate(() => document.querySelector('.gym-log-row')?.dataset.exId);
const uLog = gU.logs.find((l) => l.exerciseId === exId && l.date === today);
const kg = uLog?.sets?.at(-1)?.weight;
check('lbs entry stored canonically in kg', Math.abs(kg - 100.017) < 0.01, `kg=${kg}`);
const chipU = await page.evaluate(() => document.querySelector('.gym-log-row .gym-chips')?.textContent);
check('chip shows the lbs value back', /220\.5×5/.test(chipU || ''), chipU);
// undo + back to kg for the rest of the suite
await page.locator('.gym-log-row [data-gym-act="undo-set"]').first().click();
await page.waitForTimeout(250);
await page.click('.page-tab[href="#/gym/settings"]');
await page.waitForTimeout(250);
await page.selectOption('[data-gym-set="unit"]', 'kg');
await page.waitForTimeout(250);
await page.click('.page-tab[href="#/gym"]');
await page.waitForTimeout(300);

// 12c. rest/flex designations + themed checkboxes
await page.click('.page-tab[href="#/gym/settings"]');
await page.waitForTimeout(300);
const cb = await page.evaluate(() => {
  const el = document.querySelector('.gym-check input[type="checkbox"]');
  const cs = getComputedStyle(el);
  return { appearance: cs.appearance, bg: cs.backgroundColor, hasRest: !!document.querySelector('[data-gym-set="workout-rest"]'), hasFlex: !!document.querySelector('[data-gym-set="workout-flex"]') };
});
check('gym checkboxes are theme-drawn (not native white)', cb.appearance === 'none' && cb.bg !== 'rgb(255, 255, 255)' && cb.hasRest && cb.hasFlex, JSON.stringify(cb));
// mark the FIRST workout as rest + flex
await page.locator('[data-gym-set="workout-rest"]').first().check();
await page.waitForTimeout(200);
await page.locator('[data-gym-set="workout-flex"]').first().check();
await page.waitForTimeout(200);
g1 = await gymStore();
check('rest + flex flags persist on the workout', g1.workouts[0].rest === true && g1.workouts[0].flex === true, JSON.stringify(g1.workouts[0]));
// weekly plan currently points today at 'Shoulders' — repoint to the rest workout
const dayKey2 = await page.evaluate(() => ['mon','tue','wed','thu','fri','sat','sun'][(new Date().getDay() + 6) % 7]);
await page.selectOption(`[data-gym-set="day"][data-day="${dayKey2}"]`, g1.workouts[0].id);
await page.waitForTimeout(200);
await page.click('.page-tab[href="#/gym"]');
await page.waitForTimeout(400);
const restView = await page.evaluate(() => ({
  sub: document.querySelector('.pwidget--gymcurrent .gym-sub')?.textContent,
  logRows: document.querySelectorAll('.pwidget--gymcurrent .gym-log-row').length,
  btn: document.querySelector('[data-gym-act="complete"]')?.textContent,
}));
check('rest day board: no logging, flex noted, completable', /Rest day · flex/.test(restView.sub || '') && restView.logRows === 0 && restView.btn === 'Complete rest day', JSON.stringify(restView));
// un-rest it and restore today's assignment for the remaining checks
await page.click('.page-tab[href="#/gym/settings"]');
await page.waitForTimeout(250);
await page.locator('[data-gym-set="workout-rest"]').first().uncheck();
await page.waitForTimeout(200);
await page.selectOption(`[data-gym-set="day"][data-day="${dayKey2}"]`, sh.id);
await page.waitForTimeout(200);
await page.click('.page-tab[href="#/gym"]');
await page.waitForTimeout(300);

// 13. storage separation
const dash = await page.evaluate(() => localStorage.getItem('atlas.page.v1'));
check('gym never touched dashboard storage', dash === null, String(dash).slice(0, 60));
// 14. boot import: a fresh profile (no gym store) adopts /gym-import.json
{
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 1300 } });
  const p2 = await ctx2.newPage();
  await p2.goto('http://localhost:5173/#/gym', { waitUntil: 'load' });
  await p2.waitForTimeout(800);
  const st = await p2.evaluate(() => JSON.parse(localStorage.getItem('atlas.gym.v1') || 'null'));
  const cur = await p2.evaluate(() => document.querySelector('.pwidget--gymcurrent')?.textContent || document.querySelector('.empty__title')?.textContent);
  const uni = st?.exercises?.find((e) => e.name === 'Single Arm Cable Row');
  check('old-Atlas data imported on first boot',
    st?.plan?.type === 'cycle' && st?.workouts?.length === 7 && st?.exercises?.length === 36 &&
    st.workouts[0].name === 'Chest & Back A' && st.workouts[4].name === 'Chest & Back B' &&
    uni?.unilateral === true && st.exercises[0].target === '3×8' && st.plan.cycle.position === 0,
    JSON.stringify({ type: st?.plan?.type, w: st?.workouts?.length, e: st?.exercises?.length, uni, cur: String(cur).slice(0, 40) }));
  await ctx2.close();
}
// 15. per-weekday gym hours (open/close), not a single preferred window
await page.click('.page-tab[href="#/gym/settings"]');
await page.waitForSelector('.gym-day-row .gym-hours');
const dayRows = await page.$$eval('.gym-day-row', (els) => els.filter((e) => e.querySelector('.gym-hours')).length);
check('7 day rows with open/close inputs', dayRows === 7, String(dayRows));
await page.fill('[data-gym-set="hours-open"][data-day="mon"]', '16:00');
await page.fill('[data-gym-set="hours-close"][data-day="mon"]', '21:00');
await page.fill('[data-gym-set="hours-open"][data-day="sat"]', '09:00');
await page.fill('[data-gym-set="hours-close"][data-day="sat"]', '12:00');
await page.waitForTimeout(200);
const hours = await page.evaluate(() => JSON.parse(localStorage.getItem('atlas.gym.v1')).hours);
check('each day stores its own open/close', hours.mon.open === '16:00' && hours.mon.close === '21:00' && hours.sat.open === '09:00' && hours.sat.close === '12:00' && hours.tue.open === '', JSON.stringify(hours));

check('no console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
await browser.close();
let fail = 0;
for (const c of out) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ' — ' + c.detail}`); if (!c.ok) fail++; }
process.exit(fail ? 1 : 0);
