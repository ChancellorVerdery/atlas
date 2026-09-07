// The profile service's board/flag storage, pull.all fan-in and import
// replace-semantics, executed - not read.
//
// WHY THIS FILE EXISTS. profile.js was one of the last two services with no
// behavioral test (gate.js is the other), and it is the one that owns whole-app
// backup restore: sync.import is a REPLACE, so a bug here deletes data on every
// device rather than corrupting one plugin. Nothing was watching it.
//
// Importing services/profile.js is possible as of Pass 12, which put
// `await applyDdl(DDL)` and serveHttp() behind an entrypoint guard. Before that,
// importing blocked ~2 minutes retrying DDL against no database and then called
// process.exit(1) - the same class of problem Pass 11 fixed for inbox/outbox.
//
// Run: node test/profile-sync.check.mjs
import { strictEqual, deepStrictEqual, ok } from 'node:assert'
import { pool } from '../lib/db.js'
import { handle } from '../services/profile.js'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'

// ---- model of profile.page_boards / profile.user_flags ----------------------
// Deliberately loud: any SQL this does not recognise is a hard throw, never a
// silent {rows:[]}. A future edit that reached these tables some other way would
// otherwise route around the model and leave every arm green (Pass 9/10/11's
// lesson, and NC4 below is the reminder that harness code can itself be wrong).
let boards, flags
const reset = () => { boards = new Map(); flags = new Map() }
const k = (u, s) => `${u}|${s}`
reset()

const runSql = async (q, params = []) => {
  const s = String(q).replace(/\s+/g, ' ').trim()
  if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') return { rows: [] }
  if (s.startsWith('SELECT board FROM profile.page_boards WHERE user_id = $1 AND storage_key'))
    return { rows: boards.has(k(params[0], params[1])) ? [{ board: boards.get(k(params[0], params[1])) }] : [] }
  if (s.startsWith('SELECT value FROM profile.user_flags WHERE user_id = $1 AND flag'))
    return { rows: flags.has(k(params[0], params[1])) ? [{ value: flags.get(k(params[0], params[1])) }] : [] }
  if (s.startsWith('SELECT storage_key, board FROM profile.page_boards WHERE user_id'))
    return { rows: [...boards].filter(([key]) => key.startsWith(params[0] + '|'))
      .map(([key, board]) => ({ storage_key: key.split('|')[1], board })) }
  if (s.startsWith('SELECT flag, value FROM profile.user_flags WHERE user_id'))
    return { rows: [...flags].filter(([key]) => key.startsWith(params[0] + '|'))
      .map(([key, value]) => ({ flag: key.split('|')[1], value })) }
  if (s.startsWith('INSERT INTO profile.page_boards')) {
    // jsonb: the service hands pg a string, Postgres hands back a parsed value.
    boards.set(k(params[0], params[1]), JSON.parse(params[2])); return { rows: [] }
  }
  if (s.startsWith('INSERT INTO profile.user_flags')) {
    flags.set(k(params[0], params[1]), params[2]); return { rows: [] }
  }
  // Both DELETEs are matched WITHOUT their WHERE clause on purpose. Modelling
  // them as 'DELETE ... WHERE user_id' made an unscoped delete land in the
  // unmodelled-SQL throw, which the cross-user arm below then read as "B's rows
  // survived" and went green over a table-wide wipe (see NC2). Matching the bare
  // statement and honouring the scope only when it is actually present is what
  // makes that arm about isolation rather than about the model.
  for (const [stmt, store] of [['profile.page_boards', () => boards], ['profile.user_flags', () => flags]]) {
    if (!s.startsWith('DELETE FROM ' + stmt)) continue
    const scoped = /WHERE user_id = \$1/.test(s)
    for (const key of [...store().keys()])
      if (!scoped || key.startsWith(params[0] + '|')) store().delete(key)
    return { rows: [] }
  }
  throw new Error('unmodelled SQL: ' + s)
}
pool.query = runSql
pool.connect = async () => ({ query: runSql, release() {} })

// ---- model of the plugin services and the outbox ---------------------------
// Both go out over fetch(): postSvc() to http://<compose-service>/state*, and
// runner.js deliver() to $OUTBOX_URL. Nothing here touches a real socket.
let plugin, calls, sent, down
const resetSvc = () => { plugin = new Map(); calls = []; sent = []; down = new Set() }
resetSvc()
const res = body => ({ ok: true, status: 200, json: async () => body })
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  if (url.includes('/deliver')) { sent.push(body); return res({}) }
  const [, svc, ...rest] = url.match(/^http:\/\/([^/]+)(\/.*)$/) ? [0, ...url.slice(7).split(/(?=\/)/)] : []
  const host = url.slice(7).split('/')[0]
  const path = '/' + url.slice(7).split('/').slice(1).join('/')
  calls.push({ host, path, userId: body.userId })
  if (down.has(host)) throw new Error('connect ECONNREFUSED')
  if (path === '/state') return res({ value: plugin.get(host + '|' + body.userId) ?? null })
  if (path === '/state/save') { plugin.set(host + '|' + body.userId, body.value); return res({}) }
  if (path === '/state/clear') { plugin.delete(host + '|' + body.userId); return res({}) }
  throw new Error('unmodelled service call: ' + url)
}

