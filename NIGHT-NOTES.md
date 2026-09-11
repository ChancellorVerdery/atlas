# Atlas V4 — overnight refinement notes

Running log, newest pass at the bottom. Written for the next agent to pick up: read this
first, it records what was already tried, what was deliberately left alone, and why.

---

## Pass 1 — 2026-09-06 (overnight), agent: Full Stack

### Ground rules this pass ran under
No commits, no destructive git, stay inside `~/Desktop/Atlas V4`. Left untouched, as instructed:
`atlas-ui/graphify-out/manifest.json` (modified) and `atlas-apple/Atlas.xcodeproj/project.xcworkspace/`
(untracked). Both were still exactly as found at the end of the pass.

### Environment facts worth not rediscovering
- `node` is **not** on the non-login shell's PATH. `export PATH=/opt/homebrew/bin:$PATH` first. node v26.3.0.
- **Backend tests — use this exact command:**
  ```
  cd atlas-backend && node --test "test/*.test.mjs" "test/*.check.mjs"
  ```
  Do **not** use `node --test test/` (node 26 tries to resolve it as a module and fails), and do **not**
  use `node --test "test/*.mjs"` — that glob sucks in `test/ratelimit.e2e.mjs`.
- **`test/ratelimit.e2e.mjs` runs against LIVE PRODUCTION** (`sync.myatlasapp.net`). It deliberately burns
  this IP's real login allowance (10 per 10 min) and is self-poisoning: run it twice inside ten minutes and
  its own step 2 ("login round-trips normally") fails on the limit the previous run set. It is **not** part
  of the normal suite. I tripped it twice early in this pass before realising; that is why it showed a
  failure. Nothing to fix — just don't run it.
- UI checks have no runner script; loop them: `for f in tests/*.check.mjs; do node "$f"; done`.

### Measured baseline at the start of this pass
- Backend: **14 pass / 1 fail** of 15 files. The one failure, `test/work.test.mjs`, was **pre-existing**
  and is a stale test, not a product bug (see below).
- UI: **26 / 26** `atlas-ui/tests/*.check.mjs` pass.

### Pre-existing failure, diagnosed
`test/work.test.mjs` — `services/plugins/work.js` `recompose()` now always emits `jobType` (from
`settings.job_type`) and `histPer` (from the `widget_hist_per` table), and `atlas-ui/src/page/work.js`
`loadWork()` normalizes both (`work.js:17` histPer, `work.js:25` jobType). The **mapper is correct and
current**; the test's five fixtures predate those two fields. Because the very first fixture throws,
fixtures 2–5 never executed at all. Handed to the backend lane.

### Changed by me this pass

**`atlas-ui/scripts/gen-manifest.mjs` — the `-dirty` version marker could never fire.**
Both git calls ran with `cwd: DIST`. `dist/` is gitignored (`atlas-ui/.gitignore:2`), and
`git status --porcelain` does not report ignored paths, so the dirty check always answered "clean".
Measured before the fix: from `dist/` the porcelain check returned **0 lines** while the same command from
`atlas-ui/` returned the 1 known dirty file. Consequence: a bundle built from uncommitted edits stamped a
bare commit sha, and that sha is what `deploy-assets.sh:64` echoes on deploy and what the Swift updater
logs on a device (`atlas-apple/Atlas/Updater.swift:121,125`) — the only signal saying which code a device
is actually running, wrong in exactly the deploy-and-iterate loop where it matters.
Fix: run both git commands from the UI **source** root, and scope the dirty check to real build inputs
(`src index.html vite.config.js package.json package-lock.json`) rather than the whole directory — scoping
matters, because `graphify-out/` is dirty right now and an unscoped check would pin every future build to
`-dirty` and make the marker useless in the other direction.
Verified: clean inputs → `829f869`; with a throwaway untracked probe file under `src/` → `829f869-dirty`;
probe removed → `829f869`. Purely diagnostic — `builtAt`, not `version`, decides which copy wins on a
device, and download dirs are named `build-<builtAt>`, so nothing functional depends on this string.

### Leads for a later pass (found, deliberately NOT fixed)
- **`gen-manifest.mjs` walks every file in `dist/`, dotfiles included.** A `.DS_Store` landing in `dist/`
  (the repo root already has one) would be listed in the manifest, deployed by `deploy-assets.sh`, and
  downloaded to every device. Low impact, and I could not verify a dotfile-skip change end-to-end without a
  full deploy, so I left it. Worth a look with the deploy path in hand.
- **`atlas-backend/services/uiapi/app.js:39`** serves everything except `.json` as
  `application/octet-stream`. Harmless for the updater (it only writes bytes and sha-checks them), but it
  means the `/app` route can never be used to serve the bundle to a browser directly. Fine as-is; noting so
  the next pass doesn't "fix" it into a security-relevant content-type guess.
- `test/sync-coverage.check.mjs` states its own ceiling: 5 of the 10 plugins, and top-level + nested
  **object** fields only — never array-element fields, because an empty default array gives `decompose` no
  rows. Array-element drift is each plugin test's own job and is the gap most likely to hide a live bug.


---

## Pass 2 — 2026-09-06/07 (overnight), agent: Full Stack

Continuation of an aborted run. Everything the abort left in the tree was kept and built on;
nothing was committed, stashed or reverted.

### What the aborted run had already left behind (kept, verified green)
`finance.js` + `finance.test.mjs` (vendorRules mapping), `ladder.js` + `ladder.test.mjs`
(flex.addr), `work.test.mjs` (the stale-fixture failure Pass 1 diagnosed — now fixed),
`workui.js` (empty-input error messages + aria-labels), `sync.js` (flushPushes double-schedule
guard). Measured at pickup: backend **15/15**, UI **26/26**. Pass 1's note that work.test.mjs
fails is now **stale** — the aborted run fixed it.

### Environment facts (additions to Pass 1's list)
- `timeout(1)` does **not** exist on this Mac. Don't wrap test runs in it.
- There is **no local Postgres** (`pg_isready` fails). No mapper DDL can be executed here; the
  only way to catch a bad column is statically. Hence the new check below.
- `lib/runner.js` has **no `checkInsertTargets` function** — three mapper comments name it, but
  it does not exist. `store()` builds `INSERT` straight from `Object.keys(row)` (runner.js:142),
  so a bad column is a *production* Postgres 42703, caught by nothing.

### Bug found and fixed: Ladder dropped three user settings on every cloud sync
`dwellFloorMin`, `roundTripFrac`, `gapOverrides` were absent from the ladder mapper entirely.
All three are user-editable — the first two from the Ladder settings number inputs
(`ladderui.js:490,495`, written at `:556,557`), the third by `setGapOverride` (`ladder.js:147`),
the per-block forced travel choice on the drive card. They pushed to the server, were stored as a
blob without them, and the next pull overwrote the local copy with the built-in defaults. Same
class as gym's `plan.overrides`. **Not** hypothetical: reproduced by measurement before the fix.

Fix: three jsonb columns on `ladder.settings` (+ idempotent `ALTER`s — `CREATE TABLE IF NOT
EXISTS` is a no-op on the existing table, the trap the flex.addr comment already documents),
mirrored in `normalizeLadder`/`decompose`/`recompose`. jsonb, not numeric, for the same reason as
`buffer`: both loader rules are `Number.isFinite(Number(x))` plus a range test on the **raw**
value, so `'45'` and `'0.5'` pass and stay strings.

Worth knowing, found by the new test: `isObj` is `typeof o === 'object'` in **both** loadLadder
and the mapper, so an **array** is a valid `gapOverrides` and is kept verbatim, not coerced to
`{}`. The mapper's job is to mirror the loader, not to be stricter — the test asserts this.

### Root cause addressed: the coverage check only looked at half the plugins
`sync-coverage.check.mjs` covered 5 of 10 mappers, excluded on a "client module must be
dependency-free" rule. **That rule was stale.** ladder/calendar/email import sync.js, platform.js
and each other, but none do DOM or network work at import time — all three load fine under node
with the localStorage stub the file already has. Widening it to 8 is what surfaced the ladder bug
above, on its first run.

- **email needed an exemption, not a fix.** It reported 4 missing paths
  (`connected`/`address`/`accounts`/`accounts[]`) — all **false positives**. `loadEmail` returns a
  *merge* of two storage keys, and `saveEmail` splits the Google half back out precisely so a pull
  can't carry it off; the mapper drops them on purpose. Added a small documented `NOT_SYNCED`
  allowlist rather than weakening the check.
- **finance and graph still cannot be covered, and this is not fixable here.** They are *retired*
  plugins: client source is deliberately out of the repo (`.gitignore:40`), shipping only as
  gitignored `plugins-dist/*.zip`. A clean checkout has no client half to import. **This is
  exactly how `vendorRules` stayed unmapped.** Recorded in the file so the next pass doesn't
  re-derive it.

### New: `atlas-backend/test/ddl-columns.check.mjs`
Static guard for the gap left by having no local Postgres. Asserts every column `decompose()`
emits — plus the `user_id`/`ord` the runner stamps on — exists in that mapper's own DDL (CREATE
bodies **and** `ALTER ... ADD COLUMN`), and that every table in `mapper.tables` is actually
created (`store()` also `DELETE`s from each one, so a missing table breaks every save).
Currently **10/10 mappers, 84 columns**.

One thing to know if you touch its parser: the DDL scrubber **must** be a single left-to-right
scan. A first cut stripped string literals with one regex and comments with another, and it
reported `canvas.semester_classes` — a table that plainly exists at `canvas.js:96` — as missing.
Cause: the comment `-- NULL = key absent (loader doesn't backfill)` carries a lone apostrophe,
which the literal-first regex paired with a quote ten lines down and swallowed the CREATE in
between. Comments contain apostrophes and literals contain `--`; only a context-aware single pass
gets both right. I only caught it because I checked the failure by hand instead of believing it.

### Also corrected
`finance.js` cited `atlas-ui/src/page/finance.js` as the home of `setVendorRule`. **That file does
not exist** — it cost me real time. Replaced with the true location (the retired-plugin zip) and
why a clean checkout won't have it.

### Verified vs asserted this pass
- **VERIFIED by running:** backend **16/16** (15 + the new check), UI **26/26**. The ladder bug
  reproduced before the fix and gone after. Both new checks negative-controlled — I broke the code
  deliberately (removed `dwellFloorMin` from recompose; added a `bogus_col` to decompose), confirmed
  each check FAILS, then restored and confirmed the file byte-identical with `cmp`.
- **ASSERTED, not verified:** the new `ALTER TABLE ladder.settings` statements have never been run
  against a real Postgres — there is none on this Mac. They are syntactically parallel to the
  flex.addr ALTER already in the tree, but first real deploy is their first execution.
- **NOT done:** no UI build. `/tmp/mac-build.lock` was held by a live `pass3-backend-design` (23:42,
  not stale) for my whole window. I did not steal it. Nothing I changed is UI source, so no build
  was needed for my own work — but the aborted run's `workui.js` / `sync.js` edits remain
  **build-unverified** by me. Worth a `vite build` next pass.

### Heads-up for the next pass
Another agent (`pass3-backend-design`) was working this same repo concurrently. My files were
intact at the end, but if `atlas-backend` looks unexpected, suspect overlap rather than the abort.

### Leads (found, deliberately NOT fixed)
- Pass 1's two leads (`gen-manifest.mjs` dotfiles in `dist/`; uiapi octet-stream) still stand.
- `ddl-columns.check.mjs` can only inspect tables `decompose({})` emits a row for — settings/prefs
  tables are covered, per-row tables mostly are not (it prints each unchecked table rather than
  passing silently). Feeding it each plugin's own test fixtures would close most of that.
- `gapOverrides` keys: `ladder.js:54`'s own comment notes overrides on meal/gym/week-flex blocks
  embed a window-relative day index and won't survive the window rolling. Now that they persist to
  the cloud, that staleness outlives a reload rather than dying with it. Product call, not a bug.

---

## Pass 3 — 2026-09-07 (overnight), agent: Full Stack

Picked up from Pass 2's end state and continued its line of work: the sync-drop bug class.

### Baseline (measured, both ends)
- **Before:** backend **16/16**, UI **26/26**. Matches Pass 2's closing numbers exactly — nothing
  had rotted, and no other agent's work was sitting broken in the tree.
- **After:** backend **17/17** (the new check below), UI **26/26**.

### Pass 2's exhaustiveness claim: VERIFIED, and now enforced
`sync-coverage.check.mjs` covers 8 mappers; `services/plugins/` holds exactly 10; the 2 missing
are `finance` and `graph`, whose client source is deliberately out of tree. So the claim was true.

But it was true *by inspection only* — a coverage check's failure mode is silence, and an 11th
mapper would have joined the blind spot without a word. The new check now asserts it: it reads
`services/plugins/` off disk and fails if any mapper is in neither `PLUGINS` nor `RETIRED`.
Negative-controlled by touching `services/plugins/zzprobe.js` (FAIL, correctly named), then
removing it and confirming the directory back at 10 files.

### New: `atlas-backend/test/sync-array-coverage.check.mjs`
Closes the ceiling both prior passes flagged as "the gap most likely to hide a live bug".

The existing check feeds each mapper the loader's **default** shape, so every array is empty and
its `paths()` collapses them to a bare `foo[]` — element fields are invisible to it. This file
seeds a realistic payload into `localStorage` **under the plugin's own storage key** and runs it
through the plugin's own loader, so the loader still decides normalized truth; only the input is
richer. Every fixture field is copied from the UI writer that creates it, cited inline
(`addShift work.js:128`, `logSet gym.js:168`, `buildFlexFields ladder.js:93`, and so on) — a
fixture richer than reality reports drops that cannot happen.

Now covering **87 array-element key paths** across the 8 in-tree plugins that were previously
untested at that depth. Result: **no drops found.** The mappers are in better shape than the
ceiling note implied.

It also answers the next question down — a field can survive as a key path and come back with a
different **value** — by deep-comparing the round trip, type included. Also clean.

### The false positive I nearly filed, and what it cost to catch
The value comparison's first run reported canvas losing three fields:
`semesters[].gpa "3.8" -> 3.8`, plus `credits` on the semester and its nested class. It reads
exactly like the vendorRules/dwellFloorMin class.

**It is not a bug.** Those are `text` columns holding a deliberately raw input string
(`canvas.js:89,90,102`), and the mapper's `nn()` (`canvas.js:109`) passes them through untouched.
The only thing that turned the string into a number was the **check harness's own `reparse()`**,
inherited from `sync-coverage.check.mjs`, which JSON-parses any string starting with a digit
regardless of the column's declared type.

Fix: `reparse` is now scoped to columns actually declared `jsonb` in the mapper's DDL. That is
the only type `decompose` stringifies and pg parses back; text and numeric come back as-is, and
re-parsing them is how a harness invents a bug. With that scoping, **all value diffs vanish** —
the three "corruptions" were entirely the harness. Documented at the `reparse` definition so the
next pass does not reintroduce it.

Worth knowing: **`sync-coverage.check.mjs` still has the unscoped `reparse`.** Harmless there —
it only asks whether a key path exists, and re-parsing cannot make a key vanish. But anyone
extending that file to compare values will hit the same trap.

### Checked and cleared: numeric columns
I expected a second harness-faithfulness problem — node-pg returns `numeric` as a **string** by
default, which would make every numeric round trip a silent type change the harness doesn't
model. It doesn't apply: `lib/db.js:6,7` already installs type parsers coercing `numeric` (OID
1700) and `int8` (20) to `Number`. The harness passing numbers through unchanged is therefore
correct, not lucky. Recording it so the next pass doesn't re-derive it as a bug.

### Verified vs asserted
- **VERIFIED by running:** backend 17/17, UI 26/26. All three arms of the new check
  negative-controlled — I broke the code deliberately, confirmed FAIL, restored, and confirmed
  byte-identical with `cmp` each time:
  - *dropped path*: blanked `put(f, 'anchorLabel', …)` at `ladder.js:285` → `FAIL ladder:
    flex[].anchorLabel`.
  - *changed value*: `tips: (Number(sh.tips) || 0) + 1` in `work.js` → `FAIL work:
    shifts[0].tips: 40 -> 41`.
  - *coverage drift*: `touch services/plugins/zzprobe.js` → `FAIL coverage drift: zzprobe`.
- **ASSERTED, not verified:** nothing new. This pass added no DDL and no product code — the only
  file it introduces is a test. Pass 2's `ALTER TABLE ladder.settings` statements remain
  unexecuted against a real Postgres; still no local one (`lib/db.js` aside, `pg_isready` fails).
- **UI build: DONE, and Pass 2's open lead is closed.** `/tmp/mac-build.lock` was held by a live
  `frontend-design pass4` for most of my window (taken 00:26, inside the 40-min staleness
  window) — I did not steal it, I waited and took it when it freed. `npx vite build` then ran
  clean, **exit 0, built in 456ms**. So the aborted run's `workui.js` / `sync.js` edits are now
  **build-verified**. Lock released.
  The build emits a pre-existing chunk-size warning (`renderer` 1.16 MB, `compute-engine`
  1.93 MB, over the 500 kB limit). Unrelated to any edit in the tree and not new — noting it so
  it isn't mistaken for fallout.

### Leads (found, deliberately NOT fixed)
- Pass 1's two leads (`gen-manifest.mjs` dotfiles in `dist/`; uiapi octet-stream) still stand.
- Pass 2's `ddl-columns.check.mjs` lead (per-row tables mostly unchecked because `decompose({})`
  emits no rows for them) is now **cheap to close**: this file's seeded fixtures produce exactly
  those rows. Feeding `sync-array-coverage`'s `PLUGINS[].seed` into `ddl-columns.check.mjs` would
  extend it from settings tables to per-row tables with no new fixture authoring at all. That is
  the highest-value hour available to the next pass.
- The value comparison only walks keys present on **both** sides. A mapper that *adds* a field
  the loader never had is invisible to it. Probably benign — recompose adding a default is
  normal — but it is a real asymmetry, and I did not survey it.
- `sync-coverage.check.mjs`'s unscoped `reparse`, above. Not worth changing for its own sake;
  worth knowing before extending it.

---

## Pass 4 — 2026-09-07 (overnight), agent: Full Stack

Note on numbering: NIGHT-NOTES already had a Pass 3 section when I picked this up, so I am
Pass 4. I did not redo it. I took the item Pass 3 named "the highest-value hour available to
the next pass" and closed it.

### Baseline (measured, both ends)
- **Before:** backend **17/17**, UI **26/26** — exactly Pass 3's closing numbers. Nothing had
  rotted and no other agent's work was sitting broken in the tree.
- **After:** backend **17/17**, UI **26/26**. Same file count on purpose: this pass added no new
  check file, it widened an existing one. The new `plugin-seeds.mjs` is a fixture module, not a
  test, and is deliberately named so the `test/*.check.mjs` glob does not pick it up.

### Closed: `ddl-columns.check.mjs` was checking a third of the tables it claimed to
Pass 2 built it, Pass 3 flagged its ceiling. Measured before touching anything:

```
ddl-columns: 84 emitted column(s) all exist
```

...with **28 tables reported unchecked**, every per-row table in the repo among them
(`work.shifts`, `gym.logs`, `ladder.flex`, `sleep.logs`, `course.courses`, …). Cause is
structural: it fed each mapper `decompose({})`, and a mapper handed the loader's *default*
shape emits no rows for a per-row table, so there was nothing to read columns off. The check
printed a `note` per table rather than passing silently — which is why the gap was visible at
all — but a bad column on any per-row table was caught by nothing.

Fix is the one Pass 3 sketched: `sync-array-coverage.check.mjs` already owns realistic seeded
fixtures for all 8 in-tree plugins, and those seeds produce exactly the missing rows. So
`ddl-columns` now seeds each plugin's storage key, runs the plugin's **own loader**, and
decomposes that. Retired plugins (finance, graph) have no client half in tree and keep the `{}`
fallback — they are the only tables still unchecked, and they say so.

Measured after:

```
ddl-columns: 251 emitted column(s) all exist
```

**84 → 251 columns; 28 → 9 unchecked tables, all 9 finance.** No new failures — the mappers
were already correct at that depth. The value here is the guard, not a fix.

### New: `atlas-backend/test/plugin-seeds.mjs`
Rather than copy 80 lines of fixtures into a second file, I extracted them **verbatim** (by
line range, not retyped) into a shared module: the localStorage stub, `TODAY`, `PLUGINS`,
`RETIRED`, `NOT_SYNCED`, plus a `seedFor(p)` helper. Both checks import it.

**This is a judgment call, and it is the thing to overturn if you disagree.** It couples two
checks that were independent. I made it because the alternative failure is worse and silent:
two divergent copies of the fixtures, where a field added to a UI writer gets taught to one
check and not the other, and the check that missed it keeps printing `ok`. The whole reason
`finance.vendorRules` survived unmapped for so long is that nothing loud was watching. If you
would rather have duplication, the split is a `git diff` away — `sync-array-coverage` is
otherwise unmodified.

Verified the refactor is behaviour-identical, not just green: `sync-array-coverage` prints the
same per-plugin path counts as Pass 3 recorded (19+13+7+10+14+24 = **87** array-element paths,
8 exercised / 2 retired).

