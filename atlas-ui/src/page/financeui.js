// Finance plugin UI: 9 live-view widgets over the local Plaid cache, a
// transaction recategorize modal, and the Finance-scoped Settings tab
// (connect a bank via Plaid Link, manual sync, budgets, custom categories).

import {
  loadFinance, saveFinance, financeConnected, startLink, finishLink, removeItem, syncAll,
  computeNetWorth, categoryKey, categoryLabel, BUILTIN_CATEGORIES, addCustomCategory, removeCustomCategory,
  setCategory, setCategories, setVendorRule, clearVendorRule, vendorKey, vendorTxnCount, applyCategoryToVendor, setTransferOverride, setTransferOverrides, isTransfer, PERIODS, rangeFor, setRange, categoryViewFor, setCategoryView,
  topTransactionsFor, recentTransactions, incomeExpenseFor, categoryBreakdown, monthlyTrend, detectSubscriptions,
  setBudget, budgetProgress, largeTransactions, dismissLargeTxn, dismissSubscription, txnLabel,
  largeThresholdOf, setLargeThreshold, LARGE_WINDOW_DAYS,
} from './finance.js'
import { barChart, lineChart } from './chart.js'

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const FIN_KINDS = ['fintopspend', 'finrecent', 'fincategory', 'finsubs', 'finaccounts', 'finincexp', 'finbudget', 'finnetworth', 'finanomaly']
const CHART_KINDS = ['fincategory', 'finincexp', 'finnetworth']

const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const shortDate = (iso) => { const d = new Date(iso + 'T12:00:00'); return `${d.getMonth() + 1}/${d.getDate()}` }

const head = (t) => `<p class="gym-head">${esc(t)}</p>`
const notConnected = () => `<p class="gym-empty">Connect a bank account in Finance → Settings to see this.</p>`
const rangePills = (w, s) => PERIODS.map(([k, l]) =>
  `<button type="button" class="wk-pill${k === rangeFor(s, w.id) ? ' is-on' : ''}" data-fin-range="${k}" data-wid="${esc(w.id)}">${l}</button>`).join('')

const txnRow = (t, s, { dismissible } = {}) => {
  const cat = categoryLabel(categoryKey(t, s), s)
  const transfer = isTransfer(t, s)
  return `<div class="wk-row fin-row" data-fin-txn="${esc(t.transaction_id)}">
    <span class="wk-date">${esc(shortDate(t.date))}</span>
    <span class="wk-time fin-label">${esc(txnLabel(t))}<span class="fin-cat">${esc(cat)}${transfer ? ' · transfer' : ''}</span></span>
    <span class="wk-earned fin-amt${t.amount > 0 ? ' fin-amt--out' : ' fin-amt--in'}">${money(-t.amount)}</span>
    ${dismissible ? `<button type="button" class="pw-item-remove" data-fin-act="dismiss-large" data-txn="${esc(t.transaction_id)}" title="Dismiss">×</button>` : ''}
  </div>`
}

