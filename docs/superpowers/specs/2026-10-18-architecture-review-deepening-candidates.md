# Architecture Review — Deepening Candidates

**Date:** 2026-10-18
**Status:** Survey / research backlog. No candidate approved; no design decisions made. Deferred for later research — pick a candidate, then run the grilling loop before any interface design.
**Scope:** `src/` (frontend), `src-tauri/src/` (Rust core), light pass on `scripts/binaries/`.
**Method:** commit-history hotspot walk + full read of Rust core modules, four processors, frontend provider/hooks/types, sidecar pipeline; every friction claim spot-verified by grep before inclusion.

Vocabulary (`codebase-design`): **module / interface / implementation / depth / seam / adapter / leverage / locality**; deletion test; one adapter = hypothetical seam, two = real. Domain vocabulary in `GLOSSARY.md` (Engine, Sidecar, Manifest, Lock, Staged binaries, Gate, lane — note: "lane" not yet in glossary, see §3).

---

## 1. Candidates

Ranked by evidence strength × expected leverage.

### 1.1 Collapse the compression ladder into one deep engine module — **Strength: Strong · in-process**

**Files:** `src-tauri/src/processors/pdf.rs:284-356`, `video.rs:786-840` + `845-896` (two loops in one file), `image.rs:211-355`, `document.rs:398-528`; primitives already exist in `engine/processor.rs:218-301`.

**Evidence (verified):**
- The loop shape *cancel-check → temp file → run pass → if-fits deliver → else BestAttempt keep-smaller → else last_error → remove_all* is written five times.
- Byte-identical helpers: `remove_all` ×3 (`pdf.rs:210`, `video.rs:343`, `document.rs:193`); `measure_output` ×2 with identical "sidecar produced an empty output" copy (`pdf.rs:177`, `video.rs:301`); binary quality search ×2 (`image.rs:131`, `document.rs:274`); vips save options ×2 (`image.rs:59`, `document.rs:91`).
- `deliver_or_cancel` (`document.rs:226-265`) closes the cancel-after-delivery window — but only for document; image/pdf/video deliver at loop end relying on the loop-top token check for the same race.

**Problem:** one algorithm expressed only by duplication — five shallow copies of an implicit interface no named module owns.

**Solution sketch:** engine layer owns the ladder (temp attribution, cancel checks, keep-smaller bookkeeping, terminal delivery incl. `deliver_or_cancel` ownership rules); processors shrink to pass-spec construction (args builders, strategy/quality labels, per-engine output validation).

**Deletion test:** complexity reappears in 5 callers today → after extraction the loop vanishes from four files.

