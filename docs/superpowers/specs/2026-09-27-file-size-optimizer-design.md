# File Size Optimizer — Design Spec

**Date:** 2026-09-27  
**Status:** Draft → Approved  
**License:** GPLv3

---

## 1. Product Overview & Users

### What

An offline desktop application for batch-optimizing files to maximum size limits while preserving the best possible quality. Users drag files in, the app compresses them to category-based size targets, and results are shown inline.

### Who

Anyone who needs to reduce file sizes for portals, email attachments, uploads, or storage — without understanding codecs, formats, bitrates, or compression algorithms. The app hides all technical complexity behind simple category-based size targets.

### Key Principles

- **Offline only** — no server, no account, no cloud, no uploads. All processing local.
- **Privacy by design** — user files never leave their machine.
- **Simple by default** — category targets, not format-specific knobs.
- **Originals preserved** — never modify source files, write to a separate output folder.
- **Open source (GPLv3)** — free to use, distribute, modify.

### Platforms

macOS, Windows, Linux.

---

## 2. Architecture & Tech Stack

### System Diagram

```
┌──────────────────────────────────────────────────────────┐
│                    Frontend (React + TS)                   │
│                   shadcn/ui + Tailwind CSS                 │
│                                                            │
│  Sidebar Layout                                            │
│  ├─ Compress View (drop zone, file list, results)          │
│  ├─ History View (future)                                  │
│  └─ Settings View (targets, output folder, quality floors) │
└──────────────────────────┬───────────────────────────────┘
                           │ Tauri IPC (commands + events)
┌──────────────────────────┴───────────────────────────────┐
│                    Rust Core (Tauri 2)                     │
│                                                            │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │ File        │  │ Target Size  │  │ Job Queue +  │     │
│  │ Detection   │  │ Engine       │  │ Cancellation │     │
│  │ + Category  │  │ (orchestrator)│  │ (tokio)      │     │
│  └─────────────┘  └──────┬───────┘  └──────────────┘     │
│                          │                                 │
│          CompressionProcessor trait                        │
│                          │                                 │
│    ┌─────────┬───────────┼───────────┬─────────┐          │
│    ▼         ▼           ▼           ▼         ▼          │
│  Image     Video        PDF       Document   Other        │
│  Proc      Proc         Proc      Proc       (skip +      │
│    │         │           │           │        warn)       │
│    ▼         ▼           ▼           ▼                    │
│  vips     ffmpeg +     gs +       zip crate               │
│  sidecar  ffprobe      qpdf       + vips sidecar          │
│           sidecars     sidecars                           │
└──────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Desktop framework | Tauri 2 | Cross-platform, Rust backend, small bundle, mature |
| Frontend | React + TypeScript + Vite | Standard, well-supported in Tauri ecosystem |
| UI components | shadcn/ui + Tailwind CSS | Used by every production Tauri+React app (Clypra, wealthfolio, clash-nyanpasu). Desktop-tuned design tokens. No library lock-in — component code lives in repo. |
| Sidebar | shadcn sidebar block | Must use existing shadcn sidebar block (not custom). Agent must ask which specific block to use during implementation. |
| Async runtime | Tokio (via Tauri) | Job queue, cancellation, concurrent file processing |
| Settings storage | tauri-plugin-store | Official Tauri plugin, handles platform paths automatically |
| Image processing | libvips (`vips` CLI sidecar) | Fastest, lowest memory, JPEG/PNG/WebP/HEIC, LGPLv3 |
| Video processing | FFmpeg + ffprobe (sidecars) | Industry standard, two-pass target-size encoding, GPLv2+ |
| PDF processing | Ghostscript + qpdf (sidecars) | Ghostscript for aggressive compression, qpdf for lossless first pass |
| Document processing | Rust `zip` crate + vips sidecar | Unzip OOXML → recompress embedded media → rezip at level 9 |
| Toast notifications | sonner (via shadcn/ui) | Batch completion + error notifications |
| App license | GPLv3 | Compatible with all dependencies (FFmpeg GPLv2+, Ghostscript AGPLv3, libvips LGPLv3) |

### Sidecar Binaries

Shipped via Tauri's `externalBin` mechanism. Each binary named with target triple suffix (e.g. `vips-aarch64-apple-darwin`).

| Binary | Approx Size | License | Role |
|--------|------------|---------|------|
| `vips` | ~15 MB | LGPLv3 | Image compression + document media recompression |
| `ffmpeg` | ~70 MB | GPLv2+ (with libx264/libx265) | Video encoding |
| `ffprobe` | ~30 MB | GPLv2+ | Video metadata probing (duration, resolution) |
| `gs` (Ghostscript) | ~30 MB | AGPLv3 | Aggressive PDF compression |
| `qpdf` | ~5 MB | Apache 2.0 | Lossless PDF optimization (first pass) |

**Total sidecar budget:** ~150 MB per platform.

### Design Rules

- Compression core is fully independent of UI — all compression logic in Rust, frontend only sends commands and receives events.
- Adding a format = implement `CompressionProcessor` trait + register in the registry. Engine stays unchanged.
- Sidecar binaries called via `std::process::Command` with paths resolved from Tauri's resource directory.

### Shadcn Preset

The project uses a custom shadcn preset for initialization:

```bash
yarn dlx shadcn@latest init --preset bNRvlrmDx --template vite
```

### Theme Tokens

Green primary palette. Key tokens:

**Light mode:**
- `--primary: oklch(0.527 0.154 150.069)` — green
- `--background: oklch(1 0 0)` — white
- `--radius: 0.45rem`

**Dark mode:**
- `--primary: oklch(0.448 0.119 151.328)` — green
- `--background: oklch(0.145 0 0)` — near-black
- `--border: oklch(1 0 0 / 10%)` — translucent white

Full theme tokens documented in the shadcn preset. System preference controls light/dark switching.

---

## 3. File Categories & Format Support

### User-Facing Categories

Only these 5 categories appear in the UI. Individual formats are an internal implementation detail.

| Category | Default Target | Quality Floor | Initial Formats |
|----------|---------------|---------------|-----------------|
| Images | 200 KB | Q=30 | JPEG, PNG, WebP, HEIC/HEIF |
| Videos | 10 MB | CRF=28, 480p min | MP4, MOV |
| PDF | 2 MB | 72 DPI, JPEGQ=15 | PDF |
| Documents | 1 MB | Q=40 on embedded media | DOCX, XLSX, PPTX |
| Other | — | — | Unsupported (skip + warn) |

### Category Detection

- File extension → category mapping in a static registry (internal, not user-facing).
- Unknown extensions → "Other" category → shown in file list with "Unsupported" badge → skipped during compression.
- Detection is extension-based in v1. Future: sniff file magic bytes for robustness.

### Format → Output Format

| Input | Output | Reason |
|-------|--------|--------|
| JPEG | JPEG | Same format |
| PNG | PNG | Same format |
| WebP | WebP | Same format |
| HEIC/HEIF | JPEG | Broader portal support, avoids x265 patent issues for output |
| MP4 | MP4 | H.264 + AAC |
| MOV | MP4 | Re-encoded to MP4 for broader portal compatibility |
| PDF | PDF | Same format |
| DOCX | DOCX | Only embedded media recompressed; XML/structure preserved |
| XLSX | XLSX | Only embedded media recompressed |
| PPTX | PPTX | Only embedded media recompressed |

### Target Resolution Order

1. Category default (set in Settings, editable by user)
2. Application default (built-in defaults above)

Per-file override is **not in v1**. Users change category defaults in Settings. May be added in v2.

---

## 4. User Interface Design

### Layout

Sidebar layout using shadcn sidebar block. Three views:

1. **Compress** — main workflow (drop zone, file list, results, actions)
2. **History** — placeholder for future (not in v1)
3. **Settings** — category targets, output folder, quality floors

### Compress View

```
┌─────────────────────────────────────────────────────────────┐
│  [traffic lights]    File Size Optimizer            [gear]   │
├──────────┬──────────────────────────────────────────────────┤
│          │                                                  │
│ Sidebar  │  Compress Files                                  │
│          │                                                  │
│ ┌──────┐ │  ┌────────────────────────────────────────────┐ │
│ │ icon │ │  │            Drop files to compress            │ │
│ │Optim-│ │  │            or browse from computer           │ │
│ │izer  │ │  └────────────────────────────────────────────┘ │
│ └──────┘ │                                                  │
│          │  ┌────────────────────────────────────────────┐ │
│ ▸Compress│  │ File        Category  Target   Status   Act│ │
│  History │  │ photo1.jpg  Image     200 KB   ✓ Done   📂 │ │
│  Settings│  │   1.2 MB → 180 KB · 65% smaller              │ │
│          │  │ marksheet   PDF       2 MB     ✓ Done   📂 │ │
│          │  │   4.1 MB → 1.7 MB · 59% smaller              │ │
│          │  │ video.mp4   Video     10 MB    45% [▓▓▓░░] │ │
│          │  │   25 MB → compressing…      [Cancel]        │ │
│          │  │ assign.docx Document  1 MB     Pending       │ │
│          │  │ large.png   Image     200 KB   ⚠ Best effort│ │
│          │  │   8 MB → 320 KB · target not met             │ │
│          │  │ archive.zip Other    —        ✕ Unsupported  │ │
│          │  └────────────────────────────────────────────┘ │
│          │                                                  │
│ v1.0.0   │  6 files · 2 done · 1 compressing…  [Compress]  │
│ GPLv3    │                              [Clear] [Cancel All]│
└──────────┴──────────────────────────────────────────────────┘
```

### Compress View Behavior

- Drag files (or click to browse) → files appear in list with detected category + target.
- Can drag more files at any time — they append to the list.
- Click **Compress** → all pending files process sequentially. Progress bar per file + overall.
- Each in-progress file row has a **Cancel** button (per-file cancellation).
- **Cancel All** button at bottom cancels remaining queue.
- Completed rows show: original size → new size, % reduction, **Reveal in folder** button (hover-reveal).
- Failed/unachievable rows show warning + reason (e.g. "Could not reach target at quality floor. Best result: 320 KB").
- Unsupported files show "Unsupported" badge, skipped during compression.
- **Clear** removes all files from the list (does not delete output files).
- Batch summary in footer with live counts: `6 files · 2 done · 1 compressing · 1 pending · 1 warning · 1 skipped`.

### Settings View

Settings is a **view inside the sidebar layout**, not a separate window.

**Sections:**

1. **Output Folder** — path display + Browse button (opens native folder picker via Tauri dialog). Default: `~/Documents/Compressed`.
2. **Category Targets** — number input + unit selector (KB/MB) per category, shown with category badge + supported formats hint.
3. **Quality Floors (advanced)** — collapsed under a details/summary element. Most users never touch these.
   - Images minimum quality: 30%
   - Videos minimum CRF: 28
   - Videos minimum resolution: 480p
   - PDF minimum DPI: 72
   - PDF minimum JPEG quality: 15%
   - Documents media quality: 40%

**Footer:** Save Changes / Cancel buttons (sticky). Changes apply to next compression run, not retroactive.  
**Header:** "Reset to defaults" link — restores built-in values.

### Status Colors

| Status | Color | Meaning |
|--------|-------|---------|
| Done | primary (green) | Target met successfully |
| Compressing | primary (green, pulsing) | In progress |
| Pending | muted-foreground | Waiting in queue |
| Best effort | destructive (red) | Target unmet at quality floor, best result saved |
| Unsupported | muted-foreground (dimmed) | Format not supported, skipped |
| Cancelled | muted-foreground | User cancelled |
| Failed | destructive (red) | Error during compression |

### Notifications

- Toast (sonner) on batch complete: "Compressed 8 files. Saved 14.3 MB total."
- Toast on errors: "2 files could not reach target."

### Design Tokens

Desktop-tuned shadcn configuration:
- Font: Inter
- Border radius: 0.45rem
- Tabular-nums for all size figures
- Hover-reveal actions on table rows (reduce visual noise)
- System preference for light/dark mode
- Native traffic lights on macOS, standard buttons on Windows/Linux

---

## 5. Target Size Engine & Compression Algorithms

### Trait Interface

```rust
trait CompressionProcessor {
    fn category(&self) -> Category;
    fn supported_extensions(&self) -> &[&str];
    fn compress_to_target(
        &self,
        input: &Path,
        output: &Path,
        target_bytes: u64,
        quality_floor: &QualityFloor,
        cancel_token: CancellationToken,
        progress: ProgressSender,
    ) -> Result<CompressionResult>;
}
```

### Binary Search Algorithm (generic, all categories)

```
1. Start with highest quality setting
2. Compress → measure output size
3. If output ≤ target → done (try higher quality to maximize)
4. If output > target → lower quality, retry
5. If quality hits floor AND output still > target → return "best effort" with actual result
6. If still over after quality floor → try dimension/resolution reduction
7. If still over → return best attempt + warning "target not achievable"
```

### Per-Category Strategies

#### Images (libvips sidecar)

- Binary search on `Q` parameter (5–95, 8 iterations max).
- If Q hits floor (30) and still over → reduce dimensions by 10% increments.
- HEIC input → JPEG output (broader portal support, avoids x265 patent issues for output).
- Strip all metadata by default (`strip` flag).
- CLI pattern: `vips copy input.jpg output.jpg[Q=75,strip]`

#### Videos (FFmpeg + ffprobe sidecars)

- Get duration via ffprobe: `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4`
- Calculate target bitrate: `(target_bytes * 8 * 0.95) / duration_seconds`
- Two-pass encode with calculated bitrate (H.264 + AAC).
- Pass 1 (analysis): `ffmpeg -y -i input -c:v libx264 -b:v {bitrate}k -pass 1 -passlogfile prefix -an -f mp4 /dev/null`
- Pass 2 (encode): `ffmpeg -i input -c:v libx264 -b:v {bitrate}k -pass 2 -passlogfile prefix -c:a aac -b:a 128k output.mp4`
- If over target → reduce resolution (1080p → 720p → 480p, floor at 480p).
- If still over → increase CRF (lower quality), floor at CRF 28.
- Windows note: use `NUL` instead of `/dev/null` for pass 1 output.
- **Do NOT use `-fs` flag** — it truncates the video, producing incomplete output.

#### PDF (qpdf → Ghostscript fallback)

- **Pass 1:** qpdf lossless — `qpdf --linearize --object-streams=generate --compression-level=9 input.pdf output.pdf`
- If over target → **Pass 2:** qpdf with image optimization — `qpdf --linearize --object-streams=generate --recompress-flate --compression-level=9 --optimize-images --jpeg-quality=75 input.pdf output.pdf`
- If still over → **Pass 3:** Ghostscript `/screen` preset (72 DPI) — `gs -sDEVICE=pdfwrite -dPDFSETTINGS=/screen -dNOPAUSE -dQUIET -dBATCH -sOutputFile=output.pdf input.pdf`
- If still over → binary search on Ghostscript DPI (100 → 72 → 50 → 36) + JPEGQ (60 → 40 → 25 → 15).
- Floor: 72 DPI, JPEGQ 15.

#### Documents (Rust zip crate + vips sidecar)

- Unzip OOXML container using Rust `zip` crate.
- Find embedded media directories: `word/media/`, `ppt/media/`, `xl/media/`.
- Recompress each image using vips sidecar (binary search on quality, floor Q=40).
- Re-zip with DEFLATE level 9 using `zip` crate's `CompressionMethod::Deflated` + `compression_level(9)`.
- If over target → lower media quality further, retry.
- EMF/WMF embedded images: skipped in v1 (no mature CLI tool for conversion).
- Only embedded media is recompressed; XML and document structure preserved.

### Cancellation

- Each compression job receives a `CancellationToken` (tokio).
- Per-file cancel: drops the token for that job → kills the sidecar process (`Command::kill()`).
- Cancel All: drops tokens for all pending + in-progress jobs.
- In-progress file finishes current sidecar call then exits; incomplete temp files cleaned up.

### Progress Reporting

- Engine sends progress events via Tauri IPC events to the frontend.
- **Per-file progress:**
  - Images/PDF: percentage based on binary search iteration count.
  - Video: parsed from FFmpeg stderr (`time=` or `out_time_ms=` field).
- **Overall batch progress:** completed files / total files.

---

## 6. Safety, Error Handling & Edge Cases

### File Safety

- Original files are **never modified** — all processing reads from source, writes to output folder.
- Output filename = same as input. Collision handling: append `-1`, `-2` suffix (e.g. `photo-1.jpg`).
- Temp files written to OS temp dir + app subfolder. Cleaned up after each job, even on error/cancel.
- On next launch: scan temp dir for stale files older than 24h and delete them.

### Unsupported Files

- Extension not in any category registry → marked "Other" → shown in list with "Unsupported" badge → skipped during compression.
- Not an error — just skipped with clear status.

### Error States

| Scenario | Behavior |
|----------|----------|
| Sidecar binary missing/crashed | Job fails with "Engine error: [tool] not available". Toast notification. |
| Input file unreadable / permission denied | Job fails with "Cannot read file". |
| Output folder unwritable | Entire batch fails before start with "Output folder not writable" dialog. |
| Target already met (file under target) | Skipped — marked "Already under target" with original size shown. File copied to output as-is. |
| Target unachievable at quality floor | "Best effort" result saved + warning shown with actual size. |
| Corrupt input file | Sidecar exits with error code → job fails with "File may be corrupt". |
| Disk full during compression | Job fails with "Not enough disk space". Temp files cleaned. |
| User cancels mid-job | Sidecar process killed. Temp files deleted. File marked "Cancelled". |

### "Already Under Target" Optimization

- Before running any compression, check if `file_size <= target_bytes`.
- If yes → copy file to output as-is, mark "Already under target (no compression needed)".
- Saves processing time and avoids unnecessary quality loss.

### Filename Collision Resolution

```
photo.jpg exists in output → photo-1.jpg
photo-1.jpg exists → photo-2.jpg
(photo-1.jpg was from a previous run, not this batch)
```

---

## 7. Data Models & IPC

### Settings (tauri-plugin-store)

```json
{
  "outputFolder": "~/Documents/Compressed",
  "categoryTargets": {
    "image": { "size": 200, "unit": "KB" },
    "video": { "size": 10, "unit": "MB" },
    "pdf": { "size": 2, "unit": "MB" },
    "document": { "size": 1, "unit": "MB" }
  },
  "qualityFloors": {
    "image": { "minQuality": 30 },
    "video": { "minCrf": 28, "minResolution": "480p" },
    "pdf": { "minDpi": 72, "minJpegQuality": 15 },
    "document": { "minMediaQuality": 40 }
  }
}
```

### Tauri IPC Commands (Frontend → Rust)

| Command | Payload | Returns |
|---------|---------|---------|
| `add_files` | `file_paths: Vec<String>` | `Vec<FileEntry>` — detected category + target per file |
| `remove_file` | `file_id: String` | `()` — removes from batch list |
| `clear_list` | — | `()` — clears all files from batch |
| `compress_all` | — | `batch_id: String` — starts batch, returns immediately |
| `cancel_file` | `file_id: String` | `()` — cancels one in-progress file |
| `cancel_all` | `batch_id: String` | `()` — cancels remaining queue |
| `get_settings` | — | `Settings` |
| `save_settings` | `settings: Settings` | `()` |
| `reset_settings` | — | `Settings` — restores defaults |
| `browse_folder` | — | `String \| null` — opens native folder picker, returns path |
| `reveal_in_folder` | `file_path: String` | `()` — opens OS file manager at file location |

### Tauri IPC Events (Rust → Frontend)

| Event | Payload | When |
|-------|---------|------|
| `file:progress` | `{ file_id, percent }` | During compression, per file |
| `file:complete` | `{ file_id, output_path, original_size, compressed_size, status }` | File done |
| `file:error` | `{ file_id, error_message }` | File failed |
| `file:cancelled` | `{ file_id }` | File was cancelled |
| `batch:complete` | `{ batch_id, total_saved_bytes }` | All files in batch processed |
| `file:added` | `{ file_id, name, category, target, size }` | After `add_files` resolves categories |

### Data Types

```rust
enum Category {
    Image,
    Video,
    Pdf,
    Document,
    Other,
}