export function financeWidgetHTML(w) {
  const s = loadFinance()
  const connected = financeConnected(s)

  if (w.kind === 'fintopspend') {
    if (!connected) return head('Top transactions') + notConnected()
    const rows = topTransactionsFor(s, rangeFor(s, w.id))
    return head('Top transactions') + `<div class="wk-pills">${rangePills(w, s)}</div>` +
      (rows.length ? `<div class="wk-rows fin-rows">${rows.map((t) => txnRow(t, s)).join('')}</div>` : '<p class="gym-empty">No transactions this period.</p>')
  }

  if (w.kind === 'finrecent') {
    if (!connected) return head('Recent transactions') + notConnected()
    const rows = recentTransactions(s)
    return head('Recent transactions') +
      (rows.length ? `<div class="wk-rows fin-rows">${rows.map((t) => txnRow(t, s)).join('')}</div>` : '<p class="gym-empty">No transactions yet — sync in Settings.</p>')
  }

  if (w.kind === 'fincategory') {
    if (!connected) return head('Spending by category') + notConnected()
    const view = categoryViewFor(s, w.id)
    const toggle = `<div class="wk-pills">
      <button type="button" class="wk-pill${view === 'breakdown' ? ' is-on' : ''}" data-fin-catview="breakdown" data-wid="${esc(w.id)}">Breakdown</button>
      <button type="button" class="wk-pill${view === 'trend' ? ' is-on' : ''}" data-fin-catview="trend" data-wid="${esc(w.id)}">6-month trend</button>
    </div>`
    const rangeRow = view === 'breakdown' ? `<div class="wk-pills">${rangePills(w, s)}</div>` : ''
    return head('Spending by category') + toggle + rangeRow + `<div class="chart-mount" data-widget-id="${esc(w.id)}"></div>`
  }

  if (w.kind === 'finsubs') {
    if (!connected) return head('Upcoming subscriptions') + notConnected()
    const subs = detectSubscriptions(s)
    if (!subs.length) {
      return head('Upcoming subscriptions')
        + '<p class="gym-empty">Nothing billing on a fixed schedule yet — a charge counts once it lands on the same date each month, or the same weekday each week.</p>'
    }
    const rows = subs.map((sub) => `<div class="wk-row fin-row">
      <span class="wk-time fin-label">${esc(sub.label)}<span class="fin-cat">${esc(sub.cadence)}</span></span>
      <span class="wk-earned fin-amt fin-amt--out">${money(sub.amount)}</span>
      <span class="wk-proj">next ${esc(shortDate(sub.nextDate))}</span>
      <button type="button" class="pw-item-remove" data-fin-act="dismiss-sub" data-subkey="${esc(sub.key)}" title="Not a subscription">×</button>
    </div>`).join('')
    return head('Upcoming subscriptions') + `<div class="wk-rows fin-rows fin-rows--subs">${rows}</div>`
  }

  if (w.kind === 'finaccounts') {
    if (!connected) return head('Accounts') + notConnected()
    if (!s.accounts.length) return head('Accounts') + '<p class="gym-empty">No accounts yet — sync in Settings.</p>'
    const rows = s.accounts.map((a) => {
      const isCredit = a.type === 'credit' || a.type === 'loan'
      const bal = Number(a.balances?.current) || 0
      return `<div class="fin-acct">
        <span class="fin-acct__name">${esc(a.name)}${a.mask ? ` <span class="fin-acct__mask">••${esc(a.mask)}</span>` : ''}</span>
        <span class="fin-acct__type">${esc(a.subtype || a.type || '')}</span>
        <span class="fin-amt${isCredit ? ' fin-amt--out' : ' fin-amt--in'}">${isCredit ? `${money(bal)} owed` : money(bal)}</span>
      </div>`
    }).join('')
    return head('Accounts') + `<div class="fin-accts">${rows}</div>`
  }

  if (w.kind === 'finincexp') {
    if (!connected) return head('Income vs. expenses') + notConnected()
    const inc = incomeExpenseFor(s, rangeFor(s, w.id))
    return head('Income vs. expenses') + `<div class="wk-pills">${rangePills(w, s)}</div>` +
      `<div class="chart-mount" data-widget-id="${esc(w.id)}"></div>
      <p class="gym-sub">Net ${inc.net >= 0 ? '+' : ''}${money(inc.net)}</p>`
  }

  if (w.kind === 'finbudget') {
    if (!connected) return head('Budgets') + notConnected()
    const rows = budgetProgress(s)
    if (!rows.length) return head('Budgets') + '<p class="gym-empty">Set monthly budgets in Finance → Settings.</p>'
    return head('Budgets') + `<div class="fin-budgets">${rows.map((b) => `
      <div class="fin-budget-row">
        <span class="fin-budget-label">${esc(b.label)}</span>
        <span class="fin-budget-nums">${money(b.spent)} / ${money(b.limit)}</span>
        <div class="fin-budget-bar"><div class="fin-budget-fill${b.pct > 100 ? ' fin-budget-fill--over' : ''}" style="width:${Math.min(100, b.pct).toFixed(1)}%"></div></div>
      </div>`).join('')}</div>`
  }

  if (w.kind === 'finnetworth') {
    if (!connected) return head('Net worth') + notConnected()
    const hist = s.netWorthHistory
    if (hist.length < 2) return head('Net worth') + `<div class="gym-big${computeNetWorth(s) < 0 ? '' : ' gym-big--num'}">${money(computeNetWorth(s))}</div>
      <p class="gym-sub">History builds up each time you sync (${hist.length} point${hist.length === 1 ? '' : 's'} so far).</p>`
    const cur = hist[hist.length - 1].netWorth
    return head('Net worth') + `<div class="chart-mount" data-widget-id="${esc(w.id)}"></div>
      <p class="gym-sub">Currently ${money(cur)}</p>`
  }

  // kind id stays 'finanomaly' — renaming it would orphan the widget on every
  // saved board. Only what you see changed.
  if (w.kind === 'finanomaly') {
    if (!connected) return head('Large transactions') + notConnected()
    const rows = largeTransactions(s)
    const min = largeThresholdOf(s)
    if (!rows.length) {
      return head('Large transactions')
        + `<p class="gym-empty">Nothing at or above ${money(min)} in the last ${LARGE_WINDOW_DAYS} days.</p>`
    }
    return head('Large transactions')
      + `<div class="wk-rows fin-rows">${rows.map((t) => txnRow(t, s, { dismissible: true })).join('')}</div>`
      + `<p class="gym-sub">At or above ${money(min)}, last ${LARGE_WINDOW_DAYS} days.</p>`
  }

  return ''
}

