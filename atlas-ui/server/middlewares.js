import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { remote } from './remote.js'
import { callLLM } from './llm.js'


// Graph plugin backend: the browser can't touch the filesystem, open Finder,
// or run graphify — this middleware does all three from the dev-server
// process. Endpoints under /graph-api: pick (native folder dialog), graph
// (read graphify-out/graph.json), build (headless no-LLM graphify rebuild),
// file (preview contents), reveal (Finder), events (SSE, fs.watch → rebuild).
function graphApi() {
  const exec = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 64e6, ...opts }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stderr })) : resolve(stdout))))

  let pyCache = null
  async function graphifyPython() {
    if (pyCache) return pyCache
    // graphify's CLI shebang points at the interpreter its package lives in
    try {
      const bin = (await exec('which', ['graphify'])).trim()
      const shebang = fs.readFileSync(bin, 'utf8').split('\n')[0].replace(/^#!/, '').trim()
      if (shebang && !/[^\w/.-]/.test(shebang)) { pyCache = shebang; return pyCache }
    } catch { /* fall through */ }
    pyCache = 'python3'
    return pyCache
  }

  const REBUILD_SRC = 'import sys\nfrom pathlib import Path\nfrom graphify.watch import _rebuild_code\nsys.exit(0 if _rebuild_code(Path(sys.argv[1]), force=True) else 1)\n'
  const building = new Map() // dir → in-flight build promise (dedupe concurrent asks)
  function buildGraph(dir) {
    if (!building.has(dir)) {
      const p = graphifyPython()
        .then((py) => exec(py, ['-c', REBUILD_SRC, dir], { timeout: 600e3 }))
        .finally(() => building.delete(dir))
      building.set(dir, p)
    }
    return building.get(dir)
  }

  // path must live inside dir — no ../ escapes, no absolute-path smuggling
  const safeJoin = (dir, rel) => {
    const abs = path.resolve(dir, rel)
    return abs === path.resolve(dir) || abs.startsWith(path.resolve(dir) + path.sep) ? abs : null
  }

  const MIME = { md: 'text/markdown', txt: 'text/plain', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' }

  // dir → { watcher, clients:Set<res>, timer } — one fs.watch per directory
  const watches = new Map()
  function notify(dir, msg) {
    const w = watches.get(dir)
    if (w) for (const res of w.clients) res.write(`data: ${msg}\n\n`)
  }
  function ensureWatch(dir) {
    if (watches.has(dir)) return watches.get(dir)
    const w = { clients: new Set(), timer: null, watcher: null }
    try {
      w.watcher = fs.watch(dir, { recursive: true }, (_ev, fname) => {
        if (!fname || fname.includes('graphify-out')) return // our own output
        if (/(^|\/)\.(git|DS_Store)/.test(fname) || fname.includes('node_modules')) return
        clearTimeout(w.timer)
        w.timer = setTimeout(() => {
          notify(dir, 'building')
          buildGraph(dir).then(() => notify(dir, 'updated')).catch(() => notify(dir, 'error'))
        }, 1500) // let save bursts settle before one rebuild
      })
    } catch { /* dir gone — SSE clients just get no events */ }
    watches.set(dir, w)
    return w
  }
  function dropClient(dir, res) {
    const w = watches.get(dir)
    if (!w) return
    w.clients.delete(res)
    if (!w.clients.size) { clearTimeout(w.timer); w.watcher?.close(); watches.delete(dir) }
  }

  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const dir = u.searchParams.get('dir') || ''
    const json = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) }
    try {
      if (u.pathname === '/pick') {
        try {
          const out = await exec('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose a directory to graph")'])
          return json(200, { path: out.trim().replace(/\/$/, '') })
        } catch { return json(200, { canceled: true }) } // Cancel exits non-zero
      }
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(400, { error: 'bad or missing dir' })
      if (u.pathname === '/graph') {
        const gp = path.join(dir, 'graphify-out', 'graph.json')
        if (!fs.existsSync(gp)) return json(404, { needsBuild: true })
        res.setHeader('Content-Type', 'application/json')
        return res.end(fs.readFileSync(gp))
      }
      if (u.pathname === '/build' && req.method === 'POST') {
        await buildGraph(dir)
        return json(200, { ok: true })
      }
      if (u.pathname === '/file') {
        const abs = safeJoin(dir, u.searchParams.get('path') || '')
        if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(404, { error: 'no such file' })
        const st = fs.statSync(abs)
        if (st.size > 8e6) return json(413, { error: 'file too large to preview', size: st.size })
        res.setHeader('Content-Type', MIME[path.extname(abs).slice(1).toLowerCase()] || 'text/plain; charset=utf-8')
        return res.end(fs.readFileSync(abs))
      }
      if (u.pathname === '/reveal' && req.method === 'POST') {
        const abs = safeJoin(dir, u.searchParams.get('path') || '')
        if (!abs || !fs.existsSync(abs)) return json(404, { error: 'no such file' })
        await exec('open', ['-R', abs]) // macOS Finder reveal
        return json(200, { ok: true })
      }
      if (u.pathname === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        res.write('data: watching\n\n')
        const w = ensureWatch(dir)
        w.clients.add(res)
        req.on('close', () => dropClient(dir, res))
        return
      }
      json(404, { error: 'unknown graph-api endpoint' })
    } catch (err) {
      json(500, { error: err.stderr?.toString().slice(-400) || err.message })
    }
  }
  return handler
}


// ---- shared by the AI-backed middlewares (Notes, Study) --------------------

const fail = (code, msg) => Object.assign(new Error(msg), { code })

// Copy the live NoteStore (plus its -wal/-shm siblings) somewhere safe before
// querying it — reading in place mid-WAL yields a torn result.
//
// fs.existsSync() passes WITHOUT Full Disk Access: TCC blocks opening the file,
// not seeing its directory entry. So this copy is the first call that actually
// fails, and it fails with a bare EPERM naming two absolute paths and nothing
// about permissions — which is exactly the error that reached the user.
// Exported so the permission branch has a runnable check (a process that
// already holds Full Disk Access can't reproduce it any other way).
export function copyNoteStore(store, destDir) {
  try {
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(store + ext)) fs.copyFileSync(store + ext, path.join(destDir, 'NoteStore.sqlite' + ext))
    }
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      throw fail(500, 'Can\'t read the Notes database — grant Full Disk Access to the app running the dev server (System Settings → Privacy & Security → Full Disk Access), then restart it.')
    }
    throw fail(500, `Couldn't copy the Notes database — ${e.message}`)
  }
}

// The single credential arrives from the client (see src/page/ai.js
// credsForClaude/credsHeader) — either the POST body's `ai` field or the
// x-atlas-ai header (base64 JSON), so a caller without a JSON body could
// still use the header path. null when absent. Never falls back to the dev
// machine's own `claude` CLI/subscription — see callLLM in llm.js.
function credsFromRequest(req, body) {
  if (body?.ai && typeof body.ai === 'object' && !Array.isArray(body.ai)) return body.ai
  const h = req?.headers?.['x-atlas-ai']
  if (h) {
    try {
      const parsed = JSON.parse(Buffer.from(String(h), 'base64').toString('utf8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* malformed header — treat as absent */ }
  }
  return null
}

// JSON body with base64 file payloads. Anthropic's request cap is 32MB, so
// 50MB here is a backstop, not the real limit (the client pre-checks sizes).
// 80MB: the client allows 45MB of raw files per upload, which base64 inflates ~4/3
const readBody = (req, cap = 80e6) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (c) => {
    // pause rather than destroy: destroying the socket here killed the 413
    // response mid-write, so the browser saw a connection reset instead.
    if ((size += c.length) > cap) { req.pause(); reject(fail(413, 'payload too large')) } else chunks.push(c)
  })
  req.on('end', () => {
    try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(fail(400, 'bad request body')) }
  })
  req.on('error', reject)
})

// Uploads → files on disk, which is how Claude Code's Read tool ingests them.
// Any file type is accepted; the two families the model can't read natively
// are converted here with tools macOS already ships:
//  • HEIC/HEIF — what every iPhone photo is by default. Unconverted, Claude
//    just reports binary data, so a photo of handwritten homework would
//    silently extract nothing. sips → JPEG.
//  • Word/RTF/ODT/HTML — textutil → plain text.
// Anything else is handed over as-is: Read copes with any text-ish format
// (code, csv, json, tex, srt…) and says so plainly when it genuinely can't.
const HEIC_RE = /hei[cf]/i
const DOC_RE = /\.(docx?|rtf|rtfd|odt|wordml|webarchive)$/i
const DOC_MIME = /(msword|wordprocessingml|rtf|opendocument\.text)/i