// One request through the real /handle. Returns the deliveries it produced.
const req = async (code, payload, { userId = A, sessionId = 's1' } = {}) => {
  sent = []
  await handle({ userId, sessionId, reqId: 'r-' + code, code, payload })
  return sent
}
const result = ds => ds.find(d => d.reqId)
const update = ds => ds.find(d => d.type === 'sync.update')

// ---- arms -------------------------------------------------------------------

await check('a board key round-trips as a jsonb document', async () => {
  reset()
  const board = { widgets: [{ id: 'w1', x: 0 }], v: 1 }
  const saved = await req('page.save', { storageKey: 'atlas.page.gym.v1', value: board })
  strictEqual(result(saved).ok, true)
  const got = await req('page.get', { storageKey: 'atlas.page.gym.v1' })
  deepStrictEqual(result(got).data, { key: 'atlas.page.gym.v1', value: board })
})

await check('an unset key reads back null rather than erroring', async () => {
  reset()
  const got = await req('page.get', { storageKey: 'atlas.page.work.v1' })
  strictEqual(result(got).ok, true)
  strictEqual(result(got).data.value, null)
})

await check('a flag is stored as an opaque string', async () => {
  reset()
  await req('page.save', { storageKey: 'atlas.theme', value: 'dark' })
  strictEqual(flags.get(k(A, 'atlas.theme')), 'dark')
  strictEqual(result(await req('page.get', { storageKey: 'atlas.theme' })).data.value, 'dark')
})

// The guard in pageSave(). String({}) is '[object Object]', which would be
// persisted, pulled by every other device, and destroy the value everywhere.
await check('a structured flag value is JSON, never [object Object]', async () => {
  reset()
  await req('page.save', { storageKey: 'atlas.tabs', value: { order: ['gym', 'work'] } })
  const stored = flags.get(k(A, 'atlas.tabs'))
  ok(!String(stored).includes('[object Object]'), `flag persisted as ${stored}`)
  deepStrictEqual(JSON.parse(stored), { order: ['gym', 'work'] })
})

// sync.update must carry what a *pull* would return, not what the client sent:
// the two differ exactly in the case above, and a device believing the object
// form would write it straight back.
await check('sync.update fans out the stored value, not the submitted one', async () => {
  reset()
  const ds = await req('page.save', { storageKey: 'atlas.tabs', value: { order: ['gym'] } })
  strictEqual(update(ds).data.value, flags.get(k(A, 'atlas.tabs')))
  strictEqual(update(ds).excludeSession, 's1')
  strictEqual(update(ds).userId, A)
})

await check('a non-object board is refused and fans nothing out', async () => {
  reset()
  const ds = await req('page.save', { storageKey: 'atlas.page.v1', value: 'nope' })
  strictEqual(result(ds).ok, false)
  strictEqual(update(ds), undefined)
  strictEqual(boards.size, 0)
})

await check('a non-atlas key is refused', async () => {
  reset()
  const ds = await req('page.save', { storageKey: 'evil.key', value: 'x' })
  strictEqual(result(ds).ok, false)
  ok(/refusing to store/.test(result(ds).error), result(ds).error)
  strictEqual(flags.size, 0)
})

await check('pull.all returns boards, flags and every plugin state in one map', async () => {
  reset(); resetSvc()
  boards.set(k(A, 'atlas.page.v1'), { widgets: [] })
  flags.set(k(A, 'atlas.theme'), 'dark')
  plugin.set('atlas-gym|' + A, { workouts: [1] })
  const { data } = result(await req('sync.pull.all', {}))
  deepStrictEqual(data.warnings, [])
  deepStrictEqual(data.states['atlas.page.v1'], { widgets: [] })
  strictEqual(data.states['atlas.theme'], 'dark')
  deepStrictEqual(data.states['atlas.gym.v1'], { workouts: [1] })
  strictEqual(data.states['atlas.work.v1'], null)   // plugin reachable, nothing stored
})

await check('an unreachable plugin becomes null + a warning, never a failed pull', async () => {
  reset(); resetSvc()
  down.add('atlas-finance')
  plugin.set('atlas-gym|' + A, { workouts: [] })
  const r = result(await req('sync.pull.all', {}))
  strictEqual(r.ok, true)
  strictEqual(r.data.states['atlas.finance.v1'], null)
  strictEqual(r.data.warnings.length, 1)
  ok(r.data.warnings[0].startsWith('atlas.finance.v1:'), r.data.warnings[0])
  deepStrictEqual(r.data.states['atlas.gym.v1'], { workouts: [] })
})