// Chart widgets draw through view.js's existing chart-mount + ResizeObserver
// plumbing (same mechanism as gymscoregraph) — these are called from
// drawChart() there, not invoked directly by financeWidgetHTML.
export function financeCategoryChartSVG(w, h, widgetId) {
  const s = loadFinance()
  const view = categoryViewFor(s, widgetId)
  return view === 'trend'
    ? barChart(monthlyTrend(s), { w, h, yLabel: 'Spent ($)' })
    : barChart(categoryBreakdown(s, rangeFor(s, widgetId)), { w, h, yLabel: 'Spent ($)' })
}
export function financeIncExpChartSVG(w, h, widgetId) {
  const s = loadFinance()
  const inc = incomeExpenseFor(s, rangeFor(s, widgetId))
  return barChart([{ label: 'Income', value: Math.round(inc.income * 100) / 100 }, { label: 'Expenses', value: Math.round(inc.expenses * 100) / 100 }], { w, h, yLabel: '$' })
}
export function financeNetWorthChartSVG(w, h) {
  const s = loadFinance()
  return lineChart(s.netWorthHistory.map((p) => ({ label: shortDate(p.date), value: Math.round(p.netWorth * 100) / 100 })), { w, h, yLabel: 'Net worth ($)' })
}

// ---- recategorize modal --------------------------------------------------------

function openTxnModal(s, txn) {
  document.querySelector('.fin-overlay')?.remove()
  const o = document.createElement('div')
  o.className = 'modal-overlay cal-overlay fin-overlay'
  const acct = s.accounts.find((a) => a.account_id === txn.account_id)
  const cur = categoryKey(txn, s)
  const others = vendorTxnCount(s, txn) - 1
  const opts = [...BUILTIN_CATEGORIES.map((k) => [k, categoryLabel(k, s)]), ...s.customCategories.map((c) => [c.key, c.label])]
  o.innerHTML = `<div class="cal-panel fin-panel">
    <div class="cal-panel__head"><h2 class="cal-panel__title">${esc(txnLabel(txn))}</h2>
      <button type="button" class="mail-iconbtn" data-fin="overlay-close" aria-label="Close">✕</button></div>
    <p class="cal-panel__cal">${esc(txn.date)} · ${esc(acct?.name || 'Account')} · ${money(-txn.amount)}</p>
    <div class="fin-modal-body">
      <label class="fin-field-label" for="fin-cat-select">Category</label>
      <select class="pw-field" id="fin-cat-select" data-fin="cat-select" data-txn="${esc(txn.transaction_id)}">
        ${opts.map(([k, l]) => `<option value="${esc(k)}"${k === cur ? ' selected' : ''}>${esc(l)}</option>`).join('')}
        <option value="__new__">+ New category…</option>
      </select>
      <div class="fin-newcat" hidden>
        <input class="pw-field" data-fin="newcat-input" placeholder="Category name">
        <button type="button" class="gym-btn" data-fin="newcat-add" data-txn="${esc(txn.transaction_id)}">Add</button>
      </div>
      ${others > 0 ? `<label class="gym-check">
        <input type="checkbox" data-fin="vendor-bulk" data-txn="${esc(txn.transaction_id)}">
        <span>Also recategorize the ${others} other <b>${esc(txnLabel(txn))}</b> transaction${others === 1 ? '' : 's'}</span>
      </label>` : ''}
      <label class="gym-check">
        <input type="checkbox" data-fin="vendor-rule" data-txn="${esc(txn.transaction_id)}"${s.vendorRules[vendorKey(txn)] ? ' checked' : ''}>
        <span>Always categorize <b>${esc(txnLabel(txn))}</b> this way</span>
      </label>
      <label class="gym-check">
        <input type="checkbox" data-fin="transfer-check" data-txn="${esc(txn.transaction_id)}"${isTransfer(txn, s) ? ' checked' : ''}>
        <span>This is a transfer between my own accounts</span>
      </label>
    </div>
  </div>`
  o.addEventListener('click', (e) => { if (e.target === o || e.target.closest('[data-fin="overlay-close"]')) o.remove() })
  document.body.appendChild(o)
}

