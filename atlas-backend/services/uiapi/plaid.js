// Plaid relay. The browser can't hold a client secret and Plaid's REST API has
// no CORS, so every call is relayed. The client sends its own
// client_id/secret/env (from Finance → Settings) in each request body — nothing
// is provisioned or stored here, so this service holds no Plaid credentials of
// its own. Moved from the Mac (atlas-ui/server/middlewares.js) unchanged apart
// from the body reader.
const BASE = { sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' }

// 1MB. The largest legitimate body is an access_token plus a cursor; the reader
// this replaced had no cap at all, which is an unbounded-memory POST sink once
// the handler is reachable over a network.
const BODY_CAP = 1e6

const readBody = (req) => new Promise((resolve, reject) => {
  let size = 0
  const chunks = []
  req.on('data', (c) => {
    size += c.length
    if (size > BODY_CAP) { reject(new Error('payload too large')); req.destroy(); return }
    chunks.push(c)
  })
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
    catch (e) { reject(e) }
  })
  req.on('error', reject)
})

async function plaid(env, path, body) {
  const r = await fetch(`${BASE[env] || BASE.sandbox}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const j = await r.json()
  if (!r.ok) throw Object.assign(new Error(j.error_message || `Plaid error ${r.status}`), { plaid: j })
  return j
}

export async function plaidApi(req, res) {
  const u = new URL(req.url, 'http://x')
  const json = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) }
  if (req.method !== 'POST') return json(405, { error: 'POST only' })
  let body
  try { body = await readBody(req) } catch { return json(400, { error: 'bad request body' }) }
  const { client_id, secret, env } = body
  if (!client_id || !secret) return json(400, { error: 'missing client_id/secret' })
  const base = { client_id, secret }
  try {
    if (u.pathname === '/link-token') {
      const j = await plaid(env, '/link/token/create', {
        ...base,
        client_name: 'Atlas',
        language: 'en',
        country_codes: ['US'],
        user: { client_user_id: 'atlas-local' },
        products: ['transactions'],
      })
      return json(200, { link_token: j.link_token })
    }
    if (u.pathname === '/exchange') {
      const j = await plaid(env, '/item/public_token/exchange', { ...base, public_token: body.public_token })
      return json(200, { access_token: j.access_token, item_id: j.item_id })
    }
    if (u.pathname === '/accounts') {
      const j = await plaid(env, '/accounts/balance/get', { ...base, access_token: body.access_token })
      return json(200, { accounts: j.accounts })
    }
    if (u.pathname === '/sync') {
      // Plaid paginates via has_more/next_cursor — loop here so the client gets
      // one complete batch per manual "Sync now" click.
      let cursor = body.cursor || undefined
      let added = [], modified = [], removed = [], accounts = []
      for (let i = 0; i < 50; i++) { // backstop against a runaway loop
        const j = await plaid(env, '/transactions/sync', {
          ...base, access_token: body.access_token, cursor, count: 500,
          // first sync of an item: ask for Plaid's maximum history (2 years)
          ...(cursor ? {} : { options: { days_requested: 730 } }),
        })
        added.push(...j.added)
        modified.push(...j.modified)
        removed.push(...j.removed)
        if (j.accounts?.length) accounts = j.accounts
        cursor = j.next_cursor
        if (!j.has_more) break
      }
      return json(200, { added, modified, removed, next_cursor: cursor, accounts })
    }
    json(404, { error: 'unknown finance-api endpoint' })
  } catch (err) {
    json(err.plaid ? 400 : 500, err.plaid || { error: err.message })
  }
}
