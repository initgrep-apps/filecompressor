# Slice 4: Image Compression (End-to-End) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drop a JPEG/PNG/WebP/HEIC → click Compress → file compresses to ≤ target via vips sidecar → result shown inline (before/after size, % reduction) → "Reveal in folder" opens file manager. If target unachievable at quality floor → "Best effort". If already under target → copied as-is.

**Architecture:** This slice establishes the compression infrastructure used by all later slices: `CompressionProcessor` trait, `TargetSizeEngine` orchestrator (binary search), sequential job queue (tokio mpsc), cancellation tokens, progress events. The `ImageProcessor` implements the trait using the `vips` sidecar. Output goes to the configured output folder with collision handling.

**Tech Stack:** Rust, tokio, libvips (sidecar), Tauri 2 events, React

## Global Constraints

- **vips sidecar:** Must be bundled via Tauri `externalBin`. Binary named with target triple suffix.
- **Binary search:** Q parameter 5–95, max 8 iterations. If floor (30) hit and still over → reduce dimensions by 10%.
- **HEIC input → JPEG output** (not HEIC output)
- **Strip all metadata** by default
- **Originals never modified** — write to output folder
- **Filename collision:** append `-1`, `-2` suffix
- **Temp files:** OS temp dir + app subfolder, cleaned after each job
- **"Already under target":** if `file_size <= target_bytes`, copy as-is, mark "Already under target"
- **Progress:** per-file percent via `file:progress` event (based on binary search iteration count)

## File Structure

```
src-tauri/src/
├── engine/
│   ├── mod.rs                # TargetSizeEngine orchestrator
│   ├── trait.rs              # CompressionProcessor trait
│   ├── result.rs             # CompressionResult, CompressionError
│   └── progress.rs           # ProgressSender (wraps Tauri event emitter)
├── processors/
│   ├── mod.rs                # Processor registry
│   └── image.rs              # ImageProcessor (vips sidecar)
├── queue.rs                  # Job queue (tokio mpsc + CancellationToken map)
├── sidecar.rs                # Sidecar path resolution + Command runner
├── output.rs                 # Output folder + filename collision handling
├── temp.rs                   # Temp directory management + cleanup
├── commands.rs               # (modify) add compress_all, cancel_file, cancel_all, reveal_in_folder
├── lib.rs                    # (modify) register engine + queue

src/
├── views/CompressView.tsx    # (modify) add Compress button, progress bars, results
├── hooks/
│   └── useCompression.ts     # Listen to progress/complete/error events, call compress_all
```

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
- Produces: `get_sidecar_path(app: &AppHandle, name: &str) -> Result<String>` — resolves sidecar binary path from Tauri resources

- [ ] **Step 1: Create sidecar.rs**

```rust
use tauri::{AppHandle, Manager};

pub fn get_sidecar_path(app: &AppHandle, name: &str) -> Result<String, String> {
    let resource_path = app
        .path()
        .resolve("binaries", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve binaries dir: {}", e))?;

    let target_triple = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "aarch64-apple-darwin",
        ("macos", "x86_64") => "x86_64-apple-darwin",
        ("windows", "x86_64") => "x86_64-pc-windows-msvc",
        ("linux", "x86_64") => "x86_64-unknown-linux-gnu",
        ("linux", "aarch64") => "aarch64-unknown-linux-gnu",
        (os, arch) => return Err(format!("Unsupported platform: {} {}", os, arch)),
    };

    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    let filename = format!("{}-{}{}", name, target_triple, suffix);
    let path = resource_path.join(&filename);

    if !path.exists() {
        return Err(format!("Sidecar binary not found: {}", path.display()));
    }

    Ok(path.to_string_lossy().to_string())
}
```

- [ ] **Step 2: Register module in lib.rs**

Add `mod sidecar;` to `src-tauri/src/lib.rs`.

- [ ] **Step 3: Commit**

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
- Produces: `resolve_output_path(folder, filename) -> PathBuf` (collision-safe), `create_temp_dir(app) -> PathBuf`, `cleanup_temp_dir(path)`

