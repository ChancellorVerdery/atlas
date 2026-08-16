// Solver self-check for the Formal plugin (node tests/formal.check.mjs).
// Pure-function imports only — nothing here touches localStorage.
import assert from 'node:assert/strict'
import {
  normalizeRoom, normalizeHouse, roomCouples, roomBrothers, houseMax, fillHouse,
  normalizeExpenses, expenseTotal, expenseTotals,
} from '../src/page/formal.js'

const room = (beds, name = '') => normalizeRoom({ beds, name })
const house = (rooms) => ({ id: 'h', name: '', link: '', price: 0, rooms })

// king + futon: 1 couple (futon dead) or 3 brothers
const kf = room({ king: 1, futon: 1 })
assert.equal(roomCouples(kf), 1)
assert.equal(roomBrothers(kf), 3)
let f = fillHouse(house([kf]), 0) // no dates → room packs 3 brothers, all stag
assert.deepEqual([f.total, f.brothers, f.dates, f.couples, f.stags], [3, 3, 0, 0, 3])
assert.equal(f.rooms[0].brothers, 3)
f = fillHouse(house([kf]), 1) // 1 date → couple takes the room, futon dead
assert.deepEqual([f.total, f.brothers, f.dates, f.couples, f.stags], [2, 1, 1, 1, 0])
assert.ok(f.rooms[0].mode === 'couples' && f.rooms[0].couples === 1)

// 4 fulls: 8 brothers at D=0, 4 couples at D=4, couples-only room at D=2
const ff = room({ full: 4 })
assert.equal(houseMax(house([ff])).couples, 4)
assert.equal(fillHouse(house([ff]), 0).total, 8)
f = fillHouse(house([ff]), 4)
assert.deepEqual([f.total, f.brothers, f.stags], [8, 4, 0])
f = fillHouse(house([ff]), 2) // room flips to couples — no stags may join
assert.deepEqual([f.total, f.couples, f.stags], [4, 2, 0])
assert.equal(f.rooms[0].couples, 2)

// multi-room: couple takes the king room, other room packs 5
const h2 = house([room({ king: 1 }), room({ full: 2, futon: 1 })])
f = fillHouse(h2, 1)
assert.deepEqual(f.rooms.map((x) => x.mode), ['couples', 'brothers'])
assert.deepEqual([f.total, f.brothers, f.stags], [7, 6, 5])

// privacy beats headcount: D=2 across {king+2 futons} and {2 fulls} — each
// couple gets its own room even though sharing the 2-full room would leave
// 4 stag spots
const h4 = house([room({ king: 1, futon: 2 }), room({ full: 2 })])
f = fillHouse(h4, 2)
assert.deepEqual(f.rooms.map((x) => x.mode), ['couples', 'couples'])
assert.deepEqual([f.total, f.stags], [4, 0])

// couches: 1 brother each, never couples; a couch-only room is brothers-only
const h3 = house([room({ queen: 1 }), room({ couch: 3 }, 'Living room')])
assert.equal(roomCouples(room({ couch: 3 })), 0)
f = fillHouse(h3, 0)
assert.deepEqual([f.total, f.brothers], [5, 5])
f = fillHouse(h3, 1) // couple in the queen; living room still packs 3 stags
assert.deepEqual([f.total, f.brothers, f.couples, f.stags], [5, 4, 1, 3])
assert.equal(f.rooms[1].brothers, 3)
assert.equal(houseMax(h3).couples, 1) // slider max — couches never add couples
// a couch in a bedroom acts like a futon: dead for couples, +1 brother
const qc = room({ queen: 1, couch: 1 })
assert.equal(roomBrothers(qc), 3)
assert.equal(fillHouse(house([qc]), 1).total, 2)

// sofa sleeper: 2 brothers, never a couple (and dead in a couples room)
assert.equal(roomBrothers(room({ sleeper: 1 })), 2)
assert.equal(roomCouples(room({ sleeper: 1 })), 0)
assert.equal(houseMax(house([room({ sleeper: 2 })])).couples, 0) // can't host dates
f = fillHouse(house([room({ sleeper: 2 })]), 0)
assert.deepEqual([f.total, f.brothers], [4, 4])
f = fillHouse(house([room({ queen: 1, sleeper: 1 })]), 1) // couple takes the room, sleeper dead
assert.deepEqual([f.total, f.couples], [2, 1])

// couples get their own rooms: two kings (own rooms) beat cramming both
// couples into the 2-queen room
const h5 = house([room({ queen: 2 }), room({ king: 1 }), room({ king: 1 })])
f = fillHouse(h5, 2)
assert.deepEqual(f.rooms.map((x) => x.mode), ['brothers', 'couples', 'couples'])
assert.deepEqual([f.total, f.stags], [8, 4])
// Chancellor's case: a 3-queen room + three king+futon rooms. At D=3 the
// couples take the three king rooms (own rooms), NOT the 3-queen room —
// even though sharing the queen room would sleep more people (14 > 12).
const h6 = house([room({ queen: 3 }), room({ king: 1, futon: 1 }), room({ king: 1, futon: 1 }), room({ king: 1, futon: 1 })])
f = fillHouse(h6, 3)
assert.deepEqual(f.rooms.map((x) => x.mode), ['brothers', 'couples', 'couples', 'couples'])
assert.deepEqual(f.rooms.map((x) => x.couples), [0, 1, 1, 1])
assert.deepEqual([f.total, f.brothers, f.stags], [12, 9, 6])
f = fillHouse(h6, 2) // and at D=2, two king rooms — never the queen room
assert.deepEqual(f.rooms.map((x) => x.couples), [0, 1, 1, 0])
// overflow couples CONSOLIDATE: kings full, 3 more couples → all three go
// together into the 3-queen room, not one each across the 6/4/3-queen rooms
const h7 = house([
  room({ queen: 6 }), room({ queen: 4 }), room({ queen: 3 }),
  room({ king: 1 }), room({ king: 1 }), room({ king: 1 }),
])
f = fillHouse(h7, 6)
assert.deepEqual(f.rooms.map((x) => x.couples), [0, 0, 3, 1, 1, 1])
assert.deepEqual([f.total, f.stags], [32, 20]) // 6q+4q rooms pack 20 brothers
f = fillHouse(h7, 5) // overflow of 2 still takes the cheapest room whole
assert.deepEqual(f.rooms.map((x) => x.couples), [0, 0, 2, 1, 1, 1])
f = fillHouse(h7, 8) // overflow of 5 → one 6-queen room, never 3q + 4q split
assert.deepEqual(f.rooms.map((x) => x.couples), [5, 0, 0, 1, 1, 1])

