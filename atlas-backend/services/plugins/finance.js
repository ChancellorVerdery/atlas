// Finance plugin service — mirrors atlas.finance.v1.
//
// Blob shape (loadFinance() in atlas-ui/src/page/finance.js):
//   { clientId, secret, env: 'sandbox'|'production',
//     items: [{itemId, accessToken, institutionName, cursor}],   // cursor null pre-first-sync
//     accounts: [raw Plaid account + item_id],                   // persisted VERBATIM
//     transactions: [raw Plaid txn + item_id],                   // persisted VERBATIM
//     overrides: { txnId -> {category?, isTransfer?} },          // PARTIAL; isTransfer:false meaningful
//     customCategories: [{key, label, color}],
//     budgets: { categoryKey -> monthly limit (number) },
//     netWorthHistory: [{date:'YYYY-MM-DD', netWorth}],          // append-only, order matters
//     dismissedAnomalies: [transactionId, ...],
//     dismissedSubscriptions: [normMerchant key, ...],             // "not a subscription" marks
//     ranges: { widgetId -> period }, categoryView: { widgetId -> view },
//     lastSync: number }
//
// IMPORTANT: the wire carries RAW localStorage — backup imports (renderer.js
// importData, main.js importAll) push blobs loadFinance() has never touched.
// decompose therefore runs the loader's exact top-level normalization first
// (normalizeFinance below). Below the top level the loader validates NOTHING
// (items/accounts/transactions/customCategories/netWorthHistory entries and
// budget values are kept verbatim), so every per-entry table stores a verbatim
// jsonb copy as the source of truth and only extracts columns opportunistically
// (NULL when the entry lacks a usable value). A save must never fail on a
// state the app's own loader tolerates — e.g. a budget of Infinity arrives as
// JSON null (jsonb keeps it), items:[{}] inserts fine, duplicate ids are fine.
//
// Fidelity notes:
// - accounts/transactions/items/customCategories/netWorthHistory: the jsonb
//   `raw`/`cat` column is the truth and is recomposed verbatim; the extracted
//   columns exist only for SQL queries and are nullable + sanitized (a non-ISO
//   date or non-numeric amount goes NULL in the extract, never 500s). No PKs
//   on these tables: the loader never dedupes, so array position (ord) is the
//   identity — hand-merged backups with duplicate ids must save.
// - No FKs to finance_items: item_id is a soft ref like every other ref here
//   (gym_logs.exercise_id, finance_overrides.transaction_id) — the loader
//   happily renders orphaned accounts/transactions.
// - overrides are partial objects: category NULL = key absent, is_transfer
//   NULL = key absent (explicit false is stored as false, not NULL). Keys of
//   an object are unique, so the PK is safe. A non-object override value
//   (foreign blob) is stored as the empty override.
// - budgets.monthly_limit is jsonb: setBudget writes positive numbers, but
//   Infinity stringifies to null and the loader keeps budgets verbatim — a
//   NOT NULL numeric column would permanently break saves.
// - dismissedAnomalies/dismissedSubscriptions fold into finance_settings as
//   jsonb (order-preserving); the loader only checks Array.isArray, so
//   entries can be anything.
// - ranges{} + categoryView{} share finance_widget_prefs via nullable columns:
//   NULL range = widgetId absent from ranges, NULL cat_view = absent from
//   categoryView. No CHECK constraints on the values: the loader passes stored
//   values through unvalidated (rangeFor/categoryViewFor coerce at READ time),
//   so the DB must accept whatever the blob holds.
// - recompose rebuilds overrides/budgets/ranges/categoryView with
//   Object.fromEntries so a '__proto__' key stays a plain own property.

import { runPlugin } from '../../lib/runner.js'

