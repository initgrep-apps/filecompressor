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
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{LockResult, Mutex, MutexGuard};

fn poison_recover<T>(lock: LockResult<MutexGuard<'_, T>>) -> MutexGuard<'_, T> {
    lock.unwrap_or_else(|e| {
        eprintln!("warn: history mutex was poisoned, recovering: {e}");
        e.into_inner()
    })
}

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

    pub fn append_session_start(&self, record: &SessionStartRecord) -> Result<(), String> {
        self.append(HistoryRecordRef::SessionStart(record))
    }

    pub fn append_file(&self, record: &FileResultRecord) -> Result<(), String> {
        self.append(HistoryRecordRef::File(record))
    }

    pub fn append_session_end(&self, record: &SessionEndRecord) -> Result<(), String> {
        self.append(HistoryRecordRef::SessionEnd(record))
    }

    pub(crate) fn read_lines(&self) -> Result<Vec<String>, String> {
        let _guard = poison_recover(self.lock.lock());
        let bytes = match std::fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(format!(
                    "history read failed: read {}: {e}",
                    self.path.display()
                ))
            }
        };
        Ok(bytes
            .split(|b| *b == b'\n')
            .map(|line| String::from_utf8_lossy(line).trim().to_string())
            .filter(|line| !line.is_empty())
            .collect())
    }

    fn append(&self, record: HistoryRecordRef<'_>) -> Result<(), String> {
        let _guard = poison_recover(self.lock.lock());
        let path = self.path.display();
        let line = serde_json::to_string(&record)
            .map_err(|e| format!("history write failed: serialize record for {path}: {e}"))?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!(
                    "history write failed: create parent dir {} for {path}: {e}",
                    parent.display()
                )
            })?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .read(true)
            .open(&self.path)
            .map_err(|e| format!("history write failed: open {path}: {e}"))?;
        let mut buf = Vec::with_capacity(line.len() + 2);
        if file.metadata().map(|m| m.len()).unwrap_or(0) > 0 {
            let mut last = [0u8; 1];
            let ends_with_newline = file
                .seek(SeekFrom::End(-1))
                .and_then(|_| file.read_exact(&mut last))
                .map(|_| last[0] == b'\n')
                .unwrap_or(false);
            if !ends_with_newline {
                buf.push(b'\n');
            }
        }
        buf.extend_from_slice(line.as_bytes());
        buf.push(b'\n');
        file.write_all(&buf)
            .map_err(|e| format!("history write failed: write {path}: {e}"))
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
        assert!(v["qualityUsed"].is_null());
        assert!(v["strategyUsed"].is_null());
        assert!(v["error"].is_null());
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
        let err = store.read_lines().unwrap_err();
        assert!(err.starts_with("history read failed:"), "{err}");
        assert!(err.starts_with("history read failed: read "), "{err}");
        assert!(
            err.contains(&store.file_path().display().to_string()),
            "{err}"
        );
    }

    #[test]
    fn append_creates_parent_directories() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(&dir.path().join("a").join("b"));
        store.append_session_end(&small_end("s1")).unwrap();
        assert!(store.file_path().exists());
        assert_eq!(
            store.file_path(),
            dir.path()
                .join("a")
                .join("b")
                .join("history.jsonl")
                .as_path()
        );
    }

    #[test]
    fn append_propagates_write_error() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        std::fs::create_dir(store.file_path()).unwrap();
        let err = store.append_session_end(&small_end("s1")).unwrap_err();
        assert!(err.starts_with("history write failed:"), "{err}");
        assert!(
            err.contains(&store.file_path().display().to_string()),
            "{err}"
        );
    }

    #[test]
    fn append_repairs_missing_trailing_newline() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let partial = b"{\"type\":\"session_end\",\"sessionId\":\"torn";
        std::fs::write(store.file_path(), partial).unwrap();

        store.append_session_end(&small_end("s2")).unwrap();

        let lines = store.read_lines().unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], String::from_utf8_lossy(partial));
        let parsed: SessionEndRecord = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(parsed.session_id, "s2");

        let mut expected = partial.to_vec();
        expected.push(b'\n');
        expected.extend_from_slice(lines[1].as_bytes());
        expected.push(b'\n');
        assert_eq!(std::fs::read(store.file_path()).unwrap(), expected);
    }

    #[test]
    fn append_writes_single_terminated_line() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());

        store.append_session_end(&small_end("s1")).unwrap();
        let raw = std::fs::read(store.file_path()).unwrap();
        assert!(raw.ends_with(b"\n"));
        assert_eq!(raw.iter().rev().take_while(|b| **b == b'\n').count(), 1);
        assert_ne!(raw[0], b'\n');

        store.append_session_end(&small_end("s2")).unwrap();
        let raw = std::fs::read(store.file_path()).unwrap();
        assert_eq!(raw.iter().filter(|b| **b == b'\n').count(), 2);
        assert!(!raw.ends_with(b"\n\n"));
        assert_eq!(store.read_lines().unwrap().len(), 2);
    }

    #[test]
    fn read_lines_tolerates_invalid_utf8_bytes() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"{\"a\":1}\n");
        bytes.extend_from_slice(&[0xff, 0xfe, 0x80]);
        bytes.extend_from_slice(b"\n");
        bytes.extend_from_slice(b"{\"b\":2}\n");
        std::fs::write(store.file_path(), bytes).unwrap();

        let lines = store.read_lines().unwrap();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "{\"a\":1}");
        assert!(!lines[1].is_empty());
        assert_eq!(lines[2], "{\"b\":2}");
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
        let first: SessionEndRecord = serde_json::from_str(&lines[0]).unwrap();
        let second: SessionEndRecord = serde_json::from_str(&lines[1]).unwrap();
        assert_eq!(first.session_id, "s1");
        assert_eq!(second.session_id, "s2");
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
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            for t in 0..2 {
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    for i in 0..25 {
                        let mut record = small_end(&format!("t{t}-{i}"));
                        record.session_id = format!("t{t}-{i}-{}", "x".repeat(8192));
                        store.append_session_end(&record).unwrap();
                    }
                });
            }
        });
        let lines = store.read_lines().unwrap();
        assert_eq!(lines.len(), 50);
        let mut ids = std::collections::HashSet::new();
        for line in &lines {
            let parsed: SessionEndRecord = serde_json::from_str(line).unwrap();
            assert!(parsed.session_id.len() > 8192);
            ids.insert(parsed.session_id);
        }
        for t in 0..2 {
            for i in 0..25 {
                let expected = format!("t{t}-{i}-{}", "x".repeat(8192));
                assert!(ids.contains(&expected), "missing {t}-{i}");
            }
        }
        assert_eq!(ids.len(), 50);
    }

    #[test]
    fn read_during_write_never_sees_torn_line() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let stop = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                for i in 0..100 {
                    let mut record = small_end(&format!("w-{i}"));
                    record.session_id = format!("w-{i}-{}", "y".repeat(8192));
                    store.append_session_end(&record).unwrap();
                }
                stop.store(true, std::sync::atomic::Ordering::SeqCst);
            });
            while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                for line in store.read_lines().unwrap() {
                    serde_json::from_str::<serde_json::Value>(&line).unwrap();
                }
            }
        });
        for line in store.read_lines().unwrap() {
            serde_json::from_str::<serde_json::Value>(&line).unwrap();
        }
    }

    #[test]
    fn record_schema_keys_are_pinned() {
        let start = serde_json::to_value(HistoryRecordRef::SessionStart(&SessionStartRecord {
            session_id: "s1".into(),
            started_at: 1,
            file_count: 0,
            output_folder: "/out".into(),
        }))
        .unwrap();
        let mut start_keys: Vec<String> = start.as_object().unwrap().keys().cloned().collect();
        start_keys.sort();
        assert_eq!(
            start_keys,
            vec![
                "fileCount",
                "outputFolder",
                "sessionId",
                "startedAt",
                "type",
            ]
        );

        let file = serde_json::to_value(HistoryRecordRef::File(&FileResultRecord {
            session_id: "s1".into(),
            file_id: "f1".into(),
            completed_at: 1,
            name: "a.jpg".into(),
            path: "/in/a.jpg".into(),
            output_path: None,
            category: "image".into(),
            target_bytes: 1,
            original_size: 1,
            compressed_size: None,
            status: "done".into(),
            quality_used: None,
            strategy_used: None,
            error: None,
            duration_ms: 0,
        }))
        .unwrap();
        let mut file_keys: Vec<String> = file.as_object().unwrap().keys().cloned().collect();
        file_keys.sort();
        assert_eq!(
            file_keys,
            vec![
                "category",
                "completedAt",
                "compressedSize",
                "durationMs",
                "error",
                "fileId",
                "name",
                "originalSize",
                "outputPath",
                "path",
                "qualityUsed",
                "sessionId",
                "status",
                "strategyUsed",
                "targetBytes",
                "type",
            ]
        );

        let end = serde_json::to_value(HistoryRecordRef::SessionEnd(&small_end("s1"))).unwrap();
        let mut end_keys: Vec<String> = end.as_object().unwrap().keys().cloned().collect();
        end_keys.sort();
        assert_eq!(
            end_keys,
            vec![
                "cancelled",
                "counts",
                "endedAt",
                "sessionId",
                "totalSavedBytes",
                "type",
            ]
        );
        let mut counts_keys: Vec<String> =
            end["counts"].as_object().unwrap().keys().cloned().collect();
        counts_keys.sort();
        assert_eq!(
            counts_keys,
            vec![
                "alreadyUnderTarget",
                "bestEffort",
                "cancelled",
                "done",
                "failed",
                "unsupported",
            ]
        );
    }

    #[test]
    fn append_and_read_roundtrip_unicode_paths() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let file = FileResultRecord {
            session_id: "séance-漢字-😀".into(),
            file_id: "f1".into(),
            completed_at: 1,
            name: "café-漢字-😀.jpg".into(),
            path: "/in/café/漢字/😀.jpg".into(),
            output_path: Some("/out/café/漢字/😀.jpg".into()),
            category: "image".into(),
            target_bytes: 1,
            original_size: 1,
            compressed_size: None,
            status: "failed".into(),
            quality_used: None,
            strategy_used: None,
            error: Some("échec: 漢字 😀".into()),
            duration_ms: 0,
        };
        store.append_file(&file).unwrap();
        let line = store.read_lines().unwrap().pop().unwrap();
        let parsed: FileResultRecord = serde_json::from_str(&line).unwrap();
        assert_eq!(parsed.path, file.path);
        assert_eq!(parsed.output_path, file.output_path);
        assert_eq!(parsed.error, file.error);
        assert_eq!(parsed.name, file.name);
        assert_eq!(parsed.session_id, file.session_id);
    }
}
