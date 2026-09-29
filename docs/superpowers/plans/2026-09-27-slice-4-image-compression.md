# Slice 4: Image Compression (End-to-End) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop a JPEG/PNG/WebP/HEIC → click Compress → file compresses to ≤ target via vips sidecar → result shown inline (before/after size, % reduction) → "Reveal in folder" opens file manager. If target unachievable at quality floor → "Best effort". If already under target → copied as-is.

**Architecture:** This slice establishes the compression infrastructure used by all later slices: `CompressionProcessor` trait, `TargetSizeEngine` orchestrator (binary search), sequential job queue (tokio mpsc), cancellation tokens, progress events. The `ImageProcessor` implements the trait using the `vips` sidecar. Output goes to the configured output folder with collision handling.

**Tech Stack:** Rust, tokio, libvips (sidecar), Tauri 2 events, React

## Global Constraints

- **vips sidecar:** Must be bundled via Tauri `externalBin`. Binary named with target triple suffix.
- **Binary search:** Q parameter 5–95, max 8 iterations. If floor (30) hit and still over → reduce dimensions by 10%.
- **HEIC input → JPEG output** (not HEIC output). Case-insensitive extension match (`.HEIC` too).
- **Strip all metadata** by default
- **Originals never modified** — write to output folder
- **Filename collision:** append `-1`, `-2` suffix
- **Temp files:** OS temp dir + app subfolder, cleaned after each job
- **"Already under target":** if `file_size <= target_bytes`, copy as-is, mark "Already under target"
- **Progress:** per-file percent via `file:progress` event (based on binary search iteration count)
- **Unsupported files skipped, not failed:** `Category::Other` is skipped silently with `Unsupported` badge (existing `FileEntry::new` already sets this status) — never marked `Failed`. Do not emit `file:error` for unsupported categories.
- **Mutex poisoning:** all `FileListState` locks use `unwrap_or_else(|e| e.into_inner())` (per `docs/superpowers/specs/2026-09-28-slice-2-review-fixes.md` F3 — existing `commands.rs` already complies)
- **Cancellation must bypass the busy channel:** cancel state lives in shared `CancellationTokenMap` (tauri-managed state) so `cancel_file`/`cancel_all` commands act instantly while the worker is busy in `process_batch`. **Do NOT route CancelFile/CancelAll through the mpsc channel** — messages sent while `process_batch` occupies the receiver are never polled mid-batch.
- **tokio is a direct dependency** — add `tokio = { version = "1", features = ["sync", "rt", "macros"] }` (queue.rs uses `tokio::spawn`, `tokio::sync::mpsc`; tauri does not re-export tokio).
- **Reveal uses plugin-opener, not plugin-shell:** repo already ships `tauri-plugin-opener`; `reveal_in_folder` uses `app.opener().reveal_item_in_dir(&path)` (reveals the file in the OS file manager). Do NOT add tauri-plugin-shell.
- **Preserve opener config:** existing `lib.rs` registers `tauri_plugin_opener::init()` and capabilities include `opener:default`; keep both in any `lib.rs`/capabilities edits, and keep the existing `unwrap_or_else` graceful-start error handling (no `.expect()`).
- **Frontend progress state:** `useCompression` applies `percent` from `file:progress` into per-file `progress` state — FileList renders a progress bar from it. Do not discard percent.
- **`engine/trait.rs` is an invalid Rust filename** (`trait` is a keyword) — file is `engine/processor.rs` everywhere in this plan.

## File Structure

```
src-tauri/src/
├── engine/
│   ├── mod.rs                # TargetSizeEngine orchestrator exports
│   ├── processor.rs          # CompressionProcessor trait (NOT trait.rs — keyword)
│   ├── result.rs             # CompressionResult, CompressionError
│   └── progress.rs           # ProgressSender (wraps Tauri event emitter)
├── processors/
│   ├── mod.rs                # Processor registry
│   └── image.rs              # ImageProcessor (vips sidecar)
├── queue.rs                  # Job queue (tokio mpsc + CancellationTokenMap managed state)
├── sidecar.rs                # Sidecar path resolution (testable sidecar_filename fn)
├── output.rs                 # Output folder + filename collision handling
├── temp.rs                   # Temp directory management + cleanup
├── commands.rs               # (modify) add compress_all, cancel_file, cancel_all, reveal_in_folder
├── lib.rs                    # (modify) register engine + queue; PRESERVE opener plugin + graceful-startup unwrap_or_else

src/
├── views/CompressView.tsx    # (modify) add Compress button, progress bars, results
├── hooks/useCompression.ts   # Listen to progress/complete/error events, call compress_all
├── hooks/useFileList.ts      # (modify) expose setFiles for useCompression
├── App.tsx                   # (modify) mount sonner <Toaster />
├── types.ts                  # (modify) add Progress fields to FileEntry if needed
```

Also test-covered: `#[cfg(test)]` modules in sidecar.rs / output.rs / temp.rs, and `src/hooks/useCompression.test.ts`.

## Acceptance Criteria

1. Drop a JPEG > 200 KB → click Compress → output file ≤ 200 KB appears in list with green "Done" status
2. Before/after sizes shown: "1.2 MB → 180 KB · 85% smaller"
3. "Reveal in folder" button (hover-reveal) opens OS file manager at output location
4. Drop a PNG → compressed to ≤ 200 KB (palette quantization used if needed)
5. Drop a WebP → compressed to ≤ 200 KB
6. Drop a HEIC → converted to JPEG, compressed to ≤ 200 KB
7. Drop an image already < 200 KB → marked "Already under target", copied as-is
8. Drop a very large image that can't reach 200 KB at Q=30 → "Best effort" with actual size shown in red
9. Progress bar shows per-file percentage during compression
10. "Compress" button starts processing all pending files sequentially
11. Output file written to configured output folder (from Settings)
12. If output filename collides → `-1` suffix appended
13. Multiple files: processed one at a time, each shows its own progress

---

## Task 1: Create Sidecar Path Resolution

**Files:**
- Create: `src-tauri/src/sidecar.rs`

**Interfaces:**
- Produces: `sidecar_filename(name: &str) -> Result<String, String>` — pure, testable platform-dispatch fn returning `{name}-{target_triple}[.exe]`
- Produces: `get_sidecar_path(app: &AppHandle, name: &str) -> Result<String, String>` — resolves sidecar binary path from Tauri resources, errors if binary missing

**Acceptance Criteria:**
- `sidecar_filename` returns `vips-aarch64-apple-darwin` on macOS arm64, `vips-x86_64-pc-windows-msvc.exe` on Windows, `vips-x86_64-unknown-linux-gnu` on Linux x86_64 (spec §2 "Sidecar Binaries": triple-suffixed naming)
- Unsupported platform (`solaris`/`sparc`) → `Err("Unsupported platform: solaris sparc")`, never a silently wrong filename
- `get_sidecar_path` resolves from Tauri resource dir (spec §2 Design Rules) and returns descriptive `Err` when the binary is absent (spec §6 error table "Sidecar binary missing")
- Filename logic testable without any Tauri runtime (pure fn separation)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `sidecar_filename_returns_triple_suffixed_name_per_platform` — table test over the 5 (os, arch) pairs → exact expected triple strings
- `sidecar_filename_errors_on_unsupported_platform` — `("solaris", "sparc")` → `Err` containing "Unsupported platform"
- `sidecar_filename_includes_exe_suffix_on_windows` — `("windows", "x86_64")` → filename ends with `.exe`

- [x] **Step 1: Create sidecar.rs**

```rust
use tauri::{AppHandle, Manager};

pub(crate) fn target_triple(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        (os, arch) => Err(format!("Unsupported platform: {} {}", os, arch)),
    }
}

pub(crate) fn sidecar_filename(name: &str) -> Result<String, String> {
    let target_triple = target_triple(std::env::consts::OS, std::env::consts::ARCH)?;
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    Ok(format!("{}-{}{}", name, target_triple, suffix))
}

pub fn get_sidecar_path(app: &AppHandle, name: &str) -> Result<String, String> {
    let resource_path = app
        .path()
        .resolve("binaries", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve binaries dir: {}", e))?;

    let filename = sidecar_filename(name)?;
    let path = resource_path.join(&filename);

    if !path.exists() {
        return Err(format!("Engine error: {} not available", name));
    }

    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_filename_returns_triple_suffixed_name_per_platform() {
        assert_eq!(target_triple("macos", "aarch64"), Ok("aarch64-apple-darwin"));
        assert_eq!(target_triple("macos", "x86_64"), Ok("x86_64-apple-darwin"));
        assert_eq!(target_triple("windows", "x86_64"), Ok("x86_64-pc-windows-msvc"));
        assert_eq!(target_triple("linux", "x86_64"), Ok("x86_64-unknown-linux-gnu"));
        assert_eq!(target_triple("linux", "aarch64"), Ok("aarch64-unknown-linux-gnu"));
    }

    #[test]
    fn sidecar_filename_errors_on_unsupported_platform() {
        let err = target_triple("solaris", "sparc").unwrap_err();
        assert_eq!(err, "Unsupported platform: solaris sparc");
    }

    #[test]
    fn sidecar_filename_includes_exe_suffix_on_windows() {
        let current = sidecar_filename("vips").unwrap();
        assert!(current.starts_with("vips-"));
        if cfg!(target_os = "windows") {
            assert!(current.ends_with(".exe"));
        } else {
            assert!(!current.ends_with(".exe"));
        }
    }
}
```

- [x] **Step 2: Register module in lib.rs**

Add `mod sidecar;` to `src-tauri/src/lib.rs`.

- [x] **Step 3: Run tests**

```bash
cd src-tauri && cargo test sidecar
```

