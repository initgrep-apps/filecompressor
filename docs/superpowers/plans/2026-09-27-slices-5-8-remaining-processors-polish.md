# Slices 5-8: Remaining Processors + Batch Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PDF, Video, Document processors (each implementing the existing `CompressionProcessor` trait from Slice 4), then add batch cancellation UI, toast notifications, and stale temp cleanup.

**Architecture:** Each new processor follows the same pattern as `ImageProcessor`: implement `CompressionProcessor` trait, bundle sidecar binary, register in `ProcessorRegistry`. The engine, job queue, and IPC events from Slice 4 are reused unchanged.

## Global Constraints

- **Every sidecar binary must be self-contained per platform** — never ship a binary that resolves dylibs from absolute non-system paths (e.g. `/opt/homebrew`). macOS: bundle transitive dylibs + rewrite load commands to `@rpath` via `scripts/bundle-vips-macos.sh` (extend per-engine as needed); Windows: official static builds; Linux: musl static or AppImage.
- **Sidecar path resolution MUST target the executable's directory, not `BaseDirectory::Resource`** — Tauri's bundler strips the target triple from externalBin binaries and places them in `Contents/MacOS/`, NOT `Contents/Resources/`. Resolution pattern (from `src-tauri/src/sidecar.rs` `get_sidecar_path`): candidates = `current_exe().parent()/vips-<triple>` (dev) then `current_exe().parent()/vips` (bundle). A Resource-dir assumption breaks only in bundled builds and is invisible in dev tests — the GUI test in slice-9/acceptance covers it, but implementers must apply the exe-dir pattern for every new engine (qpdf, gs, ffmpeg, ffprobe).
- **Audit gate is part of the project gate** — `bash scripts/audit-sidecars.sh` must pass (invoked via the Rust test `sidecars_are_self_contained` in `src-tauri/src/sidecar.rs`, runs in `cargo test`); every new engine bundle step MUST re-run the audit and show PASS before commit.
- **Bundled dylibs are committed** under `src-tauri/frameworks/` and wired via `bundle.macOS.frameworks` in `src-tauri/tauri.conf.json` (merge into existing keys, keep valid JSON).

## Slice Dependencies

```
Slice 4 (Image Compression) ← establishes engine + queue
  ├→ Slice 5 (PDF)           ← adds PdfProcessor
  ├→ Slice 6 (Video)         ← adds VideoProcessor
  └→ Slice 7 (Document)      ← adds DocumentProcessor
       └→ Slice 8 (Batch + Cancel + Polish)  ← adds per-file cancel UI, toasts, stale cleanup
```

Slices 5, 6, 7 are independent — can be done in any order.

---

# Slice 5: PDF Compression

**Goal:** Drop a PDF → compress → result ≤ target or "Best effort" at 72 DPI / JPEGQ 15.

## Acceptance Criteria

1. Drop a PDF > 2 MB → compresses to ≤ 2 MB, "Done" status
2. qpdf lossless first pass → if under target, done
3. qpdf image optimization second pass → if under target, done
4. Ghostscript /screen preset → if under target, done
5. Ghostscript DPI/JPEGQ binary search → if under target, done
6. If all passes fail → "Best effort" with smallest result saved
7. Output PDF opens correctly in a PDF viewer
8. Progress shown during compression
9. Reveal in folder works

## Tasks

### Task 1: Create PdfProcessor

**Files:**
- Create: `src-tauri/src/processors/pdf.rs`
- Modify: `src-tauri/src/processors/mod.rs` (register PdfProcessor)

- [x] **Step 1: Create pdf.rs implementing CompressionProcessor**

The processor must implement the 4-pass strategy from the spec:
1. qpdf lossless: `qpdf --linearize --object-streams=generate --compression-level=9 input.pdf output.pdf`
2. qpdf image opt: `qpdf --linearize --object-streams=generate --recompress-flate --compression-level=9 --optimize-images --jpeg-quality=75 input.pdf output.pdf`
3. Ghostscript /screen: `gs -sDEVICE=pdfwrite -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile=output.pdf input.pdf`
4. Binary search: DPI [100, 72, 50, 36] × JPEGQ [60, 40, 25, 15]

Each pass: run sidecar → measure output → if ≤ target, stop and return success. If all passes exhausted, return best effort (smallest output).

The processor needs two sidecar paths: `qpdf` and `gs`. Update `sidecar.rs` if needed to resolve multiple binaries, or pass both paths to `compress_to_target`.

