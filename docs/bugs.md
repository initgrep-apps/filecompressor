Mannual testing bugs: DO NOT REMOVE OR UPDATE this section

1) if i click the input boxes on settings screen to change. simple clicks on corners either increments the number or decrease. it should clearly be like a number box properly designed. something like [+]10[-] so that either side increment or decrement. the example is for showing u. u must use proper compoennt from shadecn or design if it is not present. the same applies to all. 
2) if i have added the items in compress page, then i go to settings. i can update the settings. then two things happen: a) the added items in compress page are lost. b) I can not longer add items or drop items. when trying, it then doesnt show anything. i have to close the app and do it again
3) if multiple items are added, they are compressed in sequence when it is clearly possible to do them in parallel or batch similar files in parallel though that seems weird. there is a chance to also consider whether the cpu and memory would allow that since i noticed when compressing videos it throttles the cpu usage quite a bit so it has to be a very concious adaptive decision to go from series to parallel or otherway araound depending on the machine. the required compute needs to think that if we run each file type in paralle (assume we batch the similar files meaning similar files compressed in sequence while different batch of different files compress in parallel) then at one point we can have max N supported file compressions running. we can discuss this more and it could be an improvement
4) the UI imo does not look professional and is still in the middle of reaching there.
 a)history page: the save and cancel footer is scrolled to bottom for smaller size we need to scroll. it should instead show always. also it must looks something how the native os looks (this can be deferred later)
b) compress page: the section for drag and drop should look similar to added attachedment (google translate design but better) . 
c) the compress ppage: when scrolled everything scrolls as a page including the section for drag and drop. imo the drag and drop must stay and rest of the table that shows added items must scroll only. the table footer that shows count and buttons for clearing must also show always in someway. the design needs a better thought.[Image 1]

---

## Triage — 2026-09-30 (root-cause investigation; section above is preserved verbatim)

| # | Type | Severity | Fix scope |
|---|------|----------|-----------|
| 1 | UI defect (component) | P1 — usable but hostile | `SettingsView.tsx` inputs |
| 2 | Functional bug | P0 — blocks core workflow | State architecture |
| 3 | Enhancement (not a bug) | P2 — v2 design discussion | Batch scheduler |
| 4a | Layout bug | P1 | `App.tsx` layout wrapper |
| 4b/4c | Design feedback | P2 — UI polish batch | CompressView design |

### Bug 1 — Settings number inputs: corner-click spinners

- **Root cause:** all 9 numeric controls are native `<Input type="number">` (`src/views/SettingsView.tsx:180, 217, 233, 259, 273, 290`). WKWebView (macOS) renders no visible stepper — the spin arrows are a tiny invisible hover region at the input corner, and on WebKit a plain click can trigger an up/down step. Confirms user report; not a state bug.
- **Fix direction:** replace with a proper stepper — shadcn `InputGroup`/`InputGroupAddon` + `Button` (`[-]` value `[+]`) or a committed shadcn stepper pattern, clamped to each field's min/max (i.e. `[+10−]` style). Applies to all 9 inputs (4 category targets + 5 quality floors). Keep `aria-label`s.

### Bug 2 — Compress list lost + drops stop working after visiting Settings (P0)

One root cause, two visible symptoms:

- **2a (list lost):** `src/App.tsx:126` — `activeView === "compress" && <CompressView />` unmounts CompressView on navigation. `useFileList` holds the list in component state (`src/hooks/useFileList.ts:26`), so returning to Compress remounts with `files = []` while the backend `FileListState` (`src-tauri/src/commands.rs:22`) still holds the old entries. UI and Rust state diverge.
- **2b (drops no longer show anything):** user re-drops the same files → `add_files_core` silently dedups against the still-populated backend list (`src-tauri/src/commands.rs:41-43`, strips non-files first), returns `[]`, and the empty result renders nothing. Correct dedup behavior + destroyed UI state = looks like drop inputs are dead.
- **Fix direction:** make UI state survive navigation — (a) keep all three views mounted and toggle visibility (`hidden` attr), or (b) lift file-list state to `App.tsx`/context, or (c) treat backend as source of truth with a `get_files` command used on remount. Preferred: (a) — smallest change, also preserves `useCompression` listeners and drag-drop webview subscription. Add regression test: add file → switch view → switch back → row present; re-drop same file → still one row (dedup, no visual change), re-drop new file → appears.