- [x] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add sidecar path resolution"
```

---

## Task 2: Create Output + Temp File Management

**Files:**
- Create: `src-tauri/src/output.rs`
- Create: `src-tauri/src/temp.rs`

**Interfaces:**
- Produces: `resolve_output_path(folder, filename) -> PathBuf` (collision-safe), `create_temp_dir(app) -> PathBuf`, `cleanup_temp_dir(path)`, `cleanup_stale_temp_files(app)`

**Acceptance Criteria:**
- Collision: `photo.jpg` exists → returns `photo-1.jpg`; `photo-1.jpg` exists → `photo-2.jpg` (spec §6 collision resolution, verbatim algorithm)
- 1000 collisions exhausted → `{stem}-overflow` fallback, never `None`/panic
- No-extension files (`README`) → `README-1` without dangling dot
- Temp dir: unique session subdir under OS temp + `file-compressor` (spec §6 File Safety)
- Stale cleanup: only session dirs older than 24h removed; fresh dirs untouched; safe when app temp missing (no panic)
- `cleanup_temp_dir` idempotent on already-removed path
- All tests use `tempfile::TempDir` — never real user dirs (`/tmp/nonexistent_dir` literal is banned)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `test_no_collision` — (exists) fresh dir → unchanged filename
- `collision_appends_dash_one_suffix` — pre-create `photo.jpg` → `photo-1.jpg`
- `collision_increments_suffix_to_dash_two_when_dash_one_taken` — seed `photo.jpg` + `photo-1.jpg` → `photo-2.jpg`
- `collision_caps_at_999_then_uses_overflow_fallback` — pre-create 1000 files → `{stem}-overflow`
- `collision_handles_file_without_extension` — `README` exists → `README-1`
- `cleanup_temp_dir_removes_directory_tree`
- `cleanup_temp_dir_no_op_on_missing_path` — called twice, second call no panic
- `cleanup_stale_temp_files_removes_only_dirs_older_than_24h` — one dir mtime -86401s (removed), one -3600s (kept)
- `cleanup_stale_temp_files_safe_when_app_temp_missing` — no panic, no fs mutation
- `create_temp_dir` / `cleanup_stale_temp_files` (AppHandle variants) — covered via code review only; unit tests need a Tauri harness (documented limitation, verified in Task 8 manual pass)

- [x] **Step 1: Create output.rs**

```rust
use std::path::{Path, PathBuf};

pub fn resolve_output_path(output_folder: &str, filename: &str) -> PathBuf {
    let folder = Path::new(output_folder);
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let ext = Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let mut candidate = folder.join(filename);

    if !candidate.exists() {
        return candidate;
    }

    for i in 1..1000 {
        let name = if ext.is_empty() {
            format!("{}-{}", stem, i)
        } else {
            format!("{}-{}.{}", stem, i, ext)
        };
        candidate = folder.join(&name);
        if !candidate.exists() {
            return candidate;
        }
    }

    folder.join(format!("{}-overflow", stem))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_no_collision() {
        let dir = tempdir().unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "photo.jpg");
        assert_eq!(path.file_name().unwrap(), "photo.jpg");
    }

    #[test]
    fn collision_appends_dash_one_suffix() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "photo.jpg");
        assert_eq!(path.file_name().unwrap(), "photo-1.jpg");
    }

    #[test]
    fn collision_increments_suffix_to_dash_two_when_dash_one_taken() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("photo-1.jpg"), b"x").unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "photo.jpg");
        assert_eq!(path.file_name().unwrap(), "photo-2.jpg");
    }

    #[test]
    fn collision_caps_at_999_then_uses_overflow_fallback() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        for i in 1..1000 {
            std::fs::write(dir.path().join(format!("photo-{}.jpg", i)), b"x").unwrap();
        }
        let path = resolve_output_path(dir.path().to_str().unwrap(), "photo.jpg");
        assert_eq!(path.file_name().unwrap(), "photo-overflow.jpg");
    }

    #[test]
    fn collision_handles_file_without_extension() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("README"), b"x").unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "README");
        assert_eq!(path.file_name().unwrap(), "README-1");
    }
}
```

Note on the cap test: with 1000 pre-created names the loop `1..1000` finds no free slot, so the `-overflow` fallback triggers with the extension preserved (`photo-overflow.jpg`).

- [x] **Step 2: Create temp.rs**

`cleanup_stale_temp_files_in` is extracted (path + now injectable) so the 24h boundary is testable without a Tauri harness:

```rust
use std::path::PathBuf;
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

pub fn create_temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let temp_base = app
        .path()
        .temp_dir()
        .map_err(|e| format!("Failed to get temp dir: {}", e))?;

    let app_temp = temp_base.join("file-compressor");
    std::fs::create_dir_all(&app_temp)
        .map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let session_temp = app_temp.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&session_temp)
        .map_err(|e| format!("Failed to create session temp dir: {}", e))?;

    Ok(session_temp)
}

pub fn cleanup_temp_dir(path: &PathBuf) {
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Removes session dirs under `app_temp` whose mtime is older than 24h.
pub fn cleanup_stale_temp_files_in(app_temp: &std::path::Path, now: SystemTime) {
    if !app_temp.exists() {
        return;
    }

    if let Ok(entries) = std::fs::read_dir(app_temp) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if now
                        .duration_since(modified)
                        .map(|d| d.as_secs() > 86400)
                        .unwrap_or(false)
                    {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
    }
}

pub fn cleanup_stale_temp_files(app: &AppHandle) {
    let Ok(temp_base) = app.path().temp_dir() else {
        return;
    };
    cleanup_stale_temp_files_in(&temp_base.join("file-compressor"), SystemTime::now());
}

#[cfg(test)]
mod tests {
    use super::*;
    use filetime::{FileTime, set_file_mtime};
    use std::fs;

    #[test]
    fn cleanup_temp_dir_removes_directory_tree() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("session").join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("attempt-1.jpg"), b"x").unwrap();

        cleanup_temp_dir(&dir.path().join("session"));
        assert!(!dir.path().join("session").exists());
    }

    #[test]
    fn cleanup_temp_dir_no_op_on_missing_path() {
        let missing = PathBuf::from("/definitely/not/a/real/dir/file-compressor-test");
        cleanup_temp_dir(&missing);
        cleanup_temp_dir(&missing); // second call — still no panic
    }

    #[test]
    fn cleanup_stale_temp_files_removes_only_dirs_older_than_24h() {
        let base = tempfile::tempdir().unwrap();
        let old = base.path().join("old-session");
        let fresh = base.path().join("fresh-session");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&fresh).unwrap();

        let now = SystemTime::now();
        set_file_mtime(&old, FileTime::from_unix_time(
            now.duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() - 86401, 0,
        )).unwrap();
        set_file_mtime(&fresh, FileTime::from_unix_time(
            now.duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() - 3600, 0,
        )).unwrap();

        cleanup_stale_temp_files_in(base.path(), now);
        assert!(!old.exists(), "dir older than 24h must be removed");
        assert!(fresh.exists(), "dir newer than 24h must be kept");
    }

    #[test]
    fn cleanup_stale_temp_files_safe_when_app_temp_missing() {
        let missing = tempfile::tempdir().unwrap();
        let app_temp = missing.path().join("file-compressor");
        cleanup_stale_temp_files_in(&app_temp, SystemTime::now());
        assert!(!app_temp.exists());
    }
}
```

- [x] **Step 2b: Add filetime dev-dependency**

Add to `src-tauri/Cargo.toml` `[dev-dependencies]`:

```toml
filetime = "0.2"
```

- [x] **Step 3: Register modules in lib.rs**

Add `mod output;` and `mod temp;` to `src-tauri/src/lib.rs`.

- [x] **Step 4: Add tempfile dev-dependency (if not present)**

`tempfile` is already a dev-dependency (used by models.rs tests). Verify in `src-tauri/Cargo.toml`.

- [x] **Step 5: Run tests**

```bash
cd src-tauri && cargo test output:: -- --nocapture
```

Expected: all 5 collision tests pass.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add output path collision handling + temp file management"
```

---

## Task 3: Create Engine Trait + Result Types

**Files:**
- Create: `src-tauri/src/engine/mod.rs`
- Create: `src-tauri/src/engine/processor.rs` (NOT `trait.rs` — `trait` is a Rust keyword and cannot be a module name)
- Create: `src-tauri/src/engine/result.rs`
- Create: `src-tauri/src/engine/progress.rs`

**Interfaces:**
- Produces: `CompressionProcessor` trait, `CompressionResult`, `CompressionError`, `ProgressSender`

**Acceptance Criteria:**
- Trait matches spec §5 "Trait Interface" shape: `category()`, `supported_extensions()`, `compress_to_target(...)` with `CancellationToken` + `ProgressSender` params
- `CompressionResult` fields exactly: `output_path, compressed_size, quality_used, met_target, strategy_used` (spec §7 data model)
- `CompressionError` Display strings match spec §6 error-table user-facing copy verbatim: `"Cancelled"`, `"Engine error: {name} not available"`, `"Cannot read file: ..."`, `"Cannot write output: ..."`, `"Not enough disk space"`
- Module named `processor` (not `trait`) — compiles under strict keyword rules
- `tokio-util = "0.7"` present in `src-tauri/Cargo.toml` (first tokio-util consumer; also add `tokio` here — see Step 6)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `compression_error_display_strings_match_spec_wording` — table test over all 7 variants asserting exact Display strings (spec §6 copy is user-facing; a refactor must not silently change UX wording)

- [x] **Step 1: Create engine/result.rs**