> **Note:** The `CompressionProcessor` trait signature takes a single `sidecar_path: &str`. To handle two sidecars (qpdf + gs), either:
> - (A) Modify the trait to accept `sidecar_paths: &HashMap<String, String>` — cleaner but changes Slice 4 code
> - (B) Resolve the second sidecar inside the processor via `AppHandle` — but the trait doesn't have access to it
> - (C) Concatenate: `sidecar_path` = "qpdf_path;gs_path" — hacky
>
> **Recommended:** Option A — modify the trait to pass a `&SidecarPaths` struct containing all resolved paths. Update `ImageProcessor` to use `paths.vips`. This is a small change to Slice 4 code.

- [x] **Step 2: Modify trait to accept SidecarPaths**

Update `src-tauri/src/engine/processor.rs` (the merged trait file — `engine/trait.rs` is an invalid Rust filename, `trait` is a keyword; this is the same correction slice-4 made):

```rust
pub struct SidecarPaths {
    pub vips: String,
    pub ffmpeg: String,
    pub ffprobe: String,
    pub gs: String,
    pub qpdf: String,
}

pub trait CompressionProcessor: Send + Sync {
    fn category(&self) -> Category;
    fn supported_extensions(&self) -> &[&str];

    fn compress_to_target(
        &self,
        input: &Path,
        output: &Path,
        target_bytes: u64,
        quality_floor: &QualityFloors,
        cancel_token: CancellationToken,
        progress: ProgressSender,
        sidecar_paths: &SidecarPaths,
        temp_dir: &Path,
    ) -> Result<CompressionResult, CompressionError>;
}
```

Update `ImageProcessor::compress_to_target` to use `sidecar_paths.vips` instead of `sidecar_path`.

Update `queue.rs` to resolve all sidecar paths and pass `SidecarPaths` to the processor.

**Acceptance Criteria:**
- Trait signature matches the merged 8-param shape: `sidecar_path: &str` (processor.rs:37) → `sidecar_paths: &SidecarPaths` — ONE param swap, no restructure; `temp_dir: &Path` stays
- Floor type is `&QualityFloors` (merged name — settings.rs:87-98), NOT the plan/spec's `&QualityFloor` spelling
- ALL call sites update in the same commit (compile-only verification): `ImageProcessor::compress_to_target` impl (processors/image.rs:215-225), `sidecar_path` consumers (image.rs:257, 264 → `run_vips`/`run_vips_resize`), 6 test call sites (image.rs:557, 584, 723, 756, 807, 860), queue.rs single call (queue.rs:289-302)
- Fail-fast semantics preserved: resolving all 5 sidecars keeps the per-name error copy "Engine error: {name} not available" (sidecar.rs:37) — missing vips still short-circuits before `compress_to_target`; the error-copy pin test (engine/result.rs:71-112) must stay green
- Registration uses the merged API: `registry.register(Box::new(...))` (processors/mod.rs:29-45) — NOT the plan's hand-rolled `extension_map.insert` block
- externalBin gains `binaries/qpdf` + `binaries/gs` AND equivalent pinned tests (extend `tauri_conf_json_lists_vips_as_external_bin` pattern — sidecar.rs:290-303) — else the bundle claim is untestable
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `pdf_pass1_qpdf_lossless_stops_early_when_under_target` — pass 1 output ≤ target must not run pass 2/3/4 (prevents wasted sidecar spawns + over-compression)
- `pdf_pass2_qpdf_image_opt_stops_early` — AC3 sequencing (regress silently ships /screen-degraded PDFs)
- `pdf_pass3_gs_screen_stops_early` — AC4
- `pdf_binary_search_dpi_jpegq_grid` — pass 4 = enumerated 16-cell ladder [100,72,50,36]×[60,40,25,15] in descending order, early exit on fit, gs args carry `-dPDFSETTINGS` + DPI/JPEGQ flags (NOT adaptive lo/hi binary search — spec §5 wording)
- `pdf_all_passes_fail_returns_best_effort_smallest_output` — AC6: keep the SMALLEST of all outputs, never the last candidate (classic bug = last-wins → user gets larger best-effort file)
- `pdf_already_under_target_skips_all_sidecars` — spec §6 "Already Under Target": PDFs copy as-is, no sidecar call
- `pdf_gs_missing_binary_fails_with_engine_error` — "Engine error: gs not available" surfaces even when qpdf pass succeeded (no swallow)
- `pdf_corrupt_input_sidecar_error_maps_to_file_may_be_corrupt` — spec §6 "File may be corrupt": garbage PDF must NOT report Done (gs may exit 0 with garbage output — detect invalid output)
- `pdf_cancel_mid_pass_returns_cancelled_and_cleans_temp` — sidecar kill + temp cleanup on cancel
- `sidecar_paths_reaches_both_qpdf_and_gs` — Option A: queue passes both resolved paths through `&SidecarPaths` (breaks only in bundled builds otherwise)
- `pdf_sidecar_stderr_tail_in_error_message` — GS error diagnostics visible (reuse image.rs fake-sidecar pattern)
- `pdf_zero_byte_output_rejected` — "measure output" rejects 0-byte gs outputs (exit 0 + empty file ≠ Done)

