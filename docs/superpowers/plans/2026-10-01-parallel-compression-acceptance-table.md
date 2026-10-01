# Parallel Batch Compression Acceptance Table — Spec §2 Decisions + §3 Invariants → Proving Test Map

Plan: `2026-10-01-parallel-compression.md` · Task 6 Step 3
Spec: `2026-10-01-parallel-compression-design.md`

Every spec §2 decision and §3 invariant plus every plan Task 1–5 acceptance criterion mapped to its
named proving test. Test names are exact, grepped from the merged source of PRs #53–#57 on this
branch — where a spec/plan test name drifted during review, the shipped name is cited (drift noted
in the drift table below). Criteria that only a running GUI can prove are listed under
**Deferred manual smoke** — Task 6 Step 4 was NOT executed by the implementing agent; it remains
for the user. No hand-waved checks.

## Spec §2 — Decisions (locked 2026-10-01)

| # | Decision | Proving test / evidence | Type |
|---|----------|-------------------------|------|
| 1 | Scheduling model — category lanes: same-category sequential, cross-category parallel | `same_category_never_runs_two_at_once` (scheduler.rs:192 — max same-lane concurrency 1) + `lanes_dispatch_oldest_first_within_budget` (scheduler.rs:204) + queue-level `video_occupies_two_slots_image_waits_at_n2` (queue.rs:1038) | automated |
| 2 | Concurrency bound — global weighted slot budget N | `never_exceeds_slot_budget` (scheduler.rs:281 — observed max in-flight weight == 2 at N=2) + `video_occupies_two_slots_video_plus_two_images_fill_n4` (scheduler.rs:216 — observed max weight == 4 at N=4) | automated |
| 3 | How N is decided — Auto + manual override (`Auto / 1 / 2 / 3`, default Auto) | `performance_defaults_to_auto` (settings.rs:345) + `resolve_max_concurrent_manual_verbatim` (settings.rs:363) + `resolve_max_concurrent_auto_clamps_cores` (settings.rs:351) + UI `performance select renders four options` (SettingsView.test.tsx:326) | automated |
| 4 | Auto computation — `clamp(logical cores / 2, 1, 4)` via `std::thread::available_parallelism()`, cores only, zero new deps | `resolve_max_concurrent_auto_clamps_cores` (settings.rs:351 — injectable cores: 1→1, 2→1, 3→1, 4→2, 8→4, 16→4, 0→1; error→1 pinned in `performance_defaults_to_auto`); `Cargo.toml` diff for Tasks 1–5 adds no deps (reviewed in PRs) | automated |
| 5 | CPU-heavy files — video = 2 slots, all other categories = 1 | `two_videos_do_not_overlap_at_n3` (scheduler.rs:234) + `two_videos_do_not_overlap_even_at_n4` (scheduler.rs:327) + `video_occupies_two_slots_video_plus_two_images_fill_n4` (scheduler.rs:216) + queue `video_occupies_two_slots_image_waits_at_n2` (video lane drains both files before image dispatches) | automated |
| 6 | Cleanup on cancel — per-job, unchanged; slots freed only AFTER temp cleanup completes | `cancel_all_across_lanes_cleans_each_jobs_temp_and_frees_slots` (queue.rs:1124 — temp-dir snapshot diff empty after cancel + a follow-up batch runs to completion proving slots freed) + scheduler-level `frees_slots_as_soon_as_jobs_finish` (scheduler.rs:339 — next dispatch happens only after prior job's exit probe) | automated |
| 7 | Frontend compress UI — zero changes (events already per-file keyed) | No new IPC commands/events (grep `emit(` in queue.rs diff shows only existing topics); existing compress-UI suites stayed green untouched (146/146 frontend tests in gate); end-to-end events pinned by `n1_matches_legacy_sequential_order` + `parallel_same_name_outputs_get_suffixes_end_to_end` | automated (suite green) |

## Spec §3 — Architecture invariants

| Invariant | Proving test / evidence | Type |
|-----------|-------------------------|------|
| 3.1 One sidecar binary file per engine; each job spawns a process; budget caps live process count; nothing duplicated on disk | Structural: `sidecars_are_self_contained` (sidecar.rs) + `tauri_conf_json_lists_all_sidecar_engines_as_external_bin` (sidecar.rs) prove binaries untouched; budget capping live processes is enforced by the slot math proven in §2 rows 2 & 5. Real-process CPU/RAM observation: **manual smoke (deferred)** | automated + manual smoke (deferred) |
| 3.2 FIFO lane per category, drop order preserved | `lanes_dispatch_oldest_first_within_budget` (scheduler.rs:204 — dispatch log `[image:a, pdf:p, image:b]`) + queue `video_occupies_two_slots_image_waits_at_n2` (completion order == batch order) | automated |
| 3.2 Within a lane strictly sequential — never two files of one category at once | `same_category_never_runs_two_at_once` (scheduler.rs:192) | automated |
| 3.2 Across lanes parallel, bounded by N weighted slots | `never_exceeds_slot_budget` (scheduler.rs:281) + `lanes_dispatch_oldest_first_within_budget` (scheduler.rs:204) | automated |
| 3.2 Slot weights — video = 2, image/pdf/document = 1; two videos overlap only at N ≥ 4 | `video_occupies_two_slots_video_plus_two_images_fill_n4` (scheduler.rs:216) + `two_videos_do_not_overlap_at_n3` (scheduler.rs:234) + `two_videos_do_not_overlap_even_at_n4` (scheduler.rs:327 — same-lane sequencing holds even when budget would allow it) | automated |
| 3.2 N = 1 degenerates to exactly today's behavior, original batch order (no lane grouping) | `n1_matches_legacy_sequential_order` (queue.rs:1014 — `file:error` order == batch order, then `batch:complete`; MockRuntime, missing sidecars = deterministic events) | automated |
| 3.3 Settings key `{ performance: { maxConcurrent } }`, values auto/1/2/3, default auto | `performance_serde_roundtrip_camel_case` (settings.rs:376 — `maxConcurrent` key pinned in serialized JSON) + `performance_defaults_to_auto` (settings.rs:345) | automated |
| 3.3 Missing `performance` key in existing stores → default auto | `parse_settings_value_missing_performance_fills_default` (settings.rs:385) + `parse_settings_value_corrupt_performance_fills_default` (settings.rs:392) | automated |
| 3.3 Auto resolution at batch start in Rust; manual values verbatim | `resolve_max_concurrent_auto_clamps_cores` (settings.rs:351, pure `resolve_max_concurrent_from(cores)`) + `resolve_max_concurrent_manual_verbatim` (settings.rs:363); batch-start call site is `process_batch` (`resolve_max_concurrent()` before the N=1/lanes branch, queue.rs) | automated |
| 3.3 Settings UI — Performance Card with `Simultaneous files` Select, wired through existing draft/save flow | `performance select renders four options` (SettingsView.test.tsx:326 — options `Auto · 1 · 2 · 3`) + `changing performance updates draft and enables save` (SettingsView.test.tsx:339 — Save enabled after pick; `save_settings` payload carries `performance.maxConcurrent === "2"`) + `renders four cards with card composition` (SettingsView.test.tsx:279 — 4 cards incl. Performance, titles pinned) | automated |
| 3.4 (1) Per-file cancel / Cancel All → token fires → sidecar killed → processor returns | Pre-existing processor cancel pins, unchanged: `pdf_cancel_mid_pass_returns_cancelled_and_cleans_temp` (pdf.rs:1129), `video_cancel_mid_encode_kills_ffmpeg_and_removes_passlogs` (video.rs:1438), `document_cancel_mid_recompress_cleans_temp_entries` (document.rs:1437) | automated |
| 3.4 (2) Scheduler runs the job's temp cleanup BEFORE releasing its slots — cancelled video frees 2 slots only after passlog/temp gone | `cancel_all_across_lanes_cleans_each_jobs_temp_and_frees_slots` (queue.rs:1124 — snapshot of `file-compressor` temp root unchanged after cancelled batch, then second batch starts and completes) + `frees_slots_as_soon_as_jobs_finish` (scheduler.rs:339) | automated |
| 3.4 (3) Cancelling one job never cleans or stops other lanes | `single_failure_does_not_stop_lane_or_batch` (queue.rs:1192 — all 3 files still process after first error) + scheduler `panicking_job_does_not_kill_batch_or_sum` (scheduler.rs:298) | automated |
| 3.4 (4) Launch-time stale cleanup (>24h) unchanged | temp.rs suite untouched and green: `cleanup_stale_temp_files_removes_only_dirs_older_than_24h`, `cleanup_stale_temp_files_keeps_dir_at_exact_24h_boundary`, `cleanup_stale_temp_files_removes_stale_regular_files_not_fresh_ones`, `cleanup_stale_temp_files_keeps_dir_with_future_mtime`, `cleanup_stale_temp_files_safe_when_app_temp_missing`, `cleanup_temp_dir_removes_directory_tree`, `cleanup_temp_dir_no_op_on_missing_path`, `cleanup_temp_dir_idempotent_after_removal` | automated |
| 3.5 Error isolation — one failing job affects only its own row; batch:complete still fires exactly once; total_saved sums successes | `single_failure_does_not_stop_lane_or_batch` (queue.rs:1192) + `batch_complete_fires_once_after_all_lanes_drain` (queue.rs:1214 — exactly one emission, `totalSavedBytes` numeric) + scheduler `drains_to_empty_and_returns_sum` (scheduler.rs:271 — summed output 14) + `panicking_job_does_not_kill_batch_or_sum` (scheduler.rs:298) | automated |
| 3.6 Reserved-name registry — per-batch claims, suffix exactly as today, claims live for batch lifetime | `reserved_registry_two_claims_same_name_get_suffix` (output.rs:202 — second/third claims suffix `-1`/`-2` with disk untouched) + `reserved_registry_disk_collision_still_suffixes` (output.rs:224) + `reserved_registry_cross_batch_isolated` (output.rs:214) + `reserved_registry_different_folders_isolated` (output.rs:233) + `reserved_registry_fs_error_falls_back_to_uuid` (output.rs:272) + end-to-end `parallel_same_name_outputs_get_suffixes_end_to_end` (queue.rs:1235 — two zero-media `report.docx` at N=2 → `{report.docx, report-1.docx}` both complete) | automated |
| 3.6 No TOCTOU between membership check and insert (single mutex lock) | `reserved_registry_concurrent_claims_all_unique` (output.rs:244 — 8 OS threads claim `photo.jpg` concurrently → 8 unique names, no duplicates) | automated |

## Spec §5 — Backward-compatibility parity rule

| Criterion | Proving test / evidence | Type |
|-----------|-------------------------|------|
| `maxConcurrent = "1"` behaves indistinguishably from today: same completion order (original batch order), same events, same statuses | `n1_matches_legacy_sequential_order` (queue.rs:1014) — N=1 completion order equals batch order verbatim; legacy sequential loop kept in `process_batch` (`max_concurrent <= 1` branch) | automated |

## Plan Task AC blocks (Tasks 1–5)

### Task 1 — Settings backend

| # | Acceptance Criterion | Proving test |
|---|----------------------|--------------|
| 1 | `Performance` struct serializes camelCase, roundtrip pinned | `performance_serde_roundtrip_camel_case` (settings.rs:376) |
| 2 | Missing/corrupt `performance` key → `"auto"` via serde default | `parse_settings_value_missing_performance_fills_default` (settings.rs:385) + `parse_settings_value_corrupt_performance_fills_default` (settings.rs:392) |
| 3 | Truth table pinned with injectable cores, no env dependence | `resolve_max_concurrent_auto_clamps_cores` (settings.rs:351) + `performance_defaults_to_auto` (settings.rs:345) + `resolve_max_concurrent_manual_verbatim` (settings.rs:363) |
| 4–5 | Required tests pass; gate clean | Full gate green (see Gate evidence below) |

### Task 2 — Reserved-name registry

| # | Acceptance Criterion | Proving test |
|---|----------------------|--------------|
| 1 | Two sequential claims, same fresh name, one registry, neither file on disk → `name.ext` then `name-1.ext` | `reserved_registry_two_claims_same_name_get_suffix` (output.rs:202) |
| 2 | On-disk files still collide exactly as today (existing tests untouched) | Pre-existing output tests unchanged + green: `fresh_dir_returns_unchanged_filename` (output.rs:128), `collision_appends_dash_one_suffix` (output.rs:135), `collision_increments_suffix_to_dash_two_when_dash_one_taken` (output.rs:143), `collision_overflow_taken_returns_unique_nonexistent_path` (output.rs:163), `collision_overflow_taken_without_extension_returns_unique_nonexistent_path` (output.rs:183), `collision_handles_file_without_extension` (output.rs:289) + `reserved_registry_disk_collision_still_suffixes` (output.rs:224) |
| 3 | Existing `resolve_output_path` signature/behavior unchanged | Thin delegate over the shared core; pinned by all pre-existing tests above |
| 4 | Registry claim atomic under one mutex lock (no TOCTOU) | `reserved_registry_concurrent_claims_all_unique` (output.rs:244) |
| 5 | Required tests pass; gate clean | Full gate green |

### Task 3 — Scheduler core

| # | Acceptance Criterion | Proving test |
|---|----------------------|--------------|
| 1 | Never more than `max_slots` weight in flight | `never_exceeds_slot_budget` (scheduler.rs:281) + `video_occupies_two_slots_video_plus_two_images_fill_n4` (scheduler.rs:216) |
| 2 | Same-lane jobs never overlap | `same_category_never_runs_two_at_once` (scheduler.rs:192) + `two_videos_do_not_overlap_at_n3` (scheduler.rs:234) + `two_videos_do_not_overlap_even_at_n4` (scheduler.rs:327) |
| 3 | Oldest-lane-first dispatch order | `lanes_dispatch_oldest_first_within_budget` (scheduler.rs:204) |
| 4 | `should_stop` flips → remaining jobs skipped via `on_skipped`, in-flight run to completion, sum reflects completed only | `stop_hook_skips_remaining_and_sums_completed` (scheduler.rs:245) + `stop_before_start_skips_everything` (scheduler.rs:311) |
| 5 | Required tests pass; gate clean | Full gate green |

### Task 4 — Queue wiring

| # | Acceptance Criterion | Proving test |
|---|----------------------|--------------|
| 1 | N=1 → identical completion order/events/statuses (§5 parity) | `n1_matches_legacy_sequential_order` (queue.rs:1014) |
| 2 | Lane path: Pending files grouped into per-category FIFO lanes preserving batch order; same category never concurrent; budget honored with video weight 2 | `video_occupies_two_slots_image_waits_at_n2` (queue.rs:1038) |
| 3 | Cancel-all mid-batch: in-flight finish as Cancelled + cleaned; not-started marked Cancelled + `file:cancelled` emitted; no Pending left | `cancel_all_mid_batch_marks_pending_cancelled_across_lanes` (queue.rs:1059) |
| 4 | Temp cleanup still runs per job before its slots release | `cancel_all_across_lanes_cleans_each_jobs_temp_and_frees_slots` (queue.rs:1124) + `frees_slots_as_soon_as_jobs_finish` (scheduler.rs:339) |
| 5 | `batch:complete` fires exactly once after all lanes drain, summed `total_saved_bytes` | `batch_complete_fires_once_after_all_lanes_drain` (queue.rs:1214) |
| 6 | One failing job does not stop other lanes | `single_failure_does_not_stop_lane_or_batch` (queue.rs:1192) |
| 7 | Unsupported entries (no processor) skip with `file:complete` status `unsupported`, return 0 saved | Code path pinned structurally: `registry_lookup_matches_category` (processors/mod.rs:104 — `get_processor(Category::Other)` → `None`) + `process_single_job` unsupported arm emits `file:complete` with `FileStatus::Unsupported` and returns 0 (queue.rs:360–382). No dedicated end-to-end unsupported-through-queue unit test exists — noted as a residual gap, not hand-waved |
| 8 | Required tests pass; gate clean | Full gate green |

### Task 5 — Settings frontend

| # | Acceptance Criterion | Proving test |
|---|----------------------|--------------|
| 1 | Performance Card renders between Category Targets and Quality Floors with 4-option Select, label `Simultaneous files` | `renders four cards with card composition` (SettingsView.test.tsx:279 — all four card titles incl. Performance) + `performance select renders four options` (SettingsView.test.tsx:326 — options exactly `Auto · 1 · 2 · 3` under `Simultaneous files`) |
| 2 | Selecting updates draft; Save persists; hasChanges flips | `changing performance updates draft and enables save` (SettingsView.test.tsx:339) |
| 3 | Existing settings tests stay green | Migrated SettingsView suite green in gate (16 pre-existing scenarios) |
| 4 | Required tests pass; gate clean | Full gate green |

## Test-name drift (spec §7 / plan → shipped)

| Spec/plan name | Shipped name |
|---|---|
| `auto_n_derivation_table` (spec §7) | `resolve_max_concurrent_auto_clamps_cores` |
| `manual_n_used_verbatim` (spec §7) | `resolve_max_concurrent_manual_verbatim` |
| `single_lane_failure_does_not_stop_others` (spec §7) | `single_failure_does_not_stop_lane_or_batch` |
| `parallel_same_name_outputs_get_suffixes` (spec §7) | `parallel_same_name_outputs_get_suffixes_end_to_end` |
| `cancel_all_across_lanes_cleans_each_jobs_temp_and_frees_slots` (spec §7) | shipped verbatim (added in Task 4 review) |
| Plan Task 1 test names | shipped verbatim; review added `parse_settings_value_corrupt_performance_fills_default` |

## Bonus pins (not plan ACs, guard the ACs)

| Concern | Test |
|---------|------|
| In-flight weight probe on the scheduler core | `video_occupies_two_slots_video_plus_two_images_fill_n4` also pins `probe.max_weight() == 4` |
| Panic isolation inside the scheduler core | `panicking_job_does_not_kill_batch_or_sum` (scheduler.rs:298) |
| Stop fired before any dispatch | `stop_before_start_skips_everything` (scheduler.rs:311) |
| Slot release timing on the core | `frees_slots_as_soon_as_jobs_finish` (scheduler.rs:339) |
| Concurrent registry claim storm | `reserved_registry_concurrent_claims_all_unique` (output.rs:244) |
| Registry fs-error fallback | `reserved_registry_fs_error_falls_back_to_uuid` (output.rs:272) |
| Corrupt `performance` value fallback | `parse_settings_value_corrupt_performance_fills_default` (settings.rs:392) |
| Queue-level cancel + temp/slot proof | `cancel_all_across_lanes_cleans_each_jobs_temp_and_frees_slots` (queue.rs:1124) |

## Gate evidence (Task 6, this branch, worktree run 2026-10-01)

- `yarn install --frozen-lockfile` — OK
- `yarn build` — OK (Rolldown production build)
- `yarn test` — `Test Files 11 passed (11)` / `Tests 146 passed (146)`
- `cd src-tauri && cargo test` — `225 passed; 0 failed; 4 ignored` (4 ignored = real-sidecar smokes)

## Deferred manual smoke (GUI-runtime only — NOT executed by Task 6; remains for the user)

Plan Task 6 Step 4 procedure, deferred:

1. `yarn tauri dev`: add 10 mixed files (images + videos + pdf + docx) at default Auto → observe
   2+ rows `compressing` simultaneously; summary counts shift live; single `batch:complete` toast.
2. Cancel All mid-flight → remaining rows Cancelled; no temp leftovers
   (`ls $(getconf DARWIN_USER_TEMP_DIR)/file-compressor/` shows no orphan dirs); slots freed
   (next batch runs).

No unit test can observe a real GUI at runtime; these stay user-executed manual smoke — not faked.
