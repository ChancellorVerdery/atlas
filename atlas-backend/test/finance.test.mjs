// Round-trip test for the finance mapper: recompose(simulatePg(decompose(S)))
// must deepStrictEqual S for any S the plugin's loader produces.
import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/finance.js'

// Columns declared jsonb in the DDL: decompose stringifies them, pg returns
// them parsed. Everything else round-trips as-is (date cols went in as
// 'YYYY-MM-DD' strings and come back as the same strings; numeric/int8 come
// back as JS numbers via db.js parsers; text[] comes back as a JS array).
const JSONB = {
  settings: ['dismissed_anomalies', 'dismissed_subscriptions'],
  items: ['raw'],
  accounts: ['raw'],
  transactions: ['raw'],
  custom_categories: ['cat'],
  budgets: ['monthly_limit'],
  networth_history: ['raw'],
}

function simulatePg(byTable) {
  const out = {}
  for (const [table, rows] of Object.entries(byTable)) {
    out[table] = rows.map(row => {
      const r = {}
      for (const [k, v] of Object.entries(row)) {
        if ((JSONB[table] || []).includes(k)) r[k] = JSON.parse(v)
        else r[k] = v === undefined ? null : structuredClone(v)
      }
      return r
    })
  }
  return out
}

const roundTrip = S => mapper.recompose(simulatePg(mapper.decompose(S)))

// ---- sample 1: exact default state loadFinance() produces from empty storage
const defaults = {
  clientId: '',
  secret: '',
  env: 'sandbox',
  items: [],
  accounts: [],
  transactions: [],
  overrides: {},
  customCategories: [],
  budgets: {},
  netWorthHistory: [],
  dismissedAnomalies: [],
  dismissedSubscriptions: [],
  ranges: {},
  categoryView: {},
  lastSync: 0,
}
deepStrictEqual(roundTrip(defaults), defaults)

// ---- sample 2: rich state exercising every field and edge case
const rich = {
  clientId: '64f0c1a2b3d4e5f6a7b8c9d0',
  secret: 's3cr3t-ключ-秘密', // unicode secret
  env: 'production',
  items: [
    // freshly linked: cursor is explicitly null (finishLink pushes cursor: null)
    { itemId: 'item-α', accessToken: 'access-sandbox-111', institutionName: 'Crédit Agricole 🏦', cursor: null },
    // synced item: cursor is a Plaid opaque string; empty-string institution name
    { itemId: 'item-2', accessToken: 'access-production-222', institutionName: '', cursor: 'CAESJXRc9v==' },
  ],
  accounts: [
    // full Plaid account object persisted verbatim (nested balances, nulls, extras)
    {
      account_id: 'acc-1', item_id: 'item-α', name: 'Chèque courant', official_name: null,
      mask: '0000', type: 'depository', subtype: 'checking',
      balances: { available: 100.5, current: 110.25, iso_currency_code: 'USD', limit: null, unofficial_currency_code: null },
      verification_status: 'automatically_verified',
    },
    // sparse account: no balances, no name/mask/type — recompose must not invent keys
    { account_id: 'acc-2', item_id: 'item-2' },
    // credit account with zero balance
    {
      account_id: 'acc-3', item_id: 'item-2', name: 'Visa', mask: '', type: 'credit', subtype: 'credit card',
      balances: { available: null, current: 0, limit: 5000, iso_currency_code: 'USD' },
    },
  ],
  transactions: [
    // full Plaid txn verbatim: pending, nested PFC, location, counterparties
    {
      transaction_id: 'txn-1', item_id: 'item-α', account_id: 'acc-1',
      date: '2026-07-01', amount: 12.34, name: 'CAFÉ ØSTERBRO', merchant_name: 'Café Østerbro',
      pending: true, iso_currency_code: 'USD',
      personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'VERY_HIGH' },
      location: { address: null, city: 'København', country: 'DK' },
      counterparties: [{ name: 'Café Østerbro', type: 'merchant' }],
    },
    // income (negative amount), no merchant_name, no PFC — extracted cols go NULL, raw is truth
    { transaction_id: 'txn-2', item_id: 'item-2', account_id: 'acc-2', date: '2026-06-15', amount: -2500 },
    // empty-string name, fractional amount
    { transaction_id: 'txn-3', item_id: 'item-2', account_id: 'acc-3', date: '2026-06-20', amount: 0.01, name: '', merchant_name: null },
  ],
  overrides: {
    'txn-1': { category: 'CUSTOM_COFFEE' },              // partial: category only
    'txn-2': { isTransfer: false },                      // partial: explicit false is meaningful
    'txn-3': { category: 'OTHER', isTransfer: true },    // both keys
    'txn-gone': { isTransfer: true },                    // dangling ref to a deleted txn (tolerated)
  },
  customCategories: [
    { key: 'CUSTOM_COFFEE', label: 'Coffee ☕', color: '#7986cb' },
    { key: 'CUSTOM_1751234567890', label: '', color: '#33b679' }, // empty label (slugify fell through)
  ],
  budgets: {
    FOOD_AND_DRINK: 300,
    CUSTOM_COFFEE: 45.5,
    CUSTOM_DELETED: 10, // dangling budget after category.remove (tolerated)
  },
  netWorthHistory: [
    // two syncs on the same date — both rows kept, order matters
    { date: '2026-07-01', netWorth: 1234.56 },
    { date: '2026-07-01', netWorth: 1230.06 },
    { date: '2026-07-02', netWorth: -500.25 }, // negative net worth
  ],
  dismissedAnomalies: ['txn-3', 'txn-old-🚩'],
  dismissedSubscriptions: ['netflix', 'the gym membership 🏋️'],
  ranges: { 'fin-w1': 'week', 'fin-w2': 'all' },
  categoryView: { 'fin-w2': 'trend', 'fin-w3': 'breakdown' }, // overlaps w2, w3 has no range
  lastSync: 1751846400123,
}
deepStrictEqual(roundTrip(rich), rich)

