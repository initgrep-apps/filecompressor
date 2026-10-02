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
use std::collections::HashMap;
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryFile {
    pub name: String,
    pub path: String,
    pub output_path: Option<PathBuf>,
    pub category: String,
    pub target_bytes: u64,
    pub original_size: u64,
    pub compressed_size: Option<u64>,
    pub status: String,
    pub quality_used: Option<u32>,
    pub strategy_used: Option<String>,
    pub error: Option<String>,
    pub duration_ms: u64,
    pub completed_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySession {
    pub session_id: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub output_folder: String,
    pub file_count: usize,
    pub files: Vec<HistoryFile>,
    pub outcome: Counts,
    pub total_saved_bytes: u64,
    pub cancelled: bool,
    pub interrupted: bool,
    pub matched_files: Option<usize>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FoldResult {
    pub sessions: Vec<HistorySession>,
    pub skipped_lines: usize,
}

fn history_file_from(record: &FileResultRecord) -> HistoryFile {
    HistoryFile {
        name: record.name.clone(),
        path: record.path.clone(),
        output_path: record.output_path.as_ref().map(PathBuf::from),
        category: record.category.clone(),
        target_bytes: record.target_bytes,
        original_size: record.original_size,
        compressed_size: record.compressed_size,
        status: record.status.clone(),
        quality_used: record.quality_used,
        strategy_used: record.strategy_used.clone(),
        error: record.error.clone(),
        duration_ms: record.duration_ms,
        completed_at: record.completed_at,
    }
}

fn saved_for(file: &HistoryFile) -> u64 {
    match file.compressed_size {
        Some(compressed) => file.original_size.saturating_sub(compressed),
        None => 0,
    }
}

fn outcome_from_files(files: &[HistoryFile]) -> Counts {
    let mut counts = Counts::default();
    for file in files {
        match file.status.as_str() {
            "done" => counts.done += 1,
            "best_effort" => counts.best_effort += 1,
            "failed" => counts.failed += 1,
            "cancelled" => counts.cancelled += 1,
            "unsupported" => counts.unsupported += 1,
            "already_under_target" => counts.already_under_target += 1,
            other => eprintln!("warn: history file has unknown status: {other}"),
        }
    }
    counts
}

fn parse_or_skip<T: serde::de::DeserializeOwned>(line: &str, kind: &str) -> Option<T> {
    match serde_json::from_str(line) {
        Ok(parsed) => Some(parsed),
        Err(e) => {
            eprintln!("warn: history fold skipped invalid {kind} record: {e}");
            None
        }
    }
}

pub fn fold_records(lines: &[String]) -> FoldResult {
    let mut sessions: Vec<HistorySession> = Vec::new();
    let mut session_index: HashMap<String, usize> = HashMap::new();
    let mut file_indexes: Vec<HashMap<String, usize>> = Vec::new();
    let mut skipped_lines = 0usize;

    for line in lines {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(e) => {
                eprintln!("warn: history fold skipped malformed line: {e}");
                skipped_lines += 1;
                continue;
            }
        };
        let Some(kind) = value.get("type").and_then(|t| t.as_str()) else {
            eprintln!("warn: history fold skipped line without a string \"type\"");
            skipped_lines += 1;
            continue;
        };
        match kind {
            "session_start" => {
                let Some(record) = parse_or_skip::<SessionStartRecord>(line, "session_start")
                else {
                    skipped_lines += 1;
                    continue;
                };
                match session_index.get(&record.session_id).copied() {
                    Some(index) => {
                        let session = &mut sessions[index];
                        session.started_at = record.started_at;
                        session.output_folder = record.output_folder;
                        session.file_count = record.file_count;
                    }
                    None => {
                        session_index.insert(record.session_id.clone(), sessions.len());
                        file_indexes.push(HashMap::new());
                        sessions.push(HistorySession {
                            session_id: record.session_id,
                            started_at: record.started_at,
                            ended_at: None,
                            output_folder: record.output_folder,
                            file_count: record.file_count,
                            files: Vec::new(),
                            outcome: Counts::default(),
                            total_saved_bytes: 0,
                            cancelled: false,
                            interrupted: false,
                            matched_files: None,
                        });
                    }
                }
            }
            "file" => {
                let Some(record) = parse_or_skip::<FileResultRecord>(line, "file") else {
                    skipped_lines += 1;
                    continue;
                };
                let Some(index) = session_index.get(&record.session_id).copied() else {
                    skipped_lines += 1;
                    continue;
                };
                if sessions[index].ended_at.is_some() {
                    eprintln!(
                        "warn: history fold skipped file record after session_end: {}",
                        record.file_id
                    );
                    skipped_lines += 1;
                    continue;
                }
                let history_file = history_file_from(&record);
                match file_indexes[index].get(&record.file_id).copied() {
                    Some(file_index) => sessions[index].files[file_index] = history_file,
                    None => {
                        let position = sessions[index].files.len();
                        file_indexes[index].insert(record.file_id, position);
                        sessions[index].files.push(history_file);
                    }
                }
            }
            "session_end" => {
                let Some(record) = parse_or_skip::<SessionEndRecord>(line, "session_end") else {
                    skipped_lines += 1;
                    continue;
                };
                let Some(index) = session_index.get(&record.session_id).copied() else {
                    skipped_lines += 1;
                    continue;
                };
                let session = &mut sessions[index];
                session.ended_at = Some(record.ended_at);
                session.total_saved_bytes = record.total_saved_bytes;
                session.cancelled = record.cancelled;
                session.outcome = record.counts;
            }
            _ => {}
        }
    }

    for session in &mut sessions {
        if session.ended_at.is_none() {
            session.interrupted = true;
            session.outcome = outcome_from_files(&session.files);
            session.total_saved_bytes = session
                .files
                .iter()
                .map(saved_for)
                .fold(0u64, u64::saturating_add);
        }
        session.files.sort_by_key(|file| file.completed_at);
    }
    sessions.sort_by_key(|session| std::cmp::Reverse(session.started_at));

    FoldResult {
        sessions,
        skipped_lines,
    }
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

    pub(crate) fn file_path(&self) -> &Path {
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
        let path = self.path.display();
        Ok(bytes
            .split(|b| *b == b'\n')
            .map(|line| {
                if let Err(e) = std::str::from_utf8(line) {
                    eprintln!("warn: history line had invalid UTF-8, lossy-decoded ({path}): {e}");
                }
                String::from_utf8_lossy(line).trim().to_string()
            })
            .filter(|line| !line.is_empty())
            .collect())
    }

    pub fn load(&self) -> Result<FoldResult, String> {
        Ok(fold_records(&self.read_lines()?))
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
        let len = file
            .seek(SeekFrom::End(0))
            .map_err(|e| format!("history write failed: seek {path}: {e}"))?;
        let mut buf = Vec::with_capacity(line.len() + 2);
        if len > 0 {
            let mut last = [0u8; 1];
            let ends_with_newline = match file
                .seek(SeekFrom::End(-1))
                .and_then(|_| file.read_exact(&mut last))
            {
                Ok(()) => last[0] == b'\n',
                Err(e) => {
                    eprintln!(
                        "warn: history append newline probe {path} failed, inserting separator: {e}"
                    );
                    false
                }
            };
            if !ends_with_newline {
                buf.push(b'\n');
            }
        }
        buf.extend_from_slice(line.as_bytes());
        buf.push(b'\n');
        write_terminated(&mut file, &buf, &self.path)
    }
}

fn write_terminated(file: &mut std::fs::File, buf: &[u8], path: &Path) -> Result<(), String> {
    file.write_all(buf)
        .map_err(|e| format!("history write failed: write {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn small_end(session_id: &str) -> SessionEndRecord {
        big_end(session_id.into())
    }

    fn big_end(session_id: String) -> SessionEndRecord {
        SessionEndRecord {
            session_id,
            ended_at: 0,
            total_saved_bytes: 0,
            counts: Counts::default(),
            cancelled: false,
        }
    }

    fn sorted_keys(value: &serde_json::Value) -> Vec<String> {
        let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        keys
    }

    fn line(value: serde_json::Value) -> String {
        value.to_string()
    }

    fn start(sid: &str, at: i64) -> serde_json::Value {
        serde_json::json!({
            "type": "session_start", "sessionId": sid, "startedAt": at,
            "fileCount": 1, "outputFolder": "/out"
        })
    }

    fn file(
        sid: &str,
        fid: &str,
        at: i64,
        status: &str,
        sizes: (u64, Option<u64>),
    ) -> serde_json::Value {
        serde_json::json!({
            "type": "file", "sessionId": sid, "fileId": fid, "completedAt": at,
            "name": "a.jpg", "path": "/in/a.jpg", "outputPath": "/out/a.jpg",
            "category": "image", "targetBytes": 1024,
            "originalSize": sizes.0, "compressedSize": sizes.1,
            "status": status, "qualityUsed": 70, "strategyUsed": "quality=70",
            "error": null, "durationMs": 12
        })
    }

    fn end(sid: &str, at: i64) -> serde_json::Value {
        serde_json::json!({
            "type": "session_end", "sessionId": sid, "endedAt": at,
            "totalSavedBytes": 100,
            "counts": { "done": 1, "bestEffort": 0, "failed": 0, "cancelled": 0,
                        "unsupported": 0, "alreadyUnderTarget": 0 },
            "cancelled": false
        })
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
            dir.path().join("a").join("b").join("history.jsonl")
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
    fn append_parent_is_file_surfaces_create_stage_error() {
        let dir = tempdir().unwrap();
        let blocker = dir.path().join("blocker.txt");
        std::fs::write(&blocker, b"x").unwrap();
        let store = HistoryStore::new_in(&blocker.join("child"));
        let err = store.append_session_end(&small_end("s1")).unwrap_err();
        assert!(
            err.starts_with("history write failed: create parent dir "),
            "{err}"
        );
        assert!(
            err.contains(&store.file_path().display().to_string()),
            "{err}"
        );
    }

    #[test]
    fn write_failure_surfaces_write_stage_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("history.jsonl");
        std::fs::write(&path, "").unwrap();
        let mut file = std::fs::File::open(&path).unwrap();
        let err = write_terminated(&mut file, b"{\"a\":1}\n", &path).unwrap_err();
        assert!(err.starts_with("history write failed: write "), "{err}");
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
                        store
                            .append_session_end(&big_end(format!("t{t}-{i}-{}", "x".repeat(8192))))
                            .unwrap();
                    }
                });
            }
        });
        let lines = store.read_lines().unwrap();
        assert_eq!(lines.len(), 50);
        let mut ids = std::collections::HashSet::new();
        for line in &lines {
            let parsed: SessionEndRecord = serde_json::from_str(line).unwrap();
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

    struct StopGuard<'a>(&'a std::sync::atomic::AtomicBool);

    impl Drop for StopGuard<'_> {
        fn drop(&mut self) {
            self.0.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    #[test]
    fn read_during_write_never_sees_torn_line() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let stop = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let _guard = StopGuard(&stop);
                for i in 0..100 {
                    store
                        .append_session_end(&big_end(format!("w-{i}-{}", "y".repeat(8192))))
                        .unwrap();
                }
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
    fn append_blocks_until_lock_released() {
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let store = &store;
        let guard = store.lock.lock().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let handle = scope.spawn(move || {
                started_tx.send(()).unwrap();
                store.append_session_end(&small_end("s1")).unwrap();
                done_tx.send(()).unwrap();
            });
            started_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("worker thread never reached append");
            assert!(
                done_rx.recv_timeout(Duration::from_millis(150)).is_err(),
                "append completed while the store lock was held"
            );
            drop(guard);
            assert!(done_rx.recv_timeout(Duration::from_secs(5)).is_ok());
            handle.join().unwrap();
        });
        let lines = store.read_lines().unwrap();
        assert_eq!(lines.len(), 1);
        let parsed: SessionEndRecord = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(parsed.session_id, "s1");
    }

    #[test]
    fn read_lines_blocks_until_lock_released() {
        use std::sync::mpsc;
        use std::time::Duration;

        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        std::fs::write(store.file_path(), "{\"a\":1}\n").unwrap();
        let store = &store;
        let guard = store.lock.lock().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            let handle = scope.spawn(move || {
                started_tx.send(()).unwrap();
                let lines = store.read_lines().unwrap();
                done_tx.send(lines).unwrap();
            });
            started_rx
                .recv_timeout(Duration::from_secs(5))
                .expect("worker thread never reached read_lines");
            assert!(
                done_rx.recv_timeout(Duration::from_millis(150)).is_err(),
                "read_lines completed while the store lock was held"
            );
            drop(guard);
            let lines = done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(lines, vec!["{\"a\":1}".to_string()]);
            handle.join().unwrap();
        });
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
        assert_eq!(
            sorted_keys(&start),
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
        assert_eq!(
            sorted_keys(&file),
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
        assert_eq!(
            sorted_keys(&end),
            vec![
                "cancelled",
                "counts",
                "endedAt",
                "sessionId",
                "totalSavedBytes",
                "type",
            ]
        );
        assert_eq!(
            sorted_keys(&end["counts"]),
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
        assert_eq!(parsed, file);
    }

    #[test]
    fn fold_single_complete_session() {
        let lines = vec![
            line(start("s1", 100)),
            line(file("s1", "f1", 110, "done", (500, Some(100)))),
            line(end("s1", 120)),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.skipped_lines, 0);
        assert_eq!(out.sessions.len(), 1);
        let s = &out.sessions[0];
        assert_eq!(s.session_id, "s1");
        assert_eq!(s.started_at, 100);
        assert_eq!(s.ended_at, Some(120));
        assert_eq!(s.output_folder, "/out");
        assert!(!s.cancelled);
        assert!(!s.interrupted);
        assert_eq!(s.total_saved_bytes, 100);
        assert_eq!(s.outcome.done, 1);
        assert_eq!(s.file_count, 1);
        assert_eq!(s.matched_files, None);
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0].quality_used, Some(70));
        assert_eq!(s.files[0].output_path, Some(PathBuf::from("/out/a.jpg")));
    }

    #[test]
    fn fold_uses_session_end_values_verbatim() {
        let mut end_record = end("s1", 120);
        end_record["counts"] = serde_json::json!({
            "done": 0, "bestEffort": 2, "failed": 0,
            "cancelled": 0, "unsupported": 0, "alreadyUnderTarget": 0
        });
        let lines = vec![
            line(start("s1", 100)),
            line(file("s1", "f1", 110, "done", (500, Some(100)))),
            line(end_record),
        ];
        let out = fold_records(&lines);
        let s = &out.sessions[0];
        assert_eq!(
            s.total_saved_bytes, 100,
            "end totalSavedBytes wins over file-derived 400"
        );
        assert_eq!(
            s.outcome.best_effort, 2,
            "counts come verbatim from the end record"
        );
        assert_eq!(s.outcome.done, 0);
    }

    #[test]
    fn fold_missing_session_end_is_interrupted() {
        let lines = vec![
            line(start("s1", 10)),
            line(file("s1", "f1", 11, "done", (5, Some(1)))),
        ];
        let out = fold_records(&lines);
        assert!(out.sessions[0].interrupted);
        assert_eq!(out.sessions[0].ended_at, None);
        assert_eq!(out.sessions[0].total_saved_bytes, 4);
    }

    #[test]
    fn fold_interrupted_computes_all_six_status_counts() {
        let lines = vec![
            line(start("s1", 10)),
            line(file("s1", "f1", 11, "done", (10, Some(1)))),
            line(file("s1", "f2", 12, "best_effort", (10, Some(2)))),
            line(file("s1", "f3", 13, "failed", (10, None))),
            line(file("s1", "f4", 14, "cancelled", (10, None))),
            line(file("s1", "f5", 15, "unsupported", (10, None))),
            line(file("s1", "f6", 16, "already_under_target", (10, None))),
        ];
        let out = fold_records(&lines);
        let s = &out.sessions[0];
        assert!(s.interrupted);
        assert_eq!(s.outcome.done, 1);
        assert_eq!(s.outcome.best_effort, 1);
        assert_eq!(s.outcome.failed, 1);
        assert_eq!(s.outcome.cancelled, 1);
        assert_eq!(s.outcome.unsupported, 1);
        assert_eq!(s.outcome.already_under_target, 1);
        assert_eq!(s.total_saved_bytes, 9 + 8);
    }

    #[test]
    fn fold_session_end_cancelled_flag() {
        let mut end_record = end("s1", 120);
        end_record["cancelled"] = serde_json::json!(true);
        let lines = vec![line(start("s1", 100)), line(end_record)];
        let out = fold_records(&lines);
        assert!(out.sessions[0].cancelled);
    }

    #[test]
    fn fold_orders_sessions_newest_first_and_files_by_time() {
        let lines = vec![
            line(start("old", 10)),
            line(file("old", "f1", 11, "done", (1, Some(1)))),
            line(start("new", 99)),
            line(file("new", "b", 105, "done", (1, Some(1)))),
            line(file("new", "a", 101, "done", (1, Some(1)))),
            line(end("new", 106)),
        ];
        let out = fold_records(&lines);
        let ids: Vec<&str> = out.sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, vec!["new", "old"]);
        let files = &out.sessions[0].files;
        assert_eq!(files.len(), 2);
        assert!(files[0].completed_at <= files[1].completed_at);
    }

    #[test]
    fn fold_repeated_session_start_last_wins() {
        let mut second = start("s1", 20);
        second["outputFolder"] = serde_json::json!("/out2");
        second["fileCount"] = serde_json::json!(7);
        let lines = vec![
            line(start("s1", 10)),
            line(file("s1", "f1", 11, "done", (5, Some(1)))),
            line(end("s1", 12)),
            line(second),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.sessions.len(), 1);
        let s = &out.sessions[0];
        assert_eq!(s.started_at, 20);
        assert_eq!(s.output_folder, "/out2");
        assert_eq!(s.file_count, 7);
        assert_eq!(s.files.len(), 1, "prior files retained");
        assert_eq!(s.files[0].name, "a.jpg");
        assert_eq!(
            s.ended_at,
            Some(12),
            "end recorded before restart preserved"
        );
        assert_eq!(s.total_saved_bytes, 100);
    }

    #[test]
    fn fold_skips_malformed_counts_them_and_ignores_unknown_types() {
        let lines = vec![
            "not json".to_string(),
            line(serde_json::json!({ "type": "future_record", "sessionId": "x" })),
            line(serde_json::json!({ "type": "file", "sessionId": "s1" })),
            line(start("s1", 10)),
        ];
        let out = fold_records(&lines);
        assert_eq!(
            out.skipped_lines, 2,
            "malformed and typed-invalid counted; unknown type ignored silently"
        );
        assert_eq!(out.sessions.len(), 1);
        assert!(out.sessions[0].files.is_empty());
    }

    #[test]
    fn fold_counts_non_object_and_non_string_type_lines() {
        let lines = vec![
            "[]".to_string(),
            "123".to_string(),
            "\"str\"".to_string(),
            "null".to_string(),
            "{}".to_string(),
            line(serde_json::json!({ "type": 123 })),
            line(serde_json::json!({ "type": null })),
            line(serde_json::json!({ "type": "future_record" })),
            line(start("s1", 10)),
        ];
        let out = fold_records(&lines);
        assert_eq!(
            out.skipped_lines, 7,
            "non-record lines counted as malformed"
        );
        assert_eq!(out.sessions.len(), 1);
    }

    #[test]
    fn fold_file_after_session_end_is_skipped_and_counted() {
        let lines = vec![
            line(start("s1", 10)),
            line(end("s1", 12)),
            line(file("s1", "f1", 13, "done", (5, Some(1)))),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.skipped_lines, 1);
        let s = &out.sessions[0];
        assert!(s.files.is_empty(), "post-end file record not added");
        assert_eq!(s.outcome.done, 1, "end-derived outcome stays frozen");
        assert_eq!(s.total_saved_bytes, 100, "end-derived total stays frozen");
    }

    #[test]
    fn fold_orphan_file_lines_are_skipped() {
        let lines = vec![line(file("nobody", "f1", 11, "done", (5, Some(1))))];
        let out = fold_records(&lines);
        assert_eq!(out.sessions.len(), 0);
        assert_eq!(out.skipped_lines, 1);
    }

    #[test]
    fn fold_orphan_session_end_is_skipped() {
        let lines = vec![line(end("nobody", 11))];
        let out = fold_records(&lines);
        assert_eq!(out.sessions.len(), 0);
        assert_eq!(out.skipped_lines, 1);
    }

    #[test]
    fn fold_duplicate_file_id_last_wins() {
        let lines = vec![
            line(start("s1", 10)),
            line(file("s1", "f1", 11, "failed", (5, None))),
            line(file("s1", "f1", 12, "done", (5, Some(1)))),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.sessions[0].files.len(), 1);
        assert_eq!(out.sessions[0].files[0].status, "done");
    }

    #[test]
    fn fold_saturates_when_compressed_exceeds_original() {
        let lines = vec![
            line(start("s1", 10)),
            line(file("s1", "f1", 11, "done", (5, Some(10)))),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.sessions[0].total_saved_bytes, 0);
    }

    #[test]
    fn fold_interrupted_saturates_total_saved() {
        let lines = vec![
            line(start("s1", 10)),
            line(file("s1", "f1", 11, "done", (0, Some(u64::MAX)))),
            line(file("s1", "f2", 12, "done", (u64::MAX, Some(0)))),
            line(file("s1", "f3", 13, "done", (u64::MAX, Some(0)))),
        ];
        let out = fold_records(&lines);
        assert_eq!(
            out.sessions[0].total_saved_bytes,
            u64::MAX,
            "saturating_add clamps the sum instead of panicking"
        );
    }

    #[test]
    fn fold_interrupted_flag_matches_ended_at_biconditional() {
        let complete = fold_records(&[line(start("s1", 10)), line(end("s1", 12))]);
        let s = &complete.sessions[0];
        assert_eq!(s.interrupted, s.ended_at.is_none());

        let interrupted = fold_records(&[line(start("s2", 10))]);
        let s = &interrupted.sessions[0];
        assert_eq!(s.interrupted, s.ended_at.is_none());
        assert!(s.interrupted);
    }

    #[test]
    fn fold_output_serde_keys_are_pinned() {
        let lines = vec![
            line(start("s1", 100)),
            line(file("s1", "f1", 110, "done", (500, Some(100)))),
            line(end("s1", 120)),
        ];
        let out = fold_records(&lines);
        let value = serde_json::to_value(&out.sessions[0]).unwrap();
        for key in [
            "sessionId",
            "startedAt",
            "endedAt",
            "outputFolder",
            "fileCount",
            "files",
            "outcome",
            "totalSavedBytes",
            "cancelled",
            "interrupted",
            "matchedFiles",
        ] {
            assert!(value.get(key).is_some(), "missing top-level key {key}");
        }
        assert_eq!(value["endedAt"], 120);
        assert!(value["matchedFiles"].is_null());
        let file = &value["files"][0];
        for key in [
            "outputPath",
            "completedAt",
            "qualityUsed",
            "strategyUsed",
            "durationMs",
        ] {
            assert!(file.get(key).is_some(), "missing file key {key}");
        }
        assert_eq!(file["outputPath"], "/out/a.jpg");
        assert!(file["outputPath"].is_string());
        assert_eq!(file["completedAt"], 110);
        assert_eq!(file["qualityUsed"], 70);
        assert_eq!(file["strategyUsed"], "quality=70");
        assert_eq!(file["durationMs"], 12);
    }

    #[test]
    fn fold_tolerates_absent_optional_keys() {
        let minimal = serde_json::json!({
            "type": "file", "sessionId": "s1", "fileId": "f1", "completedAt": 11,
            "name": "a.jpg", "path": "/in/a.jpg", "category": "image",
            "targetBytes": 1024, "originalSize": 5, "status": "failed", "durationMs": 0
        });
        let lines = vec![line(start("s1", 10)), line(minimal)];
        let out = fold_records(&lines);
        assert_eq!(out.skipped_lines, 0);
        assert_eq!(out.sessions[0].files.len(), 1);
        let f = &out.sessions[0].files[0];
        assert_eq!(f.output_path, None);
        assert_eq!(f.compressed_size, None);
        assert_eq!(f.quality_used, None);
        assert_eq!(f.strategy_used, None);
        assert_eq!(f.error, None);
    }

    #[test]
    fn fold_zero_file_interrupted_session_still_appears() {
        let lines = vec![line(start("s1", 10))];
        let out = fold_records(&lines);
        assert_eq!(out.sessions.len(), 1);
        assert!(out.sessions[0].files.is_empty());
        assert!(out.sessions[0].interrupted);
        assert_eq!(out.sessions[0].ended_at, None);
        assert_eq!(out.sessions[0].outcome, Counts::default());
    }

    #[test]
    fn load_roundtrips_through_file() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        store
            .append_session_start(&SessionStartRecord {
                session_id: "s1".into(),
                started_at: 10,
                file_count: 1,
                output_folder: "/out".into(),
            })
            .unwrap();
        store
            .append_file(&FileResultRecord {
                session_id: "s1".into(),
                file_id: "f1".into(),
                completed_at: 11,
                name: "a.jpg".into(),
                path: "/in/a.jpg".into(),
                output_path: Some("/out/a.jpg".into()),
                category: "image".into(),
                target_bytes: 1024,
                original_size: 5,
                compressed_size: Some(1),
                status: "done".into(),
                quality_used: Some(70),
                strategy_used: Some("quality=70".into()),
                error: None,
                duration_ms: 12,
            })
            .unwrap();
        let out = store.load().unwrap();
        assert_eq!(out.skipped_lines, 0);
        assert_eq!(out.sessions[0].session_id, "s1");
        assert_eq!(out.sessions[0].files[0].compressed_size, Some(1));
    }

    #[test]
    fn load_surfaces_read_error() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        std::fs::create_dir(store.file_path()).unwrap();
        let err = store.load().unwrap_err();
        assert!(err.starts_with("history read failed: read "), "{err}");
    }
}
