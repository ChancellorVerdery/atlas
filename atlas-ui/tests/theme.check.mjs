// The colour scheme is only "universal" if every knob the stylesheet reads gets
// a value and the logo is derived from those same values — otherwise half the
// app (or the app icon) keeps the old palette.
// Run: node tests/theme.check.mjs
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
}

const {
  PRESETS, DEFAULT_PRESET, parseHex, toHex, triplet, shade,
  loadTheme, saveTheme, resolve, themeVars, logoSVG, logoDataURL,
} = await import('../src/page/theme.js')

// --- colour maths -----------------------------------------------------------
assert.deepEqual(parseHex('#e0b15c'), [224, 177, 92])
assert.deepEqual(parseHex('e0b15c'), [224, 177, 92])
assert.deepEqual(parseHex('#abc'), [170, 187, 204]) // shorthand expands
assert.deepEqual(parseHex('nonsense'), parseHex(PRESETS[DEFAULT_PRESET].accent)) // never throws
assert.deepEqual(parseHex(null), parseHex(PRESETS[DEFAULT_PRESET].accent))
assert.equal(toHex([224, 177, 92]), '#e0b15c')
assert.equal(toHex([300, -5, 92.6]), '#ff005d') // clamped and rounded
assert.equal(triplet('#e0b15c'), '224, 177, 92')

assert.equal(shade('#e0b15c', 1), '#e0b15c')
assert.equal(shade('#ffffff', 0.5), '#808080')
assert.equal(shade('#000000', 0.5), '#000000')
// lightening pulls toward white, so an already-bright colour still moves
const lit = parseHex(shade('#e0b15c', 1.2))
assert.ok(lit.every((v, i) => v > parseHex('#e0b15c')[i]), 'lightening must raise every channel')
assert.equal(shade('#ffffff', 2), '#ffffff') // and stays in range

// --- every preset is complete ----------------------------------------------
for (const [id, p] of Object.entries(PRESETS)) {
  for (const k of ['label', 'bg', 'panel', 'accent', 'signal']) {
    assert.ok(p[k], `preset ${id} is missing ${k}`)
  }
  for (const k of ['bg', 'panel', 'accent', 'signal']) {
    assert.match(p[k], /^#[0-9a-f]{6}$/, `preset ${id}.${k} should be a full hex`)
  }
}
assert.ok(PRESETS[DEFAULT_PRESET])

// --- the stored scheme is normalised, never trusted -------------------------
store.clear()
assert.equal(loadTheme().preset, DEFAULT_PRESET)
assert.equal(loadTheme().accent, null)
store.set('atlas.theme.v1', '{ not json')
assert.equal(loadTheme().preset, DEFAULT_PRESET) // corrupt store must not break boot
saveTheme({ preset: 'no-such-scheme', accent: 'not-a-colour' })
assert.equal(loadTheme().preset, DEFAULT_PRESET)
assert.equal(loadTheme().accent, null)

// --- a custom accent overrides the preset's, and derives its own deep tone ---
saveTheme({ preset: 'cobalt', accent: null })
assert.equal(resolve().accent, PRESETS.cobalt.accent)
saveTheme({ preset: 'cobalt', accent: '#ff0000' })
const custom = resolve()
assert.equal(custom.accent, '#ff0000')
assert.equal(custom.bg, PRESETS.cobalt.bg) // the rest of the scheme is untouched
assert.equal(custom.accentDeep, shade('#ff0000', 0.72))
assert.notEqual(custom.accentDeep, custom.accent)

// --- every custom property the stylesheet reads gets a value ----------------
// These names are the contract with styles.css; a missing one is a corner of
// the app left on the old palette.
const REQUIRED = [
  '--bg', '--panel', '--ink', '--ink-dim', '--ink-faint',
  '--brass', '--brass-deep', '--signal',
  '--brass-rgb', '--ink-rgb', '--signal-rgb',
]
const vars = themeVars()
for (const k of REQUIRED) assert.ok(vars[k], `themeVars is missing ${k}`)
assert.equal(vars['--brass'], '#ff0000')
assert.equal(vars['--brass-rgb'], '255, 0, 0') // the alpha rules follow the accent
assert.equal(vars['--signal-rgb'], triplet(PRESETS.cobalt.signal))

// --- the logo is drawn from the same scheme ---------------------------------
const svg = logoSVG()
assert.ok(svg.includes('#ff0000'), 'the logo should use the custom accent')
assert.ok(svg.includes(PRESETS.cobalt.bg), 'the logo plate should use the scheme background')
assert.ok(!svg.includes('#e0b15c'), 'no default brass may survive in a recoloured logo')
assert.ok(!svg.includes('#b9863a'), 'no default deep brass either')
assert.match(svg, /^<svg[\s\S]+<\/svg>$/)
assert.ok(svg.includes('viewBox="0 0 1024 1024"'))

saveTheme({ preset: 'brass', accent: null })
const brassSvg = logoSVG()
assert.ok(brassSvg.includes('#e0b15c'), 'the default scheme still draws the brass logo')
assert.notEqual(brassSvg, svg)

// a data URL the browser and the icon rasteriser can both load
const url = logoDataURL()
assert.ok(url.startsWith('data:image/svg+xml;charset=utf-8,'))
assert.equal(decodeURIComponent(url.slice(url.indexOf(',') + 1)), brassSvg)
assert.ok(!/[<>"#]/.test(url.slice(url.indexOf(',') + 1)), 'raw #/<> would break the data URL')

console.log('theme.check: all assertions passed')
