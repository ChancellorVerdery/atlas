// Shared plugin fixtures: the seeded localStorage payload for each in-tree
// plugin, plus the retired list and the sync exemptions.
//
// Extracted verbatim from sync-array-coverage.check.mjs so ddl-columns.check.mjs
// can reuse it. Both checks ask a question that only a NON-EMPTY shape can
// answer -- "do element fields survive a round trip" and "do the columns of a
// per-row table exist" -- and both were blind for the same reason: a mapper fed
// the loader's default shape emits no rows for any per-row table. One copy of
// the fixtures, so a field added to a UI writer is taught to both checks at once
// and neither can silently drift behind the other.
//
// Fixture provenance: every element field is copied from the UI writer that
// creates it, cited inline. They are not invented, and a field the UI never
// writes is deliberately absent -- a fixture richer than reality would report
// drops that cannot happen.
//
// This module installs the localStorage stub on import and exports the backing
// Map. Loaders read localStorage at CALL time, not import time, so a consumer
// seeds it per plugin with seedFor() below.
export const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
}
// Date-keyed fixtures must be recent: several loaders prune entries older than a
// cutoff (gym's OVERRIDE_KEEP_DAYS is 90), so a hardcoded past date would be
// silently dropped by the loader and the check would test nothing.
const d = new Date()
export const TODAY = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const PLUGINS = [
  {
    name: 'gym', module: 'gym.js', loader: 'loadGym', key: 'atlas.gym.v1',
    // addWorkout gym.js:103, addExercise gym.js:117, logSet gym.js:168-169,
    // completions gym.js:288, overrides/extras are date-keyed (gym.js:59,66).
    seed: {
      workouts: [{ id: 'gw1', name: 'Chest & Back' }],
      exercises: [{ id: 'ge1', workoutId: 'gw1', name: 'Bench', unilateral: false }],
      logs: [{ id: 'gl1', exerciseId: 'ge1', date: TODAY, side: null, sets: [{ weight: 135, reps: 8 }] }],
      completions: [{ workoutId: 'gw1', date: TODAY, ts: 1757000000000, start: '17:00', end: '18:10' }],
      plan: { type: 'cycle', cycle: { order: ['gw1'], position: 0 }, overrides: { [TODAY]: 'gw1' }, extras: { [TODAY]: ['ge1'] } },
    },
  },
  {
    name: 'work', module: 'work.js', loader: 'loadWork', key: 'atlas.work.v1',
    // addShift work.js:128-137, addUpcoming work.js:210.
    seed: {
      shifts: [{ id: 'ws1', date: TODAY, start: '09:00', end: '17:00', hours: null, tips: 40, wage: 15 }],
      upcoming: [{ id: 'wu1', date: TODAY, start: '09:00', end: '17:00', endMode: 'est', gcalId: 'g1' }],
      ranges: { w1: 'month' },
      histPer: { w1: 10 },
    },
  },
  {
    name: 'sleep', module: 'sleep.js', loader: 'loadSleep', key: 'atlas.sleep.v1',
    // addLog sleep.js:45-58. quality is optional and only set when 1..5.
    seed: {
      logs: [
        { id: 'sl1', type: 'night', date: TODAY, start: '23:00', end: '07:00', minutes: 480, quality: 4 },
        { id: 'sl2', type: 'nap', date: TODAY, minutes: 25 },
      ],
    },
  },
  {
    name: 'canvas', module: 'canvas.js', loader: 'loadCanvas', key: 'atlas.canvas.v1',
    // semesters canvasui.js:567, nested classes canvasui.js:581, scaleModes canvasui.js:549.
    seed: {
      semesters: [{ id: 'sm1', name: 'Fall 25', gpa: '3.8', credits: '15', classes: [{ id: 'cl1', name: 'Calc', grade: 'A', credits: '4' }] }],
      dismissed: ['c1:a1'],
      hiddenCourses: ['c2'],
      scaleModes: { c1: 'letters', c2: 'plusminus' },
    },
  },
  {
    name: 'course', module: 'course.js', loader: 'loadCourse', key: 'atlas.course.v1',
    // Element shape is fully specified by loadCourse's own .map() (course.js:42-60).
    seed: {
      courses: [{ id: 'c1', code: 'MATH 1241', title: 'Calculus I', credits: 4, prereqs: ['c0'], coreqs: ['c2'], summerOk: true, term: 'fall-2025' }],
      terms: [{ season: 'fall', year: 2025, current: true }],
      disabledTerms: ['spring-2026'],
    },
  },
  {
    name: 'ladder', module: 'ladder.js', loader: 'loadLadder', key: 'atlas.ladder.v1',
    // meals default ladder.js:35-39; flex via buildFlexFields ladder.js:93-116
    // (one 'set', one 'attached' — they carry disjoint field sets, so both are
    // needed to cover the union); aliases ladder.js:74; pushed ladder.js:82.
    seed: {
      meals: [{ id: 'lm1', name: 'Breakfast', pref: '08:00', duration: 30, enabled: true }],
      flex: [
        { id: 'lf1', title: 'Study', minutes: 90, kind: 'set', date: TODAY, start: '13:00', end: '14:30', addr: '9201 University City Blvd' },
        { id: 'lf2', title: 'Stretch', minutes: 15, kind: 'attached', side: 'after', place: 'same', anchorTag: 'gym' },
        { id: 'lf3', title: 'Review', minutes: 20, kind: 'attached', side: 'before', place: 'home', anchorId: 'blk1', anchorLabel: 'Physics lecture' },
        { id: 'lf4', title: 'Commute prep', minutes: 10, kind: 'recur', weekday: 2 },
        { id: 'lf5', title: 'Errand', minutes: 30, kind: 'day', date: TODAY },
      ],
      aliases: [{ id: 'la1', match: 'Fretwell', address: '9201 University City Blvd' }],
      geo: { 'some addr': { lat: 35.3, lon: -80.7 } },
      drives: { '35.3,-80.7>35.4,-80.8': 15 },
      gapOverrides: { blk1: 'home' },
      calIds: { gym: 'g1', drives: 'g2', ladder: 'g3' },
      pushed: { [TODAY]: [{ calId: 'g1', id: 'ev1' }] },
    },
  },
  {
    name: 'calendar', module: 'calendar.js', loader: 'loadCal', key: 'atlas.calendar.v1',
    seed: { hiddenCals: ['cal1'], view: 'week' },
  },
  {
    name: 'email', module: 'email.js', loader: 'loadEmail', key: 'atlas.email.v1',
    seed: { pinned: ['msg1'], splitPct: 55 },
  },
]

