// Formal plugin — data layer + the room solver. Houses are candidate formal
// rentals built room-by-room. The core rule: every bedroom is exclusively a
// couples room or a brothers room, never mixed — a futon, twin, or couch in a
// couples room goes UNUSED (a brother on it would intrude on the couple's
// privacy), but in a brothers room each sleeps one more brother. Couches are
// room items like beds (a living room is just a room of couches) and never
// hold couples.
//
// Each House WIDGET carries its own house in the page model (w.house), like
// card/list widgets carry their content — so every widget is independent.
//
// Everything here is pure (no localStorage) so tests/formal.check.mjs can run
// it under plain node.

const isObj = (o) => o !== null && typeof o === 'object'
export const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

// king/queen/full: 1 couple OR 2 brothers. sleeper (sofa sleeper): 2 brothers,
// no couple. twin/futon/couch: 1 brother, no couple.
export const ITEM_TYPES = ['king', 'queen', 'full', 'twin', 'futon', 'sleeper', 'couch']
export const BED_TYPES = ITEM_TYPES // back-compat alias
const COUPLE_BEDS = ['king', 'queen', 'full']

const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0)
const int = (v) => Math.floor(num(v))

export function normalizeRoom(r) {
  const beds = {}
  for (const t of ITEM_TYPES) beds[t] = int(isObj(r?.beds) ? r.beds[t] : 0)
  return { id: r?.id || uid('fr'), name: typeof r?.name === 'string' ? r.name : '', beds }
}

// One widget's house payload (w.house) — tolerant of anything prune let
// through. Migrates the old house-level couches count into a "Living room"
// room (stable id keeps re-renders consistent until an edit persists it).
export function normalizeHouse(h) {
  const rooms = (Array.isArray(h?.rooms) ? h.rooms : []).filter(isObj).map(normalizeRoom)
  const legacyCouches = int(h?.couches)
  if (legacyCouches > 0) {
    rooms.push(normalizeRoom({ id: 'fr-couches', name: 'Living room', beds: { couch: legacyCouches } }))
  }
  return {
    name: typeof h?.name === 'string' ? h.name : '',
    link: typeof h?.link === 'string' ? h.link : '',
    // stay dates, YYYY-MM-DD (legacy single `date` becomes the from date)
    dateFrom: typeof h?.dateFrom === 'string' ? h.dateFrom : (typeof h?.date === 'string' ? h.date : ''),
    dateTo: typeof h?.dateTo === 'string' ? h.dateTo : '',
    price: num(h?.price),
    // per-house switches: disabled surfaces stop counting (default all on)
    use: { futon: h?.use?.futon !== false, sleeper: h?.use?.sleeper !== false, couch: h?.use?.couch !== false },
    rooms,
  }
}

// ---- expense tracker ---------------------------------------------------------
// One widget = one tracker (w.exp). An expense is flat (cost × qty) or
// per-person (cost × people, e.g. $70/ticket × 14 going to the park); a
// per-person row with no people count falls back to the tracker's brothers.
// Brothers split the whole bill evenly — dates don't pay.

export function normalizeExpense(x) {
  return {
    id: x?.id || uid('fx'),
    name: typeof x?.name === 'string' ? x.name : '',
    link: typeof x?.link === 'string' ? x.link : '',
    cat: typeof x?.cat === 'string' ? x.cat : '',
    note: typeof x?.note === 'string' ? x.note : '',
    cost: num(x?.cost),
    per: !!x?.per,
    qty: Math.max(1, int(x?.qty) || 1),
    people: int(x?.people), // 0 → use the tracker's brothers
    paid: !!x?.paid,
  }
}

export function normalizeExpenses(t) {
  return {
    name: typeof t?.name === 'string' ? t.name : '',
    brothers: int(t?.brothers),
    items: (Array.isArray(t?.items) ? t.items : []).filter(isObj).map(normalizeExpense),
  }
}

export const expenseTotal = (it, brothers) =>
  it.cost * (it.per ? (it.people > 0 ? it.people : brothers) : it.qty)

export function expenseTotals(t) {
  let total = 0
  let paid = 0
  const byCat = new Map()
  for (const it of t.items) {
    const v = expenseTotal(it, t.brothers)
    total += v
    if (it.paid) paid += v
    const c = it.cat.trim()
    if (c) byCat.set(c, (byCat.get(c) || 0) + v)
  }
  return { total, paid, owed: total - paid, perBrother: t.brothers > 0 ? total / t.brothers : 0, byCat: [...byCat] }
}

// ---- capacity math (pure) --------------------------------------------------