- [ ] **Step 1: Create output.rs**

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

    #[test]
    fn test_no_collision() {
        let path = resolve_output_path("/tmp/nonexistent_dir", "photo.jpg");
        assert_eq!(path.file_name().unwrap(), "photo.jpg");
    }
}
```

- [ ] **Step 2: Create temp.rs**

```rust
use std::path::PathBuf;
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

pub fn cleanup_stale_temp_files(app: &AppHandle) {
    let Ok(temp_base) = app.path().temp_dir() else {
        return;
    };
    let app_temp = temp_base.join("file-compressor");
    if !app_temp.exists() {
        return;
    }

    if let Ok(entries) = std::fs::read_dir(&app_temp) {
        let now = std::time::SystemTime::now();
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if now.duration_since(modified).map(|d| d.as_secs() > 86400).unwrap_or(false) {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
    }
}
```

- [ ] **Step 3: Register modules in lib.rs**

Add `mod output;` and `mod temp;` to `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run tests**

```bash
cd src-tauri && cargo test output -- --nocapture
```

Expected: collision test passes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add output path collision handling + temp file management"
```

---

## Task 3: Create Engine Trait + Result Types

**Files:**
- Create: `src-tauri/src/engine/mod.rs`
- Create: `src-tauri/src/engine/trait.rs`
- Create: `src-tauri/src/engine/result.rs`
- Create: `src-tauri/src/engine/progress.rs`

**Interfaces:**
- Produces: `CompressionProcessor` trait, `CompressionResult`, `CompressionError`, `ProgressSender`

- [ ] **Step 1: Create engine/result.rs**

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
```

- [ ] **Step 2: Create engine/progress.rs**

```rust
use tauri::{AppHandle, Emitter};
use std::sync::Arc;

#[derive(Clone)]
pub struct ProgressSender {
    app: Arc<AppHandle>,
    file_id: String,
}

impl ProgressSender {
    pub fn new(app: AppHandle, file_id: String) -> Self {
        ProgressSender {
            app: Arc::new(app),
            file_id,
        }
    }

    pub fn send_progress(&self, percent: u32) {
        let _ = self.app.emit("file:progress", serde_json::json!({
            "fileId": self.file_id,
            "percent": percent,
        }));
    }
}
```

- [ ] **Step 3: Create engine/trait.rs**

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

- [ ] **Step 4: Create engine/mod.rs**

```rust
pub mod trait;
pub mod result;
pub mod progress;

pub use trait::CompressionProcessor;
pub use result::{CompressionResult, CompressionError};
pub use progress::ProgressSender;
```

- [ ] **Step 5: Add tokio-util dependency**

Add to `src-tauri/Cargo.toml`:
```toml
tokio-util = "0.7"
```

- [ ] **Step 6: Register module in lib.rs**

Add `mod engine;` to `src-tauri/src/lib.rs`.

- [ ] **Step 7: Commit**

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
- Produces: `ImageProcessor` struct implementing the trait

- [ ] **Step 1: Create processors/mod.rs**

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
```

- [ ] **Step 2: Create processors/image.rs**

```rust
use std::path::Path;
use tokio_util::sync::CancellationToken;
use crate::engine::{CompressionProcessor, CompressionResult, CompressionError, ProgressSender};
use crate::models::Category;
use crate::settings::QualityFloors;

pub struct ImageProcessor;

impl ImageProcessor {
    pub fn new() -> Self {
        ImageProcessor
    }

    fn get_output_extension(input: &Path) -> &str {
        let ext = input.extension().and_then(|e| e.to_str()).unwrap_or("jpg");
        match ext.to_lowercase().as_str() {
            "heic" | "heif" => "jpg", // HEIC → JPEG
            other => match other {
                "jpg" | "jpeg" => "jpg",
                "png" => "png",
                "webp" => "webp",
                _ => "jpg",
            }
        }
    }

    fn run_vips(
        sidecar_path: &str,
        input: &Path,
        output: &Path,
        quality: u32,
        cancel_token: &CancellationToken,
    ) -> Result<(), CompressionError> {
        let output_str = output.to_string_lossy();
        let suffix = match output.extension().and_then(|e| e.to_str()).unwrap_or("jpg").to_lowercase().as_str() {
            "png" => format!("{}[palette=true,Q=256,strip]", output_str),
            _ => format!("{}[Q={},strip]", output_str, quality),
        };

        let mut child = std::process::Command::new(sidecar_path)
            .arg("copy")
            .arg(input.to_string_lossy().as_ref())
            .arg(&suffix)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| CompressionError::SidecarFailed(format!("Failed to start vips: {}", e)))?;

        if cancel_token.is_cancelled() {
            let _ = child.kill();
            return Err(CompressionError::Cancelled);
        }

        let status = child.wait()
            .map_err(|e| CompressionError::SidecarFailed(format!("vips wait failed: {}", e)))?;

        if !status.success() {
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }
            return Err(CompressionError::SidecarFailed(format!("vips exited with code {:?}", status.code())));
        }

        Ok(())
    }

    fn run_vips_resize(
        sidecar_path: &str,
        input: &Path,
        output: &Path,
        quality: u32,
        scale_percent: u32,
        cancel_token: &CancellationToken,
    ) -> Result<(), CompressionError> {
        // First get image dimensions, then scale
        let output_str = output.to_string_lossy();

        let mut child = std::process::Command::new(sidecar_path)
            .arg("thumbnail")
            .arg(input.to_string_lossy().as_ref())
            .arg(format!("{}[Q={},strip]", output_str, quality))
            .arg(format!("{}", scale_percent))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| CompressionError::SidecarFailed(format!("Failed to start vips thumbnail: {}", e)))?;

        if cancel_token.is_cancelled() {
            let _ = child.kill();
            return Err(CompressionError::Cancelled);
        }

        let status = child.wait()
            .map_err(|e| CompressionError::SidecarFailed(format!("vips wait failed: {}", e)))?;

        if !status.success() {
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }
            return Err(CompressionError::SidecarFailed(format!("vips thumbnail exited with code {:?}", status.code())));
        }

        Ok(())
    }
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

        // Already under target
        if input_size <= target_bytes {
            std::fs::copy(input, output)
                .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
            return Ok(CompressionResult {
                output_path: output.to_path_buf(),
                compressed_size: input_size,
                quality_used: 100,
                met_target: true,
                strategy_used: "already-under-target".to_string(),
            });
        }

        let min_quality = quality_floor.image.min_quality;
        let max_quality: u32 = 95;
        let mut lo = min_quality;
        let mut hi = max_quality;
        let mut best_result: Option<(u32, u64, std::path::PathBuf)> = None;

        let temp_output = temp_dir.join("compress_temp");
        let output_ext = Self::get_output_extension(input);
        let temp_file = temp_output.with_extension(output_ext);

        // Binary search on quality
        for iteration in 0..8u32 {
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }

            let mid = (lo + hi) / 2;
            let percent = ((iteration as u32 * 100) / 8).min(90);
            progress.send_progress(percent);

            let result = Self::run_vips(sidecar_path, input, &temp_file, mid, &cancel_token);

            match result {
                Ok(()) => {
                    let size = std::fs::metadata(&temp_file)
                        .map(|m| m.len())
                        .unwrap_or(u64::MAX);

                    if size <= target_bytes {
                        // Success — try higher quality
                        best_result = Some((mid, size, temp_file.clone()));
                        lo = mid + 1;
                    } else {
                        // Too big — try lower quality
                        hi = if mid == 0 { 0 } else { mid - 1 };
                    }
                }
                Err(CompressionError::Cancelled) => return Err(CompressionError::Cancelled),
                Err(e) => return Err(e),
            }

            if lo > hi {
                break;
            }
        }

        // If best result met target, use it
        if let Some((quality, size, ref path)) = best_result {
            if size <= target_bytes {
                std::fs::copy(path, output)
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
        }

        // Quality floor hit — try dimension reduction
        progress.send_progress(92);
        let mut scale: u32 = 90;
        let quality = min_quality;

        while scale >= 50 {
            if cancel_token.is_cancelled() {
                return Err(CompressionError::Cancelled);
            }

            let result = Self::run_vips_resize(sidecar_path, input, &temp_file, quality, scale, &cancel_token);

            match result {
                Ok(()) => {
                    let size = std::fs::metadata(&temp_file)
                        .map(|m| m.len())
                        .unwrap_or(u64::MAX);

                    if size <= target_bytes {
                        std::fs::copy(&temp_file, output)
                            .map_err(|e| CompressionError::OutputFileError(e.to_string()))?;
                        progress.send_progress(100);
                        return Ok(CompressionResult {
                            output_path: output.to_path_buf(),
                            compressed_size: size,
                            quality_used: quality,
                            met_target: true,
                            strategy_used: format!("quality={},dims={}%", quality, scale),
                        });
                    }

                    best_result = Some((quality, size, temp_file.clone()));
                }
                Err(CompressionError::Cancelled) => return Err(CompressionError::Cancelled),
                Err(e) => return Err(e),
            }

            scale = if scale <= 10 { 0 } else { scale - 10 };
        }

        // Best effort — use smallest result
        if let Some((quality, size, ref path)) = best_result {
            std::fs::copy(path, output)
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

        Err(CompressionError::SidecarFailed("Could not compress image".to_string()))
    }
}
```

- [ ] **Step 3: Register module in lib.rs**

Add `mod processors;` to `src-tauri/src/lib.rs`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: implement ImageProcessor with vips binary search"
```