// ---- interactions -------------------------------------------------------------

let rerenderApp = null

function onFinanceClick(e) {
  const pill = e.target.closest('[data-fin-range]')
  if (pill) { setRange(loadFinance(), pill.dataset.wid, pill.dataset.finRange); rerenderApp?.(); return }
  const cv = e.target.closest('[data-fin-catview]')
  if (cv) { setCategoryView(loadFinance(), cv.dataset.wid, cv.dataset.finCatview); rerenderApp?.(); return }
  const dismiss = e.target.closest('[data-fin-act="dismiss-large"]')
  if (dismiss) { dismissLargeTxn(loadFinance(), dismiss.dataset.txn); rerenderApp?.(); return }
  const dismissSub = e.target.closest('[data-fin-act="dismiss-sub"]')
  if (dismissSub) { dismissSubscription(loadFinance(), dismissSub.dataset.subkey); rerenderApp?.(); return }
  const addCat = e.target.closest('[data-fin="newcat-add"]')
  if (addCat) {
    const input = addCat.closest('.fin-newcat').querySelector('[data-fin="newcat-input"]')
    const lbl = input.value.trim()
    if (!lbl) return
    const s = loadFinance()
    const key = addCustomCategory(s, lbl)
    const txn = s.transactions.find((t) => t.transaction_id === addCat.dataset.txn)
    const cbody = addCat.closest('.fin-modal-body')
    if (txn && cbody?.querySelector('[data-fin="vendor-bulk"]')?.checked) applyCategoryToVendor(s, txn, key)
    else if (txn && cbody?.querySelector('[data-fin="vendor-rule"]')?.checked) setVendorRule(s, txn, key)
    else setCategory(s, addCat.dataset.txn, key)
    document.querySelector('.fin-overlay')?.remove()
    rerenderApp?.()
    return
  }
  if (e.target.closest('[data-fin="overlay-close"]')) return // handled on the overlay itself
  const row = e.target.closest('[data-fin-txn]')
  if (row && !e.target.closest('button, .fin-ex-check')) {
    const s = loadFinance()
    const txn = s.transactions.find((t) => t.transaction_id === row.dataset.finTxn)
    if (txn) openTxnModal(s, txn)
  }
}

function onFinanceChange(e) {
  const sel = e.target.closest('[data-fin="cat-select"]')
  if (sel) {
    if (sel.value === '__new__') {
      const body = sel.closest('.fin-modal-body')
      body.querySelector('.fin-newcat').hidden = false
      body.querySelector('[data-fin="newcat-input"]')?.focus()
      return
    }
    const s = loadFinance()
    const txn = s.transactions.find((t) => t.transaction_id === sel.dataset.txn)
    const body = sel.closest('.fin-modal-body')
    // Bulk "recategorize the others" → one-time vendor-wide override;
    // "Always categorize this vendor" → forward rule; otherwise a one-off.
    if (txn && body?.querySelector('[data-fin="vendor-bulk"]')?.checked) applyCategoryToVendor(s, txn, sel.value)
    else if (txn && body?.querySelector('[data-fin="vendor-rule"]')?.checked) setVendorRule(s, txn, sel.value)
    else setCategory(s, sel.dataset.txn, sel.value)
    rerenderApp?.()
    return
  }
  const bulk = e.target.closest('[data-fin="vendor-bulk"]')
  if (bulk) {
    if (!bulk.checked) return // untick is a no-op; already-applied overrides stand
    const s = loadFinance()
    const txn = s.transactions.find((t) => t.transaction_id === bulk.dataset.txn)
    const val = bulk.closest('.fin-modal-body')?.querySelector('[data-fin="cat-select"]')?.value
    if (txn && val && val !== '__new__') { applyCategoryToVendor(s, txn, val); rerenderApp?.() }
    return
  }
  const vr = e.target.closest('[data-fin="vendor-rule"]')
  if (vr) {
    const s = loadFinance()
    const txn = s.transactions.find((t) => t.transaction_id === vr.dataset.txn)
    if (!txn) return
    if (vr.checked) {
      const val = vr.closest('.fin-modal-body')?.querySelector('[data-fin="cat-select"]')?.value
      if (val && val !== '__new__') setVendorRule(s, txn, val)
    } else clearVendorRule(s, vendorKey(txn))
    rerenderApp?.()
    return
  }
  const chk = e.target.closest('[data-fin="transfer-check"]')
  if (chk) { setTransferOverride(loadFinance(), chk.dataset.txn, chk.checked); rerenderApp?.() }
}