// Same exemptions as sync-coverage.check.mjs, and for the same reason: loadEmail
// returns a MERGE of two storage keys and saveEmail splits the Google half back
// out, so the mapper drops it on purpose.
export const NOT_SYNCED = {
  email: ['connected', 'address', 'accounts', 'accounts[]'],
}

// The mirror of NOT_SYNCED: key paths a round trip is allowed to ADD that the
// loader's own shape never had. Surveyed across all 10 mappers at the seeded
// fixture depth before the assertion was turned on — the answer was zero
// everywhere, so this is deliberately EMPTY and an addition means something
// changed. A recompose filling in a default is legitimate; put it here with a
// one-line reason rather than loosening the check.
export const ALSO_ADDED = {}

// Exhaustiveness guard. "Covered 8 of 10, the other 2 are unfixable" is only
// true until someone adds an 11th mapper — and the failure mode of a coverage
// check is silence, so drift has to be made loud. RETIRED is the pair whose
// client source is deliberately out of tree (.gitignore: retired-plugin
// archive), so there is nothing a clean checkout could import to compare
// against; that is why finance.vendorRules stayed unmapped for as long as it
// did. Anything else new must be added to PLUGINS or justified here.
export const RETIRED = ['finance', 'graph']

// Seed one plugin's storage key so its own loader -- not the fixture -- decides
// normalized truth.
export function seedFor(p) {
  store.clear()
  store.set(p.key, JSON.stringify(p.seed))
}

