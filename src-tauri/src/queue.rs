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

use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tauri::{AppHandle, Emitter, Manager};
use crate::commands::FileListState;
use crate::engine::{CompressionResult, CompressionError, ProgressSender, STRATEGY_ALREADY_UNDER_TARGET};
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
    } else if result.strategy_used == STRATEGY_ALREADY_UNDER_TARGET {
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

        // Preflight: the output folder must be writable before the batch starts
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

            let entry: Option<FileEntry> = {
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
        assert_eq!(output_file_name("heicfile"), "heicfile");
    }
}
