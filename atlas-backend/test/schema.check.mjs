// Every plugin owns a Postgres schema named after it, so a table's identity is
// <schema>.<table> (gym.workouts, finance.networth_history). That convention
// lives in three places at once — the DDL, the mapper's `tables` list, and the
// runner's qualify() — and nothing at runtime notices when they drift: a table
// listed but never created fails only on first save, in production.
//
// This check pins them together. It is static (no database required), which is
// also its ceiling: it proves the names agree, not that the SQL executes.
// Run: node test/schema.check.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const fails = []
const eq = (a, b, msg) => { if (a !== b) fails.push(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`) }
const ok = (cond, msg) => { if (!cond) fails.push(msg) }

// ---- plugin mappers ---------------------------------------------------------
const pluginDir = join(ROOT, 'services/plugins')
for (const file of readdirSync(pluginDir).filter((f) => f.endsWith('.js'))) {
  const mapper = (await import(join(pluginDir, file))).default
  const where = `plugins/${file}`

  ok(typeof mapper.schema === 'string' && mapper.schema, `${where}: mapper has no schema`)
  if (!mapper.schema) continue
  eq(mapper.schema, mapper.name, `${where}: schema must match the mapper name`)
  ok(mapper.ddl.includes(`CREATE SCHEMA IF NOT EXISTS ${mapper.schema};`),
    `${where}: ddl never creates schema "${mapper.schema}"`)

  // Tables the DDL actually creates, and the schema each lands in.
  const created = [...mapper.ddl.matchAll(/CREATE TABLE IF NOT EXISTS ([\w.]+)\s*\(/g)].map((m) => m[1])
  for (const t of created) {
    ok(t.includes('.'), `${where}: table ${t} is not schema-qualified`)
    eq(t.split('.')[0], mapper.schema, `${where}: table ${t} is in the wrong schema`)
  }
  eq([...created].map((t) => t.split('.')[1]).sort().join(','),
    [...mapper.tables].sort().join(','),
    `${where}: ddl tables and mapper.tables disagree`)

  // Foreign keys and index targets must be qualified too — an unqualified one
  // silently resolves through search_path to whatever happens to be there.
  for (const m of mapper.ddl.matchAll(/REFERENCES ([\w.]+)\s*\(/g))
    ok(m[1].includes('.'), `${where}: unqualified FK target "${m[1]}"`)
  for (const m of mapper.ddl.matchAll(/CREATE (?:UNIQUE )?INDEX[^\n]*? ON ([\w.]+)/g))
    ok(m[1].includes('.'), `${where}: unqualified index target "${m[1]}"`)

  // decompose() must emit exactly the tables the runner will write, or rows
  // are silently dropped (missing key) / crash on insert (unknown key).
  let keys
  try { keys = Object.keys(mapper.decompose({})) } catch { keys = null }
  if (keys) {
    eq(keys.sort().join(','), [...mapper.tables].sort().join(','),
      `${where}: decompose({}) keys do not match mapper.tables`)
  }
}

// ---- no legacy unqualified names survive anywhere ---------------------------
const LEGACY = ['users', 'sessions', 'page_boards', 'user_flags', 'google_tokens']
const svcDir = join(ROOT, 'services')
const files = [
  ...readdirSync(svcDir).filter((f) => f.endsWith('.js')).map((f) => join(svcDir, f)),
  ...readdirSync(pluginDir).filter((f) => f.endsWith('.js')).map((f) => join(pluginDir, f)),
]
for (const path of files) {
  const src = readFileSync(path, 'utf8')
  for (const t of LEGACY) {
    const re = new RegExp(`\\b(FROM|INTO|JOIN|UPDATE|REFERENCES|ALTER TABLE|CREATE TABLE IF NOT EXISTS) ${t}\\b`, 'g')
    for (const m of src.matchAll(re))
      fails.push(`${path.replace(ROOT + '/', '')}: unqualified legacy table in "${m[0]}"`)
  }
}

// ---- the runner qualifies -----------------------------------------------------
const runner = readFileSync(join(ROOT, 'lib/runner.js'), 'utf8')
ok(/const qualify = \(mapper, t\) =>/.test(runner), 'runner.js: qualify() helper is gone')
for (const m of runner.matchAll(/(SELECT \* FROM|DELETE FROM|INSERT INTO) \$\{([^}]+)\}/g))
  ok(m[2].startsWith('qualify('), `runner.js: "${m[0]}" bypasses qualify()`)

if (fails.length) {
  console.error(fails.map((f) => 'FAIL ' + f).join('\n'))
  process.exit(1)
}
console.log('schema check: all plugin tables schema-qualified and consistent')
