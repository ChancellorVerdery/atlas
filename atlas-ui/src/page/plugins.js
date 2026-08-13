// Plugin registry + state. Base Atlas is login + settings + dashboard; every
// other page/widget belongs to a plugin that can be enabled, disabled, or
// installed from a .zip in Settings → Plugins.
//
// A plugin zip carries a plugin.json manifest (format 1) + the plugin's
// source. Today every plugin's code already ships inside the app bundle, so
// installing a zip just registers + enables it; a zip whose id Atlas doesn't
// know is rejected until the plugin API exists.
// ponytail: manifest carries format+entry so API-era zips (format 1 + entry
// module, dynamically imported) install through this same path later.

const KEY = 'atlas.plugins.v1'

// ---- registry ---------------------------------------------------------------
// id === the page id in pages.js. Order here is the Settings list order.
export const PLUGIN_DEFS = [
  { id: 'calendar', name: 'Calendar', description: 'Google Calendar — month + agenda views, event editor, dashboard widgets' },
  { id: 'canvas', name: 'Canvas', description: 'Canvas LMS — grades, assignments, announcements, GPA' },
  { id: 'course', name: 'Course Planner', description: 'Degree planner — semesters, prerequisites, route map' },
  { id: 'email', name: 'Email', description: 'Gmail — inbox, compose, pins, multiple accounts' },
  { id: 'equations', name: 'Equations', description: 'LaTeX equation cards and formula sheets' },
  { id: 'gym', name: 'Gym', description: 'Workouts, set logging, strength scores, volume' },
  { id: 'ladder', name: 'Ladder', description: 'Day planner — classes, shifts, sleep, and drive times on one timeline' },
  { id: 'notes', name: 'Notes', description: 'Apple Notes browser + markdown conversion' },
  { id: 'sleep', name: 'Sleep', description: 'Sleep log, debt tracking, bedtime guidance' },
  { id: 'study', name: 'Study', description: 'Tutor chat, question bank, flashcards per course' },
  { id: 'work', name: 'Work', description: 'Shifts, tips, income tracking, tip share' },
]
export const pluginDef = (id) => PLUGIN_DEFS.find((p) => p.id === id)

// Widget kind → owning plugin. Core kinds (dashboard dev widgets) map to null.
export const KIND_PLUGIN = {
  card: null, list: null, graph: null,
  eqcard: 'equations', eqlist: 'equations',
  gymcurrent: 'gym', gymnext: 'gym', gymscore: 'gym', gymscoregraph: 'gym', gymexercises: 'gym', gymvolume: 'gym',
  calagenda: 'calendar', calmonth: 'calendar',
  cvgradebook: 'canvas', cvupcoming: 'canvas', cvannounce: 'canvas', cvoverdue: 'canvas', cvgpa: 'canvas', cvsemesters: 'canvas', cvcourses: 'canvas', cvtodo: 'canvas',
  wkincome: 'work', wkshifts: 'work', wkhistory: 'work', wktipshare: 'work', wkupcoming: 'work',
  slbedtime: 'sleep', sllog: 'sleep', slhours: 'sleep', sldebt: 'sleep',
}

// ---- state ------------------------------------------------------------------
// { enabled: {id: bool}, installed: {id: {name, version, source, installedAt}} }
// Rides sync's raw page.save path automatically (any atlas.* key), so enabling
// a plugin on one device enables it everywhere.

// Existing installs predate the registry: any legacy Atlas key present means
// this user was running the everything-built-in era — enable it all once,
// and they can trim in Settings. A truly fresh install has none of these
// (this runs after main.js hydrates from the backend, so a second device
// pulls the registry rather than re-migrating). Every plugin store + board
// key counts — a profile that only ever used Canvas/Finance must not read
// as fresh. devMode counts too: it predates the registry and marks a dev
// profile, never a brand-new user.
const LEGACY_EVIDENCE = [
  'atlas.page.v1', 'atlas.devMode', 'atlas.work.upseeded',
  'atlas.calendar.v1', 'atlas.canvas.v1', 'atlas.course.v1', 'atlas.email.v1',
  'atlas.gym.v1', 'atlas.ladder.v1', 'atlas.notes.v1',
  'atlas.sleep.v1', 'atlas.study.v1', 'atlas.work.v1',
  'atlas.page.gym.v1', 'atlas.page.canvas.v1', 'atlas.page.work.v1',
  'atlas.page.sleep.v1', 'atlas.page.equations.v1',
]

export function loadPlugins() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) } catch { s = null }
  if (!s || typeof s !== 'object') {
    s = { enabled: {}, installed: {} }
    if (LEGACY_EVIDENCE.some((k) => localStorage.getItem(k) !== null)) {
      for (const p of PLUGIN_DEFS) s.enabled[p.id] = true
    }
    // Persist even the fresh all-off default: the migration must be one-shot.
    // Left unwritten, the evidence check re-runs on every load, and ordinary
    // base-app writes (the dashboard board, the Google-status cache that the
    // boot refresh saves) would later read as "legacy" and silently enable
    // all 14 plugins on a genuinely fresh account.
    savePlugins(s)
  }
  if (!s.enabled || typeof s.enabled !== 'object') s.enabled = {}
  if (!s.installed || typeof s.installed !== 'object') s.installed = {}
  return s
}
export function savePlugins(s) { localStorage.setItem(KEY, JSON.stringify(s)) }