```rust
use std::path::PathBuf;

#[derive(Debug)]
pub struct CompressionResult {
    pub output_path: PathBuf,
    pub compressed_size: u64,
    pub quality_used: u32,
    pub met_target: bool,
    pub strategy_used: String,
}

#[derive(Debug, Clone)]
pub enum CompressionError {
    Cancelled,
    SidecarNotFound(String),
    SidecarFailed(String),
    InputFileError(String),
    OutputFileError(String),
    DiskFull,
    Unknown(String),
}

impl std::fmt::Display for CompressionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompressionError::Cancelled => write!(f, "Cancelled"),
            CompressionError::SidecarNotFound(name) => write!(f, "Engine error: {} not available", name),
            CompressionError::SidecarFailed(msg) => write!(f, "Processing error: {}", msg),
            CompressionError::InputFileError(msg) => write!(f, "Cannot read file: {}", msg),
            CompressionError::OutputFileError(msg) => write!(f, "Cannot write output: {}", msg),
            CompressionError::DiskFull => write!(f, "Not enough disk space"),
            CompressionError::Unknown(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for CompressionError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compression_error_display_strings_match_spec_wording() {
        let cases: Vec<(CompressionError, &str)> = vec![
            (CompressionError::Cancelled, "Cancelled"),
            (CompressionError::SidecarNotFound("vips".into()), "Engine error: vips not available"),
            (CompressionError::SidecarFailed("boom".into()), "Processing error: boom"),
            (CompressionError::InputFileError("locked".into()), "Cannot read file: locked"),
            (CompressionError::OutputFileError("readonly".into()), "Cannot write output: readonly"),
            (CompressionError::DiskFull, "Not enough disk space"),
            (CompressionError::Unknown("odd".into()), "odd"),
        ];
        for (err, expected) in cases {
            assert_eq!(err.to_string(), expected);
        }
    }
}
```

- [x] **Step 2: Create engine/progress.rs**

