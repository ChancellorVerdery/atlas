// Flashcards plugin self-check: the one-time migration from Study's card
// data, store independence (separate tabs/courses, no cross-writes), and the
// spaced-repetition scheduler (moved here from Study when the plugin split
// in two — see tests/study.check.mjs). Run:
//   node tests/flashcards.check.mjs
import assert from 'node:assert/strict'

// ---- fake localStorage (two independent keys, like a real browser) ---------
function fakeStorage() {
  const data = {}
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v) },
    removeItem: (k) => { delete data[k] },
  }
}

globalThis.localStorage = fakeStorage()
const F = await import('../src/page/flashcards.js')

// ---- migration ---------------------------------------------------------------
globalThis.localStorage = fakeStorage()
// Seed a Study store with two courses, one carrying cards mid-SRS-schedule.
localStorage.setItem('atlas.study.v1', JSON.stringify({
  active: 't1',
  tabs: [
    { id: 't1', name: 'Calc II', questions: [], catStats: {}, chat: [],
      cards: [{ id: 'c1', front: 'd/dx sin x', back: 'cos x', box: 2, due: '2026-08-20' },
              { id: 'c2', front: 'd/dx cos x', back: '-sin x', box: 0, due: '' }] },
    { id: 't2', name: 'Physics II', questions: [], catStats: {}, chat: [], cards: [] },
  ],
}))

const s1 = F.loadFlashcards()
assert.equal(s1.tabs.length, 2, 'one flashcards tab per study tab')
const calc = s1.tabs.find((t) => t.name === 'Calc II')
assert.ok(calc, 'tab name carried over')
assert.equal(calc.cards.length, 2)
const c1 = calc.cards.find((c) => c.id === 'c1')
assert.equal(c1.box, 2, 'SRS box preserved by the migration')
assert.equal(c1.due, '2026-08-20', 'SRS due date preserved by the migration')
assert.equal(c1.front, 'd/dx sin x')
assert.ok(localStorage.getItem('atlas.flashcards.v1') != null, 'migration persisted its own store')
const studyBefore = localStorage.getItem('atlas.study.v1')
assert.ok(studyBefore.includes('"cards"'), 'study store left untouched (still has its cards field)')

// Idempotent: adding a card straight to Study after the fact must NOT
// re-trigger the migration (the flashcards key already exists) — the second
// load returns exactly what's already in atlas.flashcards.v1, unchanged.
const studyState = JSON.parse(studyBefore)
studyState.tabs[0].cards.push({ id: 'c3', front: 'new', back: 'new', box: 0, due: '' })
localStorage.setItem('atlas.study.v1', JSON.stringify(studyState))
const s2 = F.loadFlashcards()
assert.equal(s2.tabs.find((t) => t.name === 'Calc II').cards.length, 2, 'second load is a no-op — no re-migration')
assert.equal(localStorage.getItem('atlas.study.v1'), JSON.stringify(studyState), 'flashcards never writes atlas.study.v1')
console.log('ok migration: seeded once from Study, SRS state intact, idempotent, study store untouched')

// ---- independence (separate stores, separate tab lists) --------------------
globalThis.localStorage = fakeStorage() // no study store at all — flashcards must work standalone
let s = F.loadFlashcards()
assert.equal(s.tabs.length, 0)
s.tabs.push(F.newTab('Chemistry'))
s.active = s.tabs[0].id
F.saveFlashcards(s)
assert.equal(localStorage.getItem('atlas.study.v1'), null, 'adding a flashcards tab never creates a study store')

// And the reverse: study data appearing later must not retroactively alter an
// already-independent flashcards store (the migration only ever runs once,
// on the first-ever load, and that already happened above).
localStorage.setItem('atlas.study.v1', JSON.stringify({ active: '', tabs: [{ id: 'sx', name: 'Should not appear', questions: [], catStats: {}, chat: [], cards: [] }] }))
const s3 = F.loadFlashcards()
assert.equal(s3.tabs.length, 1)
assert.equal(s3.tabs[0].name, 'Chemistry', 'flashcards keeps its own tab list once it has real data')
console.log('ok independence: separate stores, separate course lists, no cross-writes')

// ---- spaced repetition (ladder, misses reset) -------------------------------
assert.deepEqual(F.LADDER, [1, 3, 7, 14, 21])
assert.equal(F.addDays('2026-01-31', 3), '2026-02-03') // month rollover
const card = F.normCard({ front: 'f', back: 'b' })
assert.equal(card.box, 0)
assert.equal(card.due, '') // new card: due immediately
const T = '2026-07-27'
F.gradeCard(card, true, T);  assert.equal(card.box, 1); assert.equal(card.due, '2026-07-30') // +3
F.gradeCard(card, true, T);  assert.equal(card.box, 2); assert.equal(card.due, '2026-08-03') // +7
F.gradeCard(card, true, T);  assert.equal(card.box, 3); assert.equal(card.due, '2026-08-10') // +14
F.gradeCard(card, true, T);  assert.equal(card.box, 4); assert.equal(card.due, '2026-08-17') // +21 (cap)
F.gradeCard(card, true, T);  assert.equal(card.box, 4); assert.equal(card.due, '2026-08-17') // stays capped
F.gradeCard(card, false, T); assert.equal(card.box, 0); assert.equal(card.due, '2026-07-28') // miss → tomorrow

const dueTab = { cards: [F.normCard({}), F.normCard({ due: '2026-07-27' }), F.normCard({ due: '2026-09-01' })] }
assert.equal(F.dueCards(dueTab, T).length, 2) // '' and today are due, future is not
console.log('ok spaced repetition: ladder, cap, miss-resets-to-box-0, dueCards filter')

// ---- text repair heals stored card data on load -----------------------------
globalThis.localStorage = fakeStorage()
localStorage.setItem('atlas.flashcards.v1', JSON.stringify({
  active: 't1', tabs: [{ id: 't1', name: 'C', cards: [{ front: 'F\\n\\nront $\\\\pi$', back: 'b' }] }],
}))
const healed = F.loadFlashcards().tabs[0]
assert.equal(healed.cards[0].front, 'F\n\nront $\\pi$')
console.log('ok text repair applied on load, same as Study')

console.log('\nflashcards.check: all good')
