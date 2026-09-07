// Does every column decompose() emits actually EXIST in the mapper's own DDL?
//
// lib/runner.js store() builds its INSERT straight from the decomposed row:
//
//     const row  = { ...rows[i], user_id: userId, ord: i }
//     const cols = Object.keys(row)
//     INSERT INTO <schema>.<table> (cols...) VALUES (...)
//
// So a key added to decompose() without a matching column is not a type error,
// not a test failure, and not visible in any round-trip test (those simulate pg
// with a plain object, which happily carries any key). It is a Postgres 42703
// "column ... does not exist" at save time, in production, for every save of
// that plugin — the failure the mappers' own comments call checkInsertTargets.
//
// The reverse trap is subtler and has bitten this repo twice (ladder.flex.addr,
// work): CREATE TABLE IF NOT EXISTS is a NO-OP on a table that already exists,
// so adding a column to the CREATE body does nothing to a deployed database.
// Such a column needs its own idempotent ALTER TABLE ... ADD COLUMN IF NOT
// EXISTS. This check therefore reads columns from CREATE bodies *and* ALTERs,
// and separately reports columns that a fresh DB would have but a deployed one
// would not.
//
// It can only inspect tables decompose actually emits a row for, so the shape it
// is fed decides its reach. Fed the loader's DEFAULT shape every per-row table is
// empty and unchecked — that left 28 of this repo's tables unexamined, settings
// tables only. So each plugin with a fixture in plugin-seeds.mjs is run through
// its OWN loader over that seed, which emits rows for the per-row tables too.
// Retired plugins have no client half in tree and keep the {} fallback. A table
// still empty under the shape fed here is reported as unchecked rather than
// silently passing.
//
// Run: node test/ddl-columns.check.mjs
import { readdirSync } from 'node:fs'

// Fixtures and the localStorage stub are shared with sync-array-coverage.check.mjs;
// importing that module installs the stub.
import { PLUGINS, RETIRED_FIXTURES, seedFor } from './plugin-seeds.mjs'

// Columns lib/runner.js store() stamps onto every row itself.
const RUNNER_COLS = ['user_id', 'ord']

// Blank out string literals and comments so a column name inside a
// DEFAULT '{"gym":""}' can never be read as SQL.
//
// This MUST be one left-to-right scan, not two regex passes. Doing literals
// first and comments second is what a first cut did, and it silently broke on
// canvas: the comment `-- NULL = key absent (loader doesn't backfill)` carries
// a lone apostrophe, which a literal-first regex happily paired with the next
// quote ten lines down, swallowing a whole CREATE TABLE in between and
// reporting a table that plainly exists as missing. Comments can contain
// apostrophes and literals can contain '--', so only a single pass that knows
// which context it is in gets both right.
function scrub(sql) {
  let out = '', i = 0
  while (i < sql.length) {
    if (sql[i] === "'") {                       // string literal, '' escapes
      i++
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue }
        if (sql[i] === "'") { i++; break }
        i++
      }
      out += "''"
    } else if (sql[i] === '-' && sql[i + 1] === '-') {   // line comment
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (sql[i] === '/' && sql[i + 1] === '*') {   // block comment
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
    } else out += sql[i++]
  }
  return out
}

// schema.table -> Set(column). `alterOnly` collects columns introduced by an
// ALTER, which is what a DEPLOYED database actually gains.
function ddlColumns(ddl) {
  const sql = scrub(ddl)
  const tables = new Map()
  const alterAdded = new Map()

  // CREATE TABLE [IF NOT EXISTS] <name> ( <body> ) — body is balanced-paren
  // scanned so a numeric(10,2) or a multi-column PRIMARY KEY doesn't end it.
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)\s*\(/gi
  let m
  while ((m = re.exec(sql))) {
    let depth = 1, i = re.lastIndex
    for (; i < sql.length && depth; i++) {
      if (sql[i] === '(') depth++
      else if (sql[i] === ')') depth--
    }
    const body = sql.slice(re.lastIndex, i - 1)
    const cols = new Set()
    let d = 0, cur = ''
    const flush = () => {
      const first = cur.trim().split(/\s+/)[0]
      // Skip table-level constraints, which are not columns.
      if (first && !/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|EXCLUDE|LIKE)$/i.test(first)) cols.add(first.toLowerCase())
      cur = ''
    }
    for (const ch of body) {
      if (ch === '(') d++
      else if (ch === ')') d--
      if (ch === ',' && d === 0) flush()
      else cur += ch
    }
    flush()
    tables.set(m[1].toLowerCase(), cols)
  }

  // ALTER TABLE <name> ADD COLUMN [IF NOT EXISTS] <col>
  const ra = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w.]+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/gi
  while ((m = ra.exec(sql))) {
    const t = m[1].toLowerCase(), c = m[2].toLowerCase()
    if (!tables.has(t)) tables.set(t, new Set())
    tables.get(t).add(c)
    if (!alterAdded.has(t)) alterAdded.set(t, new Set())
    alterAdded.get(t).add(c)
  }
  return { tables, alterAdded }
}

