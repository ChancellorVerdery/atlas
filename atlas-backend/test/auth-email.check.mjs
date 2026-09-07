// Does auth actually behave correctly around email case? — BEHAVIORAL.
//
// The bug (Pass 8): login() has always matched `lower(email)`; signup() stored
// the address exactly as typed, under `email text UNIQUE`. UNIQUE compares raw
// text, so 'A@x.com' and 'a@x.com' were two accounts — and then one login query
// matched BOTH, returning them in unordered physical row order. bcrypt checked
// the password against whichever row came back first, so the other user's
// correct password intermittently answered 'Invalid email or password', and
// which one was locked out could change after any UPDATE or VACUUM.
//
// This file used to READ auth.js's source, because auth.js ran `applyDdl()` at
// module top level and so could not be imported without a Postgres — and there
// is none on a dev box here (`pg_isready` fails; standing since Pass 2). Pass 9
// put that bootstrap behind an `import.meta.url === argv[1]` guard, so signup(),
// login(), logout(), whoami() and handle() are now exported and importable with
// no I/O at all (lib/db.js's pg.Pool is lazy and connects on first query).
// These arms therefore EXECUTE the real functions.
//
// Run: node test/auth-email.check.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { strictEqual, ok, deepStrictEqual } from 'node:assert'
import bcrypt from 'bcryptjs'
import { normalizeEmail } from '../lib/email.js'
import { pool } from '../lib/db.js'
import { signup, login, logout, whoami, handle } from '../services/auth.js'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log('ok', name) }
  catch (e) { failures++; console.error('FAIL', name, '-', e.message) }
}

// ---------------------------------------------------------------------------
// A model of the two tables auth owns. `pool` is the singleton exported by
// lib/db.js and auth.js holds that same object, so replacing .query here
// replaces it for the code under test.
//
// TWO MODELLING DECISIONS ARE LOAD-BEARING. Both encode a real Postgres
// behaviour that the bug depends on; get either wrong and these arms pass
// vacuously:
//
//  1. UNIQUE(email) compares RAW TEXT. The insert raises 23505 only on an
//     exact-text collision — never on a case variant. That is precisely why
//     signup() needs its own lower(email) pre-check and why the constraint
//     alone was not enough.
//  2. A SELECT with NO `ORDER BY` returns matching rows in REVERSE insertion
//     order. Postgres guarantees no order at all there; reverse is the cheapest
//     faithful stand-in for "row order moved under you after an UPDATE or
//     VACUUM". With `ORDER BY created_at, id` the model sorts, like the real
//     planner would.
//
// Any SQL the model does not recognise is a hard throw, not a silent {rows:[]}
// — otherwise a future edit to auth.js could route around the model entirely
// and every arm below would still print ok.
// ---------------------------------------------------------------------------
const db = { users: [], sessions: [] }
let seq = 0
const addUser = (email, password) => {
  const u = { id: `u${++seq}`, email, password_hash: bcrypt.hashSync(password, 4), created_at: seq }
  db.users.push(u)
  return u
}
const reset = () => { db.users = []; db.sessions = []; seq = 0 }

pool.query = async (sql, params = []) => {
  const s = String(sql).replace(/\s+/g, ' ').trim()

  if (s.startsWith('DELETE FROM auth.sessions WHERE expires_at < now()')) {
    db.sessions = db.sessions.filter(x => !x.expired)
    return { rows: [], rowCount: 0 }
  }
  if (s.startsWith('DELETE FROM auth.sessions WHERE token =')) {
    db.sessions = db.sessions.filter(x => x.token !== params[0])
    return { rows: [], rowCount: 0 }
  }
  if (s.startsWith('SELECT 1 FROM auth.users WHERE lower(email) =')) {
    // The SQL is `lower(email) = $1`: only the COLUMN is folded, never the
    // parameter. Lowercasing params[0] here too would quietly do signup()'s
    // normalization for it and make the pre-check look correct against a
    // raw-cased caller. (Caught by negative control NC2, which failed one arm
    // where it should have failed two.)
    const hit = db.users.filter(u => u.email.toLowerCase() === String(params[0]))
    return { rows: hit.slice(0, 1).map(() => ({ '?column?': 1 })) }
  }
  if (s.startsWith('INSERT INTO auth.users')) {
    const [email, hash] = params
    // (1) raw-text UNIQUE: a case variant is NOT a collision.
    if (db.users.some(u => u.email === email)) {
      const e = new Error('duplicate key value violates unique constraint "users_email_key"')
      e.code = '23505'
      throw e
    }
    const u = { id: `u${++seq}`, email, password_hash: hash, created_at: seq }
    db.users.push(u)
    return { rows: [{ id: u.id, email: u.email }] }
  }
  if (s.startsWith('SELECT id, email, password_hash FROM auth.users')) {
    let hit = db.users.filter(u => u.email.toLowerCase() === String(params[0]))
    // (2) unordered SELECT -> physical order, modelled as reversed.
    if (/ORDER BY created_at, id/.test(s)) hit = hit.slice().sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
    else hit = hit.slice().reverse()
    return { rows: hit.map(u => ({ id: u.id, email: u.email, password_hash: u.password_hash })) }
  }
  if (s.startsWith('INSERT INTO auth.sessions')) {
    db.sessions.push({ token: params[0], user_id: params[1] })
    return { rows: [], rowCount: 1 }
  }
  if (s.startsWith('SELECT u.id, u.email FROM auth.sessions s')) {
    const sess = db.sessions.find(x => x.token === params[0])
    if (!sess) return { rows: [] }
    const u = db.users.find(x => x.id === sess.user_id)
    return { rows: u ? [{ id: u.id, email: u.email }] : [] }
  }
  throw new Error(`the auth pool model does not recognise this query: ${s.slice(0, 90)}`)
}

