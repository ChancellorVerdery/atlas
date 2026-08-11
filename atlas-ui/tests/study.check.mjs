// Study plugin self-check: spaced-repetition scheduler + the local grading
// tiers (compute-engine equivalence, numeric sampling, tolerance). Run:
//   node tests/study.check.mjs
import assert from 'node:assert/strict'

globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
const S = await import('../src/page/study.js')

// ---- normalization ----------------------------------------------------------
const q = S.normQuestion({ category: '  U-Substitution ', intro: 'Solve $\\int 2x\\,dx$', parts: [{ answer: 'x^2+C' }] })
assert.equal(q.category, 'u-substitution')
assert.equal(q.parts[0].kind, 'math')
assert.equal(q.parts[0].check, 'equiv')
assert.equal(q.parts[0].tolerancePct, 1)
assert.equal(S.normQuestion({}).category, 'general')
assert.equal(S.normQuestion({}).parts.length, 1)
const tq = S.normQuestion({ parts: [{ kind: 'text', answer: 'chain rule', check: 'equiv' }] })
assert.equal(tq.parts[0].check, 'text') // text parts never keep a math check

// choice parts: options normalize, answer clamps to range, degenerate demotes
const cq = S.normQuestion({ figures: ['/study-api/figure?f=sf-1-1.png', ''], parts: [{ kind: 'choice', answer: '7', options: [{ text: 'A' }, { figure: '/f.png' }, { text: '' }] }] })
assert.deepEqual(cq.figures, ['/study-api/figure?f=sf-1-1.png'])
assert.equal(cq.parts[0].kind, 'choice')
assert.equal(cq.parts[0].check, 'choice')
assert.equal(cq.parts[0].options.length, 2) // empty option dropped
assert.equal(cq.parts[0].answer, '1') // clamped into range
const dq = S.normQuestion({ parts: [{ kind: 'choice', answer: '0', options: [{ text: 'only one' }] }] })
assert.equal(dq.parts[0].kind, 'text') // one option is not a choice
assert.equal(await S.checkPart(cq.parts[0], '1'), 'correct')
assert.equal(await S.checkPart(cq.parts[0], '0'), 'incorrect')
assert.equal(await S.checkPart(cq.parts[0], ''), 'incorrect') // never a judge call

// ---- scheduler (1-3-7-14-21 ladder, misses reset) ---------------------------
assert.deepEqual(S.LADDER, [1, 3, 7, 14, 21])
assert.equal(S.addDays('2026-01-31', 3), '2026-02-03') // month rollover
const card = S.normCard({ front: 'f', back: 'b' })
assert.equal(card.box, 0)
assert.equal(card.due, '') // new card: due immediately
const T = '2026-07-27'
S.gradeCard(card, true, T);  assert.equal(card.box, 1); assert.equal(card.due, '2026-07-30') // +3
S.gradeCard(card, true, T);  assert.equal(card.box, 2); assert.equal(card.due, '2026-08-03') // +7
S.gradeCard(card, true, T);  assert.equal(card.box, 3); assert.equal(card.due, '2026-08-10') // +14
S.gradeCard(card, true, T);  assert.equal(card.box, 4); assert.equal(card.due, '2026-08-17') // +21 (cap)
S.gradeCard(card, true, T);  assert.equal(card.box, 4); assert.equal(card.due, '2026-08-17') // stays capped
S.gradeCard(card, false, T); assert.equal(card.box, 0); assert.equal(card.due, '2026-07-28') // miss → tomorrow
const tab = { cards: [S.normCard({}), S.normCard({ due: '2026-07-27' }), S.normCard({ due: '2026-09-01' })], catStats: {} }
assert.equal(S.dueCards(tab, T).length, 2) // '' and today are due, future is not

// ---- category stats ---------------------------------------------------------
S.recordCat(tab, 'u-substitution', true)
S.recordCat(tab, 'u-substitution', false)
assert.deepEqual(tab.catStats['u-substitution'], { attempts: 2, correct: 1 })
assert.equal(S.catPct(tab.catStats['u-substitution']), 50)
assert.equal(S.catPct(undefined), null)

