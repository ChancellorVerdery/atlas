// Pure unit test of the degree scheduler (no browser). Runs in the battery.
import { scheduleDegree, termKey } from '../src/page/course.js'
let pass = 0, fail = 0
const ok = (c, n, x = '') => { c ? (pass++, console.log('  ok ' + n)) : (fail++, console.log('  FAIL ' + n + ' ' + x)) }

const C = (code, credits, opts = {}) => ({
  id: 'id-' + code, code, title: opts.title || code, credits,
  prereqs: opts.prereqs || [], coreqs: opts.coreqs || [], preOrCo: opts.preOrCo || [],
  summerOk: !!opts.summerOk, term: opts.term || null,
})
const base = (courses, settings = {}, terms = [], disabledTerms = []) => ({
  courses,
  terms: terms.map((t) => ({ ...t, key: termKey(t.season, t.year) })), // mirror loadCourse's key
  disabledTerms,
  settings: { maxCredits: 15, summerMax: 9, strategy: 'soonest-summer', ...settings },
})
const termOf = (plan, code) => { for (const t of plan.board) if (t.courseIds.includes('id-' + code)) return t.key; return null }
const rank = (k) => { const [s, y] = k.split('-'); return Number(y) * 3 + ({ spring: 0, summer: 1, fall: 2 })[s] }

console.log('course-sched (scheduler unit)')

// 1) prereq ordering + credit cap
{
  const s = base([C('A', 15), C('B', 3, { prereqs: ['A'] })], { maxCredits: 15 }, [{ season: 'fall', year: 2025, current: true }])
  const p = scheduleDegree(s, new Date('2025-10-01'))
  ok(rank(termOf(p, 'B')) > rank(termOf(p, 'A')), 'B (needs A) lands later than A', `${termOf(p, 'A')} vs ${termOf(p, 'B')}`)
  ok(termOf(p, 'A') === 'spring-2026', 'A goes to the first future term', termOf(p, 'A'))
}
// 2) small classes share a term; a cap-filling class stands alone
{
  const s = base([C('X', 3), C('Y', 3), C('Z', 15)], { maxCredits: 15 }, [{ season: 'fall', year: 2025, current: true }])
  const p = scheduleDegree(s, new Date('2025-10-01'))
  ok(termOf(p, 'X') === termOf(p, 'Y') && termOf(p, 'X'), 'two small classes share a term')
  ok(termOf(p, 'Z') !== termOf(p, 'X'), 'the 15-credit class is alone', termOf(p, 'Z'))
}
// 3) coreq same-or-earlier: the coreq shares the term (pulled in as a group)
{
  const s = base([C('A', 4), C('B', 4, { coreqs: ['A'] })], {}, [{ season: 'fall', year: 2025, current: true }])
  const p = scheduleDegree(s, new Date('2025-10-01'))
  ok(termOf(p, 'A') === termOf(p, 'B'), 'coreq A shares B’s term', `${termOf(p, 'A')} vs ${termOf(p, 'B')}`)
}
// 4) a prereq completed in a past term is satisfied
{
  const s = base([C('CALC1', 4, { term: 'fall-2025' }), C('CALC2', 4, { prereqs: ['CALC1'] })], {}, [{ season: 'fall', year: 2025, current: true }])
  const p = scheduleDegree(s, new Date('2025-10-01'))
  ok(termOf(p, 'CALC2') === 'spring-2026', 'CALC2 schedules right after its already-done prereq', termOf(p, 'CALC2'))
}
// 5) summer availability
{
  const s = base([C('S1', 6, { summerOk: true }), C('S2', 6)], { maxCredits: 6, summerMax: 6 }, [{ season: 'spring', year: 2026, current: true }])
  const p = scheduleDegree(s, new Date('2026-03-01'))
  ok(termOf(p, 'S1') === 'summer-2026', 'a summer-offered class fills the summer', termOf(p, 'S1'))
  ok(termOf(p, 'S2') === 'fall-2026', 'a class not offered in summer skips to fall', termOf(p, 'S2'))
}
// 6) disabled summer skipped
{
  const s = base([C('S1', 6, { summerOk: true }), C('S2', 6, { summerOk: true })], { maxCredits: 6, summerMax: 6 }, [{ season: 'spring', year: 2026, current: true }], ['summer-2026'])
  const p = scheduleDegree(s, new Date('2026-03-01'))
  ok(termOf(p, 'S1') !== 'summer-2026' && termOf(p, 'S2') !== 'summer-2026', 'nothing lands in the disabled summer')
}
// 7) strategy: even load caps each term below the hard max
{
  const cs = [C('A', 3), C('B', 3), C('C', 3), C('D', 3)] // 12 cr, no deps
  const soonest = scheduleDegree(base(cs, { maxCredits: 12, strategy: 'soonest-summer' }, [{ season: 'fall', year: 2025, current: true }]), new Date('2025-10-01'))
  const even = scheduleDegree(base(cs, { maxCredits: 12, strategy: 'even' }, [{ season: 'fall', year: 2025, current: true }]), new Date('2025-10-01'))
  const soonestTerms = new Set(cs.map((c) => termOf(soonest, c.code))).size
  const evenTerms = new Set(cs.map((c) => termOf(even, c.code))).size
  ok(soonestTerms === 1, 'soonest packs all 4 into one 12-credit term', `${soonestTerms}`)
  ok(evenTerms >= soonestTerms, 'even load spreads across more terms (lighter each)', `${evenTerms}`)
}
// 7b) even load never fails where soonest succeeds: a 15cr class survives the lighter cap
{
  const cs = [C('BIG', 15), C('S1', 3), C('S2', 3)]
  const p = scheduleDegree(base(cs, { maxCredits: 15, strategy: 'even' }, [{ season: 'fall', year: 2025, current: true }]), new Date('2025-10-01'))
  ok(p.unplaceable.length === 0 && termOf(p, 'BIG'), 'even load falls back to full caps instead of dropping a big class', JSON.stringify(p.unplaceable))
}
// 8) prereq cycle reported, not dropped
{
  const s = base([C('P', 3, { prereqs: ['Q'] }), C('Q', 3, { prereqs: ['P'] })], {}, [{ season: 'fall', year: 2025, current: true }])
  const p = scheduleDegree(s, new Date('2025-10-01'))
  ok(p.unplaceable.length === 2 && p.warnings.length >= 1, 'a prereq cycle is flagged unplaceable')
}
// 9) edges connect placed courses
{
  const s = base([C('A', 3), C('B', 3, { prereqs: ['A'] })], {}, [{ season: 'fall', year: 2025, current: true }])
  const p = scheduleDegree(s, new Date('2025-10-01'))
  ok(p.edges.some((e) => e.from === 'id-A' && e.to === 'id-B' && e.kind === 'prereq'), 'a prereq edge A→B exists')
}

console.log(`\ncourse-sched: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