// A brand-new account starts with every plugin OFF, whatever leftover Atlas
// data this browser happens to hold. Called at signup (main.js): writing the
// registry up front is what stops loadPlugins' legacy-evidence migration from
// firing on someone else's data that merely shares the browser.
export function seedFreshPluginState() {
  savePlugins({ enabled: {}, installed: {} })
}

export const isPluginEnabled = (id) => !!loadPlugins().enabled[id]
// A widget kind renders only while its plugin is on; core kinds always do.
export const isKindEnabled = (kind, s = loadPlugins()) => {
  const owner = KIND_PLUGIN[kind]
  return owner == null ? true : !!s.enabled[owner]
}

export function setPluginEnabled(id, on) {
  const s = loadPlugins()
  s.enabled[id] = !!on
  savePlugins(s)
}

export function removeInstalled(id) {
  const s = loadPlugins()
  delete s.installed[id]
  s.enabled[id] = false // data stays; only the plugin's UI goes away
  savePlugins(s)
}

// ---- zip reading (vanilla — DecompressionStream, no library) ------------------

const u16 = (b, o) => b[o] | (b[o + 1] << 8)
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw')
  const ab = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer()
  return new Uint8Array(ab)
}

// ArrayBuffer → Map<path, Uint8Array>. Understands stored + deflated entries;
// rejects encrypted and zip64 archives (plugin zips are tiny).
export async function parseZip(buf) {
  const b = new Uint8Array(buf)
  // End-of-central-directory: scan back over the (≤64K) comment for PK\5\6.
  // A candidate only counts when its comment-length field reaches exactly the
  // end of the file — otherwise those 4 bytes sitting INSIDE a real archive
  // comment would be mistaken for the record and garbage offsets read out.
  let eocd = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06
      && i + 22 + u16(b, i + 20) === b.length) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = u16(b, eocd + 10)
  let off = u32(b, eocd + 16)
  if (off === 0xffffffff) throw new Error('zip64 archives are not supported')

  const entries = new Map()
  const dec = new TextDecoder()
  for (let n = 0; n < count; n++) {
    if (u32(b, off) !== 0x02014b50) throw new Error('corrupt zip (bad central directory)')
    const flags = u16(b, off + 8)
    const method = u16(b, off + 10)
    const csize = u32(b, off + 20)
    const nameLen = u16(b, off + 28), extraLen = u16(b, off + 30), commentLen = u16(b, off + 32)
    const localOff = u32(b, off + 42)
    const name = dec.decode(b.subarray(off + 46, off + 46 + nameLen))
    off += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue // directory entry
    if (flags & 0x1) throw new Error('encrypted zips are not supported')
    if (method !== 0 && method !== 8) throw new Error(`unsupported compression (method ${method})`)
    // sizes in the LOCAL header may be zeroed (data-descriptor flag) — the
    // central directory's csize is authoritative, so read lengths from there
    const lNameLen = u16(b, localOff + 26), lExtraLen = u16(b, localOff + 28)
    const start = localOff + 30 + lNameLen + lExtraLen
    const raw = b.subarray(start, start + csize)
    entries.set(name, method === 0 ? raw : await inflateRaw(raw))
  }
  return entries
}

// ---- manifest + install -------------------------------------------------------

export function validateManifest(m) {
  if (!m || typeof m !== 'object') return 'plugin.json is not an object'
  if (m.format !== 1) return `unsupported manifest format ${JSON.stringify(m.format)} — this Atlas speaks format 1`
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(m.id || '')) return 'invalid plugin id'
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) return 'invalid plugin name'
  if (typeof m.version !== 'string' || !m.version.trim()) return 'invalid version'
  return null
}

// Install a plugin zip (File or ArrayBuffer). Returns the manifest on success;
// throws with a user-readable message on any failure.
export async function installPluginZip(file) {
  const buf = file instanceof ArrayBuffer ? file : await file.arrayBuffer()
  let entries
  try { entries = await parseZip(buf) } catch (e) { throw new Error(`Couldn't read that zip: ${e.message}`) }
  // manifest at the root, or one folder deep (zips made by right-click-compress)
  const manifestPath = entries.has('plugin.json') ? 'plugin.json'
    : [...entries.keys()].find((k) => /^[^/]+\/plugin\.json$/.test(k))
  if (!manifestPath) throw new Error('No plugin.json in that zip — not an Atlas plugin.')
  let manifest
  try { manifest = JSON.parse(new TextDecoder().decode(entries.get(manifestPath))) } catch { throw new Error('plugin.json is not valid JSON.') }
  const bad = validateManifest(manifest)
  if (bad) throw new Error(`Invalid plugin.json: ${bad}.`)
  if (!pluginDef(manifest.id)) {
    // ponytail: until the plugin API ships, a zip can only enable code that's
    // already in the app — the API's dynamic loader is the upgrade path here.
    throw new Error(`"${manifest.name}" isn't built into Atlas yet — third-party plugins need the Atlas plugin API, which is coming later.`)
  }
  const s = loadPlugins()
  s.installed[manifest.id] = {
    name: manifest.name, version: manifest.version,
    source: 'zip', installedAt: new Date().toISOString(),
  }
  s.enabled[manifest.id] = true
  savePlugins(s)
  return manifest
}
