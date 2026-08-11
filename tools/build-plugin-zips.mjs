#!/usr/bin/env node
// Builds one distributable .zip per Atlas plugin into plugins-dist/.
// Each zip = plugin.json (manifest, format 1) + the plugin's source modules.
// Today the app ships every plugin's code in its own bundle, so these zips
// register/enable rather than add code; when the plugin API lands, API-era
// zips add an `entry` module and install through the same drop zone.
//
// Usage: node tools/build-plugin-zips.mjs   (from the repo root or anywhere)

import { execSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PLUGIN_DEFS } from '../atlas-ui/src/page/plugins.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'atlas-ui', 'src', 'page')
const OUT = join(ROOT, 'plugins-dist')
const VERSION = '1.0.0'

// Source modules per plugin. Equations has no modules of its own — its widget
// kinds live in the core board renderer — so its zip is manifest-only.
const FILES = {
  calendar: ['calendar.js', 'calendarui.js'],
  canvas: ['canvas.js', 'canvasui.js'],
  course: ['course.js', 'courseui.js'],
  email: ['email.js', 'emailui.js'],
  equations: [],
  finance: ['finance.js', 'financeui.js'],
  formal: ['formal.js', 'formalui.js'],
  graph: ['graph.js', 'graphui.js'],
  gym: ['gym.js', 'gymui.js'],
  ladder: ['ladder.js', 'ladderui.js'],
  notes: ['notes.js', 'notesui.js'],
  sleep: ['sleep.js', 'sleepui.js'],
  study: ['study.js', 'studyui.js'],
  work: ['work.js', 'workui.js'],
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

for (const def of PLUGIN_DEFS) {
  const files = FILES[def.id]
  if (files === undefined) { console.error(`no file list for plugin "${def.id}"`); process.exit(1) }
  const stage = join(OUT, `.stage-${def.id}`)
  mkdirSync(join(stage, 'src'), { recursive: true })
  writeFileSync(join(stage, 'plugin.json'), JSON.stringify({
    format: 1,
    id: def.id,
    name: def.name,
    version: VERSION,
    description: def.description,
    // Built-in marker: the code ships inside Atlas. API-era plugins will
    // replace this with an `entry` module for the dynamic loader.
    builtin: true,
  }, null, 2) + '\n')
  for (const f of files) {
    const p = join(SRC, f)
    if (!existsSync(p)) { console.error(`missing source ${p}`); process.exit(1) }
    copyFileSync(p, join(stage, 'src', f))
  }
  const zip = join(OUT, `${def.id}.zip`)
  execSync(`zip -q -r ${JSON.stringify(zip)} .`, { cwd: stage })
  rmSync(stage, { recursive: true })
  console.log(`${def.id}.zip  ${(statSync(zip).size / 1024).toFixed(1)} KB`)
}
console.log(`\n${PLUGIN_DEFS.length} plugin zips in ${OUT}`)