export function bindFinance(rerender) {
  rerenderApp = rerender
  document.body.addEventListener('click', onFinanceClick)
  document.body.addEventListener('change', onFinanceChange)
}

// ---- explore tab: every synced transaction, filter/search/sort/export ----------

// Session-only filter state — survives re-renders (recategorize, tab bounce)
// but resets on reload, like the tip-share inputs in Work.
const ex = { q: '', account: '', category: '', from: '', to: '', min: '', max: '', sort: 'date', dir: 'desc', shown: 300, selected: new Set() }

function exFiltered(s) {
  const q = ex.q.trim().toLowerCase()
  const rows = s.transactions.filter((t) => {
    if (q && !`${t.merchant_name || ''} ${t.name || ''}`.toLowerCase().includes(q)) return false
    if (ex.account && t.account_id !== ex.account) return false
    if (ex.category && categoryKey(t, s) !== ex.category) return false
    if (ex.from && t.date < ex.from) return false
    if (ex.to && t.date > ex.to) return false
    const abs = Math.abs(t.amount)
    if (ex.min !== '' && abs < Number(ex.min)) return false
    if (ex.max !== '' && abs > Number(ex.max)) return false
    return true
  })
  const dir = ex.dir === 'asc' ? 1 : -1
  rows.sort((a, b) => {
    if (ex.sort === 'amount') return (Math.abs(a.amount) - Math.abs(b.amount)) * dir
    if (ex.sort === 'name') return txnLabel(a).localeCompare(txnLabel(b)) * dir
    return (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) * dir
  })
  return rows
}

function exportCSV(s, rows) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const acctName = (id) => s.accounts.find((a) => a.account_id === id)?.name || id
  const lines = ['Date,Name,Account,Category,Amount,Transfer', ...rows.map((t) =>
    [t.date, txnLabel(t), acctName(t.account_id), categoryLabel(categoryKey(t, s), s), -t.amount, isTransfer(t, s) ? 'yes' : ''].map(cell).join(','))]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'atlas-transactions.csv'
  a.click()
  URL.revokeObjectURL(a.href)
}

