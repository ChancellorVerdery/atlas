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
// Which account the Atlas data cached in this browser belongs to. Deliberately
// NOT an 'atlas.' key: sync's pushKey, the import map, and the backup export
// all filter on that prefix, so this stays device-local by construction — and
// unlike AUTH_KEY it survives logout, which is when it has to answer "is the
// cache sitting here still yours?".
const LAST_USER_KEY = 'atlasLastUser'

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

// The server owns a profile; localStorage is only this device's cache of it.
// That cache is per-account, so opening a DIFFERENT account here must not
// inherit the previous one's keys — they would render as the new account's
// data, and the write hook would then upload them into it.
//
// No record = a browser from before this shipped, so assume the cache is the
// current user's: wiping on a guess would destroy local data that was never
// pushed (offline edits, a pre-sync profile). Same user is always a merge for
// the same reason — the server returns null both for "never saved" and for
// "plugin service unreachable" (backend lib/runner.js), so absence there can
// never be read as a deletion.
// ponytail: identity check only. Genuine per-key deletions still don't sync —
// the wire has no delete op, only page.save upserts; add one if it bites.
const isForeignAccount = (userId) => {
  const prev = localStorage.getItem(LAST_USER_KEY)
  return !!(prev && userId && prev !== userId)
}
const rememberAccount = (userId) => { if (userId) localStorage.setItem(LAST_USER_KEY, userId) }
const clearLocalAtlas = () => { for (const k of localAtlasKeys()) localStorage.removeItem(k) }

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
      await postLoginHydrate(gate, mode === 'signup', data.userId)
    } catch (err) {
      setError(err?.message || 'Sign in failed.')
      setBusy(false)
    }
  })
}

// After a fresh login: empty profile + existing local data → offer an import;
// otherwise adopt the server's states. `isNewAccount` is true only for signup,
// and decides whether this profile starts with no plugins enabled.
async function postLoginHydrate(gate, isNewAccount, userId) {
  const states = await sync.pullAll()
  const serverEmpty = Object.values(states || {}).every((v) => v == null)
  const foreign = isForeignAccount(userId)
  const localKeys = foreign ? [] : localAtlasKeys()

  // Only ever offer to carry up data this browser holds on the current user's
  // behalf. Another account's cache isn't theirs to import, so it's dropped
  // rather than offered — otherwise the prompt reads as "upload someone else's
  // profile into yours?".
  if (serverEmpty && localKeys.length) {
    rememberAccount(userId)
    await renderImportCard(gate, localKeys)
    return
  }
  if (foreign) clearLocalAtlas()
  rememberAccount(userId)
  applyStates(states)
  installHook()
  // After the hook, so the empty registry syncs to this account's other devices.
  if (isNewAccount) seedFreshPluginState()
  await bootApp()
}

function renderImportCard(gate, localKeys) {
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
    // land invisible. Nothing is cleared there: the local keys were just
    // uploaded, so the cache already matches the server.
    const finish = async (seedFresh) => {
      installHook()
      if (seedFresh) seedFreshPluginState()
      await bootApp()
      resolve()
    }

    // "Start fresh" has to mean it. The server holds nothing for this account,
    // so the cache must match: left in place, the old profile stays live here
    // and the write hook uploads it into the account on the next edit.
    const startFresh = async () => {
      clearLocalAtlas()
      await finish(true)
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

    freshBtn.addEventListener('click', startFresh)
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
      const userId = res.userId || auth.userId
      // Resuming a session, so a mismatch means a stale cache from whoever used
      // this browser before — drop it before the pull rather than merging it in.
      if (isForeignAccount(userId)) clearLocalAtlas()
      rememberAccount(userId)
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
