// Wrap a Storage's setItem so every write through it also runs `onWrite`.
//
// The hook goes on Storage.prototype, NOT on the storage object. Storage has a
// WebIDL named-property setter, so `localStorage.setItem = fn` is an ITEM write:
// WebKit stores a string item called "setItem" (the function's source text) and
// keeps dispatching setItem() to the real prototype method — the hook silently
// never installs. Chromium happens to shadow the method instead, which is why
// this worked for months in Electron and died the day the app moved into the
// Swift WKWebView shell (iOS is the same engine). Symptom: nothing pushes, and
// every hydrate pulls the server's stale copy over the user's edits.
//
// Test shims use a plain object with an own setItem; those are patched in place.
export function installStorageHook(storage, onWrite) {
  const target = Object.hasOwn(storage, 'setItem') ? storage : Object.getPrototypeOf(storage)
  const real = target.setItem
  target.setItem = function (k, v) {
    const r = real.call(this, k, v)
    if (this === storage) onWrite(k, v)
    return r
  }
  // Sweep the junk item the old assignment left behind in WebKit stores.
  try { if (storage.getItem('setItem') != null) storage.removeItem('setItem') } catch {}
}
