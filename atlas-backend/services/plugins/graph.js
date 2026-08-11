// graph plugin service — mirrors atlas.graph.v1 (src/page/graph.js).
//
// The blob is exactly four scalars, all guaranteed present by loadGraphStore:
//   { dir: string, mode: '2d'|'3d', mdOnly: boolean, maxNodes: int >= 1 }
// Graph data itself (graphify-out/graph.json) never enters localStorage and
// is out of scope here.

import { runPlugin } from '../../lib/runner.js'

const mapper = {
  name: 'graph',
  storageKey: 'atlas.graph.v1',

  // Loader guard is maxNodes >= 1 (graph.js:18) — the UI input's min=50 is
  // cosmetic, so the CHECK stays >= 1.
  ddl: `
CREATE TABLE IF NOT EXISTS graph_settings (
  user_id   uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dir       text NOT NULL DEFAULT '',
  mode      text NOT NULL DEFAULT '2d' CHECK (mode IN ('2d','3d')),
  md_only   boolean NOT NULL DEFAULT false,
  max_nodes integer NOT NULL DEFAULT 1500 CHECK (max_nodes >= 1),
  ord       integer NOT NULL DEFAULT 0
);
`,

  tables: ['graph_settings'],

  // state → single settings row (user_id/ord added by the runner)
  decompose(state) {
    return {
      graph_settings: [
        {
          dir: state.dir,
          mode: state.mode,
          md_only: state.mdOnly,
          max_nodes: state.maxNodes,
        },
      ],
    }
  },

  // rows → exact localStorage blob
  recompose(rows) {
    const r = rows.graph_settings[0]
    return {
      dir: r.dir,
      mode: r.mode,
      mdOnly: r.md_only,
      maxNodes: r.max_nodes,
    }
  },
}

export default mapper

if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
