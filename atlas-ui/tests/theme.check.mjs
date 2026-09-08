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
  PRESETS, DEFAULT_PRESET, DEFAULT_MODE, AUTO_MODE, effectiveMode, CUSTOM, CUSTOM_KEYS, customSeed,
  parseHex, toHex, triplet, shade,
  parseColor, hexToHsl, hslToHex, tintShade,
  loadTheme, saveTheme, resolve, themeVars, logoSVG, logoDataURL,
} = await import('../src/page/theme.js')

// how far apart two colours are on the hue circle (0-180)
const hueGap = (a, b) => {
  const d = Math.abs(hexToHsl(a).h - hexToHsl(b).h) % 360
  return d > 180 ? 360 - d : d
}

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
assert.equal(Object.keys(PRESETS).length, 8) // eight schemes; Custom is the ninth choice
for (const [id, p] of Object.entries(PRESETS)) {
  for (const k of ['label', 'accent', 'signal', 'pos', 'neg']) assert.ok(p[k], `preset ${id} is missing ${k}`)
  for (const k of ['accent', 'signal', 'pos', 'neg']) {
    assert.match(p[k], /^#[0-9a-f]{6}$/, `preset ${id}.${k} should be a full hex`)
  }
  // every scheme brings its own surfaces for BOTH modes
  for (const mode of ['dark', 'light']) {
    for (const k of ['bg', 'panel']) {
      assert.match(p[mode][k], /^#[0-9a-f]{6}$/, `preset ${id}.${mode}.${k} should be a full hex`)
    }
  }
  // a light mode that is merely white, or a dark one merely black, would make
  // the eight schemes interchangeable
  assert.notEqual(p.dark.bg, p.light.bg)
}
assert.ok(PRESETS[DEFAULT_PRESET])

// A fresh profile follows the device, and 'auto' is a pointer rather than a
// palette: everything downstream must still see a real dark|light.
assert.equal(DEFAULT_MODE, AUTO_MODE)
assert.ok(['dark', 'light'].includes(effectiveMode(AUTO_MODE)))
assert.equal(effectiveMode('light'), 'light')
assert.equal(effectiveMode('dark'), 'dark')
assert.equal(effectiveMode('sepia'), effectiveMode(DEFAULT_MODE)) // unknown falls back

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
assert.equal(resolve().mode, effectiveMode(DEFAULT_MODE))

// picking Custom starts from what's on screen, not from some default palette
const seeded = customSeed(loadTheme())
assert.deepEqual(Object.keys(seeded).sort(), CUSTOM_KEYS.map(([k]) => k).sort())
assert.equal(seeded.accent, PRESETS.cobalt.accent)
// seeded from BOTH modes, so opening Custom on Rose starts on papyrus
assert.equal(seeded.darkBg, PRESETS.cobalt.dark.bg)
assert.equal(seeded.lightBg, PRESETS.cobalt.light.bg)
assert.equal(seeded.pos, PRESETS.cobalt.pos)

saveTheme({ preset: CUSTOM, custom: { ...seeded, accent: '#ff0000' } })
const custom = resolve()
assert.equal(custom.accent, '#ff0000')
assert.equal(custom.bg, PRESETS.cobalt.dark.bg) // the seeded surfaces carried over
assert.equal(custom.accentDeep, shade('#ff0000', 0.72))
assert.notEqual(custom.accentDeep, custom.accent)
assert.equal(themeVars()['--brass-rgb'], '255, 0, 0')
saveTheme({ preset: CUSTOM, mode: 'light', custom: { ...seeded, accent: '#ff0000' } })
assert.equal(resolve().bg, PRESETS.cobalt.light.bg) // …in both modes

// a half-written custom scheme still renders: bad keys fall back, not throw
saveTheme({ preset: CUSTOM, custom: { accent: '#00ff00', darkBg: 'oops' } })
assert.equal(resolve().accent, '#00ff00')
assert.equal(resolve().bg, PRESETS[DEFAULT_PRESET].dark.bg)

// the old shape (a preset + a lone accent) becomes a custom scheme
store.set('atlas.theme.v1', JSON.stringify({ preset: 'emerald', accent: '#123456' }))
const migrated = loadTheme()
assert.equal(migrated.preset, CUSTOM)
assert.equal(migrated.custom.accent, '#123456')
assert.equal(migrated.custom.darkBg, PRESETS.emerald.dark.bg)
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
    assert.ok(contrast(c.inkDim, c.bg) >= 4.5, `${id}/${mode}: dimmed text is ${contrast(c.inkDim, c.bg).toFixed(2)}:1`)
    // the faint tone is real UI text (hints, drop zones, the mode chips), and a
    // ramp fixed for one ground dips below on a tinted one
    assert.ok(contrast(c.inkFaint, c.bg) >= 3, `${id}/${mode}: faint text is ${contrast(c.inkFaint, c.bg).toFixed(2)}:1`)
    assert.ok(contrast(c.accent, c.bg) >= 3, `${id}/${mode}: the accent is ${contrast(c.accent, c.bg).toFixed(2)}:1`)
    // the money colours have to read on the scheme's own ground, and stay
    // distinguishable from each other — a scheme where gain and loss look alike
    // is worse than one that just kept green and red
    assert.ok(contrast(c.pos, c.bg) >= 3, `${id}/${mode}: gain is ${contrast(c.pos, c.bg).toFixed(2)}:1`)
    assert.ok(contrast(c.neg, c.bg) >= 3, `${id}/${mode}: loss is ${contrast(c.neg, c.bg).toFixed(2)}:1`)
    assert.ok(hueGap(c.pos, c.neg) >= 45, `${id}/${mode}: gain and loss are only ${hueGap(c.pos, c.neg).toFixed(0)}° apart`)
    // primary buttons: the label sits on the accent itself
    const onAccent = themeVars()['--on-accent']
    assert.ok(contrast(onAccent, c.accent) >= 4.5,
      `${id}/${mode}: button text on the accent is ${contrast(onAccent, c.accent).toFixed(2)}:1`)
  }
}