const ddl = `
CREATE TABLE IF NOT EXISTS finance_settings (
  user_id             uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  client_id           text NOT NULL DEFAULT '',        -- Plaid client_id
  secret              text NOT NULL DEFAULT '',        -- ponytail: plaintext at rest, encrypt with pgcrypto when this leaves the tunnel
  env                 text NOT NULL DEFAULT 'sandbox' CHECK (env IN ('sandbox','production')),
  last_sync           numeric NOT NULL DEFAULT 0,      -- Date.now(); normalizeFinance guarantees a number
  dismissed_anomalies jsonb NOT NULL DEFAULT '[]',     -- ordered txn-id list, entries verbatim
  dismissed_subscriptions jsonb NOT NULL DEFAULT '[]', -- ordered normMerchant-key list, entries verbatim
  ord                 integer NOT NULL DEFAULT 0
);
-- CREATE TABLE IF NOT EXISTS above skips the whole statement on an existing
-- table, so a column added after first deploy needs its own idempotent ALTER.
ALTER TABLE finance_settings ADD COLUMN IF NOT EXISTS dismissed_subscriptions jsonb NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS finance_items (
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id          text,                               -- extracted; NULL when absent/unusable
  access_token     text,                               -- ponytail: plaintext at rest, encrypt with pgcrypto when this leaves the tunnel
  institution_name text,
  cursor           text,                               -- Plaid sync cursor; extracted only
  raw              jsonb NOT NULL,                     -- the item entry verbatim — recompose truth
  ord              integer NOT NULL DEFAULT 0          -- array position is the identity (no PK)
);

CREATE TABLE IF NOT EXISTS finance_accounts (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id      text,                                -- extracted; NULL when absent/unusable
  item_id         text,                                -- soft ref (no FK): orphans are loader-valid
  name            text,
  mask            text,
  type            text,
  subtype         text,
  balance_current numeric,
  raw             jsonb NOT NULL,                      -- full Plaid account object, recomposed verbatim
  ord             integer NOT NULL DEFAULT 0           -- array position is the identity (no PK)
);

CREATE TABLE IF NOT EXISTS finance_transactions (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id text,                                 -- extracted; NULL when absent/unusable
  item_id        text,                                 -- soft ref (no FK)
  account_id     text,
  date           text,                                 -- 'YYYY-MM-DD'; text: the loader never validates it
  amount         numeric,                              -- Plaid sign: positive = money out
  name           text,
  merchant_name  text,
  pfc_primary    text,                                 -- personal_finance_category.primary
  raw            jsonb NOT NULL,                       -- full Plaid txn object, recomposed verbatim
  ord            integer NOT NULL DEFAULT 0            -- array position is the identity (no PK)
);
CREATE INDEX IF NOT EXISTS finance_transactions_user_date ON finance_transactions(user_id, date);

CREATE TABLE IF NOT EXISTS finance_overrides (
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id text NOT NULL,                        -- soft ref; may outlive the txn (tolerated)
  category       text,                                 -- NULL = category key absent from override
  is_transfer    boolean,                              -- NULL = isTransfer key absent; false suppresses heuristics
  ord            integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS finance_custom_categories (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cat     jsonb NOT NULL,                              -- {key,label,color} verbatim; dup keys are loader-valid
  ord     integer NOT NULL DEFAULT 0                   -- array position is the identity (no PK)
);

CREATE TABLE IF NOT EXISTS finance_budgets (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_key  text NOT NULL,                         -- builtin or custom; may dangle after category.remove (tolerated)
  monthly_limit jsonb NOT NULL,                        -- jsonb: Infinity arrives as JSON null and must round-trip
  ord           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, category_key)
);

CREATE TABLE IF NOT EXISTS finance_networth_history (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date      text,                                      -- extracted; multiple rows per date allowed (one per sync)
  net_worth numeric,                                   -- extracted; NULL when absent/unusable
  raw       jsonb NOT NULL,                            -- the history entry verbatim — recompose truth
  ord       integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS finance_widget_prefs (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  widget_id text NOT NULL,                             -- soft FK into page-board widget ids (orphans tolerated)
  range     text,                                      -- NULL = widgetId absent from ranges{}
  cat_view  text,                                      -- NULL = widgetId absent from categoryView{}
  ord       integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, widget_id)
);
`

const isObj = o => o !== null && typeof o === 'object'
const str = v => (typeof v === 'string' ? v : null)
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)

// Exact mirror of loadFinance()'s top-level normalization
// (atlas-ui/src/page/finance.js). Never mutates the wire value.
function normalizeFinance(raw) {
  const s = isObj(raw) ? raw : {}
  return {
    clientId: typeof s.clientId === 'string' ? s.clientId : '',
    secret: typeof s.secret === 'string' ? s.secret : '',
    env: s.env === 'production' ? 'production' : 'sandbox',
    items: Array.isArray(s.items) ? s.items : [],
    accounts: Array.isArray(s.accounts) ? s.accounts : [],
    transactions: Array.isArray(s.transactions) ? s.transactions : [],
    overrides: isObj(s.overrides) ? s.overrides : {},
    customCategories: Array.isArray(s.customCategories) ? s.customCategories : [],
    budgets: isObj(s.budgets) ? s.budgets : {},
    netWorthHistory: Array.isArray(s.netWorthHistory) ? s.netWorthHistory : [],
    dismissedAnomalies: Array.isArray(s.dismissedAnomalies) ? s.dismissedAnomalies : [],
    dismissedSubscriptions: Array.isArray(s.dismissedSubscriptions) ? s.dismissedSubscriptions : [],
    ranges: isObj(s.ranges) ? s.ranges : {},
    categoryView: isObj(s.categoryView) ? s.categoryView : {},
    lastSync: typeof s.lastSync === 'number' && Number.isFinite(s.lastSync) ? s.lastSync : 0,
  }
}

