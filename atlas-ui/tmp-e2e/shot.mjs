import { chromium } from 'playwright';
const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","height":560,"title":"Key Metrics","cols":[
   {"id":"c-1","sections":[{"id":"s-1","title":"Finance","lines":[
     {"id":"l-1","widgets":[{"id":"w-a","kind":"card","title":"Revenue","text":"Quarterly revenue is up."},{"id":"w-b","kind":"card","title":"Costs","text":"Cloud spend flat."}]},
     {"id":"l-2","widgets":[{"id":"w-c","kind":"card","title":"Notes","text":"Review Friday."}]}]},{"id":"s-2","title":"Ops","lines":[{"id":"l-9","widgets":[{"id":"w-f","kind":"card","title":"Standup","text":"Daily at 9:30."}]}]}]},
   {"id":"c-2","lines":[
     {"id":"l-3","widgets":[{"id":"w-d","kind":"graph","graphType":"bar","title":"Traffic","xLabel":"Day","yLabel":"Visits","points":[{"label":"Mon","value":10},{"label":"Tue","value":30},{"label":"Wed","value":20},{"label":"Thu","value":45},{"label":"Fri","value":28}]}]}]}]},
 {"id":"r-2","width":50,"cols":[
   {"id":"c-3","lines":[
     {"id":"l-4","widgets":[{"id":"w-e","kind":"list","title":"Tasks","items":["Ship rebuild","Test drop zones"]}]}]}]}]};
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } });
await ctx.addInitScript(() => localStorage.setItem('atlas.devMode', '1'));
await ctx.addInitScript((fx) => localStorage.setItem('atlas.page.v1', JSON.stringify(fx)), FIXTURE);
const page = await ctx.newPage();
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
await page.screenshot({ path: process.env.OUT + '/view-mode.png' });
await page.click('#customize');
await page.waitForTimeout(400);
await page.screenshot({ path: process.env.OUT + '/customize-mode.png' });
await b.close();
