// Two-way sync between the notes folder on this device and the copy on the
// Atlas server. Drop a file in from anywhere, delete one anywhere — every other
// device converges on the next pass.
//
// THE SNAPSHOT IS THE WHOLE IDEA. It records the state at which this device and
// the server last agreed: {rev, files:{path:{sha256,mtime}}}. Comparing disk to
// the snapshot says what THIS device did; comparing the server's delta to the
// snapshot says what everyone else did. Without it you cannot tell "they added
// a file" from "I deleted it" — both look like "present there, absent here" —
// and a sync that guesses wrong resurrects deleted notes forever.
//
// It is device-local by construction: `atlasNotesSync`, deliberately NOT an
// `atlas.`-prefixed key. sync.js pushes every atlas.* key to the backend, and a
// snapshot describing THIS disk must never land on another device.
//
// Nothing here is ever destructive on a disagreement. When both ends changed
// the same note, both versions survive — the server's keeps the path, ours
// becomes "note (conflict …).md" and uploads as a new file.

const KEY = 'atlasNotesSync'
const EMPTY = { rev: 0, files: {} }

export function loadSnapshot() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY))
    if (!s || typeof s !== 'object') return { ...EMPTY }
    return { rev: Number(s.rev) || 0, files: s.files && typeof s.files === 'object' ? s.files : {} }
  } catch { return { ...EMPTY } }
}
export const saveSnapshot = (s) => localStorage.setItem(KEY, JSON.stringify(s))
export const clearSnapshot = () => localStorage.removeItem(KEY)

