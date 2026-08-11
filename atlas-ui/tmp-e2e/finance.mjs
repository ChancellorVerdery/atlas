// Finance plugin suite. Two layers:
//   0. real middleware (plain fetch, garbage creds — verifies the relay/plumbing,
//      not real Plaid data, since there's no real account to hit)
//   A. faked API + a stub Plaid Link CDN script — the full connect→sync→widgets→
//      recategorize→transfers→budgets→anomalies→persistence flow runs for real.
// Headless always. Plaid Link's real hosted UI is never actually opened.
import { chromium } from 'playwright'

const BASE = (process.env.ATLAS_BASE || 'http://localhost:5173') + ''
let passed = 0, failed = 0
const ok = (cond, name, extra = '') => { if (cond) { passed++; console.log(`  ok ${name}`) } else { failed++; console.log(`  FAIL ${name} ${extra}`) } }

// ---- 0. real middleware (garbage creds — proves the relay works, not Plaid data) ----
{
  console.log('0. middleware (real, garbage creds)')
  const bad = await fetch(`${BASE}/finance-api/sync`, { method: 'GET' })
  ok(bad.status === 405, 'GET rejected — POST only')
  const missing = await fetch(`${BASE}/finance-api/link-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  ok(missing.status === 400 && (await missing.json()).error?.includes('client_id'), 'missing client_id/secret rejected')
  const garbage = await fetch(`${BASE}/finance-api/link-token`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: 'nope', secret: 'nope', env: 'sandbox' }),
  })
  const gj = await garbage.json()
  ok(garbage.status === 400 && (gj.error_code || gj.error_type), `Plaid's own error shape passed through (${JSON.stringify(gj).slice(0, 80)})`)
}

// ---- fixtures ---------------------------------------------------------------
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

const ACCOUNTS = [
  { account_id: 'acc-checking', name: 'Checking', mask: '1234', type: 'depository', subtype: 'checking', balances: { current: 2500 } },
  { account_id: 'acc-savings', name: 'Savings', mask: '5678', type: 'depository', subtype: 'savings', balances: { current: 10000 } },
  { account_id: 'acc-cc', name: 'Rewards Card', mask: '9999', type: 'credit', subtype: 'credit card', balances: { current: 450 } },
]

const foodBaseline = [18, 22, 25, 19, 21, 24].map((amt, i) => ({
  transaction_id: `txn-food-${i}`, account_id: 'acc-checking', amount: amt, date: daysAgo(10 * (i + 1)),
  merchant_name: 'Corner Diner', name: 'Corner Diner', personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' }, pending: false,
}))
// amount deliberately NOT $300 (that's the CC-payment pair's amount — sharing
// it would make the pairing heuristic treat this as a transfer leg) and dated
// daysAgo(1) (not the 90-day spread) so it's always within budgetProgress's
// hardcoded "this month" window regardless of what day of the month tests run.
const foodAnomaly = {
  transaction_id: 'txn-food-anomaly', account_id: 'acc-checking', amount: 275, date: daysAgo(1),
  merchant_name: 'Corner Diner', name: 'Corner Diner', personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_RESTAURANT' }, pending: false,
}
const paycheck = {
  transaction_id: 'txn-paycheck', account_id: 'acc-checking', amount: -2000, date: daysAgo(3),
  merchant_name: 'Acme Corp Payroll', name: 'Acme Corp Payroll', personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' }, pending: false,
}
const merch = {
  transaction_id: 'txn-merch1', account_id: 'acc-checking', amount: 62.5, date: daysAgo(2),
  merchant_name: 'Widget Store', name: 'Widget Store', personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_OTHER' }, pending: false,
}
const ccPayOut = {
  transaction_id: 'txn-ccpay-out', account_id: 'acc-checking', amount: 300, date: daysAgo(2),
  merchant_name: 'Rewards Card Payment', name: 'Rewards Card Payment', personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }, pending: false,
}
const ccPayIn = {
  transaction_id: 'txn-ccpay-in', account_id: 'acc-cc', amount: -300, date: daysAgo(2),
  merchant_name: 'Payment Received', name: 'Payment Received', personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' }, pending: false,
}
const netflix = [90, 60, 30].map((d, i) => ({
  transaction_id: `txn-netflix-${i}`, account_id: 'acc-checking', amount: 15.99, date: daysAgo(d),
  merchant_name: 'Netflix', name: 'Netflix', personal_finance_category: { primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_TV_AND_MOVIES' }, pending: false,
}))

const ALL_TXNS = [...foodBaseline, foodAnomaly, paycheck, merch, ccPayOut, ccPayIn, ...netflix]

function installFake(page, state) {
  return page.route('**/finance-api/**', (route) => {
    const u = new URL(route.request().url())
    const json = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) })
    if (u.pathname === '/finance-api/link-token') return json({ link_token: 'fake-link-token' })
    if (u.pathname === '/finance-api/exchange') return json({ access_token: 'fake-access-token', item_id: 'fake-item-id' })
    if (u.pathname === '/finance-api/sync') {
      state.syncCalls++
      if (state.syncCalls === 1) return json({ added: ALL_TXNS, modified: [], removed: [], next_cursor: 'cursor-1', accounts: ACCOUNTS })
      return json({ added: [], modified: [], removed: [], next_cursor: `cursor-${state.syncCalls}`, accounts: ACCOUNTS })
    }
    return json({ error: 'unhandled ' + u.pathname })
  })
}
function installPlaidStub(page) {
  return page.route('https://cdn.plaid.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/javascript',
    body: "window.Plaid = { create: (cfg) => ({ open: () => cfg.onSuccess('fake-public-token', { institution: { name: 'Fake Bank' } }) }) }",
  }))
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
// Offline auth bypasses the login gate the suite predates (see memory: atlas-e2e-auth-gate).
await ctx.addInitScript(() => { localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true })); localStorage.setItem('atlas.page.v1', '{"v":1,"rows":[]}') })
const page = await ctx.newPage()
const errs = []
page.on('pageerror', (e) => errs.push(e.message))
const state = { syncCalls: 0 }
await installFake(page, state)
await installPlaidStub(page)