### Bug 3 — Sequential compression: spec decision, not a defect

- **Classification:** deliberate v1 design — spec §7 "One file at a time (simpler, avoids sidecar resource contention, predictable progress)". User's own framing ("improvement", needs CPU/memory-adaptive decision) confirms it is an enhancement, not a regression.
- **Disposition:** backlog for v2 as adaptive parallelism (per-category worker lanes, batch similar formats sequentially, run different categories concurrently, concurrency cap N chosen from machine resources). Requires design discussion (brainstorm) before any plan — overlapping sidecar CPU spikes when two ffmpeg encodes run simultaneously is the key risk the caller already flagged.

### Bug 4a — Settings Save/Cancel footer scrolls away (P1)

- **Hypothesis (verify in app before fixing):** `SettingsView` already pins the footer (`shrink-0` + `flex-1 … overflow-y-auto` content, `src/views/SettingsView.tsx:117-326`) — same pattern CompressView uses. The unconstrained link is `src/App.tsx:125`: `<div className="flex flex-1 flex-col">` lacks `min-h-0`, so the view child grows to content height instead of scrolling internally; the page (header + drop zone + content) scrolls as one body and the footer leaves the viewport. Classic flexbox `min-height:auto` trap.
- **Fix direction:** add `min-h-0`/`overflow-hidden` to the `App.tsx:125` wrapper (and prove with a small-window screenshot). Note user said "history page" — Save/Cancel footer only exists on Settings; History is a placeholder, so triaging this as Settings.
- Native-OS look refinement: deferred per caller.

### Bug 4b/4c — Compress page design feedback (P2, UI polish batch)

- **4b (drop-zone look):** design preference — replace with a richer drop-zone design per attached reference. Design task, not a code defect.
- **4c (scroll containment):** real layout complaint — drag zone + summary footer should be pinned; only the file table scrolls. Likely shares the Bug 4a `min-h-0` root cause; needs a small design pass before implementation (which element scrolls, sticky footer styling).
- **Disposition:** bundle 4a + 4b + 4c into one "Compress/Settings layout & polish" design task — brainstorm first, per project conventions.

### Recommended order

1. **Bug 2** (P0) — one fix resolves loss + dead-drop + divergent state.
2. **Bug 4a + 4c** (P1/P2 layout) — single `min-h-0` chain fix, verified visually.
3. **Bug 1** (P1) — stepper component for all 9 inputs.
4. **Bug 4b** (P2) — drop-zone redesign with reference image.
5. **Bug 3** (P2) — v2 design discussion only.

---

## Refinement Drift — 2026-09-30-manual-testing-1-bugs
**Date:** 2026-10-01 | **Plan:** `docs/superpowers/plans/2026-09-30-manual-testing-1-bugs.md`

Second refine pass (post-`51b644a`): drift found between plan step snippets and repo facts. All items fixed in-plan; none require code change (implementation not started).

