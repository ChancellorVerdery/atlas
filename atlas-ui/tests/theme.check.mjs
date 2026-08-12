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
  PRESETS, DEFAULT_PRESET, DEFAULT_MODE, CUSTOM, CUSTOM_KEYS, customSeed,
  parseHex, toHex, triplet, shade,
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
assert.equal(loadTheme().mode, DEFAULT_MODE)
store.set('atlas.theme.v1', '{ not json')
assert.equal(loadTheme().preset, DEFAULT_PRESET) // corrupt store must not break boot
saveTheme({ preset: 'no-such-scheme', mode: 'sepia' })
assert.equal(loadTheme().preset, DEFAULT_PRESET)
assert.equal(loadTheme().mode, DEFAULT_MODE)
// an unknown scheme still yields a complete custom palette to fall back on
for (const [k] of CUSTOM_KEYS) assert.match(loadTheme().custom[k], /^#[0-9a-f]{6}$/)

// --- a custom scheme owns its colours; presets are untouched ----------------
saveTheme({ preset: 'cobalt' })
assert.equal(resolve().accent, PRESETS.cobalt.accent)
assert.equal(resolve().mode, DEFAULT_MODE)

// picking Custom starts from what's on screen, not from some default palette
const seeded = customSeed(loadTheme())
assert.deepEqual(Object.keys(seeded).sort(), CUSTOM_KEYS.map(([k]) => k).sort())
assert.equal(seeded.accent, PRESETS.cobalt.accent)
assert.equal(seeded.bg, PRESETS.cobalt.bg)

saveTheme({ preset: CUSTOM, custom: { ...seeded, accent: '#ff0000' } })
const custom = resolve()
assert.equal(custom.accent, '#ff0000')
assert.equal(custom.bg, PRESETS.cobalt.bg) // the seeded surfaces carried over
assert.equal(custom.accentDeep, shade('#ff0000', 0.72))
assert.notEqual(custom.accentDeep, custom.accent)
assert.equal(themeVars()['--brass-rgb'], '255, 0, 0')

// a half-written custom scheme still renders: bad keys fall back, not throw
saveTheme({ preset: CUSTOM, custom: { accent: '#00ff00', bg: 'oops' } })
assert.equal(resolve().accent, '#00ff00')
assert.equal(resolve().bg, PRESETS[DEFAULT_PRESET].bg)

// the old shape (a preset + a lone accent) becomes a custom scheme
store.set('atlas.theme.v1', JSON.stringify({ preset: 'emerald', accent: '#123456' }))
const migrated = loadTheme()
assert.equal(migrated.preset, CUSTOM)
assert.equal(migrated.custom.accent, '#123456')
assert.equal(migrated.custom.bg, PRESETS.emerald.bg)
assert.equal(migrated.accent, undefined) // the dead key is gone, not just ignored

// --- light mode: its own surfaces and ink, the scheme's accent --------------
// Contrast is the thing that actually breaks when a dark-designed app flips,
// so measure it rather than eyeball it. WCAG AA body text is 4.5:1.
const lum = (hex) => {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
assert.ok(contrast('#000000', '#ffffff') > 20.9) // the maths itself is right
assert.ok(contrast('#777777', '#777777') === 1)

for (const id of Object.keys(PRESETS)) {
  for (const mode of ['dark', 'light']) {
    saveTheme({ preset: id, mode })
    const c = resolve()
    assert.equal(c.mode, mode)
    assert.ok(contrast(c.ink, c.bg) >= 4.5, `${id}/${mode}: body text is ${contrast(c.ink, c.bg).toFixed(2)}:1`)
    assert.ok(contrast(c.ink, c.panel) >= 4.5, `${id}/${mode}: text on panels is too low`)
    assert.ok(contrast(c.inkDim, c.bg) >= 3, `${id}/${mode}: dimmed text is too low`)
    assert.ok(contrast(c.accent, c.bg) >= 3, `${id}/${mode}: the accent is ${contrast(c.accent, c.bg).toFixed(2)}:1`)
    // primary buttons: the label sits on the accent itself
    const onAccent = themeVars()['--on-accent']
    assert.ok(contrast(onAccent, c.accent) >= 4.5,
      `${id}/${mode}: button text on the accent is ${contrast(onAccent, c.accent).toFixed(2)}:1`)
  }
}

// …and for an arbitrary custom accent, not just the six we chose
for (const accent of ['#ffffff', '#000000', '#ff0000', '#0000ff', '#ffff00', '#7a7a7a']) {
  for (const mode of ['dark', 'light']) {
    saveTheme({ preset: CUSTOM, mode, custom: { bg: '#090b11', panel: '#0e1219', accent, signal: accent } })
    const c = resolve()
    assert.ok(contrast(c.accent, c.bg) >= 3, `custom ${accent}/${mode}: accent only ${contrast(c.accent, c.bg).toFixed(2)}:1`)
    assert.ok(contrast(themeVars()['--on-accent'], c.accent) >= 4.5, `custom ${accent}/${mode}: unreadable button text`)
  }
}

// light mode inverts the wash used by hairlines and hovers — without this a
// light surface gets light-on-light lines, i.e. no visible structure
saveTheme({ preset: 'brass', mode: 'light' })
const lightVars = themeVars()
saveTheme({ preset: 'brass', mode: 'dark' })
const darkVars = themeVars()
assert.notEqual(lightVars['--ink-rgb'], darkVars['--ink-rgb'])
assert.ok(lum(toHex(lightVars['--ink-rgb'].split(', ').map(Number))) < 0.1, 'light mode washes with a DARK ink')
assert.ok(lum(toHex(darkVars['--ink-rgb'].split(', ').map(Number))) > 0.5, 'dark mode washes with a LIGHT ink')
assert.notEqual(lightVars['--bg'], darkVars['--bg'])

// --- every custom property the stylesheet reads gets a value ----------------
// These names are the contract with styles.css; a missing one is a corner of
// the app left on the old palette.
const REQUIRED = [
  '--bg', '--panel', '--ink', '--ink-dim', '--ink-faint',
  '--brass', '--brass-deep', '--signal',
  '--brass-rgb', '--ink-rgb', '--signal-rgb', '--on-accent',
]
saveTheme({ // this block owns its state — the mode sweep above changed it
  preset: CUSTOM, mode: 'dark',
  custom: { bg: PRESETS.cobalt.bg, panel: PRESETS.cobalt.panel, accent: '#ff0000', signal: PRESETS.cobalt.signal },
})
const vars = themeVars()
for (const k of REQUIRED) assert.ok(vars[k], `themeVars is missing ${k}`)
assert.equal(vars['--brass'], '#ff0000')
assert.equal(vars['--brass-rgb'], '255, 0, 0') // the alpha rules follow the accent
assert.equal(vars['--signal-rgb'], triplet(PRESETS.cobalt.signal))

// --- the logo is drawn from the same scheme ---------------------------------
const svg = logoSVG()
assert.ok(svg.includes('#ff0000'), 'the logo should use the custom accent')

// The plate is flat and exactly the app background — no gradient, no glow, so
// the icon reads as the same surface the app is painted on.
assert.match(svg, new RegExp(`<rect[^>]*rx="200" fill="${PRESETS.cobalt.bg}"`))
assert.ok(!/<linearGradient id="bg"/.test(svg), 'the plate must not be a gradient')
assert.ok(!/radialGradient|id="glow"/.test(svg), 'no glow wash over the plate')
assert.equal((svg.match(/<linearGradient/g) || []).length, 1) // only the mark's own shading remains
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