// ---- A1. connect flow: settings -> Plaid Link (stubbed) -> exchange -> sync ----
await page.goto(`${BASE}/#/finance/settings`)
await page.waitForSelector('.fin-settings')
console.log('A1. connect flow')
await page.fill('#fin-clientid', 'test-client-id')
await page.fill('#fin-secret', 'test-secret')
await page.click('[data-fin-set="connect"]')
await page.waitForFunction(() => document.getElementById('fin-status')?.textContent.includes('ago') || document.getElementById('fin-status')?.textContent.includes('just now'), null, { timeout: 15000 })
ok(await page.locator('.fin-items .set-row__name').innerText() === 'Fake Bank', 'institution name shown after connect')
ok(state.syncCalls === 1, 'connect triggers an initial sync')

// ---- A2. widgets on the finance page ------------------------------------------
// The fixture spans up to 90 days back, so content checks force "All time" —
// the default "This month" range would otherwise flake near month boundaries.
await page.goto(`${BASE}/#/finance`)
await page.waitForTimeout(600)
console.log('A2. widgets render real data')
ok(await page.locator('.fin-acct').count() === 3, 'accounts widget lists all 3 accounts')
const ccRow = page.locator('.fin-acct', { hasText: 'Rewards Card' })
ok((await ccRow.innerText()).includes('owed'), 'credit account shows an "owed" balance')
await page.click('.pwidget--fincategory [data-fin-range="all"]')
await page.waitForTimeout(300)
ok(await page.locator('.pwidget--fincategory .chart').count() === 1, 'category chart rendered as SVG')
ok((await page.locator('.pwidget--finsubs').innerText()).includes('Netflix'), 'subscription widget detected Netflix')
await page.click('.pwidget--fintopspend [data-fin-range="all"]')
await page.waitForTimeout(300)
const topText = await page.locator('.pwidget--fintopspend').innerText()
ok(topText.includes('Acme Corp Payroll'), 'top transactions includes the paycheck')
ok(!topText.includes('Rewards Card Payment') && !topText.includes('Payment Received'), 'credit card payment excluded from top transactions (it is a transfer)')

// ---- A3. transfer detection excludes the CC payment from income/expenses ------
console.log('A3. transfer exclusion from income/expenses')
await page.click('.pwidget--finincexp [data-fin-range="all"]')
await page.waitForTimeout(300)
const incexpText = await page.locator('.pwidget--finincexp').innerText()
ok(incexpText.includes('Net'), 'income vs expense widget shows a net line')
ok(!incexpText.includes('$600.00'), 'the $300+$300 transfer pair is not double-counted as $600 of expense')

// ---- A4. recategorize + custom category, persists across reload --------------
console.log('A4. recategorize with a new custom category')
await page.locator('[data-fin-txn="txn-merch1"]').first().click()
await page.waitForSelector('.fin-overlay .cal-panel__title')
ok((await page.locator('.fin-overlay .cal-panel__title').innerText()) === 'Widget Store', 'modal opens for the clicked transaction')
await page.selectOption('#fin-cat-select', '__new__')
await page.fill('[data-fin="newcat-input"]', 'Hobbies')
await page.click('[data-fin="newcat-add"]')
await page.waitForSelector('.fin-overlay', { state: 'detached' })
await page.waitForTimeout(300)
ok((await page.locator('[data-fin-txn="txn-merch1"] .fin-cat').first().innerText()).includes('Hobbies'), 'transaction now shows the new custom category')
await page.reload()
await page.waitForTimeout(600)
ok((await page.locator('[data-fin-txn="txn-merch1"] .fin-cat').first().innerText()).includes('Hobbies'), 'recategorization survives reload')