// ---- the helper itself -------------------------------------------------------
await check('normalizeEmail folds case and trims', () => {
  strictEqual(normalizeEmail('  alex@example.com '), 'alex@example.com')
  strictEqual(normalizeEmail('a@x.com'), 'a@x.com')
})
await check('normalizeEmail is total — no throw on non-strings', () => {
  // payload comes off the wire; null/undefined/number must not crash the
  // service before the 'Enter a valid email address' reply is produced.
  for (const v of [null, undefined, 0, {}, []]) strictEqual(typeof normalizeEmail(v), 'string')
  strictEqual(normalizeEmail(null), '')
})

// ---- signup stores a folded address ------------------------------------------
await check('signup stores the folded address, not the typed casing', async () => {
  reset()
  const r = await signup({ email: '  alex@example.com ', password: 'correct-horse' })
  ok(r.ok, `signup failed: ${r.error}`)
  strictEqual(db.users.length, 1)
  strictEqual(db.users[0].email, 'alex@example.com',
    'signup stored a raw-cased address; UNIQUE(email) is raw text, so this is how one address becomes two accounts')
  strictEqual(r.data.email, 'alex@example.com')
})

// ---- the duplicate pair cannot be created ------------------------------------
await check('a case-variant signup is rejected, not accepted as a second account', async () => {
  reset()
  ok((await signup({ email: 'a@x.com', password: 'password-one' })).ok)
  const dup = await signup({ email: 'A@X.com', password: 'password-two' })
  strictEqual(dup.ok, false)
  strictEqual(dup.error, 'That email is already registered')
  strictEqual(db.users.length, 1, 'a case variant created a SECOND account — UNIQUE(email) cannot see it')
})

await check('signup rejects a legacy mixed-case row it did not write', async () => {
  // The pre-check exists for exactly this: a row stored before normalization.
  // UNIQUE(email) compares raw text and would let this through.
  reset()
  addUser('Legacy@X.com', 'password-one')
  const dup = await signup({ email: 'legacy@x.com', password: 'password-two' })
  strictEqual(dup.ok, false)
  strictEqual(db.users.length, 1, 'a legacy mixed-case row still admits a duplicate')
})

// ---- login ---------------------------------------------------------------
await check('login accepts any casing of the address', async () => {
  reset()
  ok((await signup({ email: 'a@x.com', password: 'password-one' })).ok)
  const r = await login({ email: '  A@X.COM ', password: 'password-one' })
  ok(r.ok, `login failed: ${r.error}`)
  strictEqual(r.data.email, 'a@x.com')
})

await check('login is deterministic against a PRE-EXISTING duplicate pair', async () => {
  // This is the arm the ORDER BY exists for. Both rows predate normalization,
  // so signup()'s pre-check never saw them; only the lookup's order decides
  // which one a login resolves to. The model returns an unordered SELECT
  // reversed, so without ORDER BY this picks the NEWER row and the older
  // account's correct password is rejected.
  reset()
  addUser('A@x.com', 'password-oldest')
  addUser('a@x.com', 'password-newest')
  const r = await login({ email: 'a@x.com', password: 'password-oldest' })
  ok(r.ok, 'the oldest duplicate account could not sign in with its own correct password — the lookup is picking a row by physical order')
  strictEqual(r.data.id ?? r.data.userId, 'u1', 'the lookup did not resolve to the oldest account')
  // ...and it must be stable, not a coin flip: same answer every time.
  for (let i = 0; i < 3; i++) {
    const again = await login({ email: 'A@X.COM', password: 'password-oldest' })
    ok(again.ok && again.data.userId === 'u1', 'the duplicate pair resolves differently between two identical logins')
  }
})

