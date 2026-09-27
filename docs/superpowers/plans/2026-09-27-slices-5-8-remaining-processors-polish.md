# Slices 5-8: Remaining Processors + Batch Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PDF, Video, Document processors (each implementing the existing `CompressionProcessor` trait from Slice 4), then add batch cancellation UI, toast notifications, and stale temp cleanup.

**Architecture:** Each new processor follows the same pattern as `ImageProcessor`: implement `CompressionProcessor` trait, bundle sidecar binary, register in `ProcessorRegistry`. The engine, job queue, and IPC events from Slice 4 are reused unchanged.

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

- [ ] **Step 1: Create pdf.rs implementing CompressionProcessor**

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

- [ ] **Step 2: Modify trait to accept SidecarPaths**

Update `src-tauri/src/engine/trait.rs`:

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

- [ ] **Step 3: Implement PdfProcessor::compress_to_target**

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

- [ ] **Step 4: Register PdfProcessor in mod.rs**

```rust
let pdf_proc = pdf::PdfProcessor::new();
for ext in pdf_proc.supported_extensions() {
    extension_map.insert(ext.to_lowercase(), Category::Pdf);
}
processors.insert(Category::Pdf, Box::new(pdf_proc));
```

- [ ] **Step 5: Bundle qpdf + gs sidecar binaries**

Download qpdf and gs binaries for the current platform. Place in `src-tauri/binaries/` with target triple suffix. Add to `tauri.conf.json` `externalBin`:

```json
"externalBin": [
  "binaries/vips",
  "binaries/qpdf",
  "binaries/gs"
]
```

- [ ] **Step 6: Test end-to-end**

Drop a large PDF → compress → verify output is ≤ 2 MB (or "Best effort"). Verify output PDF opens correctly.

- [ ] **Step 7: Commit**

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

- [ ] **Step 1: Create video.rs**

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

- [ ] **Step 2: Register VideoProcessor in mod.rs**

- [ ] **Step 3: Bundle ffmpeg + ffprobe sidecar binaries**

Download from:
- macOS: `evermeet.cx/ffmpeg/`
- Windows: `github.com/BtbN/FFmpeg-Builds/releases`
- Linux: `johnvansickle.com/ffmpeg/`

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

- [ ] **Step 4: Test end-to-end**

Drop an MP4 → compress → verify output ≤ 10 MB. Verify output plays. Drop a MOV → verify MP4 output.

- [ ] **Step 5: Commit**

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

### Task 2: Create DocumentProcessor

**Files:**
- Create: `src-tauri/src/processors/document.rs`
- Modify: `src-tauri/src/processors/mod.rs` (register DocumentProcessor)

- [ ] **Step 1: Create document.rs**

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

- [ ] **Step 2: Register DocumentProcessor in mod.rs**

- [ ] **Step 3: Test end-to-end**

Drop a DOCX with embedded images → compress → verify output ≤ 1 MB. Verify output opens in Word/LibreOffice. Test XLSX and PPTX.

- [ ] **Step 4: Commit**

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

### Task 2: Add batch summary footer + Cancel All button

**Files:**
- Modify: `src/views/CompressView.tsx`

- [ ] **Step 1: Add batch summary**

Compute counts from file list:
```typescript
const done = files.filter(f => f.status === 'done').length
const compressing = files.filter(f => f.status === 'compressing').length
const pending = files.filter(f => f.status === 'pending').length
const warning = files.filter(f => f.status === 'best_effort').length
const skipped = files.filter(f => f.status === 'unsupported').length
```

Display: "6 files · 2 done · 1 compressing · 1 pending · 1 warning · 1 skipped"

- [ ] **Step 2: Add Cancel All button**

Show "Cancel All" button (destructive variant) when `isCompressing` is true. Clicking calls `cancelAll()`.

### Task 3: Add toast notifications

**Files:**
- Modify: `src/views/CompressView.tsx` or `src/App.tsx`

- [ ] **Step 1: Add sonner Toaster to App**

```tsx
import { Toaster } from '@/components/ui/sonner'

// At the bottom of App component:
<Toaster />
```

- [ ] **Step 2: Show toast on batch complete**

In `useCompression` hook, on `batch:complete` event:
```typescript
const totalSavedMB = (e.payload.totalSavedBytes / (1024 * 1024)).toFixed(1)
toast.success(`Compressed ${doneCount} files. Saved ${totalSavedMB} MB total.`)
```

- [ ] **Step 3: Show toast on errors**

On `file:error` events, accumulate error count. On `batch:complete`, if errorCount > 0:
```typescript
toast.error(`${errorCount} files could not reach target.`)
```

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

### Task 6: Acceptance check

- [ ] **Step 1: Test all acceptance criteria**

1. ✅ Per-file Cancel works
2. ✅ Cancel All works
3. ✅ Cancelled files: temp cleaned, marked Cancelled
4. ✅ Batch summary shows live counts
5. ✅ Toast on batch complete
6. ✅ Toast on errors
7. ✅ Stale temp cleanup on launch

- [ ] **Step 2: Run production build**

```bash
yarn tauri build
```

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: slice 8 complete — batch processing, cancellation, polish"
```