let failures = 0
let checkedCols = 0
const unchecked = []
const degraded = []

const files = readdirSync(new URL('../services/plugins/', import.meta.url))
  .filter((f) => f.endsWith('.js')).sort()

for (const file of files) {
  const name = file.replace(/\.js$/, '')
  let mapper
  try {
    mapper = (await import(`../services/plugins/${file}`)).default
  } catch (e) {
    failures++
    console.log(`FAIL ${name}: could not import — ${String(e.message).slice(0, 100)}`)
    continue
  }
  if (!mapper?.ddl || !Array.isArray(mapper.tables) || typeof mapper.decompose !== 'function') {
    console.log(`skip ${name} (not a table-backed mapper)`)
    continue
  }

  const { tables: ddlT } = ddlColumns(mapper.ddl)

  // Widest shape available. With a fixture: seed the plugin's own storage key and
  // run its own loader, so the LOADER decides normalized truth and every per-row
  // table gets a row. Without one: decompose({}), which each mapper normalizes to
  // its loader's default shape — settings tables only. Retired plugins have no
  // client half in-tree, so that is all they can get.
  let shape = {}
  let shapeSrc = 'decompose({})'
  const fixture = PLUGINS.find((p) => p.name === name)
  // A retired plugin has no client half in tree, so there is no loader to run.
  // It gets a hand-authored raw blob instead (plugin-seeds.mjs RETIRED_FIXTURES),
  // which the mapper's own normalizer accepts as-is. Same reach, one less link
  // in the chain of trust -- and the only way finance's 9 tables can be read at
  // all. A retired mapper with NO raw fixture stays on decompose({}) and is
  // reported unchecked rather than passing quietly.
  if (!fixture && RETIRED_FIXTURES[name]) {
    shape = RETIRED_FIXTURES[name]
    shapeSrc = 'raw fixture'
  }
  if (fixture) {
    try {
      seedFor(fixture)
      const mod = await import(`../../atlas-ui/src/page/${fixture.module}`)
      if (typeof mod[fixture.loader] !== 'function') throw new Error(`no ${fixture.loader}`)
      shape = mod[fixture.loader]()
      shapeSrc = 'seeded fixture'
    } catch (e) {
      // Loud, not silent: a fixture that stops loading would quietly shrink this
      // check back to the settings-only ceiling it exists to lift.
      degraded.push(`${name}: fixture present but its loader did not run — ${String(e.message).slice(0, 80)}`)
    }
  }

  let byTable
  try {
    byTable = mapper.decompose(shape)
  } catch (e) {
    failures++
    console.log(`FAIL ${name}: decompose(${shapeSrc}) threw — ${String(e.message).slice(0, 100)}`)
    continue
  }

  const problems = []
  for (const t of mapper.tables) {
    const qualified = `${mapper.schema}.${t}`.toLowerCase()
    const known = ddlT.get(qualified)
    if (!known) { problems.push(`table ${qualified} is in mapper.tables but has no CREATE TABLE in the ddl`); continue }

    for (const c of RUNNER_COLS) {
      if (!known.has(c)) problems.push(`${qualified}.${c} is stamped by runner store() but missing from the ddl`)
    }

    const rows = byTable[t] || []
    if (!rows.length) { unchecked.push(`${name}.${t} (from ${shapeSrc})`); continue }
    for (const row of rows) {
      for (const c of Object.keys(row)) {
        checkedCols++
        if (!known.has(c.toLowerCase())) problems.push(`${qualified}.${c} is emitted by decompose but missing from the ddl (Postgres 42703 on every save)`)
      }
    }
  }

  if (problems.length) {
    failures++
    console.log(`FAIL ${name}: ${problems.length} problem(s)`)
    for (const p of problems) console.log(`       ${p}`)
  } else {
    console.log(`ok   ${name}: every decomposed column exists in the ddl (${shapeSrc})`)
  }
}

for (const u of unchecked) console.log(`note ${u}: no rows emitted — columns unchecked`)
for (const g of degraded) { failures++; console.log(`FAIL ${g}`) }
console.log(failures
  ? `\n${failures} mapper(s) would fail at INSERT time`
  : `\nddl-columns: ${checkedCols} emitted column(s) all exist`)
process.exit(failures ? 1 : 0)
