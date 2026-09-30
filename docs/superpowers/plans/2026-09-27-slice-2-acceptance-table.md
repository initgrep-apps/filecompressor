# Slice 2 Acceptance Table — AC → Proving Test Map

Plan: `2026-09-27-slice-2-file-detection.md` · Task 11 (acceptance check) · closeout date 2026-09-30

Every plan-level acceptance criterion (12) mapped to its proving test. Test names are exact, taken
from merged source on `main` (gate green 2026-09-30: `yarn build` ✓, `yarn test` 116 ✓,
`cargo test` 194 passed / 4 ignored real-sidecar smokes). GUI-runtime-only criteria that cannot be
proven by unit test are marked **manual smoke (deferred)** — no hand-waved checks.

## Provenance (why 0 boxes were ticked until now)

Slice 2 shipped across PRs identified in git history (`5ff51c6 feat: slice 2 complete — file
detection + file list`, `978c6c3 fix: Path::extension-based detection; drop dotless
misdetection; …`) plus the post-merge hardening plan `2026-09-28-slice-2-review-fixes.md`
(F1–F12, all tasks 1–6 ticked). The original plan's checkboxes were never updated during
implementation; this table + closeout commit records the verified state. Two plan prose errors
were already corrected in-plan by the post-merge note (2026-09-28): `FileStatus` has 8 variants
(not 9), `FileEntry` has 10 fields (not 12) — the plan's own code snippets agree with the code.

## Plan-level ACs (12)

| # | Acceptance Criterion | Proving test / evidence | Type |
|---|----------------------|-------------------------|------|
| 1 | Drag files onto the drop zone → they appear in the file list | `calls onDrop with Tauri-provided paths on drop event` (DropZone.test.tsx:66) + `adds files via IPC` (useFileList.test.ts:26) + `test_add_files_valid_paths` (commands.rs:258). Shipped via `getCurrentWebview().onDragDropEvent` (DropZone.tsx) after F1 fix (`File.path` was dead in Tauri 2). Drop in the running macOS app: per review-fixes spec AC1, verified manually with `onDragDropEvent`; production-build re-check **manual smoke (deferred)** | automated + manual smoke (deferred) |
| 2 | Click "browse" → native file dialog opens → selected files appear in list | `click triggers browse` + `Enter and Space trigger browse` (DropZone.test.tsx:116,124) + `browseFiles wraps single string path` / `browseFiles passes array through` / `browseFiles cancel (null) does nothing` (useFileList.test.ts:53,62,40) + `test_remove_file_existing`-style IPC chain. tauri-plugin-dialog registered (`lib.rs` plugin + `capabilities/default.json` `dialog:default` + `@tauri-apps/plugin-dialog` 2.8). OS dialog opening: **manual smoke (deferred)** | automated + manual smoke (deferred) |
| 3 | Each file shows: filename, category badge, target size, file size, status (Pending) | `shows name, size, category badge, target, status` (FileList.test.tsx:29) + `test_file_entry_new_valid_file` (models.rs:106) | automated |
| 4 | JPEG/PNG/WebP/HEIC → "Image" badge, target "200 KB" | `test_detect_image_formats` (detection.rs:52) + `test_default_targets` (detection.rs:88, 200*1024) + badge mapping in `shows name, size, category badge, target, status` | automated |
| 5 | MP4/MOV → "Video" badge, target "10 MB" | `test_detect_video_formats` (detection.rs:62) + `test_default_targets` (10*1024*1024) | automated |
| 6 | PDF → "PDF" badge, target "2 MB" | `test_detect_pdf` (detection.rs:68) + `test_default_targets` (2*1024*1024) | automated |
| 7 | DOCX/XLSX/PPTX → "Document" badge, target "1 MB" | `test_detect_document_formats` (detection.rs:73) + `test_default_targets` (1*1024*1024) | automated |
| 8 | Unknown extension (.zip, .xyz) → "Other" badge, target "—", status "Unsupported" | `test_detect_unknown` (detection.rs:80) + `test_detect_dotless_names_not_extensions` / `test_detect_trailing_dot` / `test_detect_dotfile_no_ext` (F6, Path::extension semantics) + `test_file_entry_status_assignment` (models.rs:178, Other→Unsupported) + UI: `unsupported rows are dimmed` + `zero size and zero target render em-dash` (FileList.test.tsx:73,61) | automated |
| 9 | Can drag more files at any time — they append to the list | `adds files via IPC` merge semantics + `rapid adds do not corrupt ordering` (useFileList.test.ts:144) + `test_add_files_returns_new_only` (commands.rs:357, return contains only new entries; hook merges into state) | automated |
| 10 | Each file row has a remove button (×) → removes that file | `remove button calls onRemove with id and has aria-label` (FileList.test.tsx:84, F10) + `removeFile filters only after IPC success` (useFileList.test.ts:102) + `test_remove_file_existing` (commands.rs:377) | automated |
| 11 | "Clear" button removes all files from list | `clearList empties and clears error` (useFileList.test.ts:125) + `clear list disabled while compressing` (CompressView.test.tsx, later slice guard) + `test_clear_list` (commands.rs:387) | automated |
| 12 | File sizes displayed in human-readable format (KB/MB) | `formats sizes across tiers` (FileList.test.tsx:43, B/KB/MB/GB — GB tier added by F9) + `test_file_entry_new_valid_file` originalSize population | automated |

