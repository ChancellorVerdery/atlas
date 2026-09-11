// Checks the localStorage write hook installs on a WebIDL-faithful Storage.
// Storage has a named-property setter, so `localStorage.setItem = fn` is an
// item write, not a method override: WebKit stores a string item "setItem" and
// keeps calling the real method. That is how the Swift/WKWebView shell shipped
// with a hook that never installed — no pushes, and every hydrate pulled the
// server's stale copy over the user's edits ("widgets don't persist, theme
// changes back"). Chromium shadows instead, so Electron never showed it.
import assert from 'node:assert/strict'
import { installStorageHook } from '../src/storage-hook.js'

// A Storage that follows the spec's legacy-platform-object [[Set]]: any string
// property assignment on the object itself invokes the named setter (stores an
// item); reads resolve prototype members first, then items.
class FakeStorage {
  constructor() { this.items = new Map() }
  getItem(k) { return this.items.has(k) ? this.items.get(k) : null }
  setItem(k, v) { this.items.set(String(k), String(v)) }
  removeItem(k) { this.items.delete(k) }
}
const spec = (s) => new Proxy(s, {
  set(t, p, v) { if (typeof p === 'string') { t.setItem(p, v); return true } t[p] = v; return true },
  get(t, p, receiver) {
    // Methods run with `this` = the storage object itself, as in a browser.
    if (p in FakeStorage.prototype || p === 'items') { const v = t[p]; return typeof v === 'function' ? v.bind(receiver) : v }
    return typeof p === 'string' && t.items.has(p) ? t.items.get(p) : undefined
  },
  getOwnPropertyDescriptor(t, p) {
    if (typeof p === 'string' && t.items.has(p) && !(p in FakeStorage.prototype)) return { value: t.items.get(p), configurable: true, enumerable: true, writable: true }
    return undefined
  },
})

// 1. The bug, reproduced: assignment stores an item and intercepts nothing.
{
  const raw = new FakeStorage(), ls = spec(raw)
  let ran = 0
  ls.setItem = (k, v) => { ran++; raw.setItem(k, v) }
  ls.setItem('atlas.page.v1', '{}')
  assert.equal(ran, 0, 'assignment must NOT install the hook on a spec Storage')
  assert.match(raw.getItem('setItem'), /^\(k, v\) =>/, 'the function source lands as an item')
  assert.equal(raw.getItem('atlas.page.v1'), '{}', 'the real setItem still ran')
}

// 2. The fix: prototype wrap intercepts, sweeps the junk item, ignores siblings.
{
  const proto = Object.getPrototypeOf(new FakeStorage())
  const realSetItem = proto.setItem
  const raw = new FakeStorage(), ls = spec(raw)
  raw.setItem('setItem', '(k, v) => { junk }')
  const seen = []
  installStorageHook(ls, (k, v) => seen.push([k, v]))
  assert.equal(raw.getItem('setItem'), null, 'junk item swept on install')
  ls.setItem('atlas.theme.v1', '{"preset":"slate"}')
  assert.deepEqual(seen, [['atlas.theme.v1', '{"preset":"slate"}']], 'hook sees the write')
  assert.equal(raw.getItem('atlas.theme.v1'), '{"preset":"slate"}', 'write still lands')
  assert.equal(raw.getItem('setItem'), null, 'no junk item after install')
  // sessionStorage shares the prototype but must not push.
  const sibling = spec(new FakeStorage())
  sibling.setItem('atlas.x', '1')
  assert.equal(seen.length, 1, 'a sibling Storage is not hooked')
  // A write that came through the prototype bypass (origSetItem) is not seen.
  realSetItem.call(raw, 'atlas.y', '2')
  assert.equal(seen.length, 1, 'writes through the captured original do not push')
  proto.setItem = realSetItem
}

// 3. Plain-object shims (the other check files) are patched in place.
{
  const store = new Map()
  const shim = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
  const seen = []
  installStorageHook(shim, (k) => seen.push(k))
  shim.setItem('atlas.z', 1)
  assert.deepEqual(seen, ['atlas.z'])
  assert.equal(store.get('atlas.z'), '1')
  assert.equal(Object.prototype.setItem, undefined, 'Object.prototype untouched')
}

console.log('storage-hook: ok')
