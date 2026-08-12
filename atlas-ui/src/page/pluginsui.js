// Settings → Plugins: the enable/disable list + the zip drop zone. Logic and
// state live in plugins.js; this renders into the global Settings page.

import { PLUGIN_DEFS, loadPlugins, setPluginEnabled, removeInstalled, installPluginZip } from './plugins.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// A card per plugin, on a grid that fits the page rather than a list you scroll
// past. The whole card is the switch — at this size a separate toggle is a
// smaller target than the thing containing it.
export function pluginsSettingsHTML() {
  const s = loadPlugins()
  const cards = PLUGIN_DEFS.map((p) => {
    const on = !!s.enabled[p.id]
    const inst = s.installed[p.id]
    return `<button type="button" class="plug-card${on ? ' is-on' : ''}" data-plug-toggle="${p.id}"
            role="switch" aria-checked="${on}" aria-label="${esc(p.name)}">
      <span class="plug-card__top">
        <span class="plug-card__name">${esc(p.name)}</span>
        <span class="switch${on ? ' is-on' : ''}" aria-hidden="true"><span class="switch__dot"></span></span>
      </span>
      <span class="plug-card__desc">${esc(p.description)}</span>
      <span class="plug-card__foot">
        ${inst ? `<span class="plug-badge" title="Installed from a zip">zip · v${esc(inst.version)}</span>` : ''}
        ${inst ? `<span class="plug-card__rm" data-plug-remove="${p.id}" role="button" tabindex="0"
                   title="Remove the installed zip (your data stays)">Remove</span>` : ''}
      </span>
    </button>`
  }).join('')
  return `<div class="plug-head">
    <span class="set-row__name">Plugins</span>
    <span class="set-row__sub">Turn Atlas features on or off. Disabling hides a plugin's pages and widgets — its data stays and comes back when re-enabled.</span>
  </div>
  <div class="plug-grid">
    ${cards}
    <div class="plug-drop plug-drop--card" id="plugin-drop" role="button" tabindex="0"
      title="Install a plugin from a .zip">
      <span class="plug-drop__big">Drop a plugin .zip</span>
      <span class="plug-drop__sub">or click to browse</span>
    </div>
  </div>
  <input type="file" id="plugin-file" accept=".zip,application/zip" hidden>
  <p class="set-row__sub plug-status" id="plugin-status" role="status"></p>`
}

const status = (msg, isErr) => {
  const el = document.getElementById('plugin-status')
  if (el) { el.textContent = msg; el.classList.toggle('is-err', !!isErr) }
}

let rerenderApp = null
let onEnableCb = null

async function install(file) {
  if (!file) return
  try {
    const m = await installPluginZip(file)
    onEnableCb?.() // seed the plugin's starter board if it never had one
    rerenderApp?.()
    status(`Installed ${m.name} v${m.version} — enabled.`)
  } catch (e) {
    status(e.message, true)
  }
}

export function bindPlugins(rerender, onEnable) {
  rerenderApp = rerender
  onEnableCb = onEnable

  document.body.addEventListener('click', (e) => {
    // Remove sits INSIDE the card, and the card is the toggle — so it has to be
    // checked first or removing would also flip the plugin.
    const rm = e.target.closest('[data-plug-remove]')
    if (rm) {
      e.stopPropagation()
      removeInstalled(rm.dataset.plugRemove)
      rerenderApp?.()
      status('Removed. Its data is still on this device — re-enable any time.')
      return
    }
    const t = e.target.closest('[data-plug-toggle]')
    if (t) {
      const on = !loadPlugins().enabled[t.dataset.plugToggle]
      setPluginEnabled(t.dataset.plugToggle, on)
      if (on) onEnableCb?.()
      rerenderApp?.()
      return
    }
    if (e.target.closest('#plugin-drop')) document.getElementById('plugin-file')?.click()
  })

  document.body.addEventListener('change', (e) => {
    if (e.target.id !== 'plugin-file' || !e.target.files?.length) return
    install(e.target.files[0])
    e.target.value = '' // same file can be re-picked after a fix
  })

  // The drop zone is focusable + role=button — make Enter/Space actually work.
  document.body.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('#plugin-drop')) {
      e.preventDefault()
      document.getElementById('plugin-file')?.click()
    }
  })

  // A file dropped a few pixels OUTSIDE the zone must not hit the browser
  // default (navigating the tab to the file, killing the app mid-session).
  // Guard file drags at the window level; the zone's own handlers run first.
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  })
  window.addEventListener('drop', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  })

  // Drag-and-drop: dragover must be cancelled or the browser navigates to the file.
  document.body.addEventListener('dragover', (e) => {
    const zone = e.target.closest?.('#plugin-drop')
    if (!zone) return
    e.preventDefault()
    zone.classList.add('is-over')
  })
  document.body.addEventListener('dragleave', (e) => {
    e.target.closest?.('#plugin-drop')?.classList.remove('is-over')
  })
  document.body.addEventListener('drop', (e) => {
    const zone = e.target.closest?.('#plugin-drop')
    if (!zone) return
    e.preventDefault()
    zone.classList.remove('is-over')
    install(e.dataTransfer?.files?.[0])
  })
}