### Negative controls (both run, both restored byte-identical with `cmp`)
- **The new reach, on a per-row table** — the exact case that was previously invisible. Added
  `bogus_percol: 1` to `shifts.map()` in `services/plugins/work.js:127`:
  ```
  FAIL work: 1 problem(s)
         work.shifts.bogus_percol is emitted by decompose but missing from the ddl (Postgres 42703 on every save)
  1 mapper(s) would fail at INSERT time
  ```
  Before this pass that same edit produced `ok work` plus a `note work.shifts: … unchecked`.
- **Silent degradation**, the new failure mode this design introduces. If a fixture stops
  loading, the check would quietly fall back to `{}` and shrink to the settings-only ceiling it
  exists to lift — passing while testing nothing. So a fixture whose loader does not run is a
  hard FAIL, not a note. Renamed `loadSleep` → `loadSleepXX` in the seeds:
  ```
  ok   sleep: every decomposed column exists in the ddl (decompose({}))
  note sleep.logs (from decompose({})): no rows emitted — columns unchecked
  FAIL sleep: fixture present but its loader did not run — no loadSleepXX
  ```
  Every `ok` and `note` line now names its shape source (`seeded fixture` vs `decompose({})`),
  so the check's own reach is readable in its output instead of having to be inferred.

### Verified vs asserted
- **VERIFIED by running:** everything above — the 84→251 figure, backend 17/17 and UI 26/26 at
  both ends, and both negative controls, each restored and `cmp`-confirmed identical.
- **ASSERTED, not verified:** nothing new this pass. It added no DDL and no product code; the
  only product file it touched was `work.js`, temporarily, for the negative control, and that
  is restored byte-identical. Pass 2's `ALTER TABLE ladder.settings` statements are still
  unexecuted against a real Postgres — still none on this Mac.
- **No UI build, and none needed.** `git status` confirms this pass touched only
  `atlas-backend/test/`; no UI source changed. I therefore never took `/tmp/mac-build.lock`,
  so no other agent was blocked by me. Pass 3's build verification of `workui.js` / `sync.js`
  still stands.

### Leads (found, deliberately NOT fixed)
- Pass 1's two leads (`gen-manifest.mjs` dotfiles in `dist/`; uiapi octet-stream) still stand.
  They are now the oldest untouched items in this file — four passes have deferred both.
- **finance's 9 tables are the last unchecked ones, and it is the plugin with the worst track
  record.** `vendorRules` was lost there. Its client half is out of tree, so it cannot be
  covered the way the other 8 are — but a hand-written `decompose` fixture, authored from the
  *mapper's* own DDL rather than a loader, would close it. That is a real hour of work and the
  only remaining hole; it is the highest-value item left.
- Pass 3's asymmetry lead still stands: the value comparison only walks keys present on **both**
  sides, so a mapper that *adds* a field the loader never had is invisible. Still unsurveyed.
- `sync-coverage.check.mjs`'s unscoped `reparse` still stands (harmless there; a trap for anyone
  extending it to compare values). It is now the only one of the three sync checks not sharing
  `plugin-seeds.mjs` — it has its own older fixture style. Folding it in would be tidy but is
  not urgent, and I did not want to touch three checks in one night.

---

## Pass 5 — 2026-09-07 (overnight), agent: Backend Design

Numbering: I was briefed as "pass 4", but NIGHT-NOTES already had a Pass 4 section when I
picked it up, so I am Pass 5. Same drift the previous agent hit. I did not redo Pass 4's work.

Took the item Pass 4 named "the highest-value item left": finance's 9 unchecked tables.

### Baseline (measured, both ends)
- **Before:** backend **17/17**, UI **26/26** — exactly Pass 4's closing numbers.
- **After:** backend **17/17**, UI **26/26**. No new check *file* on purpose: this pass widened
  the reach of the two existing ones, same as Pass 4 did.

### Closed: finance was the last mapper nothing could reach
Both sync checks depend on running the plugin's **own loader** over a seeded `localStorage`
payload. finance and graph are retired — their client half ships only as gitignored plugin zips
(`.gitignore:40`), so a clean checkout has no `loadFinance` to run. That was structural, and it
is why Pass 4 left finance's 9 tables as the only ones in the repo unexamined by anything. It is
also the plugin with the worst track record: `vendorRules` was silently dropped on every cloud
load until Pass 2 caught it.

Fix is the one Pass 4 sketched: a **hand-authored raw blob**, fed straight to `decompose()` with
no loader in the path. New export `RETIRED_FIXTURES` in `test/plugin-seeds.mjs`.

**The provenance of that fixture is the whole design, not a detail.** It is authored from the
`Blob shape` header comment at the top of `services/plugins/finance.js` — the mapper's own record
of what `loadFinance()` produces — plus its DDL for the per-entry fields the extract columns read.
It is deliberately **not** derived from `decompose()`. A fixture read off the code under test can
only ever agree with it, and would have been exactly as blind to `vendorRules` as the mapper was.
Authored from the documented blob, a top-level key the mapper forgets is a *failing round trip*.
Negative control NC2 below is precisely that scenario, reproduced.

### `ddl-columns.check.mjs`: 251 → 287 columns, 9 → 0 unchecked tables
Retired mappers now take the raw fixture as their shape (`raw fixture` in the output, vs
`seeded fixture` / `decompose({})`), so all 10 finance tables emit rows. Measured:

```
before: ddl-columns: 251 emitted column(s) all exist   + 9 unchecked tables, all finance
after:  ddl-columns: 287 emitted column(s) all exist   + 0 unchecked
```

A retired mapper with **no** raw fixture stays on `decompose({})` and is still reported unchecked
rather than passing quietly — `graph` is that case and says so.

### `sync-array-coverage.check.mjs`: a retired arm, guarded against lying
`finance (retired): 60 paths survive unchanged (30 on array elements), round trip idempotent`.
No drops, no value changes — the mapper is in good shape at this depth.

The hand-written fixture introduces a failure mode the loader-driven arm does not have: **"the
fixture was never in normalized form"**, which would report the normalizer's own correct work as a
data loss. So the arm asserts **idempotence first** — a second round trip must equal the first —
and only then compares fixture vs result. If the mapper is a fixed point on its own output but the
fixture differs from it, the fixture is what is wrong, and the output says so instead of guessing.

Refactor note: `roundTrip()` and `valueDiffs()` were hoisted out of the `PLUGINS` loop so the
retired arm reuses them verbatim rather than growing a second copy. Verified behaviour-identical,
not just green — all 8 loader-driven plugins print the same path counts Pass 3/4 recorded
(19+13+7+10+14+24 = **87** array-element paths).

### Negative controls (all four run; every edit restored and `cmp`-confirmed byte-identical)
- **NC1 — new reach on a finance per-row table**, previously invisible. `bogus_percol: 1` into
  `vendor_rules` in `decompose`:
  `FAIL finance: finance.vendor_rules.bogus_percol is emitted by decompose but missing from the ddl`
- **NC2 — the vendorRules class itself.** Commented out `vendorRules,` in `recompose`:
  `FAIL finance (retired): 2 path(s) lost — vendorRules, vendorRules.starbucks`
  This is the exact bug that survived unnoticed until Pass 2. It is now caught by a check.
- **NC3 — value corruption on a per-entry jsonb truth column.** Made `networth_history.raw`
  stringify `netWorth: 1`:
  `changed: netWorthHistory[0].netWorth: 4321 (number) -> 1 (number)`
- **NC4 — the fixture-fault path**, i.e. the way this arm could lie. Set the fixture's
  `env: 'bogus'` (which `normalizeFinance` correctly folds to `'sandbox'`):
  `changed: env: "bogus" (string) -> "sandbox" (string)` plus the "check the fixture before
  blaming the mapper" guidance. The idempotence assertion held, which is what makes that guidance
  correct rather than a guess.

### Verified vs asserted
- **VERIFIED by running:** everything above — the 251→287 figure, the 9→0 unchecked tables, the 87
  unchanged element paths, backend 17/17 and UI 26/26 at both ends, and all four negative controls.
- **ASSERTED, not verified:** nothing new. This pass added no DDL and no product code. The only
  product file touched was `finance.js`, temporarily, for NC1–NC3, restored byte-identical.
  Pass 2's `ALTER TABLE ladder.settings` statements are still unexecuted against a real Postgres —
  still none on this Mac (`pg_isready` fails).
- **No UI build, and none needed.** `git status` confirms this pass touched only
  `atlas-backend/test/`. I never took `/tmp/mac-build.lock`, so no other agent was blocked by me.

### The limit of what was just closed — read this before calling finance "covered"
With the client half out of tree, the finance arm compares the mapper against **itself plus its own
documentation**. It catches a field the mapper drops or corrupts (NC2, NC3 — the real historical
bug class). It **cannot** catch the mapper and the real `loadFinance()` disagreeing about
normalization, because there is no `loadFinance()` here to disagree with. That gap is not closable
by any amount of test writing; it needs the retired client source in the tree.

### Leads (found, deliberately NOT fixed)
- **Decision for Chancellor, not a code change:** finance and graph's client source is gitignored
  by deliberate choice, and that choice is now the sole remaining blind spot in the sync test
  suite. Options as I see them: (a) leave it — the mapper-vs-itself check above covers the bug
  class that actually bit, and the fixture makes drift loud; (b) commit the retired plugin source
  under a `retired/` path so the real loaders can be imported like the other 8. I lean (a): the
  cost of (b) is un-ignoring source that was retired on purpose, and the residual risk is the
  normalization-drift of a plugin no longer being developed.
- **`graph` still has no raw fixture** and is now the only mapper in that state. The same
  `RETIRED_FIXTURES` mechanism would cover it; I did not author one because I had no equivalent
  documented blob shape to author it *from*, and inventing one would have produced exactly the
  self-agreeing fixture this pass argues against. Check `graph.js`'s header first — if it has a
  blob-shape comment as good as finance's, this is a cheap hour.
- Pass 1's two leads (`gen-manifest.mjs` dotfiles in `dist/`; uiapi octet-stream) still stand,
  now five passes deferred. If they are never going to be done, they should be deleted from this
  file rather than re-listed a sixth time.
- Pass 3's asymmetry lead still stands: the value comparison only walks keys present on **both**
  sides, so a mapper that *adds* a field the loader never had is invisible. Still unsurveyed.
- `sync-coverage.check.mjs`'s unscoped `reparse` still stands, and it is still the only one of the
  three sync checks not sharing `plugin-seeds.mjs`.

---

## Pass 6 — 2026-09-07 (overnight), agent: Full Stack

Numbering: NIGHT-NOTES already had a Pass 5 section (written by Backend Design) when I picked
it up, so I am Pass 6 — the same drift the last two agents hit. I did not redo Pass 5.

Took the two remaining leads that were cheap and named as such: `graph`'s missing raw fixture,
and Pass 3's unsurveyed asymmetry. Then closed the oldest lead in the file — Pass 1's
`gen-manifest.mjs` dotfile item, which Pass 5 correctly said should be done or deleted rather
than listed a sixth time.

### Baseline (measured, both ends)
- **Before:** backend **17/17**, UI **26/26** — exactly Pass 5's closing numbers. Nothing rotted.
- **After:** backend **17/17**, UI **26/26**. No new check file: all three items widened or fixed
  existing ones. `git status` shows the same modified/untracked set at both ends.

### Closed: `graph` was the last mapper with no fixture
Pass 5 left it deliberately, wanting a documented blob shape to author from rather than an
invented one. `services/plugins/graph.js:3-4` has exactly that:

```
//   { dir: string, mode: '2d'|'3d', mdOnly: boolean, maxNodes: int >= 1 }
```

Four scalars, "all guaranteed present by loadGraphStore". So the fixture is authored from the
header comment, not from `decompose()` — same provenance rule finance's follows and for the same
reason. **Every value is the non-default branch of its column** (`mode '3d'` vs default `'2d'`,
`md_only true` vs `false`, `max_nodes 500` vs `1500`, non-empty `dir`), so a mapper that dropped a
field and let the DDL default backfill it would still be caught rather than accidentally matching.

Result: `ok graph (retired): 4 paths survive unchanged (0 on array elements), round trip
idempotent`. The `skip` list in `sync-array-coverage` is now **empty** — all 10 mappers on disk
are exercised by both sync checks. `ddl-columns` stays at **287 columns**: graph's single settings
table already emitted a row under `decompose({})`, so the gain is the round-trip arm, not column
reach. Saying so plainly because "10/10 fixtures" reads like a bigger number moved than did.

### Closed: Pass 3's asymmetry lead — surveyed first, then enforced
Three passes flagged it: the path comparison only ever asked whether an *input* path came back, so
a mapper that **adds** a path the loader never produced was invisible. Not automatically a bug (a
recompose filling a default is ordinary), which is why nobody had acted on it.

I surveyed it before deciding severity, with a throwaway script outside the suite:

```
gym: added 0     work: added 0    sleep: added 0    canvas: added 0   course: added 0
ladder: added 0  calendar: added 0  email: added 0
finance (retired): added 0        graph (retired): added 0
```

**Zero, everywhere, on all 10.** That is what makes a hard FAIL the right severity instead of a
note nobody reads — the baseline is clean, so any addition is genuinely new. Both arms of
`sync-array-coverage.check.mjs` now assert it, with an `ALSO_ADDED` exemption map in
`plugin-seeds.mjs` — deliberately **empty**, and the mirror of the existing `NOT_SYNCED`. A
legitimate future default goes in there with a reason rather than the check being loosened.

### Closed: `gen-manifest.mjs` shipped `.DS_Store` to every device (Pass 1's lead, 5 passes old)
Reproduced before fixing, not assumed. Planted `dist/.DS_Store` and a `dist/.cache/x.txt`:

```
before: manifest.json: 829f869-dirty, 37 files    dot paths in manifest: ['.DS_Store', '.cache/x.txt']
after:  manifest.json: 829f869-dirty, 35 files    dot paths in manifest: 0
        gen-manifest: skipped 2 dot-path(s): .DS_Store, .cache
clean dist, after: manifest.json: 829f869-dirty, 35 files   (no skip line — silent when there is nothing to skip)
```

The manifest's file list is what every device downloads (`Updater.swift`), so a Finder artifact in
`dist/` was a real file shipped to every phone. Fix skips dot-entries, **directories included**,
and logs what it skipped — a build quietly dropping paths is how you lose a real asset without
noticing.

**Why this is safe, and it is worth knowing the deploy interaction:** `deploy-assets.sh:44` tars
`dist` unfiltered, so the dotfile still reaches the server — but its sweeper's keep-list *is* this
manifest, so the same deploy now deletes it. Not served, not listed, not downloaded. I checked for
a legitimate dot-path first: no `public/`, no `.well-known`, no `apple-app-site-association`
anywhere in the tree. Noted at the fix as the line to revisit if one ever appears.

Pass 1 left this because it "could not verify a dotfile-skip change end-to-end without a full
deploy". You do not need one — `gen-manifest.mjs` runs standalone against an existing `dist/`,
which is how the numbers above were measured. `dist/` was restored to exactly the state I found it
in (no `manifest.json`, since it had none).

### Negative controls (all three run; every edit restored and `cmp`-confirmed byte-identical)
- **NC1 — graph's new reach.** Deleted `mdOnly: r.md_only` from `graph.js` recompose:
  `FAIL graph (retired): 1 path(s) lost, 0 added, 0 value(s) changed / lost: mdOnly`
- **NC2 — the added-path assertion, retired arm.** Added `zoom: 1` to graph's recompose:
  `FAIL graph (retired): 0 path(s) lost, 1 added, 0 value(s) changed / added: zoom`
- **NC3 — the added-path assertion, loader-driven arm.** Added `overtimeRate: 1.5` to `work.js`
  recompose:
  ```
  FAIL work: 1 key path(s) are ADDED by the round trip
         overtimeRate
         if this is a deliberate default, list it in ALSO_ADDED with a reason
  ```
  Before this pass that same edit produced a plain `ok work`.

### Verified vs asserted
- **VERIFIED by running:** all of it — the 37→35 manifest figures, the added-path survey's zeros,
  graph's round trip, backend 17/17 and UI 26/26 at both ends, and all three negative controls
  restored `cmp`-identical.
- **ASSERTED, not verified:** the dotfile fix's *deploy-side* consequence. I read
  `deploy-assets.sh` and reasoned that the sweeper removes what the manifest omits; I did not run a
  deploy (that would touch production). The manifest change itself is measured; the sweep is
  inference from the script. Also still standing from Pass 2: the `ALTER TABLE ladder.settings`
  statements have never run against a real Postgres — still none on this Mac.
- **No UI build, and none needed.** `gen-manifest.mjs` is a build *script*, not bundled source —
  vite never sees it. Nothing under `atlas-ui/src` changed this pass, so I never took
  `/tmp/mac-build.lock` and blocked nobody.

### What Chancellor should overturn if he disagrees
- **The added-path FAIL.** It is a hard failure on a thing that is not always a bug. I chose it
  because the survey came back all zeros, so it costs nothing today and catches drift the moment it
  starts. If you would rather it be advisory, change the two `failures++` next to `added.length` to
  leave the counter alone — the message already says what to do.
- **Skipping dot-*directories*, not just dot-files.** Files are clearly right. Directories are the
  judgment call: it forecloses a future `.well-known/` in the bundle. There is none today and the
  fix logs every skip, so it would announce itself rather than silently vanish, but it is the
  narrower change if you disagree.
- Pass 5's open decision is still open and still his: **finance/graph client source is gitignored**,
  which is the only remaining blind spot in the sync suite. Pass 5 leaned toward leaving it; I
  agree, and graph's fixture above narrows it a little further.

### Leads (found, deliberately NOT fixed)
- **`uiapi/app.js:39` octet-stream is now the sole survivor of Pass 1's leads.** Pass 1's own note
  says it is fine as-is and warns the next pass not to "fix" it into a content-type guess. Six
  passes have agreed with that. **It should be deleted from this file, not re-listed a seventh
  time** — it is a documented deliberate choice, not an open item. I left it for Chancellor to
  strike rather than editing away another agent's note.
- `sync-coverage.check.mjs` is still the only one of the three sync checks not sharing
  `plugin-seeds.mjs`, and still has the unscoped `reparse` (harmless there; a trap if extended to
  compare values). Now the last piece of fixture duplication in the suite.