function convertUpload(src, i, tmp, name, mt) {
  // converted output keeps the source's stem — filenames carry meaning now
  // (study figures are matched to documents by name)
  const stem = path.basename(src).replace(/\.[^.]*$/, '') || `upload-${i}`
  if (HEIC_RE.test(mt) || HEIC_RE.test(name)) {
    const out = path.join(tmp, `${stem}.jpg`)
    try { execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', out], { stdio: 'ignore' }); return out } catch { return src }
  }
  if (DOC_RE.test(name) || DOC_MIME.test(mt)) {
    const out = path.join(tmp, `${stem}.txt`)
    try { execFileSync('textutil', ['-convert', 'txt', src, '-output', out], { stdio: 'ignore' }); return out } catch { return src }
  }
  return src
}

function writeUploads(tmp, files) {
  return (files || []).map((f, i) => {
    const name = String(f.name || '')
    const mt = String(f.media_type || '')
    // keep the real extension — Read dispatches on it, and a mislabeled ext
    // is what turns a readable file into "binary data"
    const ext = (path.extname(name).slice(1) || (mt === 'application/pdf' ? 'pdf' : mt.split('/')[1]) || 'bin').toLowerCase()
    const p = path.join(tmp, `upload-${i}.${ext}`)
    fs.writeFileSync(p, Buffer.from(f.data, 'base64'))
    return convertUpload(p, i, tmp, name, mt)
  })
}

// Reads local files for direct-API attachment. The old CLI path handed the
// `claude` process a Read tool over the job's temp directory and let it
// open files itself; a direct Messages/chat-completions call has no
// filesystem tool, so this reads them here instead — images and PDFs become
// base64 content blocks (see llm.js callLLM), anything else (already-
// converted .txt from DOC_RE, plain pasted-in text files) is inlined under
// its own filename.
const IMG_EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
function readAttachments(paths) {
  const images = []
  const textParts = []
  for (const p of [...new Set(paths)]) {
    const ext = path.extname(p).slice(1).toLowerCase()
    try {
      if (ext === 'pdf') images.push({ media_type: 'application/pdf', data: fs.readFileSync(p).toString('base64'), name: path.basename(p) })
      else if (IMG_EXT_MIME[ext]) images.push({ media_type: IMG_EXT_MIME[ext], data: fs.readFileSync(p).toString('base64'), name: path.basename(p) })
      else textParts.push(`--- ${path.basename(p)} ---\n${fs.readFileSync(p, 'utf8')}`)
    } catch { /* unreadable — the prompt still lists its filename for context */ }
  }
  return { images, text: textParts.join('\n\n') }
}

// Claude-only LLM call for the AI-backed middlewares (Study extraction, tutor
// chat, judge; Notes conversion) that must return schema-shaped JSON. `cred`
// is the caller's own connected Claude account (subscription OAuth), resolved
// client-side (src/page/ai.js credsForClaude) — never the dev machine's own
// `claude` CLI/subscription.
async function askClaude(prompt, schema, cred, images) {
  if (!cred) throw fail(400, 'no_ai_provider')
  let out
  try { out = await callLLM({ cred, prompt, schema, images }) }
  catch (e) { throw fail(502, e.message) }
  let parsed
  try { parsed = JSON.parse(out.text) } catch { throw fail(502, 'The AI did not return valid JSON — try again.') }
  return parsed
}

// Notes plugin backend: turns uploads (handwriting photos, screenshots, PDFs,
// pasted text, web links) into markdown notes, and lists/writes the user's
// notes directory — none of which the browser can do. Conversion runs
// through askClaude/callLLM on the USER'S OWN connected Claude account
// (see ai.js credsForClaude) — never the dev machine's local
// Claude Code subscription. Reading note contents reuses /graph-api/file
// (sandboxed). Apple Notes import reads the account/folder/note tree and one
// note's full content directly by its stable id (never by title, which can
// collide) — typed notes skip the AI entirely (a plain AppleScript body
// read); ink still renders via notes-ink and flows through the same
// conversion as any other upload.

// ---- Apple Notes tree + HTML→markdown (pure, testable) ----------------------
// notesApi()'s osascript walk emits \x1f-delimited lines (AppleScript has no
// JSON encoder); this turns that text into the account→folders→notes shape
// the note picker renders. One line per (account, folder) pair even when the
// folder has no notes, so empty folders still show up in the tree.
// ponytail: only top-level folders per account are walked — nested subfolders
// (folders inside folders) don't appear. Upgrade path: recurse into `folders
// of fld` in appleTree() below and thread a parent id through here.
export function parseAppleTree(raw) {
  const order = []
  const accounts = new Map() // accName → Map(fldId → {name, id, notes[]})
  for (const line of String(raw || '').split('\n')) {
    if (!line.trim()) continue
    const [accName, fldName, fldId, ntId, ntTitle] = line.split('\x1f')
    if (!accName || !fldId) continue
    if (!accounts.has(accName)) { accounts.set(accName, new Map()); order.push(accName) }
    const folders = accounts.get(accName)
    if (!folders.has(fldId)) folders.set(fldId, { name: fldName || '', id: fldId, notes: [] })
    if (ntId) folders.get(fldId).notes.push({ id: ntId, title: ntTitle || '' })
  }
  return order.map((account) => ({ account, folders: [...accounts.get(account).values()] }))
}

// AppleScript's note "id" is a Core Data objectID URI
// (x-coredata://<store-uuid>/ICNote/p<pk>) whose trailing integer is
// NoteStore.sqlite's own Z_PK for that row — extracting it lets the ink-canvas
// lookup key off the exact row instead of a title (which can collide).
// Unverified against a live Notes database; paperCanvases() below falls back
// to the old title match if this ever comes back empty.
export function notePk(id) {
  const m = /\/p(\d+)$/.exec(String(id || ''))
  return m ? m[1] : null
}

// Apple Notes' `body of note` returns HTML (h1-3/div/br/b/i/a — Notes' own
// rich-text tag set). A deliberately simple regex converter, not an HTML
// parser: good enough for a direct read into a markdown vault; anything it
// doesn't recognize degrades to plain text rather than breaking.
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '').trim()
const HTML_UNESCAPE = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }
export function appleHtmlToMarkdown(html) {
  let s = String(html || '')
  s = s.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_m, t) => `\n# ${stripTags(t)}\n`)
  s = s.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_m, t) => `\n## ${stripTags(t)}\n`)
  s = s.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_m, t) => `\n### ${stripTags(t)}\n`)
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t) => `- ${stripTags(t)}\n`)
  s = s.replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, (_m, t) => `**${stripTags(t)}**`)
  s = s.replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, (_m, t) => `*${stripTags(t)}*`)
  s = s.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, t) => `[${stripTags(t)}](${href})`)
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(?:div|p)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, '')
  s = s.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g, (m) => HTML_UNESCAPE[m])
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function notesApi() {
  const exec = (cmd, args) => new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 16e6 }, (err, stdout) => (err ? reject(err) : resolve(stdout))))

  // ---- Apple Notes import ----------------------------------------------------
  // A handwritten note is rendered straight from its on-disk ink vectors to a
  // full-height PDF by ../notes-ink/render_note.sh — no Notes app, no screen
  // unlock, and (unlike Apple's own export) no truncation of tall canvases.
  // A typed note has no ink bundle, so its content is read directly via
  // AppleScript's `body of note` (HTML → markdown) — no export, no screen
  // unlock, no claude call; see fetchAppleNote below.
  // Reading the Notes DB or an ink bundle needs Full Disk Access granted to
  // whatever app runs the dev server.
  // Caveat: ink syncs lazily — a note not yet scrolled through on this Mac has
  // only its first page of strokes locally, so it still renders truncated until
  // opened+scrolled in Notes once (a data limit, not an export limit). See
  // ~/.claude memory apple-notes-ink-renderer.
  const RENDER_SH = fileURLToPath(new URL('../../notes-ink/render_note.sh', import.meta.url))
  const NOTES_DIR = path.join(os.homedir(), 'Library/Group Containers/group.com.apple.notes')

  // Every account → its top-level folders → each folder's notes, id-first.
  // \x1f-delimited (AppleScript has no JSON encoder — matches the sqlite3
  // -separator convention used below). One line per folder even when it holds
  // zero notes, so empty folders still appear in the tree.
  async function appleTree() {
    const SEP = '(ASCII character 31)'
    const out = await exec('osascript', [
      '-e', 'set treeOut to {}',
      '-e', 'tell application "Notes"',
      '-e', 'repeat with acc in accounts',
      '-e', 'set accName to name of acc',
      '-e', 'repeat with fld in folders of acc',
      '-e', 'set fldName to name of fld',
      '-e', 'set fldId to id of fld as text',
      '-e', `set end of treeOut to accName & ${SEP} & fldName & ${SEP} & fldId & ${SEP} & "" & ${SEP} & ""`,
      '-e', 'repeat with nt in notes of fld',
      '-e', `set end of treeOut to accName & ${SEP} & fldName & ${SEP} & fldId & ${SEP} & (id of nt as text) & ${SEP} & (name of nt)`,
      '-e', 'end repeat',
      '-e', 'end repeat',
      '-e', 'end repeat',
      '-e', 'end tell',
      '-e', 'set text item delimiters to linefeed',
      '-e', 'treeOut as text',
    ])
    return parseAppleTree(out)
  }

  // Escape a client-supplied note id for interpolation into an AppleScript
  // string literal — a newline would let it smuggle extra statements.
  function ascLit(s) {
    const v = String(s ?? '')
    if (/[\r\n]/.test(v)) throw fail(400, 'invalid note id')
    return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  // {title, html} for one note by its stable id. html is '' for a note with
  // no typed content — a purely handwritten note's body is empty; that's the
  // paperCanvases() branch in fetchAppleNote, not this.
  async function noteNameAndBody(id) {
    let out
    try {
      out = await exec('osascript', [
        '-e', 'tell application "Notes"',
        '-e', `set n to note id "${ascLit(id)}"`,
        '-e', '(name of n) & (ASCII character 31) & (body of n)',
        '-e', 'end tell',
      ])
    } catch (e) { throw fail(404, `note not found — ${String(e.stderr || e.message).trim().split('\n').pop()}`) }
    const i = out.indexOf('\x1f')
    return i < 0 ? { title: out.trim(), html: '' } : { title: out.slice(0, i), html: out.slice(i + 1) }
  }

  // Locate a paper attachment's ink bundle across the (possibly several) Notes
  // accounts on disk.
  function findBundle(uuid) {
    const accts = path.join(NOTES_DIR, 'Accounts')
    if (!fs.existsSync(accts)) return null
    for (const a of fs.readdirSync(accts)) {
      const p = path.join(accts, a, 'Paper/Bundles', `${uuid}.bundle/Database/data.sqlite3`)
      if (fs.existsSync(p)) return p
    }
    return null
  }

  // A note's handwritten canvases: [{uuid, bundle, W,H,OX,OY}]. Empty for a
  // typed note. Canvas bounds come from the attachment's ZMETADATADATA JSON.
  // NoteStore.sqlite is copied (with -wal/-shm) before querying so a live WAL
  // never yields a torn read. Keyed by id (via notePk) when the Core Data PK
  // extraction holds, else by title (the old, collision-prone match).
  function paperCanvases(id, title) {
    const store = path.join(NOTES_DIR, 'NoteStore.sqlite')
    if (!fs.existsSync(store)) throw fail(500, `Notes database not found — the dev server needs Full Disk Access to read ${NOTES_DIR}.`)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-nstore-'))
    try {
      copyNoteStore(store, tmp)
      const pk = notePk(id)
      const where = pk ? `n.Z_PK = ${pk}` : `n.ZTITLE1 = '${title.replace(/'/g, "''")}'`
      const sql = `SELECT a.ZIDENTIFIER, a.ZMETADATADATA FROM ZICCLOUDSYNCINGOBJECT a `
        + `JOIN ZICCLOUDSYNCINGOBJECT n ON n.Z_PK = a.ZNOTE `
        + `WHERE ${where} AND a.ZTYPEUTI = 'com.apple.paper'`
      let out
      try { out = execFileSync('sqlite3', ['-separator', '\x1f', path.join(tmp, 'NoteStore.sqlite'), sql], { encoding: 'utf8', maxBuffer: 8e6 }) }
      catch (e) {
        if (/authorization denied|not permitted|unable to open/i.test(String(e.stderr || e.message))) throw fail(500, `Can't read the Notes database — grant Full Disk Access to the app running the dev server (System Settings → Privacy & Security → Full Disk Access).`)
        throw fail(500, `Notes database query failed — ${String(e.stderr || e.message).trim()}`)
      }
      const canvases = []
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        const [uuid, meta] = line.split('\x1f')
        const bundle = findBundle(uuid)
        if (!bundle) continue // attachment metadata exists but its ink bundle isn't on disk yet
        let W, H, OX, OY
        try { const m = JSON.parse(meta || '{}'); W = m.paperContentBoundsWidthKey; H = m.paperContentBoundsHeightKey; OX = m.paperContentBoundsOriginXKey; OY = m.paperContentBoundsOriginYKey } catch { /* auto-size */ }
        canvases.push({ uuid, bundle, W, H, OX, OY })
      }
      return canvases
    } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
  }

  // Render one ink bundle → PDF via render_note.sh; resolves with the stroke
  // count (0 for an empty canvas — Notes leaves stub canvases with no ink,
  // which are skipped rather than failing the whole import).
  const renderPaper = (c, outPdf) => new Promise((resolve, reject) => {
    const args = [RENDER_SH, c.bundle, outPdf]
    if (c.W && c.H) args.push(String(c.W), String(c.H), String(c.OX ?? 0), String(c.OY ?? 0))
    execFile('bash', args, { timeout: 60e3, maxBuffer: 16e6 }, (err, stdout, stderr) => {
      const msg = String(stderr || (err && err.message) || '')
      if (err) {
        if (/no strokes/i.test(msg)) return resolve(0) // empty stub canvas
        return reject(fail(502, `couldn't render handwriting — ${msg.trim().split('\n').pop()}`))
      }
      if (!fs.existsSync(outPdf) || fs.statSync(outPdf).size < 200) return resolve(0)
      resolve(Number(/(\d+) strokes/.exec(stdout || '')?.[1]) || 1)
    })
  })

  // One note, by its stable id — never by title (titles can collide).
  // Handwritten → { kind: 'ink', title, files: [{name, media_type, data}],
  // source: 'ink' }: unchanged render_note.sh rendering; the caller runs
  // these through the existing upload+convert (claude) pipeline, same as any
  // other upload. Typed → { kind: 'typed', title, markdown }: read directly
  // via AppleScript's `body of note` — no export, no claude call, and nothing
  // is written back to Apple Notes (no duplicate, no delete — see notesui.js
  // pickAppleNote, which only ever reads).
  async function fetchAppleNote(id) {
    const { title, html } = await noteNameAndBody(id)
    const canvases = paperCanvases(id, title)
    if (canvases.length) {
      // A note can hold several ink canvases (plus empty stubs); render each,
      // keep the non-empty ones.
      const rendered = []
      for (let i = 0; i < canvases.length; i++) {
        const out = path.join(os.tmpdir(), `ink-${Date.now()}-${i}.pdf`)
        try {
          const strokes = await renderPaper(canvases[i], out)
          if (strokes && fs.existsSync(out) && fs.statSync(out).size >= 200) rendered.push(fs.readFileSync(out).toString('base64'))
        } finally { fs.rmSync(out, { force: true }) }
      }
      if (rendered.length) {
        const files = rendered.map((data, i) => ({
          name: rendered.length > 1 ? `${title} (${i + 1}).pdf` : `${title}.pdf`,
          media_type: 'application/pdf',
          data,
        }))
        return { kind: 'ink', title, files, source: 'ink' }
      }
      // Canvases exist but hold no local ink — not synced (or genuinely
      // blank). Never fall through to a partial read: a truncated note must
      // surface clearly rather than silently return incomplete content.
      throw fail(422, `"${title}" is handwritten, but none of its ink is on this Mac yet — open it in Notes and scroll to the bottom once so iCloud downloads it, then try again.`)
    }
    // Typed note: direct read, no export, no claude.
    return { kind: 'typed', title, markdown: appleHtmlToMarkdown(html) }
  }

  // path must live inside dir — no ../ escapes, no absolute-path smuggling
  const safeJoin = (dir, rel) => {
    const abs = path.resolve(dir, rel)
    return abs === path.resolve(dir) || abs.startsWith(path.resolve(dir) + path.sep) ? abs : null
  }

  // "note uploads" holds originals (images/PDFs), not notes — skipped here.
  const SKIP = new Set(['node_modules', 'graphify-out', 'note uploads'])
  function walk(dir, base = dir, out = { dirs: [], notes: [] }) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue
      const abs = path.join(dir, e.name)
      const rel = path.relative(base, abs)
      if (e.isDirectory()) { out.dirs.push(rel); walk(abs, base, out) }
      else if (/\.md$/i.test(e.name)) out.notes.push({ path: rel, mtime: fs.statSync(abs).mtimeMs })
    }
    return out
  }

  // ponytail: naive tag-strip instead of a readability dep — Claude copes
  // with the leftover nav/boilerplate text fine.
  async function fetchPageText(url) {
    let r
    try {
      r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Atlas notes)' } })
    } catch (err) { throw fail(502, `couldn't fetch that link — ${err.message}`) }
    if (!r.ok) throw fail(502, `couldn't fetch that link (${r.status})`)
    return (await r.text())
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }[m]))
      .replace(/\s+/g, ' ').trim().slice(0, 200000)
  }

  const SCHEMA = JSON.stringify({
    type: 'object',
    properties: { title: { type: 'string' }, markdown: { type: 'string' } },
    required: ['title', 'markdown'],
    additionalProperties: false,
  })

  // Formatting is specified as exact patterns with correct/incorrect examples —
  // abstract style rules produce different interpretations run to run; concrete
  // exemplars are what keep repeated conversions of the same note similar.
  const RULES = `You convert study material (photos of handwritten notes, screenshots, PDFs, pasted text, or web-page text) into ONE well-organized Obsidian markdown note.

Content rules:
- Merge all provided inputs into a single note — they are parts of the same topic.
- When file paths are listed below, read each one; images and PDFs are the note's source material to transcribe.
- Transcribe the content faithfully — never invent or drop information — but do NOT keep the original's structure or ordering. Organize the note in the most logical way and place each piece of content where it most logically belongs.
- When two sections cover substantially the same material, merge them into one section.

Formatting rules — apply these EXACTLY the same way every time:
- Definitions: bold term first, an em dash, then the definition in the same sentence.
  Correct:   **Conductor** — a material that charge moves through easily.
  Incorrect: **Conductor**
             - a material that charge moves through easily.
  Never put the definition on its own line or bullet below the term, and never phrase a definition as "An X is ..." — always the bold-term-then-dash pattern.
- Wiki-links: link a phrase ONLY when it matches one of the existing note names listed below, as [[Exact Name]] or [[Exact Name|text as it reads in the sentence]]. Link every natural mention of those names. NEVER link anything not on the list — no links to notes that don't exist.
- Precedence: at the sentence where a term is DEFINED, the term is bolded and NOT wiki-linked, even when a note with that name exists (definition beats linking). Its other mentions elsewhere in the note are linked as usual.
- Math: use $...$ for inline and $$...$$ for display math. NEVER use \\( \\) or \\[ \\] delimiters. Write ellipses as \\ldots or \\cdots, never \\dots.
- Headings: ## for sections, ### for subsections; start the body with a single # title line.

Drawings — when the source contains one, REDRAW it, do not describe it in prose. Only ever emit these for something actually present in the material; never invent one.
- TABLE (any grid of values, hand-ruled or not): a normal markdown table. Never an image. If it needs a caption or column alignment, use a fence instead:
  \`\`\`atlas-table
  {"columns":["Ion","Charge"],"rows":[["Na","+1"],["O","-2"]],"align":["left","right"],"caption":"Common ions"}
  \`\`\`
- GRAPH or PLOT (axes with a function, a curve, or plotted points): emit a SPEC and let the app plot it. Do NOT draw axes yourself and do NOT describe the shape.
  \`\`\`atlas-graph
  {"title":"Projectile height","xLabel":"t (s)","yLabel":"h (m)","domain":[0,4],
   "curves":[{"latex":"-4.9x^2+20x","label":"h(t)"}],
   "points":[{"x":2.04,"y":20.4,"label":"apex"}]}
  \`\`\`
  The independent variable in "latex" is ALWAYS x, whatever the axis is called (write t as x). Use "series" for measured/tabulated data points: {"series":[{"label":"trial 1","data":[[0,0],[1,4.9]]}]}. Give "domain" whenever the source implies one. Read the function off the page if it is written down; only fit an approximate one if it is not, and say so in the label.
- FIGURE — anything that is neither of the above (free-body diagram, circuit, apparatus sketch, labelled diagram): redraw it as clean inline SVG.
  \`\`\`atlas-figure
  <svg viewBox="0 0 320 200" xmlns="http://www.w3.org/2000/svg">…</svg>
  \`\`\`
  Use stroke="currentColor" with fill="none" for strokes so it follows the app's light/dark theme, keep text in <text> elements, and set a viewBox so it scales. No <script>, no <foreignObject>, no external or embedded raster images.

Output:
- Begin the markdown with YAML frontmatter: date, source (one of: handwritten, screenshot, pdf, text, web), and source_url when a URL was given.
- title: a short, filename-safe note title (no slashes, no extension).
- Do NOT write any files — return only the note as structured output; the app saves it.`

  // Conversion runs through callLLM (llm.js) on the user's OWN connected
  // Claude/OpenAI account. Uploads are written to a temp dir and read back
  // here as base64 attachments (readAttachments) — no filesystem tool, no
  // local `claude` CLI. Everything is torn down after.
  async function convert(dir, body, cred) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-notes-'))
    try {
      const paths = writeUploads(tmp, body.files)
      const webText = body.url ? await fetchPageText(body.url) : ''
      const names = walk(dir).notes.map((n) => n.path.replace(/\.md$/i, '').split('/').pop()).slice(0, 2000)
      const { images, text: fileText } = readAttachments(paths)
      const prompt = [
        RULES,
        `Existing notes in this vault (wiki-link to these exact names where relevant):\n${names.join(', ') || '(none yet)'}`,
        `Today's date: ${new Date().toISOString().slice(0, 10)}`,
        paths.length ? `Attached files to read and transcribe:\n${paths.join('\n')}` : '',
        body.url ? `Source URL: ${body.url}\n\nExtracted page text:\n${webText}` : '',
        body.text ? `Typed/pasted notes:\n${body.text}` : '',
        fileText ? `File contents:\n${fileText}` : '',
        'Convert the material above into one note.',
      ].filter(Boolean).join('\n\n')

      // cred is the user's own connected Claude account (resolved client-side
      // by credsForClaude; never the dev machine's own claude CLI). Model is
      // pinned inside llm.js so note style stays stable.
      return await askClaude(prompt, SCHEMA, cred, images)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }

  // Originals land in "<root>/note uploads/" (deduped names) and get appended
  // to the note as Obsidian embeds — done server-side so the embed names
  // always match what was actually written after dedup renaming.
  function save(dir, body) {
    const sub = body.subdir ? safeJoin(dir, body.subdir) : dir
    if (!sub) throw fail(400, 'bad subdirectory')
    const fname = String(body.filename || '').replace(/\.md$/i, '').replace(/[/\\:]/g, '-').trim() || 'untitled'
    const target = path.join(sub, `${fname}.md`)
    if (fs.existsSync(target)) throw fail(409, 'a note with that name already exists there')
    let md = String(body.markdown || '')
    const saved = []
    if (body.uploads?.length) {
      const updir = path.join(dir, 'note uploads')
      fs.mkdirSync(updir, { recursive: true })
      for (const u of body.uploads) {
        let name = path.basename(String(u.name || 'upload')).replace(/[\\:]/g, '-')
        const ext = path.extname(name)
        const stem = name.slice(0, name.length - ext.length)
        for (let i = 2; fs.existsSync(path.join(updir, name)); i++) name = `${stem}-${i}${ext}`
        fs.writeFileSync(path.join(updir, name), Buffer.from(u.data, 'base64'))
        saved.push(name)
      }
      md += `\n\n---\n**Originals:** ${saved.map((n) => (/\.pdf$/i.test(n) ? `[[${n}]]` : `![[${n}]]`)).join(' ')}\n`
    }
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(target, md)
    return { ok: true, path: path.relative(dir, target) }
  }

  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const json = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) }
    try {
      if (u.pathname === '/pick') {
        try {
          const out = await exec('osascript', ['-e', 'POSIX path of (choose folder with prompt "Choose your notes folder")'])
          return json(200, { path: out.trim().replace(/\/$/, '') })
        } catch { return json(200, { canceled: true }) } // Cancel exits non-zero
      }
      if (u.pathname === '/apple-tree' && req.method === 'GET') return json(200, await appleTree())
      const body = req.method === 'POST' ? await readBody(req) : {}
      if (u.pathname === '/apple-note' && req.method === 'POST') {
        if (!String(body.id || '').trim()) return json(400, { error: 'missing note id' })
        return json(200, await fetchAppleNote(String(body.id)))
      }
      const dir = u.searchParams.get('dir') || body.dir || ''
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return json(400, { error: 'bad or missing dir' })
      if (u.pathname === '/tree') return json(200, walk(dir))
      if (u.pathname === '/convert' && req.method === 'POST') return json(200, await convert(dir, body, credsFromRequest(req, body)))
      if (u.pathname === '/save' && req.method === 'POST') return json(200, save(dir, body))
      // Raw write / delete at an EXACT relative path — what folder sync needs,
      // and what save() deliberately is not: save() is the composer's route, so
      // it sanitizes the filename and 409s on an existing file. Mirroring a
      // remote change has to land on the path it was given and overwrite.
      if (u.pathname === '/put' && req.method === 'POST') {
        const rel = String(body.path || '')
        const abs = safeJoin(dir, rel)
        if (!abs || abs === path.resolve(dir)) throw fail(400, 'bad path')
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, String(body.content ?? ''))
        return json(200, { ok: true, path: rel, mtime: fs.statSync(abs).mtimeMs })
      }
      if (u.pathname === '/delete' && req.method === 'POST') {
        const abs = safeJoin(dir, String(body.path || ''))
        if (!abs || abs === path.resolve(dir)) throw fail(400, 'bad path')
        // Already absent is success: the sync pass and the user can race, and
        // both outcomes are "the file is gone", which is what was asked for.
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true })
        return json(200, { ok: true })
      }
      json(404, { error: 'unknown notes-api endpoint' })
    } catch (err) {
      json(err.code >= 400 && err.code <= 599 ? err.code : 500, { error: err.message })
    }
  }
  return handler
}

