import { chromium } from 'playwright';
const FIXTURE = {"v":1,"rows":[
 {"id":"r-1","title":"Identities","cols":[
   {"id":"c-1","sections":[{"id":"s-1","title":"Fundamentals","lines":[
     {"id":"l-1","widgets":[
       {"id":"w-1","kind":"eqcard","title":"Pythagorean theorem","latex":"a^{2}+b^{2}=c^{2}"},
       {"id":"w-2","kind":"eqcard","title":"Euler's identity","latex":"e^{i\\pi}+1=0"}]}]}]},
   {"id":"c-2","sections":[{"id":"s-2","title":"Calculus","lines":[
     {"id":"l-2","widgets":[{"id":"w-3","kind":"eqlist","title":"Derivatives","items":[
       {"name":"Power rule","latex":"\\frac{d}{dx}x^{n}=nx^{n-1}"},
       {"name":"Chain rule","latex":"(f\\circ g)'=(f'\\circ g)\\cdot g'"},
       {"name":"Quotient rule","latex":"\\left(\\frac{f}{g}\\right)'=\\frac{f'g-fg'}{g^{2}}"}]}]}]}]}]}]};
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await (typeof context !== 'undefined' ? context : ctx).addInitScript(() => localStorage.setItem('atlas.devMode', '1')); // dev widgets in palette
await ctx.addInitScript((fx) => localStorage.setItem('atlas.page.equations.v1', JSON.stringify(fx)), FIXTURE);
const page = await ctx.newPage();
await page.goto('http://localhost:5173/#/equations', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: process.env.OUT + '/equations-view.png' });
await page.click('#customize');
await page.waitForTimeout(600);
await page.screenshot({ path: process.env.OUT + '/equations-customize.png' });
await browser.close();
