import { chromium } from 'playwright';
const GYM = {"v":1,
 "plan":{"type":"cycle","weekly":{"mon":null,"tue":null,"wed":null,"thu":null,"fri":null,"sat":null,"sun":null},"cycle":{"order":["gw-a","gw-b","gw-c"],"position":0}},
 "workouts":[{"id":"gw-a","name":"Chest & Back"},{"id":"gw-b","name":"Arms"},{"id":"gw-c","name":"Legs"}],
 "exercises":[
   {"id":"ge-1","workoutId":"gw-a","name":"Bench press","unilateral":false},
   {"id":"ge-2","workoutId":"gw-a","name":"Single-arm row","unilateral":true},
   {"id":"ge-3","workoutId":"gw-b","name":"Curls","unilateral":false},
   {"id":"ge-4","workoutId":"gw-c","name":"Squat","unilateral":false}],
 "logs":[
   {"id":"l1","exerciseId":"ge-1","date":"2026-06-01","side":null,"sets":[{"weight":100,"reps":5},{"weight":100,"reps":4}]},
   {"id":"l2","exerciseId":"ge-1","date":"2026-06-10","side":null,"sets":[{"weight":102.5,"reps":5}]},
   {"id":"l3","exerciseId":"ge-1","date":"2026-06-24","side":null,"sets":[{"weight":105,"reps":6}]},
   {"id":"l4","exerciseId":"ge-3","date":"2026-06-01","side":null,"sets":[{"weight":20,"reps":10}]},
   {"id":"l5","exerciseId":"ge-3","date":"2026-06-24","side":null,"sets":[{"weight":22.5,"reps":10}]},
   {"id":"l6","exerciseId":"ge-4","date":"2026-06-05","side":null,"sets":[{"weight":140,"reps":5}]},
   {"id":"l7","exerciseId":"ge-4","date":"2026-06-26","side":null,"sets":[{"weight":150,"reps":5}]},
   {"id":"l8","exerciseId":"ge-2","date":"2026-06-24","side":"L","sets":[{"weight":30,"reps":10}]},
   {"id":"l9","exerciseId":"ge-2","date":"2026-06-24","side":"R","sets":[{"weight":32.5,"reps":10}]}],
 "completions":[]};
const wid = (k, n) => ({ id: `w-${k}${n || ''}`, kind: k });
const line = (n, ws) => ({ id: `l-${n}`, widgets: ws });
const PAGE = {"v":1,"rows":[
 {"id":"r-1","title":"Today","cols":[
   {"id":"c-1","width":1.4,"sections":[{"id":"s-1","lines":[line('a',[wid('gymcurrent')])]}]},
   {"id":"c-2","sections":[
     {"id":"s-2","title":"Coming up","lines":[line('b',[wid('gymnext',1)]), line('c',[wid('gymnext',2)])]},
     {"id":"s-3","lines":[line('e',[wid('gymscore'), wid('gymvolume')])]}]}]},
 {"id":"r-2","title":"Progress","cols":[
   {"id":"c-3","sections":[{"id":"s-4","lines":[line('f',[wid('gymexercises'), wid('gymscoregraph')])]}]}]}]};
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 1150 } });
await ctx.addInitScript(({ g, p }) => {
  localStorage.setItem('atlas.gym.v1', JSON.stringify(g));
  localStorage.setItem('atlas.page.gym.v1', JSON.stringify(p));
}, { g: GYM, p: PAGE });
const page = await ctx.newPage();
await page.goto('http://localhost:5173/#/gym', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: process.env.OUT + '/gym-board.png' });
await page.click('.gym-ex-row[data-ex-id="ge-1"]');
await page.waitForTimeout(400);
await page.screenshot({ path: process.env.OUT + '/gym-modal.png' });
await page.keyboard.press('Escape');
await page.click('.page-tab[href="#/gym/settings"]');
await page.waitForTimeout(400);
await page.screenshot({ path: process.env.OUT + '/gym-settings.png' });
await browser.close();
