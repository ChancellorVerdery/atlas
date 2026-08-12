// The Custom scheme editor. A modal, not an inline row: picking eight colours
// needs a wheel, a slider and a text field, and that is a workspace rather than
// a settings control.
//
// Everything previews live on the app behind the modal — the point of a scheme
// is how it looks on real pages, not in a swatch. Cancel puts back what was
// there when it opened.
import {
  CUSTOM, CUSTOM_KEYS, loadTheme, saveTheme, applyTheme, customSeed,
  parseColor, hexToHsl, hslToHex, tintShade, toHex, parseHex,
} from './theme.js'

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const WHEEL = 188 // px; the picker canvas is square

// The hue/saturation disc, drawn once per open. Hue is the angle, saturation
// the radius, both at full lightness — the tint/shade slider owns the third
// axis, which is what keeps the wheel readable.
function drawWheel(cv) {
  const r = WHEEL / 2
  const ctx = cv.getContext('2d')
  const img = ctx.createImageData(WHEEL, WHEEL)
  for (let y = 0; y < WHEEL; y++) {
    for (let x = 0; x < WHEEL; x++) {
      const dx = x - r, dy = y - r
      const dist = Math.sqrt(dx * dx + dy * dy)
      const i = (y * WHEEL + x) * 4
      if (dist > r) { img.data[i + 3] = 0; continue }
      const hue = (Math.atan2(dy, dx) * 180) / Math.PI + 90
      const [rr, gg, bb] = parseHex(hslToHex(hue, Math.min(1, dist / r), 0.5))
      img.data[i] = rr; img.data[i + 1] = gg; img.data[i + 2] = bb
      // feather the rim so the disc doesn't alias into a cog
      img.data[i + 3] = dist > r - 1.5 ? 255 * (r - dist) / 1.5 : 255
    }
  }
  ctx.putImageData(img, 0, 0)
}

const wheelPos = (hex) => {
  const { h, s } = hexToHsl(hex)
  const r = WHEEL / 2
  const a = ((h - 90) * Math.PI) / 180
  return { x: r + Math.cos(a) * s * r, y: r + Math.sin(a) * s * r }
}

// One editor state: which slot is being edited, and the hue/sat + tint/shade
// that produce its colour. Kept out of the store until Done.
let ui = null