enum FileStatus {
    Pending,
    Compressing,
    Done,
    BestEffort,
    Failed,
    Cancelled,
    Unsupported,
    AlreadyUnderTarget,
}

struct FileEntry {
    id: String,           // UUID
    name: String,
    path: String,
    category: Category,
    target_bytes: u64,
    original_size: u64,
    status: FileStatus,
    compressed_size: Option<u64>,
    output_path: Option<String>,
    error: Option<String>,
}

struct CompressionResult {
    output_path: PathBuf,
    compressed_size: u64,
    quality_used: u32,
    met_target: bool,
    strategy_used: String,  // e.g. "quality=75" or "quality=30,dims=80%"
}
```

### Job Queue (Rust side)

- `tokio::sync::mpsc` channel — frontend sends jobs, a worker task processes sequentially.
- One file at a time (simpler, avoids sidecar resource contention, predictable progress).
- Each job has its own `CancellationToken` stored in a `HashMap<file_id, CancellationToken>`.
- Cancel All iterates the map and triggers all tokens.

---

## 8. Offline / Privacy

- No server.
- No account.
- No cloud processing.
- No upload of user files.
- All processing happens locally.
- No database required in v1.
- Internet connection is not required for normal operation.
- No telemetry, no analytics, no crash reporting sent anywhere.

---

## 9. MVP Scope (v1)

All 4 categories in v1:

- Mixed-format batch input
- Category-based compression targets
- User-editable category defaults (Settings view)
- Automatic file type/category detection
- Image compression (JPEG, PNG, WebP, HEIC → JPEG)
- Video compression (MP4, MOV → MP4)
- PDF compression (qpdf + Ghostscript)
- Document compression (DOCX, XLSX, PPTX — embedded media recompression)
- Batch processing with sequential job queue
- Per-file and cancel-all cancellation
- Progress reporting (per-file + batch)
- Original-file preservation (write to output folder)
- Before/after file sizes in file list
- Quality floors (advanced settings)
- "Best effort" indication when target cannot be achieved
- "Already under target" detection (skip compression, copy as-is)
- Unsupported file detection and clear status
- Sidebar layout (Compress, History placeholder, Settings)
- Toast notifications on batch complete / errors
- Dark/light theme via system preference

### Not in v1

- Per-file target override (change category default instead)
- History view (sidebar item placeholder only)
- Batch presets/profiles
- Custom quality floor per file
- HEIC output (input only, converts to JPEG)
- EMF/WMF embedded image conversion in documents
- File magic byte detection (extension-based in v1)
- Telemetry / crash reporting
- Auto-update mechanism

---

## 10. Research References

- **Compression tools research:** `COMPRESSION_TOOLS_RESEARCH.md` (CLI commands, licensing, binary sources per platform)
- **Tauri-skills security audit:** `full-stack-skills/tauri-skills` repo contains markdown prompt files only — no executable code, no network, no secrets. Safe to use as a topic index. Community-maintained (not official Tauri). Pin commit SHA if installing. Cross-check against `v2.tauri.app` docs.
- **UI library research:** Every production Tauri+React app (Clypra, wealthfolio, clash-nyanpasu) uses Radix UI + Tailwind, most via shadcn/ui. No Tauri app uses Mantine/Chakra/Ant Design.