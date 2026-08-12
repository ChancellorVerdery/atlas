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
const INK = '#e9e7df', INK_DIM = '#9aa0ad', INK_FAINT = '#5c616e'

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

// ---- the scheme -------------------------------------------------------------

export function loadTheme() {
  let t
  try { t = JSON.parse(localStorage.getItem(KEY)) || {} } catch { t = {} }
  if (!PRESETS[t.preset]) t.preset = DEFAULT_PRESET
  if (typeof t.accent !== 'string' || !/^#?[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(t.accent)) t.accent = null
  return t
}
export function saveTheme(t) { localStorage.setItem(KEY, JSON.stringify(t)) }

// The resolved palette: a preset, with the custom accent (if any) on top.
export function resolve(t = loadTheme()) {
  const p = PRESETS[t.preset] || PRESETS[DEFAULT_PRESET]
  const accent = t.accent ? toHex(parseHex(t.accent)) : p.accent
  return { ...p, accent, accentDeep: shade(accent, 0.72) }
}

// Every custom property the stylesheet reads. The -rgb triplets exist because
// dozens of rules need the accent at partial alpha, and rgba() can't take a hex
// var — without them a scheme would only reach half the app.
export function themeVars(t = loadTheme()) {
  const c = resolve(t)
  return {
    '--bg': c.bg,
    '--panel': c.panel,
    '--ink': INK,
    '--ink-dim': INK_DIM,
    '--ink-faint': INK_FAINT,
    '--brass': c.accent,
    '--brass-deep': c.accentDeep,
    '--signal': c.signal,
    '--brass-rgb': triplet(c.accent),
    '--ink-rgb': '202, 214, 242',
    '--signal-rgb': triplet(c.signal),
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
  const plateTop = shade(c.panel, 1.75)
  const hub = shade(c.bg, 1.9)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${plateTop}"/>
      <stop offset="1" stop-color="${c.bg}"/>
    </linearGradient>
    <linearGradient id="brass" gradientUnits="userSpaceOnUse" x1="512" y1="200" x2="512" y2="824">
      <stop offset="0" stop-color="${hi}"/>
      <stop offset="0.55" stop-color="${c.accent}"/>
      <stop offset="1" stop-color="${c.accentDeep}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.42" r="0.6">
      <stop offset="0" stop-color="${c.accent}" stop-opacity="0.30"/>
      <stop offset="1" stop-color="${c.accent}" stop-opacity="0"/>
    </radialGradient>
    <path id="ray" d="M 0 -400 57.6 -57.6 400 0 57.6 57.6 0 400 -57.6 57.6 -400 0 -57.6 -57.6 Z"/>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#bg)"/>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#glow)"/>
  <rect x="66.5" y="66.5" width="891" height="891" rx="198" fill="none"
        stroke="#ffffff" stroke-opacity="0.06" stroke-width="5"/>
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
  const url = logoDataURL(t)
  for (const el of document.querySelectorAll('link[rel="icon"]')) el.href = url
  for (const el of document.querySelectorAll('.brand__img, .auth-card__logo, .set-theme__logo')) el.src = url
  if (icon) pushAppIcon(t)
  return t
}
