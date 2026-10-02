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

use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartRecord {
    pub session_id: String,
    pub started_at: i64,
    pub file_count: usize,
    pub output_folder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResultRecord {
    pub session_id: String,
    pub file_id: String,
    pub completed_at: i64,
    pub name: String,
    pub path: String,
    pub output_path: Option<String>,
    pub category: String,
    pub target_bytes: u64,
    pub original_size: u64,
    pub compressed_size: Option<u64>,
    pub status: String,
    pub quality_used: Option<u32>,
    pub strategy_used: Option<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEndRecord {
    pub session_id: String,
    pub ended_at: i64,
    pub total_saved_bytes: u64,
    pub counts: Counts,
    pub cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub done: u32,
    pub best_effort: u32,
    pub failed: u32,
    pub cancelled: u32,
    pub unsupported: u32,
    pub already_under_target: u32,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum HistoryRecordRef<'a> {
    SessionStart(&'a SessionStartRecord),
    File(&'a FileResultRecord),
    SessionEnd(&'a SessionEndRecord),
}

pub struct HistoryStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl HistoryStore {
    pub fn new_in(dir: &Path) -> Self {
        HistoryStore {
            path: dir.join("history.jsonl"),
            lock: Mutex::new(()),
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.path
    }

    pub fn append_session_start(&self, rec: &SessionStartRecord) -> Result<(), String> {
        self.append(HistoryRecordRef::SessionStart(rec))
    }

    pub fn append_file(&self, rec: &FileResultRecord) -> Result<(), String> {
        self.append(HistoryRecordRef::File(rec))
    }

    pub fn append_session_end(&self, rec: &SessionEndRecord) -> Result<(), String> {
        self.append(HistoryRecordRef::SessionEnd(rec))
    }

    pub(crate) fn read_lines(&self) -> Result<Vec<String>, String> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let content = match std::fs::read_to_string(&self.path) {
            Ok(content) => content,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("history read failed: {e}")),
        };
        Ok(content
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect())
    }

    fn append(&self, record: HistoryRecordRef<'_>) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let line =
            serde_json::to_string(&record).map_err(|e| format!("history write failed: {e}"))?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("history write failed: {e}"))?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| format!("history write failed: {e}"))?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|e| format!("history write failed: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn small_end(session_id: &str) -> SessionEndRecord {
        SessionEndRecord {
            session_id: session_id.into(),
            ended_at: 0,
            total_saved_bytes: 0,
            counts: Counts {
                done: 0,
                best_effort: 0,
                failed: 0,
                cancelled: 0,
                unsupported: 0,
                already_under_target: 0,
            },
            cancelled: false,
        }
    }

    #[test]
    fn append_session_start_writes_camel_case_line() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        store
            .append_session_start(&SessionStartRecord {
                session_id: "s1".into(),
                started_at: 1_760_000_000_000,
                file_count: 3,
                output_folder: "/out".into(),
            })
            .unwrap();
        let line = store.read_lines().unwrap().pop().unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "session_start");
        assert_eq!(v["sessionId"], "s1");
        assert_eq!(v["startedAt"], 1_760_000_000_000i64);
        assert_eq!(v["fileCount"], 3);
        assert_eq!(v["outputFolder"], "/out");
    }

    #[test]
    fn append_file_serializes_optional_fields_as_null() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        store
            .append_file(&FileResultRecord {
                session_id: "s1".into(),
                file_id: "f1".into(),
                completed_at: 1_760_000_001_000,
                name: "a.jpg".into(),
                path: "/in/a.jpg".into(),
                output_path: None,
                category: "image".into(),
                target_bytes: 204_800,
                original_size: 1024,
                compressed_size: None,
                status: "cancelled".into(),
                quality_used: None,
                strategy_used: None,
                error: None,
                duration_ms: 0,
            })
            .unwrap();
        let line = store.read_lines().unwrap().pop().unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "file");
        assert!(v["outputPath"].is_null());
        assert!(v["compressedSize"].is_null());
        assert_eq!(v["status"], "cancelled");
    }

    #[test]
    fn append_session_end_writes_counts_and_cancelled() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        store
            .append_session_end(&SessionEndRecord {
                session_id: "s1".into(),
                ended_at: 1_760_000_010_000,
                total_saved_bytes: 4096,
                counts: Counts {
                    done: 2,
                    best_effort: 0,
                    failed: 1,
                    cancelled: 1,
                    unsupported: 0,
                    already_under_target: 0,
                },
                cancelled: true,
            })
            .unwrap();
        let line = store.read_lines().unwrap().pop().unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "session_end");
        assert_eq!(v["counts"]["bestEffort"], 0);
        assert_eq!(v["counts"]["alreadyUnderTarget"], 0);
        assert_eq!(v["cancelled"], true);
    }

    #[test]
    fn read_lines_missing_file_returns_empty() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        assert!(store.read_lines().unwrap().is_empty());
    }

    #[test]
    fn read_lines_skips_blank_lines() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        std::fs::write(store.file_path(), "{\"a\":1}\n\n{\"b\":2}\n").unwrap();
        let lines = store.read_lines().unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "{\"a\":1}");
        assert_eq!(lines[1], "{\"b\":2}");
    }

    #[test]
    fn read_lines_io_error_returns_err() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        std::fs::create_dir(store.file_path()).unwrap();
        assert!(store.read_lines().is_err());
    }

    #[test]
    fn append_creates_parent_directories() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(&dir.path().join("a").join("b"));
        store.append_session_end(&small_end("s1")).unwrap();
        assert!(store.file_path().exists());
    }

    #[test]
    fn append_propagates_write_error() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        std::fs::create_dir(store.file_path()).unwrap();
        let err = store.append_session_end(&small_end("s1")).unwrap_err();
        assert!(err.starts_with("history write failed:"), "{err}");
    }

    #[test]
    fn append_creates_file_and_appends_in_order() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        assert!(!store.file_path().exists());
        store.append_session_end(&small_end("s1")).unwrap();
        store.append_session_end(&small_end("s2")).unwrap();
        let lines = store.read_lines().unwrap();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("\"s1\""));
        assert!(lines[1].contains("\"s2\""));
    }

    #[test]
    fn append_session_end_roundtrips() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let record = SessionEndRecord {
            session_id: "s1".into(),
            ended_at: 42,
            total_saved_bytes: 4096,
            counts: Counts {
                done: 2,
                best_effort: 1,
                failed: 1,
                cancelled: 0,
                unsupported: 0,
                already_under_target: 3,
            },
            cancelled: true,
        };
        store.append_session_end(&record).unwrap();
        let line = store.read_lines().unwrap().pop().unwrap();
        let parsed: SessionEndRecord = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed, record);
    }

    #[test]
    fn concurrent_appends_keep_lines_intact() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let store = &store;
        std::thread::scope(|scope| {
            for t in 0..2 {
                scope.spawn(move || {
                    for i in 0..25 {
                        store
                            .append_session_end(&small_end(&format!("t{t}-{i}")))
                            .unwrap();
                    }
                });
            }
        });
        let lines = store.read_lines().unwrap();
        assert_eq!(lines.len(), 50);
        for line in &lines {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            assert_eq!(v["type"], "session_end");
        }
    }
}
