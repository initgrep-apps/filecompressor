# Slices 5–8 Acceptance Table — Composite AC → Proving Test Map

Plan: `2026-09-27-slices-5-8-remaining-processors-polish.md` · Task 6 Step 1

Every plan-level acceptance criterion across Slices 5–8 (9 + 8 + 8 + 7 = 32) mapped to its proving test.
Test names are exact, taken from the merged source of PRs #36–#42. Where a plan-specified test name
drifted during review, the shipped name is cited (drift noted). GUI-runtime-only criteria that cannot be
proven by unit test are marked **manual smoke (deferred)** — no hand-waved checks.

## Slice 5 — PDF Compression (plan lines 34–44) — PR #36

| # | Acceptance Criterion | Proving test / evidence | Type |
|---|----------------------|-------------------------|------|
| 1 | Drop a PDF > 2 MB → compresses to ≤ 2 MB, "Done" | `real_pdf_sidecars_compress_oversized_pdf_through_all_passes` (`src-tauri/src/processors/pdf.rs:1302`, ignored real-sidecar smoke; PR #36 validated pass args CLI-level with `qpdf --check` clean) + unit chain of rows 2–5 | automated (ignored smoke) |
| 2 | qpdf lossless first pass → if under target, done | `pdf_pass1_qpdf_lossless_stops_early_when_under_target` (pdf.rs:583) — under-target pass 1 output stops before passes 2–4 | automated |
| 3 | qpdf image optimization second pass → if under target, done | `pdf_pass2_qpdf_image_opt_stops_early` (pdf.rs:626) | automated |
| 4 | Ghostscript /screen preset → if under target, done | `pdf_pass3_gs_screen_stops_early` (pdf.rs:667) | automated |
| 5 | Ghostscript DPI/JPEGQ binary search → if under target, done | `pdf_dpi_jpegq_grid_walks_descending` (pdf.rs:711) — pins 1 /screen pass + full 16-cell ladder `[100,72,50,36]×[60,40,25,15]` descending, early exit on fit (shipped name; plan's `pdf_binary_search_dpi_jpegq_grid` drifted) | automated |
| 6 | All passes fail → "Best effort" with smallest result saved | `pdf_all_passes_fail_returns_best_effort_smallest_output` (pdf.rs:802) — smallest-output selection, never last-wins | automated |
| 7 | Output PDF opens correctly in a PDF viewer | No unit test can open a viewer. Real-sidecar smoke + CLI `qpdf --check` (PR #36) prove structural validity; viewer open **manual smoke (deferred)** | manual smoke (deferred) |
| 8 | Progress shown during compression | `send_progress` per attempt (pdf.rs:268) driven through `ProgressSender`; channel exercised by `pdf_cancel_mid_pass_returns_cancelled_and_cleans_temp` (sleeper sidecar). Percent-bar UI pinned by `renders progress bar from progressByFile while compressing` (FileList.test.tsx, PR #42). PDF-level percent curve during a real run: **manual smoke (deferred)** | automated + manual smoke (deferred) |
| 9 | Reveal in folder works | `reveal button calls onReveal with output path` + `reveal button renders for done/best_effort/already_under_target rows` (FileList.test.tsx, PR #42) → `invoke('reveal_in_folder')` chain (useCompression.ts → commands.rs, shipped Slice 4, PR #32). Finder opening the real folder: **manual smoke (deferred)** | automated + manual smoke (deferred) |

## Slice 6 — Video Compression (plan lines 204–213) — PR #37

| # | Acceptance Criterion | Proving test / evidence | Type |
|---|----------------------|-------------------------|------|
| 1 | Drop an MP4 > 10 MB → compresses to ≤ 10 MB, "Done" | Unit chain: `video_bitrate_formula_matches_spec` + `video_two_pass_commands_constructed_correctly` + `video_over_target_steps_resolution_1080_720_480` (fake-sidecar ladder to fit). No ignored real-ffmpeg smoke exists (unlike image/pdf/document); real encode **manual smoke (deferred)** — sidecars CLI-validated in PR #37 | automated + manual smoke (deferred) |
| 2 | MOV input → re-encoded to MP4 output | `video_mov_input_delivers_queue_resolved_mp4_output` (video.rs:1505) + queue-level `output_file_name_rewrites_mov_to_mp4` + `mov_collision_uses_real_output_name` (queue.rs, review-round-1 regression pin) | automated |
| 3 | Two-pass H.264 encoding with calculated bitrate | `video_bitrate_formula_matches_spec` (`(target*8*0.95)/duration`, u128, tiny-duration/overflow guards) + `video_two_pass_commands_constructed_correctly` (arg-order contract: pass 1 `-an -f mp4 /dev/null -pass 1 -passlogfile`, pass 2 `-c:a aac -b:a 128k -pass 2`) | automated |
| 4 | If over target → reduce resolution (1080p → 720p → 480p) | `video_over_target_steps_resolution_1080_720_480` (video.rs:1336) — ladder applies to BOTH passes, fresh passlogfile prefix per attempt | automated |
| 5 | If still over → increase CRF up to 28 | `video_crf_floor_28_best_effort` (video.rs:1390) — CRF ascends to settings floor (default 28), not hardcoded | automated |
| 6 | Progress parsed from FFmpeg stderr (`time=` / `out_time_ms=`) | `video_progress_parses_time_and_out_time_ms` (both formats, µs units, garbage lines ignored) + `video_progress_percent_clamped_0_to_100` + `video_progress_monotonic_and_ends_at_100` + `drain_*` line-splitter tests (6) | automated |
| 7 | Output MP4 plays correctly | No unit test can verify playback. Structural validity via fake-sidecar size assertions + CLI-validated sidecars (PR #37); playback **manual smoke (deferred)** | manual smoke (deferred) |
| 8 | "Best effort" if can't reach target at CRF 28 / 480p | `video_crf_floor_28_best_effort` — smallest-output selection via `BestAttempt::keep_smaller_in`; error surfacing pinned by `video_total_failure_surfaces_last_attempt_error` | automated |

## Slice 7 — Document Compression (plan lines 308–319) — PR #38

| # | Acceptance Criterion | Proving test / evidence | Type |
|---|----------------------|-------------------------|------|
| 1 | Drop a DOCX > 1 MB → compresses to ≤ 1 MB, "Done" | `document_over_target_lowers_quality_and_retries` (quality-retry loop to fit) + `real_vips_compresses_docx_media_to_target` (ignored real-vips smoke) | automated (incl. ignored smoke) |
| 2 | XLSX and PPTX also work | Same processor path; `document_media_path_identification` pins all three exact media prefixes (`word/media/`, `ppt/media/`, `xl/media/`). Office-app open for xlsx/pptx: **manual smoke (deferred)** | automated + manual smoke (deferred) |
| 3 | Only embedded media (`word/media/`, `ppt/media/`, `xl/media/`) is recompressed | `document_media_path_identification` — exact dirs recompressed, near-miss paths (`word/embeddings/`, root `media/`) untouched | automated |
| 4 | XML and document structure preserved — output opens in Office/LibreOffice | `document_non_media_entries_copied_byte_identical` (round-trip + `[Content_Types].xml` first) + `document_output_opens_valid` (re-read zip: count + names match). Word-open **manual smoke (deferred)** | automated + manual smoke (deferred) |
| 5 | Binary search on media quality, floor Q=40 | `document_media_binary_search_floors_at_q40` — floor wired from `qualityFloors.document.minMediaQuality`, not hardcoded | automated |
| 6 | Re-zipped with DEFLATE level 9 | `document_rezip_uses_deflate_level_9` — method + level verified by re-reading produced zip against level-9/level-6 references | automated |
| 7 | EMF/WMF embedded images: skipped (no error) | `document_emf_wmf_skipped_without_error` — WMF passes through untouched, job Done | automated |
| 8 | "Best effort" if can't reach target | `document_best_effort_delivers_smallest_over_target_attempt` — smallest-output selection | automated |

## Slice 8 — Batch Processing + Cancellation + Polish (plan lines 404–413) — PRs #39 #40 #41 #42

| # | Acceptance Criterion | Proving test / evidence | Type |
|---|----------------------|-------------------------|------|
| 1 | Per-file Cancel stops one mid-job | `compressing row shows cancel instead of remove` + `per-file cancel button calls onCancel with id` (FileList.test.tsx, PR #42) → `cancel_file / cancel_all / reveal_in_folder invoke with camelCase payloads` + `cancel_file failure surfaces a toast error` (useCompression.test.ts:366,414) → `QueueState::cancel_file` token cancel (queue.rs:157). Mid-job kill behavior per processor: `pdf_cancel_mid_pass_returns_cancelled_and_cleans_temp`, `video_cancel_mid_encode_kills_ffmpeg_and_removes_passlogs`, `document_cancel_mid_recompress_cleans_temp_entries` | automated |
| 2 | Cancel All stops remaining queue | `cancel all button visible during compression only` + `cancel all click invokes cancel_all` (CompressView.test.tsx:104,200, PR #39) → `cancel_all failure surfaces a toast error` (useCompression.test.ts:406) → `QueueState::cancel_all` (queue.rs:163) cancels batch + file tokens; remaining Pending rows marked Cancelled via `emit_file_cancelled` | automated |
| 3 | Cancelled files: temp files cleaned, marked "Cancelled" | Marked: `file:cancelled sets cancelled status` (useCompression.test.ts) + `cancelled files represented in summary` (CompressView.test.tsx). Temp cleaned: the three processor cancel tests above (each asserts temp dir empty) + per-job `temp::cleanup_temp_dir` on cancel path (queue.rs:331, verified PR #42) | automated |
| 4 | Batch summary shows live counts | `batch summary counts mixed statuses` (CompressView.test.tsx:137) — exact string `7 files · 3 done · 1 compressing · 1 pending · 1 warning · 1 skipped` (superset of plan's 6-file example: already-under-target counts as done). Live: `summary updates live during compression`. Edge pins: `failed files counted in summary`, `cancelled files represented in summary`, `already under target counted as done in summary` | automated |
| 5 | Toast on batch complete | `batch complete toast shows total saved bytes` (CompressView.test.tsx:211) + `toast success says compressed N files with done count` (doneCount, not total) + zero-processed suppression `cancelled files are not counted and a zero-count batch suppresses the success toast` (useCompression.test.ts) | automated |
| 6 | Toast on errors: "N files could not reach target." | `error count toast shows count when errors accumulated` (CompressView.test.tsx:232) — pins exact wording `2 files could not reach target.`; accumulation tests `error count accumulates file:error events and reaches onBatchComplete` / `resets between batches` / `ignores unknown fileIds` (useCompression.test.ts, PR #40) | automated |
| 7 | Stale temp files (>24h) cleaned on app launch | `cleanup_stale_temp_files_removes_only_dirs_older_than_24h`, `..._keeps_dir_at_exact_24h_boundary`, `..._removes_stale_regular_files_not_fresh_ones`, `..._keeps_dir_with_future_mtime`, `..._safe_when_app_temp_missing`, `cleanup_temp_dir_removes_directory_tree` / `_no_op_on_missing_path` / `_idempotent_after_removal` (temp.rs, 8 tests). Launch hook `lib.rs:43` `.setup()`. Restart phase of the plan's manual procedure: **manual smoke (deferred)** | automated + manual smoke (deferred) |

## Bonus pins (not plan ACs, guard the ACs)

| Concern | Test |
|---------|------|
| Output-folder preflight (Slice 8 Task 5) | `queue_batch_unwritable_folder_emits_batch_error_and_processes_nothing`, `queue_batch_creates_missing_output_folder`, `queue_batch_create_dir_fails_emits_cannot_create_error`, `write_test_file_removed_after_preflight`, `preflight_skips_when_folder_already_writable` (queue.rs, PR #41) |
| Sidecar paths reach qpdf+gs (Slice 5 trait refactor) | `sidecar_paths_reaches_both_qpdf_and_gs` (sidecar.rs:313) |
| Sidecar self-containment audit gate | `sidecars_are_self_contained` (sidecar.rs, runs in `cargo test`) + `bash scripts/audit-sidecars.sh` → PASS |
| Best-effort status mapping | `decide_result_status_maps_unmet_target_to_best_effort` etc. (queue.rs) |
| Real-sidecar end-to-end smokes (ignored, run locally) | `real_vips_compresses_oversized_jpeg_to_target` (image.rs), `real_pdf_sidecars_compress_oversized_pdf_through_all_passes` (pdf.rs), `real_vips_compresses_docx_media_to_target` (document.rs) |

## Deferred manual smoke list (GUI-runtime only)

1. Output PDF opens in a viewer (Slice 5 AC7)
2. PDF percent-curve visible during real compression (Slice 5 AC8)
3. Finder/reveal opens the real folder (Slice 5 AC9)
4. Real MP4 encode ≤ target + playback (Slice 6 AC1, AC7)
5. XLSX/PPTX/DOCX open in Office/LibreOffice (Slice 7 AC2, AC4)
6. Stale-temp cleanup across an app restart (Slice 8 AC7 restart phase)