// …and for an arbitrary custom accent, not just the six we chose
for (const accent of ['#ffffff', '#000000', '#ff0000', '#0000ff', '#ffff00', '#7a7a7a']) {
  for (const mode of ['dark', 'light']) {
    saveTheme({ preset: CUSTOM, mode, custom: { accent, signal: accent, pos: accent, neg: accent } })
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
  custom: { ...customSeed({ preset: 'cobalt', mode: 'dark' }), accent: '#ff0000' },
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
assert.match(svg, new RegExp(`<rect[^>]*rx="200" fill="${PRESETS.cobalt.dark.bg}"`))
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

// --- reading a colour the user typed ----------------------------------------
// The formats worth parsing by hand, so this works with no DOM at all.
assert.equal(parseColor('#e0b15c'), '#e0b15c')
assert.equal(parseColor('e0b15c'), '#e0b15c')
assert.equal(parseColor('  #ABC  '), '#aabbcc')
assert.equal(parseColor('#e0b15cff'), '#e0b15c') // alpha dropped, not rejected
assert.equal(parseColor('rgb(224, 177, 92)'), '#e0b15c')
assert.equal(parseColor('rgb(224 177 92)'), '#e0b15c') // modern space syntax
assert.equal(parseColor('rgba(224, 177, 92, 0.5)'), '#e0b15c')
assert.equal(parseColor('RGB(100%, 0%, 0%)'), '#ff0000')
assert.equal(parseColor('hsl(0, 100%, 50%)'), '#ff0000')
assert.equal(parseColor('hsl(120 100% 25%)'), '#008000')
assert.equal(parseColor('hsla(240, 100%, 50%, .3)'), '#0000ff')
assert.equal(parseColor(''), null)
assert.equal(parseColor('   '), null)
assert.equal(parseColor(null), null)
assert.equal(parseColor('#ff00'), null) // not a hex length that means anything
assert.equal(parseColor('rgb(1, 2)'), null) // too few channels
// named colours need the browser's parser; with no DOM this reports "unknown"
// rather than guessing, which is what the modal's message keys off
assert.equal(parseColor('rebeccapurple'), null)

// --- hue/lightness maths the wheel and slider run on ------------------------
assert.equal(hslToHex(0, 1, 0.5), '#ff0000')
assert.equal(hslToHex(120, 1, 0.25), '#008000')
assert.equal(hslToHex(0, 0, 1), '#ffffff')
assert.equal(hslToHex(-40, 1, 0.5), hslToHex(320, 1, 0.5)) // angles wrap
for (const hex of ['#e0b15c', '#6aa8ff', '#123456', '#ffffff', '#000000', '#7f7f7f']) {
  const { h, s, l } = hexToHsl(hex)
  assert.equal(hslToHex(h, s, l), hex, `${hex} should survive a hsl round trip`)
}

// tint/shade: 0 is untouched, the ends are white and black
assert.equal(tintShade('#e0b15c', 0), '#e0b15c')
assert.equal(tintShade('#e0b15c', 1), '#ffffff')
assert.equal(tintShade('#e0b15c', -1), '#000000')
assert.ok(lum(tintShade('#e0b15c', 0.4)) > lum('#e0b15c'))
assert.ok(lum(tintShade('#e0b15c', -0.4)) < lum('#e0b15c'))

// --- the semantic pair is exposed to the stylesheet -------------------------
saveTheme({ preset: 'rose', mode: 'light' })
const rose = themeVars()
for (const k of ['--pos', '--neg', '--pos-rgb', '--neg-rgb']) assert.ok(rose[k], `themeVars is missing ${k}`)
assert.equal(rose['--pos-rgb'], triplet(rose['--pos']))
// Rose's money colours are its own, not the default green/red
assert.notEqual(rose['--neg'], PRESETS.brass.neg)

console.log('theme.check: colour parsing, wheel maths and semantics all covered')
