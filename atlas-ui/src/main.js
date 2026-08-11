// Atlas entry gate — auth / hydrate / boot. Sits in front of renderer.js:
// decides between offline mode, a resumed session, or the login view, then
// hydrates localStorage from the sync backend and installs the write hook
// before the app shell loads.
import { sync } from './sync.js'
import { seedFreshPluginState } from './page/plugins.js'
import './auth.css'
import logoUrl from './assets/atlas-logo.svg'

const AUTH_KEY = 'atlas.auth.v1'
const SKIP_KEYS = [AUTH_KEY, 'atlas.devMode', 'atlas.backend']

// Captured before the hook wraps setItem: writes through this never sync.
const origSetItem = localStorage.setItem.bind(localStorage)

const readAuth = () => {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)) } catch { return null }
}

const asRaw = (v) => (typeof v === 'string' ? v : JSON.stringify(v))

// Server → localStorage, without triggering a push back to the server.
const applyStates = (states) => {
  for (const [key, value] of Object.entries(states || {})) {
    if (value == null) continue
    origSetItem(key, asRaw(value))
  }
}

const installHook = () => {
  // ponytail: removeItem/clear not hooked — deletions do not sync yet.
  localStorage.setItem = (k, v) => { origSetItem(k, v); sync.pushKey(k, v) }
}

// connect() retries forever when the server is down; race a deadline so an
// unreachable backend surfaces as a rejection instead of a hang.
const withTimeout = (promise, ms = 6000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('Sync server unreachable')), ms)),
])

// Live updates from other devices: write through the original setItem, then
// nudge the app. renderer.js exposes no global render on window, so we
// dispatch a CustomEvent instead ('atlas:sync-update').
sync.onUpdate((key, value) => {
  origSetItem(key, asRaw(value))
  window.dispatchEvent(new CustomEvent('atlas:sync-update', { detail: { key, value } }))
})

window.atlasLogout = async () => {
  try { await sync.request('auth.logout', {}) } catch {}
  localStorage.removeItem(AUTH_KEY)
  location.reload()
}

async function bootApp() {
  document.getElementById('auth-gate')?.remove()
  await import('./renderer.js')
}

const localAtlasKeys = () =>
  Object.keys(localStorage).filter((k) => k.startsWith('atlas.') && !SKIP_KEYS.includes(k))

// ---- login view ------------------------------------------------------------

function renderLogin({ warning } = {}) {
  document.getElementById('auth-gate')?.remove()
  const gate = document.createElement('div')
  gate.id = 'auth-gate'
  gate.className = 'auth-gate'
  gate.innerHTML = `
    <div class="auth-card">
      <img class="auth-card__logo" src="${logoUrl}" alt="" />
      <h1 class="auth-card__name">Atlas</h1>
      <p class="auth-card__tag">Sign in to sync your boards</p>
      ${warning ? `<p class="auth-warn">${warning}</p>` : ''}
      <form class="auth-form" novalidate>
        <label class="auth-label">Email
          <input class="auth-input" name="email" type="email" autocomplete="email" required />
        </label>
        <label class="auth-label">Password
          <input class="auth-input" name="password" type="password" autocomplete="current-password" required />
        </label>
        <p class="auth-error" hidden></p>
        <button type="submit" class="auth-submit">Sign in</button>
        <button type="button" class="auth-toggle">Need an account? Create one</button>
      </form>
      <button type="button" class="auth-offline${warning ? ' auth-offline--loud' : ''}">Continue offline</button>
    </div>`
  document.body.appendChild(gate)

  const form = gate.querySelector('.auth-form')
  const submitBtn = gate.querySelector('.auth-submit')
  const toggleBtn = gate.querySelector('.auth-toggle')
  const errorEl = gate.querySelector('.auth-error')
  let mode = 'login'

  const setError = (msg) => {
    errorEl.textContent = msg || ''
    errorEl.hidden = !msg
  }
  const setBusy = (busy, label) => {
    submitBtn.disabled = busy
    submitBtn.classList.toggle('is-busy', busy)
    submitBtn.textContent = label || (mode === 'login' ? 'Sign in' : 'Create account')
  }

  toggleBtn.addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login'
    setError('')
    setBusy(false)
    toggleBtn.textContent = mode === 'login'
      ? 'Need an account? Create one'
      : 'Have an account? Sign in'
    form.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password'
  })

  gate.querySelector('.auth-offline').addEventListener('click', async () => {
    origSetItem(AUTH_KEY, JSON.stringify({ offline: true }))
    await bootApp()
  })

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const email = form.email.value.trim()
    const password = form.password.value
    if (!email || !password) { setError('Email and password are required.'); return }
    setError('')
    setBusy(true, mode === 'login' ? 'Signing in…' : 'Creating account…')
    try {
      if (sync.status !== 'online') await withTimeout(sync.connect())
      const data = await sync.request(mode === 'login' ? 'auth.login' : 'auth.signup', { email, password })
      origSetItem(AUTH_KEY, JSON.stringify({
        token: data.token,
        userId: data.userId,
        email: data.email || email,
      }))
      await sync.connect({ token: data.token }) // opens the outbox socket
      await postLoginHydrate(gate, mode === 'signup')
    } catch (err) {
      setError(err?.message || 'Sign in failed.')
      setBusy(false)
    }
  })
}