await check('a wrong password is rejected without leaking which half failed', async () => {
  reset()
  ok((await signup({ email: 'a@x.com', password: 'password-one' })).ok)
  const bad = await login({ email: 'a@x.com', password: 'password-two' })
  deepStrictEqual(bad, { ok: false, error: 'Invalid email or password' })
  const missing = await login({ email: 'nobody@x.com', password: 'password-one' })
  deepStrictEqual(missing, { ok: false, error: 'Invalid email or password' },
    'an unknown address answers differently from a wrong password — that is an account-enumeration oracle')
})

// ---- input validation --------------------------------------------------------
await check('signup validates before it touches the database', async () => {
  reset()
  strictEqual((await signup({ email: 'not-an-email', password: 'password-one' })).error, 'Enter a valid email address')
  strictEqual((await signup({ email: 'a@x.com', password: 'short' })).error, 'Password must be at least 8 characters')
  strictEqual((await signup({})).error, 'Enter a valid email address')
  strictEqual((await signup(null)).error, 'Enter a valid email address')
  strictEqual(db.users.length, 0, 'a rejected signup still wrote a row')
})

// ---- session lifecycle -------------------------------------------------------
await check('the session minted by signup identifies that user, and logout revokes it', async () => {
  reset()
  const s = await signup({ email: 'a@x.com', password: 'password-one' })
  ok(s.ok)
  const me = await whoami(s.data.token)
  ok(me.ok, `whoami rejected a freshly minted token: ${me.error}`)
  strictEqual(me.data.email, 'a@x.com')
  strictEqual(me.data.userId, s.data.userId)
  ok(!(await whoami('')).ok)
  ok(!(await whoami('not-a-token')).ok)
  ok((await logout(s.data.token)).ok)
  strictEqual((await whoami(s.data.token)).ok, false, 'a logged-out token still resolves')
})

// ---- dispatch ------------------------------------------------------------
await check('handle() routes each code and never throws out of the service', async () => {
  reset()
  const r = await handle({ reqId: 'r1', code: 'auth.signup', payload: { email: 'A@x.com', password: 'password-one' } })
  strictEqual(r.reqId, 'r1')
  ok(r.ok, `signup via handle failed: ${r.error}`)
  const li = await handle({ reqId: 'r2', code: 'auth.login', payload: { email: 'a@x.com', password: 'password-one' } })
  ok(li.ok && li.reqId === 'r2')
  ok((await handle({ reqId: 'r3', code: 'auth.whoami', token: li.data.token })).ok)
  ok((await handle({ reqId: 'r4', code: 'auth.logout', token: li.data.token })).ok)
  deepStrictEqual(await handle({ reqId: 'r5', code: 'auth.nope' }), { reqId: 'r5', ok: false, error: 'unhandled code' })
})

await check('a database failure becomes an error reply, not a crash', async () => {
  // serveHttp turns a throw into a 500 with a stack; handle() is supposed to
  // catch first so the client gets a reply carrying its reqId.
  reset()
  const real = pool.query
  pool.query = async () => { throw new Error('connection terminated unexpectedly') }
  const err = console.error; console.error = () => {}
  try {
    const r = await handle({ reqId: 'r9', code: 'auth.login', payload: { email: 'a@x.com', password: 'password-one' } })
    strictEqual(r.reqId, 'r9')
    strictEqual(r.ok, false)
    ok(/connection terminated/.test(r.error))
  } finally { pool.query = real; console.error = err }
})

// ---- the client half ---------------------------------------------------------
await check('the sign-in form does not fold case itself', () => {
  // Documenting the division of labour, not asserting a bug: main.js only
  // trims. If it ever starts lowercasing, the server must STILL fold, because
  // an old bundle on a device is the exact case this bug came in through.
  const ui = readFileSync(fileURLToPath(new URL('../../atlas-ui/src/main.js', import.meta.url)), 'utf8')
  ok(/form\.email\.value\.trim\(\)/.test(ui), 'main.js no longer reads the email field the way this check assumed')
})

console.log(failures ? `\nauth-email.check: ${failures} FAILED` : '\nauth-email.check: all good')
process.exit(failures ? 1 : 0)
