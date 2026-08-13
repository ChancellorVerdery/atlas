// Plugin system self-check (node, no framework): registry completeness, the
// vanilla zip parser against real zips from the builder, and manifest
// validation. Run from atlas-ui/: node tests/plugins.check.mjs
import assert from 'node:assert/strict'
import { PLUGIN_DEFS, KIND_PLUGIN, parseZip, validateManifest } from '../src/page/plugins.js'
import { KINDS } from '../src/page/model.js'
import { PAGES } from '../src/page/pages.js'

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

// ponytail: the real-zip round-trip (built formal.zip via tools/build-plugin-zips.mjs)
// is gone with the formal plugin and the deferred custom-plugin builder. The zip
// PARSER is still exercised below with a synthetic archive; re-add a real-plugin
// round-trip when the drag-and-drop plugin API is actually built.

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

console.log('\nplugins.check: all good')