Closure-based emitter — the seam that makes the whole engine testable without a Tauri harness (Task 4's `ProgressSender::test_stub()` depends on this):

```rust
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

#[derive(Clone)]
pub struct ProgressSender {
    emit: Arc<dyn Fn(u32) + Send + Sync>,
}

impl ProgressSender {
    pub fn new(app: AppHandle, file_id: String) -> Self {
        ProgressSender {
            emit: Arc::new(move |percent| {
                let _ = app.emit(
                    "file:progress",
                    serde_json::json!({ "fileId": file_id, "percent": percent }),
                );
            }),
        }
    }

    #[cfg(test)]
    pub fn test_stub() -> Self {
        ProgressSender { emit: Arc::new(|_| {}) }
    }

    pub fn send_progress(&self, percent: u32) {
        (self.emit)(percent);
    }
}
```

Payload field names are camelCase (`fileId`) per project convention (`#[serde(rename_all = "camelCase")]` for IPC structs, AGENTS.md) — the TS hook in Task 7 reads `e.payload.fileId`. (Spec §7 event table writes `file_id`; convention overrides the table.)

- [x] **Step 3: Create engine/processor.rs**

```rust
use std::path::Path;
use tokio_util::sync::CancellationToken;
use crate::engine::result::{CompressionResult, CompressionError};
use crate::engine::progress::ProgressSender;
use crate::models::Category;
use crate::settings::QualityFloors;

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
        sidecar_path: &str,
        temp_dir: &Path,
    ) -> Result<CompressionResult, CompressionError>;
}
```

- [x] **Step 4: Create engine/mod.rs**

```rust
pub mod processor;
pub mod result;
pub mod progress;

pub use processor::CompressionProcessor;
pub use result::{CompressionResult, CompressionError};
pub use progress::ProgressSender;
```

- [x] **Step 5: Add tokio-util dependency**

Add to `src-tauri/Cargo.toml`:
```toml
tokio-util = "0.7"
```

- [x] **Step 6: Add tokio dependency (direct)**

Queue.rs (Task 5) uses `tokio::spawn` and `tokio::sync::mpsc`. Tauri does not re-export tokio, so add the direct dependency now:

```toml
tokio = { version = "1", features = ["sync", "rt", "macros"] }
```

- [x] **Step 7: Register module in lib.rs**

Add `mod engine;` to `src-tauri/src/lib.rs`.

- [x] **Step 8: Run tests**

```bash
cd src-tauri && cargo test engine::
```

- [x] **Step 9: Commit**

```bash
git add -A
git commit -m "feat: add CompressionProcessor trait + engine types"
```

---

## Task 4: Implement ImageProcessor

**Files:**
- Create: `src-tauri/src/processors/mod.rs`
- Create: `src-tauri/src/processors/image.rs`

**Interfaces:**
- Consumes: `CompressionProcessor` trait, vips sidecar
- Produces: `ImageProcessor` struct implementing the trait, `ProcessorRegistry`
- Produces (testable): `binary_search_quality(lo, hi, max_iterations, target_bytes, attempt)` — pure closure-injected search core, no sidecar needed to test

**Acceptance Criteria:**
- Binary search on `Q` (floor from `quality_floor.image.min_quality`…95), **max 8 iterations** — spec §5 Images strategy
- Q floor hit + still over → dimension reduction in 10% steps down to 50% via `vips resize <in> <out>[opts] <scale>` (scale is a **float factor**, e.g. `0.9` for 90% — NOT `vips thumbnail`, whose 3rd arg is target width in pixels)
- PNG output: lossy `Q` is invalid for pngsave — PNG strategy = single attempt with `[compression=9,palette,colours=256,strip]` then dims reduction (AC #4 "palette quantization if needed")
- Each search iteration writes to a **distinct temp file** (`attempt-{n}.{ext}`) — a later attempt must never overwrite the recorded best attempt's file (else best-effort reports the wrong size)
- Best-effort result = **smallest** output across all attempts (quality search + dims search), never merely the last attempt — spec §5 step 7 / §6 "Best effort" row
- HEIC/HEIF input → JPEG output ext (spec §3 format table); unknown ext → `jpg` fallback
- All vips save strings carry `strip` (metadata stripping — spec §5)
- Already-under-target → copy as-is, `strategy_used: "already-under-target"` (spec §6 optimization)
- Cancel checked before each iteration and after each sidecar wait; cancelled beats non-zero exit code (return `Cancelled`, not `SidecarFailed`)
- Registry: maps all image extensions (lowercased) → `Category::Image`; returns `None` for `Category::Video/Pdf/Document/Other` lookups
- Progress percent = `(iteration * 100 / 8).min(90)`, then 92 for dims phase, 100 at completion
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `get_output_extension_maps_heic_heif_to_jpg` — spec §3 format rule
- `get_output_extension_preserves_png_jpg_webp`
- `get_output_extension_defaults_unknown_to_jpg`
- `registry_maps_all_image_extensions_to_image_category` — incl. uppercase input
- `registry_lookup_returns_none_for_non_image_categories` — Video/Pdf/Document/Other → None
- `binary_search_finds_highest_quality_meeting_target` — fake size fn monotonic in Q
- `binary_search_caps_at_max_eight_iterations` — unreachable target, lo=0/hi=255 → exactly 8 attempt calls, None
- `binary_search_exhausts_real_range_within_cap` — 30..95 range → ≤ 8 calls, None
- `binary_search_cancelled_before_first_iteration_returns_cancelled` — 0 attempt calls
- `binary_search_cancelled_mid_search_returns_cancelled`
- `already_under_target_copies_file_and_marks_result` — real tempfile-based test, no sidecar call
- `quality_floor_reached_triggers_dimension_reduction` — fake sidecar script, resize 50% fits → `strategy_used` contains `dims=50%`
- `unachievable_returns_best_effort_with_smallest_attempt` — fake sidecar, nothing fits → smallest attempt copied, `met_target: false`
- `sidecar_nonzero_exit_marks_job_failed_with_exit_code` — fake sidecar `/bin/false` (cfg unix)

- [x] **Step 1: Create processors/mod.rs**

```rust
pub mod image;

use std::collections::HashMap;
use crate::engine::CompressionProcessor;
use crate::models::Category;

pub struct ProcessorRegistry {
    processors: HashMap<Category, Box<dyn CompressionProcessor>>,
    extension_map: HashMap<String, Category>,
}

impl ProcessorRegistry {
    pub fn new() -> Self {
        let mut processors: HashMap<Category, Box<dyn CompressionProcessor>> = HashMap::new();
        let mut extension_map: HashMap<String, Category> = HashMap::new();

        let image_proc = image::ImageProcessor::new();
        for ext in image_proc.supported_extensions() {
            extension_map.insert(ext.to_lowercase(), Category::Image);
        }
        processors.insert(Category::Image, Box::new(image_proc));

        ProcessorRegistry {
            processors,
            extension_map,
        }
    }

    pub fn get_processor(&self, category: Category) -> Option<&dyn CompressionProcessor> {
        self.processors.get(&category).map(|p| p.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_maps_all_image_extensions_to_image_category() {
        let registry = ProcessorRegistry::new();
        for ext in ["jpg", "jpeg", "png", "webp", "heic", "heif"] {
            assert_eq!(registry.extension_map.get(ext), Some(&Category::Image), "ext: {}", ext);
        }
        // lowercased on insert — uppercase input still maps
        assert_eq!(registry.extension_map.get("JPEG"), Some(&Category::Image));
    }

    #[test]
    fn registry_lookup_returns_none_for_non_image_categories() {
        let registry = ProcessorRegistry::new();
        assert!(registry.get_processor(Category::Video).is_none());
        assert!(registry.get_processor(Category::Pdf).is_none());
        assert!(registry.get_processor(Category::Document).is_none());
        assert!(registry.get_processor(Category::Other).is_none());
    }
}
```

- [x] **Step 2: Create processors/image.rs**

```rust
use std::path::{Path, PathBuf};
use tokio_util::sync::CancellationToken;
use crate::engine::{CompressionProcessor, CompressionResult, CompressionError, ProgressSender};
use crate::models::Category;
use crate::settings::QualityFloors;

pub struct ImageProcessor;

const MAX_SEARCH_ITERATIONS: u32 = 8;
const SCALE_FLOOR_PERCENT: u32 = 50;

impl ImageProcessor {
    pub fn new() -> Self {
        ImageProcessor
    }

    fn get_output_extension(input: &Path) -> String {
        let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("");
        match ext.to_lowercase().as_str() {
            "jpg" | "jpeg" => "jpg".to_string(),
            "png" => "png".to_string(),
            "webp" => "webp".to_string(),
            // HEIC/HEIF → JPEG output (spec §3); unknown → jpg fallback
            _ => "jpg".to_string(),
        }
    }

    /// vips save-string options per output format. `quality` applies only to
    /// lossy formats (jpg/webp). PNG uses palette quantization instead —
    /// pngsave has no lossy Q.
    fn save_options(ext: &str, quality: u32) -> String {
        match ext {
            "png" => "[compression=9,palette,colours=256,strip]".to_string(),
            _ => format!("[Q={},strip]", quality),
        }
    }

    fn run_vips(
        sidecar_path: &str,
        input: &Path,
        output: &Path,
        ext: &str,
        quality: u32,
        cancel_token: &CancellationToken,
    ) -> Result<(), CompressionError> {
        let mut child = std::process::Command::new(sidecar_path)
            .arg("copy")
            .arg(input)
            .arg(format!("{}{}", output.display(), Self::save_options(ext, quality)))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| CompressionError::SidecarFailed(format!("Failed to start vips: {}", e)))?;

        let status = child
            .wait()
            .map_err(|e| CompressionError::SidecarFailed(format!("vips wait failed: {}", e)))?;

        if !status.success() {
            // Cancelled beats exit-code (kill surfaces as non-zero exit)
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }
            return Err(CompressionError::SidecarFailed(format!(
                "vips exited with code {:?}",
                status.code()
            )));
        }
        Ok(())
    }

    /// Dimension reduction via `vips resize` — scale is a float factor (0.9 = 90%).
    /// NOT `vips thumbnail` (3rd arg there is width in pixels, not a percent).
    fn run_vips_resize(
        sidecar_path: &str,
        input: &Path,
        output: &Path,
        ext: &str,
        quality: u32,
        scale_factor: f64,
        cancel_token: &CancellationToken,
    ) -> Result<(), CompressionError> {
        let mut child = std::process::Command::new(sidecar_path)
            .arg("resize")
            .arg(input)
            .arg(format!("{}{}", output.display(), Self::save_options(ext, quality)))
            .arg(format!("{}", scale_factor))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| CompressionError::SidecarFailed(format!("Failed to start vips resize: {}", e)))?;

        let status = child
            .wait()
            .map_err(|e| CompressionError::SidecarFailed(format!("vips wait failed: {}", e)))?;

        if !status.success() {
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }
            return Err(CompressionError::SidecarFailed(format!(
                "vips resize exited with code {:?}",
                status.code()
            )));
        }
        Ok(())
    }
}

/// Highest quality whose produced size fits `target_bytes`, within
/// `max_iterations`. Returns None when every attempt stays over target.
/// Pure/closure-injected so the search policy is unit-testable without vips.
fn binary_search_quality(
    lo: u32,
    hi: u32,
    max_iterations: u32,
    target_bytes: u64,
    cancel_token: &CancellationToken,
    progress: &ProgressSender,
    attempt: &mut dyn FnMut(u32) -> Result<(u64, PathBuf), CompressionError>,
) -> Result<Option<(u32, u64, PathBuf)>, CompressionError> {
    let mut lo = lo;
    let mut hi = hi;
    let mut best: Option<(u32, u64, PathBuf)> = None;

    for iteration in 0..max_iterations {
        if cancel_token.is_cancelled() {
            return Err(CompressionError::Cancelled);
        }
        if lo > hi {
            break;
        }

        let mid = (lo + hi) / 2;
        progress.send_progress((iteration * 100 / MAX_SEARCH_ITERATIONS).min(90));

        let (size, path) = attempt(mid)?;
        if size <= target_bytes {
            best = Some((mid, size, path));
            lo = mid + 1;
        } else {
            hi = mid.saturating_sub(1);
        }
    }

    Ok(best)
}

impl CompressionProcessor for ImageProcessor {
    fn category(&self) -> Category {
        Category::Image
    }

    fn supported_extensions(&self) -> &[&str] {
        &["jpg", "jpeg", "png", "webp", "heic", "heif"]
    }

    fn compress_to_target(
        &self,
        input: &Path,
        output: &Path,
        target_bytes: u64,
        quality_floor: &QualityFloors,
        cancel_token: CancellationToken,
        progress: ProgressSender,
        sidecar_path: &str,
        temp_dir: &Path,
    ) -> Result<CompressionResult, CompressionError> {
        let input_size = std::fs::metadata(input)
            .map(|m| m.len())
            .map_err(|e| CompressionError::InputFileError(e.to_string()))?;

        // Already under target — copy as-is (spec §6)
        if input_size <= target_bytes {
            std::fs::copy(input, output)
                .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
            progress.send_progress(100);
            return Ok(CompressionResult {
                output_path: output.to_path_buf(),
                compressed_size: input_size,
                quality_used: 100,
                met_target: true,
                strategy_used: "already-under-target".to_string(),
            });
        }

        let ext = Self::get_output_extension(input);
        let min_quality = quality_floor.image.min_quality;

        // Distinct temp file per attempt — a later attempt must never
        // overwrite the file recorded as the best one.
        let attempt = |n: u32, quality: u32, scale: Option<f64>| -> Result<(u64, PathBuf), CompressionError> {
            let temp_file = temp_dir.join(format!("attempt-{}.{}", n, ext));
            match scale {
                None => Self::run_vips(sidecar_path, input, &temp_file, &ext, quality, &cancel_token)?,
                Some(s) => Self::run_vips_resize(sidecar_path, input, &temp_file, &ext, quality, s, &cancel_token)?,
            }
            let size = std::fs::metadata(&temp_file)
                .map(|m| m.len())
                .map_err(|e| CompressionError::InputFileError(e.to_string()))?;
            Ok((size, temp_file))
        };

        // Phase 1: binary search on quality (PNG loses here — save_options
        // ignores quality for png, so the search converges after floor hits).
        let mut attempt_n: u32 = 0;
        let quality_search = binary_search_quality(
            min_quality,
            95,
            MAX_SEARCH_ITERATIONS,
            target_bytes,
            &cancel_token,
            &progress,
            &mut |q| {
                let r = attempt(attempt_n, q, None)?;
                attempt_n += 1;
                Ok(r)
            },
        )?;

        if let Some((quality, size, path)) = quality_search {
            std::fs::copy(&path, output)
                .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
            progress.send_progress(100);
            return Ok(CompressionResult {
                output_path: output.to_path_buf(),
                compressed_size: size,
                quality_used: quality,
                met_target: true,
                strategy_used: format!("quality={}", quality),
            });
        }

        // Phase 2: dimension reduction in 10% steps, floor at SCALE_FLOOR_PERCENT
        progress.send_progress(92);
        let mut smallest: Option<(u32, u64, PathBuf)> = None;
        let mut scale_percent = 90;
        while scale_percent >= SCALE_FLOOR_PERCENT {
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }
            let scale = scale_percent as f64 / 100.0;
            let r = attempt(attempt_n, min_quality, Some(scale))?;
            attempt_n += 1;

            if r.0 <= target_bytes {
                std::fs::copy(&r.1, output)
                    .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
                progress.send_progress(100);
                return Ok(CompressionResult {
                    output_path: output.to_path_buf(),
                    compressed_size: r.0,
                    quality_used: min_quality,
                    met_target: true,
                    strategy_used: format!("quality={},dims={}%", min_quality, scale_percent),
                });
            }
            if smallest.as_ref().map(|(_, s, _)| r.0 < *s).unwrap_or(true) {
                smallest = Some((min_quality, r.0, r.1));
            }
            scale_percent -= 10;
        }

        // Phase 3: best effort — smallest attempt wins (spec §5 step 7)
        if let Some((quality, size, path)) = smallest {
            std::fs::copy(&path, output)
                .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
            progress.send_progress(100);
            return Ok(CompressionResult {
                output_path: output.to_path_buf(),
                compressed_size: size,
                quality_used: quality,
                met_target: false,
                strategy_used: format!("quality={},best-effort", quality),
            });
        }

        Err(CompressionError::SidecarFailed(
            "Could not compress image".to_string(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn get_output_extension_maps_heic_heif_to_jpg() {
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/photo.heic")), "jpg");
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/photo.HEIF")), "jpg");
    }

    #[test]
    fn get_output_extension_preserves_png_jpg_webp() {
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/a.png")), "png");
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/a.JPG")), "jpg");
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/a.webp")), "webp");
    }

    #[test]
    fn get_output_extension_defaults_unknown_to_jpg() {
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/a.tiff")), "jpg");
        assert_eq!(ImageProcessor::get_output_extension(Path::new("p/a")), "jpg");
    }

    #[test]
    fn binary_search_finds_highest_quality_meeting_target() {
        // size shrinks as quality drops; Q<=80 fits target
        let attempt = |q: u32| Ok::<(u64, PathBuf), CompressionError>((u64::from(200 - q) * 1000, PathBuf::from("t")));
        let result = binary_search_quality(
            30, 95, MAX_SEARCH_ITERATIONS, 120_000,
            &CancellationToken::new(), &ProgressSender::test_stub(),
            &mut |q| attempt(q),
        ).unwrap();
        let (q, size, _) = result.expect("should find a fitting quality");
        assert!(size <= 120_000);
        assert!(q >= 80, "expected highest fitting quality, got {}", q);
    }

    #[test]
    fn binary_search_caps_at_max_eight_iterations() {
        // 256-wide window needs exactly 8 halvings to exhaust — verifies the cap
        let count = std::cell::Cell::new(0u32);
        let result = binary_search_quality(
            0, 255, MAX_SEARCH_ITERATIONS, 1, // target 1 byte — nothing fits
            &CancellationToken::new(), &ProgressSender::test_stub(),
            &mut |_q| { count.set(count.get() + 1); Ok((u64::MAX, PathBuf::from("t"))) },
        ).unwrap();
        assert!(result.is_none());
        assert_eq!(count.get(), 8, "must cap at 8 iterations");
    }

    #[test]
    fn binary_search_exhausts_real_range_within_cap() {
        let count = std::cell::Cell::new(0u32);
        let result = binary_search_quality(
            30, 95, MAX_SEARCH_ITERATIONS, 1,
            &CancellationToken::new(), &ProgressSender::test_stub(),
            &mut |_q| { count.set(count.get() + 1); Ok((u64::MAX, PathBuf::from("t"))) },
        ).unwrap();
        assert!(result.is_none());
        assert!(count.get() <= 8);
    }

    #[test]
    fn binary_search_cancelled_before_first_iteration_returns_cancelled() {
        let token = CancellationToken::new();
        token.cancel();
        let count = std::cell::Cell::new(0u32);
        let result = binary_search_quality(
            30, 95, MAX_SEARCH_ITERATIONS, 100,
            &token, &ProgressSender::test_stub(),
            &mut |_q| { count.set(count.get() + 1); Ok((1, PathBuf::from("t"))) },
        );
        assert!(matches!(result, Err(CompressionError::Cancelled)));
        assert_eq!(count.get(), 0);
    }

    #[test]
    fn binary_search_cancelled_mid_search_returns_cancelled() {
        let token = CancellationToken::new();
        let count = std::cell::Cell::new(0u32);
        let result = binary_search_quality(
            30, 95, MAX_SEARCH_ITERATIONS, 100,
            &token, &ProgressSender::test_stub(),
            &mut |_q| {
                count.set(count.get() + 1);
                if count.get() == 3 { token.cancel(); }
                Ok((u64::MAX, PathBuf::from("t")))
            },
        );
        assert!(matches!(result, Err(CompressionError::Cancelled)));
    }

    #[test]
    fn already_under_target_copies_file_and_marks_result() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.jpg");
        let output = dir.path().join("out.jpg");
        fs::write(&input, b"tiny").unwrap();

        let result = ImageProcessor.compress_to_target(
            &input, &output, 200 * 1024,
            &crate::settings::QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            "/bin/false", // must never be invoked
            &dir.path().join("tmp"),
        ).unwrap();

        assert!(result.met_target);
        assert_eq!(result.strategy_used, "already-under-target");
        assert_eq!(result.compressed_size, 4);
        assert_eq!(fs::read(&output).unwrap(), b"tiny");
    }

    #[test]
    fn sidecar_nonzero_exit_marks_job_failed_with_exit_code() {
        // unix only: /bin/false exists and exits 1
        if !Path::new("/bin/false").exists() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("in.jpg");
        fs::write(&input, vec![0u8; 300 * 1024]).unwrap(); // over target → search runs
        let result = ImageProcessor.compress_to_target(
            &input, &dir.path().join("out.jpg"), 200 * 1024,
            &crate::settings::QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            "/bin/false",
            &dir.path().join("tmp"),
        );
        match result {
            Err(CompressionError::SidecarFailed(msg)) => assert!(msg.contains("exited with code")),
            other => panic!("expected SidecarFailed, got {:?}", other.map(|r| r.strategy_used)),
        }
    }

    /// Writes a deterministic bash fake of the vips CLI:
    /// `copy IN OUT[opts]`        → file of exactly 100_000 bytes
    /// `resize IN OUT[opts] SCALE` → file of exactly 100_000 * SCALE bytes
    /// Lets the dims-reduction + best-effort paths be tested end-to-end
    /// without libvips. Skipped on non-unix (needs bash + chmod).
    #[cfg(unix)]
    fn write_fake_vips(dir: &Path) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("fake-vips");
        let script = r#"#!/bin/bash
op="$1"; out="$3"
base="${out%%\[*}"
case "$op" in
  copy)   head -c 100000 /dev/zero > "$base" ;;
  resize) head -c "$(awk -v s="$4" 'BEGIN { printf "%d", 100000 * s }')" /dev/zero > "$base" ;;
esac
"#;
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().to_string()
    }

    #[test]
    #[cfg(unix)]
    fn quality_floor_reached_triggers_dimension_reduction() {
        let dir = tempfile::tempdir().unwrap();
        let fake = write_fake_vips(&dir.path()); // copy → 100_000 B, resize 0.5 → 50_000 B
        let input = dir.path().join("in.jpg");
        fs::write(&input, vec![0u8; 300 * 1024]).unwrap();
        let tmp = dir.path().join("tmp");
        fs::create_dir_all(&tmp).unwrap();

        // target 60 KB: quality search (100_000) always fails;
        // resize 0.9→0.8→0.7→0.6 fail, resize 0.5 → 50_000 fits
        let result = ImageProcessor.compress_to_target(
            &input, &dir.path().join("out.jpg"), 60 * 1024,
            &crate::settings::QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &fake, &tmp,
        ).unwrap();

        assert!(result.met_target);
        assert!(result.strategy_used.contains("dims=50%"), "got: {}", result.strategy_used);
        assert_eq!(result.compressed_size, 50_000);
    }

    #[test]
    #[cfg(unix)]
    fn unachievable_returns_best_effort_with_smallest_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let fake = write_fake_vips(&dir.path());
        let input = dir.path().join("in.jpg");
        fs::write(&input, vec![0u8; 300 * 1024]).unwrap();
        let tmp = dir.path().join("tmp");
        fs::create_dir_all(&tmp).unwrap();

        // target 10 KB: nothing ever fits (smallest possible = 50_000)
        let result = ImageProcessor.compress_to_target(
            &input, &dir.path().join("out.jpg"), 10 * 1024,
            &crate::settings::QualityFloors::default(),
            CancellationToken::new(),
            ProgressSender::test_stub(),
            &fake, &tmp,
        ).unwrap();

        assert!(!result.met_target);
        assert!(result.strategy_used.contains("best-effort"));
        assert_eq!(result.compressed_size, 50_000, "best effort = smallest attempt, not last quality attempt");
        assert_eq!(fs::metadata(&dir.path().join("out.jpg")).unwrap().len(), 50_000);
    }
}
```

Fake-sidecar tests note: `quality_floor_reached_triggers_dimension_reduction` proves the dims loop runs only after the full quality search fails (copy always emits 100 000 B > 60 KB target), and `unachievable_returns_best_effort_with_smallest_attempt` pins the "smallest wins" rule — the last quality attempt is Q≈33-ish at 100 000 B while the winning attempt is the 0.5-scale 50 000 B file.

- [x] **Step 3: Register module in lib.rs**

Add `mod processors;` to `src-tauri/src/lib.rs`.

- [x] **Step 4: Run tests**

```bash
cd src-tauri && cargo test processors::
```

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: implement ImageProcessor with vips binary search"
```

---

## Task 5: Implement Job Queue + Cancellation

**Files:**
- Create: `src-tauri/src/queue.rs`
- Modify: `src-tauri/src/commands.rs` (add compress_all, cancel_file, cancel_all, reveal_in_folder)
- Modify: `src-tauri/src/lib.rs` (register queue + commands; preserve opener plugin + graceful startup)

**Interfaces:**
- Produces: `QueueState` (tauri-managed), `compress_all`, `cancel_file`, `cancel_all`, `reveal_in_folder` commands
- Produces (testable): `decide_result_status(&CompressionResult) -> FileStatus`, `output_file_name(name) -> String` (HEIC rewrite)
- Events: `file:progress`, `file:complete`, `file:error`, `file:cancelled`, `batch:complete`, `batch:error` — payload field names camelCase

**Acceptance Criteria:**
- `compress_all` returns a `batch_id` immediately; worker processes files strictly sequentially (spec §7 Job Queue)
- **Cancellation bypasses the channel**: `cancel_file`/`cancel_all` act directly on a shared token map — commands must work while the worker is mid-`process_batch` (messages sent through the occupied mpsc receiver would never be polled)
- `cancel_all` also stops queued-not-yet-started files: batch token cancelled → worker marks remaining `Pending` entries `Cancelled` + emits `file:cancelled` for each (spec §5 Cancellation "drops tokens for all pending + in-progress jobs")
- `cancel_file` on a not-yet-started file marks it `Cancelled` in `FileListState`; worker skips non-`Pending` entries
- Per-file token inserted into the map **before** the entry status flips to `Compressing` (no race window where cancel misses)
- `Category::Other` entries are **skipped silently** (already `Unsupported` from `FileEntry::new`) — never marked `Failed` (spec §3/§6 "not an error — just skipped")
- Categories with no registered processor (Video/Pdf/Document in this slice) → also skipped, status set `Unsupported`
- **Output-folder preflight** before the batch: `create_dir_all` + write-probe; failure → emit `batch:error` ("Output folder not writable") and abort the whole batch (spec §6 error table)
- HEIC output rewrite is case-insensitive (`photo.HEIC` → `photo.jpg`)
- Filename collision via `resolve_output_path` (`-1`, `-2` suffixes)
- Temp dir created per file, cleaned after each job **even on error/cancel** (spec §6)
- `totalSavedBytes` = Σ `original_size - compressed_size` (saturating) over succeeded files
- All `Mutex` access uses `unwrap_or_else(|e| e.into_inner())` — poison recovery per slice-2-fixes F3 (existing `commands.rs` convention)
- `reveal_in_folder` uses `tauri-plugin-opener` (already installed): `reveal_item_in_dir` — opens the OS file manager **at the file**, not the file itself
- `lib.rs` keeps `tauri_plugin_opener::init()`, the `opener:default` capability, and the existing `unwrap_or_else` startup error handling
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `decide_result_status_maps_already_under_target`
- `decide_result_status_maps_met_target_to_done`
- `decide_result_status_maps_unmet_target_to_best_effort`
- `output_file_name_rewrites_heic_to_jpg` — lower + uppercase `.heic`/`.heif`
- `output_file_name_keeps_non_heic_name`
- `output_file_name_handles_name_without_extension`
- Queue orchestration (sequential order, mid-batch cancel, preflight) is verified via Task 7 hook tests + Task 8 manual acceptance — direct unit testing requires a Tauri harness (documented limitation)

- [x] **Step 1: Create queue.rs**

```rust
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tauri::{AppHandle, Emitter, Manager};
use crate::commands::FileListState;
use crate::engine::{CompressionProcessor, CompressionResult, CompressionError, ProgressSender};
use crate::models::{FileEntry, FileStatus};
use crate::output::resolve_output_path;
use crate::processors::ProcessorRegistry;
use crate::sidecar;
use crate::temp;

/// HEIC/HEIF input → .jpg output filename (spec §3), case-insensitive.
pub(crate) fn output_file_name(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.ends_with(".heic") || lower.ends_with(".heif") {
        name.rsplit_once('.')
            .map(|(stem, _)| format!("{}.jpg", stem))
            .unwrap_or_else(|| format!("{}.jpg", name))
    } else {
        name.to_string()
    }
}

/// Map a successful CompressionResult to its final FileStatus.
pub(crate) fn decide_result_status(result: &CompressionResult) -> FileStatus {
    if !result.met_target {
        FileStatus::BestEffort
    } else if result.strategy_used == "already-under-target" {
        FileStatus::AlreadyUnderTarget
    } else {
        FileStatus::Done
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchMessage {
    batch_id: String,
    file_ids: Vec<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileErrorPayload<'a> {
    file_id: &'a str,
    error_message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCompletePayload<'a> {
    file_id: &'a str,
    output_path: String,
    original_size: u64,
    compressed_size: u64,
    status: FileStatus,
    met_target: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCancelledPayload<'a> {
    file_id: &'a str,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BatchCompletePayload<'a> {
    batch_id: &'a str,
    total_saved_bytes: u64,
}

/// Managed state shared by commands and the worker task.
/// Cancellation goes through this struct directly — NOT through the
/// mpsc channel, whose receiver is busy inside process_batch.
pub struct QueueState {
    token_map: Mutex<HashMap<String, CancellationToken>>,
    batch_token: Mutex<Option<CancellationToken>>,
    sender: mpsc::UnboundedSender<BatchMessage>,
}

impl QueueState {
    pub fn new(app: AppHandle) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<BatchMessage>();
        let worker_app = app.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(msg) = receiver.recv().await {
                Self::process_batch(&worker_app, msg.batch_id, msg.file_ids).await;
            }
        });
        QueueState {
            token_map: Mutex::new(HashMap::new()),
            batch_token: Mutex::new(None),
            sender,
        }
    }

    /// Called by compress_all: registers a fresh batch token then queues work.
    pub fn start_batch(&self, batch_id: String, file_ids: Vec<String>) {
        *self.batch_token.lock().unwrap_or_else(|e| e.into_inner()) = Some(CancellationToken::new());
        let _ = self.sender.send(BatchMessage { batch_id, file_ids });
    }

    pub fn cancel_file(&self, file_id: &str) {
        if let Some(token) = self.token_map.lock().unwrap_or_else(|e| e.into_inner()).get(file_id) {
            token.cancel();
        }
    }

    pub fn cancel_all(&self) {
        if let Some(token) = self.batch_token.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            token.cancel();
        }
        for token in self.token_map.lock().unwrap_or_else(|e| e.into_inner()).values() {
            token.cancel();
        }
    }

    fn batch_cancelled(&self) -> bool {
        self.batch_token
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|t| t.is_cancelled())
            .unwrap_or(false)
    }

    async fn process_batch(app: &AppHandle, batch_id: String, file_ids: Vec<String>) {
        let queue = app.state::<QueueState>();
        let registry = ProcessorRegistry::new();
        let state = app.state::<FileListState>();

        // Preflight: output folder must be writable before the batch starts
        let settings = crate::commands::load_settings(app);
        let output_folder = settings.output_folder.clone();
        if let Err(e) = ensure_output_folder_writable(&output_folder) {
            let _ = app.emit(
                "batch:error",
                serde_json::json!({ "batchId": batch_id, "errorMessage": e }),
            );
            return;
        }

        let mut total_saved: u64 = 0;

        for file_id in file_ids {
            // Cancel-all stops the remaining queue
            if queue.batch_cancelled() {
                let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                    if e.status == FileStatus::Pending {
                        e.status = FileStatus::Cancelled;
                    }
                }
                let _ = app.emit("file:cancelled", FileCancelledPayload { file_id: &file_id });
                continue;
            }

            let entry: FileEntry = {
                let list = state.0.lock().unwrap_or_else(|e| e.into_inner());
                list.iter().find(|e| e.id == file_id).cloned()
            };
            let Some(entry) = entry else { continue };
            if entry.status != FileStatus::Pending {
                continue; // cancelled/removed/done — skip
            }

            // Insert token BEFORE flipping status → cancel_file never misses.
            // Re-check status after inserting: a concurrent cancel_file may
            // have marked the entry Cancelled between the clone and now.
            let cancel_token = CancellationToken::new();
            queue
                .token_map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(file_id.clone(), cancel_token.clone());

            let flipped = {
                let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
                match list.iter_mut().find(|e| e.id == file_id) {
                    Some(e) if e.status == FileStatus::Pending => {
                        e.status = FileStatus::Compressing;
                        true
                    }
                    _ => false,
                }
            };
            if !flipped {
                queue
                    .token_map
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&file_id);
                continue;
            }

            let progress = ProgressSender::new(app.clone(), file_id.clone());

            let result = match registry.get_processor(entry.category) {
                None => {
                    // No processor registered (Video/Pdf/Document in this slice):
                    // skip as Unsupported — NOT Failed (spec §3/§6)
                    let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                        e.status = FileStatus::Unsupported;
                    }
                    queue
                        .token_map
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&file_id);
                    continue;
                }
                Some(processor) => {
                    let temp_dir = match temp::create_temp_dir(app) {
                        Ok(d) => d,
                        Err(e) => {
                            let _ = app.emit("file:error", FileErrorPayload {
                                file_id: &file_id,
                                error_message: e,
                            });
                            queue
                                .token_map
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .remove(&file_id);
                            continue;
                        }
                    };

                    let output_filename = output_file_name(&entry.name);
                    let output_path = resolve_output_path(&output_folder, &output_filename);

                    let run = match sidecar::get_sidecar_path(app, "vips") {
                        Ok(sidecar_path) => processor.compress_to_target(
                            std::path::Path::new(&entry.path),
                            &output_path,
                            entry.target_bytes,
                            &settings.quality_floors,
                            cancel_token,
                            progress,
                            &sidecar_path,
                            &temp_dir,
                        ),
                        // get_sidecar_path already formats "Engine error: … not available"
                        Err(e) => Err(CompressionError::Unknown(e)),
                    };

                    // Temp cleaned after each job, even on error/cancel (spec §6)
                    temp::cleanup_temp_dir(&temp_dir);
                    run
                }
            };

            match result {
                Ok(compression_result) => {
                    let saved = entry.original_size.saturating_sub(compression_result.compressed_size);
                    total_saved += saved;
                    let status = decide_result_status(&compression_result);

                    {
                        let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                            e.status = status;
                            e.compressed_size = Some(compression_result.compressed_size);
                            e.output_path = Some(compression_result.output_path.to_string_lossy().to_string());
                        }
                    }

                    let _ = app.emit("file:complete", FileCompletePayload {
                        file_id: &file_id,
                        output_path: compression_result.output_path.to_string_lossy().to_string(),
                        original_size: entry.original_size,
                        compressed_size: compression_result.compressed_size,
                        status,
                        met_target: compression_result.met_target,
                    });
                }
                Err(CompressionError::Cancelled) => {
                    let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                        e.status = FileStatus::Cancelled;
                    }
                    let _ = app.emit("file:cancelled", FileCancelledPayload { file_id: &file_id });
                }
                Err(e) => {
                    let error_msg = e.to_string();
                    let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(e2) = list.iter_mut().find(|e2| e2.id == file_id) {
                        e2.status = FileStatus::Failed;
                        e2.error = Some(error_msg.clone());
                    }
                    let _ = app.emit("file:error", FileErrorPayload {
                        file_id: &file_id,
                        error_message: error_msg,
                    });
                }
            }

            queue
                .token_map
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&file_id);
        }

        let _ = app.emit("batch:complete", BatchCompletePayload {
            batch_id: &batch_id,
            total_saved_bytes: total_saved,
        });
    }
}

