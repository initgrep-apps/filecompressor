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

use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub(crate) fn progress_payload(file_id: &str, percent: u32) -> serde_json::Value {
    serde_json::json!({ "fileId": file_id, "percent": percent })
}

#[derive(Clone)]
pub struct ProgressSender {
    emit: Arc<dyn Fn(u32) + Send + Sync>,
}

impl ProgressSender {
    pub fn new(app: AppHandle, file_id: String) -> Self {
        Self::new_with_emitter(Arc::new(move |percent| {
            // Event-emit failures are non-actionable: serialization is
            // infallible for the fixed two-field payload; a missing listener
            // is normal in early lifecycle.
            let _ = app.emit("file:progress", progress_payload(&file_id, percent));
        }))
    }

    pub(crate) fn new_with_emitter(emitter: Arc<dyn Fn(u32) + Send + Sync>) -> Self {
        ProgressSender { emit: emitter }
    }

    #[cfg(test)]
    pub fn test_stub() -> Self {
        Self::new_with_emitter(Arc::new(|_| {}))
    }

    pub fn send_progress(&self, percent: u32) {
        (self.emit)(percent.clamp(0, 100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_with_emitter_passes_percent_through() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let sender = ProgressSender::new_with_emitter(Arc::new(move |percent| {
            sink.lock().unwrap().push(percent);
        }));
        sender.send_progress(0);
        sender.send_progress(45);
        sender.send_progress(100);
        assert_eq!(*seen.lock().unwrap(), vec![0, 45, 100]);
    }

    #[test]
    fn send_progress_clamps_out_of_range_values() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let sender = ProgressSender::new_with_emitter(Arc::new(move |percent| {
            sink.lock().unwrap().push(percent);
        }));
        sender.send_progress(150);
        sender.send_progress(7);
        assert_eq!(*seen.lock().unwrap(), vec![100, 7]);
    }

    #[test]
    fn progress_payload_uses_camel_case_file_id_key() {
        let payload = progress_payload("abc-123", 72);
        assert_eq!(
            payload["fileId"], "abc-123",
            "payload key must be camelCase fileId"
        );
        assert!(
            payload.get("file_id").is_none(),
            "snake_case key would break the TS hook"
        );
        assert_eq!(payload["percent"], 72);
    }
}
