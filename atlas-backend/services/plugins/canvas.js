// Canvas plugin service — mirrors atlas.canvas.v1.
//
// loadCanvas() (atlas-ui/src/page/canvas.js) guarantees — and decompose()
// re-applies, because the wire carries raw localStorage that the loader only
// ever fixed in memory:
//   host: string, token: string, scale: 'plusminus'|'letters',
//   credits: {}   courseId → RAW input string (may be '', may be garbage —
//                 coerced Number()||3 only at read time; NEVER coerce here),
//   semesters: [] of {id, name, gpa, credits, classes?[]},
//   dismissed: [] of 'courseId:assignmentId' raw strings,
//   hiddenCourses: [] of courseId strings.
//
// Fidelity notes baked into the schema:
// - dismissed entries are kept as ONE raw text column. The app builds keys as
//   `${courseId}:${a.id}` and later destructures split(':') into exactly two
//   parts, so valid ids can't contain a colon — but loadCanvas() passes any
//   string array through untouched, so splitting server-side could corrupt a
//   legacy/odd entry. Raw storage round-trips everything.
// - semesters may LACK classes (rows created before any class was added) or
//   have classes: [] (all classes removed) — has_classes preserves absent vs
//   empty. semesterValue() branches on Array.isArray(sem.classes), so this
//   distinction is behavior, not cosmetics.
// - loadCanvas() does not normalize semester/class internals, so name/gpa/
//   credits/grade are nullable: NULL = key absent from the object (recompose
//   omits the key rather than inventing null).
// - credits{} and hiddenCourses[] merge into canvas_course_prefs; credits is
//   nullable there because '' (user cleared the field, key kept) must stay
//   distinct from NULL (course hidden but never given credit hours).
//   hiddenCourses rows are emitted first, in array order, so the ord column
//   reproduces the exact array; credits{} key order is irrelevant to
//   deepStrictEqual (and JSON) so credits-only rows follow after.

import { runPlugin } from '../../lib/runner.js'

const ddl = `
CREATE TABLE IF NOT EXISTS canvas_settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  host    text NOT NULL DEFAULT '',
  -- ponytail: plaintext at rest, encrypt with pgcrypto when this leaves the tunnel
  token   text NOT NULL DEFAULT '',       -- Canvas personal access token
  scale   text NOT NULL DEFAULT 'plusminus' CHECK (scale IN ('plusminus','letters')),
  ord     integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS canvas_course_prefs (
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id text NOT NULL,                -- Canvas course id, stringified
  credits   text,                         -- RAW input string; NULL = not in credits{}
  hidden    boolean NOT NULL DEFAULT false, -- true = in hiddenCourses[]
  ord       integer NOT NULL DEFAULT 0,   -- hiddenCourses[] array order for hidden rows
  PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS canvas_dismissed (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     text NOT NULL,                  -- raw 'courseId:assignmentId' string, unsplit
  ord     integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, key)
);

CREATE TABLE IF NOT EXISTS canvas_semesters (
  id          text NOT NULL,              -- client 's' + 6 base36
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        text,                       -- NULL = key absent (loader doesn't backfill)
  gpa         text,                       -- raw string; ignored by app when classes exist
  credits     text,                       -- raw string
  has_classes boolean NOT NULL DEFAULT false, -- distinguishes classes:[] from no classes key
  ord         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS canvas_semester_classes (
  id          text NOT NULL,              -- client 's' + 6 base36 (same generator)
  user_id     uuid NOT NULL,
  semester_id text NOT NULL,
  name        text,
  grade       text,                       -- 'A'..'F' from the UI; unchecked, letterPoints() tolerates anything
  credits     text,                       -- raw string
  ord         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id),
  FOREIGN KEY (user_id, semester_id) REFERENCES canvas_semesters(user_id, id) ON DELETE CASCADE
);
`

const nn = v => (v === undefined ? null : v) // absent key → SQL NULL

