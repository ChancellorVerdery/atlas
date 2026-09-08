// Colour scheme — one place the whole app takes its palette from.
//
// Everything visual reads CSS custom properties, so a scheme is just a set of
// values written onto :root. The logo is drawn from the same values (it's built
// here as SVG rather than shipped as a fixed file), which is what lets the app
// icon follow the scheme too — the desktop shell rasterises this SVG and hands
// it to the dock.
//
// Stored in atlas.theme.v1, so it rides the normal sync path to every device.

const KEY = 'atlas.theme.v1'

// The ink ramp is shared: it's the readable-text scale, and re-tuning contrast
// per scheme is a good way to ship an unreadable one. Schemes vary the surface
// they sit on and the accent that picks things out.
//
// Two ramps, one per mode. `rgb` is the one that matters most: dozens of rules
// wash the foreground over the surface at low alpha (hovers, hairlines, active
// rows). Flipping that triplet is what makes those rules darken on a light
// surface instead of vanishing — one variable instead of ~90 rewritten rules.
const MODES = {
  dark: { ink: '#e9e7df', inkDim: '#9aa0ad', inkFaint: '#5c616e', rgb: '202, 214, 242' },
  light: { ink: '#161a21', inkDim: '#535a68', inkFaint: '#858c9b', rgb: '22, 26, 33' },
}
// 'auto' by default: a fresh profile should look like the rest of the user's
// device rather than picking a side. Everything downstream still resolves this
// to a real dark|light through effectiveMode(), so nothing else changes.
export const DEFAULT_MODE = 'auto'

// 'auto' isn't a palette — it's a pointer at the OS setting (iOS/macOS
// appearance), resolved to a real MODES key on every read so everything
// downstream keeps seeing only dark|light.
export const AUTO_MODE = 'auto'
const systemMode = () =>
  (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) ? 'light' : 'dark'
export const isModeChoice = (m) => m === AUTO_MODE || !!MODES[m]
// Always a real MODES key, never the 'auto' pointer — that is this function's
// whole contract. The fallback has to resolve too: DEFAULT_MODE is itself
// 'auto' now, so returning it raw would hand 'auto' to callers that only
// understand dark|light (colorScheme, the MODES lookup, the logo).
export const effectiveMode = (m) => {
  const choice = isModeChoice(m) ? m : DEFAULT_MODE
  return choice === AUTO_MODE ? systemMode() : choice
}

// Each scheme brings its own surfaces for BOTH modes — a light mode doesn't
// have to be white any more than a dark one has to be black, and a tinted
// ground (Rose's papyrus, Moss's raw linen) is what stops eight schemes from
// collapsing into one off-white page with different buttons on it.
//
// pos/neg are the money colours (and every other up/down in the app). They stay
// opposed — one cool, one warm — but not always green/red: on Rose, red reads as
// part of the palette rather than as a loss, so it shifts to teal vs deep coral.
export const PRESETS = {
  brass: {
    label: 'Brass', accent: '#e0b15c', signal: '#74d6c4', pos: '#5fd08a', neg: '#e08c8c',
    dark: { bg: '#090b11', panel: '#0e1219' }, light: { bg: '#f6f2e8', panel: '#fffdf7' },
  },
  cobalt: {
    label: 'Cobalt', accent: '#6aa8ff', signal: '#7de0c8', pos: '#5fd08a', neg: '#ef7d7d',
    dark: { bg: '#080b14', panel: '#0d1220' }, light: { bg: '#eef2f8', panel: '#ffffff' },
  },
  emerald: {
    label: 'Emerald', accent: '#5fd08a', signal: '#8ec9f0', pos: '#7ad6a0', neg: '#e58f7d',
    dark: { bg: '#08110d', panel: '#0d1a14' }, light: { bg: '#edf3ee', panel: '#fbfffb' },
  },
  rose: {
    label: 'Rose', accent: '#f08a9b', signal: '#8ab6f0', pos: '#6fc3b8', neg: '#c4566b',
    dark: { bg: '#110a0e', panel: '#1a1016' }, light: { bg: '#f7efe6', panel: '#fffaf3' },
  },
  violet: {
    label: 'Violet', accent: '#b28cf0', signal: '#7de0c8', pos: '#79d0b0', neg: '#e0708f',
    dark: { bg: '#0c0912', panel: '#13101f' }, light: { bg: '#f2eff7', panel: '#fdfbff' },
  },
  slate: {
    label: 'Slate', accent: '#cad6f2', signal: '#9fb3d9', pos: '#86c9a4', neg: '#d98f92',
    dark: { bg: '#0a0c10', panel: '#10141b' }, light: { bg: '#f1f2f4', panel: '#ffffff' },
  },
  ember: {
    label: 'Ember', accent: '#f0894f', signal: '#f0c463', pos: '#8fc98a', neg: '#d95f5f',
    dark: { bg: '#120b08', panel: '#1b110c' }, light: { bg: '#f8efe6', panel: '#fffaf4' },
  },
  moss: {
    label: 'Moss', accent: '#a8c060', signal: '#7fc9a8', pos: '#86c060', neg: '#d98a6a',
    dark: { bg: '#0d1008', panel: '#141810' }, light: { bg: '#f2f2e4', panel: '#fbfcf2' },
  },
}
export const DEFAULT_PRESET = 'brass'