export function openThemeModal(openModal, closeModal, rerender) {
  const before = loadTheme()
  ui = {
    key: CUSTOM_KEYS[0][0],
    colours: customSeed(before),
    mode: before.mode,
    tint: 0,
  }

  openModal('Custom colour scheme', `
    <div class="tm">
      <div class="tm__slots" id="tm-slots"></div>
      <div class="tm__pick">
        <canvas class="tm__wheel" id="tm-wheel" width="${WHEEL}" height="${WHEEL}"></canvas>
        <div class="tm__controls">
          <label class="tm__slider">
            <span>Shade</span>
            <input type="range" id="tm-tint" min="-90" max="90" value="0" step="1" aria-label="Shade to tint">
            <span>Tint</span>
          </label>
          <div class="tm__inputs">
            <input type="color" id="tm-hex" aria-label="Colour picker">
            <input type="text" id="tm-code" class="pw-field" spellcheck="false"
                   placeholder="#e0b15c, rgb(224 177 92), hsl(38 68% 62%)…" aria-label="Colour code">
          </div>
          <p class="tm__note" id="tm-note">Any CSS colour works — hex, rgb, hsl, or a name.</p>
        </div>
      </div>
      <div class="tm__foot">
        <span class="tm__hint">Previewing live behind this window.</span>
        <button type="button" class="gym-btn gym-btn--ghost" data-tm="cancel">Cancel</button>
        <button type="button" class="gym-btn" data-tm="done">Use this scheme</button>
      </div>
    </div>`)

  const root = document.getElementById('app-modal')
  if (!root) return
  const $ = (id) => root.querySelector('#' + id)
  drawWheel($('tm-wheel'))

  const preview = () => {
    const t = loadTheme()
    applyTheme({ ...t, preset: CUSTOM, custom: ui.colours, mode: ui.mode }, { icon: false })
  }

  const renderSlots = () => {
    $('tm-slots').innerHTML = CUSTOM_KEYS.map(([k, label, hint]) => `
      <button type="button" class="tm__slot${ui.key === k ? ' is-on' : ''}" data-tm-key="${k}" title="${esc(hint)}">
        <span class="tm__chip" style="background:${esc(ui.colours[k])}"></span>
        <span class="tm__slotname">${esc(label)}</span>
        <span class="tm__slothex">${esc(ui.colours[k])}</span>
      </button>`).join('')
  }

  const syncControls = () => {
    const hex = ui.colours[ui.key]
    $('tm-hex').value = hex
    $('tm-code').value = hex
    $('tm-tint').value = String(Math.round(ui.tint * 100))
    const dot = root.querySelector('.tm__dot')
    const { x, y } = wheelPos(hex)
    dot.style.left = `${x}px`
    dot.style.top = `${y}px`
    dot.style.background = hex
  }

  const set = (hex, { fromWheel = false } = {}) => {
    ui.colours = { ...ui.colours, [ui.key]: hex }
    if (fromWheel) ui.tint = 0
    // Editing a surface shows the mode it belongs to, so you're never tuning a
    // colour you can't see.
    const wantMode = ui.key.startsWith('light') ? 'light' : ui.key.startsWith('dark') ? 'dark' : ui.mode
    ui.mode = wantMode
    renderSlots()
    syncControls()
    preview()
  }

  // the wheel's selection dot lives on top of the canvas
  const dot = document.createElement('span')
  dot.className = 'tm__dot'
  $('tm-wheel').parentElement.appendChild(dot)

  let base = ui.colours[ui.key] // the wheel colour before tint/shade

  const pickFromWheel = (e) => {
    const cv = $('tm-wheel')
    const r = cv.getBoundingClientRect()
    const x = e.clientX - r.left - WHEEL / 2, y = e.clientY - r.top - WHEEL / 2
    const dist = Math.min(Math.sqrt(x * x + y * y), WHEEL / 2)
    const hue = (Math.atan2(y, x) * 180) / Math.PI + 90
    base = hslToHex(hue, dist / (WHEEL / 2), 0.5)
    set(base, { fromWheel: true })
  }

  $('tm-wheel').addEventListener('pointerdown', (e) => {
    e.preventDefault()
    $('tm-wheel').setPointerCapture(e.pointerId)
    pickFromWheel(e)
    const move = (ev) => pickFromWheel(ev)
    const up = () => { $('tm-wheel').removeEventListener('pointermove', move); document.removeEventListener('pointerup', up) }
    $('tm-wheel').addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
  })

  $('tm-tint').addEventListener('input', (e) => {
    ui.tint = Number(e.target.value) / 100
    set(tintShade(base, ui.tint))
  })

  $('tm-hex').addEventListener('input', (e) => { base = e.target.value; set(base, { fromWheel: true }) })

  $('tm-code').addEventListener('input', (e) => {
    const hex = parseColor(e.target.value)
    const note = $('tm-note')
    if (!hex) {
      note.textContent = e.target.value.trim() ? 'Not a colour Atlas recognises.' : 'Any CSS colour works — hex, rgb, hsl, or a name.'
      note.classList.toggle('is-bad', !!e.target.value.trim())
      return
    }
    note.textContent = `Read as ${hex}`
    note.classList.remove('is-bad')
    base = hex
    ui.colours = { ...ui.colours, [ui.key]: hex }
    ui.tint = 0
    renderSlots()
    const d = root.querySelector('.tm__dot')
    const p = wheelPos(hex)
    d.style.left = `${p.x}px`; d.style.top = `${p.y}px`; d.style.background = hex
    $('tm-hex').value = hex
    preview()
  })

  root.addEventListener('click', (e) => {
    const slot = e.target.closest('[data-tm-key]')
    if (slot) {
      ui.key = slot.dataset.tmKey
      base = ui.colours[ui.key]
      ui.tint = 0
      set(base)
      return
    }
    const act = e.target.closest('[data-tm]')
    if (!act) return
    if (act.dataset.tm === 'cancel') {
      applyTheme(before) // put back exactly what was there
      closeModal()
      rerender()
      return
    }
    const t = loadTheme()
    t.preset = CUSTOM
    t.custom = ui.colours
    t.mode = ui.mode
    saveTheme(t)
    applyTheme(t) // the committing apply — this one repaints the app icon
    closeModal()
    rerender()
  })

  renderSlots()
  syncControls()
  preview()
}