---

## Task 5: Implement Job Queue + Cancellation

**Files:**
- Create: `src-tauri/src/queue.rs`
- Modify: `src-tauri/src/commands.rs` (add compress_all, cancel_file, cancel_all, reveal_in_folder)

**Interfaces:**
- Produces: `JobQueue` struct, `compress_all`, `cancel_file`, `cancel_all` commands

- [ ] **Step 1: Create queue.rs**

```rust
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;
use tauri::{AppHandle, Emitter, Manager};
use crate::commands::FileListState;
use crate::engine::{CompressionProcessor, CompressionResult, CompressionError, ProgressSender};
use crate::models::{Category, FileStatus};
use crate::output::resolve_output_path;
use crate::processors::ProcessorRegistry;
use crate::sidecar;
use crate::temp;

pub struct JobQueue {
    cancel_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    sender: mpsc::UnboundedSender<JobMessage>,
}

enum JobMessage {
    Compress(Vec<String>), // file_ids
    CancelFile(String),
    CancelAll,
}

impl JobQueue {
    pub fn new(app: AppHandle) -> Self {
        let (sender, mut receiver) = mpsc::unbounded_channel::<JobMessage>();
        let cancel_tokens: Arc<Mutex<HashMap<String, CancellationToken>>> = Arc::new(Mutex::new(HashMap::new()));

        let cancel_tokens_clone = cancel_tokens.clone();
        let app_clone = app.clone();

        tokio::spawn(async move {
            while let Some(msg) = receiver.recv().await {
                match msg {
                    JobMessage::Compress(file_ids) => {
                        Self::process_batch(&app_clone, &cancel_tokens_clone, file_ids).await;
                    }
                    JobMessage::CancelFile(file_id) => {
                        let tokens = cancel_tokens_clone.lock().await;
                        if let Some(token) = tokens.get(&file_id) {
                            token.cancel();
                        }
                    }
                    JobMessage::CancelAll => {
                        let tokens = cancel_tokens_clone.lock().await;
                        for token in tokens.values() {
                            token.cancel();
                        }
                    }
                }
            }
        });

        JobQueue { cancel_tokens, sender }
    }

    pub fn compress(&self, file_ids: Vec<String>) {
        let _ = self.sender.send(JobMessage::Compress(file_ids));
    }

    pub fn cancel_file(&self, file_id: String) {
        let _ = self.sender.send(JobMessage::CancelFile(file_id));
    }

    pub fn cancel_all(&self) {
        let _ = self.sender.send(JobMessage::CancelAll);
    }

    async fn process_batch(
        app: &AppHandle,
        cancel_tokens: &Arc<Mutex<HashMap<String, CancellationToken>>>,
        file_ids: Vec<String>,
    ) {
        let registry = ProcessorRegistry::new();
        let state = app.state::<FileListState>();
        let batch_id = uuid::Uuid::new_v4().to_string();
        let mut total_saved: u64 = 0;

        for file_id in file_ids {
            // Get file entry from state
            let entry = {
                let list = state.0.lock().unwrap();
                list.iter().find(|e| e.id == file_id).cloned()
            };

            let Some(entry) = entry else { continue };
            if entry.status != FileStatus::Pending {
                continue;
            }

            // Check output folder
            let settings = crate::commands::load_settings(app);
            let output_folder = settings.output_folder.clone();
            if !std::path::Path::new(&output_folder).exists() {
                let _ = std::fs::create_dir_all(&output_folder);
            }

            // Create cancel token
            let cancel_token = CancellationToken::new();
            {
                let mut tokens = cancel_tokens.lock().await;
                tokens.insert(file_id.clone(), cancel_token.clone());
            }

            // Update status to Compressing
            {
                let mut list = state.0.lock().unwrap();
                if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                    e.status = FileStatus::Compressing;
                }
            }

            let progress = ProgressSender::new(app.clone(), file_id.clone());

            let result = if entry.category == Category::Other {
                Err(CompressionError::Unknown("Unsupported file type".to_string()))
            } else if let Some(processor) = registry.get_processor(entry.category) {
                // Create temp dir
                let temp_dir = match temp::create_temp_dir(app) {
                    Ok(d) => d,
                    Err(e) => {
                        let _ = app.emit("file:error", serde_json::json!({
                            "fileId": file_id,
                            "errorMessage": e,
                        }));
                        continue;
                    }
                };

                // Resolve output path with collision handling
                let output_filename = if entry.category == Category::Image && 
                    (entry.name.ends_with(".heic") || entry.name.ends_with(".heif")) {
                    entry.name.rsplit_once('.').map(|(stem, _)| format!("{}.jpg", stem)).unwrap_or(entry.name.clone())
                } else {
                    entry.name.clone()
                };
                let output_path = resolve_output_path(&output_folder, &output_filename);

                // Get sidecar path
                let sidecar_name = match entry.category {
                    Category::Image => "vips",
                    _ => "vips",
                };
                let sidecar_path = match sidecar::get_sidecar_path(app, sidecar_name) {
                    Ok(p) => p,
                    Err(e) => {
                        let _ = app.emit("file:error", serde_json::json!({
                            "fileId": file_id,
                            "errorMessage": e,
                        }));
                        temp::cleanup_temp_dir(&temp_dir);
                        continue;
                    }
                };

                let result = processor.compress_to_target(
                    std::path::Path::new(&entry.path),
                    &output_path,
                    entry.target_bytes,
                    &settings.quality_floors,
                    cancel_token,
                    progress,
                    &sidecar_path,
                    &temp_dir,
                );

                temp::cleanup_temp_dir(&temp_dir);
                result
            } else {
                Err(CompressionError::Unknown("No processor for category".to_string()))
            };

            // Process result
            match result {
                Ok(compression_result) => {
                    let saved = entry.original_size.saturating_sub(compression_result.compressed_size);
                    total_saved += saved;

                    let status = if compression_result.met_target {
                        if compression_result.strategy_used == "already-under-target" {
                            FileStatus::AlreadyUnderTarget
                        } else {
                            FileStatus::Done
                        }
                    } else {
                        FileStatus::BestEffort
                    };

                    // Update state
                    {
                        let mut list = state.0.lock().unwrap();
                        if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                            e.status = status;
                            e.compressed_size = Some(compression_result.compressed_size);
                            e.output_path = Some(compression_result.output_path.to_string_lossy().to_string());
                        }
                    }

                    let _ = app.emit("file:complete", serde_json::json!({
                        "fileId": file_id,
                        "outputPath": compression_result.output_path.to_string_lossy(),
                        "originalSize": entry.original_size,
                        "compressedSize": compression_result.compressed_size,
                        "status": serde_json::to_value(status).unwrap_or(serde_json::Value::Null),
                        "metTarget": compression_result.met_target,
                    }));
                }
                Err(CompressionError::Cancelled) => {
                    let mut list = state.0.lock().unwrap();
                    if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                        e.status = FileStatus::Cancelled;
                    }
                    let _ = app.emit("file:cancelled", serde_json::json!({
                        "fileId": file_id,
                    }));
                }
                Err(e) => {
                    let error_msg = e.to_string();
                    let mut list = state.0.lock().unwrap();
                    if let Some(e2) = list.iter_mut().find(|e2| e2.id == file_id) {
                        e2.status = FileStatus::Failed;
                        e2.error = Some(error_msg.clone());
                    }
                    let _ = app.emit("file:error", serde_json::json!({
                        "fileId": file_id,
                        "errorMessage": error_msg,
                    }));
                }
            }

            // Remove cancel token
            {
                let mut tokens = cancel_tokens.lock().await;
                tokens.remove(&file_id);
            }
        }

        let _ = app.emit("batch:complete", serde_json::json!({
            "batchId": batch_id,
            "totalSavedBytes": total_saved,
        }));
    }
}
```

