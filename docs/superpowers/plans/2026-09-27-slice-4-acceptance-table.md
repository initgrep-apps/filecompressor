# Slice 4 Acceptance Table — Image Compression AC → Proving Test Map

Plan: `2026-09-27-slice-4-image-compression.md` · Task 8 Step 1

All 13 plan-level acceptance criteria (plan lines 2288–2300) mapped to their proving test.
Test names are exact, taken from the merged source of PRs #25–#33. Where a criterion is
GUI-runtime-only and cannot be proven by unit test, it is marked **manual smoke (deferred)** —
no hand-waved checks. Full gate run evidence: `yarn build` clean, `yarn test` 116/116,
`cargo test` 194 passed / 0 failed / 4 ignored (real-sidecar smokes).

## Slice 4 — Image Compression (plan lines 2288–2300) — PRs #25–#33

| # | Acceptance Criterion | Proving test / evidence | Type |
|---|----------------------|-------------------------|------|
| 1 | JPEG > 200 KB → compresses to ≤ 200 KB, "Done" | `binary_search_finds_highest_quality_meeting_target` (image.rs:442) pins the fit-to-target search; `zero_byte_vips_output_is_rejected_not_delivered` (image.rs:904) rejects fake successes; `real_vips_compresses_oversized_jpeg_to_target` (image.rs:1012, ignored) runs the real vips sidecar end-to-end; "Done" status pinned by `decide_result_status_maps_met_target_to_done` (queue.rs:448) | automated (incl. ignored real-vips smoke) |
| 2 | Before/after sizes shown | `file:complete applies status, sizes, output path and clears progress` (useCompression.test.ts:125) + `done row renders before-after sizes and percent reduction` (FileList.test.tsx:129); payload source `FileCompletePayload { original_size, compressed_size }` emitted at queue.rs:267 | automated |
| 3 | Reveal in folder works | `reveal button calls onReveal with output path` (FileList.test.tsx:176) + `reveal button renders for done/best_effort/already_under_target rows` (FileList.test.tsx:219) → `cancel_file / cancel_all / reveal_in_folder invoke with camelCase payloads` (useCompression.test.ts:366) → `reveal_in_folder` command (commands.rs:232, `reveal_item_in_dir`). Finder actually opening the folder: **manual smoke (deferred)** | automated + manual smoke (deferred) |
| 4 | PNG compression works | `png_output_skips_quality_search_and_fits_via_palette_dims` (image.rs:778) — PNG path fits via palette/dims ladder; `png_unachievable_best_effort_strategy_claims_palette_not_quality` (image.rs:865) pins strategy honesty; `get_output_extension_preserves_png_jpg_webp` (image.rs:414) routes .png to pngsave. Real PNG run through vips in-app: **manual smoke (deferred)** | automated + manual smoke (deferred) |
| 5 | WebP compression works | `get_output_extension_preserves_png_jpg_webp` (image.rs:414) — .webp routed to webpsave with quality knob; compression covered by the shared engine tests in rows 1/8. Real WebP run through vips in-app: **manual smoke (deferred)** | automated + manual smoke (deferred) |
| 6 | HEIC → JPEG conversion works | `get_output_extension_maps_heic_heif_to_jpg` (image.rs:402) + `output_file_name_rewrites_heic_to_jpg` (queue.rs:472) — input .heic/heif produces .jpg output name end-to-end. Real HEIC decode through vips: **manual smoke (deferred)** (plan Task 8 Required Tests: "HEIC smoke if a sample file is available") | automated + manual smoke (deferred) |
| 7 | Already under target → copied as-is | `already_under_target_copies_file_and_marks_result` (image.rs:551) + `decide_result_status_maps_already_under_target` (queue.rs:440) + `already under target row renders status and result line` (FileList.test.tsx:165) + `already under target counted as done in summary` (CompressView.test.tsx:171) | automated |
| 8 | Very large image → "Best effort" with actual size | `unachievable_returns_best_effort_with_smallest_attempt` (image.rs:829) — smallest-output selection, never last-wins; `quality_floor_reached_triggers_dimension_reduction` (image.rs:743) proves the full ladder ran first; `decide_result_status_maps_unmet_target_to_best_effort` (queue.rs:456) + `best effort row renders sizes in destructive red` (FileList.test.tsx:146) | automated |
| 9 | Progress bar during compression | Rust: per-iteration `send_progress` (image.rs:154) + clamp/preserve tests `send_progress_preserves_in_range_values` / `send_progress_clamps_out_of_range_values` (progress.rs:74,87) + `deliver_output` sends 100 (processor.rs:139); TS: `file:progress stores percent and flips pending rows to compressing` (useCompression.test.ts:83) → `renders progress bar from progressByFile while compressing` (FileList.test.tsx:93) | automated |
| 10 | Compress button starts sequential processing | `compress button enabled with pending files and triggers compression` (CompressView.test.tsx:94) + `compress_all invokes command when pending files exist` (useCompression.test.ts:350) → `start_batch` (commands.rs:195) → `process_batch` processes `for file_id in file_ids` serially (queue.rs:210) | automated |
| 11 | Output written to configured folder | Batch reads `settings.output_folder` (queue.rs:200-201) and resolves every output inside it; folder contract pinned by `queue_batch_creates_missing_output_folder` (queue.rs:607), `queue_batch_unwritable_folder_emits_batch_error_and_processes_nothing` (queue.rs:646), `preflight_skips_when_folder_already_writable` (queue.rs:549); settings side `saveSettings invokes save_settings and syncs state` (useSettings.test.ts:58) | automated |
| 12 | Filename collision → -1 suffix | `collision_appends_dash_one_suffix` (output.rs:105) + `collision_increments_suffix_to_dash_two_when_dash_one_taken` (output.rs:113) + `collision_caps_at_999_then_uses_overflow_fallback` (output.rs:122) + `collision_overflow_taken_returns_unique_nonexistent_path` (output.rs:133) + `collision_handles_file_without_extension` (output.rs:172) | automated |
| 13 | Multiple files: sequential, individual progress | Sequential: `process_batch` serial loop (queue.rs:210); per-file: `ProgressSender::new(app, file_id)` per job (queue.rs:251) with `file:progress for unknown fileId is ignored` (useCompression.test.ts:91) + `file:progress for non-active rows leaves status and progress untouched` (useCompression.test.ts:99) + `summary updates live during compression` (CompressView.test.tsx:179) | automated |