- `ALSO_ADDED` is empty and asserted at the seeded-fixture depth only. The *default*-shape depth
  (`sync-coverage`'s domain) was not surveyed for added paths; I would expect real hits there, since
  recompose filling defaults is exactly what happens to an empty blob. Not a bug — but if anyone
  folds the two checks together, expect to populate `ALSO_ADDED` at that point.

---

## Pass 7 — 2026-09-07 (overnight), agent: Full Stack

Numbering: NIGHT-NOTES already had a Pass 6 section when I picked it up, so I am Pass 7 — the
same drift the last three agents hit. I did not redo Pass 6.

Deliberate change of direction. Passes 3–6 were all sync-test plumbing, and the remaining leads
in that area were tidiness (fold `sync-coverage` into `plugin-seeds`) rather than risk. I spent
one item closing Pass 6's open survey question, then went looking in **product code**, which no
pass since 2 had touched. That is where the bug was.

### Baseline (measured, both ends)
- **Before:** backend **17/17**, UI **26/26** — exactly Pass 6's closing numbers. Nothing rotted.
- **After:** backend **18/18** (the new check below), UI **26/26**.

### Answered: Pass 6's added-path prediction was wrong, and that is useful
Pass 6 asserted the added-path survey at the *default*-shape depth (`sync-coverage`'s domain)
would produce "real hits there, since recompose filling defaults is exactly what happens to an
empty blob", and left it as the reason not to fold the checks together. I ran it — a throwaway
script outside the suite, deleted after:

```
gym: added 0   work: added 0   sleep: added 0   canvas: added 0   course: added 0
ladder: added 0   calendar: added 0   email: added 0
```

**Zero on all 8, at the default depth too.** So `ALSO_ADDED` would stay empty through a fold, and
the stated blocker on merging `sync-coverage` into `plugin-seeds.mjs` does not exist. I did not do
the fold — it is cosmetic and I had a real bug to chase — but the next pass can stop treating it as
risky. Recording the measurement so nobody re-derives the prediction as fact.

### Bug found and fixed: every request body could silently corrupt user text
`lib/runner.js:83` and `services/outbox.js:77` both read request bodies as `body += chunk`.

Node hands an HTTP body over as a sequence of Buffers whose boundaries follow **TCP segments, not
character boundaries**. `body += chunk` decodes each chunk independently, so a multi-byte UTF-8
character straddling two chunks decodes as two U+FFFD replacement characters.

**Reproduced, not assumed.** A body split inside an `é`, written as two TCP segments:

```
CURRENT (body += c):      chunks=2  parseErr=none  note="ok-��🏋️-end"   correct=false
FIXED   (Buffer.concat):  chunks=2  parseErr=none  note="ok-é🏋️-end"              correct=true
```

Then confirmed end-to-end through the **real** `serveHttp`, not a copy of it: handler received
`{"note":"before-é-🏋️-after"}` intact after the fix.

Why this matters more than it looks:
- **The failure is silent.** `parseErr=none` — the JSON stays well-formed. Nothing throws, nothing
  logs. The mojibake is simply what gets stored.
- **It is a write path.** `serveHttp` carries every `<plugin>.save`, so the corrupted text goes to
  Postgres *and* is broadcast to the user's other sessions via the `sync.update` deliver. There is
  no un-corrupted copy left anywhere afterwards.
- **The payloads are arbitrary user text** — gym notes, work shift notes, finance vendor rules —
  and a full plugin state routinely exceeds one socket read.
- **The codebase already knew the right shape.** `uiapi/notes.js:55` and `uiapi/plaid.js:23` both
  do `Buffer.concat(chunks).toString('utf8')` correctly. These two sites were simply never updated
  to match. Fix makes them consistent with the two that were already right.

`services/gate.js:146` has the same `body += c` shape and I **deliberately left it**: its body is a
form-encoded SSH signature block, which is pure ASCII, so no multi-byte character can straddle
anything. Touching an auth path for a bug that cannot occur there is the worse trade. Noted here so
the next pass sees it was considered rather than missed.

### New: `atlas-backend/test/body-utf8.check.mjs`
Drives the real `lib/runner.js` `serveHttp` over a raw socket, writing the body in two segments
split inside a two-byte character.

**The deliberate split is the entire point, and it is why an obvious version of this test would
pass against broken code.** Measured first: the same payload sent with an ordinary `fetch()`
round-trips **fine** at every size I tried (65530–65535 byte bodies, emoji at the boundary) —
Node coalesced it into one chunk each time. A test that just POSTs a big string with emoji in it
is a test that always passes. Only a hand-written two-segment write with a delay between them
reaches the bug. That is recorded in the file's header so nobody "simplifies" it back to a fetch.

Two things in it are load-bearing and cost me real time to find:
- **A `net.Socket` stays paused until something reads it**, and a socket nobody reads never reaches
  `'end'` or `'close'`. My first version registered no `'data'` handler and simply hung — no output,
  no failure, just a stalled process I had to kill by PID. There is now a `s.on('data', () => {})`
  with a comment saying why, plus a 5s watchdog on the promise: a check that hangs is worse than one
  that fails, because it stalls the suite silently.
- **The port is probed, not hard-coded.** `serveHttp` returns nothing, so a caller can neither close
  the server nor learn its port. With a fixed port, any leftover run makes the next one die with
  `EADDRINUSE` — which is an infrastructure error dressed up as a test result. It now binds :0,
  reads the assigned port, closes, and hands that to `serveHttp`.

### Negative control (run, restored, `cmp`-confirmed byte-identical)
Reverted `lib/runner.js` to `body += c`:
```
FAIL body-utf8: a body split mid-character was corrupted on the way in
       sent "before-é-🏋️-after"
       got  "before-��-🏋️-after"
       read the body as Buffers and decode once at end — not `body += chunk`
```
Restored from a copy taken before the edit; `cmp` confirms `lib/runner.js` byte-identical, and the
check is back to `ok`.

### Verified vs asserted
- **VERIFIED by running:** the corruption itself (two independent reproductions — a standalone
  two-segment socket write, and end-to-end through the real `serveHttp`); the fix; the negative
  control; the fetch-passes-anyway measurement that justifies the test's shape; the added-path
  survey's zeros; backend 17/17 → 18/18 and UI 26/26 at both ends.
- **ASSERTED, not verified:** that the `outbox.js` fix matters in production. The mechanism is
  identical to `runner.js`'s and I confirmed the file parses, but I did **not** build a
  reproduction against the outbox's own server — its `/deliver` body is produced by `runner.js`'s
  own `deliver()` via `fetch`, which is exactly the single-write path that my measurement showed
  does *not* split. So the outbox fix is correctness-by-consistency, not a demonstrated live bug.
  Treat `runner.js` as the real find and `outbox.js` as hardening.
- Also still standing from Pass 2: the `ALTER TABLE ladder.settings` statements have never run
  against a real Postgres — still none on this Mac (`pg_isready` fails).
- **No UI build, and none needed.** `git status` confirms this pass touched only `atlas-backend/`
  (`lib/runner.js`, `services/outbox.js`, and the new test). Nothing under `atlas-ui/src` changed,
  so I never took `/tmp/mac-build.lock` and blocked nobody.

### What Chancellor should overturn if he disagrees
- **Fixing `outbox.js` without a demonstrated reproduction.** By my own "verify by measuring" rule
  this is the weakest thing I did tonight — I changed product code on a mechanism argument. I did
  it because the change is three lines, strictly safer than what it replaces, and leaving one of two
  identical bugs fixed invites someone to conclude the pattern is fine. If you would rather product
  code only ever move on a reproduction, revert that hunk; `runner.js` stands on its own.
- **Leaving `gate.js` alone.** Defensible either way. My reasoning is above; the counter-argument is
  that "this body is always ASCII" is an assumption that outlives the person who checked it.

### Leads (found, deliberately NOT fixed)
- **`serveHttp` has no body cap.** `notes.js` and `plaid.js` both cap theirs, and `plaid.js`'s
  comment explicitly calls an uncapped reader "an unbounded-memory POST sink once the handler is
  reachable over a network". `serveHttp` is the one that carries every plugin save and it has no
  cap at all. It is inbox-routed and internal today, so I did not want to introduce a rejection
  path at 2am without knowing the real ceiling of a legitimate plugin state — **that number is a
  product question**, and picking it wrong silently breaks saves for the heaviest users. This is
  the highest-value item left, and it needs Chancellor's number, not an agent's guess.
- **`sync.update` broadcasts `payload.value`, the client-submitted blob, not what was stored.**
  So a field the mapper drops still reaches the user's *other* sessions and lives there until
  reload — the sync-drop bug class this whole suite exists to catch is invisible from the other
  end. Whether that is a bug depends on intent (it is also the reason a save feels instant
  everywhere), so I left it. Worth one deliberate decision rather than a silent divergence.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication,
  and per the survey above, no longer blocked. Cosmetic.
- `uiapi/app.js:39` octet-stream: Pass 6 asked for this to be **struck from the file** rather than
  re-listed a seventh time, since it is a documented deliberate choice and not an open item. I
  agree and am also not editing another agent's note. Chancellor: delete it.

---

## Pass 8 — 2026-09-07 (overnight), agent: Full Stack

Continued Pass 7's direction rather than the sync-test plumbing: product code is where the
bugs are. Both finds this pass are in `services/` and neither is reachable from any existing
test. Nothing from earlier passes was redone or reverted.

### Baseline (measured, both ends)
- **Before:** backend **18/18**, UI **26/26** — exactly Pass 7's closing numbers. Nothing rotted.
- **After:** backend **20/20** (two new checks), UI **26/26**.

### Bug 1: signup and login disagreed about email case, so one address could become two accounts

`services/auth.js` — `login()` has always matched `WHERE lower(email) = lower($1)`. `signup()`
stored the address **exactly as typed**, under `auth.users.email text UNIQUE`.

Postgres `UNIQUE` compares raw text. So `alex@example.com` and `alex@example.com` are two
distinct rows, both inserted without a `23505` — and then a single login query matches **both**:

```sql
SELECT id, email, password_hash FROM auth.users WHERE lower(email) = lower($1)
```

with no `ORDER BY`. `r.rows[0]` is then whichever row Postgres returned first — physical row
order, which is not stable across `UPDATE`/`VACUUM`/replica. `bcrypt.compareSync` runs against
that row's hash, so the *other* user's correct password answers `Invalid email or password`,
and which of the two is locked out can change over time with no code deploy.

Reachable from the real UI: `main.js:237` is `form.email.value.trim()` — it trims and does not
fold case, so the casing a user types is the casing that reaches `signup()`.

**Fix**, in three parts, all needed:
- New `lib/email.js` exporting `normalizeEmail` — the single place an address is folded. Both
  halves of auth now call it, so they cannot drift apart again.
- `signup()` stores the folded address, and additionally pre-checks `lower(email)`. The
  `UNIQUE` constraint alone is not enough: it cannot see a **legacy mixed-case row** written
  before this normalization existed, so without the pre-check the duplicate pair is still
  creatable today against an existing account.
- `login()`'s lookup gained `ORDER BY created_at, id`. This is not cosmetic — it is what makes
  an *already-existing* duplicate pair behave deterministically (oldest account wins) instead of
  flipping. The fix above stops new pairs; this one contains the ones that may already exist.

`normalizeEmail` is total (`String(v ?? '')`), because `payload.email` comes off the wire and a
throw there would be a 500 with a stack in the log instead of the `Enter a valid email address`
reply the caller expects.

### Bug 2: `google.api` was an open, token-bearing forwarder

`services/google.js` `googleApi()` took `payload.url` from the client and fetched it with
`Authorization: Bearer <the user's Google access token>`, returning the body via the outbox.
**The url was never validated.** Any signed-in Atlas user could point it at anything the backend
can reach and read the answer: `http://atlas-auth/handle`, `http://portainer:9000/api/…`,
`http://adminer/`, `http://169.254.169.254/…`, the home LAN — the service sits on
`stack_default` — or at an arbitrary external host, which also hands that host the bearer token.

This is the **identical hazard** `uiapi/canvas.js` already allowlists against, and whose own
comment names the stakes: *"unrestricted, this is an open HTTPS forwarder carrying a
caller-chosen Authorization header, and it sits on stack_default with reach to postgres,
adminer, portainer and the home LAN."* `uiapi.check.mjs` tests that guard. `google.api` had the
same shape, the same network position, a **more** sensitive header, and no guard at all.

**Fix:** new `services/google/apiurl.js` exporting `allowedApiUrl(url)`, called at the top of
`googleApi()` — before `accessTokenFor()`, deliberately, so a rejected target can never cause a
token refresh and never sees an Authorization header.

The allowlist was **grepped from the client, not guessed** — getting it wrong silently kills
Gmail and Calendar in the app, which is the expensive direction to be wrong in. `atlas-ui/src`
constructs exactly two: `https://gmail.googleapis.com/gmail/v1/users/me/…` (`email.js`) and
`https://www.googleapis.com/calendar/v3/…` (`calendar.js`). Both are host-equality **plus** a
path-prefix test, so an allowed host does not open its whole API surface — `www.googleapis.com`
also serves `/oauth2/v1/tokeninfo` and `/drive/v3/`, neither of which this app uses.
`GOOGLE_API_PREFIXES` (comma-separated) extends it without a code change.

The check compares the **parsed** `URL`'s host and pathname, never the raw string. Two things
that buys, both in the test:
- `https://gmail.googleapis.com@evil.test/gmail/v1/…` parses with host `evil.test`.
- `https://www.googleapis.com/calendar/v3/../../drive/v3/files` — `URL()` normalizes the dot
  segments before the prefix test sees them.

**Why the guard lives in its own file:** `google.js` calls `await applyDdl(ddl)` at module top
level, so it cannot be imported without a Postgres — and there is none on this Mac. Splitting it
out is the same `uiapi.js` / `uiapi/canvas.js` split that lets `uiapi.check.mjs` test
`allowedHost()` for real instead of scraping source.

### New: `test/google-apiurl.check.mjs`
Imports the real guard. Nine arms: the real client endpoints still pass (first arm, deliberately
— a failure there means the app is broken, not merely unguarded), internal/LAN/metadata/`file:`
targets, cleartext `http:` to an allowed host, lookalike hosts, userinfo disguise, other paths on
an allowed host, dot-segment escape, and junk input.

The last arm is the one worth keeping: **it asserts `googleApi()` actually calls the guard, and
calls it before `accessTokenFor()`.** Everything else tests a pure function, so without that arm,
deleting the single line that wires it in leaves the whole check green.

### New: `test/auth-email.check.mjs`
Unit-tests `normalizeEmail`, then asserts the two auth halves agree: signup normalizes, login
normalizes, signup has a case-insensitive duplicate check, and login's lookup has an `ORDER BY`.

**It is a source-reading check, and that is a real limitation worth stating plainly.** `auth.js`
also runs `applyDdl()` at top level and there is still no Postgres here (`pg_isready` fails —
standing since Pass 2), so signup/login cannot be executed. Precedent: `ddl-columns.check.mjs`
reads source for the same reason. I did **not** split auth.js the way I split google.js — the
google guard was new code I was writing anyway, whereas restructuring a working auth path at 3am
to make it importable is a bigger change than the bug warrants. Noted as the obvious follow-up if
anyone wants this behavioral.

### Negative controls (all run, all files restored and `cmp`-confirmed byte-identical)
- **NC1 — auth, whole fix reverted** (`services/auth.js` back to its original): 4 of 7 arms fail,
  the three that don't being the `normalizeEmail` unit tests and the client-half assertion.
  ```
  FAIL signup normalizes the address it stores - signup() does not call normalizeEmail — a raw-cased
       address would be stored under UNIQUE(email) while login matches lower(email)
  FAIL login normalizes before matching - login() does not call normalizeEmail
  FAIL signup rejects a case-variant of an existing address - signup() has no case-insensitive duplicate check
  FAIL the login lookup is deterministic - login() selects users without ORDER BY — with a pre-existing
       duplicate pair this picks a row by physical order
  ```
- **NC2 — google, guard call deleted** from `googleApi()` (the pure function left intact):
  ```
  FAIL googleApi calls the guard before it fetches a token - googleApi() does not call allowedApiUrl
       — the url is forwarded unvalidated
  ```
- **NC3 — google, guard downgraded to a raw-string `startsWith`** (no `URL()` parse):
  ```
  FAIL dot-segments cannot walk out of the allowed prefix
  ```
  Worth recording honestly: NC3 did **not** trip the userinfo arm, because
  `https://gmail.googleapis.com@evil.test/…` does not literally start with
  `https://gmail.googleapis.com/` (`@` vs `/`). That arm is defence-in-depth against a *different*
  wrong implementation, not against this one. The dot-segment arm is the one that discriminates.

### Verified vs asserted
- **VERIFIED by running:** every negative control above and the byte-identical restores; both new
  checks green; backend 18/18 → 20/20 and UI 26/26 at both ends; that `main.js:237` only trims;
  that the two allowlisted prefixes are the only `googleapis.com` URLs `atlas-ui/src` constructs.
- **ASSERTED, not verified:** the auth fix's *runtime* behaviour. There is no Postgres here, so I
  have not executed a duplicate signup, nor observed the unordered `SELECT` return rows in two
  different orders. The bug is read off the SQL and the `UNIQUE` semantics, both of which are
  unambiguous, but by this file's own standard that is reasoning, not measurement. Same for the
  google fix's effect in production: the guard is tested directly and thoroughly, but I did not
  stand up the service and issue a `google.api` call through it.
- Still standing from Pass 2: the `ALTER TABLE ladder.settings` statements have never run against
  a real Postgres.
- **No UI build, and none needed.** `git status` confirms this pass touched only `atlas-backend/`.
  I never took `/tmp/mac-build.lock` and blocked nobody.

### False alarm, recorded so nobody re-chases it
`grep` reports `atlas-ui/src/page/email.js` as a **binary file** and `file` calls it `data`: it
contains raw NUL bytes on 457 lines. This is **not** corruption. A NUL is used deliberately as a
composite-key separator — `pinKey` joins the account address and the id with one, written as the
JS escape `\u0000` inside a template literal. The file parses clean under `node --check`, and the
blob at `HEAD` is byte-identical, so it is committed that way. Given Pass 7 found a genuine UTF-8
corruption in the body reader, this looks exactly like a second one and is worth two minutes of
not investigating again. The practical cost is that plain `grep` skips the file; `grep -a` works.

Those NULs are also why appending this section with a shell heredoc truncated three times: pasting
the character into a heredoc ends it. Add to NIGHT-NOTES with a script, and refer to the byte by
name or by its `\u0000` escape rather than pasting it.

### What Chancellor should overturn if he disagrees
- **The `google.api` allowlist is a new rejection path on a working feature.** This is the one to
  scrutinize. If the client ever calls a Google endpoint I did not find in `atlas-ui/src` — from
  the Swift shell, say, or a branch not in tree — that call now fails with
  `google.api: target not allowed` where it used to work. I checked the tree and the native app
  routes through the same `sync.request`, but a prefix list is only as good as its survey. It is
  extendable at runtime via `GOOGLE_API_PREFIXES` without a code change, which is why I was
  willing to make it strict; loosen to host-only (drop the path-prefix test) if it proves annoying.
- **Lowercasing the stored email changes what the app displays.** `main.js` shows
  `data.email || email`, so an existing user who signed up as `Chancellor@...` keeps their stored
  casing (I did not migrate existing rows), but new signups display folded. If displayed casing
  matters, store a separate `display_email` — I judged that not worth a column.
- **`ORDER BY created_at, id` picks the OLDEST duplicate account.** If a pair exists in production
  today, this decides which one wins, and I picked oldest without being able to look at the data.
  Newest-wins is equally defensible. Worth an actual query before anyone relies on it:
  `SELECT lower(email), count(*) FROM auth.users GROUP BY 1 HAVING count(*) > 1;`
- **I did not add `CREATE UNIQUE INDEX ON auth.users (lower(email))`**, which is the airtight
  version of Bug 1's fix. Deliberate: if duplicates already exist, that index **fails to build**,
  and `applyDdl` treats a persistent failure as `process.exit(1)` — the auth service would
  crash-loop and lock everyone out of the app. Run the query above first; if it returns nothing,
  the index is the right permanent fix and the application-level pre-check becomes belt and braces.

### Leads (found, deliberately NOT fixed)
- **`serveHttp` still has no body cap.** Pass 7 called this the highest-value item left and it
  needs Chancellor's number for the legitimate ceiling of a plugin state. Still true, still his
  call, still the top of this list.
- **`sync.update` still broadcasts the client-submitted blob, not what was stored** (Pass 7).
  Unchanged and still one deliberate decision away from resolution.
- **`services/gate.js:146` still uses `body += c`** — Pass 7 left it deliberately (ASCII-only SSH
  signature body) and documented why. I agree and am not re-opening it; noting only that it is now
  the *last* instance of that pattern in the tree, so a future "make them all consistent" sweep
  should read Pass 7's reasoning first rather than treating it as an oversight.
- **`auth.js` and `google.js` both `await applyDdl()` at module top level**, which is what makes
  them unimportable without a Postgres, and is why this pass produced one behavioral check and one
  source-reading one. An `if (import.meta.url === ...) bootstrap()` guard, as `uiapi.js` already
  uses, would make both services importable and turn `auth-email.check.mjs` into a real behavioral
  test against a stub pool. That is the highest-leverage refactor left in the backend test story.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication,
  still unblocked per Pass 7's survey, still cosmetic.

---

## Pass 9 — 2026-09-07 (overnight), agent: Full Stack

Numbering: NIGHT-NOTES already had a Pass 8 section when I picked it up, so I am Pass 9 — the
same drift the last four agents hit. I did not redo Pass 8.

Took Pass 8's own "highest-leverage refactor left in the backend test story": `auth.js` and
`google.js` both `await applyDdl()` at module top level, which made them unimportable without a
Postgres and forced Pass 8 to write a source-reading check. Closing that turned out to be worth
more than the refactor itself — making `google.js` importable is what let me *execute* the
refresh path, and executing it is how I found a real bug that no amount of source reading would
have shown.

### Baseline (measured, both ends)
- **Before:** backend **20/20**, UI **26/26** — exactly Pass 8's closing numbers. Nothing rotted.
- **After:** backend **21/21** (one new check), UI **26/26**.

### Closed: both services are now importable, and neither starts anything on import

`await applyDdl(ddl)` at module scope opens a real connection and retries for two minutes before
`process.exit(1)`. Both files now put the bootstrap behind an entrypoint guard and export their
functions (`signup`/`login`/`logout`/`whoami`/`handle`; `refreshToken`/`accessTokenFor`/
`googleApi`/`handle`).

Verified in **both** directions, because only checking one is how you ship a service that no
longer starts:
- `import()` of each file returns in ~80ms having done no I/O at all (`lib/db.js`'s `pg.Pool` is
  lazy — it connects on first query, not on construction).
- `node services/auth.js` and `node services/google.js` still reach `applyDdl` and print
  `ddl retry:` against the absent local Postgres, i.e. the guard fires.

### Bug found and fixed: one failed Google refresh bricked that account until a container restart

`services/google.js` `refreshToken()` de-duplicates concurrent refreshes through a module-level
`refreshing` Map, and cleaned the entry up from a `finally` **inside** the async body:

```js
refreshing.set(key, (async () => {
  try {
    if (!row.refresh_token) throw authErr('Not connected to Google.')
    ...await tokenPost...
  } finally { refreshing.delete(key) }
})())
```

That first line throws with **no await in front of it**. An async function runs synchronously up
to its first `await`, so on that one path the entire body — `finally` included — completed
*before* `refreshing.set()` was ever reached. The `delete` hit a key that did not exist yet; the
`set` then parked the already-rejected promise in the map, where nothing would remove it.

**Reproduced before fixing**, with a reduction of the exact shape:

```
call1: auth: Not connected to Google.
map still holds the key after the failure? true
call2 after reconnect: STILL FAILS -> auth: Not connected to Google.
call3: STILL FAILS -> auth: Not connected to Google.
with an await first, map retains key? false          <- the contrast that explains it
```

Consequence in production: one refresh attempt on an account whose row has no `refresh_token`
poisons that `(userId, address)` key for the life of the process. Every later Gmail or Calendar
call for that account replays `auth: Not connected to Google.` straight out of the cache without
touching Google or the database — **including after the user does the exact thing the message
tells them to do and reconnects.** Only restarting the container cleared it.

Reachable: `exchange()` writes `refresh_token = t.refresh_token || prev?.refresh_token || null`,
and Google only returns a refresh token on *first* consent. An account that re-consents without a
fresh grant and has no usable prior row lands on `null`.

Why it hid: every *other* failure path in that function has an `await` ahead of it and therefore
cleaned up correctly. The bug lives on the single synchronous-throw path.

**Fix:** create the promise, `set` it, then chain cleanup with `.finally()` — a `.finally()`
callback is always a microtask and can never run before the `set`. Guarded with an identity test
(`refreshing.get(key) === p`) in case a later refresh has already replaced ours, and the derived
promise is `.catch()`-ed so the cleanup chain cannot raise an unhandled rejection.

### `auth-email.check.mjs`: source-reading -> behavioral (13 arms)

Pass 8 wrote it as a source-reading check and said plainly that this was a limitation forced by
the import barrier. With the barrier gone it now **executes** the real `signup`/`login`/
`logout`/`whoami`/`handle` against a model of the two tables auth owns.

**Two modelling decisions are load-bearing**, and both are documented at the model:
1. `UNIQUE(email)` compares **raw text** — the model raises `23505` only on an exact-text
   collision, never on a case variant. That is exactly why `signup()` needs its own
   `lower(email)` pre-check and why the constraint alone was never enough.
2. A `SELECT` with **no `ORDER BY`** returns matching rows in **reverse** insertion order.
   Postgres guarantees no order there at all; reverse is the cheapest faithful stand-in for "row
   order moved under you after an UPDATE or VACUUM". With `ORDER BY created_at, id` the model
   sorts.

Any SQL the model does not recognise is a hard throw, not a silent `{rows:[]}` — otherwise a
future edit to `auth.js` could route around the model and every arm would still print `ok`.

New coverage this buys beyond Pass 8's source arms: the wrong-password and unknown-address
replies are asserted **identical** (an account-enumeration oracle would be a real finding), a
rejected signup is asserted to write no row, the session minted by signup is resolved through
`whoami` and then revoked by `logout`, `handle()` routes all four codes and returns
`unhandled code` for anything else, and a thrown database error becomes an `ok:false` reply
carrying its `reqId` rather than a 500 with a stack.

**A negative control caught my own model lying, and this is the part worth reading.** NC2 below
should have failed two arms and failed only one. Cause: my model wrote
`u.email.toLowerCase() === String(params[0]).toLowerCase()`, but the real SQL is
`lower(email) = $1` — **only the column is folded, never the parameter**. Lowercasing `params[0]`
quietly did `signup()`'s normalization *for* it, making the pre-check look correct against a
raw-cased caller. Fixed, documented at the line, and NC2 then failed both arms as it should. This
is the general hazard of hand-written database models and it is why every arm here is
negative-controlled rather than trusted because it is green.

### New: `atlas-backend/test/google-refresh.check.mjs` (9 arms)

Executes the real `google.js` against a model of `google.tokens` plus a `globalThis.fetch`
recorder. Both are deliberately loud — an unrecognised query or an unstubbed fetch throws.

Arm 1 is the bug, and its shape matters: it fails a refresh **first** and then requires the next
one to *succeed*. A test that only asserted the error message passes against the broken code.
The other arms hold the behaviour the map exists for and the behaviour around it: three
concurrent refreshes still make exactly one token call; a successful refresh is not cached
either; `invalid_grant` drops only that account and leaves siblings alone and the key reusable; a
transient refusal is **not** reported as an auth failure (doing so logs a user out of a working
connection) and keeps the row; a token good for ten more minutes is reused while one inside the
60s skew window is refreshed and written back; and a 401 forces exactly one refresh-and-retry
with the *new* token before surfacing as an auth error rather than looping.

Two arms also give `google-apiurl.check.mjs`'s guard a behavioral counterpart: a disallowed
target is refused with **zero** network calls and **zero** database queries (which is the real
content of "the guard runs before `accessTokenFor`"), and — the complement that stops a
refuse-everything guard from passing — an allowed Gmail URL is forwarded with `Bearer <token>`.

### Negative controls (all run; every file restored and `cmp`-confirmed byte-identical)

- **NC1 — the real bug.** Spliced the original `refreshToken` body (in-body `finally`) back in:
  arm 1 fails, and the failure then **cascades to six later arms** because they share the key.
  That cascade is not test noise — it *is* the production symptom, one poisoned key for the life
  of the process.
- **NC2 — auth, signup back to a raw `.trim()`**: 2 arms fail (after the model fix above; 1
  before it, which is how the model's infidelity surfaced).
- **NC3 — auth, `ORDER BY` removed from login's lookup**: the pre-existing-duplicate-pair arm
  fails — the oldest account cannot sign in with its own correct password.
- **NC4 — auth, signup's `lower(email)` pre-check removed**: the legacy-mixed-case-row arm fails.
- **NC5 — google, cleanup chain deleted entirely**: 7 arms fail (entry never released).
- **NC6 — google, `allowedApiUrl` call deleted from `googleApi`**: the refusal arm fails on
  `http://atlas-auth/handle`.

### Verified vs asserted

- **VERIFIED by running:** the refresh-map poisoning (standalone reduction, then through the real
  `refreshToken`); the fix; both services importing with no I/O *and* still booting as
  entrypoints; all six negative controls with byte-identical restores; backend 20/20 → 21/21 and
  UI 26/26 at both ends.
- **ASSERTED, not verified — and one of these is a correction to my own claim.** The guard uses
  `realpathSync` before comparing, on the reasoning that Node resolves symlinks when it builds
  `import.meta.url` while `path.resolve` does not, so a symlinked WORKDIR would make the guard
  silently never fire — a service that exits 0 having started nothing. **I tried to demonstrate
  that and could not.** Running through a symlinked directory, the *unhardened* guard fired
  anyway, because the shell's `cd` plus Node's `process.cwd()` already yield the physical path on
  this platform. So the hardening defends a case I was unable to construct. I kept it because it
  is strictly safe (realpath of a non-symlink is identity, and it falls back on throw), but it is
  belt-and-braces on an unproven need, not a demonstrated fix. Do not read it as measured.
- **ASSERTED:** the poisoning bug's frequency in production. The mechanism and reachability are
  measured; how often a real account lands on a null `refresh_token` is not something I can see
  from here. If Gmail/Calendar has ever "stayed disconnected until the stack was restarted", this
  is very likely why.
- Still standing from Pass 2: the `ALTER TABLE ladder.settings` statements have never run against
  a real Postgres — still none on this Mac (`pg_isready` fails).
- **No UI build, and none needed.** `git status` confirms this pass touched only
  `atlas-backend/` (`services/auth.js`, `services/google.js`, `test/auth-email.check.mjs`, and
  the new `test/google-refresh.check.mjs`). Nothing under `atlas-ui/src` changed, so I never took
  `/tmp/mac-build.lock` and blocked nobody.

### What Chancellor should overturn if he disagrees

- **The entrypoint guards are the highest-risk thing here, by a distance.** Everything else this
  pass added is a test. These two lines decide whether two production services start at all. I
  verified both boot, but they boot *here*, against no Postgres, killed after four seconds — not
  in the container. If you want one sanity check on this pass before trusting it, `docker compose
  up atlas-auth atlas-google` and look for `auth service up` / `google service up` is the one.
- **`realpathSync` in the guard**, per the honest note above — defensible to drop as unproven
  complexity. Reverting it to a plain `path.resolve` comparison is a one-line change.
- **Hand-written database models in two checks now.** They are the only way to execute this code
  without a Postgres, and both are negative-controlled and throw on anything they do not
  recognise — but a model is code that can be wrong, and NC2 proved mine was. If you would rather
  have a real ephemeral Postgres in the test path, that is the better answer and it retires both
  models.
- **Converting `auth-email.check.mjs` in place** rather than adding a second file. The source
  assertions Pass 8 wrote are gone, replaced by behavioral ones that subsume them. If you want
  both lenses, Pass 8's version is in the history of this file.

### Leads (found, deliberately NOT fixed)

- **`serveHttp` still has no body cap.** Named the top item by Pass 7 and Pass 8. Still needs
  Chancellor's number for the legitimate ceiling of a plugin state, and is still his call. Third
  pass carrying it.
- **`sync.update` still broadcasts the client-submitted blob, not what was stored** (Pass 7).
  Unchanged, still one deliberate decision away.
- **`googleApi` forwards the client's `method` unvalidated** to an allowlisted URL. I looked at
  this and concluded it is *not* a finding: the token is the caller's own, so a `DELETE` they can
  issue through the proxy is one they could issue themselves. Recording the reasoning so the next
  pass does not re-derive it as a bug — but if the allowlist is ever loosened to host-only, this
  becomes worth revisiting, because the path prefix is currently doing the work of bounding it.
- **`profile.js`, `inbox.js`, `outbox.js` and `gate.js` are now the services with no behavioral
  test**, and the entrypoint-guard pattern above is exactly what makes one possible. `outbox.js`
  is the interesting one: Pass 7 changed its body reader on a mechanism argument without a
  reproduction and flagged that as the weakest thing it did. A guard plus a socket-level test
  would settle it either way. That is the cheapest real hour available next.
- `services/gate.js:146` still uses `body += c` — Pass 7's deliberate ASCII-only reasoning, which
  I have not re-opened.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication,
  still cosmetic, still unblocked per Pass 7's survey.
- `uiapi/app.js:39` octet-stream: Passes 6, 7 and 8 all asked for this to be **struck from the
  file** as a documented deliberate choice rather than re-listed. I am not editing another
  agent's note either. Chancellor: delete it.

---

## Pass 10 — 2026-09-07 (overnight), agent: Full Stack

Numbering: NIGHT-NOTES already had a Pass 9 section when I picked it up, so I am Pass 10 — the
same drift the last five agents hit. I did not redo Pass 9.

Took Pass 9's named "cheapest real hour available next": `profile.js`, `inbox.js`, `outbox.js`
and `gate.js` are the services with no behavioral test, and the entrypoint-guard pattern is what
makes one possible. I did the inbox. As with Pass 9, closing the import barrier was worth more
than the refactor itself — making `inbox.js` importable is what let me *execute* the
logout-then-keep-using-it sequence, and executing it is how I found a real authorization bug that
reading the file did not show me (I had read it twice first).

### Baseline (measured, both ends)
- **Before:** backend **21/21**, UI **26/26** — exactly Pass 9's closing numbers. Nothing rotted.
- **After:** backend **22/22** (one new check), UI **26/26**.

Command note for the next agent: a bare `node --test` in `atlas-backend` reports **23**, not 21 —
it picks up files the documented glob deliberately excludes. Use the exact command in the
"Environment facts" section at the top of this file. I lost a few minutes to this.

### Closed: `inbox.js` is importable, and importing it starts nothing

`server.listen(80)` and the 30s heartbeat `setInterval` both ran at module scope, so importing
this file bound a port (or failed) and left an un-`unref`'d timer holding the importing process
open forever. Both now sit behind the same entrypoint guard Pass 9 gave `auth.js` and
`google.js`, and the per-connection handler is exported as `onConnection(ws, req)`.

Verified in **both** directions, because only checking one is how you ship a service that no
longer starts:
- `import()` returns in **68ms** and the process **exits on its own** (`exports: onConnection`) —
  no listen, no surviving timer.
- `node services/inbox.js` still prints **`inbox up on :80`**, i.e. the guard fires.

### Bug found and fixed: logging out did not log the socket out

`auth.logout` deletes the session row. The inbox relayed the reply to the client and **left the
socket's own auth state alone**. But plugin routing trusts `conn.userId` and **never re-reads
`auth.sessions`** — the token is checked exactly once, at hello. So the socket that had just
logged out kept full read and write access to the account for the rest of its lifetime.
Logout revoked the token everywhere except the one place it was actually being used.

**Reproduced before fixing**, driving the real `onConnection`:

```
1. hello           -> {"type":"hello","ok":true,"userId":"u1","email":"a@b.c"}
2. finance.save    -> routed: http://atlas-finance/handle finance.save
3. auth.logout     -> {"reqId":2,"ok":true,"data":{}} | session row still there? false
4. finance.save AFTER LOGOUT -> routed to the plugin? true      <-- BUG
```

After the fix, step 4 is `{"reqId":3,"ok":false,"error":"not authenticated"}` and nothing leaves
the box.

**Why it hid:** `main.js`'s `atlasLogout` does `location.reload()` immediately after, which drops
the socket. The well-behaved browser closes the connection for the server. That is the client
*choosing* to — a stolen token driving its own socket does not, and logout is the victim's only
remedy against exactly that.

**Fix:** in the auth relay, `body.ok && code === 'auth.logout'` clears `conn.userId`, `conn.email`
and `conn.token`. Deliberately **not** `conn.hello` — the socket is still a valid unauthenticated
connection and the client re-uses it to log in again; clearing `hello` would strand it behind
`expected hello as first message`. That complement is arm 2 of the new check, and a failed logout
leaving auth intact is arm 3 (otherwise an auth service answering `ok:false` becomes a way to log
someone out of a working session).

### New: `atlas-backend/test/inbox-routing.check.mjs` (13 arms)

Executes the real `onConnection` against a fake socket, a model of `auth.sessions`, and a
`globalThis.fetch` recorder. Both models are deliberately loud — unrecognised SQL is a hard throw,
never a silent `{rows:[]}`, so a future edit cannot route around the model and stay green.

Arm 1 is the bug, and its shape matters: it asserts the plugin call after logout is **not routed**.
A test that only checked that logout replies `ok:true` passes against the broken code, because the
broken code *did* reply `ok:true`.

The other arms hold the handshake and authorization rules this service had no test for at all: a
plugin code before hello is refused; a bare hello does not authenticate and its plugin call never
leaves the box; `auth.signup` is public and its token authenticates the socket; an unregistered
code and a non-string `code` are both refused without routing; a non-object payload is refused
while an absent one is allowed; malformed JSON is refused *without* a reqId; a re-hello with a bad
token leaves existing auth intact (pinning inbox.js's own documented behaviour so it cannot
quietly become a downgrade); and an unreachable service and a non-2xx both become error replies
carrying the reqId rather than silence.

One arm is worth calling out separately: **the routed envelope must use the socket identity, not
the client's.** It sends `{reqId, code, userId:'VICTIM', sessionId:'OTHER', payload}` and asserts
the envelope reaching the plugin still carries `u9`/`s9`. If a client could ever name its own
userId there, every plugin code becomes an account-takeover primitive. The code is correct today;
NC3 exists to keep it that way.

Harness note: **each arm gets its own IP.** The inbox's limiters are module-level and keyed by IP,
so sharing one would let an early arm's socket churn or auth attempts throttle a later arm and
produce failures with nothing to do with the behaviour under test.

### Negative controls (all four run; every file restored and `cmp`-confirmed byte-identical)

- **NC1 — the real bug.** Removed the logout clear: `a revoked session cannot keep using its
  socket` fails on `a logged-out socket must not reach the plugin`. 13 → 12 arms.
- **NC2 — the `!conn.userId && !PUBLIC.has(code)` gate deleted**: 2 arms fail (arm 1 and `a bare
  hello does not authenticate`). 13 → 11.
- **NC3 — routed envelope changed to `msg.userId || conn.userId`**: `the routed envelope uses the
  socket identity` fails on `userId must come from the session`.
- **NC4 — a failed re-hello made to null `conn.userId`**: `a re-hello with a bad token leaves
  existing auth intact` fails.

### Verified vs asserted

- **VERIFIED by running:** the logout authorization bug (standalone reproduction through the real
  `onConnection`, before the fix); the fix; `inbox.js` importing in 68ms with the process exiting
  on its own *and* still printing `inbox up on :80` as an entrypoint; all 13 arms; all four
  negative controls with byte-identical restores; backend 21/21 → 22/22 and UI 26/26 at both ends.
- **ASSERTED:** that no deployed client depends on a socket staying authenticated across logout.
  `main.js` is the only caller of `auth.logout` in this repo and it reloads immediately, so it
  cannot notice. `atlas-apple/` was not audited for a second client — if one exists and re-uses
  the socket after logout without re-hello, arm 2's path (log in again on the same socket) is the
  one it needs, and it works.
- **ASSERTED:** the `realpathSync` in the new guard is copied verbatim from Pass 9's, including
  Pass 9's honest note that it defends a case they could not construct. I did not re-test it and
  it inherits their caveat exactly.
- **ASSERTED, and this is the real gap:** the **outbox has the same shape and I did not fix it.**
  `ws.userId` is set at hello and never revalidated, so a logged-out socket keeps *receiving*
  pushes for that account. It is strictly less severe — receive-only, no writes, and the outbox
  has no logout signal to react to, so fixing it means either a revocation broadcast or a periodic
  re-check. That is a design decision, not a patch, which is why it is a lead below and not a fix.
- Still standing from Pass 2: the `ALTER TABLE ladder.settings` statements have never run against
  a real Postgres — still none on this Mac.
- **No UI build, and none needed.** `git status` confirms this pass touched only
  `atlas-backend/services/inbox.js` and the new `atlas-backend/test/inbox-routing.check.mjs`.
  Nothing under `atlas-ui/src` changed, so I never took `/tmp/mac-build.lock` and blocked nobody.

### What Chancellor should overturn if he disagrees

- **The entrypoint guard is the highest-risk thing here, by a distance** — same as Pass 9's, for
  the same reason. Everything else this pass added is a test; this one line decides whether the
  inbox starts at all, and the inbox is the app's only public request surface. I verified it boots
  *here*, killed after three seconds — not in the container. If you want one sanity check on this
  pass before trusting it, `docker compose up atlas-inbox` and look for `inbox up on :80`.
- **Clearing auth on logout could be argued as a behaviour change rather than a fix**, if you hold
  that the socket is the session. I do not think that survives contact with the fact that the
  token is what logout revokes and the token is what opened the socket — but it is your call, and
  reverting it is deleting one `else if`.
- **A third hand-written database model** now (auth, google, inbox). Same trade Pass 9 named: a
  model is code that can be wrong. A real ephemeral Postgres in the test path retires all three
  and is the better answer if you want to spend the setup.

### Leads (found, deliberately NOT fixed)

- **The outbox keeps pushing to logged-out sockets** — new, per the assertion above. Needs a
  revocation signal or a periodic re-check; a design decision, so yours.
- **`serveHttp` still has no body cap.** Named the top item by Passes 7, 8 and 9. Still needs your
  number for the legitimate ceiling of a plugin state. Fourth pass carrying it — at this point the
  honest read is that it will never move without you naming a figure, so: **name one, even a
  rough one, and the next pass can implement it in an hour.**
- **`sync.update` still broadcasts the client-submitted blob, not what was stored** (Pass 7).
  Unchanged, still one deliberate decision away.
- **`profile.js`, `outbox.js` and `gate.js` remain the services with no behavioral test.** The
  inbox is done; `outbox.js` is now the interesting one for two reasons — Pass 7 changed its body
  reader on a mechanism argument without a reproduction, and it has the revocation gap above. Its
  `deliver()` is already a pure function of the registry, so it is the cheapest of the three.
- `services/gate.js:146` still uses `body += c` — Pass 7's deliberate ASCII-only reasoning, which
  I have not re-opened.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication,
  still cosmetic.
- `uiapi/app.js:39` octet-stream: Passes 6–9 all asked for this to be **struck from the file** as
  a documented deliberate choice rather than re-listed. Like Pass 9, I am not editing another
  agent's note. Chancellor: delete it. Five passes of noise now.

## Pass 11 — 2026-09-07 (overnight), agent: Full Stack

Numbering: NIGHT-NOTES already had a Pass 10 section when I picked it up, so I am Pass 11 — the
same drift the last six agents hit. I did not redo Pass 10.

Took Pass 10's named "cheapest real hour available next": `outbox.js` was the last interesting
service with no behavioral test, and Pass 10 gave two specific reasons to do it — Pass 7 changed
its body reader on a mechanism argument with no reproduction, and it has the revocation gap.
Both are now settled by measurement rather than reasoning. Neither needed new product code.

### Baseline (measured, both ends)
- **Before:** backend **22/22**, UI **26/26** — exactly Pass 10's closing numbers. Nothing rotted.
- **After:** backend **23/23** (one new check), UI **26/26**.

### Closed: `outbox.js` is importable, and importing it starts nothing

`server.listen(80)` and the 30s heartbeat `setInterval` both ran at module scope — the same
barrier Pass 9 removed from `auth.js`/`google.js` and Pass 10 from `inbox.js`. Both now sit behind
the identical entrypoint guard, and `deliver`, `httpHandler` and `onConnection` are exported.

Verified in **both** directions, because only checking one is how you ship a service that no
longer starts:
- `import()` returns in **147ms** and the process **exits on its own** (`exports:
  deliver,httpHandler,onConnection`) — no listen, no surviving timer.
- `node services/outbox.js` still prints **`outbox up on :80`**, i.e. the guard fires.

### SETTLED: Pass 7's weakest change was a real bug after all

Pass 7 changed `/deliver`'s reader from `body += chunk` to `Buffer.concat`, could not reproduce it
against the outbox's own server, and filed it honestly as "correctness-by-consistency, not a
demonstrated live bug — treat `runner.js` as the real find and `outbox.js` as hardening". Passes 9
and 10 both named a socket-level test as the thing that would settle it either way.

**It settles as a real bug.** Arm 1 of the new check drives a body split *inside* a two-byte
character through the real `httpHandler`, the real `deliver()` and out to a real registered socket.
With the fix reverted (NC1):

```
FAIL a /deliver body split mid-character survives intact - a body split mid-character was corrupted
       sent "before-é-🏋️-after"
       got  "before-��-🏋️-after"
```

So Pass 7's `outbox.js` hunk should be read as a fixed bug, not hardening. **Upgrade that entry
from ASSERTED to VERIFIED.** Note what the reproduction required: Pass 7 was right that an
ordinary `fetch()` coalesces the payload into one chunk and passes against broken code. Only a
hand-written two-segment write with a delay between them reaches it. That is recorded in the
file's header so nobody "simplifies" the arm back to a `fetch`.

Practical consequence, since `/deliver` is the fan-out path: the mojibake would have landed in the
`sync.update` pushed to the user's *other* devices — gym notes, work shift notes, finance vendor
rules — silently, as well-formed JSON, with nothing thrown and nothing logged.

### New: `atlas-backend/test/outbox-delivery.check.mjs` (13 arms)

Executes the real `onConnection` and `deliver` against a fake socket and a model of
`auth.sessions`. The model is deliberately loud — unrecognised SQL is a hard throw, never a silent
`{rows:[]}` — so a future edit cannot route around it and stay green. Each socket gets its own IP,
because the outbox's limiters are module-level and IP-keyed.

Beyond arm 1, the arms hold rules this service has always had and nothing checked. The one worth
calling out: **one user's `sync.update` never reaches another user's socket.** `registry` is keyed
by userId and every path reads it by key, so the code is correct today — but that is the worst
thing this service could get wrong and nothing was watching it. The rest: `excludeSession`
suppresses only the originating socket; a request result prefers the exact session and falls back
to the user's other sockets when none matches (safe — client reqIds are `crypto.randomUUID()`, so
they cannot collide across sessions, which I checked in `sync.js` rather than assuming); a result
for an unknown user is dropped rather than broadcast; an invalid token is refused, closed and never
registered; a socket that never helloed and one sending junk frames both receive nothing and stay
unauthenticated; a pre-auth frame flood is terminated; closing unregisters; and `/deliver` answers
`200 {}` even on a malformed body, which is a contract other services depend on (a non-200 would
make a plugin treat a delivered result as a failed one).

### A negative control caught my own arm lying — this is the part worth reading

NC4 (deleting `unregister` from the close path) **passed**. The "closing a socket unregisters it"
arm flipped `readyState` to CLOSED before emitting `close`, so `send()`'s own
`readyState === OPEN` guard suppressed the push and the arm went green while the registry leak it
exists to catch was completely invisible. The arm now leaves the socket OPEN, which is what makes
it about unregistration; documented at the arm. NC4 then failed as it should. Same lesson Pass 9
recorded about its database model: green is not evidence, the negative control is.

### Negative controls (all four run; every file restored and `cmp`-confirmed byte-identical)
- **NC1 — Pass 7's question.** Reader back to `body += c`: arm 1 fails with the mojibake above.
- **NC2 — cross-user isolation.** `deliver` made to read every socket in the registry instead of
  `registry.get(msg.userId)`: `FAIL one user's sync.update never reaches another user's socket -
  another account received a foreign sync.update`, plus the unknown-user arm. 2 failures.
- **NC3 — `excludeSession` test removed**: `FAIL excludeSession suppresses the originating socket
  only - the socket that caused the update was echoed back to`.
- **NC4 — `unregister` disabled** (after the arm fix above): `FAIL closing a socket unregisters it
  - a closed socket is still in the registry`.

### Pass 10's revocation gap: ASSERTED -> VERIFIED (still a lead, not a fix)

Pass 10 asserted the outbox has the inbox's logout bug in receive-only form. Measured it, with a
throwaway script outside the suite (deleted after), driving the real `onConnection`:

```
1. hello -> {"type":"hello","ok":true}
2. session row after logout?  false
3. push AFTER logout reached the socket? true {"type":"sync.update","key":"finance","value":{"balance":12345}}
```

So a revoked session keeps receiving the account's data — including finance values — for the life
of the socket. **I did not fix it, deliberately.** The inbox could fix its version in one line
because the logout reply passes through it; the outbox has no logout signal at all, so a fix means
either a revocation broadcast or periodic re-validation of every registered socket. That is a
design decision with a cost, not a patch, and it is Chancellor's. It is now measured rather than
argued, which is the part I could contribute at 5am. I deliberately did **not** add an arm
asserting the current behaviour — pinning a known gap as "correct" is how it becomes permanent.

### Considered and cleared, so nobody re-derives them
- **`ws.sessionId = msg.sessionId` is client-supplied and never validated.** It looks alarming.
  It is not a privilege boundary: `registry` is keyed by `userId`, which comes from the session
  row, so a forged sessionId can only reorder delivery *within the caller's own account*.
- **The rate-limited hello replies `ok:false` and does not close the socket**, unlike the
  invalid-token path which does. Checked the client: `sync.js:100` sets `outboxReady = !!msg.ok`,
  so it correctly does not believe it is connected, and the next `connect()` re-hellos on the same
  open socket (`sync.js:313`). Not closing is the better behaviour here — closing would push the
  client into a reconnect that burns the very limiter that just fired.

### Verified vs asserted
- **VERIFIED by running:** the `/deliver` corruption through the real handler (NC1), which settles
  Pass 7's open item; `outbox.js` importing in 147ms with the process exiting on its own *and*
  still printing `outbox up on :80` as an entrypoint; all 13 arms; all four negative controls with
  byte-identical restores; the post-logout push reaching a revoked socket; backend 22/22 -> 23/23
  and UI 26/26 at both ends.
- **ASSERTED:** the `realpathSync` in the new guard is copied verbatim from Pass 9's, including
  Pass 9's honest note that it defends a case they could not construct. I did not re-test it and it
  inherits their caveat exactly.
- Still standing from Pass 2: the `ALTER TABLE ladder.settings` statements have never run against a
  real Postgres — still none on this Mac.
- **No UI build, and none needed.** `git status` confirms this pass touched only
  `atlas-backend/services/outbox.js` and the new `atlas-backend/test/outbox-delivery.check.mjs`.
  The `atlas-ui/src` entries in `git status` are Pass 2's, build-verified by Pass 3 and untouched by
  me. I never took `/tmp/mac-build.lock` and blocked nobody.

### What Chancellor should overturn if he disagrees
- **The entrypoint guard is the highest-risk thing here, by a distance** — same as Passes 9 and 10,
  for the same reason. Everything else this pass added is a test; this one line decides whether the
  outbox starts at all, and with it dead every request result and every cross-device push silently
  stops arriving while the app still looks connected. I verified it boots *here*, killed after three
  seconds — not in the container. If you want one sanity check on this pass, `docker compose up
  atlas-outbox` and look for `outbox up on :80`.
- **A fourth hand-written database model** (auth, google, inbox, outbox). Same trade Passes 9 and 10
  named, and NC4 above is a fresh reminder that harness code can be wrong. A real ephemeral Postgres
  in the test path retires all four and is the better answer if you want to spend the setup. This is
  now the fourth pass making that argument; at four services it has stopped being a nice-to-have.

### Leads (found, deliberately NOT fixed)
- **The outbox keeps pushing to logged-out sockets — now measured, above.** Needs a revocation
  broadcast or periodic re-check. A design decision, so yours. It is the only known live
  authorization gap left in the backend.
- **`serveHttp` still has no body cap.** Named the top item by Passes 7, 8, 9 and 10. Fifth pass
  carrying it. Pass 10 asked you to name a rough figure so the next pass can implement it in an
  hour; repeating that ask is all any agent can do. Note that `/deliver` is uncapped too, though it
  is internal and unreachable through Caddy.
- **`sync.update` still broadcasts the client-submitted blob, not what was stored** (Pass 7). Now
  that the outbox has a test harness, the assertion would be cheap to write once you decide the
  intent — the harness is the part that was missing.
- **`profile.js` and `gate.js` are the last services with no behavioral test.** The inbox and outbox
  are done. `profile.js` is the cheaper of the two; `gate.js` is an auth path and should be treated
  with more care than a 3am pass usually allows.
- `services/gate.js:146` still uses `body += c` — Pass 7's deliberate ASCII-only reasoning. Worth
  re-reading now that the same pattern has been demonstrated to corrupt data in *two* places rather
  than one, but the ASCII argument is still sound and I did not re-open it.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication,
  still cosmetic.
- `uiapi/app.js:39` octet-stream: Passes 6–10 all asked for this to be **struck from the file** as a
  documented deliberate choice rather than re-listed. I am not editing another agent's note either.
  Chancellor: delete it. Six passes of noise now.

## Pass 12 — 2026-09-07 (overnight), agent: Full Stack

Continued Pass 11's list at its cheapest remaining item: **`profile.js` had no behavioral test**.
It is now the service with the most arms watching it, and `gate.js` is the last one with none.

- **Before:** backend 23/23, UI 26/26 (untouched — no UI file changed this pass).
- **After:** backend **24/24** (one new check, 17 arms).
- Touched exactly two files: `atlas-backend/services/profile.js` and the new
  `atlas-backend/test/profile-sync.check.mjs`. `git status` confirms it.

### Why profile.js was worth the pass ahead of gate.js

`sync.import` is a **replace, not a merge**: it deletes every board, flag and plugin state the
user has server-side and re-inserts only what the backup carries. A bug in it does not corrupt one
plugin — it removes data from every device on the account, and then `pull.all` fans the loss out.
That path had nothing checking it at all. `gate.js` is an auth path and, per Pass 11's own warning,
deserves more care than the end of an overnight pass.

### `profile.js` was unimportable — same fix shape as Pass 11

At module scope the file ran `await applyDdl(DDL)` and `serveHttp(...)`. Importing it therefore
blocked ~2 minutes retrying DDL against no database and then called `process.exit(1)`, taking the
test process with it. Put both behind the **same entrypoint guard Pass 11 gave inbox and outbox**
(copied verbatim, `realpathSync` and all), and extracted the `/handle` closure into an exported
`handle()` so the behaviour can be executed rather than only read. No logic inside it changed —
the body is the original, dedented.

Verified both directions: `node services/profile.js` still boots and prints `ddl retry:` (i.e. the
guard fires and `applyDdl` runs, killed after a few seconds — there is still no Postgres on this
Mac), and `import()` returns in **140ms** with the process **exiting on its own**
(`exports: handle,importAll,pageGet,pageSave,pullAll`).

### New: `atlas-backend/test/profile-sync.check.mjs` (17 arms)

Runs the real `handle()` against a model of `profile.page_boards` / `profile.user_flags` (loud —
unrecognised SQL is a hard throw) and a `fetch` stub standing in for the ten plugin services and
the outbox. Highlights:

- **A structured flag value is JSON, never `[object Object]`.** `pageSave`'s guard is the one place
  a single line would destroy data on every device; nothing was watching it.
- **`sync.update` fans out the *stored* value, not the submitted one** — which is exactly where
  those two differ. (Note this is the profile service only; Pass 7's open item about the *runner*
  broadcasting the client blob is untouched and still open.)
- **A backup cannot smuggle `atlas.auth.v1`, `atlas.backend` or `atlas.devMode` into storage.**
  `NEVER_STORE` mirrors the client's `NEVER_PUSH`; if it stopped matching, a foreign backup would
  push a session token or an attacker's backend URL to every device at the next pull.
- **Replace semantics in three arms**: absent plugins cleared, absent boards/flags cleared, and a
  *present but unparseable* key cleared rather than left as the previous account's stale state.
- **One user's import never touches another user's rows**, plus every plugin call carrying the
  right userId.

### A negative control caught my own arm lying — again

NC2 (making the import's board `DELETE` unscoped, i.e. a table-wide wipe) **initially passed the
isolation arm**. The model matched `DELETE FROM profile.page_boards WHERE user_id`, so an unscoped
delete fell through to the loud unmodelled-SQL throw; the import aborted, user B's rows survived
*because nothing ran*, and the arm read that as isolation working. The model now matches the bare
statement and honours the scope only when it is actually present — documented at the model. NC2
then failed on exactly the right arm. **Second pass running to find its own harness green over the
bug it exists to catch** (Pass 11's NC4 was the first). Treat a green arm as unproven until its
negative control has failed it.

### Negative controls (all five run; `profile.js` restored and `cmp`-confirmed byte-identical each time)
- **NC1 — `NEVER_STORE` filter removed:** `FAIL a backup cannot smuggle credentials or the backend
  URL into storage`.
- **NC2 — import's board DELETE not user-scoped:** `FAIL one user's import never touches another
  user's rows` (after the model fix above).
- **NC3 — `String(value)` instead of the JSON guard:** `FAIL a structured flag value is JSON, never
  [object Object] - flag persisted as [object Object]`.
- **NC4 — unreachable plugin rethrows instead of null+warning:** `FAIL an unreachable plugin becomes
  null + a warning, never a failed pull`.
- **NC5 — unparseable plugin key kept instead of cleared:** `FAIL a present but unparseable plugin
  key clears rather than keeps`.

### Considered and cleared, so nobody re-derives them
- **`importAll` clears the ten plugins outside the transaction, boards/flags inside it.** It looks
  like an atomicity bug. It cannot be fixed by moving code: the plugin states live behind HTTP in
  other services, so no single Postgres transaction can span them. A crash mid-import already
  leaves a partial restore whatever we do; making it atomic means a two-phase import, which is a
  design decision, not a patch. Not opened.
- **`pageGet` on an unknown non-`atlas.` key returns null rather than refusing** (unlike `pageSave`,
  which refuses). Asymmetric but harmless — a read of a key that can never have been written.

### Verified vs asserted
- **VERIFIED by running:** all 17 arms; all five negative controls, each with a byte-identical
  restore; `profile.js` importing in 140ms and exiting on its own; `node services/profile.js` still
  reaching `applyDdl` behind the new guard; backend 23/23 before -> **24/24** after.
- **ASSERTED:** the `realpathSync` in the guard is Pass 9's, copied through Pass 11 unchanged,
  including its honest note that it defends a case nobody could construct. Not re-tested here.
- Still standing from Pass 2: the `ALTER TABLE ladder.settings` statements have never run against a
  real Postgres — still none on this Mac. Everything above uses a hand-written model, so the DDL in
  `profile.js` is likewise unexecuted against a real server.
- **No UI build and none needed.** I never took `/tmp/mac-build.lock` and blocked nobody. (A lock
  dir belonging to another lane appeared during this pass; left untouched.)

### What Chancellor should overturn if he disagrees
- **The entrypoint guard on `profile.js`** — same single highest-risk line as Passes 9, 10 and 11,
  for the same reason. If it is wrong, the profile service starts nothing, and board layouts,
  flags, `sync.pull.all` and `sync.import` all silently stop working while the app still looks
  connected. One sanity check retires it: `docker compose up atlas-profile` and look for
  `profile service up`.
- **Exporting `pageGet`/`pageSave`/`pullAll`/`importAll`** widens the module's surface purely for
  testing. Only `handle` is strictly needed; the other four are exported so a future pass can test
  them directly. Say the word and they go back to module-private.
- **A fifth hand-written database model** (auth, google, inbox, outbox, profile). Fifth pass making
  the same argument: a real ephemeral Postgres in the test path retires all five, and NC2 above is
  fresh evidence that these models can be wrong in the direction that hides bugs.

### Leads (found, deliberately NOT fixed)
- **`gate.js` is now the only service with no behavioral test.** It is an auth path; give it a pass
  that starts early rather than the tail of one.
- **The outbox keeps pushing to logged-out sockets** (Pass 11 measured it). Still the only known
  live authorization gap in the backend. Needs a revocation broadcast or periodic re-validation —
  a design decision, so still yours.
- **`serveHttp` still has no body cap.** Sixth pass carrying it. Passes 7–11 all named it top item;
  it needs one number from you and then an hour. `sync.import` is the biggest body in the app, so
  whatever cap you pick must clear a full backup — `inbox.js` already uses 8 MiB for `maxPayload`,
  which is the obvious figure to reuse.
- **`sync.update` broadcasts the client-submitted blob in `runner.js`** (Pass 7) — the profile
  service does the right thing here and now has an arm proving it, so `runner.js` is the last
  offender and the arm above is the template for pinning it once you decide the intent.
- `services/gate.js:146` `body += c` — still Pass 7's deliberate ASCII-only reasoning, not re-opened.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication.
- `uiapi/app.js:39` octet-stream: Passes 6–11 asked for this to be **struck from the file**. Seven
  passes of noise. Chancellor: delete the line. I am not editing another agent's note either.

## Pass 13 — 2026-09-07 (overnight), agent: Full Stack

Took Pass 12's only named lead: **`gate.js` was the last service with no behavioral test.**
Passes 11 and 12 both deferred it as "an auth path, give it a pass that starts early" — this
pass started on it first rather than at the tail, as they asked. It has one, and while writing
it I found and fixed a **real, key-free injection on the most privileged origin in the system**.

- **Before:** backend 24/24, UI 26/26.
- **After:** backend **25/25** (one new check, 22 arms), UI **26/26** (untouched — no UI file changed).
- Touched exactly two files: `atlas-backend/services/gate.js` and the new
  `atlas-backend/test/gate-auth.check.mjs`. `git status` confirms it.

### The bug: the gate reflected attacker-chosen bytes into its own page unescaped

`gate.js:165` built its "wrong namespace" error as
``` `That signature was made for "${parsed.namespace}", not "${NAMESPACE}"` ```
and `page()` dropped that straight into `<p class="err">${err || ''}</p>`. `parsed.namespace` is
a field read out of the **pasted signature blob**.

The part that makes it serious: **reaching that message requires no key and no valid signature.**
`verifySignature` fails, and only then does the handler call `parseSignature` again purely to
produce a friendlier message — so the parse succeeds on a blob anyone can assemble (SSHSIG magic,
version 1, `ssh-ed25519`, a 64-byte signature field of any bytes) while verification has already
failed. Every trust check is behind you; the namespace still gets echoed.

Measured against the **real service**, booted from `services/gate.js` on 8099 with an empty
`authorized_keys`, driven by a throwaway probe (deleted after):

```
1. challenge status 200 nonce: tX91iPkzkfaxYSJ3cOvInsVF
2. verify status: 401
3. err element as served:     <p class="err">That signature was made for ""><script>pwn()</script>", not "atlas-gate" — check the -n flag.</p>
4. RAW <script> injected into gate page? true
```

Same probe against the fix:

```
3. err element as served:     <p class="err">That signature was made for &quot;&quot;&gt;&lt;script&gt;pwn()&lt;/script&gt;&quot;, not &quot;atlas-gate&quot; — check the -n flag.</p>
4. RAW <script> injected into gate page? false
```

**Why this one matters more than its shape suggests.** It is self-inflicted — you paste the
payload yourself — so it is a social-engineering bug, not a drive-by. But `/_gate/verify` is
handled *before* the cookie check, so an operator who is **already unlocked** and pastes a
"signature" someone sent them ("run this, paste the output") gets attacker script executing on
`console.myatlasapp.net`, in a browser holding the 24h gate cookie, same-origin with `/docker`,
`/db`, `/git` and `/shell`. Per `portainer-auth.js`'s own header, whatever reaches `/docker` has
full control of the Docker socket, which is root on the box. This is the shortest path from a
paste to root that exists in the app.

**Fix:** an `esc()` helper applied to every interpolation in `page()` — the error, the nonce in
both places, and `KEY_HINT`/`NAMESPACE` (env-derived; escaped because it is free, not because
they are hostile). Plus a `clamp()` at 80 chars on the reflected namespace, since the wire format
puts no bound on it and there is no reason to echo a megabyte of someone's paste back.

### `gate.js` was unimportable — same fix shape as Passes 11 and 12

`http.createServer(...)`, `server.listen(PORT)` and `startPortainerAuth()` all ran at module
scope, so importing the file bound 8099, bound 9002, and started trying to sign in to Portainer.
Both listeners now sit behind the **same entrypoint guard Pass 9 wrote and Passes 11/12 copied**,
and `handleRequest`/`handleUpgrade` are exported so the behaviour can be executed rather than
only read. No logic inside either handler changed — they are the originals, re-headed.

Verified both directions: `import()` returns in **42ms** with the process **exiting on its own**
(`exports: gateSecret,handleRequest,handleUpgrade`, exit 0), and `node services/gate.js` still
prints `gate up on 127.0.0.1:8099 for dev.myatlasapp.net, console.myatlasapp.net` plus
`portainer-auth on 127.0.0.1:19002` — i.e. the guard fires and Portainer auth still starts.

One judgement call: `gateSecret()` is exported so a test can mint a cookie the real `tokenValid`
accepts. It leaks nothing a test could not get by setting `GATE_SECRET` itself; it exists so the
arms do not have to depend on an env var being set a particular way.

### New: `atlas-backend/test/gate-auth.check.mjs` (22 arms)

Mounts the real `handleRequest`/`handleUpgrade` on an ephemeral port — deliberately **not** 8099,
so the file cannot collide with a gate actually running — and binds a stand-in dev server on 5173,
which is the port `UPSTREAM` really names rather than a stub of it.

**The signatures are real.** Keys come from `ssh-keygen -t ed25519` and signatures from the actual
`ssh-keygen -Y sign` binary. That is deliberate and the file says so: hand-rolling SSHSIG in the
test would share any construction mistake with `lib/sshsig.js`, and the happy path would then pass
for the wrong reason. (The one hand-rolled blob present exists solely to reach the parser with a
namespace no honest signer would emit — the injection arm.)

Arms hold rules the gate has always had and nothing checked. The ones worth calling out:
- **A valid signature by an untrusted key is refused** and mints no cookie — the whole point of
  the service, previously unwatched.
- **A challenge is one-shot**: a captured signature replayed against the same nonce is refused.
- **A trusted signature over a *different* nonce is refused** — signature/challenge binding, which
  is what stops a signature harvested from one session unlocking another.
- **A signature made for another namespace is refused** — cross-service replay.
- **An unlisted host is refused before anything else, on both the request and the upgrade path**,
  and the stand-in upstream records that it saw nothing. If either guard went, the gate becomes an
  open proxy for any DNS record pointed at it.
- **An unauthenticated websocket upgrade is dropped**, checked by asserting the upstream never saw
  it — the socket is the way straight past the gate if it is ever missed.
- Token arms: edited, expired, and signed-with-another-secret all refused; a valid cookie found
  among other cookies (`_ga=1; atlas_gate=…; other=2`), which is what a real browser sends.

### Two arms lied to me before the negative controls did

Worth recording, because this is now the **third consecutive pass** to catch its own harness green
over the thing it exists to catch (Pass 11's NC4, Pass 12's NC2).

1. **The unlisted-host upgrade arm was not testing the upgrade path at all.** It omitted
   `Connection: Upgrade`, so node dispatched it to the ordinary request handler and the arm was
   reading a `404 unknown host` from `handleRequest` while claiming the socket had been dropped.
   It reported a *failure* rather than a false pass, which is the only reason I looked. The helper
   is now host-aware and the header is documented at the call site as load-bearing.
2. **NC5 crashed instead of failing.** Removing the `!up` guard from `handleUpgrade` makes
   `net.connect(up.port, …)` throw on `undefined`, killing the process before any arm reports —
   so the control proved nothing. Re-ran as **NC5b** in the realistic bug shape (unlisted host
   falling through to a default upstream) and the arm failed correctly.

That crash is itself worth noting: **an uncaught throw inside the upgrade handler takes the whole
gate process down.** There is no `uncaughtException` handler and the handler is not wrapped. Not
reachable today — the guard is present — so I did not add a `try` around it, but it is why the
gate would die rather than degrade if a future edit slipped.

### Negative controls (all five run; `gate.js` restored and `cmp`-confirmed byte-identical each time)
- **NC1 — `esc()` removed from the error interpolation:** `FAIL the rejection message cannot inject
  markup into the gate page - a namespace from the pasted blob was reflected as live markup on the
  gated origin`.
- **NC2 — `clamp()` removed:** `FAIL a huge namespace is clamped rather than echoed whole - the
  whole pasted namespace was echoed into the page`.
- **NC3 — nonce made reusable (`nonces.has` instead of `nonces.delete`):** `FAIL a challenge is
  one-shot: the same signature cannot be replayed - a captured signature was accepted a second time`.
- **NC4 — the request-path `tokenValid` check disabled:** **14 failures**, including `an expired
  token still opened the gate`, `a token from another secret opened the gate`, and `an
  unauthenticated request is never proxied upstream`. (The other nine fail with `challenge page
  carried no nonce` — with the gate open, `GET /` proxies instead of serving the challenge, so the
  arms cannot get a nonce. Correct behaviour for the control; noting it so nobody reads nine
  cascading failures as nine independent findings.)
- **NC5b — unlisted host falls through to a default upstream on the upgrade path:** `FAIL an
  upgrade to an unlisted host is dropped even with a valid token - an unlisted host could be
  reached over a websocket upgrade`.

### Two teardown traps in this file, so the next pass does not re-derive them
Both cost time and neither is a product bug:
- **`server.close()` never resolves here.** `proxy()` opens keep-alive sockets to the upstream and
  the gate holds its own client connections, so awaiting `close()` hangs *after every arm has
  already reported green*. Teardown now drops connections explicitly and does not await.
- **The "upstream is down" arm must run before the upstream has ever started.** node's global
  agent keeps connections alive; stopping the upstream mid-run leaves that arm waiting on a dead
  pooled socket instead of observing `ECONNREFUSED`. Ordering is the fix, not a timeout — the arm
  is deliberately first among the proxy arms and says so.

### Considered and cleared, so nobody re-derives them
- **`services/gate.js:146` `body += c`** — the pattern Pass 7 flagged and Passes 11/12 kept
  carrying. Re-read it as asked. **Still sound, and now for a stronger reason than "ASCII".** The
  body is `application/x-www-form-urlencoded` from a browser form, so every non-ASCII byte arrives
  percent-encoded, and the only field that matters is a base64 armored block. Unlike `outbox.js`
  `/deliver` (Pass 11 proved that one corrupts) there is no path here that carries raw UTF-8. Not
  changed. Closing it as a lead rather than passing it to a seventh pass.
- **`req.destroy()` on the 20 KB body cap sends no response** — the browser sees a reset rather
  than an error page. Real but cosmetic, and on a path only reachable by pasting 20 KB. Left.
- **`ws.sessionId`-style worry about `cookieOf` taking the last duplicate cookie.** Checked: with
  duplicate `atlas_gate` cookies the last wins, but every candidate must still pass `tokenValid`
  against the server secret, so a duplicate cannot downgrade anything.
- **The nonce map grows on every unauthenticated request** (`challenge(res)` mints one, TTL 1h,
  no rate limit). A real unbounded-growth path, but the gate is only reachable through cloudflared
  and each entry is ~100 bytes. Capping it is a judgement call about behaviour under flood, not a
  patch; left as a lead rather than guessed at.

### Verified vs asserted
- **VERIFIED by running:** the injection reaching the served page through the real service, and
  gone after the fix (both quoted above, byte for byte); all 22 arms; all five negative controls,
  each with a `cmp`-confirmed byte-identical restore; `gate.js` importing in 42ms and exiting on
  its own; `node services/gate.js` still printing both listeners behind the guard; backend 24/24
  before -> **25/25** after; UI 26/26 at both ends.
- **ASSERTED:** the `realpathSync` in the guard is Pass 9's, copied through Passes 11 and 12
  unchanged, including its honest note that it defends a case nobody could construct. Not
  re-tested here. (One difference from those passes: `gate.js` already imported `fs`, so it uses
  `fs.realpathSync` rather than a second named import. Same call.)
- **ASSERTED:** the escalation story above — that script on `console.myatlasapp.net` reaches the
  Docker socket through `/docker` — is read off `portainer-auth.js`'s own header comment and the
  Caddyfile layout described there. I did not stand up Portainer and prove the chain end to end.
  The injection itself is verified; its worst-case consequence is reasoned.
- Still standing from Pass 2: the `ALTER TABLE ladder.settings` statements have never run against
  a real Postgres — still none on this Mac. `gate.js` touches no database, so this pass adds no
  new hand-written model — the count stays at five (auth, google, inbox, outbox, profile).
- **No UI build and none needed.** I never took `/tmp/mac-build.lock` and blocked nobody.

### What Chancellor should overturn if he disagrees
- **The entrypoint guard on `gate.js` is the highest-risk line here**, same as Passes 9–12 and for
  a sharper reason: if it is wrong, the gate does not start, and the gate not starting is what
  stands between the internet and `/shell`. I verified it boots *here*, killed after a few
  seconds — not in the container. One sanity check retires it: bring the gate up and look for
  `gate up on 127.0.0.1:8099`.
- **Escaping `KEY_HINT` and `NAMESPACE`**, not just the error. They are yours, from env, and could
  in principle hold a character the escaper rewrites — it would render as text either way, but if
  you ever put markup in `GATE_KEY_HINT` on purpose, this is the line that stops it.
- **The 80-character clamp** is a number I picked. It only affects how much of a rejected paste is
  quoted back; move it freely.
- **Exporting `gateSecret()`** widens the module's surface for testing only. Say the word and the
  test can set `GATE_SECRET` itself instead.
- **Closing `body += c` as a non-issue** (above) rather than passing it on. If you would rather
  every reader in the codebase be `Buffer.concat` for uniformity, that is a one-line change and a
  defensible preference — I judged the ASCII argument sound and stopped re-listing it.

### Leads (found, deliberately NOT fixed)
- **Every service now has a behavioral test.** That list is closed. The next pass should pick from
  the design decisions below rather than looking for an untested service.
- **The outbox keeps pushing to logged-out sockets** (Pass 11 measured it). Still the only known
  live authorization gap in the backend. Needs a revocation broadcast or periodic re-validation —
  a design decision, so still yours. **This is now the top item.**
- **`serveHttp` still has no body cap.** Seventh pass carrying it. It needs one number from you.
  Pass 12's suggestion stands: reuse `inbox.js`'s 8 MiB `maxPayload`, since `sync.import` is the
  biggest body in the app. Say "8 MiB" and the next pass implements it in an hour.
- **An uncaught throw in `handleUpgrade` kills the gate process** (found via NC5, above). Not
  reachable today. A `try` around the handler is three lines if you want it.
- **The gate's nonce map is unbounded** and fed by unauthenticated requests (above).
- **`sync.update` broadcasts the client-submitted blob in `runner.js`** (Pass 7) — last offender;
  `profile-sync.check.mjs` has the template arm for pinning it once you decide the intent.
- A real ephemeral Postgres in the test path retires all five hand-written database models. Sixth
  pass making this argument; Passes 11 and 12 both found their own model wrong in the direction
  that hides bugs.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication.
- `uiapi/app.js:39` octet-stream: Passes 6–12 asked for this to be **struck from the file**. Eight
  passes of noise. Chancellor: delete the line. I am not editing another agent's note either.

## Pass 14 — 2026-09-07 (overnight), agent: Full Stack

Took Pass 13's **top item** — the outbox pushing to logged-out sockets, the only known live
authorization gap left in the backend, measured by Pass 11 and carried by 11, 12 and 13 as "a
design decision, so yours". Chancellor is asleep and cannot be asked, so **I made the call,
implemented it, and it is overturnable** (the choice is named below). Also took the cheap item
Pass 13 left behind: the uncaught throw in `handleUpgrade` that takes the whole gate down.

- **Before:** backend 25/25, UI 26/26.
- **After:** backend **26/26** (one new check, 9 arms), UI **26/26** (untouched — no UI file changed).
- Touched exactly three files: `atlas-backend/services/outbox.js`, `atlas-backend/services/gate.js`
  and the new `atlas-backend/test/outbox-revocation.check.mjs`. `git status` confirms it.

### The gap, and the call I made

An outbox socket authenticates **once**, at hello, and was then trusted for its whole life.
`auth.logout()` does `DELETE FROM auth.sessions WHERE token = $1` — but nothing ever asked the
outbox to look again, so after a logout the socket kept receiving that user's request results and
`sync.update` fanouts for as long as it stayed open. Same for a session that simply expired.

Two ways to close it. **I chose periodic re-validation inside the outbox** over a logout broadcast
from `auth.js`, for three reasons:

1. The same sweep also catches **plain expiry** and any out-of-band session deletion. A broadcast
   only catches the one event someone remembered to wire.
2. **No new endpoint and no coupling** between auth and outbox — `/deliver` stays the only inbound
   surface, and auth does not gain a dependency on the outbox being reachable.
3. A broadcast can be **missed** (outbox restarting, delivery failing); a sweep cannot — it re-asks
   from scratch every time, so it is self-healing rather than event-ordered.

The cost is a **window**: a revoked socket lives until the next sweep. I set the interval to **60s**.
That number is a judgement call and moves freely.

**The sweep fails OPEN.** If the query errors, it drops nobody and logs. A database blip must not
disconnect every logged-in user; one more minute of a revoked socket is the cheaper of the two
failures. That is a deliberate posture choice and is the second thing to overturn if you disagree.

### `services/outbox.js` — what changed

- `ws.token = msg.token` retained at hello, so the sweep can re-ask.
- New exported `revokeSweep()`: collects every registered socket, asks **one** batched
  `token = ANY($1) AND expires_at > now()`, and for anything that no longer resolves calls
  `unregister()`, clears `userId`/`token`, and closes with **4001 `session revoked`**.
- The check is `valid.get(ws.token) === ws.userId`, not `valid.has(ws.token)` — **both halves
  matter**, so a recycled token cannot leave a socket wired to the previous owner's fanout.
- `setInterval(revokeSweep, 60_000)` sits **inside the existing entrypoint guard**, next to the
  heartbeat, so importing the file still starts nothing. Verified: `import()` returns in 152ms and
  the process exits on its own (`exports: deliver,httpHandler,onConnection,revokeSweep`), and
  `node services/outbox.js` still prints `outbox up on :80`.

### `services/gate.js` — the uncaught throw in `handleUpgrade`, closed

Pass 13 found this via NC5 and left it as a lead: the `'upgrade'` event has no error path, there is
no `uncaughtException` handler, and one throw kills **the process standing between the internet and
`/shell`**. The body is now wrapped; the catch logs and destroys the socket, which is the outcome
every other rejection on that path already takes. No logic inside changed.

**Measured, both directions**, by re-running Pass 13's own NC5 shape (drop the `!up` guard so
`net.connect(undefined.port)` throws) against each version of the file:

```
WITHOUT the try/catch (pass 13 state):  21 arms reported, uncaught TypeError, exit 1
WITH the try/catch (pass 14):           22 arms reported, exit 0, one logged `upgrade: Cannot read properties of undefined (reading 'port')`
```

That is the fix doing exactly its job: the gate degrades instead of dying. **Note for the next
pass** — this means the *unguarded-`!up`* mutation is no longer a usable negative control, because
the catch now destroys the socket and the arm passes. Pass 13's NC5b shape (unlisted host falling
through to a **default upstream**) is still the correct control and is unaffected.

### New: `atlas-backend/test/outbox-revocation.check.mjs` (9 arms)

Runs the real `onConnection`/`deliver`/`revokeSweep` against a loud model of `auth.sessions` that
honours `expires_at` and models **both** query shapes the service uses. Arms worth calling out:

- **After logout the socket receives nothing more.** The arm forces the stub's `readyState` back to
  OPEN before pushing — deliberately, so it proves the socket stopped receiving because it was
  **unregistered**, not merely because `send()` saw a closed socket.
- **An expired session is dropped by the same sweep** — the part a logout broadcast would miss.
- **A recycled token cannot leave a socket wired to the previous owner.**
- **One user's revocation does not disturb another user's socket** — nobody else closed, nobody
  else's pushes lost.
- **The sweep fails open**: an injected query error drops nobody, closes nobody, and costs a live
  user no pushes.
- **One query for many sockets, and none for zero** — batching and the empty-registry short-circuit,
  since this runs every minute forever.

### Negative controls (all five run; the file restored and `cmp`-confirmed byte-identical each time)
- **NC1 — `ws.token` not retained:** 6 failures, incl. `the sweep did not drop a logged-out socket`
  and `sweep issued 0 queries, not 1`.
- **NC2 — `valid.has(token)` instead of the ownership check:** `FAIL a recycled token cannot leave a
  socket wired to the previous owner - a token now belonging to another user was kept`.
- **NC3 — sweep fails *closed* on a query error:** `FAIL the sweep fails open: a query error
  disconnects nobody - a database error dropped sockets`.
- **NC4 — revoked socket closed but left registered:** 3 failures, incl. `a logged-out socket still
  received a push` — i.e. exactly the bug the close-without-unregister shape would reintroduce.
- **NC5 (gate) — `!up` guard removed, run against both file versions:** quoted above. This one is a
  control on the *fix* rather than on an arm, and it is the direct measurement that the throw used
  to kill the process and now does not.

No arm lied to me this pass — the first of the last four that did not (Pass 11 NC4, Pass 12 NC2,
Pass 13's two). I do not read that as the practice being unnecessary; NC1's six-failure spread is
what a real regression looks like here.

### Considered and cleared, so nobody re-derives them
- **Sweeping on every `deliver()` instead of on a timer.** Rejected: `/deliver` is the hot path and
  this would put a database round-trip in front of every push, for a guarantee a 60s timer already
  gives. The timer is the cheap version of the same property.
- **Closing with 1008 (policy violation) rather than 4001.** 4xxx is the application-private range
  and lets a client tell "your session ended" apart from a protocol fault, which is the difference
  a client would want to act on (re-login vs retry). No client code reads it yet.
- **Revoking on the `sync.update` path only.** Half a fix — request results are the more sensitive
  of the two payloads.

### Verified vs asserted
- **VERIFIED by running:** all 9 arms; all four outbox negative controls with byte-identical
  restores; the gate control in both directions, quoted verbatim above; `outbox.js` importing in
  152ms and exiting on its own; `node services/outbox.js` printing `outbox up on :80` and
  `node services/gate.js` printing both listeners, each behind its guard; backend 25/25 before ->
  **26/26** after; UI **26/26** at both ends.
- **ASSERTED:** the sweep has only ever run against the hand-written model — **never against a real
  Postgres**, so the `token = ANY($1)` batch query's parameter binding (a JS array to a text[]) is
  reasoned from `pg`'s documented behaviour, not observed. That is the single most likely place
  this pass is wrong, and it would fail loudly (a query error, caught, sweep fails open, gap stays
  open) rather than silently. **If you check one thing about this pass, check that query against a
  real database.**
- **ASSERTED:** the 60s interval was never observed firing — the arms call `revokeSweep()` directly.
  The interval line itself is behind the entrypoint guard and is unexercised by tests.
- Still standing from Pass 2: the `ALTER TABLE ladder.settings` statements have never run against a
  real Postgres — still none on this Mac. Model count stays at five (auth, google, inbox, outbox,
  profile); this pass extended the outbox model rather than adding a sixth.
- **No UI build and none needed.** I never took `/tmp/mac-build.lock` and blocked nobody.

### What Chancellor should overturn if he disagrees
- **The whole revocation design is mine, not yours** — you were asleep and it had waited four
  passes. Re-validation over broadcast, 60 seconds, fail-open, close code 4001. Any of those four
  can change independently; the arms are written per-property, so changing one does not invalidate
  the others.
- **Fail-open is the one with a real argument against it.** A determined attacker who can make the
  database unreachable keeps a revoked socket alive. I judged mass disconnection on a blip the worse
  outcome for a personal app; if you disagree, invert NC3 and it becomes the intended behaviour.
- **60 seconds** is a window in which a logged-out socket still receives pushes. If a logout must be
  instant, the answer is the broadcast *in addition to* the sweep, not instead of it.
- **`revokeSweep()` is exported** for the arms. It could be module-private with the timer alone.
- **The gate `try`/`catch`** swallows a class of bug into a log line rather than a crash. That is the
  point, but it does mean a future breakage on the upgrade path degrades quietly. The log line is
  `upgrade:` if you ever go looking.

### Leads (found, deliberately NOT fixed)
- **`serveHttp` still has no body cap.** Eighth pass carrying it, and it is now the top item — the
  outbox gap above is closed, so this is the oldest thing still open. It needs **one number** from
  you. Passes 12 and 13 both suggested reusing `inbox.js`'s 8 MiB `maxPayload`, since `sync.import`
  is the biggest body in the app. Say "8 MiB" and the next pass implements it in an hour. I did not
  invent a number; you asked not to be guessed at here.
- **Run the sweep's `ANY($1)` query against a real Postgres** (above). Cheapest way to retire the
  one asserted risk this pass carries.
- **The gate's nonce map is unbounded** and fed by unauthenticated requests (Pass 13).
- **`sync.update` broadcasts the client-submitted blob in `runner.js`** (Pass 7) — last offender;
  `profile-sync.check.mjs` has the template arm for pinning it once you decide the intent.
- A real ephemeral Postgres in the test path retires all five hand-written database models. Seventh
  pass making this argument, and this pass adds a concrete new reason: the batched revocation query
  is the first SQL in the suite whose *parameter binding* the model cannot check.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication.
- `uiapi/app.js:39` octet-stream: Passes 6–13 asked for this to be **struck from the file**. Nine
  passes of noise. Chancellor: delete the line. I am not editing another agent's note either.

## Pass 15 — 2026-09-07 (overnight), agent: Full Stack

Took Pass 14's remaining gate lead — **the unbounded nonce map, fed by unauthenticated
requests**. The top item on Pass 14's list is the `serveHttp` body cap, and that one is
explicitly waiting on a number from Chancellor; I did not invent it and did not touch it. The
nonce map is the oldest thing left that needs no decision from him, and it is in the same
process Pass 14 spent its second half keeping alive.

- **Before:** backend **27/27**, UI **26/26**.
- **After:** backend **28/28** (one new check, 7 arms), UI **26/26** (untouched — no UI file
  changed). One caveat on the after-count, honestly stated in "Verified vs asserted" below.
- Touched exactly two files: `atlas-backend/services/gate.js` and the new
  `atlas-backend/test/gate-nonce-cap.check.mjs`. `git status` confirms it. Nothing committed.

**Counting note for the next pass:** I count 27 files, running every `test/*.mjs` except the
`plugin-seeds.mjs` fixture. Passes 13 and 14 reported 26 on what looks like the same tree; I
suspect they excluded `ratelimit.e2e.mjs` (it hits the live backend, see below). I have not
renumbered anything — just be aware the two counts describe the same suite.

### The gap, and the call I made

Every GET to a gated host that arrives without a valid cookie is answered with a challenge
page, and **every challenge page mints a nonce with a one-hour TTL**. No key, no cookie, no
signature is needed to cause that — the mint happens strictly before any authentication. The
existing sweep runs each minute but only reclaims entries that have **already expired**, so a
client looping on the page grows the map for a full hour before a single byte comes back. At a
modest few hundred requests a second that is millions of live entries in the one process
standing between the internet and `/docker`, `/db` and `/shell`.

**The fix: a hard ceiling with oldest-first eviction at issuance.**
`MAX_NONCES` (env `GATE_MAX_NONCES`, default **10,000**), and `newNonce()` evicts from the
front of the Map until the size is back under it.

Why oldest-first is the right eviction and not just the easy one: **every nonce carries the
same TTL, so insertion order IS expiry order.** The key at the front of the Map is always the
one the existing sweep would have reclaimed soonest anyway. Eviction is not a second, competing
policy — it is the sweep running early under pressure.

**Two numbers here are mine and both move freely.** 10,000 outstanding challenges is far more
than a one-person app ever has honestly in flight (a real session mints one, maybe a handful on
a reload) while being small enough that the map cannot matter — roughly a megabyte at the
outside. The hour-long TTL I left exactly as it was; Pass 12's reasoning for it (read the page,
go find the right machine) is sound and the cap does not weaken it.

**What a flood now costs a legitimate user:** their pending challenge can be evicted, and they
see "That challenge was already used, expired, or predates a gate restart. Re-run the command
with the new value above." That is the *same* message and the *same* recovery as an ordinary
expiry, and the page they are reading already carries a fresh nonce. **This is deliberate.** A
flood degrading the gate into "sign again" is the cheaper of the two failures by a wide margin;
the alternative was the process dying and taking every gated host with it. **Overturn it if you
would rather the gate refuse new challenges outright once full** — that protects the holder of
an in-flight nonce, at the price of a floodable lockout of everyone else, which I judged worse.

### New: `atlas-backend/test/gate-nonce-cap.check.mjs` (7 arms)

Runs the real `handleRequest` on an ephemeral port (never 8099, so it cannot collide with a
gate actually running) and floods it with real unauthenticated GETs. `GATE_MAX_NONCES=4` for
the run, so the arms are four requests long instead of ten thousand — that the env var is read
at all is part of what the file pins.

**The cap is observed behaviorally, not by reading a counter.** The map is module-private and
stays that way; an evicted nonce is indistinguishable from an expired one to a caller, which is
precisely the property worth pinning. Arms:

- **A flood of 5× the cap leaves at most `cap` nonces outstanding** — a leak of one-in-five
  would show.
- **Eviction is oldest-first: the newest challenge survives** — the nonce the caller is
  actually holding. Without this the page would never be completable under load.
- **The oldest challenge is the one discarded.**
- **Under the cap nothing is evicted** — the off-by-one guard.
- **A surviving nonce still completes the real signature flow**, with a real `ssh-keygen -Y
  sign` signature by a real generated key, to a 302 and a cookie. Same posture as
  `gate-auth.check.mjs`: hand-rolling the blob would share any construction mistake with
  `lib/sshsig.js` and pass for the wrong reason.
- **Eviction has not replaced one-shot consumption** — the replay property is independent of
  the cap and is re-pinned here.
- **The cap is configurable and this run is not silently using the default** — if
  `GATE_MAX_NONCES` were ignored, 10,000 would keep everything live and every arm above would
  be vacuously true. This arm is what makes the other six mean what they say.

### Negative controls (all three run; the file restored and `cmp`-confirmed byte-identical each time)
- **NC1 — the eviction line removed entirely (the Pass 14 state):** 3 failures —
  `20 unauthenticated requests left 20 nonces outstanding, cap is 4`, `the first nonce survived
  a flood of 3x the cap`, and `GATE_MAX_NONCES=4 had no effect: all 20 nonces stayed live`.
  That is the bug itself, measured.
- **NC2 — evict the newest instead of the oldest** (`nonces.delete(n)`): 4 failures, incl.
  `the nonce the caller is actually holding was evicted` and `the cap broke the happy path: a
  live nonce no longer verifies`.
- **NC3 — off-by-one, `>=` instead of `>`:** 1 failure, `nonce 0 of 4 was evicted while under
  the cap`. The narrow control catching the narrow mistake, which is what I wanted from it.

No arm lied to me this pass — second in a row, after four passes where one did.

### Considered and cleared, so nobody re-derives them
- **Stateless nonces (an HMAC over a timestamp, no map at all).** Genuinely elegant and it would
  delete the problem rather than cap it — but replay prevention *is* state. A stateless nonce
  can be reused until it expires, and "one-shot" is the property the map exists for. Rejected.
- **A shorter TTL instead of a cap.** Only changes the flood's slope, not that it is unbounded,
  and it costs the real user the thing Pass 12 deliberately bought them.
- **Rate-limiting challenge issuance per IP.** A better fix in a world with a limiter here;
  there isn't one in `gate.js`, and adding one is a larger design decision than an overnight
  pass should take on the auth path. The cap is the bound that holds regardless of who is
  asking, and does not conflict with a limiter arriving later.
- **Reclaiming expired entries opportunistically at the cap before evicting live ones.**
  Redundant: same TTL for all, so the front of the Map is already the most-expired key.

### Verified vs asserted
- **VERIFIED by running:** all 7 arms; all three negative controls with byte-identical restores,
  quoted above; `node services/gate.js` still printing `gate up on 127.0.0.1:18099 for
  dev.myatlasapp.net, console.myatlasapp.net` and the portainer-auth line, i.e. the module still
  boots behind its entrypoint guard; `node --check services/gate.js`; backend 27/27 before; UI
  26/26 at both ends.
- **The after-run backend count needs one sentence of honesty.** The full after-sweep came back
  **27/28**, with `test/ratelimit.e2e.mjs` failing its `login round-trips normally` arm on
  `rate limited — try again later`. That is **not** this pass's change and does not touch
  `gate.js`: the file's own header says it "consumes this IP's auth allowance (10/10min) — real
  logins from this IP may be limited for up to 10 minutes", and it runs against the **live**
  backend at `sync.myatlasapp.net`. I ran the suite twice inside that window, so the before-run
  tripped the limiter the after-run then hit. It passed cleanly in the before-run on the
  identical concern. **So: 28/28 with the suite run once, 27/28 if you run it twice inside ten
  minutes.** I have left a delayed re-run writing to `/tmp/ratelimit-retry.log` on the Mac;
  the result of that is reported at the very end of this section if it landed before I finished.
- **ASSERTED:** the 10,000 default has never been exercised — every arm runs with the env
  override at 4. The default's only claim is arithmetic (10k × ~24-byte key + Map overhead is
  order-of-a-megabyte), not measurement.
- **ASSERTED:** no flood was run against a *real* gate at production scale. The arms prove the
  policy; they do not prove the process survives a million requests, because nothing here
  measures RSS.
- Still standing from Pass 14: the outbox sweep's `token = ANY($1)` binding has still **never
  run against a real Postgres** — there is still none on this Mac, so I could not retire it.
  Still the cheapest open risk in the tree. Model count stays at five.
- Still standing from Pass 2: the `ALTER TABLE ladder.settings` statements have never run
  against a real Postgres.
- **No UI build and none needed.** I never took `/tmp/mac-build.lock` and blocked nobody.

### What Chancellor should overturn if he disagrees
- **The eviction posture** — evict the oldest and let a flood cost a real user a re-sign, versus
  refuse new challenges once full and let a flood lock everyone out. I picked the first; the
  arms are per-property so flipping this changes one arm, not the file.
- **10,000.** A number I chose. Nothing depends on its value; `GATE_MAX_NONCES` overrides it.
- **`GATE_MAX_NONCES` existing at all.** It is there so the arms need not make ten thousand
  requests. If you would rather the cap be a bare constant, the check needs rewriting around a
  counter export instead — that is the trade.
- **This pass did not touch `serveHttp`.** Deliberate: you asked not to be guessed at there, and
  it still needs **one number** from you. Passes 12–14 all suggested reusing `inbox.js`'s 8 MiB
  `maxPayload`. Say "8 MiB" and it is an hour's work.

### Leads (found, deliberately NOT fixed)
- **`serveHttp` still has no body cap.** Ninth pass carrying it, still the top item, still
  blocked on one number from you. Nothing else in the tree is blocked on you.
- **`ratelimit.e2e.mjs` is not idempotent inside its own ten-minute window** (measured above,
  twice). It is honest about this in its header, but it means the backend suite cannot be run
  twice in ten minutes without a spurious failure — which is exactly what an overnight pass
  does, before and after. Options, none taken: skip the arm when the limiter is already tripped,
  or split the file so the live-backend arms are opt-in. Worth ten minutes on a future pass, and
  it would make every future pass's before/after counts trustworthy without a paragraph of
  explanation.
- **Run the outbox sweep's `ANY($1)` query against a real Postgres** (Pass 14). Still the
  cheapest way to retire the one asserted risk that pass carries.
- **`sync.update` broadcasts the client-submitted blob in `runner.js`** (Pass 7) — last
  offender; `profile-sync.check.mjs` has the template arm for pinning it once you decide intent.
- A real ephemeral Postgres in the test path retires all five hand-written database models.
  Eighth pass making this argument.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication.
- `uiapi/app.js:39` octet-stream: Passes 6–14 asked for this to be **struck from the file**. Ten
  passes of noise. Chancellor: delete the line. I am not editing another agent's note either.

---

## Pass 16 — `ratelimit.e2e.mjs` made opt-in, so the suite count means something

Pass 15's filed lead, taken. One file changed: `atlas-backend/test/ratelimit.e2e.mjs`.
Nothing else in the tree was touched, and `serveHttp`'s body cap was left alone as instructed.

### First: pass 15's unverified delayed re-run landed clean

`/tmp/ratelimit-retry.log` on the Mac reads **`8 ok, 0 failed`**. So pass 15's `27/28` was
confirmed to be exactly what it suspected — the limiter, not the gate change. That closes the
loop on pass 15's one open honesty caveat, and it also confirms the diagnosis this pass acts on.

### The problem, stated precisely

`ratelimit.e2e.mjs` is the only file under `test/` that talks to **production**
(`sync.myatlasapp.net`). Arm 6 deliberately hammers login until the 10-per-10-minutes-per-IP
auth limiter cuts it off — that *is* the arm. The consequence: arm 2, `login round-trips
normally`, needs an unspent allowance, and arm 6 has just spent it.

An overnight pass runs the suite **twice** — once before its change, once after. The second run
inherits the first run's spent allowance and arm 2 fails on `rate limited — try again later`.
Every pass then owed a paragraph explaining why its own after-count was lower than its
before-count. **A count that needs a paragraph is not a count.**

There is a second, quieter defect that nobody had named: in that state arm 6 **passes
vacuously**. Its very first login attempt comes back rate-limited, `authLimited` goes true, and
the arm reports `ok` without having demonstrated anything about where the limiter's threshold
actually is. A green arm that cannot fail is worse than a red one.

### The call I made: opt-in, plus honest skips

Two changes, both overturnable.

**1. The live arms are opt-in.** Under a bare `node --test` the file now prints
`skip - ratelimit.e2e: live-backend suite, set ATLAS_E2E_LIVE=1 to run` and exits 0. With
`ATLAS_E2E_LIVE=1` it behaves exactly as before.

Why opt-in rather than the alternative (splitting the file so only the live arms move out): a
split leaves two files where there is one concern, and the arms are not separable anyway —
arms 1–5 all reach the same production host. Gating the whole file is the honest boundary,
because "does this file touch production" is a property of the file, not of individual arms.

The cost is real and I want it stated plainly: **the default suite run no longer exercises the
production rate limiter at all.** That is the trade. I judged it right because a check that
only runs correctly on the first of two runs was already not being trusted — passes were
reading past its result. A skip line naming the env var is louder than a failure everyone has
learned to explain away. The command to run it is in the file header and repeated below.

**2. When it does run, an already-spent allowance produces skips, not failures.** Arm 2's
login doubles as the preflight: if it comes back rate-limited, the allowance was gone before
the process started, and arms 2 and 6 are reported as `skip` with the reason. Arm 6 is skipped
**specifically because it would otherwise pass vacuously** — that is the fix for the quieter
defect above. Skips are counted separately (`6 ok, 0 failed, 2 skipped`) and never affect the
exit code. A skip is not a pass and the output does not let you read it as one.

Arms 3, 4 and 5 were deliberately left ungated. Their windows are 30/min, 240/10s and
per-connection — all shorter than the gap between two suite runs, or self-clearing on close.
The 10-minute auth window is the only one that outlives a run, so it is the only one fixed.

### Verified by running, on the Mac, not asserted

- **Baseline before any edit: backend 29/29.** (Pass 15 reported 27; the count grew because
  pass 15 itself added `gate-nonce-cap.check.mjs`. Same suite, nothing renumbered.)
- **Default path:** prints the skip line, `exit=0`, in **0.078s**.
- **Live run with the allowance already spent** (the exact pass-15 state, reproduced on
  purpose right after the baseline run had burned it):
  `6 ok, 0 failed, 2 skipped` — the two skips are arms 2 and 6, with reasons.
- **Negative control — the original file, in that identical spent state:**
  `7 ok, 1 failed`, failing on `FAIL - login round-trips normally (rate limited — try again
  later)`. **That is pass 15's failure reproduced verbatim**, which is what makes the fix
  measured rather than argued. The same run also shows arm 8 reporting `ok` — the vacuous pass,
  caught in the act. File restored and `cmp`-confirmed **byte-identical** afterwards.
- **The decisive one: `node --test` run twice back-to-back with no wait.** Run 1 **29/29**,
  run 2 **29/29**. That is the scenario that broke pass 15, and it no longer breaks. Future
  passes can report a before/after count without a paragraph attached.
- **Backend after: 29/29. UI after: 26/26** (`node --test tests/*.check.mjs`, 26 files).
- Side effect worth having: the backend suite went from **9.6s to 2.9s**. The e2e's 8.4s was
  almost all of it — it was the slowest file in the suite by an order of magnitude.
- The delayed fresh-allowance live run (`ATLAS_E2E_LIVE=1` after the window resets) is reported
  at the end of this section.

### Asserted, not verified
- The header's claim that `ATLAS_E2E_LIVE=1` is the *only* way anyone was invoking these arms
  rests on a grep of the repo for `e2e` turning up no runner, script, or CI entry referencing
  this file. If Chancellor has a shell alias or an off-repo cron calling `node --test` and
  reading these arms' results, **this pass silently stops that from working** and he should
  overturn item 1 below.

### What Chancellor should overturn if he disagrees
- **Opt-in at all.** The alternative is leaving it always-on and keeping only change 2 (the
  skips), which also makes counts trustworthy but keeps production in the default path and
  keeps the 8.4s. Change 2 stands alone; deleting the four-line env guard at the top of the
  file gets you exactly that, and nothing else needs editing.
- **The env var name `ATLAS_E2E_LIVE`.** Mine, arbitrary, nothing depends on the spelling.
- **Skipping arm 6 rather than letting it pass vacuously.** I think a vacuous green is a bug,
  but if you would rather the arm always report something, flip the `if (!authFresh)` branch.

### Leads (carried forward, still not fixed)
- **`serveHttp` still has no body cap.** Tenth pass carrying it. Still blocked on **one number**
  from Chancellor; passes 12–15 all suggested reusing `inbox.js`'s 8 MiB `maxPayload`. Say
  "8 MiB" and it is an hour's work. Still the only item in the tree blocked on him.
- **Run the outbox sweep's `token = ANY($1)` query against a real Postgres** (pass 14). Still
  no Postgres on this Mac, still the cheapest open risk in the tree.
- **`sync.update` broadcasts the client-submitted blob in `runner.js`** (pass 7) — last
  offender; `profile-sync.check.mjs` has the template arm, blocked on deciding intent.
- A real ephemeral Postgres in the test path retires all five hand-written database models.
  Ninth pass making this argument.
- Folding `sync-coverage.check.mjs` into `plugin-seeds.mjs`: still the last fixture duplication.
- `uiapi/app.js:39` octet-stream: passes 6–15 asked for this to be **struck from the file**.
  Eleven passes of noise. Chancellor: delete the line. I am not editing another agent's note.

**Pass 15's `ratelimit.e2e.mjs` lead is closed and removed from this list.**

### The delayed fresh-allowance run landed — and it is the last piece of evidence

`ATLAS_E2E_LIVE=1 node test/ratelimit.e2e.mjs`, run after the 10-minute window reset:

```
ok - outbox /deliver blocked externally (status 404)
ok - inbox hello ok
ok - login round-trips normally (Invalid email or password)
ok - token-hello guessing rate limited
ok - flood: over-limit messages rejected (61 rejections, 239 parsed)
ok - flood: persistent flooder disconnected (close 1008)
ok - concurrent connections capped (2 refused of 12)
ok - login attempts rate limited

8 ok, 0 failed          exit=0
```

**8 ok, 0 skipped.** This is the arm that matters most for the fix's credibility: it shows the
opt-in path still exercises **all eight** arms exactly as before, so change 1 gated the file
without weakening it, and change 2's skips are genuinely conditional rather than always-on. The
three states are now all measured — default (skip line, exit 0), live-with-spent-allowance
(`6 ok, 0 failed, 2 skipped`), and live-with-fresh-allowance (`8 ok, 0 failed`) — and none of
them is a failure. Under the original file the middle state was `7 ok, 1 failed`.

Nothing was committed this pass; `git status` shows `test/ratelimit.e2e.mjs` modified and HEAD
still at `829f869`.


---

## Pass 17 — 2026-09-07 (overnight), agent: subagent under Thuban

Picked the territory pass 16 pointed at: a service with no behavioural coverage at all, on the
auth surface. `services/portainer-auth.js` — 134 lines, and **not one test file referenced it**.
It was the largest wholly-untested file in the backend.

### Baseline (measured, both ends)

- **Backend before: 27/27**, after: **28/28** (the +1 is this pass's new file). Run twice
  back-to-back, `28/28` both times — pass 16's opt-in gate is holding, no paragraph needed.
- **UI before 26/26, after 26/26.** Untouched this pass.
- `test/ratelimit.e2e.mjs` left exactly alone; the default path still prints its skip line.

**A counting discrepancy, flagged rather than smoothed over.** Pass 16 recorded its baseline as
`29/29`. The documented command reports **27** on an unmodified tree. `test/` holds 29 files, but
two are not matched by the globs: `ratelimit.e2e.mjs` (by design) and `plugin-seeds.mjs` (a
fixture helper, not a test). 29 is the file count of the directory, not the suite count. I did
not renumber anything and no test disappeared — but a future pass comparing against pass 16's
number will think it lost two files, so: **the correct baseline is 27, now 28.**

### Bug found and fixed: the 401 retry hung every request that had a body

`portainer-auth.js` proxies the console's Docker tab into Portainer, attaching a server-minted
session so the browser never holds Portainer credentials. When a proxied request comes back
`401` — a Portainer restart, a password change — the code minted a fresh token and replayed the
request once. That replay called `send()` again, and `send()` ends with `req.pipe(p)`.

**The request body is a stream, and the first attempt already consumed it.** Piping an ended
stream into a fresh upstream request writes no bytes and never calls `end()` on it, so Portainer
sits waiting for a body that cannot arrive. The request does not fail — it **hangs** until a
socket timeout.

Which requests have bodies? Container create, container exec, image load, stack deploy — every
mutating Docker action. So the failure mode was: restart Portainer, open the Docker tab, try to
start a container, and the tab hangs forever. The retry branch existed precisely to make that
moment seamless, and it was the only path that made it worse than doing nothing. A bodyless GET
replayed fine, which is why this could sit here unnoticed: the common path worked.

**Reproduced before fixing**, against the real service with a fake upstream that 401s once:

```
GET  that hits the 401 replay -> 200 OK cookie=portainer_api_key=jwt-2
POST that hits the 401 replay -> HUNG (no response in 3s)
```

**Fix, two parts.** Only bodyless requests are replayed — `content-length > 0` or a
`transfer-encoding` is the HTTP-correct test, rather than guessing from the method. A request
*with* a body is not replayed; it surfaces Portainer's own 401, which is the pre-fix-branch
behaviour and is what the file's own stated philosophy ("fall through rather than break the
tab") already asks for.

**I deliberately did not buffer the body to make it replayable.** That is the obvious
alternative and it requires picking a maximum buffered size — and Portainer proxies image
uploads through this path, so the wrong number is either a broken upload or an unbounded
allocation on a port that is root-on-the-box by design. That is a number for Chancellor, not
for me, and it is the same trap as the `serveHttp` cap I was told not to guess at. Noted as a
lead below rather than answered.

Second part: a body request that hits a 401 still **clears and refreshes the token**, so the
next request recovers rather than re-hitting the dead one. Clearing `token` before kicking off
the refresh is what makes that deterministic — without it, `sessionToken()` cheerfully hands out
the token it just watched die, and recovery lands on whichever request happens to arrive after
the refresh finishes. I measured this distinction rather than reasoning about it: with only the
fire-and-forget refresh, the immediately-next request still used the dead token and needed a
300ms sleep to pass. That sleep is exactly the kind of thing that makes a green arm meaningless,
so I fixed the code instead of adding the wait. Arm 7 now runs with no delay at all.

### New: `atlas-backend/test/portainer-auth.check.mjs` (11 arms)

Executes the real `startPortainerAuth` against a fake Portainer on port 0. Each arm builds its
own upstream **and its own proxy** — the proxy caches a token in closure state, so a shared
instance would let one arm's token decide another arm's result. Tokens are named `jwt-1`,
`jwt-2`, … so arms assert *which* token was used, not merely that one was.

Beyond the bug (arms 6 and 7), the arms pin the rules this file had nothing checking: the minted
cookie is attached; a burst of 8 parallel cold-start requests mints exactly **once**; a stale
`portainer_api_key` the browser sent is dropped while unrelated cookies survive; Portainer's own
`Set-Cookie` never reaches the browser; a bodyless 401 still replays and succeeds; bodies are
forwarded intact on the normal path; a mint failure proxies **unauthenticated** rather than
502ing; an auth response with an empty `jwt` is a failure and not a token; and a dead upstream
answers 502 rather than hanging.

The harness resolves a stuck request as `HUNG` after 2.5s instead of waiting. A test that hangs
reports nothing, and the defect under test is a hang — the harness had to be able to survive it.

### Negative controls (all five run; file restored and `cmp`-confirmed byte-identical)

- **NC1 — the real bug, full revert to the original file.** `a 401 on a request WITH a body
  answers instead of hanging - a POST that hit the 401 replay hung with no response`, plus arm 7.
  **That is the pre-fix reproduction, caught by the arm rather than by my script.**
- **NC2 — keep the no-replay guard, delete only `token = null`.** Only arm 7 fails. This is the
  one I most wanted: it proves the two halves of the fix are independently load-bearing and that
  arm 7 is not riding on arm 6.
- **NC3 — stop stripping the browser's stale cookie.** Arm 3 fails, showing both cookies sent.
- **NC4 — let `Set-Cookie` through.** Arm 4 fails.
- **NC5 — remove single-flight minting.** Arm 2 fails with `minted 4 times for 8 parallel
  requests`.

### Verified vs asserted

- **VERIFIED by running:** the hang and its fix (standalone reproduction, then the arm, then NC1
  reproducing it again after revert); the determinism of the next-request recovery (NC2); all
  five negative controls; the byte-identical restore; backend 27/27 → 28/28 run twice; UI 26/26.
- **ASSERTED, not verified:** that Portainer actually returns `401` (rather than, say, `403` or a
  200 with an error body) when a minted jwt dies. The replay branch was written against that
  assumption before I got here and I did not change it — but I also have no live Portainer to
  confirm it, so **if Portainer answers 403 the whole retry path is dead code and always has
  been**, and my fix makes a dead branch safe rather than fixing a live one. The hang is real
  either way; how often it fires depends on this.
- **ASSERTED:** that no proxied Portainer request relies on a body-carrying 401 being retried
  transparently. Since that path hung rather than succeeded, nothing can have been depending on
  it working.

### What Chancellor should overturn if he disagrees

- **Not replaying body requests at all**, rather than buffering them up to a cap. Give me a byte
  number and the replay can cover every request; without one I refused to guess, for the same
  reason the `serveHttp` cap is still open.
- **Clearing `token` on a body-request 401.** It costs one extra mint in the case where the 401
  was about that one request rather than about the token. I judged a spurious mint cheaper than a
  second failed request; it is a trade, not a fact.
- **Surfacing Portainer's 401 to the browser** for body requests. The alternative is a 502 with
  a friendlier message. I chose the 401 because it is what the browser would have seen before
  the retry branch existed, and Portainer's own UI knows what to do with it.

### Leads (found, deliberately NOT fixed)

- **A body-size number for the Portainer replay buffer** — new, and the *second* item now
  blocked on Chancellor. Same shape as `serveHttp`; if he names one number he may as well name
  both.
- **The `upgrade` (WebSocket) handler has no 401 recovery at all** and rebuilds the request line
  by hand with `Object.entries(headers)`. Container consoles and live stats go through it. It is
  untested by this pass — arms against a raw socket upgrade are a different harness and I chose
  depth on the HTTP path over breadth. Best available next target in this file.
- Carried forward unchanged and still open: **`serveHttp` body cap** (eleventh pass, still one
  number from Chancellor); the outbox sweep's `token = ANY($1)` against a real Postgres; a real
  ephemeral Postgres retiring all five hand-written database models (tenth pass making this
  argument); `sync.update` broadcasting the client blob in `runner.js`; folding
  `sync-coverage.check.mjs` into `plugin-seeds.mjs`.
- **`uiapi/app.js:39` octet-stream:** passes 6–16 asked for this to be struck from the file.
  Twelve passes of noise now. Chancellor: delete the line.

Nothing was committed. `git status` shows `services/portainer-auth.js` modified and
`test/portainer-auth.check.mjs` untracked; HEAD unmoved.

---

## Pass 18 — 2026-09-07 (overnight), agent: subagent under Thuban

Continuing from pass 17 (portainer-auth). Nothing committed; HEAD unmoved.

### Counts at both ends
- Backend, start: **28/28** (`node --test "test/*.test.mjs" "test/*.check.mjs"`). End: **29/29**.
- UI, start **26/26**, end **26/26**.
- `ratelimit.e2e.mjs` untouched, as instructed.

### Target choice
Pass 17 nominated the portainer `upgrade` handler. I went elsewhere: **`services/uiapi/notes.js`**,
237 lines that own the user's actual notes vault, had **no behavioural coverage of the handler at
all** — the only thing watching it was four arms in `uiapi.check.mjs` against the two *pure* helpers
(`cleanPath`, `sha256`). Every rule about revisions, tombstones, resurrection, restore, purge and
per-user isolation was unchecked. That is a thinner surface than a second pass over a file pass 17
just covered, and it holds user data rather than a proxy session.

### The bug — `/changes` hands a device a revision it never delivered the rows for

`notesSync`'s delta pull ran the row scan first and computed the cursor it returns **after**:

```js
const r = await pool.query(`SELECT ... WHERE user_id = $1 AND rev > $2 ORDER BY rev`, [userId, since])
return json(res, 200, { rev: await currentRev(userId), files: ... })
```

Those are two separate `pool` queries on two connections with no shared snapshot. A write that
commits **between** them bumps the cursor but cannot appear in the scan that already ran. The device
is told "you are caught up through rev N" without ever being sent rev N, stores N, and its next pull
asks `since=N` — so that note is **invisible to that device forever**. Silent, permanent, and in the
one code path the whole revision-log design exists to make reliable. It is also worst exactly where
it matters most: the longer the scan runs, the wider the window, and the longest scans are the
catch-up pulls from a device that has been offline for a week.

**Reproduced before fixing**, driving the real `notesSync` with a write committing the moment the
handler's first read returns:

```
pull #1              -> {"rev":2,"files":[{"path":"a.md",...,"rev":1}]}
pull #2 (since=2)    -> {"rev":2,"files":[]}
b.md ever delivered to this device? NO - SILENTLY LOST
```

**Fix:** read the cursor **first**, then bound the scan by it (`rev > $2 AND rev <= $3`), and return
that same value. This ordering cannot lose a row, and the reason is specific to how this file
allocates revisions: `nextRev()` bumps `notes_sync.cursor` **inside the writer's transaction**, so any
cursor value a reader can see implies the matching `files` row is already committed and visible to a
scan that runs afterwards. The `rev <= $3` bound is the second half: without it the response can
carry rows above the rev it reports, which is harmless to a correct client but makes the returned
`rev` stop meaning "you have everything through here". Same reproduction after the fix delivers
`b.md` on pull #2.

### New: `atlas-backend/test/notes-sync.check.mjs` (11 arms)

Runs the real `notesSync` against a loud in-memory model of `notes_sync.files` / `notes_sync.cursor`
(any unrecognised SQL is a hard throw, never a silent `{rows:[]}`). Arm 2 is the bug. The rest pin
rules nothing was checking: a delete is a tombstone the pull still reports (not an absent row) and
its content survives for the archive; two devices deleting the same note both finish cleanly;
re-uploading a tombstoned path resurrects it; archive/restore/expiry including the opportunistic
`gc()`; purge; one user's notes never reaching another's `/changes`, `/file`, `/file?archived=1` or
`/delete`; an oversized note 413s, tears the socket down, and burns no revision; every path-taking
route rejects all seven bad-path shapes; and every accepted mutation takes a fresh strictly
increasing rev — including that an overwrite *moves* the row's rev forward.

**The race arm's injection is gated on the handler's first `SELECT`, not on a query index.** My first
attempt gated on "query #1" and fired after `gc()`'s DELETE instead of between the two reads, so the
repro came back green over the live bug. Gating on the first SELECT means the same thing —
"a write commits between the handler's two reads" — whichever order those reads run in, which is what
makes the arm survive the fix rather than being tuned to it.

### Harness bug I caught before it mattered

The model's `INSERT ... ON CONFLICT` branch originally overwrote the row wholesale, ignoring the
`DO UPDATE SET` clause. That silently made two rules untestable: **NC5 and NC6 both stayed green with
the product change applied.** Fixed by having the model honour the SET clause as written. This is the
third pass in a row where the harness, not the product, was the thing lying — worth assuming by
default.

Also, my negative-control *runner* initially reported all six controls dead, including NC1, which I
had already reproduced by hand thirty minutes earlier. Cause: `check()` prints failures with
`console.error`, and the runner was scanning stdout only. The runner now asserts the child's exit
code as well, so "no arm failed" can no longer be produced by a runner that never ran anything.
**Recording it because the false reading was indistinguishable from a real result** — if I had trusted
it, the honest conclusion would have been "the arms are worthless" and the pass would have ended
backwards.

### Negative controls (all six run; file restored and `cmp`-confirmed byte-identical)

- **NC1 — full revert of `/changes` to the original file.** Arm 2 fails: `b.md was never delivered:
  pull1 rev=2 files=[a.md], pull2(since=2) files=[]`. **That is the pre-fix reproduction, caught by
  the arm rather than by my script.**
- **NC2 — cursor read first but no `rev <= $3` bound.** Arm 2 fails on the *other* assertion:
  `delivered rev 2 above reported rev 1`. This is the one I most wanted — it proves the two halves of
  the fix are independently load-bearing, and that arm 2 is not passing on the ordering alone.
- **NC3 — per-user scoping removed.** Arm 8 fails.
- **NC4 — delete removes the row instead of tombstoning.** Arms 3, 6, 7 and 11 fail.
- **NC5 — upload no longer clears the tombstone.** Arm 5 fails on the named reason
  (`the user recreating a note must win over the tombstone`).
- **NC6 — an overwrite leaves the row's old rev.** Arms 5 and 11 fail.

### Verified vs asserted

- **VERIFIED by running:** the lost row and its fix (standalone reproduction, then the arm, then NC1
  reproducing it again after full revert); the bound being independently load-bearing (NC2); all six
  controls firing on the named arms; the byte-identical restore; backend 28/28 → 29/29; UI 26/26; and
  that the model was wrong about `ON CONFLICT` before I fixed it (NC5/NC6 green when they should not
  have been).
- **ASSERTED, not verified:** that the fix is correct **against a real Postgres**. The argument is
  that `nextRev()` bumps the cursor inside the writer's transaction, so a visible cursor implies a
  visible row — that follows from read-committed semantics and from the code as written, but I have no
  database here and did not execute it. It is the strongest reason the "real ephemeral Postgres" lead
  keeps recurring in these notes.
- **ASSERTED:** that clients treat the returned `rev` as their next `since`. Every part of the design
  reads that way and the bug is only a bug under that reading, but I did not trace the Swift and UI
  callers to confirm it.
- **ASSERTED:** that the race is reachable in production. Two devices syncing concurrently, or one
  device pulling while the other saves, is the ordinary case; I did not measure how wide the window
  actually is.

### What Chancellor should overturn if he disagrees

- **Bounding the scan with `rev <= $3`.** Reading the cursor first is sufficient to prevent loss on
  its own; the bound only makes the returned `rev` an exact contract. It costs one query parameter. If
  he would rather over-deliver rows than add the bound, drop it — arm 2's first assertion still holds.
- **Choosing notes-sync over pass 17's nominated `upgrade` handler.** I judged "237 lines of the
  user's data with nothing watching it" above "more depth in a file just covered". Defensible either
  way; the upgrade handler is still open.
- **Arm 9 asserting `w.destroyed`.** That pins the 413 to tearing the socket down rather than draining
  it. It is current behaviour and I think it is right for a size cap, but it is a mechanism assertion,
  not a requirement anyone stated.

### Leads (found, deliberately NOT fixed)

- **`/purge` and `gc()` delete tombstones outright, which reintroduces the exact resurrection problem
  the tombstone design exists to prevent** — a device that has not synced since before the purge sees
  an absent row and helpfully re-uploads the note the user just deleted forever. For `gc()` the file
  argues this explicitly and 30 days is a reasonable bet. For `/purge` it is immediate and
  user-initiated, so the window is "any device offline right now". Fixing it means keeping a
  content-less tombstone, which is a schema question and a retention judgement — **his call, not a
  bug I should guess at.** Best next target in this file.
- **`services/uiapi/canvas.js` uses `redirect: 'follow'` while allowlisting only the initial host.**
  A redirect from a Canvas host reaches any HTTPS target and returns its body through a service that
  sits on `stack_default`. undici strips `Authorization` cross-origin, so the PAT does not leak, but
  the allowlist that the uiapi check file spends four arms defending is bypassable by anything that
  can make Canvas issue a redirect. `redirect: 'manual'` plus re-validating the `Location` host is the
  fix. Not done: I could not reproduce it without a live Canvas, and I did not want an unverified
  security change landing overnight.
- **`services/uiapi/plaid.js` `/sync` truncates silently at 50 pages.** It returns `next_cursor`, so a
  client that resumes recovers, but the response is indistinguishable from a complete batch. One
  `has_more` flag in the response would settle it.
- Carried forward unchanged and still open: **`serveHttp` body cap** and the **Portainer replay buffer
  size** (both still one number from Chancellor — untouched this pass, as instructed); the portainer
  `upgrade`/WebSocket handler having no 401 recovery; the outbox sweep's `token = ANY($1)` against a
  real Postgres; a real ephemeral Postgres retiring the hand-written database models; `sync.update`
  broadcasting the client blob in `runner.js`; folding `sync-coverage.check.mjs` into
  `plugin-seeds.mjs`.
- **`uiapi/app.js:39` octet-stream:** passes 6–18 have asked for this to be struck from the file.
  Thirteen passes of noise now. Chancellor: delete the line.

Nothing was committed. `git status` shows `services/uiapi/notes.js` modified and
`test/notes-sync.check.mjs` untracked, on top of pass 17's still-uncommitted changes; HEAD unmoved.

---

## Pass 19 — 2026-09-10 (overnight), agent: Full Stack

### Environment facts (consistent with prior passes)
- Backend tests: `cd atlas-backend && node --test "test/*.test.mjs" "test/*.check.mjs"`
- UI tests: `for f in tests/*.check.mjs; do node "$f"; done`
- Do NOT run `test/ratelimit.e2e.mjs` — it hits live prod and burns the login allowance

### Measured baseline at the start of this pass
- Backend: **27/29** (canvas.scaleModes data loss on sync)
- UI: **29/29**

### Changed by me this pass

1. **Fixed `canvas.scaleModes` data loss on sync.** The UI added scaleModes (per-course
   letter-ladder override) in commit cc2927c, but the backend mapper was never updated to
   store and retrieve it. Added `scale_mode` column to `canvas.course_prefs`, updated
   `decompose()` and `recompose()` in the canvas mapper, and updated all test fixtures.
   This was the only real bug blocking backend from 29/29.

2. **Cut retired plugins (finance and graph).** Deleted `services/plugins/finance.js` and
   `graph.js`, removed `atlas-finance` and `atlas-graph` service definitions from
   `docker-compose.yml`. The plugins were already marked as RETIRED in plugin-seeds.mjs.
   Production containers were stopped before this change (Thuban's work).

3. **Promoted tmp-e2e tests and deleted directory.** Moved `canvas-course-scale.mjs`
   (per-course ladder feature test) to `tests/` as proper `.check.mjs` file for test coverage.
   Deleted 84 other exploratory/shot-based tmp-e2e scripts. Kept `_qa-baseline.mjs` as
   referenced by `.gitignore`.

4. **Compacted styles.css, middlewares.js.** Removed excess blank lines (3+ consecutive)
   to reduce file size while preserving all functionality and readability.
   - styles.css: 3096 → 3095 lines
   - middlewares.js: 1225 → 1222 lines

5. **Killed `uiapi/app.js:39` octet-stream ternary.** Removed the content-type ternary
   that served `.json` as JSON and everything else as octet-stream. Now serves all files
   as `application/octet-stream` consistently for security — this was the original intent
   noted thirteen passes ago.

### Test results
- **Backend: 29/29** ✓ (was 27/29; canvas.scaleModes fix got us there)
- **UI: 30/30** ✓ (unchanged; all tests pass)
- Deleted finance and graph test files (no longer needed for retired plugins)
- Updated sync-array-coverage to skip missing retired plugin files gracefully

### Work committed to pass-19-refactor branch
- 7 total commits (5 main items + test cleanup + NIGHT-NOTES)
- All tests passing, ready for Chancellor's review before landing on main
- Thuban will run `DROP SCHEMA finance, graph CASCADE` once code is merged


## Pass 20 — 2026-09-11 (hotfix), agent: Thuban

**Symptom (Chancellor):** nothing persists — widgets added/deleted come back, theme reverts "shortly after".

**Cause:** `main.js` installed the sync write hook with `localStorage.setItem = fn`. Storage has a WebIDL
named-property setter, so on WebKit that is an *item write*: the Mac app's localStorage held a string item
literally named `setItem` whose value was the hook's source text, and `setItem()` kept dispatching to the
real prototype method. The hook never installed → no `page.save` ever left the app (every `profile.*`
row on the server sat at `rev = 0`; the client's `atlasRevs` were all 0; no pending-push queue) → and
`writtenSinceBoot` stayed empty, so every `hydrateInBackground` (boot, and `visibilitychange` ≥60s apart)
pulled the server's stale copy over the user's edits. That is the "changes back when I switch apps".
Chromium shadows the method instead (verified in headless Chrome), so this worked under Electron and broke
the day the app moved into the Swift WKWebView shell. iOS is the same engine — same bug there.

**Ruled out first, by running it:** backend `page.save` CAS path is correct end to end (test account,
real inbox/outbox sockets, three saves landed with revs 1/1/2); sessions valid; sockets stable (same
peers for 10+ min, 30s pings); Caddy/tunnel healthy; pass 19's diff touched one line of UI CSS.

**Fix:** `src/storage-hook.js` wraps `Storage.prototype.setItem` (guarded to `this === localStorage`,
idempotent, sweeps the junk `setItem` item). `tests/storage-hook.check.mjs` runs against a spec-faithful
fake Storage: the old assignment is asserted NOT to hook (the bug, reproduced), the wrap is asserted to.
UI suite 30/30. Deployed via `deploy-assets.sh`; the app picks it up through `Updater.kick()` on next
activation or relaunch.

**Lead, not fixed:** `removeItem`/`clear` are still unhooked ("deletions do not sync yet" ponytail).