// ---- sample 3: realistic usage — one bank, several accounts/txns, light prefs
const realistic = {
  clientId: 'abc123',
  secret: 'plaid-secret',
  env: 'sandbox',
  items: [{ itemId: 'item-chase', accessToken: 'access-sandbox-xyz', institutionName: 'Chase', cursor: 'cursor-42' }],
  accounts: [
    { account_id: 'chk', item_id: 'item-chase', name: 'Checking', mask: '1234', type: 'depository', subtype: 'checking', balances: { available: 812.4, current: 850.15, iso_currency_code: 'USD' } },
    { account_id: 'sav', item_id: 'item-chase', name: 'Savings', mask: '5678', type: 'depository', subtype: 'savings', balances: { available: 5000, current: 5000, iso_currency_code: 'USD' } },
    { account_id: 'cc', item_id: 'item-chase', name: 'Freedom', mask: '9012', type: 'credit', subtype: 'credit card', balances: { available: 4100, current: 900.33, limit: 5000, iso_currency_code: 'USD' } },
  ],
  transactions: [
    { transaction_id: 't1', item_id: 'item-chase', account_id: 'chk', date: '2026-07-03', amount: 54.12, name: 'TRADER JOES', merchant_name: 'Trader Joe\'s', personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' } },
    { transaction_id: 't2', item_id: 'item-chase', account_id: 'chk', date: '2026-07-01', amount: -1800, name: 'PAYROLL ACME', personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' } },
    { transaction_id: 't3', item_id: 'item-chase', account_id: 'chk', date: '2026-06-28', amount: 500, name: 'TRANSFER TO SAVINGS', personal_finance_category: { primary: 'TRANSFER_OUT', detailed: 'TRANSFER_OUT_SAVINGS' } },
    { transaction_id: 't4', item_id: 'item-chase', account_id: 'sav', date: '2026-06-28', amount: -500, name: 'TRANSFER FROM CHECKING', personal_finance_category: { primary: 'TRANSFER_IN', detailed: 'TRANSFER_IN_SAVINGS' } },
    { transaction_id: 't5', item_id: 'item-chase', account_id: 'cc', date: '2026-06-25', amount: 15.99, name: 'Netflix', merchant_name: 'Netflix', personal_finance_category: { primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_TV_AND_MOVIES' } },
  ],
  overrides: { t5: { category: 'CUSTOM_SUBSCRIPTIONS' } },
  customCategories: [{ key: 'CUSTOM_SUBSCRIPTIONS', label: 'Subscriptions', color: '#e0b15c' }],
  budgets: { FOOD_AND_DRINK: 400, ENTERTAINMENT: 60 },
  netWorthHistory: [
    { date: '2026-06-28', netWorth: 4890.5 },
    { date: '2026-07-03', netWorth: 4949.82 },
  ],
  dismissedAnomalies: ['t1'],
  dismissedSubscriptions: [],
  ranges: { 'finoverview-1': 'month', 'fintop-1': 'year' },
  categoryView: { 'fincats-1': 'trend' },
  lastSync: 1751587200000,
}
deepStrictEqual(roundTrip(realistic), realistic)

// ---- regressions: raw (never-loaded) / loader-lenient blobs must save -------
// loadFinance validates NOTHING below the top level: items/accounts/txns/
// customCategories/netWorthHistory entries and budget values are kept
// verbatim. The wire carries raw localStorage (backup imports), so a save
// must tolerate everything the loader does.

// A budget limit of Infinity (typed as '1e999') stringifies to JSON null;
// loadFinance keeps budgets verbatim, so the null persists. Previously:
// 23502 on monthly_limit NOT NULL, breaking every later finance save.
{
  const S = { ...defaults, budgets: { FOOD_AND_DRINK: null, CUSTOM_X: 45.5, WEIRD: '300' } }
  deepStrictEqual(roundTrip(S), S, 'null/string budget limits survive verbatim')
}

// Orphaned item_id refs (hand-merged backup): accounts/transactions whose
// item_id matches no items entry render fine in every widget. Previously:
// 23503 on the hard composite FKs to items (now dropped — soft refs).
{
  const S = {
    ...defaults,
    items: [],
    accounts: [{ account_id: 'acc-1', item_id: 'item-GONE', name: 'Orphan' }],
    transactions: [{ transaction_id: 'txn-1', item_id: 'item-GONE', account_id: 'acc-1', date: '2026-07-01', amount: 5 }],
  }
  deepStrictEqual(roundTrip(S), S, 'orphaned item_id refs survive (no FK)')
}

// Loader-valid junk entries: items:[{}], transactions missing date/amount or
// with non-ISO dates, duplicate transaction/customCategory keys, sparse
// customCategories. Previously: 23502 NOT NULL / 23505 PK violations.
{
  const S = {
    ...defaults,
    items: [
      {},                                                            // empty item
      { itemId: 'item-a', accessToken: 'tok', institutionName: 'A', cursor: null },
      { itemId: 'item-a', accessToken: 'tok2', cursor: 7 },          // dup itemId + non-string cursor + missing name
    ],
    accounts: [{}, { account_id: 'acc-1' }, { account_id: 'acc-1' }],  // dup account ids
    transactions: [
      { transaction_id: 'txn-d', account_id: 'acc-1' },              // no date, no amount, no item_id
      { transaction_id: 'txn-d', date: '07/01/2026', amount: '12' }, // dup id + non-ISO date + string amount
      null,                                                          // even a null entry is loader-kept
    ],
    customCategories: [
      {},                                                            // sparse
      { key: 'CUSTOM_A', label: 'A', color: '#111111' },
      { key: 'CUSTOM_A', label: 'A again', color: '#222222' },       // dup key
      { key: 'CUSTOM_B', extra: true },                              // unknown key survives (jsonb verbatim)
    ],
    netWorthHistory: [{}, { date: 'not-a-date', netWorth: 'abc' }, { date: '2026-07-01', netWorth: 10 }],
  }
  deepStrictEqual(roundTrip(S), S, 'loader-lenient junk entries survive verbatim')
}

// Raw legacy blob missing keys entirely (pre-feature app version): decompose
// mirrors loadFinance's top-level normalization instead of crashing on
// Object.keys(undefined) / violating NOT NULLs.
deepStrictEqual(
  roundTrip({ clientId: 'x', secret: 'y' }),
  { ...defaults, clientId: 'x', secret: 'y' },
  'legacy blob missing keys → loader defaults',
)
deepStrictEqual(
  roundTrip({ ...defaults, env: 'dev', lastSync: null }),
  defaults,
  'invalid env/lastSync → loader defaults',
)

// '__proto__' keys in overrides/budgets/ranges/categoryView must come back as
// plain own properties — not vanish into (or replace) the prototype.
{
  const evil = JSON.parse(`{
    "overrides": {"__proto__": {"category": "EVIL"}},
    "budgets": {"__proto__": 10},
    "ranges": {"__proto__": "week"},
    "categoryView": {"__proto__": "trend"}
  }`)
  const back = roundTrip(evil)
  for (const [name, obj, want] of [
    ['overrides', back.overrides, { category: 'EVIL' }],
    ['budgets', back.budgets, 10],
    ['ranges', back.ranges, 'week'],
    ['categoryView', back.categoryView, 'trend'],
  ]) {
    if (Object.getPrototypeOf(obj) !== Object.prototype) throw new Error(`${name} prototype replaced`)
    const own = Object.getOwnPropertyDescriptor(obj, '__proto__')
    deepStrictEqual(own && own.value, want, `${name} __proto__ entry kept as own key`)
  }
  if (({}).category !== undefined) throw new Error('Object.prototype polluted')
}

// Non-object override values (foreign blob) are stored as the empty override
// instead of throwing at `'category' in o`.
deepStrictEqual(
  roundTrip({ ...defaults, overrides: { 'txn-1': 'junk', 'txn-2': { isTransfer: 'yes' } } }),
  { ...defaults, overrides: { 'txn-1': {}, 'txn-2': {} } },
  'non-object override / non-boolean isTransfer degrade to empty override',
)

console.log('OK finance')