// ---- colour maths (pure) ----------------------------------------------------

const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)))

// '#rgb' | '#rrggbb' -> [r, g, b]. Anything unparseable falls back to the
// default accent rather than throwing: a corrupt stored colour must not take
// the whole app down at boot.
export function parseHex(hex) {
  const s = String(hex || '').trim().replace(/^#/, '')
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return parseHex(PRESETS[DEFAULT_PRESET].accent)
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}

export const toHex = (rgb) => '#' + rgb.map((n) => clamp(n).toString(16).padStart(2, '0')).join('')
export const triplet = (hex) => parseHex(hex).join(', ')

// Scale towards black (f < 1) or white (f > 1). Lightening pulls toward 255 so
// a bright accent still moves — plain multiplication saturates and does nothing.
export function shade(hex, f) {
  const rgb = parseHex(hex)
  return toHex(f <= 1 ? rgb.map((c) => c * f) : rgb.map((c) => c + (255 - c) * (f - 1)))
}

// Relative luminance / contrast ratio (WCAG). Here because a scheme is only
// worth applying if you can still read the app afterwards — and a custom accent
// can be any colour at all.
const luminance = (hex) => {
  const [r, g, b] = parseHex(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Nudge a colour until it stands out against the surface it sits on. A fixed
// shift can't do this: Slate's accent is nearly white, so darkening it "a bit"
// for light mode still left it at 2.4:1. Colours that already pass come back
// untouched.
//
// The direction has to come from the PAIR, not the background: near-black text
// on a mid-tone accent is already on the dark side, and the rule "dark surface
// → lighten" would drag it up through the accent and make it worse (4.45:1 →
// 3.23:1, which is how this was found).
// Walking both ways and keeping the better end also covers the colours that
// can't move the "obvious" way at all — a white accent on a pale surface has to
// go DOWN, and there's no lighter white to reach for.
export function legible(hex, bg, target = 3.2) {
  const start = toHex(parseHex(hex))
  if (contrast(start, bg) >= target) return start
  const walk = (step) => {
    let c = start
    for (let i = 0; i < 24 && contrast(c, bg) < target; i++) c = shade(c, step)
    return c
  }
  const up = walk(1.12), down = walk(0.88)
  return contrast(up, bg) >= contrast(down, bg) ? up : down
}

// Text drawn ON the accent (primary buttons, today's date). Take whichever ink
// contrasts better and push it until it's comfortably readable — a luminance
// cutoff alone gets this wrong in the middle of the range, where brass in light
// mode landed at 3.75:1.
export function onAccent(accent) {
  const [dark, light] = ['#14100a', '#f7f5ef']
  const pick = contrast(dark, accent) >= contrast(light, accent) ? dark : light
  return legible(pick, accent, 4.5)
}

// ---- the scheme -------------------------------------------------------------

export const CUSTOM = 'custom'
// The colours a custom scheme owns — both modes' surfaces, so a custom scheme
// is a real scheme rather than an accent sitting on someone else's. Everything
// else (deep tones, text-on-accent, the ink ramp, hairlines) stays derived and
// contrast-checked, which is what keeps a hand-picked palette usable.
export const CUSTOM_KEYS = [
  ['accent', 'Accent', 'Buttons, links, the logo'],
  ['signal', 'Highlight', 'Secondary emphasis'],
  ['pos', 'Gain', 'Money in, streaks, ahead'],
  ['neg', 'Loss', 'Money out, late, behind'],
  ['darkBg', 'Dark background', 'The page in dark mode'],
  ['darkPanel', 'Dark surface', 'Cards and panels'],
  ['lightBg', 'Light background', 'The page in light mode'],
  ['lightPanel', 'Light surface', 'Cards and panels'],
]

const isHex = (v) => typeof v === 'string' && /^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(v)

export function loadTheme() {
  let t
  try { t = JSON.parse(localStorage.getItem(KEY)) || {} } catch { t = {} }
  // Earlier shape: a preset plus a single accent override. Fold it into a
  // custom scheme so nobody's colour survives as a key nothing reads.
  if (isHex(t.accent) && !t.custom) {
    t.custom = { ...customFrom(PRESETS[t.preset] || PRESETS[DEFAULT_PRESET]), accent: t.accent }
    t.preset = CUSTOM
  }
  delete t.accent
  if (t.preset !== CUSTOM && !PRESETS[t.preset]) t.preset = DEFAULT_PRESET
  if (!isModeChoice(t.mode)) t.mode = DEFAULT_MODE
  t.custom = normaliseCustom(t.custom)
  return t
}
export function saveTheme(t) { localStorage.setItem(KEY, JSON.stringify(t)) }

// A scheme (preset shape) flattened into the custom shape, and back again.
const customFrom = (p) => ({
  accent: p.accent, signal: p.signal, pos: p.pos, neg: p.neg,
  darkBg: p.dark.bg, darkPanel: p.dark.panel,
  lightBg: p.light.bg, lightPanel: p.light.panel,
})
const schemeFromCustom = (c) => ({
  label: 'Custom', accent: c.accent, signal: c.signal, pos: c.pos, neg: c.neg,
  dark: { bg: c.darkBg, panel: c.darkPanel },
  light: { bg: c.lightBg, panel: c.lightPanel },
})

// A custom scheme is only as trustworthy as what was typed into it: any key
// that isn't a colour falls back to the default scheme's, so a half-written
// one still renders.
function normaliseCustom(c) {
  const base = customFrom(PRESETS[DEFAULT_PRESET])
  return Object.fromEntries(CUSTOM_KEYS.map(([k]) => [k, toHex(parseHex(isHex(c?.[k]) ? c[k] : base[k]))]))
}

// Seed a custom scheme from the scheme in use — both modes, so opening Custom
// from Rose starts on papyrus, not on some default white.
export const customSeed = (t = loadTheme()) =>
  customFrom(t.preset === CUSTOM ? schemeFromCustom(normaliseCustom(t.custom)) : (PRESETS[t.preset] || PRESETS[DEFAULT_PRESET]))

export function resolve(t = loadTheme()) {
  const p = t.preset === CUSTOM ? schemeFromCustom(normaliseCustom(t.custom)) : (PRESETS[t.preset] || PRESETS[DEFAULT_PRESET])
  const mode = effectiveMode(t.mode) // 'auto' follows the OS appearance
  const m = MODES[mode]
  const { bg, panel } = p[mode]
  return {
    label: p.label,
    mode, bg, panel,
    // The ink ramp is checked against THIS scheme's ground, not a nominal one:
    // a fixed faint tone tuned for #f4f3ef drops to 2.96:1 on Rose's papyrus.
    ink: legible(m.ink, bg, 7),
    inkDim: legible(m.inkDim, bg, 4.5),
    inkFaint: legible(m.inkFaint, bg, 3.2),
    inkRgb: m.rgb,
    // Every colour that lands on the background is checked against it — a
    // scheme the user chose shouldn't be able to hide its own text.
    accent: legible(p.accent, bg),
    signal: legible(p.signal, bg),
    pos: legible(p.pos, bg),
    neg: legible(p.neg, bg),
    accentDeep: shade(legible(p.accent, bg), 0.72),
  }
}

// Every custom property the stylesheet reads. The -rgb triplets exist because
// dozens of rules need the accent at partial alpha, and rgba() can't take a hex
// var — without them a scheme would only reach half the app.
export function themeVars(t = loadTheme()) {
  const c = resolve(t)
  return {
    '--bg': c.bg,
    '--panel': c.panel,
    '--ink': c.ink,
    '--ink-dim': c.inkDim,
    '--ink-faint': c.inkFaint,
    '--brass': c.accent,
    '--brass-deep': c.accentDeep,
    '--signal': c.signal,
    '--brass-rgb': triplet(c.accent),
    '--ink-rgb': c.inkRgb,
    '--signal-rgb': triplet(c.signal),
    '--on-accent': onAccent(c.accent),
    // Semantic up/down. Every plugin reads these — finance amounts, Canvas
    // late/dropped, the calendar's now-line — so they move with the scheme
    // instead of each page hardcoding its own red.
    '--pos': c.pos,
    '--neg': c.neg,
    '--pos-rgb': triplet(c.pos),
    '--neg-rgb': triplet(c.neg),
    // --line/--line-2 are left to the stylesheet: they derive from --ink-rgb,
    // which is set here, so they follow without being restated.
  }
}

// ---- reading and picking colours -------------------------------------------

// hsl -> hex. Also the wheel's model: angle is hue, radius is saturation.
export function hslToHex(h, s, l) {
  const H = ((h % 360) + 360) % 360, S = Math.max(0, Math.min(1, s)), L = Math.max(0, Math.min(1, l))
  const c = (1 - Math.abs(2 * L - 1)) * S
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1))
  const m = L - c / 2
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(H / 60) % 6]
  return toHex(seg.map((v) => (v + m) * 255))
}

