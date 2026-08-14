// Reusable confirm-delete modal. Gym/chart/calendar overlays all reuse the
// #app-modal id and remove any existing one — so this modal must NOT share
// that id (it would rip out the modal underneath, and cancelling would leave
// nothing). It uses its own id + a higher z-index and layers on top.
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let closeActive = null // resolves the currently-open confirm (false) if a new one opens

// opts: { title, confirmLabel = 'Delete', danger = true }
export async function confirmDelete(message, opts = {}) {
  closeActive?.() // an already-open confirm resolves false before this one opens
  document.getElementById('confirm-overlay')?.remove()

  const o = document.createElement('div')
  o.className = 'modal-overlay confirm-overlay'
  o.id = 'confirm-overlay'
  o.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
    <h2 class="modal__title">${esc(opts.title || 'Are you sure?')}</h2>
    <div class="modal__body">${esc(message)}</div>
    <div class="modal__actions">
      <button type="button" class="btn-cancel">Cancel</button>
      <button type="button" class="${opts.danger === false ? 'btn-primary' : 'btn-danger'}">${esc(opts.confirmLabel || 'Delete')}</button>
    </div>
  </div>`
  document.body.appendChild(o)

  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      o.remove()
      document.removeEventListener('keydown', onKey, true)
      if (closeActive === cancel) closeActive = null
      resolve(result)
    }
    const cancel = () => finish(false)
    closeActive = cancel
    // Capture phase + stopImmediatePropagation so Escape dismisses ONLY this
    // confirm, never an Escape-closable modal (gym/chart/calendar) beneath it.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); finish(false) } }
    o.addEventListener('click', (e) => { if (e.target === o) finish(false) })
    o.querySelector('.btn-cancel').addEventListener('click', () => finish(false))
    o.querySelector(opts.danger === false ? '.btn-primary' : '.btn-danger').addEventListener('click', () => finish(true))
    document.addEventListener('keydown', onKey, true)
  })
}
