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
  dark: {
    ink: '#e9e7df', inkDim: '#9aa0ad', inkFaint: '#5c616e',
    rgb: '202, 214, 242',
  },
  light: {
    // Surfaces come from the mode, not the scheme: a scheme's dark background
    // is meaningless here, and the accent is what carries its identity.
    bg: '#f4f3ef', panel: '#ffffff',
    ink: '#161a21', inkDim: '#535a68', inkFaint: '#858c9b',
    rgb: '22, 26, 33',
  },
}
export const DEFAULT_MODE = 'dark'

export const PRESETS = {
  brass: { label: 'Brass', bg: '#090b11', panel: '#0e1219', accent: '#e0b15c', signal: '#74d6c4' },
  cobalt: { label: 'Cobalt', bg: '#080b14', panel: '#0d1220', accent: '#6aa8ff', signal: '#7de0c8' },
  emerald: { label: 'Emerald', bg: '#08110d', panel: '#0d1a14', accent: '#5fd08a', signal: '#8ec9f0' },
  rose: { label: 'Rose', bg: '#110a0e', panel: '#1a1016', accent: '#f08a9b', signal: '#8ab6f0' },
  violet: { label: 'Violet', bg: '#0c0912', panel: '#13101f', accent: '#b28cf0', signal: '#7de0c8' },
  slate: { label: 'Slate', bg: '#0a0c10', panel: '#10141b', accent: '#cad6f2', signal: '#9fb3d9' },
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
// The colours a custom scheme owns. Everything else (the ink ramp, every
// derived tone) still falls out of these.
export const CUSTOM_KEYS = [
  ['bg', 'Background'],
  ['panel', 'Surface'],
  ['accent', 'Accent'],
  ['signal', 'Highlight'],
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
  if (!MODES[t.mode]) t.mode = DEFAULT_MODE
  t.custom = normaliseCustom(t.custom)
  return t
}
export function saveTheme(t) { localStorage.setItem(KEY, JSON.stringify(t)) }

const customFrom = (p) => Object.fromEntries(CUSTOM_KEYS.map(([k]) => [k, p[k]]))

// A custom scheme is only as trustworthy as what was typed into it: any key
// that isn't a colour falls back to the default scheme's, so a half-written
// one still renders.
function normaliseCustom(c) {
  const base = PRESETS[DEFAULT_PRESET]
  return Object.fromEntries(CUSTOM_KEYS.map(([k]) => [k, toHex(parseHex(isHex(c?.[k]) ? c[k] : base[k]))]))
}

// Seed a custom scheme from whatever is on screen, so picking "Custom" starts
// where the user already is rather than from an arbitrary palette.
export const customSeed = (t = loadTheme()) => customFrom(resolve(t))

export function resolve(t = loadTheme()) {
  const p = t.preset === CUSTOM ? { label: 'Custom', ...normaliseCustom(t.custom) } : (PRESETS[t.preset] || PRESETS[DEFAULT_PRESET])
  const m = MODES[t.mode] || MODES[DEFAULT_MODE]
  const bg = m.bg || p.bg
  const accent = legible(p.accent, bg)
  const signal = legible(p.signal, bg)
  return {
    ...p,
    mode: MODES[t.mode] ? t.mode : DEFAULT_MODE,
    bg,
    panel: m.panel || p.panel,
    ink: m.ink, inkDim: m.inkDim, inkFaint: m.inkFaint, inkRgb: m.rgb,
    accent, signal, accentDeep: shade(accent, 0.72),
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
    // --line/--line-2 are left to the stylesheet: they derive from --ink-rgb,
    // which is set here, so they follow without being restated.
  }
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