export function hexToHsl(hex) {
  const [r, g, b] = parseHex(hex).map((v) => v / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  const l = (max + min) / 2
  if (!d) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4)
  return { h: ((h % 360) + 360) % 360, s, l }
}

// The tint/shade slider: -1 is fully shaded (black), +1 fully tinted (white),
// 0 is the colour as picked off the wheel.
export const tintShade = (hex, t) => {
  const rgb = parseHex(hex)
  const k = Math.abs(t)
  return toHex(rgb.map((c) => (t >= 0 ? c + (255 - c) * k : c * (1 - k))))
}

// Accept whatever the user pastes. The three formats worth parsing by hand are
// handled here so this stays testable without a DOM; anything else valid CSS
// (named colours, oklch, color()) is handed to the browser, which already has a
// complete parser — no point shipping a second one.
export function parseColor(input) {
  const s = String(input ?? '').trim()
  if (!s) return null
  if (/^#?[0-9a-f]{3}$/i.test(s) || /^#?[0-9a-f]{6}$/i.test(s)) return toHex(parseHex(s))
  if (/^#?[0-9a-f]{8}$/i.test(s)) return toHex(parseHex(s.replace(/^#/, '').slice(0, 6))) // drop alpha
  const nums = (body) => body.split(/[,\s/]+/).filter(Boolean)
  const rgbM = s.match(/^rgba?\(([^)]+)\)$/i)
  if (rgbM) {
    const p = nums(rgbM[1]).slice(0, 3)
      .map((v) => (v.endsWith('%') ? (parseFloat(v) / 100) * 255 : parseFloat(v)))
    if (p.length === 3 && p.every((n) => Number.isFinite(n))) return toHex(p)
  }
  const hslM = s.match(/^hsla?\(([^)]+)\)$/i)
  if (hslM) {
    const p = nums(hslM[1]).slice(0, 3).map(parseFloat)
    if (p.length === 3 && p.every((n) => Number.isFinite(n))) return hslToHex(p[0], p[1] / 100, p[2] / 100)
  }
  if (typeof document === 'undefined') return null
  const el = document.createElement('span')
  el.style.color = ''
  el.style.color = s
  if (!el.style.color) return null // the browser rejected it — not a colour
  document.body.appendChild(el)
  const computed = getComputedStyle(el).color
  el.remove()
  const m = computed.match(/[\d.]+/g)
  return m && m.length >= 3 ? toHex(m.slice(0, 3).map(Number)) : null
}

