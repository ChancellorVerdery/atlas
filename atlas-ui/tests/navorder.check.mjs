// navOrder resolution self-check (node, no framework, no DOM): the pure sort
// powering activePages() (src/page/pages.js) — ids in the persisted order
// sort first in that order, unknown/new ids fall back to registry order
// appended after, and disabled pages never appear at all.
// Run from atlas-ui/: node tests/navorder.check.mjs
import assert from 'node:assert/strict'
import { resolveNavOrder } from '../src/page/pages.js'

const registry = ['dashboard', 'gym', 'canvas', 'work', 'sleep', 'equations']

// 1. No persisted order — registry order, filtered to enabled.
assert.deepEqual(
  resolveNavOrder(registry, ['dashboard', 'gym', 'work'], []),
  ['dashboard', 'gym', 'work'],
  'no order: registry order, disabled excluded',
)

// 2. A full persisted order re-sorts the enabled ids to match it exactly.
assert.deepEqual(
  resolveNavOrder(registry, registry, ['sleep', 'dashboard', 'work', 'gym', 'canvas', 'equations']),
  ['sleep', 'dashboard', 'work', 'gym', 'canvas', 'equations'],
  'full order applies exactly',
)

// 3. Unknown/new ids (not in the persisted order — e.g. a plugin enabled
//    after the order was saved) fall back to registry order, appended after
//    the known ones.
assert.deepEqual(
  resolveNavOrder(registry, registry, ['work', 'dashboard']),
  ['work', 'dashboard', 'gym', 'canvas', 'sleep', 'equations'],
  'ids missing from the order keep registry order, appended',
)

// 4. Disabled pages are excluded even if the persisted order still lists
//    them (e.g. a plugin toggled off after being reordered).
assert.deepEqual(
  resolveNavOrder(registry, ['dashboard', 'canvas'], ['sleep', 'canvas', 'dashboard', 'gym']),
  ['canvas', 'dashboard'],
  'disabled pages never appear, even if the order still lists them',
)

// 5. Order entries referencing an id absent from the registry entirely (a
//    page removed from Atlas, or corrupt storage) are silently ignored.
assert.deepEqual(
  resolveNavOrder(registry, ['dashboard'], ['ghost-page', 'dashboard']),
  ['dashboard'],
  'order entries for unknown/removed ids are ignored',
)

console.log('ok resolveNavOrder: order applied, unknown ids appended, disabled excluded, stale ids ignored')
console.log('\nnavorder.check: all good')
