// Finance plugin — data layer. Talks to Plaid's REST API through the dev
// server's /finance-api middleware (Plaid has no CORS and the client secret
// can't live in the browser). Sync is a manual "Sync now" action, not a live
// feed — Plaid gives no push from a pure frontend, and a personal/dev-tier
// connection budget is worth spending deliberately rather than on a timer.
//
// Amount sign convention (Plaid): positive = money OUT of the account
// (spending), negative = money IN (income, refunds, deposits).

const KEY = 'atlas.finance.v1'

export function loadFinance() {
  let s
  try { s = JSON.parse(localStorage.getItem(KEY)) || {} } catch { s = {} }
  if (typeof s.clientId !== 'string') s.clientId = ''
  if (typeof s.secret !== 'string') s.secret = ''
  if (s.env !== 'production') s.env = 'sandbox'
  if (!Array.isArray(s.items)) s.items = [] // {itemId, accessToken, institutionName, cursor}
  if (!Array.isArray(s.accounts)) s.accounts = [] // cached: {account_id, item_id, name, mask, type, subtype, balances}
  if (!Array.isArray(s.transactions)) s.transactions = [] // cached, deduped by transaction_id
  if (!s.overrides || typeof s.overrides !== 'object') s.overrides = {} // transactionId -> {category?, isTransfer?}
  if (!s.vendorRules || typeof s.vendorRules !== 'object') s.vendorRules = {} // vendorKey -> categoryKey (auto-categorize by vendor)
  if (!Array.isArray(s.customCategories)) s.customCategories = [] // {key, label, color}
  if (!s.budgets || typeof s.budgets !== 'object') s.budgets = {} // categoryKey -> monthly limit
  if (!Array.isArray(s.netWorthHistory)) s.netWorthHistory = [] // {date, netWorth}, one entry per sync
  if (!Array.isArray(s.dismissedAnomalies)) s.dismissedAnomalies = []
  if (!Array.isArray(s.dismissedSubscriptions)) s.dismissedSubscriptions = [] // normMerchant keys marked "not a subscription"
  if (!s.ranges || typeof s.ranges !== 'object') s.ranges = {} // widgetId -> period, persisted
  if (!s.categoryView || typeof s.categoryView !== 'object') s.categoryView = {} // widgetId -> 'breakdown'|'trend'
  if (typeof s.lastSync !== 'number') s.lastSync = 0
  return s
}
export function saveFinance(s) { localStorage.setItem(KEY, JSON.stringify(s)) }
export const financeConnected = (s = loadFinance()) => !!(s.clientId && s.secret && s.items.length)

export const todayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// ---- Plaid API, through the dev-server relay --------------------------------

