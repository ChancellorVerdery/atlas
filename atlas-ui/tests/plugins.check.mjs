// Plugin system self-check (node, no framework): registry completeness, the
// vanilla zip parser against real zips from the builder, and manifest
// validation. Run from atlas-ui/: node tests/plugins.check.mjs
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_DEFS, KIND_PLUGIN, parseZip, validateManifest } from '../src/page/plugins.js'
import { KINDS } from '../src/page/model.js'
import { PAGES } from '../src/page/pages.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

// 1. Registry completeness — every widget kind maps to core or a real plugin,
//    every non-dashboard page is a plugin, no orphans in either direction.
for (const k of KINDS) assert.ok(k in KIND_PLUGIN, `kind "${k}" missing from KIND_PLUGIN`)
for (const k of Object.keys(KIND_PLUGIN)) assert.ok(KINDS.has(k), `KIND_PLUGIN has unknown kind "${k}"`)
const ids = new Set(PLUGIN_DEFS.map((p) => p.id))
assert.equal(ids.size, PLUGIN_DEFS.length, 'duplicate plugin ids')
for (const owner of Object.values(KIND_PLUGIN)) {
  if (owner != null) assert.ok(ids.has(owner), `KIND_PLUGIN references unknown plugin "${owner}"`)
}
for (const p of PAGES) {
  if (p.id === 'dashboard') continue
  assert.ok(ids.has(p.id), `page "${p.id}" has no plugin def`)
}
for (const id of ids) assert.ok(PAGES.some((p) => p.id === id), `plugin "${id}" has no page`)
console.log('ok registry: kinds, pages, and plugin defs all agree')

// 2. Zip parser against a real builder zip (deflated entries).
execSync('node tools/build-plugin-zips.mjs', { cwd: ROOT, stdio: 'pipe' })
const zipBytes = readFileSync(join(ROOT, 'plugins-dist', 'formal.zip'))
const entries = await parseZip(zipBytes.buffer.slice(zipBytes.byteOffset, zipBytes.byteOffset + zipBytes.byteLength))
assert.ok(entries.has('plugin.json'), 'plugin.json missing from parsed zip')
assert.ok(entries.has('src/formal.js') && entries.has('src/formalui.js'), 'source files missing from parsed zip')
const manifest = JSON.parse(new TextDecoder().decode(entries.get('plugin.json')))
assert.equal(manifest.id, 'formal')
assert.equal(manifest.format, 1)
assert.equal(validateManifest(manifest), null)
// decompressed content must be the actual source, byte-identical
const original = readFileSync(join(ROOT, 'atlas-ui', 'src', 'page', 'formal.js'))
assert.ok(Buffer.from(entries.get('src/formal.js')).equals(original), 'inflated src/formal.js differs from the original')
console.log('ok zip parser: manifest + sources inflate byte-identical')

// 3. Manifest validation rejects the right things.
const base = { format: 1, id: 'weather', name: 'Weather', version: '1.0.0' }
assert.equal(validateManifest(base), null)
for (const [patch, why] of [
  [{ format: 2 }, 'future format'],
  [{ id: 'Weather!' }, 'bad id'],
  [{ id: '' }, 'empty id'],
  [{ name: '' }, 'empty name'],
  [{ version: '' }, 'empty version'],
]) {
  assert.ok(validateManifest({ ...base, ...patch }) !== null, `should reject: ${why}`)
}
assert.ok(validateManifest(null) !== null, 'should reject null')
console.log('ok manifest validation')

// 4. Corrupt input errors cleanly, not cryptically.
await assert.rejects(() => parseZip(new Uint8Array([1, 2, 3, 4]).buffer), /not a zip/)
console.log('ok corrupt zip rejected')

// 5. An archive comment containing the EOCD signature bytes must not fool the
//    backwards scan (candidates are validated by comment-length-reaches-EOF).
{
  const plain = new Uint8Array(zipBytes)
  const comment = new Uint8Array([0x61, 0x62, 0x50, 0x4b, 0x05, 0x06, 0x63, 0x64]) // "ab<PK\5\6>cd"
  const commented = new Uint8Array(plain.length + comment.length)
  commented.set(plain)
  commented.set(comment, plain.length)
  // patch the REAL EOCD's comment-length field (last record, comment was 0)
  const view = new DataView(commented.buffer)
  view.setUint16(plain.length - 22 + 20, comment.length, true)
  const e2 = await parseZip(commented.buffer)
  assert.ok(e2.has('plugin.json'), 'commented zip failed to parse')
  console.log('ok EOCD-lookalike bytes in the archive comment do not break parsing')
}

console.log('\nplugins.check: all good')