// The whole point of import: it is a restore, not a merge.
await check('import clears plugins absent from the backup', async () => {
  reset(); resetSvc()
  plugin.set('atlas-gym|' + A, { workouts: [1] })
  plugin.set('atlas-sleep|' + A, { nights: [1] })
  const r = result(await req('sync.import', { data: { 'atlas.gym.v1': '{"workouts":[2]}' } }))
  strictEqual(r.ok, true)
  deepStrictEqual(plugin.get('atlas-gym|' + A), { workouts: [2] })
  strictEqual(plugin.has('atlas-sleep|' + A), false)
})

await check('import clears boards and flags absent from the backup', async () => {
  reset(); resetSvc()
  boards.set(k(A, 'atlas.page.v1'), { old: true })
  flags.set(k(A, 'atlas.theme'), 'dark')
  await req('sync.import', { data: { 'atlas.page.gym.v1': { widgets: [] }, 'atlas.tabOrder': 'a,b' } })
  strictEqual(boards.has(k(A, 'atlas.page.v1')), false)
  strictEqual(flags.has(k(A, 'atlas.theme')), false)
  deepStrictEqual(boards.get(k(A, 'atlas.page.gym.v1')), { widgets: [] })
  strictEqual(flags.get(k(A, 'atlas.tabOrder')), 'a,b')
})

// A present-but-corrupt key must still clear the stale server state, or a
// restore would silently leave the *previous* account's plugin data in place.
await check('a present but unparseable plugin key clears rather than keeps', async () => {
  reset(); resetSvc()
  plugin.set('atlas-gym|' + A, { workouts: [1] })
  const r = result(await req('sync.import', { data: { 'atlas.gym.v1': '{not json' } }))
  strictEqual(plugin.has('atlas-gym|' + A), false)
  ok(r.data.warnings.some(w => w.includes('unparseable')), JSON.stringify(r.data.warnings))
})

// NEVER_STORE mirrors the client's NEVER_PUSH/SKIP_KEYS. A foreign or tampered
// backup must not be able to smuggle a session token or a backend URL into the
// server and have pull.all fan it out to every device on the account.
await check('a backup cannot smuggle credentials or the backend URL into storage', async () => {
  reset(); resetSvc()
  await req('sync.import', { data: {
    'atlas.auth.v1': '{"token":"stolen"}',
    'atlas.backend': 'https://attacker.example',
    'atlas.devMode': 'true',
    'atlas.theme': 'dark',
  } })
  strictEqual(flags.has(k(A, 'atlas.auth.v1')), false)
  strictEqual(flags.has(k(A, 'atlas.backend')), false)
  strictEqual(flags.has(k(A, 'atlas.devMode')), false)
  strictEqual(flags.get(k(A, 'atlas.theme')), 'dark')   // the rest still restores
})

await check('import ignores non-atlas keys entirely', async () => {
  reset(); resetSvc()
  await req('sync.import', { data: { 'random.key': 'x', 'atlas.theme': 'light' } })
  strictEqual(flags.has(k(A, 'random.key')), false)
  strictEqual(flags.size, 1)
})

// The worst thing this service could get wrong: every write is user-scoped.
await check('one user\'s import never touches another user\'s rows', async () => {
  reset(); resetSvc()
  boards.set(k(B, 'atlas.page.v1'), { mine: true })
  flags.set(k(B, 'atlas.theme'), 'dark')
  plugin.set('atlas-gym|' + B, { workouts: [9] })
  await req('sync.import', { data: { 'atlas.theme': 'light' } }, { userId: A })
  deepStrictEqual(boards.get(k(B, 'atlas.page.v1')), { mine: true })
  strictEqual(flags.get(k(B, 'atlas.theme')), 'dark')
  deepStrictEqual(plugin.get('atlas-gym|' + B), { workouts: [9] })
  ok(calls.every(c => c.userId === A), 'a plugin call ran against the wrong user')
})

await check('a non-object import payload is refused', async () => {
  reset(); resetSvc()
  const r = result(await req('sync.import', { data: 'nope' }))
  strictEqual(r.ok, false)
  ok(/data must be an object/.test(r.error), r.error)
})

await check('an unknown code fails the request instead of hanging it', async () => {
  reset()
  const r = result(await req('profile.nope', {}))
  strictEqual(r.ok, false)
  strictEqual(r.error, 'unhandled code')
  strictEqual(r.reqId, 'r-profile.nope')
})

console.log(failures ? `profile-sync.check: ${failures} FAILED` : 'profile-sync.check: all good')
process.exit(failures ? 1 : 0)