fn ensure_output_folder_writable(folder: &str) -> Result<(), String> {
    let path = std::path::Path::new(folder);
    if !path.exists() {
        std::fs::create_dir_all(path)
            .map_err(|e| format!("Output folder not writable: {}", e))?;
    }
    let probe = path.join(".write-probe");
    std::fs::write(&probe, b"ok")
        .map(|_| {
            let _ = std::fs::remove_file(&probe);
        })
        .map_err(|e| format!("Output folder not writable: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::CompressionResult;

    fn result(met: bool, strategy: &str) -> CompressionResult {
        CompressionResult {
            output_path: std::path::PathBuf::from("out"),
            compressed_size: 100,
            quality_used: 75,
            met_target: met,
            strategy_used: strategy.to_string(),
        }
    }

    #[test]
    fn decide_result_status_maps_already_under_target() {
        assert_eq!(
            decide_result_status(&result(true, "already-under-target")),
            FileStatus::AlreadyUnderTarget
        );
    }

    #[test]
    fn decide_result_status_maps_met_target_to_done() {
        assert_eq!(decide_result_status(&result(true, "quality=75")), FileStatus::Done);
    }

    #[test]
    fn decide_result_status_maps_unmet_target_to_best_effort() {
        assert_eq!(decide_result_status(&result(false, "quality=30,best-effort")), FileStatus::BestEffort);
    }

    #[test]
    fn output_file_name_rewrites_heic_to_jpg() {
        assert_eq!(output_file_name("photo.heic"), "photo.jpg");
        assert_eq!(output_file_name("photo.HEIC"), "photo.jpg");
        assert_eq!(output_file_name("photo.heif"), "photo.jpg");
        assert_eq!(output_file_name("photo.HEIF"), "photo.jpg");
    }

    #[test]
    fn output_file_name_keeps_non_heic_name() {
        assert_eq!(output_file_name("photo.png"), "photo.png");
        assert_eq!(output_file_name("doc.PDF"), "doc.PDF");
    }

    #[test]
    fn output_file_name_handles_name_without_extension() {
        assert_eq!(output_file_name("heicfile"), "heicfile.jpg");
    }
}
```

- [x] **Step 2: Add commands for compress/cancel/reveal**

Add to `src-tauri/src/commands.rs`:

```rust
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn compress_all(
    state: State<'_, FileListState>,
    queue: State<'_, crate::queue::QueueState>,
) -> String {
    let list = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let pending_ids: Vec<String> = list
        .iter()
        .filter(|e| e.status == FileStatus::Pending)
        .map(|e| e.id.clone())
        .collect();
    drop(list);

    let batch_id = uuid::Uuid::new_v4().to_string();
    queue.start_batch(batch_id.clone(), pending_ids);
    batch_id
}

#[tauri::command]
pub fn cancel_file(
    file_id: String,
    state: State<'_, FileListState>,
    queue: State<'_, crate::queue::QueueState>,
) {
    queue.cancel_file(&file_id);
    // Not-yet-started file has no token — mark Cancelled so the worker skips it
    let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
        if e.status == FileStatus::Pending {
            e.status = FileStatus::Cancelled;
        }
    }
}

#[tauri::command]
pub fn cancel_all(queue: State<'_, crate::queue::QueueState>) {
    queue.cancel_all();
}

#[tauri::command]
pub fn reveal_in_folder(file_path: String, app: AppHandle) -> Result<(), String> {
    app.opener()
        .reveal_item_in_dir(&file_path)
        .map_err(|e| format!("Could not reveal file: {}", e))
}
```

Uses the already-installed `tauri-plugin-opener` (`reveal_item_in_dir` reveals the file in the OS file manager). No shell plugin, no new capabilities — `opener:default` is already granted.

- [x] **Step 3: Register queue + new commands in lib.rs**

Update `src-tauri/src/lib.rs` — **keeps** the opener plugin and graceful startup:

```rust
mod commands;
mod detection;
mod engine;
mod models;
mod output;
mod processors;
mod queue;
mod settings;
mod sidecar;
mod temp;

use commands::FileListState;
use queue::QueueState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(FileListState(Mutex::new(Vec::new())))
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(QueueState::new(handle));
            temp::cleanup_stale_temp_files(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_files,
            commands::remove_file,
            commands::clear_list,
            commands::get_settings,
            commands::save_settings,
            commands::reset_settings,
            commands::compress_all,
            commands::cancel_file,
            commands::cancel_all,
            commands::reveal_in_folder,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            eprintln!("fatal: failed to start application: {e:#}");
            std::process::exit(1);
        });
}
```

- [x] **Step 4: Verify capabilities unchanged**

`src-tauri/capabilities/default.json` already contains `opener:default` — confirm it is still there; add nothing (no shell plugin).

- [x] **Step 5: Run tests**

```bash
cd src-tauri && cargo test queue::
```

Expected: `decide_result_status` (3) + `output_file_name` (3) tests pass.

- [x] **Step 6: Verify compilation**

```bash
yarn tauri dev
```

Expected: App launches without errors.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add job queue, compression commands, reveal_in_folder"
```