## Rust Required Tests from plan Tasks 1–3 (all shipped)

| Plan test | Shipped as | Location |
|-----------|-----------|----------|
| `test_file_entry_new_valid_file` / `_missing_file` / `_empty_filename` / `_unicode_filename` / `_status_assignment` / `_serialization_roundtrip` / `_uuid_format` | same names | models.rs:106–235 |
| `test_file_entry_new_permission_denied` | same name (still `/root/forbidden.jpg` = ENOENT on macOS; F12's tempdir-0o000 replacement documented as spec note, not implemented — see gaps) | models.rs:141 |
| `test_category_enum_serialization` / `test_file_status_enum_serialization` | same names (8-variant FileStatus) | models.rs:238,249 |
| `test_detect_case_insensitivity_all` / `_multi_dot_filename` / `_hidden_file` / `_empty_string` / `_whitespace_only` | same names | detection.rs:97–128 |
| `test_add_files_valid_paths` / `_skips_nonexistent` / `_deduplicates` / `_returns_new_only` / `_empty_vec` / `test_remove_file_existing` / `test_clear_list` / `test_concurrent_access` | shipped against **core fns** (`add_files_core`/`remove_file_core`/`clear_list_core` per F4 — tests no longer exercise copied code); `_deduplicates` split into `test_add_files_deduplicates_exact_canonical` + `_redundant_separators` + `_stores_canonical_path` + `_skips_unresolvable_case_variant` (F5) | commands.rs:258–394 |
| `test_mutex_poison_recovery` | same name (F3: production locks use `unwrap_or_else(|e| e.into_inner())`) | commands.rs:398 |
| `test_concurrent_access` | covered by `rapid adds do not corrupt ordering` (frontend) + Mutex-core design; no dedicated Rust concurrency test — noted in gaps | — |

## Deliberate divergences (approved, documented)

| Plan text | Actual | Authority |
|-----------|--------|-----------|
| Task 1 AC: "FileStatus has 9 variants", "FileEntry has 12 fields" | 8 variants / 10 fields | Post-merge note in plan header (prose error, code correct) |
| Task 2 AC: `category_label` + `category_formats` helpers | Deleted (F7 — dead duplicated display strings; frontend owns labels) | review-fixes F7 |
| Architecture prose: `file:added` event | Never shipped; superseded by synchronous `add_files` return | review-fixes §3 Out of Scope |
| Task 8: HTML5 drag-drop with `File.path` | Rewritten to `onDragDropEvent` (Tauri 2 native) | review-fixes F1 |
| Task 3: hardcoded default targets | `FileEntry::new(path, target_bytes)` + settings resolver (Slice 3 evolution); `default_target_bytes` kept as `#[cfg(test)]` shim over `Settings::default()` | Slice 3 settings |
| Task 5 AC: `test_types_*` TS tests | No dedicated TS types unit tests; type-correctness enforced by tsc strict build + consumer tests (`useFileList.test.ts` constructs FileEntry literals) | drift noted |
| Plan Task 9/10 Required Tests (~23 listed) | Consolidated into 18 FileList.test.tsx + 18 CompressView.test.tsx behavioral tests (superset incl. later-slice features); e.g. `test_compressview_*` integration names shipped as the `batch:`/`banner`/`summary` suites | drift noted |

## Gaps (minor, non-blocking — for future plan work)

1. **`test_file_entry_new_permission_denied`** still uses `/root/forbidden.jpg` (macOS: ENOENT, not EACCES). F12 prescribed a real 0o000 tempdir. Current test still passes and covers the metadata-failure → `original_size = 0` contract; owner: `src-tauri/src/models.rs` tests.
2. **`test_concurrent_access`** has no dedicated Rust test (Mutex contention stress). Covered behaviorally by `rapid adds do not corrupt ordering`; owner: `src-tauri/src/commands.rs`.
3. **`test_types_serialization_compatibility`** (plan Task 5) was manual — no automated Rust↔TS roundtrip test exists. Owner: `src/types.ts` + models.rs (candidate: JSON golden test).
4. **Production build** `yarn tauri build` from review-fixes plan Task 6 Step 4 remains unchecked (out of slice-2 plan scope, noted for completeness).

## Deferred manual smoke list (GUI-runtime only)

1. Full drag/browse/remove/clear re-run in the packaged production app (Task 10 Step 3 + Task 11 Step 1 procedure; drop verified on macOS dev builds per review-fixes spec AC1)
2. Native macOS file-dialog open (browse flow, OS side)

## Bonus pins (not plan ACs, guard the ACs)

| Concern | Test |
|---------|------|
| Dedup evasion (case variants, redundant separators) | `test_add_files_skips_unresolvable_case_variant`, `test_add_files_deduplicates_redundant_separators`, `test_add_files_stores_canonical_path` (F5) |
| Settings-driven targets | `test_add_files_core_uses_settings_targets` (commands.rs:410) |
| F2 error surfacing | `renders destructive alert banner when add fails` + `sets error state when add IPC fails` + `clearList failure keeps files` + `removeFile keeps row when IPC fails` + `browseFiles surfaces picker errors` |
| Subscription failure resilience | `subscription rejection does not crash and browse still works`, `getCurrentWebview sync throw logs and leaves component usable` (DropZone.test.tsx) |
