// Course plugin service — mirrors atlas.course.v1 (Course Planner).
//
// The blob (as loadCourse() in atlas-ui/src/page/course.js normalizes it):
//   {
//     courses: [{ id, code, title, credits, prereqs[], coreqs[], preOrCo[],
//                 summerOk, term }],          // term: term key string | null
//     terms: [{ key, season, year, current }],
//     disabledTerms: string[],                // term keys, order preserved
//     settings: { maxCredits, summerMax, strategy },
//   }
// The wire does NOT guarantee that shape: the renderer's course-import seed
// (renderer.js) writes {courses:[...raw checksheet entries]} with no
// settings/terms/disabledTerms keys, and importAll ships legacy backups
// verbatim — loadCourse() only fixes these in memory and never writes back.
// So decompose() replicates loadCourse()'s normalization exactly (defaults,
// cleanRefs, drop id-less courses, dedupe term keys, sort, single current);
// recompose() therefore returns the loader-normalized shape, which is the
// shape the app would produce on its next load anyway.
//
// Fidelity notes vs the spec DDL:
// - disabledTerms[] may contain keys with NO matching terms[] row (the UI lets
//   the user toggle off future summers before they're ever scheduled, and
//   loadCourse keeps any string). The spec's `disabled boolean` on
//   course_terms would silently drop those, so disabled_terms is stored
//   verbatim as text[] on course_settings (array order preserved).
// - settings.maxCredits / summerMax: loadCourse keeps numeric *strings* it
//   finds in storage (e.g. "18" passes both its checks untouched), so a
//   numeric column would coerce "18" → 18 and break the round trip. jsonb
//   preserves number-vs-string exactly.
// - terms[].year: loadCourse accepts any finite Number(t.year) (no integer or
//   2000–2100 constraint), so the column is numeric with no CHECK.

import { runPlugin } from '../../lib/runner.js'

const ddl = `
CREATE TABLE IF NOT EXISTS course_settings (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_credits    jsonb NOT NULL,           -- number (or numeric string) as stored
  summer_max     jsonb NOT NULL,
  strategy       text NOT NULL
                 CHECK (strategy IN ('soonest-summer','soonest-optional-summer','even')),
  disabled_terms text[] NOT NULL DEFAULT '{}',  -- may reference terms with no course_terms row
  ord            integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS course_terms (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     text NOT NULL,                   -- 'fall-2025' (= season || '-' || year)
  season  text NOT NULL CHECK (season IN ('spring','summer','fall')),
  year    numeric NOT NULL,                -- loader allows any finite number
  current boolean NOT NULL DEFAULT false,  -- loader guarantees <= 1 true per user
  ord     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key)
);
CREATE UNIQUE INDEX IF NOT EXISTS course_terms_one_current
  ON course_terms(user_id) WHERE current;

CREATE TABLE IF NOT EXISTS course_courses (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id        text NOT NULL,                 -- client-minted 'c-...'
  code      text NOT NULL DEFAULT '',      -- NOT unique; req refs match on this
  title     text NOT NULL DEFAULT '',
  credits   numeric NOT NULL CHECK (credits >= 0),
  prereqs   text[] NOT NULL DEFAULT '{}',  -- free-text codes (earlier term)
  coreqs    text[] NOT NULL DEFAULT '{}',  -- same term or earlier
  pre_or_co text[] NOT NULL DEFAULT '{}',
  summer_ok boolean NOT NULL DEFAULT false,
  term_key  text,                          -- soft ref to course_terms.key; NULL = 'to take'
  ord       integer NOT NULL DEFAULT 0
  -- no PRIMARY KEY (user_id, id): loadCourse() keeps duplicate course ids
  -- (only id-LESS rows are dropped), so a hand-written import may legally
  -- carry the same id twice; row identity for recompose is ord.
);
CREATE INDEX IF NOT EXISTS course_courses_user ON course_courses(user_id, id);
`