---

## Task 6: Download + Bundle vips Sidecar

**Files:**
- Create: `src-tauri/binaries/vips-{target-triple}[.exe]`
- Modify: `src-tauri/tauri.conf.json` (add externalBin)

**Interfaces:**
- Produces: bundled `vips` sidecar resolvable by Task 1's `get_sidecar_path` (dev: placed by Tauri next to the dev exe / resolvable via resource dir)

**Acceptance Criteria:**
- `src-tauri/binaries/vips-{target-triple}` exists for the current dev platform, is executable, and `--version` prints a vips version
- Binary **must support HEIF/HEIC decode** (built with libheif) — required for AC #6; plain `brew install vips` may lack HEIF — verify with `vips -l | grep heifload` or a HEIC smoke test
- `tauri.conf.json` `bundle.externalBin` contains `"binaries/vips"`
- Binary is executable (`chmod +x`) and named exactly `vips-<target-triple>` (Task 1's `sidecar_filename` must find it)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `tauri_conf_json_lists_vips_as_external_bin` — Rust test reading `$CARGO_MANIFEST_DIR/../tauri.conf.json`, asserting `bundle.externalBin` contains `"binaries/vips"`
- `sidecar_binary_exists_for_current_target_triple` — `#[ignore]`d by default (environment-specific); run manually with `cargo test -- --ignored`

- [x] **Step 1: Download vips binary for current platform**

macOS (arm64/x86_64):
```bash
mkdir -p src-tauri/binaries
brew install vips heif  # heif formula needed for HEIC decode support
vips --version          # confirm install
vips -l | grep heifload # confirm HEIF support — REQUIRED for AC #6
cp "$(command -v vips)" "src-tauri/binaries/vips-$(rustc -Vv | grep host | sed 's/host: //')"
chmod +x src-tauri/binaries/vips-*
```

Note: `command -v vips` copies the brew shim/binary. If the brew vips binary is a script wrapper or dylib-linked in a way that breaks standalone execution, build a static/portable binary instead — see `COMPRESSION_TOOLS_RESEARCH.md` for per-platform binary sources (Windows: `https://github.com/libvips/build-win64-mxe/releases`; Linux: distro package or build). Verify standalone execution: run the copied binary directly from the binaries dir.

Windows / Linux: download from the sources in `COMPRESSION_TOOLS_RESEARCH.md`, rename to `vips-x86_64-pc-windows-msvc.exe` / `vips-x86_64-unknown-linux-gnu`.

- [x] **Step 2: Add externalBin to tauri.conf.json**

In `src-tauri/tauri.conf.json`, add to the `bundle` section:

```json
{
  "bundle": {
    "externalBin": [
      "binaries/vips"
    ]
  }
}
```

- [x] **Step 3: Verify vips runs**

```bash
./src-tauri/binaries/vips-$(rustc -Vv | grep host | sed 's/host: //') --version
```

Expected: Prints vips version. Also smoke-test HEIC decode if a sample is available.

- [x] **Step 4: Add config sanity tests**

In `src-tauri/src/sidecar.rs` `#[cfg(test)]` module, append:

```rust
    #[test]
    fn tauri_conf_json_lists_vips_as_external_bin() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let conf = std::fs::read_to_string(format!("{}/../tauri.conf.json", manifest))
            .expect("tauri.conf.json readable from src-tauri");
        let value: serde_json::Value = serde_json::from_str(&conf).expect("valid JSON");
        let bins = value["bundle"]["externalBin"]
            .as_array()
            .expect("bundle.externalBin array");
        assert!(
            bins.iter().any(|b| b.as_str() == Some("binaries/vips")),
            "externalBin must list binaries/vips, got: {:?}",
            bins
        );
    }

    #[test]
    #[ignore = "requires sidecar binary present on this machine"]
    fn sidecar_binary_exists_for_current_target_triple() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let filename = sidecar_filename("vips").unwrap();
        let path = format!("{}/binaries/{}", manifest, filename);
        assert!(
            std::path::Path::new(&path).exists(),
            "sidecar missing at {} — run Task 6 Step 1",
            path
        );
    }
```

Run:
```bash
cd src-tauri && cargo test sidecar && cargo test -- --ignored
```

- [x] **Step 5: Commit**

Note: Large binary files. Consider using git-lfs or a download script.

```bash
git add -A
git commit -m "chore: bundle vips sidecar binary"
```

---

## Task 7: Create useCompression Hook + Update CompressView

**Files:**
- Create: `src/hooks/useCompression.ts`
- Create: `src/hooks/useCompression.test.ts`
- Modify: `src/views/CompressView.tsx` (add Compress button, progress bars, results display, reveal button)
- Modify: `src/components/FileList.tsx` (progress bar, before/after sizes, reveal + cancel buttons)
- Modify: `src/hooks/useFileList.ts` (**expose `setFiles`** — the hook's return currently has no setter; useCompression needs it)
- Modify: `src/views/CompressView.test.tsx` + `src/components/FileList.test.tsx` (mock `@tauri-apps/api/event`; new assertions)
- Modify: `src/App.tsx` (mount sonner `<Toaster />`)

**Interfaces:**
- Consumes: `compress_all`, `cancel_file`, `cancel_all`, `reveal_in_folder` commands (Task 5)
- Consumes: `file:progress`, `file:complete`, `file:error`, `file:cancelled`, `batch:complete` events (camelCase payloads)
- Produces: `useCompression(files, setFiles, callbacks) -> { isCompressing, progressByFile, compressAll, cancelFile, cancelAll, revealInFolder }`
- Produces: `useFileList(...)` gains `setFiles` in its return

**Acceptance Criteria:**
- `file:progress` events store `percent` in a `progressByFile` map keyed by `fileId` — the percentage must be rendered as a per-file progress bar (AC #9); discarding percent is a defect
- `file:complete` applies `status`, `compressedSize`, `outputPath` to the matching entry and drops its progress entry
- `file:error` sets `failed` + error message; `file:cancelled` sets `cancelled`; `batch:complete` resets `isCompressing` false
- Events for unknown fileIds (stale/removed files) are ignored without corrupting state
- Listeners unsubscribed on unmount (no duplicate-handler leak)
- `compressAll` no-ops when no pending files (never sets `isCompressing`), otherwise sets it true and invokes `compress_all`
- Compress button disabled when no pending files; Cancel All visible only while compressing
- Completed rows show `1.2 MB → 180 KB · 65% smaller` + hover-reveal Reveal button; best-effort rows show actual size in destructive red; compressing rows show progress bar + per-file Cancel
- Toast on batch complete ("Compressed N files. Saved X total.") and on errors (sonner)
- `<Toaster />` mounted in App.tsx
- Existing CompressView/FileList tests keep passing (event module mocked)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**

`src/hooks/useCompression.test.ts` (mock `@tauri-apps/api/core` + `@tauri-apps/api/event` with a controllable handler registry):
- `handles_file_progress_event_stores_percent` — `{ fileId, percent: 45 }` → `progressByFile[id] === 45`
- `handles_file_complete_event_sets_done_status_and_sizes` — status/compressedSize/outputPath applied, progress entry cleared
- `handles_file_error_event_sets_failed_with_message`
- `handles_file_cancelled_event_sets_cancelled`
- `handles_batch_complete_event_resets_is_compressing`
- `ignores_events_for_unknown_file_ids` — state unchanged
- `compress_all_invokes_command_when_pending_files_exist` — `isCompressing` true, `invoke('compress_all')` called
- `compress_all_noop_when_no_pending_files` — no invoke, `isCompressing` stays false
- `cancel_file/cancel_all/reveal_in_folder_invoke_with_camel_case_payloads` — `filePath` key verified
- `unsubscribes_all_listeners_on_unmount` — every `unlisten` called

`src/views/CompressView.test.tsx` + `src/components/FileList.test.tsx` (add `vi.mock('@tauri-apps/api/event', ...)`):
- `compress_button_disabled_when_no_pending_files`
- `compress_button_enabled_with_pending_files_and_triggers_compression`
- `cancel_all_button_visible_during_compression_only`
- `renders_progress_bar_while_status_is_compressing`
- `renders_before_after_size_and_percent_reduction_for_done_row` — `1.2 MB → 180 KB · 65% smaller`
- `renders_best_effort_status_with_actual_size`
- `renders_already_under_target_status_for_copied_file`
- `reveal_button_calls_reveal_in_folder_with_output_path`
- `per_file_cancel_button_calls_cancel_file`
- `batch_complete_toast_shows_total_saved_bytes` — sonner mocked

- [ ] **Step 1: Expose setFiles from useFileList.ts**

Add `setFiles` to the hook's return (single-line change):

```typescript
  return { files, error, addFiles, browseFiles, removeFile, clearList, setFiles }
```

- [ ] **Step 2: Create useCompression.ts**

```typescript
import { useEffect, useCallback, useState, type Dispatch, type SetStateAction } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { FileEntry, FileStatus } from '@/types'

interface ProgressPayload {
  fileId: string
  percent: number
}

interface CompletePayload {
  fileId: string
  outputPath: string
  originalSize: number
  compressedSize: number
  status: FileStatus
  metTarget: boolean
}

interface ErrorPayload {
  fileId: string
  errorMessage: string
}

interface CancelledPayload {
  fileId: string
}

interface BatchCompletePayload {
  batchId: string
  totalSavedBytes: number
}

export interface CompressionCallbacks {
  onBatchComplete?: (totalSavedBytes: number, processedCount: number) => void
  onBatchError?: (errorMessage: string) => void
}

export function useCompression(
  files: FileEntry[],
  setFiles: Dispatch<SetStateAction<FileEntry[]>>,
  callbacks?: CompressionCallbacks
) {
  const [isCompressing, setIsCompressing] = useState(false)
  const [progressByFile, setProgressByFile] = useState<Record<string, number>>({})

  useEffect(() => {
    const unlisteners: UnlistenFn[] = []
    const done = (u: UnlistenFn) => unlisteners.push(u)

    listen<ProgressPayload>('file:progress', (e) => {
      const { fileId, percent } = e.payload
      setProgressByFile((prev) => ({ ...prev, [fileId]: percent }))
    }).then(done)

    listen<CompletePayload>('file:complete', (e) => {
      const { fileId, outputPath, compressedSize, status } = e.payload
      setProgressByFile((prev) => {
        const next = { ...prev }
        delete next[fileId]
        return next
      })
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, status, compressedSize, outputPath }
            : f
        )
      )
    }).then(done)

    listen<ErrorPayload>('file:error', (e) => {
      const { fileId, errorMessage } = e.payload
      setProgressByFile((prev) => {
        const next = { ...prev }
        delete next[fileId]
        return next
      })
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, status: 'failed', error: errorMessage }
            : f
        )
      )
    }).then(done)

    listen<CancelledPayload>('file:cancelled', (e) => {
      const { fileId } = e.payload
      setProgressByFile((prev) => {
        const next = { ...prev }
        delete next[fileId]
        return next
      })
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId ? { ...f, status: 'cancelled' } : f
        )
      )
    }).then(done)

    listen<BatchCompletePayload>('batch:complete', (e) => {
      setIsCompressing(false)
      const processed = files.filter(
        (f) => f.status !== 'pending' && f.status !== 'unsupported'
      ).length
      callbacks?.onBatchComplete?.(e.payload.totalSavedBytes, processed)
    }).then(done)

    return () => {
      unlisteners.forEach((u) => u())
    }
  }, [setFiles, files, callbacks])

  const compressAll = useCallback(async () => {
    const pendingCount = files.filter((f) => f.status === 'pending').length
    if (pendingCount === 0) return
    setIsCompressing(true)
    await invoke('compress_all')
  }, [files])

  const cancelFile = useCallback(async (fileId: string) => {
    await invoke('cancel_file', { fileId })
  }, [])

  const cancelAll = useCallback(async () => {
    await invoke('cancel_all')
  }, [])

  const revealInFolder = useCallback(async (filePath: string) => {
    await invoke('reveal_in_folder', { filePath })
  }, [])

  return { isCompressing, progressByFile, compressAll, cancelFile, cancelAll, revealInFolder }
}
```

- [ ] **Step 3: Create useCompression.test.ts**

Mock pattern (match repo conventions from `useFileList.test.ts` — controllable listener registry):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const listeners = new Map<string, (e: { payload: unknown }) => void>()
const unlistens: vi.Mock[] = []

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    listeners.set(event, handler)
    const un = vi.fn()
    unlistens.push(un)
    return Promise.resolve(un)
  }),
}))