// ---------------------------------------------------------------------------
// Retired plugins: a HAND-AUTHORED raw blob, because there is no loader to run.
//
// finance and graph ship their client half only as gitignored plugin zips, so a
// clean checkout has nothing to import and every fixture above is unavailable to
// them. That left finance's 9 tables the only ones in the repo no check reached
// — and finance is the mapper with the worst track record: vendorRules was
// silently dropped on every cloud load until Pass 2 found it.
//
// PROVENANCE, and it matters: this blob is authored from the "Blob shape" header
// comment at the top of services/plugins/finance.js — the mapper's own record of
// what loadFinance() produces — plus its DDL for the per-entry fields the extract
// columns read. It is deliberately NOT derived from decompose(): a fixture read
// off the code under test can only ever agree with it, and would have been just
// as blind to vendorRules as the mapper was. Authored from the documented blob,
// a top-level key the mapper forgets is a FAILING round trip.
//
// It is written already-normalized (all 16 keys normalizeFinance() emits, each
// with a type that survives its own gate), so the mapper's normalizer is a
// no-op on it and any round-trip difference is the mapper's, not the fixture's.
// sync-array-coverage.check.mjs asserts that idempotence rather than trusting it.
//
// LIMIT, stated plainly: with the client half out of tree this compares the
// mapper against ITSELF plus its own documentation. It cannot catch the mapper
// and the real loadFinance() disagreeing about normalization. Closing that needs
// the retired client source, which is a Chancellor decision, not a code change.
export const RETIRED_FIXTURES = {
  finance: {
    clientId: 'cid_test',
    secret: 'sec_test',
    env: 'production',                                    // the non-default branch of the env CHECK
    items: [{ itemId: 'it1', accessToken: 'access-sandbox-1', institutionName: 'Chase', cursor: null }],
    accounts: [{
      account_id: 'ac1', item_id: 'it1', name: 'Checking', mask: '0000',
      type: 'depository', subtype: 'checking',
      balances: { current: 1234.56, available: 1200, iso_currency_code: 'USD' },
    }],
    transactions: [{
      transaction_id: 'tx1', item_id: 'it1', account_id: 'ac1',
      date: '2026-09-01', amount: 12.34, name: 'STARBUCKS 123', merchant_name: 'Starbucks',
      personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' },
      pending: false,
    }],
    // isTransfer:false is the meaningful-false case the DDL calls out: it
    // suppresses the transfer heuristic and must NOT collapse to key-absent.
    overrides: { tx1: { category: 'coffee', isTransfer: false } },
    customCategories: [{ key: 'coffee', label: 'Coffee', color: '#6f4e37' }],
    budgets: { coffee: 40 },
    vendorRules: { starbucks: 'coffee' },                 // the field that was lost
    netWorthHistory: [{ date: '2026-09-01', netWorth: 4321 }],
    dismissedAnomalies: ['tx1'],
    dismissedSubscriptions: ['starbucks'],
    ranges: { w1: 'month' },
    categoryView: { w1: 'pie' },
    lastSync: 1757000000000,
  },

  // graph's blob is the whole plugin: four scalars, "all guaranteed present by
  // loadGraphStore" per the header comment at services/plugins/graph.js:3-4.
  // Authored from that comment, not from decompose(), for the same reason
  // finance's is — see the provenance note above.
  //
  // Every value is deliberately the NON-default branch of its column, so a
  // mapper that dropped a field and let the DDL default fill it back in would
  // still be caught: mode '3d' (default '2d'), md_only true (default false),
  // max_nodes 500 (default 1500), dir non-empty (default '').
  graph: {
    dir: '/Users/x/Notes',
    mode: '3d',
    mdOnly: true,
    maxNodes: 500,
  },
}