- [ ] **Step 2: Add commands for compress/cancel/reveal**

Add to `src-tauri/src/commands.rs`:

```rust
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
pub fn compress_all(
    state: State<FileListState>,
    app: AppHandle,
    queue: State<crate::queue::JobQueue>,
) -> String {
    let list = state.0.lock().unwrap();
    let pending_ids: Vec<String> = list
        .iter()
        .filter(|e| e.status == FileStatus::Pending)
        .map(|e| e.id.clone())
        .collect();
    drop(list);

    let batch_id = uuid::Uuid::new_v4().to_string();
    queue.compress(pending_ids);
    batch_id
}

#[tauri::command]
pub fn cancel_file(file_id: String, queue: State<crate::queue::JobQueue>) {
    queue.cancel_file(file_id);
}

#[tauri::command]
pub fn cancel_all(queue: State<crate::queue::JobQueue>) {
    queue.cancel_all();
}

#[tauri::command]
pub fn reveal_in_folder(file_path: String, app: AppHandle) -> Result<(), String> {
    let path = std::path::Path::new(&file_path);
    let _ = app.shell().open(path, None);
    Ok(())
}
```

Add `tauri-plugin-shell` to `Cargo.toml` and register it in `lib.rs`. Add `"shell:default"` to capabilities.