**Test impact:** ladder matrix (cancel mid-loop, failing pass doesn't abort ladder, best-effort fallback, zero-byte rejection) currently tested four times in four dialects (~4,920 processor test lines). One seam = matrix tested once per engine family.

### 1.2 Give the runner seam the two capabilities video rebuilt — **Strength: Strong · ports & adapters**

**Files:** `src-tauri/src/processors/video.rs:388-413` (`poll_child_exit`), `418-477` (`run_ffprobe`), `544-617` (`run_ffmpeg_with_progress`) vs canonical runner `engine/processor.rs:218-319`.

**Evidence (verified):**
- `poll_child_exit` is a line-for-line copy of the poll/kill/reap loop inside `run_sidecar`, including kill→wait→`Cancelled` ordering.
- stderr drain thread closure written three times (`processor.rs:237-245`, `video.rs:442-460`, `video.rs:564-589`).
- Duplicated constants: `WAIT_POLL_MILLIS = 30` (`processor.rs:30` + `video.rs:50`), two 5-s join-timeout constants (`STDERR_JOIN_TIMEOUT`, `FFMPEG_JOIN_TIMEOUT`).

**Problem:** the deep sidecar seam's interface doesn't stretch to "pipe stdout" or "stream stderr as progress", so video — the only engine needing both — rebuilt the seam shallowly; the two poll loops can drift.

**Solution sketch:** enrich the engine runner with a capture-stdout variant and a stderr-line-callback variant; `run_ffprobe`/`run_ffmpeg_with_progress`/`poll_child_exit` collapse into engine code; video returns to args + pass policy.

**Invariant to preserve:** Windows `engines/<engine>/` PATH-fronting (`sidecar.rs:122-135`, pinned by `processor.rs:345-374` tests) — the enriched runner wraps, never bypasses.

**Test impact:** subprocess interactions are today untestable without real ffmpeg binaries; a single runner seam admits fake-child tests (sleep-forever script → cancel kills; chatty script → drain; exit-2 → error tail).

### 1.3 One terminal-outcome sink for the job lifecycle — **Strength: Strong · in-process**

**Files:** `src-tauri/src/queue.rs:435-708` (`process_single_job`, ~273 lines; eight near-copies of the terminal block at 450-460, 467-472, 490-499, 509-541, 546-576, 618-663, 665-674, 675-703); state machine also mutates in `commands.rs:202-227`, `queue.rs:847-855` (`cancel_skip_entry`), `scheduler.rs:58-64`.

**Problem:** the `Pending → Compressing → Done/BestEffort/Failed/Cancelled/Unsupported` lifecycle fails locality — each terminal block re-states *lock list → find entry → set status/error → record_file → emit → remove_token*, and the same machine is mirrored twice in TS (`useCompression.ts:159-225`, `grouping.ts:45-54`). Adding one terminal status touches every copy.

**Solution sketch:** one terminal-outcome sink ("job completed with outcome X: set final state, write history record once, emit the event, release the token"); cancel bookkeeping rides the same sink.

**Deletion test:** the eight copies collapse into the sink; QueueState drops two of its four Mutexes.

**Test impact:** ~1,830 `queue.rs` test lines already pin exactly-once finalization; those assertions become sink unit tests plus the existing batch integration tests.

### 1.4 One classification source; delete the dead registry interface — **Strength: Strong · in-process**

**Files:** `src-tauri/src/detection.rs:19-32`; `ProcessorRegistry` map-building `processors/mod.rs:27-66` (`lookup` has **zero production callers** — grep-verified, only `mod.rs` tests); `supported_extensions` ×4 (`image.rs:173`, `video.rs:661`, `pdf.rs:243`, `document.rs:313`); output-name rules overlap (`queue.rs:53-69` vs `image.rs:45-54`).

**Problem:** answering "which files are images / what's the output name" requires four files; the registry maintains a second copy of classification knowledge through an interface nobody in production calls — a hypothetical (one-adapter) seam.

**Solution sketch:** detection consumes `supported_extensions` as the single authored list; output-extension rewrite lives beside it; the dead `extension_map`/`lookup` half is deleted.

**Deletion test:** the registry's dead half passes trivially — complexity vanishes.

**Test impact:** one exhaustive consistency property becomes possible ("every extension a processor claims is detectable; every detected category has a processor") — currently unassertable while copies exist.

### 1.5 Make the IPC contract honest at one seam — **Strength: Worth exploring · ports & adapters**

**Files:** `src/types.ts:29-84`, `src-tauri/src/models.rs:44-55`, `src/hooks/useFileList.ts:36-40`, `src/hooks/useCompression.ts:23-57`.

**Evidence (verified):** TS `FileEntry` declares `strategyUsed`/`qualityUsed`; Rust `FileEntry` (serde camelCase) returns neither from `add_files` — `useFileList.ts:39` patches the fields post-invoke (`{ ...e, strategyUsed: null, qualityUsed: null }`) to make the IPC result fit the TS type. Drift has already shipped. Six payload interfaces mirror `queue.rs:82-121` event payloads by hand; three `toMessage` helper variants across hooks.

**Solution sketch (friction statement only):** one shared payload-types module + a round-trip sample test (emit sample `file:complete` via MockRuntime wiring tests, assert exact JSON matches TS declarations), so serde renames fail a test instead of getting patched.

**Test impact:** `wiring_tests` in `lib.rs:132-177` already exercise real IPC dispatch — extend cheaply.

### 1.6 Move history orchestration out of QueueState — **Strength: Worth exploring · ports & adapters**

**Files:** `history.rs:625-747` (the store itself is deep, ~800 impl / ~2,700 test lines — leave); orchestration welded into `queue.rs:247-303` (`record_file` buffering), `797-829` (`append_history` + warn-once `history_error_sent`), `710-757` (`finish_batch` trim/dedupe); hand-written category→key matches ×4 (`queue.rs:766-777`, `queue.rs:857-866`, `commands.rs:143-152`, detection defaults) re-implementing what serde already does.

**Solution sketch:** a small history writer (write record, warn-once per session id, emit `history:error` on first failure) + serde `as_str()` enum helpers deleting the key-match copies.

**Test impact:** warn-once/emit-once becomes directly unit-testable against a temp-dir store (`history.rs:631` `new_in` exists for exactly this).

### 1.7 Resolve Sidecar paths once, behind an injectable seam — **Strength: Worth exploring · local-substitutable**

**Files:** `src-tauri/src/queue.rs:583-609` — `resolve_all_sidecar_paths()` runs **inside `process_single_job`** (per-job filesystem re-probe for 5 engines + gs-resources); `engine/processor.rs:321-337` — trait method with 8 parameters + `#[allow(clippy::too_many_arguments)]`; `SidecarPaths` (84-93) = 6 Option fields; every processor then calls `require(...)`.

**The code's own confession (quote, `queue.rs` ~lines 600-608):** *"A portable test trigger is hard: happy-path exe dirs always resolve… the failure shape is pinned indirectly."*

**Problem:** resolution runs eagerly at the shallowest layer, passed as loose data; neither the queue nor the trait owns it; the failure path has no failable seam (textbook local-substitutable dependency — tempdir fake exists, unexploited).

**Solution sketch (friction only):** resolve once per batch (or app lifetime) at a seam the queue can inject; the eight loose parameters collapse into what `SidecarPaths` already models.

**Test impact:** existing failure-assertion tests (e.g. `n1_matches_legacy_sequential_order`, `queue.rs:1367`) currently *depend* on resolution failing accidentally; with an injected fake they assert failures deliberately.

### 1.8 Progress-percent semantics: let the ladder own the scale — **Strength: Speculative · in-process**

**Files:** `image.rs:154` (`iter·100/max`, cap 90) + `image.rs:313` (hardcoded 92); `pdf.rs:299` (`index·95/total`); `video.rs:720-723` + `747,764-767`; `document.rs:267-272` (per-media units table); terminal 100 via `deliver_output` (`processor.rs:164`).

**Problem:** four local percent-slicing conventions encode one unwritten invariant ("sub-terminal < 100; 100 reserved for delivery"). Plumbing path itself is deep and centralized — only the semantics are folklore.

**Solution sketch:** folds into 1.1 when it lands — the engine owns attempt counting, so it allocates percent. Not a standalone project.

---

## 2. Deep already — do not propose touching

`sidecar.rs` (~345 impl / ~965 test lines) · `scheduler.rs` (98 impl lines, closure-decoupled lanes) · `engine/progress.rs` · `engine/result.rs` (exhaustive error copy table, no wildcard) · `output.rs` (ReservedNames) · `temp.rs` (injectable clock) · `history.rs` store · `settings.rs` · `models.rs` · `detection.rs` itself · `useCompression.ts` (333 impl / 856 test lines) · `grouping.ts` (total-function buckets + compile-time lane check) · `scripts/binaries/lib.mjs` (824 lines; consumers import rather than re-implement; 18 test files ≈ 9,600 lines).

One minor wart: `gsResourcesDir` defined in both `verify.mjs:72-74` and `prep-windows.mjs:39-41`.

---

## 3. Glossary / ADR notes

- **ADR 0001 (sidecar freeze bundles):** no candidate re-litigates it. Candidate 1.2 must preserve the Windows `engines/<engine>/` PATH-front invariant — enrichment wraps `sidecar.rs`, never bypasses.
- **GLOSSARY gap:** "lane" is used for both the scheduler's weighted execution lane (`scheduler.rs:22-26`) and the UI category column (`grouping.ts:21`, KanbanBoard). They coincide today (both keyed by category) but the relationship is undefined — add a glossary entry during 1.3/1.4 work.
- **Windows gate:** all candidates touch `src-tauri/src/` → `cargo check --all-targets --target aarch64-pc-windows-msvc` before push (`docs/ci-process.md`).

---

## 4. Top recommendation

**1.1 — Collapse the compression ladder into one deep engine module.** Largest locality × leverage: one interface replaces five duplicated loops, one cancel/ownership invariant closes the delivery race everywhere, one test matrix replaces four dialects. **Sequencing:** land 1.2 first as the enabling step (same seam, lower risk, runner variants) — then 1.1 absorbs the ladder.

---

## 5. Process when resumed

1. Pick a candidate → grilling loop (constraints, dependencies, seam shape, what tests survive).
2. Side effects inline: new terms → `GLOSSARY.md`; load-bearing rejections → ADR; alternative interfaces → design-it-twice.
3. Old shallow-module unit tests get deleted once tests at the deepened interface exist (replace, don't layer).