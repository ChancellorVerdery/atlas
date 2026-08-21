// Notes graphs on WebKit. They are the only <foreignObject> user in the app
// (typeset axis/curve labels), and foreignObject is historically where WebKit
// and Chromium disagree — so this renders the SAME spec through the SAME
// module in both engines and compares. Chromium is the control: any label that
// has size there and none here is a WebKit bug, not a bad spec.
// Run: node tmp-e2e/mobile-notegraph.mjs
import { chromium, webkit } from 'playwright'

const BASE = 'http://localhost:5173'

const SPECS = [
  ['function', { title: 'Function', xLabel: '$x$', yLabel: '$y$', curves: [{ latex: '\\sin x', label: '$\\sin x$' }] }],
  ['parametric', { title: 'Unit circle', xLabel: '$x$', yLabel: '$y$', equal: true,
    curves: [{ x: '\\cos t', y: '\\sin t', t: [0, 6.283], label: '$x=\\cos t,\\ y=\\sin t$' }] }],
  ['series', { title: 'Measured', xLabel: 'trial', yLabel: 'value',
    series: [{ label: 'measured', data: [[1, 2], [2, 4], [3, 3], [4, 6]] }] }],
]

const probe = async (engine, name, viewport, native) => {
  const b = await engine.launch({ headless: true })
  const ctx = await b.newContext({ viewport, deviceScaleFactor: native ? 3 : 1, hasTouch: !!native })
  if (native) await ctx.addInitScript(() => { window.__ATLAS_NATIVE__ = { platform: 'ios' } })
  const page = await ctx.newPage()
  const errs = []
  page.on('pageerror', (e) => { if (!/WebSocket/.test(e.message)) errs.push(e.message) })
  // Load the app origin so the dev server resolves the module graph, then drive
  // notegraph directly — no note file, no Apple Notes, no folder picker.
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(400)

  const out = await page.evaluate(async (specs) => {
    const mod = await import('/src/page/notegraph.js')
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;left:0;top:0;width:100%;background:#fff;z-index:99999'
    document.body.appendChild(host)
    const res = []
    for (const [label, spec] of specs) {
      let html = null, err = null
      try { html = await mod.graphSVG(spec) } catch (e) { err = String(e).slice(0, 140) }
      const box = document.createElement('div')
      box.innerHTML = html || ''
      host.appendChild(box)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const svg = box.querySelector('svg')
      const r = svg?.getBoundingClientRect()
      const fos = [...box.querySelectorAll('foreignObject')].map((f) => {
        const fr = f.getBoundingClientRect()
        const inner = f.firstElementChild
        const ir = inner?.getBoundingClientRect()
        return {
          foW: Math.round(fr.width), foH: Math.round(fr.height),
          innerW: Math.round(ir?.width || 0), innerH: Math.round(ir?.height || 0),
          hasMathMarkup: !!f.querySelector('.ML__latex, .ML__base, [class*="ML__"]'),
          text: (f.textContent || '').trim().slice(0, 18),
        }
      })
      res.push({
        label, err,
        svgW: Math.round(r?.width || 0), svgH: Math.round(r?.height || 0),
        curvePaths: [...box.querySelectorAll('path[d]')]
          .filter((p) => (p.getAttribute('d') || '').length > 40).length,
        foCount: fos.length,
        foWithZeroInner: fos.filter((f) => f.innerW < 1 || f.innerH < 1).length,
        foWithMath: fos.filter((f) => f.hasMathMarkup).length,
        sample: fos.slice(0, 3),
      })
    }
    host.remove()
    return res
  }, SPECS)

  await b.close()
  return { name, out, errs: [...new Set(errs)] }
}

const results = []
results.push(await probe(chromium, 'chromium desktop (control)', { width: 1440, height: 900 }, false))
results.push(await probe(webkit, 'webkit desktop', { width: 1440, height: 900 }, false))
results.push(await probe(webkit, 'webkit iPhone (native ios)', { width: 402, height: 874 }, true))

for (const r of results) {
  console.log(`\n=== ${r.name} ===`)
  for (const g of r.out) {
    const bad = g.err || g.svgW < 2 || g.curvePaths === 0 || g.foWithZeroInner > 0
    console.log(`   ${bad ? 'XX' : 'ok'} ${g.label.padEnd(11)} svg ${g.svgW}x${g.svgH} curvePaths=${g.curvePaths} ` +
      `foreignObjects=${g.foCount} zero-size-inner=${g.foWithZeroInner} with-math-markup=${g.foWithMath}` +
      (g.err ? `  ERR ${g.err}` : ''))
    for (const s of g.sample) {
      console.log(`        fo ${s.foW}x${s.foH} inner ${s.innerW}x${s.innerH} math=${s.hasMathMarkup} "${s.text}"`)
    }
  }
  for (const e of r.errs) console.log(`   error: ${e.slice(0, 160)}`)
}