- [ ] **Step 3: Register queue + new commands in lib.rs**

Update `src-tauri/src/lib.rs`:

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
use queue::JobQueue;
use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_shell::init())
        .manage(FileListState(Mutex::new(Vec::new())))
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(JobQueue::new(handle));
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
        .expect("error while running tauri application");
}
```

- [ ] **Step 4: Add tauri-plugin-shell to Cargo.toml**

```toml
tauri-plugin-shell = "2"
```

- [ ] **Step 5: Install frontend shell package**

```bash
yarn add @tauri-apps/plugin-shell
```

- [ ] **Step 6: Add shell permissions to capabilities**

Update `src-tauri/capabilities/default.json`:
```json
{
  "permissions": [
    "core:default",
    "dialog:default",
    "store:default",
    "shell:default"
  ]
}
```

- [ ] **Step 7: Verify compilation**

```bash
yarn tauri dev
```

Expected: App launches without errors.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add job queue, compression commands, reveal_in_folder"
```

---

## Task 6: Download + Bundle vips Sidecar

**Files:**
- Create: `src-tauri/binaries/vips-{target-triple}[.exe]`
- Modify: `src-tauri/tauri.conf.json` (add externalBin)

- [ ] **Step 1: Download vips binary for current platform**

For macOS (arm64):
```bash
mkdir -p src-tauri/binaries
# Download from https://github.com/libvips/build-win64-mxe/releases (Windows)
# or build from source / install via brew (macOS)
# For now, create a placeholder — actual binary download is platform-specific
```