- [x] **Step 3: Implement PdfProcessor::compress_to_target**

```rust
impl CompressionProcessor for PdfProcessor {
    fn category(&self) -> Category { Category::Pdf }
    fn supported_extensions(&self) -> &[&str] { &["pdf"] }

    fn compress_to_target(
        &self,
        input: &Path,
        output: &Path,
        target_bytes: u64,
        quality_floor: &QualityFloors,
        cancel_token: CancellationToken,
        progress: ProgressSender,
        sidecar_paths: &SidecarPaths,
        temp_dir: &Path,
    ) -> Result<CompressionResult, CompressionError> {
        // Already under target check
        // Pass 1: qpdf lossless
        // Pass 2: qpdf --optimize-images --jpeg-quality=75
        // Pass 3: gs /screen
        // Pass 4: binary search DPI + JPEGQ
        // Return best effort if all fail
    }
}
```

- [x] **Step 4: Register PdfProcessor in mod.rs**

```rust
let pdf_proc = pdf::PdfProcessor::new();
for ext in pdf_proc.supported_extensions() {
    extension_map.insert(ext.to_lowercase(), Category::Pdf);
}
processors.insert(Category::Pdf, Box::new(pdf_proc));
```

- [x] **Step 5: Bundle qpdf + gs sidecar binaries**

Download qpdf and gs binaries for the current platform. Place in `src-tauri/binaries/` with target triple suffix. **Self-contained requirement (Global Constraints):** macOS — run the dylib-bundling flow (collect transitive non-system dylibs into `src-tauri/frameworks/`, rewrite all load commands to `@rpath`, ad-hoc sign; pattern: `scripts/bundle-vips-macos.sh`) before commit; Windows: official static builds only; Linux: musl static or AppImage. Then run the audit and show PASS:

```bash
bash scripts/audit-sidecars.sh
```
Expected: `sidecar audit: PASS`. Add to `tauri.conf.json` `externalBin`:

```json
"externalBin": [
  "binaries/vips",
  "binaries/qpdf",
  "binaries/gs"
]
```

- [x] **Step 6: Test end-to-end**