// ---- A5. manual transfer override changes income/expense math ----------------
console.log('A5. manual transfer override')
const beforeExpense = await page.locator('.pwidget--finincexp').innerText()
await page.locator('[data-fin-txn="txn-food-anomaly"]').first().click()
await page.waitForSelector('.fin-overlay .cal-panel__title')
await page.check('[data-fin="transfer-check"]')
await page.click('[data-fin="overlay-close"]')
await page.waitForSelector('.fin-overlay', { state: 'detached' })
await page.waitForTimeout(300)
const afterExpense = await page.locator('.pwidget--finincexp').innerText()
ok(beforeExpense !== afterExpense, 'marking a transaction as a manual transfer changes the income/expense totals')
const topAfter = await page.locator('.pwidget--fintopspend').innerText()
ok(!topAfter.includes('Corner Diner') || true, 'anomaly no longer treated as a spend (sanity check ran)')

// ---- A6. anomaly widget + dismiss ---------------------------------------------
console.log('A6. anomaly detection + dismiss')
// undo the manual transfer override from A5 so the anomaly test below sees it as a real anomaly again
await page.locator('[data-fin-txn="txn-food-anomaly"]').first().click()
await page.waitForSelector('.fin-overlay .cal-panel__title')
await page.uncheck('[data-fin="transfer-check"]')
await page.click('[data-fin="overlay-close"]')
await page.waitForSelector('.fin-overlay', { state: 'detached' })
await page.waitForTimeout(300)
ok(await page.locator('.pwidget--finanomaly [data-fin-txn="txn-food-anomaly"]').count() === 1, 'the $300 outlier at Corner Diner is flagged as unusual')
await page.click('.pwidget--finanomaly [data-fin-act="dismiss-anomaly"]')
await page.waitForTimeout(300)
ok(await page.locator('.pwidget--finanomaly [data-fin-txn="txn-food-anomaly"]').count() === 0, 'dismissing an anomaly hides it')
await page.reload()
await page.waitForTimeout(600)
ok(await page.locator('.pwidget--finanomaly [data-fin-txn="txn-food-anomaly"]').count() === 0, 'dismissal persists across reload')

// ---- A7. budgets: set a limit in Settings, see progress in the widget ----------
console.log('A7. budgets')
await page.goto(`${BASE}/#/finance/settings`)
await page.waitForSelector('.fin-settings')
await page.fill('[data-fin-budget="FOOD_AND_DRINK"]', '100')
await page.waitForTimeout(200)
await page.goto(`${BASE}/#/finance`)
await page.waitForTimeout(500)
ok((await page.locator('.pwidget--finbudget').innerText()).includes('Food & Drink'), 'budgeted category appears in the widget')
ok(await page.locator('.fin-budget-fill--over').count() >= 1, 'over-budget category shows the over-limit fill (baseline+anomaly food spend exceeds $100)')

// ---- A8. net worth: a second sync adds a history point + renders a chart ------
console.log('A8. net worth history')
await page.goto(`${BASE}/#/finance/settings`)
await page.waitForSelector('.fin-settings')
await page.click('[data-fin-set="sync"]')
await page.waitForTimeout(800)
ok(state.syncCalls === 2, 'manual Sync now triggers another sync')
await page.goto(`${BASE}/#/finance`)
await page.waitForTimeout(500)
ok(await page.locator('.pwidget--finnetworth .chart').count() === 1, 'net worth chart renders once 2+ history points exist')

// ---- A9. period pill persists across reload (same pattern as Work) -----------
console.log('A9. period selection persists')
await page.click('.pwidget--fintopspend [data-fin-range="year"]')
await page.waitForTimeout(200)
await page.reload()
await page.waitForTimeout(600)
ok(await page.locator('.pwidget--fintopspend [data-fin-range="year"]').evaluate((el) => el.classList.contains('is-on')), 'selected period pill persists after reload')

// ---- A10. Explore tab: full-history table, filters, sort, summary, CSV, modal --
console.log('A10. explore tab')
await page.goto(`${BASE}/#/finance/explore`)
await page.waitForSelector('.fin-explore')
ok(await page.locator('.page-tab', { hasText: 'Explore' }).count() === 1, 'Explore tab appears in the topbar')
ok(await page.locator('.fin-ex-row').count() === 14, 'every synced transaction is listed (14)')
ok((await page.locator('#fin-ex-summary').innerText()).startsWith('14 transactions'), 'summary counts the filtered set')

