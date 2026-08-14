// The page/plugin registry. Every entry is a full customizable page — same
// rows/sections/lines/widgets machinery, its own storage, and a palette
// restricted to its declared widget kinds. Adding a future plugin = one
// entry here + its widget kind(s) in model.js (newWidget/KINDS) and
// view.js (widgetHTML).

import { isPluginEnabled } from './plugins.js'
import { isMobile } from '../platform.js'

export const PAGES = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    crumb: 'Atlas / Dashboard',
    storageKey: 'atlas.page.v1',
    kinds: ['card', 'list', 'graph', 'eqcard', 'eqlist', 'gymcurrent', 'gymnext', 'gymscore', 'gymscoregraph', 'gymexercises', 'gymvolume', 'calagenda', 'calmonth', 'cvgradebook', 'cvupcoming', 'cvannounce', 'cvoverdue', 'cvgpa', 'cvsemesters', 'cvcourses', 'cvtodo', 'wkincome', 'wkshifts', 'wkhistory', 'wktipshare', 'wkupcoming', 'slbedtime', 'sllog', 'slhours', 'sldebt'],
  },
  {
    id: 'gym',
    label: 'Gym',
    crumb: 'Atlas / Gym',
    storageKey: 'atlas.page.gym.v1',
    kinds: ['gymcurrent', 'gymnext', 'gymscore', 'gymscoregraph', 'gymexercises', 'gymvolume'],
    settings: 'gym', // has a plugin-scoped settings tab (renderer routes #/gym/settings)
  },
  {
    id: 'email',
    label: 'Email',
    crumb: 'Atlas / Email',
    full: true, // widgetless: the plugin renders the whole content area itself
  },
  {
    id: 'calendar',
    label: 'Calendar',
    crumb: 'Atlas / Calendar',
    full: true, // full-window page; its dashboard widgets are calagenda/calmonth
  },
  {
    id: 'canvas',
    label: 'Canvas',
    crumb: 'Atlas / Canvas',
    storageKey: 'atlas.page.canvas.v1',
    kinds: ['cvgradebook', 'cvupcoming', 'cvannounce', 'cvoverdue', 'cvgpa', 'cvsemesters', 'cvcourses', 'cvtodo'],
    settings: 'canvas', // connection, grade scale, credits, previous semesters
  },
  {
    id: 'work',
    label: 'Work',
    crumb: 'Atlas / Work',
    storageKey: 'atlas.page.work.v1',
    kinds: ['wkincome', 'wkshifts', 'wkhistory', 'wktipshare', 'wkupcoming'],
    settings: 'work', // hourly wage, tip position toggle, open-ended shifts
  },
  {
    id: 'ladder',
    label: 'Ladder',
    crumb: 'Atlas / Ladder',
    full: true, // widgetless timeline planner
    settings: 'ladder', // sleep window, home address, planning window, drive cushion, meals
  },
  {
    id: 'sleep',
    label: 'Sleep',
    crumb: 'Atlas / Sleep',
    storageKey: 'atlas.page.sleep.v1',
    kinds: ['slbedtime', 'sllog', 'slhours', 'sldebt'],
    settings: 'sleep', // preferred sleep/bedtime, debt window, recovery ratio, nap credit
  },
  {
    id: 'equations',
    label: 'Equations',
    crumb: 'Atlas / Equations',
    storageKey: 'atlas.page.equations.v1',
    kinds: ['eqcard', 'eqlist'],
  },
  {
    id: 'notes',
    label: 'Notes',
    crumb: 'Atlas / Notes',
    full: true, // widgetless: folder picker + note browser + upload-to-markdown flow
  },
  {
    id: 'study',
    label: 'Study',
    crumb: 'Atlas / Study',
    full: true, // widgetless: course tabs → tutor chat, question bank
  },
  {
    id: 'flashcards',
    label: 'Flashcards',
    crumb: 'Atlas / Flashcards',
    full: true, // widgetless: course tabs → flashcards, card bank (split out of Study, 2026-08)
  },
  {
    id: 'course',
    label: 'Course Planner',
    crumb: 'Atlas / Course Planner',
    full: true, // widgetless: the Planner page (semesters + classes entry)
    explore: 'Map', // second tab: the zoomable degree-route board
    settings: 'course', // max credits, summer cap, route strategy
  },
]

export const pageById = (id) => PAGES.find((p) => p.id === id)

// ---- nav order ---------------------------------------------------------
// Persisted, user-set order of pages in the left nav (dragged in renderer.js).
// Rides the generic page.save sync path — any atlas.* key syncs automatically
// (see sync.js's encodePush) — so reordering on one device carries to every
// other device on the same account without a dedicated wire code.
const NAV_ORDER_KEY = 'atlas.navOrder.v1'
export function loadNavOrder() {
  try { const a = JSON.parse(localStorage.getItem(NAV_ORDER_KEY)); return Array.isArray(a) ? a : [] } catch { return [] }
}
export function saveNavOrder(order) { localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(order)) }

// Pure order-resolution — no localStorage, no DOM, unit-tested directly
// (tests/navorder.check.mjs): registryIds filtered to enabledIds (disabled
// pages excluded), then sorted by `order` — ids `order` lists sort first, in
// that order; any id `order` doesn't mention (a new plugin, or navOrder
// predates it) falls back to registry order, appended after the known ones.
export function resolveNavOrder(registryIds, enabledIds, order) {
  const enabledSet = new Set(enabledIds)
  const ids = registryIds.filter((id) => enabledSet.has(id))
  if (!Array.isArray(order) || !order.length) return ids
  const idSet = new Set(ids)
  const known = order.filter((id) => idSet.has(id))
  const knownSet = new Set(known)
  return [...known, ...ids.filter((id) => !knownSet.has(id))]
}

// Pages whose plugin is currently enabled — what the nav and router see —
// sorted by the persisted nav order (registry order when none is set yet).
// Dashboard is core; every other page's id doubles as its plugin id.
export const activePages = () => {
  const registryIds = PAGES.map((p) => p.id)
  const mobile = isMobile()
  const enabledIds = registryIds.filter((id) => id === 'dashboard' || isPluginEnabled(id))
    .filter((id) => !(mobile && id === 'course')) // Course Planner is desktop-only
  return resolveNavOrder(registryIds, enabledIds, loadNavOrder()).map(pageById)
}