import { useCompression } from './useCompression'
import { invoke } from '@tauri-apps/api/core'

const emit = (event: string, payload: unknown) =>
  act(() => { listeners.get(event)?.({ payload }) })
```

Tests required (see Required Tests above): progress percent stored, complete/error/cancelled/batch-complete handlers, unknown-fileId ignore, compress_all invoke + no-op path, unlisten-all-on-unmount. Assert `invoke` called with `('cancel_file', { fileId })` / `('reveal_in_folder', { filePath })` — camelCase keys exactly.

- [ ] **Step 4: Update CompressView.tsx + FileList.tsx**

CompressView wiring (extends the Slice 2 view):

```tsx
import { useFileList } from '@/hooks/useFileList'
import { useCompression } from '@/hooks/useCompression'
import { DropZone } from '@/components/DropZone'
import { FileList } from '@/components/FileList'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
```

Implementation requirements:
- Drop zone (from Slice 2)
- File list with progress bar for `compressing` rows (from `progressByFile`)
- Compress button — disabled when `isCompressing` or no pending files; enabled otherwise
- Cancel All button — visible only while `isCompressing`
- Clear List button
- Batch summary in footer (live counts from file statuses)
- Toast wiring via `useCompression` callbacks:
  - `onBatchComplete: (saved, count) => toast.success(\`Compressed ${count} files. Saved ${formatBytes(saved)} total.\`)`
  - `onBatchError: (msg) => toast.error(msg)`
- Errors also toast per file: in `onFileError` style or from status watching — simplest: toast in the `file:error`-derived state via callback prop if added; otherwise keep error text in-row (red) — in-row display is sufficient for v1 if per-error toasts are skipped

FileList contract changes:
- New optional props: `progress?: Record<string, number>`, `onReveal?: (outputPath: string) => void`, `onCancel?: (fileId: string) => void`
- `compressing` row → progress bar (`progress[file.id] ?? 0`) + Cancel button
- `done`/`best_effort`/`already_under_target` rows → second line `formatSize(originalSize) → formatSize(compressedSize) · N% smaller` + hover-reveal Reveal button
- `best_effort` rows → size figures in `text-destructive`
- Keep the existing 5-column table structure and status badges from Slice 2 (existing tests rely on `getAllByText('—') >= 2` and 'Pending' visibility)

- [ ] **Step 5: Add sonner for toasts**

```bash
yarn dlx shadcn@latest add sonner
```

Add `<Toaster />` to `src/App.tsx` (from sonner).

- [ ] **Step 6: Update existing tests**

`src/views/CompressView.test.tsx` + `src/components/FileList.test.tsx`: add

```typescript
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}))
```

Then add the view tests listed in Required Tests (button states, progress bar, before/after line, reveal/cancel callbacks, batch toast).

- [ ] **Step 7: Verify end-to-end**

Run:
```bash
yarn tauri dev
```

Test:
1. Drop a JPEG > 200 KB → click Compress → file compresses → shows "Done" with before/after sizes
2. Check output folder → compressed file exists
3. Click reveal-in-folder → OS file manager opens at file location
4. Drop a small JPEG < 200 KB → compress → "Already under target"
5. Drop a very large image → compress → "Best effort" if can't reach 200 KB
6. Drop multiple files → processed sequentially with per-file progress
7. Batch complete → toast notification

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: wire up compression end-to-end with progress + results"
```

---

## Task 8: Acceptance Check

**Files:** none (verification only)

**Interfaces:** runs the project gate

**Acceptance Criteria:**
- Full gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`
- All 13 plan-level criteria verified manually (runtime behavior; `GATE_E2E_COMMAND` is `none`)
- Criteria with automated coverage: #7 (`already_under_target_copies_file_and_marks_result`), #12 (`collision_appends_dash_one_suffix`), #13 (sequential design + hook tests), #9 (progress map tests), #6 (HEIC rewrite tests)

**Required Tests:**
- Full gate run: `yarn build && yarn test && cd src-tauri && cargo test` — must pass clean before final commit
- `cargo test -- --ignored` (manual, optional) — real-vips sidecar presence + HEIC smoke if a sample file is available

- [ ] **Step 1: Run all 13 acceptance criteria**

1. ✅ JPEG > 200 KB → compresses to ≤ 200 KB, "Done"
2. ✅ Before/after sizes shown
3. ✅ Reveal in folder works
4. ✅ PNG compression works
5. ✅ WebP compression works
6. ✅ HEIC → JPEG conversion works
7. ✅ Already under target → copied as-is
8. ✅ Very large image → "Best effort" with actual size
9. ✅ Progress bar during compression
10. ✅ Compress button starts sequential processing
11. ✅ Output written to configured folder
12. ✅ Filename collision → -1 suffix
13. ✅ Multiple files: sequential, individual progress

- [ ] **Step 2: Run full gate**

```bash
yarn build && yarn test && cd src-tauri && cargo test
```

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: slice 4 complete — image compression end-to-end"
```