// ---- grading ----------------------------------------------------------------
const eq = (a, b, check = 'equiv', tol) => S.checkMath(b, a, check, tol) // (expected, given)

// equivalent forms all count as correct
assert.equal(await eq('\\frac{1}{x-1}+\\frac{1}{x+1}', '\\frac{2x}{x^2-1}'), 'correct') // decomposed vs combined
assert.equal(await eq('x^2+2x+1', '(x+1)^2'), 'correct')
assert.equal(await eq('0.5', '\\frac{1}{2}'), 'correct')
assert.equal(await eq('2\\sin x\\cos x', '\\sin(2x)'), 'correct')
// wrong answers settle locally via sampling — no judge call needed
assert.equal(await eq('x^3', 'x^2'), 'incorrect')
assert.equal(await eq('\\frac{x^2}{2}', '\\frac{x^2}{2}+C'), 'incorrect') // dropped +C
// numeric tolerance (expected π/4 ≈ 0.7854, ±1%)
assert.equal(await eq('0.788', '\\frac{\\pi}{4}', 'numeric', 1), 'correct')
assert.equal(await eq('0.8', '\\frac{\\pi}{4}', 'numeric', 1), 'incorrect')
assert.equal(await eq('0.8', '\\frac{\\pi}{4}', 'numeric', 5), 'correct') // wider tolerance
// 'form': equivalence is necessary, then the judge decides the form → unsure
assert.equal(await eq('\\frac{1}{x-1}+\\frac{1}{x+1}', '\\frac{2x}{x^2-1}', 'form'), 'unsure')
assert.equal(await eq('x^5', '\\frac{2x}{x^2-1}', 'form'), 'incorrect') // not even equivalent
// unparseable input → judge
assert.equal(await eq('\\frac{', 'x'), 'unsure')
// text answers: exact (normalized) is definitive, anything else → judge
assert.equal(S.checkText('Chain rule', ' chain  rule. '), 'correct')
assert.equal(S.checkText('chain rule', 'product rule'), 'unsure')
// empty submissions are just wrong — never a judge call
assert.equal(await S.checkPart(q.parts[0], '   '), 'incorrect')

// ---- grading regressions (each pins a defect found in review) ---------------

// complex answers: comparing only real parts graded 5i as 3i
assert.equal(await eq('5i', '3i', 'numeric', 1), 'incorrect')
assert.equal(await eq('2+3i', '2-3i', 'numeric', 1), 'incorrect')
assert.equal(await eq('2+3i', '2', 'numeric', 1), 'incorrect')
assert.equal(await eq('3i', '3i', 'numeric', 1), 'correct') // still accepts the right one

// ± is not a value: its Measurement parse has N() = the CENTRE, which marked
// both true roots wrong and the meaningless midpoint right. Judge decides.
assert.equal(await eq('3', '\\pm 3'), 'unsure')
assert.equal(await eq('-3', '\\pm 3'), 'unsure')
assert.equal(await eq('0', '\\pm 3'), 'unsure') // ← was 'correct'
assert.equal(await eq('1.5', '\\frac{3\\pm 1}{2}'), 'unsure') // ← was 'correct'
assert.equal(await eq('\\pm 3', '\\pm 3'), 'correct') // identical still settles locally

// sign-dependent wrong answers were accepted ~1 run in 32; probing is now
// deterministic on both sides of zero, so 40 runs must all refute.
const runs = await Promise.all(Array.from({ length: 40 }, () => eq('x', '\\sqrt{x^2}')))
assert.deepEqual([...new Set(runs)], ['incorrect'], `flaky sqrt(x^2) verdicts: ${[...new Set(runs)]}`)