// SHA-256 of a string, hex. Browser path uses WebCrypto, which needs a secure
// context — 127.0.0.1:5180 and localhost:5173 both qualify, so this works in
// the native shells and the dev server alike.
export async function sha256(text) {
  const bytes = new TextEncoder().encode(text)
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// "a/b/note.md" -> "a/b/note (conflict from iPhone, 2026-08-19).md"
export function conflictPath(path, label, when) {
  const slash = path.lastIndexOf('/')
  const dir = slash < 0 ? '' : path.slice(0, slash + 1)
  const name = slash < 0 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot <= 0 ? name : name.slice(0, dot)
  const ext = dot <= 0 ? '' : name.slice(dot)
  const day = new Date(when).toISOString().slice(0, 10)
  return `${dir}${stem} (conflict from ${label}, ${day})${ext}`
}

// How each side changed relative to the snapshot. Split out because the
// classification is the part worth reading — the apply step below is mechanical.
function classify({ snap, loc, rem }) {
  const local = !snap && loc ? 'added'
    : snap && !loc ? 'deleted'
    : snap && loc && loc.sha256 !== snap.sha256 ? 'changed'
    : 'same'

  // `rem` is present only when the server row moved past our cursor. A row can
  // move without its content changing — our own upload from a previous pass
  // comes back as a "change" — so compare hashes, not just presence.
  const remote = !rem ? 'same'
    : rem.deleted ? (snap || loc ? 'deleted' : 'same')
    : snap && rem.sha256 === snap.sha256 ? 'same'
    : !snap && loc && loc.sha256 === rem.sha256 ? 'same'
    : 'changed'

  return { local, remote }
}

/**
 * One reconciliation pass. Adapters:
 *   local  { list(): [{path, mtime}], read(path): string,
 *            write(path, content): void, remove(path): void }
 *   remote { changes(since): {rev, files:[{path,sha256,size,mtime,rev,deleted}]},
 *            get(path): {content, sha256, mtime}, put(path, content, mtime): {sha256},
 *            del(path): void }
 * Returns a report: {rev, pulled, pushed, deletedLocal, deletedRemote, conflicts, errors}
 */
export async function reconcile({ local, remote, snapshot, hash = sha256, now = () => Date.now(), label = 'this device' }) {
  const snapFiles = snapshot.files || {}
  const report = { rev: snapshot.rev || 0, pulled: [], pushed: [], deletedLocal: [], deletedRemote: [], conflicts: [], errors: [] }

  // ---- what is on disk now -------------------------------------------------
  // Re-reading every file would make each pass cost the whole vault. When the
  // mtime still matches the snapshot the content cannot have changed through
  // any normal write, so the recorded hash stands and nothing is read.
  // ponytail: a same-mtime rewrite (rare: restores, some sync clients) is
  // missed until the file is touched again — full re-hash is the upgrade.
  const listed = await local.list()
  const localNow = {}
  for (const f of listed) {
    const prev = snapFiles[f.path]
    if (prev && f.mtime != null && prev.mtime === f.mtime) {
      localNow[f.path] = { sha256: prev.sha256, mtime: f.mtime }
      continue
    }
    const content = await local.read(f.path)
    if (content == null) continue // vanished between list and read; next pass sees it
    localNow[f.path] = { sha256: await hash(content), mtime: f.mtime ?? now(), content }
  }

  // ---- what everyone else did ----------------------------------------------
  const delta = await remote.changes(snapshot.rev || 0)
  const remoteChanged = new Map((delta.files || []).map((f) => [f.path, f]))

  const paths = new Set([...Object.keys(snapFiles), ...Object.keys(localNow), ...remoteChanged.keys()])
  const nextFiles = {}
  const readLocal = async (path) => localNow[path].content ?? await local.read(path)

  for (const path of [...paths].sort()) {
    const snap = snapFiles[path] || null
    const loc = localNow[path] || null
    const rem = remoteChanged.get(path) || null
    const { local: L, remote: R } = classify({ snap, loc, rem })

    try {
      // Nothing moved on either side.
      if (L === 'same' && R === 'same') {
        if (loc) nextFiles[path] = { sha256: loc.sha256, mtime: loc.mtime }
        continue
      }

      // Only the server moved.
      if (L === 'same' && R === 'changed') {
        const got = await remote.get(path)
        await local.write(path, got.content)
        nextFiles[path] = { sha256: got.sha256, mtime: got.mtime }
        report.pulled.push(path)
        continue
      }
      if (L === 'same' && R === 'deleted') {
        if (loc) { await local.remove(path); report.deletedLocal.push(path) }
        continue // dropped from the snapshot
      }

      // Only this device moved.
      if ((L === 'added' || L === 'changed') && R === 'same') {
        const content = await readLocal(path)
        const put = await remote.put(path, content, loc.mtime)
        nextFiles[path] = { sha256: put?.sha256 ?? loc.sha256, mtime: loc.mtime }
        report.pushed.push(path)
        continue
      }
      if (L === 'deleted' && R === 'same') {
        await remote.del(path)
        report.deletedRemote.push(path)
        continue
      }

      // Both moved. Nothing below may lose bytes.
      if (L === 'deleted' && R === 'deleted') continue

      // Deleted here, edited there — the edit is newer information than our
      // delete, and keeping a file the user can delete again beats destroying
      // an edit they cannot get back.
      if (L === 'deleted' && R === 'changed') {
        const got = await remote.get(path)
        await local.write(path, got.content)
        nextFiles[path] = { sha256: got.sha256, mtime: got.mtime }
        report.pulled.push(path)
        continue
      }

      // Edited here, deleted there — same reasoning, mirrored. The upload
      // resurrects the tombstone server-side.
      if ((L === 'added' || L === 'changed') && R === 'deleted') {
        const content = await readLocal(path)
        const put = await remote.put(path, content, loc.mtime)
        nextFiles[path] = { sha256: put?.sha256 ?? loc.sha256, mtime: loc.mtime }
        report.pushed.push(path)
        continue
      }

      // Edited in both places. Identical edits are not a conflict.
      if (rem && loc && loc.sha256 === rem.sha256) {
        nextFiles[path] = { sha256: loc.sha256, mtime: loc.mtime }
        continue
      }

      // A real conflict: the server keeps the path, our version survives beside
      // it under a new name and is uploaded so every device sees both.
      const mine = await readLocal(path)
      const got = await remote.get(path)
      const alt = conflictPath(path, label, now())
      await local.write(alt, mine)
      const put = await remote.put(alt, mine, loc.mtime)
      nextFiles[alt] = { sha256: put?.sha256 ?? loc.sha256, mtime: loc.mtime }
      await local.write(path, got.content)
      nextFiles[path] = { sha256: got.sha256, mtime: got.mtime }
      report.conflicts.push({ path, kept: alt })
    } catch (e) {
      // One bad file must not stop the pass, and it must not be recorded as
      // agreed — leaving it out of nextFiles means the next pass retries it.
      report.errors.push({ path, error: String(e?.message || e) })
      if (snap) nextFiles[path] = snap
    }
  }

  report.rev = delta.rev ?? snapshot.rev ?? 0
  report.snapshot = { rev: report.rev, files: nextFiles }
  return report
}