// ---- loadCourse()'s normalization rules, mirrored verbatim ------------------
const SEASONS = ['spring', 'summer', 'fall']
const STRATEGIES = ['soonest-summer', 'soonest-optional-summer', 'even']
const seasonOrder = { spring: 0, summer: 1, fall: 2 }
const termKey = (season, year) => `${season}-${year}`
const termRank = (key) => {
  const [season, year] = String(key).split('-')
  return Number(year) * 3 + (seasonOrder[season] ?? 0)
}
const isObj = (o) => o !== null && typeof o === 'object'
const cleanRefs = (a) => (Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : [])

const mapper = {
  name: 'course',
  storageKey: 'atlas.course.v1',
  ddl,
  tables: ['course_settings', 'course_terms', 'course_courses'],

  decompose(state) {
    // settings — same checks/defaults as loadCourse (numeric strings survive;
    // summerMax's default reads the possibly-string maxCredits, like the loader)
    const settings = isObj(state.settings) ? { ...state.settings } : {}
    if (!Number.isFinite(Number(settings.maxCredits)) || settings.maxCredits <= 0) settings.maxCredits = 15
    if (!Number.isFinite(Number(settings.summerMax)) || settings.summerMax < 0) settings.summerMax = Math.min(9, settings.maxCredits)
    if (!STRATEGIES.includes(settings.strategy)) settings.strategy = 'soonest-summer'

    const disabledTerms = (Array.isArray(state.disabledTerms) ? state.disabledTerms : [])
      .filter(k => typeof k === 'string')

    // terms — filter invalid, recompute key, dedupe (first wins), sort by
    // rank, demote all but the latest current (loadCourse lines 54-62)
    const seen = new Set()
    const terms = (Array.isArray(state.terms) ? state.terms : [])
      .filter(t => isObj(t) && SEASONS.includes(t.season) && Number.isFinite(Number(t.year)))
      .map(t => ({ key: termKey(t.season, Number(t.year)), season: t.season, year: Number(t.year), current: !!t.current }))
      .filter(t => !seen.has(t.key) && seen.add(t.key))
      .sort((a, b) => termRank(a.key) - termRank(b.key))
    const currents = terms.filter(t => t.current)
    if (currents.length > 1) for (const t of currents.slice(0, -1)) t.current = false

    // courses — drop id-less rows, default/clean every field (loadCourse 42-52)
    const courses = (Array.isArray(state.courses) ? state.courses : [])
      .filter(c => isObj(c) && c.id)
      .map(c => ({
        id: c.id,
        code: String(c.code || '').trim(),
        title: String(c.title || '').trim(),
        credits: Number.isFinite(Number(c.credits)) && Number(c.credits) >= 0 ? Number(c.credits) : 3,
        prereqs: cleanRefs(c.prereqs),
        coreqs: cleanRefs(c.coreqs),
        pre_or_co: cleanRefs(c.preOrCo),
        summer_ok: !!c.summerOk,
        term_key: typeof c.term === 'string' && c.term ? c.term : null,
      }))

    return {
      course_settings: [{
        max_credits: JSON.stringify(settings.maxCredits),
        summer_max: JSON.stringify(settings.summerMax),
        strategy: settings.strategy,
        disabled_terms: disabledTerms,
      }],
      course_terms: terms,
      course_courses: courses,
    }
  },

  recompose(rows) {
    const g = rows.course_settings[0]
    return {
      courses: (rows.course_courses || []).map(r => ({
        id: r.id,
        code: r.code,
        title: r.title,
        credits: r.credits,
        prereqs: r.prereqs,
        coreqs: r.coreqs,
        preOrCo: r.pre_or_co,
        summerOk: r.summer_ok,
        term: r.term_key,
      })),
      terms: (rows.course_terms || []).map(r => ({
        key: r.key,
        season: r.season,
        year: r.year,
        current: r.current,
      })),
      disabledTerms: g.disabled_terms,
      settings: {
        maxCredits: g.max_credits,
        summerMax: g.summer_max,
        strategy: g.strategy,
      },
    }
  },
}

export default mapper
if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
