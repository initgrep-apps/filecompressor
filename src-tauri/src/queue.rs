// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use crate::commands::FileListState;
use crate::engine::{CompressionError, CompressionResult, ProgressSender};
use crate::models::{FileEntry, FileStatus};
use crate::output::resolve_output_path;
use crate::processors::ProcessorRegistry;
use crate::sidecar;
use crate::temp;
use std::collections::HashMap;
use std::sync::{LockResult, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

fn poison_recover<T>(lock: LockResult<MutexGuard<'_, T>>) -> MutexGuard<'_, T> {
    lock.unwrap_or_else(|e| {
        eprintln!("warn: queue state mutex was poisoned, recovering: {e}");
        e.into_inner()
    })
}

/// HEIC/HEIF input → .jpg output and MOV input → .mp4 output (spec §3),
/// case-insensitive. Resolving the real output extension here is what makes
/// collision detection apply before any processor touches the filename.
pub(crate) fn output_file_name(name: &str) -> String {
    let lower = name.to_lowercase();
    let output_ext: Option<&str> = if lower.ends_with(".heic") || lower.ends_with(".heif") {
        Some("jpg")
    } else if lower.ends_with(".mov") {
        Some("mp4")
    } else {
        None
    };
    match output_ext {
        Some(ext) => name.rsplit_once('.').map_or_else(
            || format!("{name}.{ext}"),
            |(stem, _)| format!("{stem}.{ext}"),
        ),
        None => name.to_string(),
    }
}

/// Map a successful CompressionResult to its final FileStatus.
pub(crate) fn decide_result_status(result: &CompressionResult) -> FileStatus {
    if !result.met_target {
        FileStatus::BestEffort
    } else if result.is_already_under_target() {
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

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileErrorPayload<'a> {
    file_id: &'a str,
    error_message: String,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCompletePayload<'a> {
    file_id: &'a str,
    output_path: String,
    original_size: u64,
    compressed_size: u64,
    status: FileStatus,
    met_target: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCancelledPayload<'a> {
    file_id: &'a str,
}

#[derive(Clone, serde::Serialize)]
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
    batch_tokens: Mutex<HashMap<String, CancellationToken>>,
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
            batch_tokens: Mutex::new(HashMap::new()),
            sender,
        }
    }

    /// Called by compress_all: registers the batch token then queues work.
    pub fn start_batch(&self, app: &AppHandle, batch_id: String, file_ids: Vec<String>) {
        let token = CancellationToken::new();
        poison_recover(self.batch_tokens.lock()).insert(batch_id.clone(), token);

        if self
            .sender
            .send(BatchMessage {
                batch_id: batch_id.clone(),
                file_ids,
            })
            .is_err()
        {
            eprintln!("warn: job worker unavailable, batch dropped: {batch_id}");
            let _ = app.emit(
                "batch:error",
                serde_json::json!({ "batchId": batch_id, "errorMessage": "Job worker unavailable" }),
            );
            poison_recover(self.batch_tokens.lock()).remove(&batch_id);
        }
    }

    pub fn cancel_file(&self, file_id: &str) {
        if let Some(token) = poison_recover(self.token_map.lock()).get(file_id) {
            token.cancel();
        }
    }

    pub fn cancel_all(&self) {
        for token in poison_recover(self.batch_tokens.lock()).values() {
            token.cancel();
        }
        for token in poison_recover(self.token_map.lock()).values() {
            token.cancel();
        }
    }

    fn batch_cancelled(&self, batch_id: &str) -> bool {
        poison_recover(self.batch_tokens.lock())
            .get(batch_id)
            .is_some_and(|t| t.is_cancelled())
    }

    fn insert_token(&self, file_id: &str, token: CancellationToken) {
        poison_recover(self.token_map.lock()).insert(file_id.to_string(), token);
    }

    fn remove_token(&self, file_id: &str) {
        poison_recover(self.token_map.lock()).remove(file_id);
    }

    async fn process_batch(app: &AppHandle, batch_id: String, file_ids: Vec<String>) {
        let queue = app.state::<QueueState>();
        let registry = ProcessorRegistry::new();
        let state = app.state::<FileListState>();

        // Preflight: the output folder must be writable before the batch starts
        let settings = crate::commands::load_settings(app);
        let output_folder = settings.output_folder.clone();
        if let Err(e) = ensure_output_folder_writable(&output_folder) {
            poison_recover(queue.batch_tokens.lock()).remove(&batch_id);
            let _ = app.emit(
                "batch:error",
                serde_json::json!({ "batchId": batch_id, "errorMessage": e }),
            );
            return;
        }

        let mut total_saved: u64 = 0;

        for file_id in file_ids {
            // Cancel-all stops the remaining queue
            if queue.batch_cancelled(&batch_id) {
                let mut list = poison_recover(state.0.lock());
                if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                    if e.status == FileStatus::Pending {
                        e.status = FileStatus::Cancelled;
                    }
                }
                emit_file_cancelled(app, &file_id);
                continue;
            }

            let entry: Option<FileEntry> = {
                let list = poison_recover(state.0.lock());
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
            queue.insert_token(&file_id, cancel_token.clone());

            let flipped = {
                let mut list = poison_recover(state.0.lock());
                match list.iter_mut().find(|e| e.id == file_id) {
                    Some(e) if e.status == FileStatus::Pending => {
                        e.status = FileStatus::Compressing;
                        true
                    }
                    _ => false,
                }
            };
            if !flipped {
                queue.remove_token(&file_id);
                continue;
            }

            let progress = ProgressSender::new(app.clone(), file_id.clone());

            let result = match registry.get_processor(entry.category) {
                None => {
                    // No processor registered (Video/Document in this slice):
                    // skip as Unsupported — NOT Failed (spec §3/§6)
                    {
                        let mut list = poison_recover(state.0.lock());
                        if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                            e.status = FileStatus::Unsupported;
                        }
                    }
                    let _ = app.emit(
                        "file:complete",
                        FileCompletePayload {
                            file_id: &file_id,
                            output_path: String::new(),
                            original_size: entry.original_size,
                            compressed_size: 0,
                            status: FileStatus::Unsupported,
                            met_target: false,
                        },
                    );
                    queue.remove_token(&file_id);
                    continue;
                }
                Some(processor) => {
                    let temp_dir = match temp::create_temp_dir(app) {
                        Ok(d) => d,
                        Err(e) => {
                            let error_msg = e.clone();
                            {
                                let mut list = poison_recover(state.0.lock());
                                if let Some(e2) = list.iter_mut().find(|e2| e2.id == file_id) {
                                    e2.status = FileStatus::Failed;
                                    e2.error = Some(error_msg.clone());
                                }
                            }
                            let _ = app.emit(
                                "file:error",
                                FileErrorPayload {
                                    file_id: &file_id,
                                    error_message: error_msg,
                                },
                            );
                            queue.remove_token(&file_id);
                            continue;
                        }
                    };

                    let output_filename = output_file_name(&entry.name);
                    let output_path = resolve_output_path(&output_folder, &output_filename);

                    let run = match sidecar::resolve_all_sidecar_paths() {
                        Ok(sidecar_paths) => processor.compress_to_target(
                            std::path::Path::new(&entry.path),
                            &output_path,
                            entry.target_bytes,
                            &settings.quality_floors,
                            cancel_token,
                            progress,
                            &sidecar_paths,
                            &temp_dir,
                        ),
                        // resolve_all_sidecar_paths already carries the
                        // "Engine error: …" wording; Unknown only re-labels
                        // pre-formatted text. A portable test trigger is
                        // hard: happy-path exe dirs always resolve, and
                        // simulating a broken current_exe() (no parent dir,
                        // non-UTF-8 cwd) is not feasible from a spawned test
                        // binary — the failure shape is pinned indirectly via
                        // sidecar.rs resolve/resolve_for unit tests.
                        Err(e) => Err(CompressionError::Unknown(e)),
                    };

                    // Temp cleaned after each job, even on error/cancel (spec §6)
                    temp::cleanup_temp_dir(&temp_dir);
                    run
                }
            };

            match result {
                Ok(compression_result) => {
                    let saved = entry
                        .original_size
                        .saturating_sub(compression_result.compressed_size);
                    total_saved += saved;
                    let status = decide_result_status(&compression_result);
                    let out_path = compression_result.output_path.to_string_lossy().to_string();

                    {
                        let mut list = poison_recover(state.0.lock());
                        if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                            e.status = status;
                            e.compressed_size = Some(compression_result.compressed_size);
                            e.output_path = Some(out_path.clone());
                        }
                    }

                    let _ = app.emit(
                        "file:complete",
                        FileCompletePayload {
                            file_id: &file_id,
                            output_path: out_path,
                            original_size: entry.original_size,
                            compressed_size: compression_result.compressed_size,
                            status,
                            met_target: compression_result.met_target,
                        },
                    );
                }
                Err(CompressionError::Cancelled) => {
                    let mut list = poison_recover(state.0.lock());
                    if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                        e.status = FileStatus::Cancelled;
                    }
                    emit_file_cancelled(app, &file_id);
                }
                Err(e) => {
                    let error_msg = e.to_string();
                    let mut list = poison_recover(state.0.lock());
                    if let Some(e2) = list.iter_mut().find(|e2| e2.id == file_id) {
                        e2.status = FileStatus::Failed;
                        e2.error = Some(error_msg.clone());
                    }
                    let _ = app.emit(
                        "file:error",
                        FileErrorPayload {
                            file_id: &file_id,
                            error_message: error_msg,
                        },
                    );
                }
            }

            queue.remove_token(&file_id);
        }

        poison_recover(queue.batch_tokens.lock()).remove(&batch_id);

        let _ = app.emit(
            "batch:complete",
            BatchCompletePayload {
                batch_id: &batch_id,
                total_saved_bytes: total_saved,
            },
        );
    }
}