// Study plugin backend: three AI jobs the browser can't run itself —
// extracting question-bank items / flashcards from uploaded course material,
// the tutor-chat turn, and grading arbitration when the local math engine is
// unsure. Same provider-routed pattern as Notes — the user's own connected
// Claude/OpenAI account, schema-constrained output.
function studyApi() {
  const PART_PROPS = {
    prompt: { type: 'string' },
    kind: { enum: ['math', 'text', 'choice'] },
    answer: { type: 'string' },
    check: { enum: ['equiv', 'numeric', 'form', 'text', 'choice'] },
    tolerancePct: { type: 'number' },
    form: { type: 'string' },
    options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['text', 'figure'], properties: { text: { type: 'string' }, figure: { type: 'string' } } } },
  }
  const PARTS = { type: 'array', minItems: 1, items: { type: 'object', additionalProperties: false, required: ['prompt', 'kind', 'answer', 'check'], properties: PART_PROPS } }
  const Q_PROPS = { category: { type: 'string' }, intro: { type: 'string' }, parts: PARTS, figures: { type: 'array', items: { type: 'string' } } }
  const SCHEMAS = {
    questions: JSON.stringify({ type: 'object', additionalProperties: false, required: ['questions'], properties: { questions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['category', 'intro', 'parts'], properties: Q_PROPS } } } }),
    cards: JSON.stringify({ type: 'object', additionalProperties: false, required: ['cards'], properties: { cards: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['front', 'back'], properties: { front: { type: 'string' }, back: { type: 'string' } } } } } }),
    chat: JSON.stringify({ type: 'object', additionalProperties: false, required: ['message', 'question'], properties: { message: { type: 'string', description: 'The literal chat bubble shown to the student, spoken directly TO them (second person). NEVER a summary or report of what you did.' }, question: { type: ['object', 'null'], additionalProperties: false, required: ['bankId', 'category', 'intro', 'parts'], properties: { bankId: { type: ['string', 'null'] }, ...Q_PROPS } } } }),
    judge: JSON.stringify({ type: 'object', additionalProperties: false, required: ['verdicts'], properties: { verdicts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['n', 'correct', 'note'], properties: { n: { type: 'number' }, correct: { type: 'boolean' }, note: { type: 'string' } } } } } }),
  }

  const NOTATION = 'Math notation: inline LaTeX between $...$ in any prose text (intros, prompts, card fronts/backs, chat messages). The "answer" field is BARE LaTeX with no $ delimiters and no "x =" prefix (unless an equation genuinely is the answer). Data tables go in prose text as GitHub-flavored markdown tables (| x | f(x) | header row, then | --- | --- |, then value rows) — the app renders them. String escaping: LaTeX commands carry ONE backslash and paragraph breaks are real newlines — never double-escape (a parsed string must contain \\frac, not a doubled backslash, and actual line breaks, never the two characters backslash + n).'

  const QUESTION_RULES = `Each question has: category, intro, parts.
- category: short lowercase tag for the technique/concept the question exercises (e.g. "u-substitution", "mean value theorem", "partial fractions"). Reuse an existing category when one fits.
- intro: the problem statement. Multi-part questions put the shared setup here and the sub-questions in the parts' prompts ("(a) …"); single-part questions put everything in intro and leave prompt "".
- Every part carries its correct answer. If the source doesn't show one, SOLVE it; skip anything you cannot answer with certainty.
- part.kind: "math" when the answer is entered in a math editor (expression or number), "text" for a short verbal answer (then check is "text"), "choice" for multiple choice (then check is "choice", options lists every choice in order, and answer is the 0-based INDEX of the correct option as a string, e.g. "2").
- part.check for math parts — every question must be explicit about EXACT vs ROUNDED:
  · "equiv" when the EXACT value is wanted (fractions, radicals, π, e — any mathematically equivalent exact form counts; a rounded decimal is wrong).
  · "numeric" ONLY when the problem asks for a decimal/rounded/approximate answer ("Round to four decimal places", "correct to two decimals", "estimate"). Keep the source's rounding instruction in the intro/prompt text, and set tolerancePct to match the stated precision — tight enough that a correctly-rounded answer passes and a sloppier one fails (answer ≈ 7 rounded to 4 decimals → tolerancePct 0.001; 2 decimals → 0.1; no precision stated → 1).
  · "form" when a specific written form is demanded (then set form, e.g. "as partial fractions").`

  const FIGURE_RULES = `Figures: the job directory contains fig-*.png screenshots of the source pages' images, numbered in reading order — source files in the order listed, and within each file, page order (fig-1 is highest on the first file's page) — Read each one to see what it shows.
- The figure list may ALSO include images the student uploaded, kept under their original filenames. An image named after another source file (e.g. "1.11 fig 2.png" alongside "Homework 1.11.mhtml") is that document's missing figure — attach it to the question it illustrates. An uploaded image that is itself a page of problems (a photo or screenshot of the assignment) is source material: extract questions from it and never attach it as a figure.
- When a question depends on a figure (a graph, region, diagram), put that figure's FILENAME (e.g. "fig-3.png") in the question's figures array — the app displays it with the question. Match figures to questions by their page order against the document.
- When the choices themselves are images ("which graph shows…"), use a "choice" part with one option per image: set each option's figure to its filename (text may stay ""), and answer to the correct option's index. A question's choice images are consecutive fig files.
- Attach ONLY genuine question figures. NEVER attach interface images: symbol palettes/keyboards, toolbars, logos, icons, progress marks. If the figure a question needs is not among the files, leave its figures empty rather than attaching a wrong one.
- Reference only filenames that actually exist; never invent figures.
- Tables of values are NOT figures: transcribe them as GitHub-flavored markdown tables (| x | f(x) | rows) inside the intro or prompt text.`

  const WEBASSIGN_RULES = `WebAssign printouts: these pages are the student's COMPLETED assignment — they show submitted answers with correct/incorrect marks and often the key. Use the verified-correct final answers (prefer values marked correct; solve yourself when the shown attempt was marked wrong). Keep the concrete numbers as printed, strip WebAssign chrome (point totals, submission counts, notepad text).`

  const PROMPTS = {
    questions: (cats, paths, text, figs) => [
      'You build a question bank from a student\'s course materials (homework, worksheets, exams, notes). Extract real practice problems — no invented filler; merge near-duplicates.',
      QUESTION_RULES, NOTATION,
      figs.length ? FIGURE_RULES : '',
      paths.some((p) => /rendered-\d+\.pdf$/.test(p)) ? WEBASSIGN_RULES : '',
      cats.length ? `Existing categories (reuse where apt): ${cats.join(', ')}` : '',
      paths.length ? `Files to read:\n${paths.join('\n')}` : '',
      figs.length ? `Figure files available (Read them, reference by filename):\n${figs.map((f) => path.basename(f)).join('\n')}` : '',
      text ? `Pasted material:\n${text}` : '',
      'Extract the question bank now.',
    ],
    cards: (cats, paths, text, figs) => [
      'You extract flashcards from a student\'s course materials: definitions, formulas, theorem statements, key facts — things to memorize. front = the prompt/term/question, back = the answer/definition/formula. Keep both concise. Skip worked problems (those belong in a question bank, not on flashcards).',
      NOTATION,
      paths.length ? `Files to read:\n${paths.join('\n')}` : '',
      text ? `Pasted material:\n${text}` : '',
      'Extract the flashcards now.',
    ],
  }

  const ROLE = { you: 'STUDENT', tutor: 'TUTOR', result: 'GRADING', sys: 'SYSTEM' }
  const transcriptLines = (t) => (Array.isArray(t) ? t : []).map((m) => `${ROLE[m?.role] || 'NOTE'}: ${String(m?.text ?? '')}`).join('\n') || '(session start)'
  const statsLines = (stats) => Object.entries(stats && typeof stats === 'object' ? stats : {})
    .map(([k, v]) => `${k}: ${v?.correct ?? 0}/${v?.attempts ?? 0}`).join('\n')

  const chatPrompt = (b) => [
    `You are a sharp, encouraging study tutor quizzing a college student on "${String(b.tab || 'their course')}". You drive the session: pose ONE question at a time, drawn from the question bank below (set bankId to its id, repeat its intro/parts verbatim). Prefer categories where accuracy is weak or untested. When the student asks for "another like that", or the bank is exhausted or thin, GENERATE a fresh question in the same style (bankId null) following the same rules:`,
    `"message" IS the chat bubble the student reads — write it as direct speech TO the student, the way a tutor talks. It is NEVER a summary, log, or report of what you did.
  Correct:   "$f^{(4)}(x)$ is the fourth derivative — differentiate $f$ four times. Start with $f'(x)$: what do you get?"
  Incorrect: "Explained the fourth derivative and coached the student step by step, question stays open." (that describes a reply instead of being one)
If earlier TUTOR lines in the transcript look like reports, do NOT imitate them — always answer in direct speech.`,
    QUESTION_RULES, NOTATION,
    'Generated questions must use math/text parts only — never "choice" and never figures (you cannot create images). Bank questions keep whatever parts and figures they have.',
    `The app grades answers itself — results appear in the transcript as GRADING lines — and after a miss the SAME question stays open for another try. You are a coach, not an answer key:
- Student missed? Work through it WITH them on the same question: set question to null and give ONE targeted nudge diagnosed from their specific answer — a sign slip → "check your signs"; numbers coming out wrong → give the correct base equation/formula to start from (the general formula, never plugged-in values); wrong technique → name the right one. Escalate hints gradually across attempts, but NEVER reveal the correct answer or a full worked solution — not even when asked directly. Move on only when they solve it or explicitly ask to skip.
- Student got it? One short line of recognition, then pose the next question.
- Never reveal the answer of the question you are currently POSING.`,
    '"question" is the next question to pose, or null when you are only replying or coaching the current one.',
    `QUESTION BANK:\n${JSON.stringify(b.bank || [])}`,
    `CATEGORY ACCURACY (correct/attempts):\n${statsLines(b.stats) || '(none yet)'}`,
    b.activeQ ? `QUESTION CURRENTLY POSED (still unanswered — return question:null unless replacing it):\n${JSON.stringify(b.activeQ)}` : '',
    `TRANSCRIPT (most recent last):\n${transcriptLines(b.transcript)}`,
  ]

  const judgePrompt = (items) => [
    'You grade a student\'s answers that a deterministic checker could not settle. For each item decide correct (true/false) per its rule, judging mathematical/semantic content — formatting and notation differences never matter unless the rule demands a specific form. Be strict: a missing constant of integration, a dropped ±, or a wrong variable is incorrect. note: why, ≤ 12 words, addressed to the student.',
    NOTATION,
    `ITEMS (expected = the correct answer, given = the student's):\n${JSON.stringify(items)}`,
  ]

  // ---- server-side extraction jobs -----------------------------------------
  // One job per uploaded file — or per BUNDLE (bundle:true groups the whole
  // upload, e.g. all screenshots of one homework, under a single agent). Job
  // state lives in this process so a browser reload rebuilds the queue strip
  // and the work keeps running through it. Ceiling: dev-server restart clears jobs.
  const jobs = new Map() // id → { id, target, tabId, tabName, label, categories, phase, error, startedAt, results, dir, sources: [{file, name, mediaType}], text, prepared }
  // Seeded from the clock: ids (and the sf-<id>-<n> figure names built from
  // them) must stay unique ACROSS dev-server restarts — a plain counter reset
  // to 0 every restart, and a later "job 2" overwrote an older bank's
  // published sf-2-*.png figures in study-figures/.
  let jobSeq = Math.floor(Date.now() / 1000)
  const CONCURRENCY = 4 // parallel claude agents (user-chosen; more risks the plan's session limit)

  const FIG_DIR = fileURLToPath(new URL('../study-figures', import.meta.url))

  // Chromium reads mhtml natively (it's Chrome's own format). One render pass
  // produces BOTH agent inputs: a clean PDF of the page (seconds to read,
  // math typeset as WebAssign shows it) and per-figure screenshots. Figures
  // are captured from the RENDERED page, not the archive's resources — the
  // archive is full of interface images (the 1368×600 MathType symbol-palette
  // sprite appears 100+ times per assignment), and pulling resources by size
  // once attached that sprite to a Riemann-sum question as its "graph".
  async function renderMhtml(src, dir, srcIdx = 0, figStart = 0) {
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ headless: true })
    try {
      const pg = await browser.newPage()
      await pg.goto('file://' + encodeURI(src).replace(/#/g, '%23'), { waitUntil: 'load', timeout: 60e3 })
      await pg.waitForTimeout(1000) // late layout (fonts, MathML)
      // Chromium renders an mhtml archive in a SECOND navigation that can land
      // after 'load' — an evaluate caught mid-commit dies with "execution
      // context destroyed", so settle and retry once.
      const ev = async (fn) => {
        try { return await fn() }
        catch { await pg.waitForLoadState('load').catch(() => {}); await pg.waitForTimeout(500); return fn() }
      }
      // Lazy images only fetch once scrolled near — sweep the page, then wait
      // for every image to finish decoding so none is captured half-loaded.
      // Sweep is driven from Node with atomic evaluates: an in-page async loop
      // gets its timers throttled (hidden page) and its context torn down.
      const height = Math.min(await ev(() => pg.evaluate(() => document.body.scrollHeight)) || 0, 60000)
      for (let y = 800; y < height; y += 800) {
        await ev(() => pg.evaluate((yy) => scrollTo(0, yy), y))
        await pg.waitForTimeout(60)
      }
      await ev(() => pg.evaluate(() => scrollTo(0, 0)))
      await pg.waitForFunction(() => [...document.images].every((im) => im.complete), { timeout: 5000 }).catch(() => {})
      // Figure candidates, in page order: img/canvas/svg of plausible figure
      // size, deduplicated by source, interface chrome excluded — by name, and
      // by frequency (a source repeated >4× is UI furniture: sprites, bullets,
      // radio art — real question figures appear once or twice). Visible
      // elements qualify by displayed size; HIDDEN imgs qualify by natural
      // size, because figure carousels ("Figure 1 of 3") keep panes 2..N
      // display:none and those are real question figures.
      const picks = await ev(() => pg.evaluate(() => {
        const els = [...document.querySelectorAll('img, canvas, svg')]
        const bySrc = new Map() // source key → { count, firstIndex }
        els.forEach((el, i) => {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          const hidden = cs.display === 'none' || cs.visibility === 'hidden' || r.width === 0
          const w = hidden ? (el.tagName === 'IMG' ? el.naturalWidth : 0) : r.width
          const h = hidden ? (el.tagName === 'IMG' ? el.naturalHeight : 0) : r.height
          if (w < 70 || h < 70 || w > 1100) return
          const cls = String(el.className?.baseVal ?? el.className ?? '')
          const key = el.currentSrc || el.src || `element-${i}`
          if (/icons?\.png|sprite|palette|toolbar|logo|button|wrs_/i.test(`${key} ${cls}`)) return
          const s = bySrc.get(key) || { count: 0, firstIndex: i }
          s.count++
          bySrc.set(key, s)
        })
        return [...bySrc.values()].filter((s) => s.count <= 4).map((s) => s.firstIndex).sort((a, b) => a - b).slice(0, 60)
      }))
      const els = await pg.$$('img, canvas, svg')
      const figs = []
      for (const i of picks) {
        const f = path.join(dir, `fig-${figStart + figs.length + 1}.png`)
        try {
          // IMGs: save the bitmap's natural pixels — element screenshots came
          // out half-white when an overflow/carousel parent clipped the img,
          // and cannot see hidden panes at all. toDataURL throws on a tainted
          // canvas → null → fall back to the element screenshot.
          const data = await els[i].evaluate((el) => {
            if (el.tagName !== 'IMG' || !el.naturalWidth) return null
            const c = document.createElement('canvas')
            c.width = el.naturalWidth
            c.height = el.naturalHeight
            c.getContext('2d').drawImage(el, 0, 0)
            return c.toDataURL('image/png').split(',')[1]
          }).catch(() => null)
          if (data) fs.writeFileSync(f, Buffer.from(data, 'base64'))
          else await els[i].screenshot({ path: f })
          figs.push(f)
        } catch { /* detached/unpaintable — skip */ }
      }
      const pdf = path.join(dir, `rendered-${srcIdx}.pdf`)
      await pg.pdf({ path: pdf, format: 'Letter', printBackground: true })
      return { pdf, figs }
    } finally { await browser.close() }
  }

  async function prepare(job) {
    if (job.prepared) return job.prepared // retry reuses the converted inputs
    const out = { paths: [], figs: [] }
    for (const [i, s] of (job.sources || []).entries()) {
      if (/\.mht(ml)?$/i.test(s.name)) {
        const { pdf, figs } = await renderMhtml(s.file, job.dir, i, out.figs.length)
        out.paths.push(pdf)
        out.figs.push(...figs)
      } else {
        const p = convertUpload(s.file, i, job.dir, s.name, s.mediaType)
        out.paths.push(p)
        // uploaded images double as attachable figures (kept under their own
        // filenames, so "1.11 fig 2.png" can be matched to its question)
        if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(p)) out.figs.push(p)
      }
    }
    job.prepared = out
    return out
  }

  // Figure filenames the agent referenced → files copied into the served
  // figure store, references rewritten to their /study-api/figure URLs.
  function publishFigures(job, list) {
    fs.mkdirSync(FIG_DIR, { recursive: true })
    const map = new Map()
    const resolve = (ref) => {
      const base = path.basename(String(ref || ''))
      if (!base) return ''
      if (map.has(base)) return map.get(base)
      const src = path.join(job.dir, base)
      let url = ''
      if (fs.existsSync(src)) {
        const pub = `sf-${job.id}-${map.size + 1}${path.extname(base).toLowerCase() || '.png'}`
        fs.copyFileSync(src, path.join(FIG_DIR, pub))
        url = `/study-api/figure?f=${pub}`
      }
      map.set(base, url)
      return url
    }
    for (const q of list) {
      q.figures = (Array.isArray(q.figures) ? q.figures : []).map(resolve).filter(Boolean)
      for (const p of q.parts || []) for (const o of p.options || []) o.figure = resolve(o.figure)
    }
    return list
  }

  async function runJob(job) {
    job.phase = 'converting'
    job.startedAt = Date.now()
    try {
      const { paths, figs } = await prepare(job)
      const prompt = PROMPTS[job.target](job.categories, paths, job.text, figs).filter(Boolean).join('\n\n')
      const { images, text: fileText } = readAttachments([...paths, ...figs])
      const fullPrompt = fileText ? `${prompt}\n\n${fileText}` : prompt
      const data = await askClaude(fullPrompt, SCHEMAS[job.target], job.cred, images)
      const list = (job.target === 'cards' ? data.cards : data.questions) || []
      job.results = job.target === 'cards' ? list : publishFigures(job, list)
      job.phase = 'ready'
    } catch (e) {
      job.phase = 'error'
      job.error = e.message
    }
    schedule()
  }

  function schedule() {
    let running = [...jobs.values()].filter((j) => j.phase === 'converting').length
    for (const j of jobs.values()) {
      if (running >= CONCURRENCY) break
      if (j.phase !== 'queued') continue
      running++
      runJob(j) // async; never throws (runJob catches)
    }
  }

  function enqueue(body, cred) {
    if (!cred) throw fail(400, 'no_ai_provider')
    const target = body.target === 'cards' ? 'cards' : 'questions'
    const text = String(body.text || '').slice(0, 200000)
    const files = Array.isArray(body.files) ? body.files : []
    if (!files.length && !text.trim()) throw fail(400, 'nothing to extract from')
    const base = {
      target,
      tabId: String(body.tabId || ''),
      tabName: String(body.tabName || 'course'),
      categories: (Array.isArray(body.categories) ? body.categories : []).map(String).slice(0, 100),
    }
    const kindWord = target === 'cards' ? 'cards' : 'questions'
    const ids = []
    const newDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-study-job-'))
    // Uploads keep their (sanitized) original filenames on disk — the agent
    // matches figure images to documents by name, so "source-3.png" naming
    // would destroy exactly the signal it needs.
    const writeSource = (f, i, dir, id) => {
      const name = path.basename(String(f.name || `upload-${id}-${i}`)).replace(/[\\/:*?"<>|#]/g, '-').trim() || `upload-${id}-${i}`
      const ext = (path.extname(name).slice(1) || (String(f.media_type) === 'application/pdf' ? 'pdf' : String(f.media_type || '').split('/')[1]) || 'bin').toLowerCase()
      let stem = name.replace(/\.[^.]*$/, '')
      if (/^(fig-\d+|rendered-\d+)$/i.test(stem)) stem = `up-${stem}` // never shadow capture names
      let file = path.join(dir, `${stem}.${ext}`)
      for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${stem}-${n}.${ext}`)
      fs.writeFileSync(file, Buffer.from(f.data, 'base64'))
      return { file, name, mediaType: String(f.media_type || '') }
    }
    const newJob = (id, dir, sources, jobText, label) =>
      jobs.set(id, { ...base, id, dir, sources, text: jobText, label, phase: 'queued', error: '', results: null, startedAt: 0, prepared: null, cred, switched: false })
    const oneJob = (group, label) => {
      const id = ++jobSeq
      const dir = newDir()
      const sources = group.map((f, i) => writeSource(f, i, dir, id))
      newJob(id, dir, sources, '', label(sources))
      ids.push(id)
    }
    // Smart bundle split: one agent per DOCUMENT, each with its name-matched
    // figure images ("1.11 fig 2.png" rides with "…Homework 1.11.mhtml") — a
    // single agent digesting 13 assignments extracted ~1 question each. An
    // all-image bundle (screenshots of ONE assignment) stays a single job.
    // ponytail: matching is exact-token only; no way to force one agent
    // across several documents — split per doc is always right so far.
    const isImg = (f) => /\.(png|jpe?g|gif|webp|bmp|hei[cf])$/i.test(String(f.name || '')) || /^image\//i.test(String(f.media_type || ''))
    const stripExt = (n) => String(n).replace(/\.[^.]*$/, '')
    const tokens = (s) => String(s).toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean).map((t) => t.replace(/\.+$/, ''))
    const matchDoc = (img, docs) => {
      // key = the part before a "fig"/"figure" marker, else the whole stem.
      // Only the no-marker branch strips an extension — stripping the marker
      // branch turned "1.11 " into "1" (the regex ate ".11") and matched HW 1.
      const n = String(img.name || '')
      const m = /\bfig(?:ure)?\b/i.exec(n)
      const keyToks = tokens(m ? n.slice(0, m.index) : stripExt(n))
      if (!keyToks.length) return null
      const hits = docs.filter((d) => { const dt = tokens(stripExt(d.name)); return keyToks.every((t) => dt.includes(t)) })
      return hits.length === 1 ? hits[0] : null // ambiguous → leftover group
    }
    if (body.bundle && files.length > 1) {
      const docs = files.filter((f) => !isImg(f))
      if (!docs.length) {
        oneJob(files, (s) => `${s[0].name} +${s.length - 1} more → ${base.tabName} ${kindWord}`)
      } else {
        const byDoc = new Map(docs.map((d) => [d, [d]]))
        const leftover = []
        for (const im of files.filter(isImg)) {
          const d = matchDoc(im, docs)
          if (d) byDoc.get(d).push(im)
          else leftover.push(im)
        }
        for (const group of byDoc.values()) {
          oneJob(group, (s) => `${s[0].name}${s.length > 1 ? ` (+${s.length - 1} fig${s.length > 2 ? 's' : ''})` : ''} → ${base.tabName} ${kindWord}`)
        }
        if (leftover.length) oneJob(leftover, (s) => `${s[0].name}${s.length > 1 ? ` +${s.length - 1} more` : ''} → ${base.tabName} ${kindWord}`)
      }
    } else {
      for (const f of files) { // one agent per file, each its own queue card
        oneJob([f], (s) => `${s[0].name} → ${base.tabName} ${kindWord}`)
      }
    }
    if (text.trim()) {
      const id = ++jobSeq
      newJob(id, newDir(), [], text, `${text.trim().slice(0, 32)}${text.trim().length > 32 ? '…' : ''} → ${base.tabName} ${kindWord}`)
      ids.push(id)
    }
    schedule()
    return { ids }
  }

  const jobSummary = (j) => ({ id: j.id, target: j.target, tabId: j.tabId, tabName: j.tabName, label: j.label, phase: j.phase, error: j.error, startedAt: j.startedAt, count: j.results?.length ?? 0, switched: !!j.switched })

  const handler = async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const json = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) }
    try {
      if (req.method === 'GET') {
        if (u.pathname === '/jobs') return json(200, { jobs: [...jobs.values()].map(jobSummary) })
        if (u.pathname === '/job') {
          const j = jobs.get(Number(u.searchParams.get('id')))
          return j ? json(200, { ...jobSummary(j), results: j.results }) : json(404, { error: 'no such job' })
        }
        if (u.pathname === '/figure') {
          const f = path.basename(u.searchParams.get('f') || '')
          const abs = path.join(FIG_DIR, f)
          if (!/^sf-[\w.-]+$/.test(f) || !fs.existsSync(abs)) return json(404, { error: 'no such figure' })
          res.setHeader('Content-Type', { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg' }[path.extname(f).slice(1)] || 'application/octet-stream')
          res.setHeader('Cache-Control', 'max-age=31536000, immutable')
          return res.end(fs.readFileSync(abs))
        }
        return json(404, { error: 'unknown study-api endpoint' })
      }
      if (req.method !== 'POST') return json(405, { error: 'GET or POST only' })
      if (u.pathname === '/job/retry') {
        const j = jobs.get(Number(u.searchParams.get('id')))
        if (!j) return json(404, { error: 'no such job' })
        if (j.phase === 'error') { j.phase = 'queued'; j.error = ''; schedule() }
        return json(200, { ok: true })
      }
      if (u.pathname === '/job/remove') {
        const j = jobs.get(Number(u.searchParams.get('id')))
        if (j) { jobs.delete(j.id); fs.rmSync(j.dir, { recursive: true, force: true }) }
        return json(200, { ok: true }) // figures already copied out — bank references stay valid
      }
      const body = await readBody(req)
      if (u.pathname === '/extract') return json(200, enqueue(body, credsFromRequest(req, body)))
      if (u.pathname === '/chat') {
        const transcript = (Array.isArray(body.transcript) ? body.transcript : []).slice(-30)
        return json(200, await askClaude(chatPrompt({ ...body, transcript }).filter(Boolean).join('\n\n'), SCHEMAS.chat, credsFromRequest(req, body)))
      }
      if (u.pathname === '/judge') {
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 20)
        if (!items.length) throw fail(400, 'no items to judge')
        return json(200, await askClaude(judgePrompt(items).filter(Boolean).join('\n\n'), SCHEMAS.judge, credsFromRequest(req, body)))
      }
      json(404, { error: 'unknown study-api endpoint' })
    } catch (err) {
      json(err.code >= 400 && err.code <= 599 ? err.code : 500, { error: err.message })
    }
  }
  return handler
}


// Claude subscription-OAuth token broker. The browser can't POST to
// Anthropic's token endpoint (CORS), and the exchange must carry the PKCE
// code_verifier, so the code-exchange + refresh run here. NEVER logs tokens.
// See src/page/ai.js for the client half (PKCE, redirect, storage).
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback'

async function claudeToken(payload) {
  let res
  try {
    res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch (e) { throw fail(502, `couldn't reach Anthropic — ${e.message}`) }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw fail(res.status === 400 || res.status === 401 ? 400 : 502, data?.error_description || data?.error || `token request failed (${res.status})`)
  // Never return/log the raw provider payload — only the three fields the
  // client stores.
  return { access: data.access_token, refresh: data.refresh_token, expires: data.expires_in }
}

function aiOauthApi() {
  return async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const json = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) }
    try {
      if (req.method !== 'POST') return json(405, { error: 'POST only' })
      const body = await readBody(req)
      if (u.pathname === '/claude/exchange') {
        if (!body.code || !body.verifier) return json(400, { error: 'missing code or verifier' })
        return json(200, await claudeToken({
          grant_type: 'authorization_code',
          code: body.code,
          state: body.state,
          client_id: OAUTH_CLIENT_ID,
          redirect_uri: OAUTH_REDIRECT_URI,
          code_verifier: body.verifier,
        }))
      }
      if (u.pathname === '/claude/refresh') {
        if (!body.refresh) return json(400, { error: 'missing refresh token' })
        return json(200, await claudeToken({
          grant_type: 'refresh_token',
          refresh_token: body.refresh,
          client_id: OAUTH_CLIENT_ID,
        }))
      }
      json(404, { error: 'unknown ai-oauth endpoint' })
    } catch (err) {
      json(err.code >= 400 && err.code <= 599 ? err.code : 500, { error: err.message })
    }
  }
}