1. Task 2: test-snippet `Row` double-fired `invoke('add_files')` and then called `addFiles` (which invokes again) — one click consumed two `mockResolvedValueOnce` values, so the dedup test (`re-drop of same path keeps one row…`) could not pass as written — plan:159-181, 212-244. Fixed: `onClick={() => addFiles(paths)}`.
2. Task 2: snippet imported `toast` but never used it → `tsc` TS6133 under `noUnusedLocals` (`tsconfig.json:19`, build `tsc && vite build`). Fixed by adding the two toast tests that were owed by the AC (batch complete/error + listener-registration failure).
3. Task 3: snippet used `beforeAll` without importing it → TS2304, breaks `yarn build`. Fixed: `beforeAll` added to the vitest import.
4. Task 5: `Separator` imported in the SettingsView rewrite snippet but unused by the JSX → TS6133. Fixed: import removed, interfaces note updated.
5. Task 4: spec §6's "Enter/Space unaffected" behavior had no test; bound tests only covered above-max clamp; null-guard test was vacuous with a static `value` (zero spy calls passes `.every`). Fixed: Enter/Space test, below-min clamp, stateful harness for the null contract (7 tests total).
6. Task 5 Step 2 selector migration: line 87 (`Videos minimum resolution`) is a Select but was folded into the numeric `toHaveValue`→`toHaveDisplayValue` range; item 4's `listbox` reference was undefined; the two new structural tests rendered synchronously (SettingsView's first paint is the loading branch) — would throw. Fixed: line 87 moved to the select list, concrete `pickOption` helper, `await loadView()` in both tests; two new control tests added.
7. Task 6: Required Tests claimed `renders empty state when no files` but no snippet defined it; structural snippet lacked non-null handling (`closest`/`querySelector` under strict TS); `drop zone is pinned outside the file-list card` was missing from the Required Tests list. Fixed: empty-state test added, non-null form applied, Required Tests list completed.
8. Task 7: onKeyDown `stopPropagation` guards Enter but not Space (browser fires a Space click on buttons after keyup) → added the Space single-fire test.
9. Docs-only: Task 1 Step 2 `data-slot` "recorded names" note; Task 2 Step 4 line range 17–45 also swallowed still-needed imports — narrowed to 17–18/25–28/31–45; heading-removal test moved from Task 3 to Task 8 Step 1c (headings only disappear after Tasks 5/6).
10. Task 8 acceptance table updated to map every row to an existing named test (added App-level Bug 2a + heading-removal + provider toast rows).

---

## Refinement Drift — 2026-10-02-history-audit-trail
**Date:** 2026-10-02 | **Plan:** `docs/superpowers/plans/2026-10-02-history-audit-trail.md`

Refine pass (pre-implementation). Drift found by code-explorer against repo facts; all items fixed in-plan (implementation not started), none require code change.