Drop a large PDF → compress → verify output is ≤ 2 MB (or "Best effort"). Verify output PDF opens correctly.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add PdfProcessor with qpdf + Ghostscript"
```

---

# Slice 6: Video Compression

**Goal:** Drop an MP4/MOV → compress → result ≤ 10 MB or "Best effort" at CRF 28 / 480p.

## Acceptance Criteria

1. Drop an MP4 > 10 MB → compresses to ≤ 10 MB, "Done"
2. MOV input → re-encoded to MP4 output
3. Two-pass H.264 encoding with calculated bitrate
4. If over target → reduce resolution (1080p → 720p → 480p)
5. If still over → increase CRF up to 28
6. Progress parsed from FFmpeg stderr (`time=` / `out_time_ms=`)
7. Output MP4 plays correctly
8. "Best effort" if can't reach target at CRF 28 / 480p

## Tasks

### Task 1: Create VideoProcessor

**Files:**
- Create: `src-tauri/src/processors/video.rs`
- Modify: `src-tauri/src/processors/mod.rs` (register VideoProcessor)

- [x] **Step 1: Create video.rs**

Implement:
1. Get duration via ffprobe: `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4`
2. Calculate bitrate: `(target_bytes * 8 * 0.95) / duration_seconds`
3. Two-pass encode:
   - Pass 1: `ffmpeg -y -i input -c:v libx264 -b:v {bitrate}k -pass 1 -passlogfile prefix -an -f mp4 /dev/null`
   - Pass 2: `ffmpeg -i input -c:v libx264 -b:v {bitrate}k -pass 2 -passlogfile prefix -c:a aac -b:a 128k output.mp4`
   - Windows: use `NUL` instead of `/dev/null`
4. If over target → reduce resolution and retry
5. If still over → increase CRF, floor at 28

For progress parsing: spawn ffmpeg with `stderr piped`, read lines, parse `time=00:01:23.45` or `out_time_ms=12345678`, compute percentage from duration.

**Acceptance Criteria:**
- Prerequisite: SidecarPaths refactor from Slice 5 landed first (video needs 2 binaries — ffmpeg + ffprobe — through one `&SidecarPaths`)
- `processors/video.rs` exists + registered: flips `registry.get_processor(Category::Video)` (queue.rs:238) from `None → Some`; the null-processor guard test (processors/mod.rs:84 `Video.is_none()`) flips to `Some(_)`
- ffprobe duration parse handles decimal seconds (`123.456`) AND fails the job on empty/`N/A`/garbage entries — no divide-by-zero, no `-b:v NaNk` reaching ffmpeg
- Bitrate formula matches spec: `(target_bytes * 8 * 0.95) / duration_seconds`, with u64-overflow + tiny-duration guards
- Two-pass command construction pinned on ARG ORDER (contract test, no real ffmpeg): pass 1 `-an -f mp4 NUL|/dev/null -pass 1 -passlogfile <fresh prefix per attempt>`; pass 2 `-c:a aac -b:a 128k -pass 2` — stale passlog files from a previous attempt must NOT corrupt the next encode
- `out_time_ms` parsed in MICROSECONDS (modern ffmpeg µs, not ms — common mislabeling bug); both `time=` and `out_time_ms=` accepted; multi-line + partial + garbage stderr lines ignored
- Progress percent clamped 0..=100 (time=01:00:01 on a 01:00:00 video must not emit 100.001%)
- Resolution ladder 1080p→720p→480p applies to BOTH passes per attempt; CRF floor 28 → Best effort with smallest-output selection (same rule as PDF)
- Cancel mid-encode kills ffmpeg AND removes passlog files (temp dir empty after cancel — no orphan files)
- Already-under-target skip: no sidecar spawn for MP4 ≤ 10 MB target
- Corrupt input via ffprobe path → "File may be corrupt" (spec §6)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `ffprobe_parses_duration_decimal_and_missing_entries_fail` — real ffprobe prints `123.456\n`; `""`/`N/A`/garbage → job fails, no divide-by-zero, no NaN bitrate
- `video_bitrate_formula_matches_spec` — `(target*8*0.95)/duration` + overflow/tiny-duration boundary guards
- `video_two_pass_commands_constructed_correctly` — arg-order contract: pass 1 `-an -f mp4 NUL|/dev/null -pass 1 -passlogfile prefix`; pass 2 `-c:a aac -b:a 128k -pass 2`
- `video_progress_parses_time_and_out_time_ms` — pure fn: both formats, µs units, garbage lines ignored, multi-line
- `video_progress_percent_clamped_0_to_100` — clamping boundary
- `video_over_target_steps_resolution_1080_720_480` — ladder applies to both passes; passlogfile isolation per attempt (fresh prefix)
- `video_crf_floor_28_best_effort` — smallest-output selection (never last-wins)
- `video_cancel_mid_encode_kills_ffmpeg_and_removes_passlogs` — kill + temp dir empty after cancel (orphan passlogs = regression)
- `video_mov_input_produces_mp4_output` — AC2 output extension logic
- `video_ffprobe_nonzero_exit_fails_with_engine_error` — "File may be corrupt" (spec §6)
- `video_already_under_target_skips_sidecars` — under-target copy-as-is (5 MB file vs 10 MB target wastes minutes if recompressed)
- `video_windows_nul_dev_null_gated` — cfg-gated constant assert (release insurance)

- [x] **Step 2: Register VideoProcessor in mod.rs**

- [x] **Step 3: Bundle ffmpeg + ffprobe sidecar binaries**

Download from:
- macOS: `evermeet.cx/ffmpeg/`
- Windows: `github.com/BtbN/FFmpeg-Builds/releases`
- Linux: `johnvansickle.com/ffmpeg/`

**Self-contained requirement (Global Constraints):** macOS — collect transitive non-system dylibs into `src-tauri/frameworks/`, rewrite all load commands to `@rpath`, ad-hoc sign (pattern: `scripts/bundle-vips-macos.sh`); Windows: BtbN builds are static — verify; Linux: johnvansickle builds are static — verify. Then run the audit and show PASS:

```bash
bash scripts/audit-sidecars.sh
```
Expected: `sidecar audit: PASS`.

Add to `tauri.conf.json` externalBin:
```json
"externalBin": [
  "binaries/vips",
  "binaries/qpdf",
  "binaries/gs",
  "binaries/ffmpeg",
  "binaries/ffprobe"
]
```

- [x] **Step 4: Test end-to-end**

Drop an MP4 → compress → verify output ≤ 10 MB. Verify output plays. Drop a MOV → verify MP4 output.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add VideoProcessor with FFmpeg two-pass encoding"
```

---

# Slice 7: Document Compression

**Goal:** Drop a DOCX/XLSX/PPTX → compress → result ≤ 1 MB or "Best effort".

## Acceptance Criteria

1. Drop a DOCX > 1 MB → compresses to ≤ 1 MB, "Done"
2. XLSX and PPTX also work
3. Only embedded media (`word/media/`, `ppt/media/`, `xl/media/`) is recompressed
4. XML and document structure preserved — output opens correctly in Office/LibreOffice
5. Binary search on media quality, floor Q=40
6. Re-zipped with DEFLATE level 9
7. EMF/WMF embedded images: skipped (no error)
8. "Best effort" if can't reach target