export function renderFinanceExplore(container) {
  const s = loadFinance()
  if (!financeConnected(s)) {
    container.innerHTML = `<div class="page"><p class="gym-empty">Connect a bank account in Finance → Settings, then every synced transaction shows up here.</p></div>`
    return
  }
  const cats = [...BUILTIN_CATEGORIES.map((k) => [k, categoryLabel(k, s)]), ...s.customCategories.map((c) => [c.key, c.label])]
  const arrow = (col) => (ex.sort === col ? (ex.dir === 'desc' ? ' ↓' : ' ↑') : '')
  container.innerHTML = `<div class="page fin-explore">
    <div class="fin-ex-filters">
      <input class="pw-field fin-ex-q" data-ex="q" placeholder="Search transactions…" value="${esc(ex.q)}" aria-label="Search">
      <select class="pw-field" data-ex="account" aria-label="Account">
        <option value="">All accounts</option>
        ${s.accounts.map((a) => `<option value="${esc(a.account_id)}"${ex.account === a.account_id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}
      </select>
      <select class="pw-field" data-ex="category" aria-label="Category">
        <option value="">All categories</option>
        ${cats.map(([k, l]) => `<option value="${esc(k)}"${ex.category === k ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <input class="pw-field" data-ex="from" type="date" value="${esc(ex.from)}" aria-label="From date" title="From date">
      <input class="pw-field" data-ex="to" type="date" value="${esc(ex.to)}" aria-label="To date" title="To date">
      <input class="pw-field wk-num" data-ex="min" type="number" min="0" placeholder="min $" value="${esc(ex.min)}" aria-label="Minimum amount">
      <input class="pw-field wk-num" data-ex="max" type="number" min="0" placeholder="max $" value="${esc(ex.max)}" aria-label="Maximum amount">
      <button type="button" class="gym-btn gym-btn--ghost" data-ex-act="csv">Export CSV</button>
    </div>
    <p class="gym-sub" id="fin-ex-summary"></p>
    <div class="fin-ex-bulk" id="fin-ex-bulk" hidden>
      <span class="fin-ex-bulk__count" id="fin-ex-selcount"></span>
      <select class="pw-field" id="fin-ex-bulkcat" aria-label="Set category for selected transactions">
        <option value="">Set category…</option>
        ${cats.map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}
      </select>
      <button type="button" class="gym-btn gym-btn--ghost" data-ex-act="transfer-on">Mark transfer</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-ex-act="transfer-off">Not transfer</button>
      <button type="button" class="gym-btn gym-btn--ghost" data-ex-act="clearsel">Clear</button>
    </div>
    <div class="wk-rows fin-rows fin-ex-rows">
      <div class="fin-ex-head">
        <input type="checkbox" class="fin-ex-check" id="fin-ex-selall" aria-label="Select all shown">
        <button type="button" class="fin-ex-sort" data-ex-sort="date">Date${arrow('date')}</button>
        <button type="button" class="fin-ex-sort" data-ex-sort="name">Name${arrow('name')}</button>
        <span class="fin-ex-sort fin-ex-sort--label">Account</span>
        <button type="button" class="fin-ex-sort fin-ex-sort--right" data-ex-sort="amount">Amount${arrow('amount')}</button>
      </div>
      <div style="display:contents" id="fin-ex-body"></div>
    </div>
    <button type="button" class="pw-add-item" id="fin-ex-more" hidden>Show all</button>
  </div>`

  const acctName = (id) => s.accounts.find((a) => a.account_id === id)?.name || ''
  const refresh = () => {
    const cur = loadFinance() // overrides may have changed via the modal
    const rows = exFiltered(cur)
    let income = 0, expenses = 0
    for (const t of rows) {
      if (isTransfer(t, cur)) continue
      if (t.amount > 0) expenses += t.amount
      else income += -t.amount
    }
    const summary = document.getElementById('fin-ex-summary')
    if (summary) summary.textContent =
      `${rows.length} transaction${rows.length === 1 ? '' : 's'} · ${money(income)} in · ${money(expenses)} out · net ${income - expenses >= 0 ? '+' : ''}${money(income - expenses)} (transfers excluded)`
    const shown = rows.slice(0, ex.shown)
    const body = document.getElementById('fin-ex-body')
    if (body) body.innerHTML = shown.map((t) => {
      const transfer = isTransfer(t, cur)
      const sel = ex.selected.has(t.transaction_id)
      return `<div class="wk-row fin-row fin-ex-row${sel ? ' is-selected' : ''}" data-fin-txn="${esc(t.transaction_id)}">
        <input type="checkbox" class="fin-ex-check" data-fin-sel="${esc(t.transaction_id)}"${sel ? ' checked' : ''} aria-label="Select transaction">
        <span class="wk-date">${esc(t.date)}</span>
        <span class="wk-time fin-label">${esc(txnLabel(t))}<span class="fin-cat">${esc(categoryLabel(categoryKey(t, cur), cur))}${transfer ? ' · transfer' : ''}</span></span>
        <span class="fin-ex-acct">${esc(acctName(t.account_id))}</span>
        <span class="wk-earned fin-amt${t.amount > 0 ? ' fin-amt--out' : ' fin-amt--in'}">${money(-t.amount)}</span>
      </div>`
    }).join('') || '<p class="gym-empty">No transactions match these filters.</p>'
    const more = document.getElementById('fin-ex-more')
    if (more) {
      more.hidden = rows.length <= ex.shown
      more.textContent = `Show all ${rows.length}`
    }
    // Bulk bar reflects the whole selection; select-all reflects the shown rows.
    const shownIds = shown.map((t) => t.transaction_id)
    const total = ex.selected.size
    const bulk = document.getElementById('fin-ex-bulk')
    if (bulk) {
      bulk.hidden = total === 0
      const c = document.getElementById('fin-ex-selcount')
      if (c) c.textContent = `${total} selected`
      const cat = document.getElementById('fin-ex-bulkcat')
      if (cat) cat.value = ''
    }
    const selall = document.getElementById('fin-ex-selall')
    if (selall) {
      const vis = shownIds.filter((id) => ex.selected.has(id)).length
      selall.checked = vis > 0 && vis === shownIds.length
      selall.indeterminate = vis > 0 && vis < shownIds.length
    }
  }
  refresh()

  // Text/number/date filters re-fill only the table body — a full re-render
  // per keystroke would drop input focus.
  container.oninput = (e) => {
    const f = e.target.closest('[data-ex]')
    if (!f) return
    ex[f.dataset.ex] = f.value
    ex.shown = 300
    refresh()
  }
  container.onclick = (e) => {
    const selBox = e.target.closest('[data-fin-sel]')
    if (selBox) {
      const id = selBox.dataset.finSel
      if (selBox.checked) ex.selected.add(id)
      else ex.selected.delete(id)
      refresh()
      return
    }
    if (e.target.id === 'fin-ex-selall') {
      const shownIds = exFiltered(loadFinance()).slice(0, ex.shown).map((t) => t.transaction_id)
      if (e.target.checked) shownIds.forEach((id) => ex.selected.add(id))
      else shownIds.forEach((id) => ex.selected.delete(id))
      refresh()
      return
    }
    if (e.target.closest('[data-ex-act="clearsel"]')) { ex.selected.clear(); refresh(); return }
    const tOn = e.target.closest('[data-ex-act="transfer-on"]')
    const tOff = e.target.closest('[data-ex-act="transfer-off"]')
    if (tOn || tOff) {
      if (ex.selected.size) { setTransferOverrides(loadFinance(), [...ex.selected], !!tOn); refresh() }
      return // selection kept so category + transfer can be applied to the same rows
    }
    const sort = e.target.closest('[data-ex-sort]')
    if (sort) {
      const col = sort.dataset.exSort
      if (ex.sort === col) ex.dir = ex.dir === 'desc' ? 'asc' : 'desc'
      else { ex.sort = col; ex.dir = 'desc' }
      renderFinanceExplore(container) // header arrows need the re-render
      return
    }
    if (e.target.closest('[data-ex-act="csv"]')) exportCSV(loadFinance(), exFiltered(loadFinance()))
    else if (e.target.id === 'fin-ex-more') { ex.shown = Infinity; refresh() }
    // row clicks fall through to the document-level onFinanceClick → modal
  }
  // Bulk category apply for the current selection (selection kept for chaining).
  container.onchange = (e) => {
    const cat = e.target.closest('#fin-ex-bulkcat')
    if (!cat || !cat.value || !ex.selected.size) return
    setCategories(loadFinance(), [...ex.selected], cat.value)
    refresh() // updates the explore rows in place; other views reload from storage
  }
}

// ---- settings tab ---------------------------------------------------------------

const NON_BUDGETABLE = new Set(['INCOME', 'TRANSFER_IN', 'TRANSFER_OUT', 'LOAN_PAYMENTS', 'LOAN_DISBURSEMENTS'])
const timeAgo = (ts) => {
  if (!ts) return 'never'
  const mins = Math.round((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`
}

export function renderFinanceSettings(container, rerender) {
  const s = loadFinance()
  const budgetKeys = [...BUILTIN_CATEGORIES.filter((k) => !NON_BUDGETABLE.has(k)), ...s.customCategories.map((c) => c.key)]
  container.innerHTML = `<div class="page gym-settings fin-settings">
    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Plaid credentials</span>
        <span class="set-row__sub">From your Plaid dashboard. Stored locally and sent only to the dev server, which relays to Plaid — never to a third party.</span></div>
    </div>
    <div class="fin-conn-fields">
      <input class="pw-field" id="fin-clientid" placeholder="Client ID" value="${esc(s.clientId)}" aria-label="Plaid client ID">
      <input class="pw-field" id="fin-secret" type="password" placeholder="Secret" value="${esc(s.secret)}" aria-label="Plaid secret">
      <select class="pw-field" id="fin-env" aria-label="Plaid environment">
        <option value="sandbox"${s.env === 'sandbox' ? ' selected' : ''}>Sandbox</option>
        <option value="production"${s.env === 'production' ? ' selected' : ''}>Production</option>
      </select>
    </div>
    ${s.items.length ? `<div class="fin-items">${s.items.map((i) => `
      <div class="set-row">
        <div class="set-row__meta"><span class="set-row__name">${esc(i.institutionName)}</span></div>
        <button type="button" class="gym-btn gym-btn--ghost" data-fin-set="disconnect" data-item-id="${esc(i.itemId)}">Disconnect</button>
      </div>`).join('')}</div>` : ''}
    <div class="fin-conn-acts">
      <button type="button" class="gym-btn" data-fin-set="connect">${s.items.length ? 'Add another bank' : 'Connect a bank'}</button>
      ${s.items.length ? `<button type="button" class="gym-btn gym-btn--ghost" data-fin-set="sync">Sync now</button>` : ''}
      <span class="set-row__sub" id="fin-status">${s.items.length ? `Last synced ${timeAgo(s.lastSync)}` : ''}</span>
    </div>

    <div class="set-row">
      <div class="set-row__meta"><span class="set-row__name">Large transaction threshold</span>
        <span class="set-row__sub">The Large transactions widget flags anything at or above this, from the last ${LARGE_WINDOW_DAYS} days.</span></div>
      <input class="pw-field wk-num" id="fin-large-threshold" type="number" min="1" step="10"
        value="${esc(largeThresholdOf(s))}" aria-label="Large transaction threshold in dollars">
    </div>

    <div class="set-row"><div class="set-row__meta"><span class="set-row__name">Budgets</span>
      <span class="set-row__sub">Monthly limit per category — the Budgets widget tracks progress against these.</span></div></div>
    <div class="fin-budget-set">${budgetKeys.map((k) => `
      <div class="fin-budget-set-row">
        <span>${esc(categoryLabel(k, s))}</span>
        <input class="pw-field wk-num" type="number" min="0" step="1" placeholder="0" value="${esc(s.budgets[k] || '')}" data-fin-budget="${esc(k)}" aria-label="Monthly budget for ${esc(categoryLabel(k, s))}">
      </div>`).join('')}</div>

    <div class="set-row"><div class="set-row__meta"><span class="set-row__name">Custom categories</span>
      <span class="set-row__sub">Also creatable on the fly from a transaction's recategorize panel.</span></div></div>
    <div class="fin-customcats">${s.customCategories.map((c) => `
      <div class="fin-customcat-row">
        <span class="fin-cat-dot" style="background:${esc(c.color)}"></span>
        <span>${esc(c.label)}</span>
        <button type="button" class="pw-item-remove" data-fin-set="del-cat" data-key="${esc(c.key)}" title="Delete category">×</button>
      </div>`).join('')}
      <div class="fin-newcat-set">
        <input class="pw-field" id="fin-newcat-set-input" placeholder="New category name">
        <button type="button" class="gym-btn" data-fin-set="add-cat">Add</button>
      </div>
    </div>
  </div>`

  container.onclick = async (e) => {
    const el = e.target.closest('[data-fin-set]')
    if (!el) return
    const act = el.dataset.finSet
    if (act === 'connect') {
      const s2 = loadFinance()
      s2.clientId = container.querySelector('#fin-clientid').value.trim()
      s2.secret = container.querySelector('#fin-secret').value.trim()
      s2.env = container.querySelector('#fin-env').value
      saveFinance(s2)
      el.disabled = true
      const statusEl = container.querySelector('#fin-status')
      if (statusEl) statusEl.textContent = 'Opening Plaid Link…'
      try {
        const linked = await startLink(s2)
        if (linked) {
          await finishLink(s2, linked.public_token, linked.institutionName)
          if (statusEl) statusEl.textContent = 'Syncing…'
          await syncAll(loadFinance())
        }
      } catch (err) {
        if (statusEl) statusEl.textContent = err.message
      }
      renderFinanceSettings(container, rerender)
      rerender?.()
    } else if (act === 'sync') {
      el.disabled = true
      const statusEl = container.querySelector('#fin-status')
      if (statusEl) statusEl.textContent = 'Syncing…'
      try { await syncAll(loadFinance()) } catch (err) { if (statusEl) statusEl.textContent = err.message }
      renderFinanceSettings(container, rerender)
      rerender?.()
    } else if (act === 'disconnect') {
      removeItem(loadFinance(), el.dataset.itemId)
      renderFinanceSettings(container, rerender)
      rerender?.()
    } else if (act === 'del-cat') {
      removeCustomCategory(loadFinance(), el.dataset.key)
      renderFinanceSettings(container, rerender)
      rerender?.()
    } else if (act === 'add-cat') {
      const input = container.querySelector('#fin-newcat-set-input')
      const lbl = input.value.trim()
      if (!lbl) return
      addCustomCategory(loadFinance(), lbl)
      renderFinanceSettings(container, rerender)
      rerender?.()
    }
  }
  container.oninput = (e) => {
    if (e.target.id === 'fin-large-threshold') {
      // blank means "still typing", not "no threshold" — don't stomp the value
      if (e.target.value.trim() === '') return
      setLargeThreshold(loadFinance(), e.target.value)
      rerender?.()
      return
    }
    const b = e.target.closest('[data-fin-budget]')
    if (!b) return
    setBudget(loadFinance(), b.dataset.finBudget, Number(b.value) || 0)
  }
}
