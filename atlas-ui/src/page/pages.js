// The page/plugin registry. Every entry is a full customizable page — same
// rows/sections/lines/widgets machinery, its own storage, and a palette
// restricted to its declared widget kinds. Adding a future plugin = one
// entry here + its widget kind(s) in model.js (newWidget/KINDS) and
// view.js (widgetHTML).

export const PAGES = [
  {
    id: 'dashboard',
    label: 'Dashboard',
    crumb: 'Atlas / Dashboard',
    storageKey: 'atlas.page.v1',
    kinds: ['card', 'list', 'graph', 'eqcard', 'eqlist', 'gymcurrent', 'gymnext', 'gymscore', 'gymscoregraph', 'gymexercises', 'gymvolume', 'calagenda', 'calmonth', 'cvgradebook', 'cvupcoming', 'cvannounce', 'cvoverdue', 'cvgpa', 'cvsemesters', 'cvcourses', 'cvtodo', 'wkincome', 'wkshifts', 'wkhistory', 'wktipshare', 'wkupcoming', 'gfgraph', 'fintopspend', 'finrecent', 'fincategory', 'finsubs', 'finaccounts', 'finincexp', 'finbudget', 'finnetworth', 'finanomaly', 'slbedtime', 'sllog', 'slhours', 'sldebt', 'fmhouses', 'fmexpenses'],
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
    id: 'graph',
    label: 'Graph',
    crumb: 'Atlas / Graph',
    full: true, // full-window force graph; its dashboard widget is gfgraph
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
    id: 'finance',
    label: 'Finances',
    crumb: 'Atlas / Finances',
    storageKey: 'atlas.page.finance.v1',
    kinds: ['fintopspend', 'finrecent', 'fincategory', 'finsubs', 'finaccounts', 'finincexp', 'finbudget', 'finnetworth', 'finanomaly'],
    settings: 'finance', // Plaid connection, sync, budgets, custom categories
    explore: true, // Explore tab: every synced transaction, filter/search/export
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
    full: true, // widgetless: course tabs → tutor chat, question bank, flashcards, card bank
  },
  {
    id: 'formal',
    label: 'Formal',
    crumb: 'Atlas / Formal',
    storageKey: 'atlas.page.formal.v1',
    kinds: ['fmhouses', 'fmexpenses'],
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