## Tasks

### Task 1: Add zip crate dependency

Add to `src-tauri/Cargo.toml`:
```toml
zip = "2"
```

**Acceptance Criteria:**
- Version conflict resolved BEFORE execution: plan pins `zip = "2"`; the repo stack note says `zip 8.6` — pin against the REAL current crate (latest is 2.x) and confirm the API surface (`ZipArchive`, `ZipWriter`, `CompressionMethod::Deflated`, `compression_level(9)`) compiles against the pinned version; fix AGENTS.md stack note if it's stale
- Compile gate green: `yarn build && yarn test && cd src-tauri && cargo test` (new dep expands lockfile; hermetic crates.io fetch assumed)

**Required Tests:**
- Compile gate is the test for a one-line dep change — no named unit tests required; `cargo test` green after pin confirms the API surface (`ZipArchive`, `ZipWriter`, `CompressionMethod::Deflated`, `compression_level(9)`) against the real crate version

### Task 2: Create DocumentProcessor

**Files:**
- Create: `src-tauri/src/processors/document.rs`
- Modify: `src-tauri/src/processors/mod.rs` (register DocumentProcessor)

- [x] **Step 1: Create document.rs**

Implement:
1. Read OOXML file as ZIP archive using `zip::ZipArchive`
2. Iterate all entries — identify media files in `word/media/`, `ppt/media/`, `xl/media/`
3. For each media file (JPEG/PNG):
   - Extract to temp dir
   - Recompress using vips sidecar (binary search on Q, floor 40)
   - Read back compressed bytes
4. For non-media files: copy as-is
5. Write new ZIP with `CompressionMethod::Deflated` + `compression_level(9)` using `zip::ZipWriter`
6. Measure output size — if over target, lower media quality and retry

**Acceptance Criteria:**
- Media identification is EXACT: only `word/media/`, `ppt/media/`, `xl/media/` entries recompressed; near-miss paths pass through untouched (`word/embeddings/`, root-level `media/`, `word/media/image1.png` caught — near-misses here corrupt the doc or miss savings)
- Non-media entries round-trip BYTE-IDENTICAL (document.xml, [Content_Types].xml, docProps/), entry order preserved ([Content_Types].xml first — some strict readers care)
- Re-zip uses `CompressionMethod::Deflated` + `compression_level(9)` — verified by re-reading the produced zip
- Media binary search floor wired through settings (`qualityFloors.document.minMediaQuality=40`), NOT hardcoded
- Outer retry loop: over target → lower media quality → retry (Step 1.6)
- EMF/WMF embedded images skipped WITHOUT error — job still Done, not partial-failure (AC7)
- vips fails on ONE media file → keep that entry's ORIGINAL bytes + re-zip (NOT fail the whole job, NOT drop the entry — dropped = broken document in Word)
- Zero-media DOCX: output ≈ input size, valid zip written, no crash on empty media list
- Corrupt ZIP → "File may be corrupt", original preserved (spec §6)
- Already-under-target: no re-zip churn on small docx (spec §6 optimization)
- Cancel mid-recompress cleans temp entries
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `document_media_path_identification` — exact dirs recompressed; near-miss paths untouched (bug = corrupt doc or missed savings)
- `document_non_media_entries_copied_byte_identical` — structure round-trip + entry order ([Content_Types].xml first)
- `document_rezip_uses_deflate_level_9` — method + level verified by re-reading produced zip (unzip -v or zip crate)
- `document_media_binary_search_floors_at_q40` — floor from settings actually wired, not hardcoded
- `document_over_target_lowers_quality_and_retries` — outer retry loop
- `document_emf_wmf_skipped_without_error` — WMF passes through untouched, job Done
- `document_vips_fails_on_media_copies_original_entry` — odd PNG edge: original bytes kept + re-zip, job not failed, entry not dropped
- `document_zero_media_docx_pure_rezip_or_pass_through` — empty media list, valid zip, no crash
- `document_corrupt_zip_fails_gracefully` — "File may be corrupt", original preserved
- `document_already_under_target` — no re-zip churn
- `document_cancel_mid_recompress_cleans_temp_entries` — temp cleanup on cancel
- `document_output_opens_valid` — structural check: re-read output via ZipArchive, entry count + names match input

- [x] **Step 2: Register DocumentProcessor in mod.rs**

- [x] **Step 3: Test end-to-end**

Drop a DOCX with embedded images → compress → verify output ≤ 1 MB. Verify output opens in Word/LibreOffice. Test XLSX and PPTX.