// 'equiv' promises equivalence, not a 6-digit decimal approximation
assert.equal(await eq('0.333333x', '\\frac{x}{3}'), 'incorrect')
assert.equal(await eq('\\frac{2x}{6}', '\\frac{x}{3}'), 'correct') // real equivalence unaffected

// exact-vs-rounded: the loose default tolerance graded 3.1415926536 ≡ π as
// correct; the strict engine now refutes rounded decimals deterministically
assert.equal(await eq('3.1415926536', '\\pi'), 'incorrect') // ← was a false 'correct'
assert.equal(await eq('0.3333', '\\frac{1}{3}'), 'incorrect')
assert.equal(await eq('0.5', '\\frac{1}{2}'), 'correct') // truly equal decimals still settle locally
assert.equal(await eq('7', '\\pi'), 'incorrect') // integers aren't "rounded decimals" — sampling refutes

// precision-matched tolerance: "round to 4 decimals" on an answer ≈6.7888
assert.equal(await eq('6.7888', '6.78878', 'numeric', 0.001), 'correct')
assert.equal(await eq('6.789', '6.78878', 'numeric', 0.001), 'incorrect') // sloppier rounding fails
assert.equal(await eq('6.789', '6.78878', 'numeric', 1), 'correct') // default tolerance stays loose

// ---- double-escape repair (Claude sometimes over-escapes its JSON) ----------
// literal backslash-n pairs → real newlines; doubled backslashes → single
assert.equal(S.fixEscapes('lengths.\\n\\nFor $y = f(x)$'), 'lengths.\n\nFor $y = f(x)$')
assert.equal(S.fixEscapes('each piece is $\\\\sqrt{1+\\\\left(\\\\frac{dy}{dx}\\\\right)^2}\\\\,dx$'),
  'each piece is $\\sqrt{1+\\left(\\frac{dy}{dx}\\right)^2}\\,dx$')
// real commands starting with n stay intact INSIDE math, escaped or doubled
assert.equal(S.fixEscapes('the gradient $\\nabla f \\neq 0$ where $\\nu > 0$'), 'the gradient $\\nabla f \\neq 0$ where $\\nu > 0$')
assert.equal(S.fixEscapes('grad is $\\\\nabla f$'), 'grad is $\\nabla f$')
// prose \n before lowercase text is still a newline (nothing to protect there)
assert.equal(S.fixEscapes('so\\n\\nlength is $x$'), 'so\n\nlength is $x$')
// bare-LaTeX repair (answers): slashes fixed, \n never touched
assert.equal(S.fixSlashes('\\\\frac{x}{2} + \\nabla f'), '\\frac{x}{2} + \\nabla f')
// matrix row separators (followed by whitespace) are untouched
assert.equal(S.fixEscapes('\\begin{pmatrix}a \\\\ b\\end{pmatrix}'), '\\begin{pmatrix}a \\\\ b\\end{pmatrix}')
// normalizers heal stored data on load (chat, questions, cards)
globalThis.localStorage = {
  getItem: () => JSON.stringify({ active: 't1', tabs: [{ id: 't1', name: 'C', catStats: {},
    chat: [{ role: 'tutor', text: 'so\\n\\nlength is $\\\\int_a^b$' }],
    questions: [{ id: 'q1', category: 'c', intro: 'find $\\\\frac{1}{2}$', parts: [{ prompt: '', kind: 'math', answer: '\\\\frac{x}{2}', check: 'equiv' }] }],
    cards: [{ front: 'F\\n\\nront $\\\\pi$', back: 'b' }] }] }),
  setItem() {}, removeItem() {},
}
const healed = S.loadStudy().tabs[0]
assert.equal(healed.chat[0].text, 'so\n\nlength is $\\int_a^b$')
assert.equal(healed.questions[0].intro, 'find $\\frac{1}{2}$')
assert.equal(healed.questions[0].parts[0].answer, '\\frac{x}{2}')
assert.equal(healed.cards[0].front, 'F\n\nront $\\pi$')

console.log('study.check: all assertions passed')