// ---- public surface ---------------------------------------------------------
// The Atlas backend that isn't the sync server: local proxies and tooling that
// need a Node process. These used to exist only while `vite` was running, which
// made the desktop app depend on a dev server. Both hosts now mount the same
// handlers — vite.config.js for development, electron/host.js for the packaged
// app — so closing the dev server no longer takes these endpoints with it.
//
// Handlers are connect-style (req, res, next) and expect req.url with the mount
// prefix ALREADY STRIPPED ('/chat', not '/study-api/chat'), because that is what
// connect's mounting does. Any host must strip it the same way.
export const MIDDLEWARES = [
  // MOVED TO THE SERVER. Pure network proxies with no local state, so they run
  // on the home server now; remote() forwards the identical prefix there. The client
  // still fetches the same root-relative paths, which is the whole point.
  { prefix: '/canvas-proxy', handler: remote('/canvas-proxy') },
  { prefix: '/finance-api', handler: remote('/finance-api') },
  // The server half of the synced notes folder. Same reverse-proxy trick: the
  // page fetches a same-origin path and the session token is attached here.
  { prefix: '/notes-sync', handler: remote('/notes-sync') },
  // STILL LOCAL, and not because of missing Linux tooling — the DATA is here.
  // graph reads a graphify corpus and opens a native folder dialog; notes reads
  // the Apple Notes store and a vault path that came from a Finder dialog.
  { prefix: '/graph-api', handler: graphApi() },
  { prefix: '/notes-api', handler: notesApi() },
  // Claude subscription-OAuth broker — CORS-blocked from the browser, and the
  // token exchange must carry the PKCE verifier. Pure network, no local state.
  { prefix: '/ai-oauth', handler: aiOauthApi() },
  // STILL LOCAL, but no longer for a `claude` CLI login reason — extraction
  // now calls out over HTTP with the user's own AI credentials (askClaude →
  // llm.js), same as chat/judge. What's left local is headless Chromium
  // (mhtml → PDF + figure screenshots for WebAssign printouts) and the
  // in-memory job queue. Moving this would buy real compute relief (4
  // concurrent agents + Chromium off this machine) whenever that's worth doing.
  { prefix: '/study-api', handler: studyApi() },
]