**Important:** The implementer must download the actual vips binary for their development platform. See `COMPRESSION_TOOLS_RESEARCH.md` for sources per platform. Rename the binary to `vips-{target-triple}` (e.g. `vips-aarch64-apple-darwin` on macOS arm64).

- [ ] **Step 2: Add externalBin to tauri.conf.json**

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

- [ ] **Step 3: Verify vips runs**

```bash
./src-tauri/binaries/vips-aarch64-apple-darwin --version
```

Expected: Prints vips version. (Adjust filename for your platform.)

- [ ] **Step 4: Commit**

Note: Large binary files. Consider using git-lfs or a download script.

```bash
git add -A
git commit -m "chore: bundle vips sidecar binary"
```

---

## Task 7: Create useCompression Hook + Update CompressView

**Files:**
- Create: `src/hooks/useCompression.ts`
- Modify: `src/views/CompressView.tsx` (add Compress button, progress bars, results display, reveal button)

- [ ] **Step 1: Create useCompression.ts**

```typescript
import { useEffect, useCallback, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import type { FileEntry, FileStatus } from '@/types'

interface ProgressEvent {
  fileId: string
  percent: number
}

interface CompleteEvent {
  fileId: string
  outputPath: string
  originalSize: number
  compressedSize: number
  status: FileStatus
  metTarget: boolean
}

interface ErrorEvent {
  fileId: string
  errorMessage: string
}

interface CancelledEvent {
  fileId: string
}

interface BatchCompleteEvent {
  batchId: string
  totalSavedBytes: number
}

export function useCompression(
  files: FileEntry[],
  setFiles: React.Dispatch<React.SetStateAction<FileEntry[]>>
) {
  const [isCompressing, setIsCompressing] = useState(false)

  useEffect(() => {
    const unlisteners: UnlistenFn[] = []

    listen<ProgressEvent>('file:progress', (e) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === e.payload.fileId
            ? { ...f, status: 'compressing' }
            : f
        )
      )
    }).then((u) => unlisteners.push(u))

    listen<CompleteEvent>('file:complete', (e) => {
      const { fileId, outputPath, compressedSize, status, metTarget } = e.payload
      setFiles((prev) =>
        prev.map((f) =>
          f.id === fileId
            ? { ...f, status, compressedSize, outputPath }
            : f
        )
      )
    }).then((u) => unlisteners.push(u))

    listen<ErrorEvent>('file:error', (e) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === e.payload.fileId
            ? { ...f, status: 'failed', error: e.payload.errorMessage }
            : f
        )
      )
    }).then((u) => unlisteners.push(u))

    listen<CancelledEvent>('file:cancelled', (e) => {
      setFiles((prev) =>
        prev.map((f) =>
          f.id === e.payload.fileId
            ? { ...f, status: 'cancelled' }
            : f
        )
      )
    }).then((u) => unlisteners.push(u))

    listen<BatchCompleteEvent>('batch:complete', (e) => {
      setIsCompressing(false)
    }).then((u) => unlisteners.push(u))

    return () => {
      unlisteners.forEach((u) => u())
    }
  }, [setFiles])

  const compressAll = useCallback(async () => {
    const pendingCount = files.filter((f) => f.status === 'pending').length
    if (pendingCount === 0) return
    setIsCompressing(true)
    setFiles((prev) =>
      prev.map((f) =>
        f.status === 'pending' ? { ...f, status: 'pending' } : f
      )
    )
    await invoke('compress_all')
  }, [files, setFiles])

  const cancelFile = useCallback(async (fileId: string) => {
    await invoke('cancel_file', { fileId })
  }, [])

  const cancelAll = useCallback(async () => {
    await invoke('cancel_all')
  }, [])

  const revealInFolder = useCallback(async (filePath: string) => {
    await invoke('reveal_in_folder', { filePath })
  }, [])

  return { isCompressing, compressAll, cancelFile, cancelAll, revealInFolder }
}
```

