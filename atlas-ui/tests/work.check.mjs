// Work plugin data layer — updateShift edits a past (closed) shift in place.
// Run: node tests/work.check.mjs
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  get length() { return store.size },
  key: (i) => [...store.keys()][i] ?? null,
}

const { loadWork, saveWork, addShift, updateShift, shiftHours, shiftEarned } = await import('../src/page/work.js')

// --- editing a past-dated, hours-only shift updates hours+tips and re-earns ---
store.clear()
let s = loadWork()
s.wage = 20
saveWork(s)
const sh = addShift(s, { date: '2026-01-05', hours: '4:00', tips: '10' })
assert.equal(shiftHours(sh), 4)
assert.equal(shiftEarned(sh), 4 * 20 + 10)

updateShift(s, sh.id, { date: '2026-01-05', hours: '6:30', tips: '25' })
s = loadWork()
const updated = s.shifts.find((x) => x.id === sh.id)
assert.equal(updated.date, '2026-01-05') // still a past date
assert.equal(shiftHours(updated), 6.5)
assert.equal(updated.tips, 25)
assert.equal(shiftEarned(updated), 6.5 * 20 + 25)

// --- editing to clock times (end wins over stale hours) -----------------------
updateShift(s, sh.id, { start: '09:00', end: '13:00', hours: '' })
s = loadWork()
const timed = s.shifts.find((x) => x.id === sh.id)
assert.equal(timed.hours, null)
assert.equal(shiftHours(timed), 4)
assert.equal(shiftEarned(timed), 4 * 20 + 25)

console.log('work.check.mjs: ok')
