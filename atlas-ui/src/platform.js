// The only platform/mobile detector. The native Swift shell injects
// window.__ATLAS_NATIVE__ = { platform: 'ios' | 'macos' } at document start.
// "Mobile" = native iOS OR any window under 820px — every other module asks
// isMobile(), never re-derives a media query of its own.

export const nativePlatform = () =>
  (typeof window !== 'undefined' && window.__ATLAS_NATIVE__ && window.__ATLAS_NATIVE__.platform) || null

export const isNative = () => nativePlatform() !== null
export const isNativeIOS = () => nativePlatform() === 'ios'

export const MOBILE_MQ = (typeof window !== 'undefined' && window.matchMedia)
  ? window.matchMedia('(max-width: 820px)')
  : { matches: false, addEventListener() {} }

export const isMobile = () => isNativeIOS() || MOBILE_MQ.matches

// Applies the is-mobile / is-native-ios classes to <body> and keeps them in
// sync as the viewport crosses the breakpoint; onChange fires on every
// re-apply so callers can re-render layout-sensitive UI.
// Callable twice on purpose: main.js calls it before the login gate paints (so
// a phone never shows the desktop shell), and renderer.js calls it again once
// there is something to re-render. Only the first call wires the listener; the
// later one just supplies the callback, so the app never accumulates duplicate
// media-query handlers.
let mqWired = false
let notify = null

export function initPlatform(onChange) {
  if (onChange) notify = onChange
  const apply = () => {
    if (typeof document === 'undefined') return
    document.body.classList.toggle('is-mobile', isMobile())
    document.body.classList.toggle('is-native-ios', isNativeIOS())
  }
  apply()
  if (!mqWired && MOBILE_MQ.addEventListener) {
    mqWired = true
    MOBILE_MQ.addEventListener('change', () => { apply(); notify && notify() })
  }
  return apply
}