- [ ] **Step 2: Update CompressView.tsx**

Replace `src/views/CompressView.tsx` with the full compress view including Compress button, progress bars, status display, and reveal-in-folder:

```tsx
import { useFileList } from '@/hooks/useFileList'
import { useCompression } from '@/hooks/useCompression'
import { DropZone } from '@/components/DropZone'
import { FileList } from '@/components/FileList'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
```

The full implementation should include:
- Drop zone (from Slice 2)
- File list with progress bars for compressing files
- Compress button (enabled when there are pending files)
- Cancel All button (visible during compression)
- Clear List button
- Batch summary in footer
- Reveal in folder button on completed rows (hover-reveal)
- Toast notifications on batch complete and errors

The FileList component from Slice 2 needs updating to show:
- Progress bar for compressing files
- Before/after size for done/best-effort files
- Reveal button for done/best-effort files
- Cancel button for compressing files

- [ ] **Step 3: Add sonner for toasts**

```bash
yarn dlx shadcn@latest add sonner
```

Add `<Toaster />` to `src/App.tsx` (from sonner).

- [ ] **Step 4: Verify end-to-end**

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

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire up compression end-to-end with progress + results"
```

---

## Task 8: Acceptance Check

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

- [ ] **Step 2: Run Rust tests**

```bash
cd src-tauri && cargo test
```

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: slice 4 complete — image compression end-to-end"
```