// After a fresh login: empty profile + existing local data → offer an import;
// otherwise adopt the server's states. `isNewAccount` is true only for signup,
// and decides whether this profile starts with no plugins enabled.
async function postLoginHydrate(gate, isNewAccount) {
  const states = await sync.pullAll()
  const serverEmpty = Object.values(states || {}).every((v) => v == null)
  const localKeys = localAtlasKeys()

  if (serverEmpty && localKeys.length) {
    await renderImportCard(gate, localKeys, isNewAccount)
    return
  }
  applyStates(states)
  installHook()
  // After the hook, so the empty registry syncs to this account's other devices.
  if (isNewAccount) seedFreshPluginState()
  await bootApp()
}

function renderImportCard(gate, localKeys, isNewAccount) {
  return new Promise((resolve) => {
    const card = gate.querySelector('.auth-card')
    card.innerHTML = `
      <img class="auth-card__logo" src="${logoUrl}" alt="" />
      <h1 class="auth-card__name">Atlas</h1>
      <p class="auth-card__tag">This browser has existing Atlas data (${localKeys.length} item${localKeys.length === 1 ? '' : 's'}). Import it into your profile?</p>
      <p class="auth-error" hidden></p>
      <button type="button" class="auth-submit" data-act="import">Import everything</button>
      <button type="button" class="auth-toggle" data-act="fresh">Start fresh</button>`
    const errorEl = card.querySelector('.auth-error')
    const importBtn = card.querySelector('[data-act="import"]')
    const freshBtn = card.querySelector('[data-act="fresh"]')

    // seedFresh=false on "Import everything": the user is carrying a whole
    // pre-plugin profile across, so the legacy migration should light up the
    // plugins that own the data they just imported — otherwise it would all
    // land invisible. "Start fresh" takes the empty registry.
    const finish = async (seedFresh) => {
      installHook()
      if (seedFresh) seedFreshPluginState()
      await bootApp()
      resolve()
    }

    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true
      freshBtn.disabled = true
      importBtn.classList.add('is-busy')
      importBtn.textContent = 'Importing…'
      errorEl.hidden = true
      try {
        const map = {}
        for (const key of localKeys) map[key] = localStorage.getItem(key)
        await sync.importAll(map)
        await finish(false)
      } catch (err) {
        importBtn.disabled = false
        freshBtn.disabled = false
        importBtn.classList.remove('is-busy')
        importBtn.textContent = 'Import everything'
        errorEl.textContent = err?.message || 'Import failed.'
        errorEl.hidden = false
      }
    })

    freshBtn.addEventListener('click', () => finish(isNewAccount))
  })
}

// ---- boot ------------------------------------------------------------------

const auth = readAuth()

if (auth?.offline) {
  await bootApp()
} else if (auth?.token) {
  try {
    const res = await withTimeout(sync.connect({ token: auth.token }))
    if (res?.ok) {
      applyStates(await sync.pullAll())
      installHook()
      await bootApp()
    } else {
      // Server answered but rejected the session — sign in again.
      localStorage.removeItem(AUTH_KEY)
      renderLogin()
    }
  } catch {
    // Server unreachable — never block the user from their local data.
    renderLogin({ warning: 'Could not reach the sync server. Sign in later, or continue offline with your local data.' })
  }
} else {
  renderLogin()
}