const mapper = {
  name: 'canvas',
  storageKey: 'atlas.canvas.v1',
  ddl,
  tables: [
    'canvas_settings',
    'canvas_course_prefs',
    'canvas_dismissed',
    'canvas_semesters',
    'canvas_semester_classes',
  ],

  decompose(state) {
    // The wire carries raw localStorage (legacy blobs, importAll), not
    // loadCanvas() output — mirror its normalization so a save never fails
    // on a blob the loader accepts (missing host/token/scale, odd scale
    // values, absent arrays).
    const host = typeof state.host === 'string' ? state.host : ''
    const token = typeof state.token === 'string' ? state.token : ''
    const scale = state.scale === 'letters' ? 'letters' : 'plusminus'
    const credits = state.credits && typeof state.credits === 'object' ? state.credits : {}
    const semList = Array.isArray(state.semesters) ? state.semesters : []
    const dismissed = Array.isArray(state.dismissed) ? state.dismissed : []
    const hiddenCourses = Array.isArray(state.hiddenCourses) ? state.hiddenCourses : []

    // hiddenCourses first (their ord must reproduce the array), then
    // credits-only courses; a course in both gets one merged row. Entries
    // are stringified for course_id, so legacy numeric ids (123) and their
    // string twins ('123') collide — dedupe here (first wins) or the
    // (user_id, course_id) PK aborts the whole save on a mixed pair.
    const prefs = []
    const byCourse = new Map()
    for (const cid of hiddenCourses) {
      const key = String(cid)
      if (byCourse.has(key)) continue
      const row = { course_id: key, credits: null, hidden: true }
      prefs.push(row)
      byCourse.set(key, row)
    }
    for (const [cid, val] of Object.entries(credits)) {
      const row = byCourse.get(cid)
      if (row) row.credits = val
      else prefs.push({ course_id: cid, credits: val, hidden: false })
    }

    const semesters = []
    const classes = []
    for (const sem of semList) {
      semesters.push({
        id: sem.id,
        name: nn(sem.name),
        gpa: nn(sem.gpa),
        credits: nn(sem.credits),
        has_classes: Array.isArray(sem.classes),
      })
      for (const cl of Array.isArray(sem.classes) ? sem.classes : []) {
        classes.push({
          id: cl.id,
          semester_id: sem.id,
          name: nn(cl.name),
          grade: nn(cl.grade),
          credits: nn(cl.credits),
        })
      }
    }

    // dismissed keys share the PK-collision problem: the loader keeps
    // duplicate entries, the UI reads via .includes(), so dedupe (order-
    // preserving, first wins) rather than let the (user_id, key) PK abort.
    const dismissedRows = []
    const seenDismissed = new Set()
    for (const k of dismissed) {
      if (seenDismissed.has(k)) continue
      seenDismissed.add(k)
      dismissedRows.push({ key: k })
    }

    return {
      canvas_settings: [{ host, token, scale }],
      canvas_course_prefs: prefs,
      canvas_dismissed: dismissedRows,
      canvas_semesters: semesters,
      canvas_semester_classes: classes,
    }
  },

  recompose(rows) {
    const st = (rows.canvas_settings || [])[0] || { host: '', token: '', scale: 'plusminus' }
    const s = {
      host: st.host,
      token: st.token,
      scale: st.scale,
      credits: {},
      semesters: [],
      dismissed: (rows.canvas_dismissed || []).map(r => r.key),
      hiddenCourses: [],
    }
    for (const r of rows.canvas_course_prefs || []) {
      if (r.credits !== null) s.credits[r.course_id] = r.credits
      if (r.hidden) s.hiddenCourses.push(r.course_id)
    }
    const classesBySem = new Map()
    for (const r of rows.canvas_semesters || []) {
      const sem = { id: r.id }
      if (r.name !== null) sem.name = r.name
      if (r.gpa !== null) sem.gpa = r.gpa
      if (r.credits !== null) sem.credits = r.credits
      if (r.has_classes) {
        sem.classes = []
        classesBySem.set(r.id, sem.classes)
      }
      s.semesters.push(sem)
    }
    for (const r of rows.canvas_semester_classes || []) {
      const arr = classesBySem.get(r.semester_id)
      if (!arr) continue // orphan (shouldn't happen; FK forbids it)
      const cl = { id: r.id }
      if (r.name !== null) cl.name = r.name
      if (r.grade !== null) cl.grade = r.grade
      if (r.credits !== null) cl.credits = r.credits
      arr.push(cl)
    }
    return s
  },
}

export default mapper
if (import.meta.url === `file://${process.argv[1]}`) runPlugin(mapper)