- [x] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add DocumentProcessor with OOXML media recompression"
```

---

# Slice 8: Batch Processing + Cancellation + Polish

**Goal:** Per-file cancel button in UI, Cancel All button, batch summary footer with live counts, toast notifications, stale temp cleanup on launch.

## Acceptance Criteria

1. Compress 10 mixed files → per-file Cancel stops one mid-job
2. Cancel All stops remaining queue
3. Cancelled files: temp files cleaned, marked "Cancelled"
4. Batch summary shows live counts: "6 files · 2 done · 1 compressing · 1 pending · 1 warning · 1 skipped"
5. Toast on batch complete: "Compressed 8 files. Saved 14.3 MB total."
6. Toast on errors: "2 files could not reach target."
7. Stale temp files (>24h) cleaned on app launch

## Tasks

### Task 1: Update FileList to show progress bars, cancel buttons, reveal buttons

**Files:**
- Modify: `src/components/FileList.tsx`

- [ ] **Step 1: Add progress bar for compressing files**

For files with status "compressing", show a thin progress bar below the filename. Listen to `file:progress` events (already handled in `useCompression` hook from Slice 4).

- [ ] **Step 2: Add per-file Cancel button for compressing files**

Show a small × button (red) for files with status "compressing". Clicking calls `cancelFile(fileId)`.

- [ ] **Step 3: Add Reveal in Folder button for done/best-effort files**

Show a folder icon button (hover-reveal) for files with status "done" or "best_effort" or "already_under_target". Clicking calls `revealInFolder(outputPath)`.

**Acceptance Criteria:**
- ALL THREE steps already shipped in Slice 4 Task 7 (commits `f1ab850`, `06449cc`, `0f3b493`) — this task is VERIFY ONLY, no new work
- Progress bar: `FileList.tsx:160-175` (`role="progressbar"`, aria-value*, `percent`% width) under StatusBadge for compressing rows; fed by `progress` prop (:24, :126)
- Per-file cancel: `FileList.tsx:197-207` — cancel button replaces remove for compressing rows; full chain cancelFile → invoke('cancel_file') → command → token cancel; token inserted BEFORE status flip (cancel never misses)
- Reveal: `FileList.tsx:185-196` hover-reveal (`opacity-0 group-hover:opacity-100 focus:opacity-100`), gated on `RESULT_STATUSES` (:30) + outputPath; → invoke('reveal_in_folder')
- Existing tests stay green (no rewrites needed): FileList.test.tsx:93-227 covers all three steps incl. negative cases (reveal hidden w/o handler, remove-disabled gating)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `renders progress bar from progressByFile while compressing` — existing (FileList.test.tsx:93-108)
- `compressing row shows cancel instead of remove` — existing (:110-127)
- `per-file cancel button calls onCancel with id` — existing
- `reveal button calls onReveal with output path` — existing (:176-188)
- `reveal button renders for best_effort rows` — NEW cheap parametric addition (Task 1 Step 3 exercises one status only today)
- `reveal button hidden when no onReveal handler passed` — existing (:218-227)
- `remove button disabled for pending rows while compressing` — existing (:202-216)

### Task 2: Add batch summary footer + Cancel All button

**Files:**
- Modify: `src/views/CompressView.tsx`

- [x] **Step 1: Add batch summary**

Compute counts from file list:
```typescript
const done = files.filter(f => f.status === 'done').length
const compressing = files.filter(f => f.status === 'compressing').length
const pending = files.filter(f => f.status === 'pending').length
const warning = files.filter(f => f.status === 'best_effort').length
const skipped = files.filter(f => f.status === 'unsupported').length
```

Display: "6 files · 2 done · 1 compressing · 1 pending · 1 warning · 1 skipped"

- [x] **Step 2: Add Cancel All button**

Show "Cancel All" button (destructive variant) when `isCompressing` is true. Clicking calls `cancelAll()`.

**Acceptance Criteria:**
- Step 2 (Cancel All) ALREADY SHIPPED (`CompressView.tsx:73-77`, destructive iff `isCompressing`, full chain → queue.rs:151-158 cancels batch + file tokens; batch-cancel gate marks remaining Pending Cancelled + emits file:cancelled) — no new work
- Step 1 (batch summary) GENUINELY NEW: shipped footer (`CompressView.tsx:87-97`) renders only `{files.length} files · {doneCount} done · {pendingCount} pending` — MISSING `compressing`, `warning` (best_effort), `skipped` (unsupported) counts required by spec §4 L232 and the Step 1 snippet above
- DECIDE + TEST the failed count: spec's status table has `Failed` (destructive) but the summary snippet omits a `failed` count entirely — either add it or document its omission, then pin the exact AC4 string in a test
- Summary updates live: file:complete/file:error events shift counts during compression
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `batch_summary_counts_mixed_statuses` — one file per status rendered → assert the exact AC4 string "6 files · 2 done · 1 compressing · 1 pending · 1 warning · 1 skipped" (regressions: best_effort miscounted as done, unsupported dropped, failed missing)
- `failed files counted in summary` — Failed status represented per the decision above
- `summary updates live during compression` — event-driven count shift
- `cancel all click calls cancelAll with batch id` — invocation verified (only visibility tested today)
- `cancel all button visible during compression only` — existing (CompressView.test.tsx:100-113)
- `cancelled files represented in summary` — AC3 "marked Cancelled" (no cancelled count/row assertion anywhere today)

### Task 3: Add toast notifications

**Files:**
- Modify: `src/views/CompressView.tsx` or `src/App.tsx`

- [x] **Step 1: Add sonner Toaster to App**

```tsx
import { Toaster } from '@/components/ui/sonner'