const mapper = {
  name: 'finance',
  storageKey: 'atlas.finance.v1',
  ddl,
  tables: [
    'finance_settings',
    'finance_items',
    'finance_accounts',
    'finance_transactions',
    'finance_overrides',
    'finance_custom_categories',
    'finance_budgets',
    'finance_networth_history',
    'finance_widget_prefs',
  ],

  decompose(raw) {
    const state = normalizeFinance(raw)
    const widgetIds = [...new Set([...Object.keys(state.ranges), ...Object.keys(state.categoryView)])]
    return {
      finance_settings: [{
        client_id: state.clientId,
        secret: state.secret,
        env: state.env,
        last_sync: state.lastSync,
        dismissed_anomalies: JSON.stringify(state.dismissedAnomalies), // jsonb, entries verbatim
        dismissed_subscriptions: JSON.stringify(state.dismissedSubscriptions), // jsonb, entries verbatim
      }],
      finance_items: state.items.map(i => ({
        item_id: str(i?.itemId),
        access_token: str(i?.accessToken),
        institution_name: str(i?.institutionName),
        cursor: str(i?.cursor),                          // null pre-first-sync (raw keeps the key)
        raw: JSON.stringify(i ?? null),                  // jsonb — truth
      })),
      finance_accounts: state.accounts.map(a => ({
        account_id: str(a?.account_id),
        item_id: str(a?.item_id),
        name: str(a?.name),
        mask: str(a?.mask),
        type: str(a?.type),
        subtype: str(a?.subtype),
        balance_current: num(a?.balances?.current),
        raw: JSON.stringify(a ?? null),                  // jsonb — truth
      })),
      finance_transactions: state.transactions.map(t => ({
        transaction_id: str(t?.transaction_id),
        item_id: str(t?.item_id),
        account_id: str(t?.account_id),
        date: str(t?.date),
        amount: num(t?.amount),
        name: str(t?.name),
        merchant_name: str(t?.merchant_name),
        pfc_primary: str(t?.personal_finance_category?.primary),
        raw: JSON.stringify(t ?? null),                  // jsonb — truth
      })),
      finance_overrides: Object.entries(state.overrides).map(([txnId, o]) => ({
        transaction_id: txnId,
        category: isObj(o) && 'category' in o ? o.category : null,
        // only a real boolean reaches the boolean column; anything else is
        // treated as key-absent rather than failing the save
        is_transfer: isObj(o) && typeof o.isTransfer === 'boolean' ? o.isTransfer : null,
      })),
      finance_custom_categories: state.customCategories.map(c => ({
        cat: JSON.stringify(c ?? null),                  // jsonb — verbatim, dup keys fine
      })),
      finance_budgets: Object.entries(state.budgets).map(([key, limit]) => ({
        category_key: key,
        monthly_limit: JSON.stringify(limit ?? null),    // jsonb: null (Infinity) / strings survive
      })),
      finance_networth_history: state.netWorthHistory.map(e => ({
        date: str(e?.date),
        net_worth: num(e?.netWorth),
        raw: JSON.stringify(e ?? null),                  // jsonb — truth
      })),
      finance_widget_prefs: widgetIds.map(w => ({
        widget_id: w,
        range: w in state.ranges ? state.ranges[w] : null,
        cat_view: w in state.categoryView ? state.categoryView[w] : null,
      })),
    }
  },

  recompose(rows) {
    const st = (rows.finance_settings || [])[0] ||
      { client_id: '', secret: '', env: 'sandbox', last_sync: 0, dismissed_anomalies: [], dismissed_subscriptions: [] }
    // Object.fromEntries everywhere a key is user/blob-controlled: a
    // '__proto__' key becomes a plain own property (no prototype writes).
    const overrides = Object.fromEntries((rows.finance_overrides || []).map(r => {
      const o = {}
      if (r.category !== null) o.category = r.category
      if (r.is_transfer !== null) o.isTransfer = r.is_transfer
      return [r.transaction_id, o]
    }))
    const budgets = Object.fromEntries(
      (rows.finance_budgets || []).map(r => [r.category_key, r.monthly_limit]))
    const prefs = rows.finance_widget_prefs || []
    const ranges = Object.fromEntries(
      prefs.filter(r => r.range !== null).map(r => [r.widget_id, r.range]))
    const categoryView = Object.fromEntries(
      prefs.filter(r => r.cat_view !== null).map(r => [r.widget_id, r.cat_view]))
    return {
      clientId: st.client_id,
      secret: st.secret,
      env: st.env,
      items: (rows.finance_items || []).map(r => r.raw),               // verbatim entry
      accounts: (rows.finance_accounts || []).map(r => r.raw),         // verbatim Plaid object
      transactions: (rows.finance_transactions || []).map(r => r.raw), // verbatim Plaid object
      overrides,
      customCategories: (rows.finance_custom_categories || []).map(r => r.cat), // verbatim
      budgets,
      netWorthHistory: (rows.finance_networth_history || []).map(r => r.raw),   // verbatim
      dismissedAnomalies: st.dismissed_anomalies,
      dismissedSubscriptions: st.dismissed_subscriptions,
      ranges,
      categoryView,
      lastSync: st.last_sync,
    }
  },
}

export default mapper
if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