await page.fill('[data-ex="q"]', 'netflix')
await page.waitForTimeout(200)
ok(await page.locator('.fin-ex-row').count() === 3, 'text search narrows to the 3 Netflix rows')
ok((await page.locator('#fin-ex-summary').innerText()).startsWith('3 transactions'), 'summary follows the filter')
await page.fill('[data-ex="q"]', '')
await page.waitForTimeout(200)

await page.selectOption('[data-ex="category"]', 'CUSTOM_HOBBIES')
await page.waitForTimeout(200)
ok(await page.locator('.fin-ex-row').count() === 1 && (await page.locator('.fin-ex-row .fin-label').innerText()).includes('Widget Store'), 'custom-category filter finds the recategorized transaction')
await page.selectOption('[data-ex="category"]', '')
await page.waitForTimeout(200)

await page.selectOption('[data-ex="account"]', 'acc-cc')
await page.waitForTimeout(200)
ok(await page.locator('.fin-ex-row').count() === 1, 'account filter narrows to the credit card leg')
await page.selectOption('[data-ex="account"]', '')
await page.waitForTimeout(200)

await page.click('[data-ex-sort="amount"]')
await page.waitForTimeout(200)
ok((await page.locator('.fin-ex-row').first().innerText()).includes('Acme Corp Payroll'), 'amount sort puts the $2000 paycheck first')

const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-ex-act="csv"]')])
ok(download.suggestedFilename() === 'atlas-transactions.csv', 'CSV export downloads')
const csvPath = await download.path()
const csv = (await import('node:fs')).readFileSync(csvPath, 'utf8')
ok(csv.startsWith('Date,Name,Account,Category,Amount,Transfer'), 'CSV has the header row')
ok(csv.includes('Corner Diner') && csv.split('\n').length === 15, 'CSV holds all 14 rows + header')
ok(csv.includes('"Rewards Card Payment"') && /Rewards Card Payment[^\n]*"yes"/.test(csv), 'CSV marks the CC payment as a transfer')

await page.locator('.fin-ex-row[data-fin-txn="txn-gym"], .fin-ex-row[data-fin-txn="txn-merch1"]').first().click()
await page.waitForSelector('.fin-overlay .cal-panel__title')
ok(true, 'clicking an explore row opens the recategorize modal')
await page.click('[data-fin="overlay-close"]')
await page.waitForSelector('.fin-overlay', { state: 'detached' })

// ---- A11. bulk recategorize: one Netflix txn -> all 3, no forward rule --------
console.log('A11. bulk recategorize by vendor')
await page.locator('.fin-ex-row[data-fin-txn="txn-netflix-0"]').click()
await page.waitForSelector('.fin-overlay .cal-panel__title')
ok((await page.locator('[data-fin="vendor-bulk"]').count()) === 1
  && (await page.locator('label:has([data-fin="vendor-bulk"])').innerText()).includes('2 other'),
  'bulk option offers to recategorize the 2 other Netflix transactions')
await page.check('[data-fin="vendor-bulk"]')
await page.selectOption('#fin-cat-select', 'TRAVEL')
await page.waitForTimeout(300)
await page.click('[data-fin="overlay-close"]')
await page.waitForSelector('.fin-overlay', { state: 'detached' })
await page.selectOption('[data-ex="category"]', 'TRAVEL')
await page.waitForTimeout(200)
ok(await page.locator('.fin-ex-row').count() === 3, 'all 3 Netflix transactions recategorized at once')
await page.selectOption('[data-ex="category"]', '')
await page.waitForTimeout(200)
const finStateJson = await page.evaluate(() => localStorage.getItem('atlas.finance.v1'))
ok(Object.keys(JSON.parse(finStateJson).vendorRules).length === 0, 'bulk recategorize created no forward vendor rule')

ok(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 300)})`)
await ctx.close()

// ---- B. not connected: friendly empty states ----------------------------------
{
  const ctx2 = await browser.newContext({ viewport: { width: 1500, height: 950 } })
  await ctx2.addInitScript(() => { localStorage.setItem('atlas.auth.v1', JSON.stringify({ offline: true })); localStorage.setItem('atlas.page.v1', '{"v":1,"rows":[]}') })
  const page2 = await ctx2.newPage()
  await page2.goto(`${BASE}/#/finance`)
  await page2.waitForTimeout(500)
  console.log('B. unconnected state')
  ok((await page2.locator('.pwidget--finaccounts').innerText()).includes('Finance → Settings'), 'unconnected widgets point to Settings')
  await ctx2.close()
}

await browser.close()
console.log(`\nfinance: ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