/// Emits the file:cancelled event (used by the worker and the cancel command).
pub(crate) fn emit_file_cancelled(app: &AppHandle, file_id: &str) {
    let _ = app.emit("file:cancelled", FileCancelledPayload { file_id });
}

fn ensure_output_folder_writable(folder: &str) -> Result<(), String> {
    let path = std::path::Path::new(folder);
    if !path.exists() {
        std::fs::create_dir_all(path).map_err(|e| format!("Output folder not writable: {}", e))?;
    }
    let probe = path.join(".write-probe");
    std::fs::write(&probe, b"ok")
        .map(|_| {
            if let Err(e) = std::fs::remove_file(&probe) {
                eprintln!("warn: failed to remove write-probe file: {e}");
            }
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
        assert_eq!(
            decide_result_status(&result(true, "quality=75")),
            FileStatus::Done
        );
    }

    #[test]
    fn decide_result_status_maps_unmet_target_to_best_effort() {
        assert_eq!(
            decide_result_status(&result(false, "quality=30,best-effort")),
            FileStatus::BestEffort
        );
    }

    #[test]
    fn decide_result_status_unmet_target_beats_already_under_strategy() {
        assert_eq!(
            decide_result_status(&result(false, "already-under-target")),
            FileStatus::BestEffort
        );
    }

    #[test]
    fn output_file_name_rewrites_heic_to_jpg() {
        assert_eq!(output_file_name("photo.heic"), "photo.jpg");
        assert_eq!(output_file_name("photo.HEIC"), "photo.jpg");
        assert_eq!(output_file_name("photo.heif"), "photo.jpg");
        assert_eq!(output_file_name("photo.HEIF"), "photo.jpg");
    }

    #[test]
    fn output_file_name_rewrites_mov_to_mp4() {
        assert_eq!(output_file_name("clip.mov"), "clip.mp4");
        assert_eq!(output_file_name("clip.MOV"), "clip.mp4");
    }

    #[test]
    fn output_file_name_keeps_non_heic_name() {
        assert_eq!(output_file_name("photo.png"), "photo.png");
        assert_eq!(output_file_name("doc.PDF"), "doc.PDF");
        assert_eq!(output_file_name("clip.mp4"), "clip.mp4");
    }

    #[test]
    fn output_file_name_handles_name_without_extension() {
        assert_eq!(output_file_name("heicfile"), "heicfile");
    }

    #[test]
    fn output_file_name_handles_dot_heic_stem_only_name() {
        assert_eq!(output_file_name(".heic"), ".jpg");
    }

    /// Regression (review round 1): the .mov → .mp4 rewrite used to happen
    /// in VideoProcessor AFTER resolve_output_path had already deduped
    /// "clip.mov", so a pre-existing clip.mp4 was silently clobbered and two
    /// queued files could resolve to the same output. The rewrite happens
    /// here, before collision resolution — the real output name is what gets
    /// deduped.
    #[test]
    fn mov_collision_uses_real_output_name() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("clip.mp4"), b"pre-existing").unwrap();
        std::fs::write(dir.path().join("clip.mov"), b"queued").unwrap();

        let resolved = resolve_output_path(
            dir.path().to_str().unwrap(),
            &output_file_name("clip.mov"),
        );
        assert_eq!(
            resolved.file_name().unwrap(),
            "clip-1.mp4",
            "collision detection must apply to the real mp4 name"
        );
        // Neither queued file may be overwritten at resolve time.
        assert_eq!(
            std::fs::read(dir.path().join("clip.mp4")).unwrap(),
            b"pre-existing".to_vec()
        );
        assert_eq!(
            std::fs::read(dir.path().join("clip.mov")).unwrap(),
            b"queued".to_vec()
        );
    }

    #[test]
    fn mov_name_without_collision_resolves_unchanged() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let resolved = resolve_output_path(
            dir.path().to_str().unwrap(),
            &output_file_name("clip.mov"),
        );
        assert_eq!(resolved.file_name().unwrap(), "clip.mp4");
    }
}
