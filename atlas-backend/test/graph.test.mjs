// Round-trip test for the graph mapper: recompose(simulatePg(decompose(S)))
// must equal S for any S loadGraphStore can produce.

import { deepStrictEqual } from 'node:assert'
import mapper from '../services/plugins/graph.js'

// Columns declared jsonb in the mapper's DDL: none for graph.
const JSONB_COLS = { graph_settings: [] }

// Deep-clone the decomposed rows and parse jsonb strings, mimicking what pg
// hands back from SELECT *.
function simulatePg(byTable) {
  const out = {}
  for (const [table, rows] of Object.entries(byTable)) {
    out[table] = rows.map(row => {
      const r = structuredClone(row)
      for (const col of JSONB_COLS[table] || [])
        if (typeof r[col] === 'string') r[col] = JSON.parse(r[col])
      return r
    })
  }
  return out
}

const roundTrip = S => deepStrictEqual(mapper.recompose(simulatePg(mapper.decompose(S))), S)

// 1. Exact defaults loadGraphStore produces from empty storage.
roundTrip({ dir: '', mode: '2d', mdOnly: false, maxNodes: 1500 })

// 2. Every field exercised: unicode + spaces in dir, 3d, mdOnly on,
//    maxNodes at the loader's floor (1, below the UI's min=50).
roundTrip({
  dir: '~/Désktop/知识 graph/notes — vault',
  mode: '3d',
  mdOnly: true,
  maxNodes: 1,
})

// 3. Realistic usage: a picked folder, tweaked cap.
roundTrip({
  dir: '~/Desktop/Atlas V4',
  mode: '2d',
  mdOnly: true,
  maxNodes: 800,
})

console.log('OK graph')
