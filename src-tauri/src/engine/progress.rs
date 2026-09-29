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