// At the bottom of App component:
<Toaster />
```

- [x] **Step 2: Show toast on batch complete**

In `useCompression` hook, on `batch:complete` event:
```typescript
const totalSavedMB = (e.payload.totalSavedBytes / (1024 * 1024)).toFixed(1)
toast.success(`Compressed ${doneCount} files. Saved ${totalSavedMB} MB total.`)
```

- [x] **Step 3: Show toast on errors**

On `file:error` events, accumulate error count. On `batch:complete`, if errorCount > 0:
```typescript
toast.error(`${errorCount} files could not reach target.`)
```

**Acceptance Criteria:**
- Step 1 (Toaster) ALREADY SHIPPED (`App.tsx:131` → `src/components/ui/sonner.tsx`) — no new work
- Step 2 (batch complete toast) ALREADY SHIPPED with favorable substitution — toast lives in the VIEW layer via `onBatchComplete` callback (`CompressView.tsx:39-40`: `Compressed ${count} files. Saved ${formatSavedBytes(saved)} total.`), hook fires `onBatchComplete(totalSavedBytes, processedCount)` on batch:complete (suppressed at 0 processed — cancelled-only batch). Cosmetic drift from this plan's hook-inline snippet (fixed-MB units + doneCount): adaptive human sizes are BETTER — pin the view-layer message in a test
- Step 3 (error-count toast) GENUINELY NEW: no aggregation of `file:error` events exists today (`useCompression.ts:130-143` only sets row failed + dropProgress); the AC6 message "N files could not reach target." is nowhere in the codebase — implement accumulation + end-of-batch toast per the snippet above
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `batch complete toast shows total saved bytes` — existing (CompressView.test.tsx:133-151)
- `batch error toast shows message` — existing (:153-160)
- `error_count_toast_shows_count_when_errors_accumulated` — NEW: accumulate file:error count → "2 files could not reach target." at batch end
- `toast_success_says_compressed_N_files_with_done_count` — doneCount vs total-files distinction (10 dropped, 2 unsupported → 8 done)
- `toast.error on cancel/reveal command failures` — existing (useCompression.test.ts:336-358)
- `StrictMode duplicate-fire guard` — existing (:386-406)

### Task 4: Verify stale temp cleanup on launch

**Files:**
- Already implemented in `src-tauri/src/temp.rs` (`cleanup_stale_temp_files`)
- Already called in `lib.rs` setup

- [ ] **Step 1: Test stale cleanup**

1. Start app → compress a file → cancel mid-job → temp files exist in temp dir
2. Manually set temp file modification time to >24h ago:
   ```bash
   touch -t $(date -v-2d +%Y%m%d0000) /tmp/file-compressor/*/some_temp_file
   ```
3. Restart app → verify stale temp files are deleted

**Acceptance Criteria:**
- Implementation ALREADY SHIPPED + unit-tested above plan bar: `temp.rs:30-108` (`STALE_AFTER_SECS = 86_400`, mtime-based, injectable `now`), launch hook `lib.rs:43` in `.setup()`, per-job cleanup even on error/cancel (`queue.rs:304-305`)
- Unit coverage ALREADY COMPLETE (temp.rs:110-243): tree removal, missing-path no-op, idempotency, 86401/86400 exact boundary, stale-vs-fresh regular files, future-mtime keep, missing-dir safety — the plan's Step 1 manual procedure is REDUNDANT with these except the restart phase
- Manual restart verification stays as the only remaining check: follow the `touch -t` procedure above once (compress → cancel mid-job → age the temp files → restart → verify deleted)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `cleanup_stale_temp_files_removes_only_dirs_older_than_24h` — existing
- `cleanup_stale_temp_files_keeps_dir_at_exact_24h_boundary` — existing
- `cleanup_stale_temp_files_removes_stale_regular_files_not_fresh_ones` — existing
- `cleanup_temp_dir_removes_directory_tree` / `no_op_on_missing_path` / `idempotent_after_removal` — existing
- `cleanup_stale_temp_files_safe_when_app_temp_missing` — existing

### Task 5: Output folder writability pre-check

**Files:**
- Modify: `src-tauri/src/queue.rs`

- [ ] **Step 1: Add writability check before batch starts**

In `process_batch`, before processing any files:
```rust
let output_folder = settings.output_folder.clone();
if !std::path::Path::new(&output_folder).exists() {
    if let Err(e) = std::fs::create_dir_all(&output_folder) {
        let _ = app.emit("batch:error", serde_json::json!({
            "error": format!("Cannot create output folder: {}", e),
        }));
        return;
    }
}
// Test writability by creating a temp file
let test_file = std::path::Path::new(&output_folder).join(".write_test");
if let Err(e) = std::fs::write(&test_file, b"test") {
    let _ = app.emit("batch:error", serde_json::json!({
        "error": format!("Output folder not writable: {}", e),
    }));
    return;
}
let _ = std::fs::remove_file(&test_file);
```

- [ ] **Step 2: Handle batch:error in frontend**

In `useCompression` hook, listen for `batch:error` and show toast error.

**Acceptance Criteria:**
- BOTH steps ALREADY SHIPPED (with favorable substitutions over the plan's literal snippets — no new work):
- Rust preflight: `queue.rs:179-189` runs `ensure_output_folder_writable` FIRST inside `process_batch` before any file; impl at `:384-397` (create_dir_all if missing + `.write-probe` write/remove test); failure removes batch token + emits `batch:error` with `{ "batchId", "errorMessage" }` camelCase keys — the plan's snippet used an `"error"` key + `.write_test` probe, which would NOT have worked with the shipped frontend; message text "Output folder not writable: {e}" matches spec §6 L391. Sidecar-worker-down also emits batch:error (:136-141).
- Frontend batch:error: `useCompression.ts:168-174` listens `{ batchId, errorMessage }` → resets `isCompressing` + processedCount → `onBatchError(msg)` → `CompressView.tsx:41` `toast.error(message)`
- One downstream residual to keep in mind: preflight failure leaves queued-not-started files Pending (no file:cancelled per file) — covered by the batch summary work in Task 2
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `queue_batch_unwritable_folder_emits_batch_error_and_processes_nothing` — NEW: preflight runs BEFORE first job; assert zero jobs started (partial-mismatch state otherwise)
- `queue_batch_creates_missing_output_folder` — NEW: folder-deleted-between-runs is a real user scenario (USB unplugged)
- `queue_batch_create_dir_fails_emits_cannot_create_error` — NEW
- `write_test_file_removed_after_preflight` — NEW: probe file cleanup asserted (leftover = user-visible litter in Documents; no double-remove panic on write-fail path)
- `preflight_skips_when_folder_already_writable` — NEW: no spurious event
- `useCompression batch:error resets state` — existing (useCompression.test.ts:195-204)
- `batch error toast shows message` — existing (CompressView.test.tsx:153-160)

### Task 6: Acceptance check

- [ ] **Step 1: Test all acceptance criteria**

1. ✅ Per-file Cancel works
2. ✅ Cancel All works
3. ✅ Cancelled files: temp cleaned, marked Cancelled
4. ✅ Batch summary shows live counts
5. ✅ Toast on batch complete
6. ✅ Toast on errors
7. ✅ Stale temp cleanup on launch

**Acceptance Criteria:**
- Slices 5-7 processors land first (mixed-format ACs involving PDF/video/document fail by construction until then)
- Every AC above maps to a concrete test or E2E procedure — NO hand-waved ✅: enumerate per criterion which test/flow proves it (composite table; cite the Required Tests names from Tasks 1-5 above)
- Slice-8-only ACs (per-file cancel, cancel-all, summary counts, toasts, stale cleanup) mostly already shipped except: full AC4 count string (Task 2), AC6 error-count toast (Task 3)
- Production build green: `yarn tauri build` (both `.app/.dmg`, `.msi/.exe`, `.deb/.AppImage` bundles produced per platform)
- Sidecar audit gate PASS before final commit: `bash scripts/audit-sidecars.sh`
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `real_vips_compresses_oversized_jpeg_to_target` — existing ignored smoke (AC pattern for real-vips E2E)
- Composite AC table pinned: each of the 13 plan-level criteria → its proving test/flow (executor cannot hand-wave)
- `bash scripts/audit-sidecars.sh` → `sidecar audit: PASS` before final commit

- [ ] **Step 2: Run production build**

```bash
yarn tauri build
```

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: slice 8 complete — batch processing, cancellation, polish"
```