## Bonus pins (not plan ACs, guard the ACs)

| Concern | Test |
|---------|------|
| Cancel safety during image jobs | `binary_search_cancelled_before_first_iteration_returns_cancelled` (image.rs:508), `binary_search_cancelled_mid_search_returns_cancelled` (image.rs:529), `cancel_during_final_fitting_pass_yields_cancelled_not_done` (image.rs:951), `wait_sidecar_cancelled_beats_exit_code` (image.rs:689) |
| Sidecar failure handling | `missing_vips_fails_fast_without_temp_litter` (image.rs:577), `sidecar_nonzero_exit_marks_job_failed_with_exit_code` (image.rs:618), `wait_sidecar_reports_truncated_stderr_tail_on_failure` (image.rs:664) |
| Search bounds | `binary_search_caps_at_max_eight_iterations` (image.rs:467), `binary_search_exhausts_real_range_within_cap` (image.rs:488) |
| Output routing edge cases | `get_output_extension_defaults_unknown_to_jpg` (image.rs:430), `output_file_name_handles_name_without_extension` / `output_file_name_handles_dot_heic_stem_only_name` (queue.rs:493,498) |
| Sidecar self-containment (slice 4b) | `sidecars_are_self_contained` (sidecar.rs, runs in `cargo test`) |

## Deferred manual smoke list (GUI-runtime only)

1. Finder/reveal opens the real folder (AC3 runtime phase)
2. Real PNG encode through vips in-app (AC4 runtime phase; engine covered by row-1 smoke + fake-sidecar ladder tests)
3. Real WebP encode through vips in-app (AC5 runtime phase)
4. Real HEIC decode → JPEG through vips (AC6; needs a HEIC sample file)