// Couples the room holds in couples mode (one per real bed; twin/futon/couch dead).
export const roomCouples = (room) => COUPLE_BEDS.reduce((t, b) => t + room.beds[b], 0)
// Brothers the room holds in brothers mode (2 per real bed or sofa sleeper,
// 1 per twin/futon/couch). `use` is the house's per-surface switch — a
// disabled futon/sleeper/couch sleeps nobody; omitted means all enabled.
export const roomBrothers = (room, use) => 2 * roomCouples(room)
  + (use?.sleeper === false ? 0 : 2 * room.beds.sleeper)
  + room.beds.twin
  + (use?.futon === false ? 0 : room.beds.futon)
  + (use?.couch === false ? 0 : room.beds.couch)
const roomBrothersNoCouch = (room, use) => roomBrothers(room, use) - (use?.couch === false ? 0 : room.beds.couch)

export function houseMax(house) {
  const use = house.use
  const couples = house.rooms.reduce((t, r) => t + roomCouples(r), 0)
  const brothers = house.rooms.reduce((t, r) => t + roomBrothersNoCouch(r, use), 0)
  const withCouches = house.rooms.reduce((t, r) => t + roomBrothers(r, use), 0)
  return { couples, brothers, brothersWithCouches: withCouches }
}

// Fill the house for D dates. Priority order:
//   1. Single-couple rooms (one couple bed) are the natural private rooms —
//      couples fill them first, cheapest in stag spots first, even when
//      doubling up elsewhere would sleep more people (privacy beats headcount).
//   2. Overflow couples CONSOLIDATE: they group together into the multi-bed
//      room(s) costing the fewest stag spots (3 couples take the 3-queen room
//      rather than spreading one each across the 6-, 4-, and 3-queen rooms —
//      couples rooming with couples is fine; wasting big rooms isn't).
//   3. Every remaining room packs stag brothers to capacity.
// Any D up to houseMax().couples is satisfiable; a larger D is clamped down.
export function fillHouse(house, D) {
  D = Math.min(int(D), houseMax(house).couples)
  const rooms = house.rooms
  const use = house.use
  const cAlloc = rooms.map(() => 0)
  let dLeft = D

  // stage 1: single-couple rooms, cheapest brother sacrifice first (stable sort → room order)
  const singles = rooms.map((_, i) => i)
    .filter((i) => roomCouples(rooms[i]) === 1)
    .sort((a, b) => roomBrothers(rooms[a], use) - roomBrothers(rooms[b], use))
  for (const i of singles) {
    if (!dLeft) break
    cAlloc[i] = 1
    dLeft--
  }

  // stage 2: cover the overflow with the cheapest set of multi-bed rooms —
  // exact min-cost cover (cost = stag spots sacrificed, ties → fewer rooms).
  // Coverage is capped at the overflow, so O(rooms·D); headcounts are tiny.
  if (dLeft > 0) {
    const multis = rooms.map((_, i) => i).filter((i) => roomCouples(rooms[i]) >= 2)
    const L = dLeft
    let dp = Array(L + 1).fill(null)
    dp[0] = { cost: 0, cnt: 0 }
    const took = [] // took[k][c] = prev coverage when room multis[k] is taken to reach c
    for (const i of multis) {
      const rc = roomCouples(rooms[i])
      const rb = roomBrothers(rooms[i], use)
      const ndp = dp.slice() // skipping the room carries every state over
      const tk = Array(L + 1).fill(null)
      for (let c = 0; c <= L; c++) {
        if (!dp[c]) continue
        const nc = Math.min(L, c + rc)
        const cost = dp[c].cost + rb
        const cnt = dp[c].cnt + 1
        if (!ndp[nc] || cost < ndp[nc].cost || (cost === ndp[nc].cost && cnt < ndp[nc].cnt)) {
          ndp[nc] = { cost, cnt }
          tk[nc] = c
        }
      }
      dp = ndp
      took.push(tk)
    }
    const chosen = []
    for (let k = multis.length - 1, c = L; k >= 0; k--) {
      if (took[k][c] != null) { chosen.unshift(multis[k]); c = took[k][c] }
    }
    for (const i of chosen) { // pack couples together, room by room
      const add = Math.min(dLeft, roomCouples(rooms[i]))
      cAlloc[i] = add
      dLeft -= add
    }
  }

  const out = rooms.map((room, i) => cAlloc[i] > 0
    ? { id: room.id, mode: 'couples', couples: cAlloc[i], brothers: 0 }
    : { id: room.id, mode: 'brothers', couples: 0, brothers: roomBrothers(room, use) })
  const stags = out.reduce((t, r) => t + r.brothers, 0)
  return { dates: D, couples: D, stags, brothers: D + stags, total: 2 * D + stags, rooms: out }
}