async function callApi(path, body) {
  const r = await fetch(`/finance-api${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error_message || j.error || `Plaid request failed (${r.status})`)
  return j
}

let plaidScript = null
function loadPlaidScript() {
  if (window.Plaid) return Promise.resolve()
  if (plaidScript) return plaidScript
  plaidScript = new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js'
    el.onload = () => resolve()
    el.onerror = () => reject(new Error('Could not load Plaid Link'))
    document.head.appendChild(el)
  })
  return plaidScript
}

// Opens the hosted Plaid Link flow; resolves {public_token, institutionName}
// on success, null if the user closed it without linking.
export async function startLink(s) {
  const { link_token } = await callApi('/link-token', { client_id: s.clientId, secret: s.secret, env: s.env })
  await loadPlaidScript()
  return new Promise((resolve, reject) => {
    const handler = window.Plaid.create({
      token: link_token,
      onSuccess: (public_token, metadata) => resolve({ public_token, institutionName: metadata?.institution?.name || 'Bank' }),
      onExit: (err) => (err ? reject(new Error(err.error_message || 'Link exited with an error')) : resolve(null)),
    })
    handler.open()
  })
}

export async function finishLink(s, publicToken, institutionName) {
  const j = await callApi('/exchange', { client_id: s.clientId, secret: s.secret, env: s.env, public_token: publicToken })
  s.items.push({ itemId: j.item_id, accessToken: j.access_token, institutionName, cursor: null })
  saveFinance(s)
}

// ponytail: local disconnect only — drops the item and its cached data but
// doesn't call Plaid's /item/remove to revoke the access_token server-side.
// Upgrade path: add that call here if items need real revocation later.
export function removeItem(s, itemId) {
  s.items = s.items.filter((i) => i.itemId !== itemId)
  s.accounts = s.accounts.filter((a) => a.item_id !== itemId)
  s.transactions = s.transactions.filter((t) => t.item_id !== itemId)
  saveFinance(s)
}

export async function syncAll(s) {
  for (const item of s.items) {
    const j = await callApi('/sync', { client_id: s.clientId, secret: s.secret, env: s.env, access_token: item.accessToken, cursor: item.cursor })
    item.cursor = j.next_cursor
    if (j.accounts?.length) {
      s.accounts = [...s.accounts.filter((a) => a.item_id !== item.itemId), ...j.accounts.map((a) => ({ ...a, item_id: item.itemId }))]
    }
    const removed = new Set((j.removed || []).map((r) => r.transaction_id))
    const byId = new Map(s.transactions.map((t) => [t.transaction_id, t]))
    for (const t of [...(j.added || []), ...(j.modified || [])]) byId.set(t.transaction_id, { ...t, item_id: item.itemId })
    for (const id of removed) byId.delete(id)
    s.transactions = [...byId.values()]
  }
  s.netWorthHistory = [...s.netWorthHistory, { date: todayKey(), netWorth: computeNetWorth(s) }].slice(-730)
  s.lastSync = Date.now()
  saveFinance(s)
}

// Boot prefetch. Finance already renders from its stored accounts/transactions,
// so this only refreshes them — and it is throttled, because every syncAll()
// appends a net-worth point and Plaid is rate-limited. Without the gap, opening
// the app five times would write five history entries and burn five calls.
const WARM_MIN_GAP_MS = 30 * 60e3
export async function warmFinance() {
  const s = loadFinance()
  if (!s.items.length || !s.clientId || !s.secret) return // not linked yet
  if (Date.now() - s.lastSync < WARM_MIN_GAP_MS) return
  try { await syncAll(s) } catch { /* prefetch is best-effort */ }
}

// Credit/loan balances.current is the amount OWED (positive) — subtract it;
// depository/investment current is real cash — add it.
export function computeNetWorth(s) {
  let n = 0
  for (const a of s.accounts) {
    const cur = Number(a.balances?.current) || 0
    n += a.type === 'credit' || a.type === 'loan' ? -cur : cur
  }
  return n
}

// ---- categories --------------------------------------------------------------

// Plaid's personal_finance_category.primary taxonomy (18 buckets) — see
// https://plaid.com/documents/pfc-taxonomy-all.csv. Used as the default
// grouping key; users can override to any built-in or custom category.
const DEFAULT_CATS = {
  INCOME: 'Income',
  LOAN_DISBURSEMENTS: 'Loan Disbursements',
  LOAN_PAYMENTS: 'Loan Payments',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT: 'Transfer Out',
  BANK_FEES: 'Bank Fees',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Food & Drink',
  GENERAL_MERCHANDISE: 'Merchandise',
  HOME_IMPROVEMENT: 'Home Improvement',
  MEDICAL: 'Medical',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Services',
  GOVERNMENT_AND_NON_PROFIT: 'Government & Non-Profit',
  TRANSPORTATION: 'Transportation',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Rent & Utilities',
  OTHER: 'Other',
}
export const BUILTIN_CATEGORIES = Object.keys(DEFAULT_CATS)

// These primaries represent money moving between the user's own accounts
// (incl. paying a credit card from checking) — never income or an expense.
const TRANSFER_PRIMARIES = new Set(['TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS'])

// Stable per-vendor key for grouping/auto-categorization. Strips the variable
// numeric tokens banks bake into descriptors — dates (07/03), times, and ref/
// store/street numbers (#8944) — so the same vendor collapses even when the
// text differs run-to-run: "ATM CASH DEPOSIT 07/03 8944 JM KEYNES DR" and its
// 07/05 sibling both key to "atm cash deposit jm keynes dr", and "SQ *BLUE
// BOTTLE #42"/#7 both to "sq blue bottle". Falls back to the digit-inclusive
// normalization when a name is all-numeric (stripping would leave nothing).
// ponytail: token heuristic, not a parser — a digit-in-brand name ("7-Eleven"
// -> "eleven") loses the digit but still groups; upgrade to a merchant-id map
// if that ever matters.
export const vendorKey = (t) => {
  const raw = (t.merchant_name || t.name || '').toLowerCase()
  const key = raw.replace(/\d[\d\/.:-]*/g, ' ').replace(/[^a-z]+/g, ' ').trim()
  return key || raw.replace(/[^a-z0-9]+/g, ' ').trim()
}

export function categoryKey(txn, s) {
  // Priority: explicit one-off override > vendor rule > Plaid's guess > OTHER.
  return s.overrides[txn.transaction_id]?.category ||
    s.vendorRules?.[vendorKey(txn)] ||
    txn.personal_finance_category?.primary || 'OTHER'
}
export function categoryLabel(key, s) {
  const custom = s.customCategories.find((c) => c.key === key)
  if (custom) return custom.label
  if (DEFAULT_CATS[key]) return DEFAULT_CATS[key]
  return String(key).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const slugify = (label) => 'CUSTOM_' + label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')

export function addCustomCategory(s, label, color) {
  const key = slugify(label) || `CUSTOM_${Date.now()}`
  if (!s.customCategories.some((c) => c.key === key)) s.customCategories.push({ key, label: label.trim(), color: color || randomColor() })
  saveFinance(s)
  return key
}
export function removeCustomCategory(s, key) {
  s.customCategories = s.customCategories.filter((c) => c.key !== key)
  saveFinance(s)
}
const PALETTE = ['#7986cb', '#33b679', '#e67c73', '#e0b15c', '#74d6c4', '#b39ddb', '#f6bf26', '#8e24aa', '#5c9ce0', '#8cc06a']
const randomColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)]

export function setCategory(s, transactionId, key) {
  s.overrides[transactionId] = { ...s.overrides[transactionId], category: key }
  saveFinance(s)
}
// Apply `key` to an explicit set of transactions (multi-select bulk edit).
export function setCategories(s, transactionIds, key) {
  for (const id of transactionIds) s.overrides[id] = { ...s.overrides[id], category: key }
  saveFinance(s)
}
// Auto-categorize every transaction from this vendor (past and future) as `key`.
// Clears any one-off category overrides for the same vendor so the rule governs
// them uniformly (transfer flags on those overrides are preserved).
export function setVendorRule(s, txn, key) {
  const vk = vendorKey(txn)
  if (!vk) return
  s.vendorRules[vk] = key
  for (const t of s.transactions) {
    const o = s.overrides[t.transaction_id]
    if (o?.category && vendorKey(t) === vk) {
      const { category, ...rest } = o
      if (Object.keys(rest).length) s.overrides[t.transaction_id] = rest
      else delete s.overrides[t.transaction_id]
    }
  }
  saveFinance(s)
}
export function clearVendorRule(s, vk) { delete s.vendorRules[vk]; saveFinance(s) }
// Count of existing transactions sharing this transaction's vendor (incl. itself).
export const vendorTxnCount = (s, txn) => {
  const vk = vendorKey(txn)
  return vk ? s.transactions.filter((t) => vendorKey(t) === vk).length : 1
}
// One-time bulk: apply `key` as a one-off category override to every existing
// transaction from this vendor. Unlike setVendorRule this creates no forward
// rule — future transactions keep their own categorization. Returns count changed.
export function applyCategoryToVendor(s, txn, key) {
  const vk = vendorKey(txn)
  if (!vk) return 0
  let n = 0
  for (const t of s.transactions) {
    if (vendorKey(t) === vk) { s.overrides[t.transaction_id] = { ...s.overrides[t.transaction_id], category: key }; n++ }
  }
  saveFinance(s)
  return n
}
export function setTransferOverride(s, transactionId, isTransfer) {
  s.overrides[transactionId] = { ...s.overrides[transactionId], isTransfer }
  saveFinance(s)
}
// Flag/unflag an explicit set of transactions as transfers (multi-select bulk).
export function setTransferOverrides(s, transactionIds, isTransfer) {
  for (const id of transactionIds) s.overrides[id] = { ...s.overrides[id], isTransfer }
  saveFinance(s)
}

// ---- transfer detection: category signal + same-amount/opposite-sign pairing
// across the user's own accounts within a few days ---------------------------

function detectTransferPairIds(transactions) {
  const buckets = new Map() // abs(amount).toFixed(2) -> txns
  for (const t of transactions) {
    const k = Math.abs(t.amount).toFixed(2)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(t)
  }
  const paired = new Set()
  for (const group of buckets.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j]
        if (a.account_id === b.account_id) continue
        if (Math.sign(a.amount) === Math.sign(b.amount)) continue // need opposite legs
        const days = Math.abs(new Date(a.date) - new Date(b.date)) / 86400000
        if (days > 3) continue
        paired.add(a.transaction_id)
        paired.add(b.transaction_id)
      }
    }
  }
  return paired
}

let pairCache = null, pairCacheAt = 0
function pairedIds(s) {
  if (pairCache && pairCacheAt === s.transactions.length) return pairCache
  pairCache = detectTransferPairIds(s.transactions)
  pairCacheAt = s.transactions.length
  return pairCache
}

export function isTransfer(txn, s) {
  const manual = s.overrides[txn.transaction_id]?.isTransfer
  if (manual != null) return manual
  if (TRANSFER_PRIMARIES.has(txn.personal_finance_category?.primary)) return true
  return pairedIds(s).has(txn.transaction_id)
}

// ---- periods (mirrors work.js: Monday weeks) --------------------------------

export const PERIODS = [['week', 'This week'], ['month', 'This month'], ['year', 'This year'], ['all', 'All time']]

export function periodStart(period, now = new Date()) {
  const d = new Date(now)
  if (period === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7)) // Monday
  else if (period === 'month') d.setDate(1)
  else if (period === 'year') { d.setMonth(0); d.setDate(1) }
  else return ''
  return todayKey(d)
}

export const rangeFor = (s, widgetId) => (PERIODS.some(([k]) => k === s.ranges[widgetId]) ? s.ranges[widgetId] : 'month')
export function setRange(s, widgetId, period) { s.ranges[widgetId] = period; saveFinance(s) }
export const categoryViewFor = (s, widgetId) => (s.categoryView[widgetId] === 'trend' ? 'trend' : 'breakdown')
export function setCategoryView(s, widgetId, view) { s.categoryView[widgetId] = view; saveFinance(s) }

// ---- transaction views -------------------------------------------------------

const label = (t) => t.merchant_name || t.name || 'Transaction'

export function topTransactionsFor(s, period, n = 12) {
  const from = periodStart(period)
  return s.transactions
    .filter((t) => (!from || t.date >= from) && !isTransfer(t, s))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    .slice(0, n)
}

export function recentTransactions(s, n = 25) {
  return [...s.transactions].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1)).slice(0, n)
}

export function incomeExpenseFor(s, period) {
  const from = periodStart(period)
  let income = 0, expenses = 0
  for (const t of s.transactions) {
    if ((from && t.date < from) || isTransfer(t, s)) continue
    if (t.amount > 0) expenses += t.amount
    else income += -t.amount
  }
  return { income, expenses, net: income - expenses }
}

export function categoryBreakdown(s, period, n = 8) {
  const from = periodStart(period)
  const sums = new Map()
  for (const t of s.transactions) {
    if ((from && t.date < from) || isTransfer(t, s) || t.amount <= 0) continue
    const k = categoryKey(t, s)
    sums.set(k, (sums.get(k) || 0) + t.amount)
  }
  return [...sums.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, value]) => ({ label: categoryLabel(k, s), value: Math.round(value * 100) / 100 }))
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function monthlyTrend(s, months = 6) {
  const now = new Date()
  const out = []
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const from = todayKey(d)
    const to = todayKey(new Date(d.getFullYear(), d.getMonth() + 1, 1))
    let value = 0
    for (const t of s.transactions) {
      if (t.date >= from && t.date < to && !isTransfer(t, s) && t.amount > 0) value += t.amount
    }
    out.push({ label: MONTH_ABBR[d.getMonth()], value: Math.round(value * 100) / 100 })
  }
  return out
}

// ---- subscriptions: recurring same-merchant, similar-amount, ~monthly ------
// cadence. ponytail: monthly-only heuristic — weekly/annual cadences are a
// clear upgrade path (Plaid's own /transactions/recurring/get product is a
// higher-quality alternative if that product gets enabled on the account).

const normMerchant = (t) => (t.merchant_name || t.name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function detectSubscriptions(s) {
  const groups = new Map()
  for (const t of s.transactions) {
    if (isTransfer(t, s) || t.amount <= 0) continue
    const k = normMerchant(t)
    if (!k || s.dismissedSubscriptions.includes(k)) continue
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(t)
  }
  const out = []
  for (const [key, txns] of groups) {
    if (txns.length < 2) continue
    const sorted = [...txns].sort((a, b) => (a.date < b.date ? -1 : 1))
    const mean = sorted.reduce((t, x) => t + x.amount, 0) / sorted.length
    if (!sorted.every((x) => Math.abs(x.amount - mean) <= mean * 0.08 + 0.5)) continue
    const gaps = []
    for (let i = 1; i < sorted.length; i++) gaps.push((new Date(sorted[i].date) - new Date(sorted[i - 1].date)) / 86400000)
    const avgGap = gaps.reduce((t, g) => t + g, 0) / gaps.length
    if (avgGap < 20 || avgGap > 40) continue
    const last = sorted[sorted.length - 1]
    const next = new Date(last.date)
    next.setDate(next.getDate() + Math.round(avgGap))
    out.push({ key, label: label(last), amount: Math.round(mean * 100) / 100, nextDate: todayKey(next) })
  }
  return out.sort((a, b) => (a.nextDate < b.nextDate ? -1 : 1))
}
// Mark a detected subscription (by its group key) as not actually recurring —
// e.g. a few coincidentally same-amount, ~monthly charges to the same vendor.
export function dismissSubscription(s, key) {
  if (!s.dismissedSubscriptions.includes(key)) s.dismissedSubscriptions.push(key)
  saveFinance(s)
}

// ---- budgets ------------------------------------------------------------------

export function setBudget(s, key, limit) {
  if (limit > 0) s.budgets[key] = limit
  else delete s.budgets[key]
  saveFinance(s)
}

export function budgetProgress(s) {
  const from = periodStart('month')
  const spent = new Map()
  for (const t of s.transactions) {
    if (t.date < from || isTransfer(t, s) || t.amount <= 0) continue
    const k = categoryKey(t, s)
    spent.set(k, (spent.get(k) || 0) + t.amount)
  }
  return Object.entries(s.budgets).map(([key, limit]) => {
    const sp = spent.get(key) || 0
    return { key, label: categoryLabel(key, s), spent: sp, limit, pct: Math.min(999, (sp / limit) * 100) }
  }).sort((a, b) => b.pct - a.pct)
}

// ---- anomalies: category spend well outside its own recent norm -----------

export function anomalies(s) {
  const now = new Date()
  const d90 = todayKey(new Date(now - 90 * 86400000))
  const d30 = todayKey(new Date(now - 30 * 86400000))
  const byCat = new Map()
  for (const t of s.transactions) {
    if (t.date < d90 || isTransfer(t, s) || t.amount <= 0) continue
    const k = categoryKey(t, s)
    if (!byCat.has(k)) byCat.set(k, [])
    byCat.get(k).push(t.amount)
  }
  const flagged = []
  for (const t of s.transactions) {
    if (t.date < d30 || isTransfer(t, s) || t.amount <= 0) continue
    if (s.dismissedAnomalies.includes(t.transaction_id)) continue
    const k = categoryKey(t, s)
    const amounts = byCat.get(k) || []
    if (amounts.length < 5) continue
    const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length
    const variance = amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length
    const stdev = Math.sqrt(variance)
    if (t.amount > mean + 2 * stdev && t.amount > 50) flagged.push({ ...t, mean, stdev })
  }
  return flagged.sort((a, b) => b.amount - a.amount)
}

export function dismissAnomaly(s, transactionId) {
  if (!s.dismissedAnomalies.includes(transactionId)) s.dismissedAnomalies.push(transactionId)
  saveFinance(s)
}

export { label as txnLabel }