// couples share ONLY when they outnumber couple-capable rooms
f = fillHouse(house([room({ full: 2 }), room({ queen: 1 })]), 3)
assert.deepEqual(f.rooms.map((x) => x.couples), [2, 1])
// overflow doubling spreads: 3 couples over two 2-full rooms → 2+1
f = fillHouse(house([room({ full: 2 }), room({ full: 2 })]), 3)
assert.deepEqual(f.rooms.map((x) => x.couples).sort(), [1, 2])

// D beyond the house's couple capacity clamps down
f = fillHouse(house([kf]), 99)
assert.deepEqual([f.dates, f.total], [1, 2])

// empty house / empty room edges
assert.equal(fillHouse(house([]), 0).total, 0)
f = fillHouse(house([room({})]), 0)
assert.equal(f.rooms[0].brothers, 0)

// legacy house-level couches migrate into a Living room (idempotent per call)
const legacy = normalizeHouse({ name: 'Old', price: 900, couches: 3, rooms: [{ beds: { king: 1 } }] })
assert.equal(legacy.rooms.length, 2)
assert.equal(legacy.rooms[1].name, 'Living room')
assert.equal(legacy.rooms[1].beds.couch, 3)
assert.ok(!('couches' in legacy))
assert.equal(normalizeHouse(legacy).rooms.length, 2) // re-normalizing doesn't duplicate
assert.equal(normalizeHouse({ date: '2026-09-19' }).dateFrom, '2026-09-19') // legacy single date → from
assert.deepEqual(
  [normalizeHouse({ dateFrom: '2026-09-18', dateTo: '2026-09-20' }).dateFrom, normalizeHouse({ dateTo: '2026-09-20' }).dateTo],
  ['2026-09-18', '2026-09-20'])

// per-house surface switches: disabled futons/sleepers/couches sleep nobody
const hU = house([room({ king: 1, futon: 1 }), room({ sleeper: 1, couch: 2 })])
hU.use = { futon: false, sleeper: false, couch: false }
assert.deepEqual(houseMax(hU), { couples: 1, brothers: 2, brothersWithCouches: 2 }) // king only
f = fillHouse(hU, 0)
assert.deepEqual([f.total, f.brothers], [2, 2])
hU.use = { futon: true, sleeper: true, couch: true } // re-enable → full counts return
assert.equal(fillHouse(hU, 0).total, 7)
hU.use = { futon: true, sleeper: true, couch: false } // couches-off collapses the with-couches split
assert.deepEqual(houseMax(hU), { couples: 1, brothers: 5, brothersWithCouches: 5 })
// normalize: defaults all on, explicit false survives, legacy houses get the field
assert.deepEqual(normalizeHouse({}).use, { futon: true, sleeper: true, couch: true })
assert.equal(normalizeHouse({ use: { couch: false } }).use.couch, false)

// ---- expense tracker ---------------------------------------------------------

// flat × qty, per-person × people (people falls back to brothers when blank)
const exp = normalizeExpenses({ brothers: 10, items: [
  { name: 'House', cost: 2400, cat: 'housing', paid: true },
  { name: 'Kegs', cost: 120, qty: 3, cat: 'drinks' },
  { name: 'Park tickets', cost: 70, per: true, people: 14, cat: 'tickets' },
  { name: 'Shirts', cost: 15, per: true, cat: 'merch' }, // people blank → 10 brothers
] })
assert.equal(expenseTotal(exp.items[0], exp.brothers), 2400)
assert.equal(expenseTotal(exp.items[1], exp.brothers), 360)
assert.equal(expenseTotal(exp.items[2], exp.brothers), 980) // 70 × 14, dates included
assert.equal(expenseTotal(exp.items[3], exp.brothers), 150) // 15 × 10 brothers
let xs = expenseTotals(exp)
assert.equal(xs.total, 3890)
assert.equal(xs.perBrother, 389) // brothers split evenly, dates don't pay
assert.deepEqual([xs.paid, xs.owed], [2400, 1490])
assert.deepEqual(Object.fromEntries(xs.byCat), { housing: 2400, drinks: 360, tickets: 980, merch: 150 })

// no brothers set: per-person-blank rows contribute 0, per-brother split is 0
xs = expenseTotals(normalizeExpenses({ items: [{ cost: 15, per: true }, { cost: 100 }] }))
assert.deepEqual([xs.total, xs.perBrother], [100, 0])

// qty floors at 1; junk coerces safely
const junk = normalizeExpenses({ brothers: -3, items: [{ cost: 'x', qty: 0 }, null, 'nope'] })
assert.equal(junk.brothers, 0)
assert.equal(junk.items.length, 1)
assert.deepEqual([junk.items[0].cost, junk.items[0].qty], [0, 1])

console.log('formal.check: all assertions passed')