// ---- the logo ---------------------------------------------------------------

// The windrose, drawn from the scheme. Same artwork as the old static file —
// it just takes its colours from `c` now, so the mark, the plate it sits on and
// the app icon can never drift apart.
export function logoSVG(t = loadTheme()) {
  const c = resolve(t)
  const hi = shade(c.accent, 1.14)
  const low = shade(c.accent, 0.62)
  const plate = c.bg // flat, and exactly --bg: the icon reads as the app's own surface
  const light = c.mode === 'light'
  // The hub is a hole punched in the plate, so it steps away from it — down on
  // a light plate, up on a dark one.
  const hub = shade(c.bg, light ? 0.9 : 1.9)
  const edge = light ? '#000000' : '#ffffff'
  const edgeOpacity = light ? 0.10 : 0.06
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="brass" gradientUnits="userSpaceOnUse" x1="512" y1="200" x2="512" y2="824">
      <stop offset="0" stop-color="${hi}"/>
      <stop offset="0.55" stop-color="${c.accent}"/>
      <stop offset="1" stop-color="${c.accentDeep}"/>
    </linearGradient>
    <path id="ray" d="M 0 -400 57.6 -57.6 400 0 57.6 57.6 0 400 -57.6 57.6 -400 0 -57.6 -57.6 Z"/>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="${plate}"/>
  <rect x="66.5" y="66.5" width="891" height="891" rx="198" fill="none"
        stroke="${edge}" stroke-opacity="${edgeOpacity}" stroke-width="5"/>
  <g transform="translate(512 512)" fill="none" stroke="url(#brass)" stroke-linejoin="round">
    <circle r="312" stroke-width="9" opacity="0.30"/>
    <circle r="232" stroke-width="7" opacity="0.20"/>
    <use href="#ray" transform="rotate(45) scale(0.60)"
         fill="url(#brass)" fill-opacity="0.45" stroke="${c.accentDeep}" stroke-width="6"/>
    <use href="#ray"
         fill="url(#brass)" fill-opacity="0.95" stroke="${low}" stroke-width="6"/>
    <circle r="58" fill="${hub}" stroke="url(#brass)" stroke-width="11"/>
    <circle r="20" fill="url(#brass)" stroke="none"/>
  </g>
</svg>`
}

// encodeURIComponent, not base64: keeps it readable in devtools and avoids
// pulling in btoa's unicode caveats. Both are valid data URLs.
export const logoDataURL = (t = loadTheme()) =>
  'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(logoSVG(t))

// ---- applying it ------------------------------------------------------------

// Draw the logo at icon size and hand the PNG to the desktop shell, which owns
// the dock icon. In a browser the endpoint isn't mounted — the failure is
// expected and silent.
function rasterize(url, size = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const cv = document.createElement('canvas')
      cv.width = cv.height = size
      cv.getContext('2d').drawImage(img, 0, 0, size, size)
      resolve(cv.toDataURL('image/png'))
    }
    img.onerror = () => reject(new Error('could not rasterise the logo'))
    img.src = url
  })
}

export async function pushAppIcon(t = loadTheme()) {
  try {
    const png = await rasterize(logoDataURL(t))
    await fetch('/local/icon', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ png }),
    })
  } catch { /* browser, or no shell listening */ }
}

// `icon: false` while dragging the colour picker — that fires continuously, and
// each icon push is a rasterise plus a round trip. The commit sends it.
export function applyTheme(t = loadTheme(), { icon = true } = {}) {
  const root = document.documentElement
  for (const [k, v] of Object.entries(themeVars(t))) root.style.setProperty(k, v)
  // Native controls (selects, checkboxes, scrollbars, date pickers) follow this
  // and nothing else — without it a light app keeps dark dropdowns.
  const { mode } = resolve(t)
  root.style.colorScheme = mode
  root.dataset.mode = mode
  const url = logoDataURL(t)
  for (const el of document.querySelectorAll('link[rel="icon"]')) el.href = url
  for (const el of document.querySelectorAll('.brand__img, .auth-card__logo, .set-theme__logo')) el.src = url
  if (icon) pushAppIcon(t)
  return t
}

// Repaint when the OS appearance flips, but only while the user is on 'auto'.
if (typeof window !== 'undefined' && window.matchMedia) {
  window.matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', () => { if (loadTheme().mode === AUTO_MODE) applyTheme() })
}