1. Task 2/6: record-serializer name mismatch — plan defined private `RecordRef<'a>` (`history.rs`) but Task 6's queue helper referenced `HistoryRecordRef<'_>`; a private enum is also unnameable from `queue.rs`. Fixed: type renamed `HistoryRecordRef`, visibility `pub(crate)` in both tasks.
2. Task 6: `process_batch` N≤1 path consumes `file_ids` by value (`queue.rs:222`), so `file_ids.len()` for `session_start` must be captured before the loop — plan did not note the ordering constraint. Fixed in Write points.
3. Task 6: `finish_batch` removes the batch token at `queue.rs:505` before emitting `batch:complete`; the `cancelled` flag must be read before/independent of removal. Fixed in Write points.
4. Task 6: status strings risk — `FileResultRecord.status` must be the serde snake_case `FileStatus` string (`already_under_target`), not `format!("{:?}")` (`AlreadyUnderTarget`). Fixed: planned `status_key` exhaustive helper + `status_key_snake_case` required test.
5. Task 7: `commands.rs` imports only `tauri::State`; `app.try_state::<HistoryStore>()` needs `use tauri::Manager;`. Fixed in interfaces + Step 3.
6. Task 7: `opener().open_path` signature is `open_path(path, with: Option<impl Into<String>>)`; call must pass `None::<&str>`. Fixed in interfaces.
7. Task 7: missing-store response `page` field inconsistency (interfaces said requested page, step hardcoded 0). Fixed: `empty_history_response` echoes clamped `page_size`, `page: 0`, with a test pinning `pageSize` clamp echo.
8. Task 9: `App.test.tsx`'s `invoke` mock resolves `undefined` while the new HistoryView calls `get_history` on mount (breadcrumb test clicks History at `:48`, heading-absence at `:122-125`) — skeleton-flake risk. Fixed: Task 9 Step 1 now configures an empty `HistoryResponse` mock; line range corrected to 122-125.
9. Task 10: fixture ripple was understated — `src/hooks/useSettings.test.ts:27` fixture is typed `Settings` (mandatory update); `SettingsView.test.tsx:281` asserts exactly 4 cards (now fails → update to 5); `baseSettings`/`resetDefaults` typed fixtures need `history`. Fixed: Task 10 Files + Required Tests list the mandatory edits.
10. Task 9: "N matches" singular/plural — test expected literal `1 match` while spec says `N matches`; plan now specifies singular/plural and the auto-expand test asserts `1 match`.
11. Spec drift (fixed): spec §3.7 still sketched `fold_sessions` / `LoadedHistory` / `query_history(..., now_ms)` while §3.5 resolves presets to `sinceMs` webview-side. Synced the spec to the plan (`fold_records` / `FoldResult` / no `now_ms`) and updated §5.7's file table to the implemented structure (`HistoryView.tsx` includes the filter bar + session row; `HistoryPagination.tsx` added).
12. Coverage gaps closed by this refine: write-failure/once-per-batch `history:error` tests, command-level `get_history`/`clear_history`/`open_folder` tests, missing-store empty response, unsupported-outcome record, sequential cancel-all path, stale-response race, DST midnight boundaries, page_size 0 safety, empty/whitespace search and empty-vec filter semantics, session-not-split-across-pages, actions/disabled-state UI tests, summary-bar page-independence UI test, automated AC proxies in Task 11.

## Refinement Drift — 2026-10-02-sidecar-binaries-release
**Date:** 2026-10-02 | **Plan:** docs/superpowers/plans/2026-10-02-sidecar-binaries-release.md

1. Task 1: committed ffmpeg/ffprobe binaries are x86_64 on disk under aarch64 names (verified via `file`) — the incident the plan fixes; also `git ls-files` shows 5 binaries + 73 framework dylibs currently tracked (~230 MB) — `git rm -r --cached` in Task 1 Step 12 is load-bearing.
2. Task 1: `audit-sidecars.sh:111` `*"PE32"*) : ;;` silently passes all Windows PE binaries — plan's verify.mjs delegate must add Windows arch checking (Task 3), currently a no-op lane.
3. Task 1: fresh-clone `audit-sidecars.sh:98-101` message says "FAIL binaries dir missing" but does not name `yarn binaries:all` — Review Focus #2 demands the actionable message; wire when delegating to verify.mjs.
4. Task 1/13: after `git rm --cached`, `cargo test` on a fresh clone fails until `yarn binaries:all` runs (frameworks dylibs no longer committed; audit requires them) — intentional gate, failing messages must point there.
5. Task 2: existing pdf.rs tests assert gs-flag MEMBERSHIP, not order (`pdf.rs:697-706, 758-797`) — so `gs_args_without_resources_match_today` (exact vector) is genuinely new, not redundant.
6. Task 2: `bundle-pdf-macos.sh` fingerprint-mismatch abort (`:53-58`) must be bypassed exactly once for the official-lib replacement of `frameworks/libqpdf.30.dylib` (tauri.conf.json:96 hard-lists that filename — replacement must keep the exact name).
7. Task 3: `sidecar_candidates_prefer_triple_then_plain_name` (`sidecar.rs:233-246`) pins `candidates.len()==2` — engine-folder candidates change this; test must be updated, easy to miss.
8. Task 3: run_sidecar spawn chain (`processor.rs:200-207`) has no env hook — PATH prepend requires restructuring into cmd-build → prepend → spawn; helper derives dir from `sidecar_path`.
9. Task 3/spec: §8.2 originally said "qpdf/ffmpeg/ffprobe static" but msvc qpdf ships VC runtime DLLs → engines/qpdf/ layout wins; spec synced during refine.
10. Task 3: platform-config merge semantics (externalBin append vs replace for tauri.windows.conf.json) unresolved until Context7 verification in Task 3 Step 4 — could affect base-conf 5-entry list on Windows.
11. Task 1: plan's "existing tests pin order" claim about gs args was overstated (see #5) — fixed by making the exact-vector test explicit.
12. Spec §7 audited during refine: fetch row no longer claims brew installs; audit row gained explicit `--target` support; both match plan.

---

## Sidecar binaries

### Incident — ffmpeg/ffprobe shipped as x86_64 under aarch64 names (found 2026-10-02)

- **What:** `src-tauri/binaries/ffmpeg-aarch64-apple-darwin` and `ffprobe-aarch64-apple-darwin` were Intel x86_64 Mach-O binaries renamed with the arm64 triple. Verified via `file` before the fix (`Mach-O 64-bit executable x86_64` under both names).
- **Root cause:** the binaries came from evermeet.cx, which distributes x86_64-only builds, and no gate checked architecture — `scripts/audit-sidecars.sh` validated linkage and signatures but never the CPU arch, so a renamed wrong-arch binary passed every check and shipped.
- **Impact:** the built `.app`/`.dmg` carried Intel ffmpeg for Apple Silicon users, running under Rosetta 2.
- **Fix:** manifest-driven fetch (`scripts/binaries.manifest.json` → Martin Riedl pinned arm64 artifacts, sha256-verified) plus an arch gate: `scripts/binaries/verify.mjs` compares `lipo -archs` content against the filename triple; wired into `audit-sidecars.sh` (and thus `cargo test` via `sidecars_are_self_contained`). Regression pinned by the "fails on arch flip fixture (x86 Mach-O under arm64 name)" test in `scripts/binaries/verify.test.mjs`, and at the shell level by `scripts/binaries/audit.test.mjs`; binaries/frameworks are now gitignored build artifacts fetched via `yarn binaries:all`.
- **Follow-up (Task 2):** Ghostscript resources are not bundled — gs resolves resources from the brew Cellar, so PDF compression only works on machines with Homebrew Ghostscript. Tracked in the sidecar-binaries-release plan Task 2.

### Incident — Ghostscript resources were never bundled (resolved 2026-10-03)

- **What:** the `gs` sidecar carried no resource tree. `gs -h` printed its compiled-in search path as `/opt/homebrew/Cellar/ghostscript/10.08.0/share/ghostscript/{Resource/Init,lib,Resource/Font,...}`, so PDF compression worked only where Homebrew Ghostscript happened to be installed at that exact path.
- **Impact:** on a clean user machine PDF compression failed with `Can't find initialization file gs_init.ps`. Invisible in CI and on developer machines, exactly like the ffmpeg arch incident.
- **Fix:** `bundle-pdf-macos.sh` stages `Resource/lib/iccprofiles/fonts` from the build host's brew prefix into `src-tauri/gs-resources/` (a gitignored build artifact); `tauri.conf.json` maps it into the bundle; `sidecar.rs::resolve_gs_resources` resolves the tree across the bundle, dev and resources layouts and `pdf.rs` prepends the `-I` search paths to the gs argument vector.
- **Gates, and what they actually guarantee.** `verify.mjs` fails on an absent or file-less resource tree. `audit-sidecars.sh` runs a clean-room smoke under `env -i HOME=/nonexistent PATH=/usr/bin:/bin` that requires the manifest-declared staged dirs (plus `Resource/Font`) to exist and contain files, then `runlibfile`s four uniquely-named sentinel resources that **only** the staged tree provides — one in `Resource/Init`, one in `lib`, and one in each font dir, so a gutted `fonts/`, `Resource/Font` or `lib` cannot pass. Note that `env -i` alone was never sufficient for this: it does not neutralize gs's compiled-in `GS_LIBDEFAULT`, and two earlier revisions of this gate passed with the font tree emptied (first because only the font-empty check was missing, then because a single sentinel in `Resource/Init` said nothing about the font dirs — `findfont` substitutes silently, which is why a sentinel must live in the font dirs and must be `runlibfile`d, not `loadfont`ed). The guarantee is therefore "the staged tree is what gs resolved its resources from on this host", not "gs was run with no Homebrew available"; the true no-brew case needs a host without Homebrew (CI, per the spec).
- **Manual acceptance with the Homebrew Ghostscript opt prefix and Cellar keg both renamed:** PDF compressed via `gs dpi=72,jpegq=60`, while the same binary without the `-I` flags aborted with exit 1.
- **Related finding — `-sICCProfilesDir` is not a pdfwrite parameter:** the plan specified `-sICCProfilesDir=<dir>`, but gs 10.08 rejects it as a device parameter and dies with `**** Unable to open the initial device, quitting.` (reproduced from the brew dir, a nonexistent dir and every argument position). `Resource/Init/gs_lev2.ps` documents `ICCProfilesDir` as a *user parameter* set from the command line, so the switch is `-uICCProfilesDir=` (gs's user-parameter switch). Pinned by a test that fails if `-sICCProfilesDir` ever reappears.

### Defects found in the gates themselves (2026-10-04, PR review round 2)

Five of the gates added for the two incidents above could not fire, or failed with the wrong diagnosis. All were reproduced live before fixing, and each fix is now pinned by a test that was verified to go red when the guard is reverted.

1. **The executable-bit check never ran.** `assertAllEnginesStaged` wrote `if (!info.mode & 0o111)`, which parses as `(!info.mode) & 0o111` — unary binds tighter than `&`, so the expression is always `0` and the branch never fired. A `chmod 644` engine passed prep. Fixed to `(info.mode & 0o111) === 0`.
2. **A single sentinel could not prove the font tree.** The clean-room smoke `runlibfile`d one sentinel in `Resource/Init`; a tree reduced to that file plus junk passed and rendered with Homebrew's Helvetica, because `findfont` substitutes silently. Three more sentinels now live in `fonts/`, `Resource/Font` and `lib`, and the fixture `runlibfile`s all four, so gutting either font dir or `lib` fails the audit.
3. **The qpdf gate's own remedy was a dead end.** `require_staged_qpdf_lib` told the user to re-run `binaries:fetch`, but fetch's unchanged fast path only compared the staged *binary* sha and returned early, so a deleted `src-tauri/.staging/` was never re-materialised and the user looped. The fast path now also requires the staged lib dir to exist and to match the lock's `libStagedSha256`.
4. **The extracted qpdf lib shipped unpinned.** Nothing hashed the staged lib, so flipping one byte at `0x4000` and re-running prep shipped the tampered dylib with exit 0. fetch now records `libStagedSha256` per staged lib member (symlinks pinned by target, since the official `lib/libqpdf.30.dylib` is one) and the digest is verified twice: as a pre-flight in `prep.mjs`, before any bundle script runs, and again inside `bundle-pdf-macos.sh` before anything is rewritten. It had to be a pre-flight because `bundle-vips-macos.sh` does `rm -rf "$FRAMEWORKS"` and re-collects, so a `bundle-pdf` failure leaves `frameworks/` holding only the vips closure — `cargo test` then cannot even build. A post-collection digest could never work: prep legitimately rewrites install ids and re-signs the collected copy.
5. **The audit blamed the wrong cause for a missing sentinel.** A tree staged before the sentinel existed failed with "missing sentinel means gs fell back to its compiled-in Homebrew prefix", which is a different problem with a different remedy. The audit now asserts the sentinels up front (and prep and verify assert them too) and names `yarn binaries:prep`.

Also fixed: `brew list --versions` lists every installed keg and the active one is last, so both prep and verify compared against a possibly stale keg; brew drift was reported only *after* the bundle scripts had already mutated `frameworks/`; the smoke silently vanished for an explicit `--target` whose `gs` was not staged; and a gs pass failing with no staged resource tree produced an opaque error instead of naming the missing tree.
