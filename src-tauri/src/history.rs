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
use std::collections::{BTreeSet, HashMap};
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

#[derive(Debug, Clone, PartialEq, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Serialize)]
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

pub const DEFAULT_PAGE_SIZE: u32 = 50;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HistoryFilters {
    pub search: Option<String>,
    pub statuses: Option<Vec<String>>,
    pub categories: Option<Vec<String>>,
    pub since_ms: Option<i64>,
    pub output_folder: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySummary {
    pub sessions: usize,
    pub files: usize,
    pub saved_bytes: u64,
    pub failed_files: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryResponse {
    pub sessions: Vec<HistorySession>,
    pub page: u32,
    pub page_size: u32,
    pub total_sessions: usize,
    pub total_files: usize,
    pub summary: HistorySummary,
    pub output_folders: Vec<String>,
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
    file.compressed_size.map_or(0, |compressed| {
        if compressed > file.original_size {
            eprintln!(
                "info: history file {} output {compressed} larger than original {}, saved clamped to 0",
                file.path, file.original_size
            );
        }
        file.original_size.saturating_sub(compressed)
    })
}

fn outcome_from_files(session_id: &str, files: &[HistoryFile]) -> Counts {
    let mut counts = Counts::default();
    for file in files {
        match file.status.as_str() {
            "done" => counts.done += 1,
            "best_effort" => counts.best_effort += 1,
            "failed" => counts.failed += 1,
            "cancelled" => counts.cancelled += 1,
            "unsupported" => counts.unsupported += 1,
            "already_under_target" => counts.already_under_target += 1,
            other => eprintln!(
                "warn: history fold session {session_id} file {} has unknown status: {other}",
                file.path
            ),
        }
    }
    counts
}

fn parse_or_skip<T: serde::de::DeserializeOwned>(
    line: &str,
    kind: &str,
    entry_index: usize,
) -> Option<T> {
    match serde_json::from_str(line) {
        Ok(parsed) => Some(parsed),
        Err(e) => {
            eprintln!(
                "warn: history fold skipped invalid {kind} record at entry {entry_index}: {e}"
            );
            None
        }
    }
}

pub fn fold_records(lines: &[String]) -> FoldResult {
    let mut sessions: Vec<HistorySession> = Vec::new();
    let mut session_index: HashMap<String, usize> = HashMap::new();
    let mut file_indexes: Vec<HashMap<String, usize>> = Vec::new();
    let mut skipped_lines = 0usize;

    for (entry, line) in lines.iter().enumerate() {
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(e) => {
                eprintln!("warn: history fold skipped malformed entry {entry}: {e}");
                skipped_lines += 1;
                continue;
            }
        };
        let kind = match value.get("type").and_then(|t| t.as_str()) {
            Some(kind) => kind,
            None => {
                eprintln!("warn: history fold skipped entry {entry} without a string \"type\"");
                skipped_lines += 1;
                continue;
            }
        };
        match kind {
            "session_start" => {
                let Some(record) =
                    parse_or_skip::<SessionStartRecord>(line, "session_start", entry)
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
                let Some(record) = parse_or_skip::<FileResultRecord>(line, "file", entry) else {
                    skipped_lines += 1;
                    continue;
                };
                let Some(index) = session_index.get(&record.session_id).copied() else {
                    eprintln!(
                        "warn: history fold skipped file record at entry {entry} for unknown session: {}",
                        record.session_id
                    );
                    skipped_lines += 1;
                    continue;
                };
                if sessions[index].ended_at.is_some() {
                    eprintln!(
                        "warn: history fold skipped file record at entry {entry} after session_end: session {} file {}",
                        record.session_id, record.file_id
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
                let Some(record) = parse_or_skip::<SessionEndRecord>(line, "session_end", entry)
                else {
                    skipped_lines += 1;
                    continue;
                };
                let Some(index) = session_index.get(&record.session_id).copied() else {
                    eprintln!(
                        "warn: history fold skipped session_end at entry {entry} for unknown session: {}",
                        record.session_id
                    );
                    skipped_lines += 1;
                    continue;
                };
                let session = &mut sessions[index];
                if session.ended_at.is_some() {
                    eprintln!(
                        "warn: history fold skipped duplicate session_end at entry {entry}: {}",
                        record.session_id
                    );
                    skipped_lines += 1;
                    continue;
                }
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
            session.outcome = outcome_from_files(&session.session_id, &session.files);
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

fn matches_search(text: &str, needle: &str) -> bool {
    text.to_lowercase().contains(needle)
}

fn file_hit(file: &HistoryFile, needle: &str) -> bool {
    matches_search(&file.name, needle)
        || matches_search(&file.path, needle)
        || file
            .output_path
            .as_ref()
            .is_some_and(|path| matches_search(&path.to_string_lossy(), needle))
        || file
            .error
            .as_deref()
            .is_some_and(|error| matches_search(error, needle))
}

fn normalize_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn normalize_list(values: Option<&[String]>) -> Option<Vec<String>> {
    let values: Vec<String> = values?
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn file_matches(
    file: &HistoryFile,
    statuses: Option<&[String]>,
    categories: Option<&[String]>,
    needle: Option<&str>,
) -> bool {
    statuses.is_none_or(|statuses| statuses.contains(&file.status))
        && categories.is_none_or(|categories| categories.contains(&file.category))
        && needle.is_none_or(|needle| file_hit(file, needle))
}

pub fn query_history(
    fold: FoldResult,
    filters: &HistoryFilters,
    page: u32,
    page_size: u32,
) -> HistoryResponse {
    let output_folders: Vec<String> = fold
        .sessions
        .iter()
        .filter_map(|session| normalize_text(Some(session.output_folder.as_str())))
        .collect::<BTreeSet<&str>>()
        .into_iter()
        .map(str::to_string)
        .collect();

    let needle = normalize_text(filters.search.as_deref()).map(str::to_lowercase);
    let statuses = normalize_list(filters.statuses.as_deref());
    let categories = normalize_list(filters.categories.as_deref());
    let output_folder = normalize_text(filters.output_folder.as_deref());
    let since_ms = filters.since_ms;

    let mut visible: Vec<HistorySession> = Vec::new();
    for mut session in fold.sessions {
        if since_ms.is_some_and(|since_ms| session.started_at < since_ms) {
            continue;
        }
        let session_folder = normalize_text(Some(session.output_folder.as_str()));
        if output_folder.is_some_and(|folder| session_folder != Some(folder)) {
            continue;
        }

        let mut file_search_hit = false;
        if let Some(needle) = needle.as_deref() {
            let folder_hit = matches_search(&session.output_folder, needle);
            file_search_hit = session.files.iter().any(|file| file_hit(file, needle));
            if !folder_hit && !file_search_hit {
                continue;
            }
        }

        let file_constraints_active = statuses.is_some() || categories.is_some();
        let needle_for_files = needle.as_deref().filter(|_| file_search_hit);
        if file_constraints_active || needle_for_files.is_some() {
            session.files.retain(|file| {
                file_matches(
                    file,
                    statuses.as_deref(),
                    categories.as_deref(),
                    needle_for_files,
                )
            });
            if session.files.is_empty() {
                continue;
            }
            session.matched_files = Some(session.files.len());
        }
        visible.push(session);
    }

    let total_sessions = visible.len();
    let mut total_files = 0usize;
    let mut saved_bytes = 0u64;
    let mut failed_files = 0usize;
    for session in &visible {
        for file in &session.files {
            total_files += 1;
            saved_bytes = saved_bytes.saturating_add(saved_for(file));
            if file.status == "failed" {
                failed_files += 1;
            }
        }
    }

    let page_size = page_size.max(1);
    let last_page = total_sessions
        .div_ceil(page_size as usize)
        .saturating_sub(1)
        .min(u32::MAX as usize) as u32;
    let page = page.min(last_page);
    let start = (page as usize).saturating_mul(page_size as usize);
    let sessions = visible
        .into_iter()
        .skip(start)
        .take(page_size as usize)
        .collect();

    let summary = HistorySummary {
        sessions: total_sessions,
        files: total_files,
        saved_bytes,
        failed_files,
    };
    debug_assert_eq!(total_sessions, summary.sessions);
    debug_assert_eq!(total_files, summary.files);

    HistoryResponse {
        sessions,
        page,
        page_size,
        total_sessions,
        total_files,
        summary,
        output_folders,
        skipped_lines: fold.skipped_lines,
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
            .enumerate()
            .map(|(i, line)| {
                if let Err(e) = std::str::from_utf8(line) {
                    eprintln!(
                        "warn: history line {i} had invalid UTF-8, lossy-decoded ({path}): {e}"
                    );
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
    fn read_lines_trims_whitespace_around_lines() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let start_line = line(start("s1", 10));
        std::fs::write(store.file_path(), format!("  \n {start_line} \r\n")).unwrap();

        let lines = store.read_lines().unwrap();
        assert_eq!(lines, vec![start_line.clone()], "only padded JSON survives");

        let out = store.load().unwrap();
        assert_eq!(out.skipped_lines, 0, "padded record parses after trimming");
        assert_eq!(out.sessions.len(), 1);
        assert_eq!(out.sessions[0].session_id, "s1");
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
        assert_eq!(s.files[0].path, "/in/a.jpg");
        assert_eq!(s.files[0].target_bytes, 1024);
        assert_eq!(s.files[0].output_path, Some(PathBuf::from("/out/a.jpg")));
    }

    #[test]
    fn fold_file_category_passthrough() {
        let mut file_record = file("s1", "f1", 110, "done", (500, Some(100)));
        file_record["category"] = serde_json::json!("video");
        let lines = vec![
            line(start("s1", 100)),
            line(file_record),
            line(end("s1", 120)),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.sessions[0].files[0].category, "video");
    }

    #[test]
    fn fold_file_error_text_passthrough() {
        let mut file_record = file("s1", "f1", 110, "failed", (500, None));
        file_record["error"] = serde_json::json!("boom");
        let lines = vec![line(start("s1", 100)), line(file_record)];
        let out = fold_records(&lines);
        assert_eq!(
            out.sessions[0].files[0].error,
            Some("boom".to_string())
        );
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
        assert!(!out.sessions[0].cancelled);
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
            line(serde_json::json!({ "type": "session_start" })),
            line(serde_json::json!({ "type": "session_end", "sessionId": "nobody" })),
            line(start("s1", 10)),
        ];
        let out = fold_records(&lines);
        assert_eq!(
            out.skipped_lines, 4,
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
    fn fold_file_ids_are_scoped_per_session() {
        let lines = vec![
            line(start("s1", 10)),
            line(file("s1", "f1", 11, "done", (5, Some(1)))),
            line(start("s2", 20)),
            line(file("s2", "f1", 21, "failed", (5, None))),
            line(file("s2", "f1", 22, "done", (5, Some(2)))),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.sessions.len(), 2);
        let s2 = out
            .sessions
            .iter()
            .find(|s| s.session_id == "s2")
            .unwrap();
        let s1 = out
            .sessions
            .iter()
            .find(|s| s.session_id == "s1")
            .unwrap();
        assert_eq!(s1.files.len(), 1);
        assert_eq!(s2.files.len(), 1, "last record for f1 within s2 replaces");
        assert_eq!(s1.files[0].status, "done");
        assert_eq!(s2.files[0].status, "done", "second s2 record wins");
        assert_eq!(s2.files[0].completed_at, 22, "second s2 record's timestamp");
    }

    #[test]
    fn fold_duplicate_session_end_is_skipped_and_counted() {
        let mut second_end = end("s1", 999);
        second_end["totalSavedBytes"] = serde_json::json!(7777);
        second_end["cancelled"] = serde_json::json!(true);
        second_end["counts"] = serde_json::json!({
            "done": 0, "bestEffort": 0, "failed": 9,
            "cancelled": 0, "unsupported": 0, "alreadyUnderTarget": 0
        });
        let lines = vec![
            line(start("s1", 10)),
            line(end("s1", 100)),
            line(second_end),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.skipped_lines, 1);
        let s = &out.sessions[0];
        assert_eq!(s.ended_at, Some(100), "first end wins");
        assert_eq!(s.total_saved_bytes, 100, "first end values retained");
        assert!(!s.cancelled, "first end values retained");
        assert_eq!(s.outcome.done, 1, "first end counts retained");
        assert_eq!(s.outcome.failed, 0, "second end counts ignored");
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
        assert!(!s.interrupted);
        assert_eq!(s.ended_at, Some(12));

        let interrupted = fold_records(&[line(start("s2", 10))]);
        let s = &interrupted.sessions[0];
        assert!(s.interrupted);
        assert_eq!(s.ended_at, None);
    }

    #[test]
    fn fold_interrupted_unknown_status_not_counted() {
        let lines = vec![
            line(start("s1", 10)),
            line(file("s1", "f1", 11, "mystery", (5, Some(1)))),
        ];
        let out = fold_records(&lines);
        let s = &out.sessions[0];
        assert!(s.interrupted);
        assert_eq!(s.outcome.done, 0);
        assert_eq!(s.outcome.best_effort, 0);
        assert_eq!(s.outcome.failed, 0);
        assert_eq!(s.outcome.cancelled, 0);
        assert_eq!(s.outcome.unsupported, 0);
        assert_eq!(s.outcome.already_under_target, 0);
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
        assert_eq!(
            sorted_keys(&value),
            vec![
                "cancelled",
                "endedAt",
                "fileCount",
                "files",
                "interrupted",
                "matchedFiles",
                "outcome",
                "outputFolder",
                "sessionId",
                "startedAt",
                "totalSavedBytes",
            ]
        );
        assert_eq!(value["endedAt"], 120);
        assert!(value["matchedFiles"].is_null());
        let file = &value["files"][0];
        assert_eq!(
            sorted_keys(file),
            vec![
                "category",
                "completedAt",
                "compressedSize",
                "durationMs",
                "error",
                "name",
                "originalSize",
                "outputPath",
                "path",
                "qualityUsed",
                "status",
                "strategyUsed",
                "targetBytes",
            ]
        );
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
        assert!(!out.sessions[0].cancelled);
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
    fn load_counts_lossy_non_json_line_as_skipped() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(store.file_path())
            .unwrap();
        file.write_all(&[0xff, 0xfe, b'\n']).unwrap();
        let start_line = line(start("s1", 10));
        file.write_all(start_line.as_bytes()).unwrap();
        file.write_all(b"\n").unwrap();

        let out = store.load().unwrap();
        assert_eq!(out.skipped_lines, 1, "lossy line is not valid JSON");
        assert_eq!(out.sessions.len(), 1);
        assert_eq!(out.sessions[0].session_id, "s1");
    }

    #[test]
    fn load_surfaces_read_error() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        std::fs::create_dir(store.file_path()).unwrap();
        let err = store.load().unwrap_err();
        assert!(err.starts_with("history read failed: read "), "{err}");
    }

    fn start_in(sid: &str, at: i64, folder: &str) -> String {
        line(serde_json::json!({
            "type": "session_start", "sessionId": sid, "startedAt": at,
            "fileCount": 1, "outputFolder": folder
        }))
    }

    fn qfile(
        sid: &str,
        fid: &str,
        at: i64,
        name: &str,
        path: &str,
        output_path: Option<&str>,
        category: &str,
        status: &str,
        sizes: (u64, Option<u64>),
        error: Option<&str>,
    ) -> String {
        line(serde_json::json!({
            "type": "file", "sessionId": sid, "fileId": fid, "completedAt": at,
            "name": name, "path": path, "outputPath": output_path,
            "category": category, "targetBytes": 1024,
            "originalSize": sizes.0, "compressedSize": sizes.1,
            "status": status, "qualityUsed": 70, "strategyUsed": "quality=70",
            "error": error, "durationMs": 12
        }))
    }

    fn two_sessions() -> FoldResult {
        let lines = vec![
            start_in("s2", 200, "/outB"),
            line(file("s2", "f2", 201, "failed", (100, None))),
            line(start("s1", 100)),
            line(file("s1", "f1", 101, "done", (500, Some(100)))),
            line(end("s1", 102)),
        ];
        fold_records(&lines)
    }

    fn five_sessions() -> FoldResult {
        let lines = vec![
            start_in("s5", 500, "/out"),
            start_in("s4", 400, "/out"),
            start_in("s3", 300, "/out"),
            start_in("s2", 200, "/out"),
            start_in("s1", 100, "/out"),
        ];
        fold_records(&lines)
    }

    fn five_sessions_mixed_statuses() -> FoldResult {
        let lines = vec![
            start_in("s5", 500, "/out"),
            qfile("s5", "f1", 501, "a.jpg", "/in/a.jpg", Some("/out/a.jpg"), "image", "done", (10, Some(5)), None),
            start_in("s4", 400, "/out"),
            qfile("s4", "f1", 401, "b.jpg", "/in/b.jpg", None, "image", "failed", (10, None), Some("boom")),
            start_in("s3", 300, "/out"),
            qfile("s3", "f1", 301, "c.jpg", "/in/c.jpg", Some("/out/c.jpg"), "image", "done", (10, Some(5)), None),
            start_in("s2", 200, "/out"),
            qfile("s2", "f1", 201, "d.jpg", "/in/d.jpg", None, "image", "failed", (10, None), Some("boom")),
            start_in("s1", 100, "/out"),
            qfile("s1", "f1", 101, "e.jpg", "/in/e.jpg", None, "image", "failed", (10, None), Some("boom")),
        ];
        fold_records(&lines)
    }

    fn search_fixture() -> FoldResult {
        let lines = vec![
            start_in("alpha", 100, "/out/alpha"),
            qfile(
                "alpha",
                "f1",
                101,
                "sunset.jpg",
                "/photos/sunset.jpg",
                Some("/out/alpha/sunset.jpg"),
                "image",
                "done",
                (500, Some(100)),
                None,
            ),
            start_in("beta", 200, "/out/beta"),
            qfile(
                "beta",
                "f2",
                201,
                "report.pdf",
                "/docs/report.pdf",
                None,
                "pdf",
                "failed",
                (100, None),
                Some("cannot read locked file"),
            ),
            start_in("gamma", 300, "/out/gamma"),
            qfile(
                "gamma",
                "f3",
                301,
                "sunset.jpg",
                "/in/zzz.bin",
                None,
                "image",
                "done",
                (500, Some(100)),
                None,
            ),
        ];
        fold_records(&lines)
    }

    fn folder_and_file_hit_fixture() -> FoldResult {
        let lines = vec![
            start_in("s1", 10, "/projects/alpha"),
            qfile(
                "s1",
                "f1",
                11,
                "alpha.txt",
                "/in/alpha.txt",
                Some("/projects/alpha/alpha.txt"),
                "document",
                "done",
                (100, Some(50)),
                None,
            ),
            qfile(
                "s1",
                "f2",
                12,
                "beta.txt",
                "/in/beta.txt",
                None,
                "document",
                "failed",
                (100, None),
                Some("nope"),
            ),
        ];
        fold_records(&lines)
    }

    fn old_start_new_file_fixture() -> FoldResult {
        let lines = vec![
            start_in("old", 100, "/out"),
            qfile(
                "old",
                "f1",
                500,
                "a.jpg",
                "/in/a.jpg",
                Some("/out/a.jpg"),
                "image",
                "done",
                (10, Some(5)),
                None,
            ),
            start_in("new", 300, "/out"),
            qfile(
                "new",
                "f1",
                301,
                "a.jpg",
                "/in/a.jpg",
                Some("/out/a.jpg"),
                "image",
                "done",
                (10, Some(5)),
                None,
            ),
            qfile(
                "new",
                "f2",
                50,
                "early.jpg",
                "/in/early.jpg",
                Some("/out/early.jpg"),
                "image",
                "done",
                (10, Some(5)),
                None,
            ),
        ];
        fold_records(&lines)
    }

    fn two_sessions_two_files_each() -> FoldResult {
        let lines = vec![
            start_in("s2", 200, "/out"),
            qfile("s2", "a", 201, "a.jpg", "/in/a.jpg", Some("/out/a.jpg"), "image", "done", (10, Some(5)), None),
            qfile("s2", "b", 202, "b.jpg", "/in/b.jpg", Some("/out/b.jpg"), "image", "done", (10, Some(5)), None),
            start_in("s1", 100, "/out"),
            qfile("s1", "a", 101, "a.jpg", "/in/a.jpg", Some("/out/a.jpg"), "image", "done", (10, Some(5)), None),
            qfile("s1", "b", 102, "b.jpg", "/in/b.jpg", Some("/out/b.jpg"), "image", "done", (10, Some(5)), None),
        ];
        fold_records(&lines)
    }

    fn mixed_folders() -> FoldResult {
        let lines = vec![
            start_in("a", 400, "/b"),
            start_in("b", 300, "/a"),
            start_in("c", 200, "/b"),
            start_in("d", 100, ""),
        ];
        fold_records(&lines)
    }

    fn no_filters() -> HistoryFilters {
        HistoryFilters::default()
    }

    #[test]
    fn query_returns_first_page_and_totals() {
        let resp = query_history(two_sessions(), &no_filters(), 0, 1);
        assert_eq!(resp.page, 0);
        assert_eq!(resp.page_size, 1);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s2");
        assert_eq!(resp.total_sessions, 2);
        assert_eq!(resp.total_files, 2);
        assert_eq!(resp.summary.sessions, 2);
        assert_eq!(resp.summary.failed_files, 1);
        assert_eq!(resp.summary.saved_bytes, 400);
    }

    #[test]
    fn query_page_middle_and_last_partial_page() {
        let expected: [(u32, usize, &[&str]); 3] = [
            (0, 2, &["s5", "s4"]),
            (1, 2, &["s3", "s2"]),
            (2, 1, &["s1"]),
        ];
        for (page, want_len, want_ids) in expected {
            let resp = query_history(five_sessions(), &no_filters(), page, 2);
            assert_eq!(resp.page, page);
            assert_eq!(resp.page_size, 2);
            assert_eq!(resp.sessions.len(), want_len, "page {page}");
            let ids: Vec<&str> = resp.sessions.iter().map(|s| s.session_id.as_str()).collect();
            assert_eq!(ids, want_ids, "page {page}");
        }
    }

    #[test]
    fn query_page_beyond_end_clamps_to_last_page() {
        let resp = query_history(two_sessions(), &no_filters(), 9, 1);
        assert_eq!(resp.page, 1);
        assert_eq!(resp.sessions[0].session_id, "s1");
    }

    #[test]
    fn query_empty_result_is_page_zero() {
        let filters = HistoryFilters { search: Some("definitely-absent".into()), ..no_filters() };
        let resp = query_history(two_sessions(), &filters, 9, 50);
        assert_eq!(resp.page, 0);
        assert!(resp.sessions.is_empty());
        assert_eq!(resp.total_sessions, 0);
        assert_eq!(resp.total_files, 0);
        assert_eq!(
            resp.summary,
            HistorySummary { sessions: 0, files: 0, saved_bytes: 0, failed_files: 0 }
        );
        assert_eq!(
            resp.output_folders,
            vec!["/out".to_string(), "/outB".to_string()]
        );
    }

    #[test]
    fn query_page_size_zero_is_safe() {
        let resp = query_history(two_sessions(), &no_filters(), 0, 0);
        assert_eq!(resp.page_size, 1);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s2");
        let clamped = query_history(two_sessions(), &no_filters(), 9, 0);
        assert_eq!(clamped.page, 1);
        assert_eq!(clamped.sessions[0].session_id, "s1");
    }

    #[test]
    fn query_status_filter_reduces_files_and_counts_them() {
        let filters = HistoryFilters {
            statuses: Some(vec!["failed".into()]),
            ..no_filters()
        };
        let resp = query_history(two_sessions(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].files.len(), 1);
        assert_eq!(resp.sessions[0].matched_files, Some(1));
        assert_eq!(resp.summary.files, 1);
        assert_eq!(resp.total_files, 1);
    }

    #[test]
    fn query_category_filter() {
        let filters = HistoryFilters {
            categories: Some(vec!["video".into()]),
            ..no_filters()
        };
        let resp = query_history(two_sessions(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 0);
        let filters = HistoryFilters {
            categories: Some(vec!["image".into()]),
            ..no_filters()
        };
        let resp = query_history(two_sessions(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 2);
        assert_eq!(resp.sessions[0].matched_files, Some(1));
        let substring = HistoryFilters {
            categories: Some(vec!["imag".into()]),
            ..no_filters()
        };
        let resp = query_history(two_sessions(), &substring, 0, 50);
        assert_eq!(
            resp.sessions.len(),
            0,
            "category filter is exact, not a substring match"
        );
    }

    #[test]
    fn query_search_hits_name_source_path_output_path_error_and_folder() {
        for (query, want_ids) in [
            ("SUNSET", vec!["gamma", "alpha"]),
            ("photos/sunset", vec!["alpha"]),
            ("alpha/sunset", vec!["alpha"]),
            ("LOCKED", vec!["beta"]),
            ("/out/beta", vec!["beta"]),
            ("no-such-text", Vec::new()),
        ] {
            let filters = HistoryFilters { search: Some(query.into()), ..no_filters() };
            let resp = query_history(search_fixture(), &filters, 0, 50);
            let ids: Vec<&str> = resp.sessions.iter().map(|s| s.session_id.as_str()).collect();
            assert_eq!(ids, want_ids, "query {query:?}");
        }
        let name_only = HistoryFilters { search: Some("SUNSET".into()), ..no_filters() };
        let resp = query_history(search_fixture(), &name_only, 0, 50);
        let gamma = resp
            .sessions
            .iter()
            .find(|s| s.session_id == "gamma")
            .expect("name-only hit is found even when path/outputPath/error do not match");
        assert_eq!(gamma.files.len(), 1);
        assert_eq!(gamma.matched_files, Some(1));
        let folder_only = HistoryFilters { search: Some("/out/beta".into()), ..no_filters() };
        let resp = query_history(search_fixture(), &folder_only, 0, 50);
        assert_eq!(resp.sessions[0].matched_files, None, "folder-only hit keeps all files");
        assert_eq!(resp.sessions[0].files.len(), 1);
        let file_hit = HistoryFilters { search: Some("locked".into()), ..no_filters() };
        let resp = query_history(search_fixture(), &file_hit, 0, 50);
        assert_eq!(resp.sessions[0].matched_files, Some(1));
    }

    #[test]
    fn query_search_file_and_folder_hit_file_set_wins() {
        let filters = HistoryFilters { search: Some("alpha".into()), ..no_filters() };
        let resp = query_history(folder_and_file_hit_fixture(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].matched_files, Some(1));
        let names: Vec<&str> = resp.sessions[0].files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["alpha.txt"]);
        assert_eq!(resp.summary.files, 1);
    }

    #[test]
    fn query_folder_search_with_status_filter_combines_semantics() {
        let filters = HistoryFilters {
            search: Some("outb".into()),
            statuses: Some(vec!["failed".into()]),
            ..no_filters()
        };
        let resp = query_history(two_sessions(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s2");
        assert_eq!(resp.sessions[0].matched_files, Some(1));

        let filters = HistoryFilters {
            search: Some("outb".into()),
            statuses: Some(vec!["done".into()]),
            ..no_filters()
        };
        assert_eq!(query_history(two_sessions(), &filters, 0, 50).sessions.len(), 0);
    }

    #[test]
    fn query_empty_and_whitespace_search_are_inactive() {
        for value in ["", "  ", "\t"] {
            let filters = HistoryFilters { search: Some(value.into()), ..no_filters() };
            let resp = query_history(two_sessions(), &filters, 0, 50);
            assert_eq!(resp.sessions.len(), 2, "search {value:?} is inactive");
            assert_eq!(resp.sessions[0].matched_files, None);
        }
    }

    #[test]
    fn query_empty_status_and_category_vecs_are_inactive() {
        let filters = HistoryFilters {
            statuses: Some(Vec::new()),
            categories: Some(Vec::new()),
            ..no_filters()
        };
        let resp = query_history(two_sessions(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 2, "toggling the last chip off shows everything");
        assert_eq!(resp.sessions[0].matched_files, None);
    }

    #[test]
    fn query_since_ms_inclusive_boundary() {
        let exact = HistoryFilters { since_ms: Some(100), ..no_filters() };
        let resp = query_history(two_sessions(), &exact, 0, 50);
        assert_eq!(resp.sessions.len(), 2);
        assert!(
            resp.sessions.iter().all(|session| session.matched_files.is_none()),
            "since_ms is session-level only; it must never reduce the file set"
        );
        let later = HistoryFilters { since_ms: Some(101), ..no_filters() };
        let resp = query_history(two_sessions(), &later, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s2");
        assert_eq!(resp.sessions[0].matched_files, None);
        assert_eq!(resp.sessions[0].files.len(), 1, "files untouched by the date filter");
    }

    #[test]
    fn query_since_ms_uses_session_start_not_file_times() {
        let filters = HistoryFilters { since_ms: Some(200), ..no_filters() };
        let resp = query_history(old_start_new_file_fixture(), &filters, 0, 50);
        assert_eq!(
            resp.sessions.len(),
            1,
            "old session with a fresh file is still excluded"
        );
        assert_eq!(resp.sessions[0].session_id, "new");
        assert_eq!(resp.sessions[0].matched_files, None);

        let inclusive = HistoryFilters { since_ms: Some(100), ..no_filters() };
        let resp = query_history(old_start_new_file_fixture(), &inclusive, 0, 50);
        assert_eq!(resp.sessions.len(), 2, "old session included at the boundary");
        let old = resp
            .sessions
            .iter()
            .find(|s| s.session_id == "old")
            .expect("old session present");
        assert_eq!(
            old.files.len(),
            1,
            "since_ms never filters file records; files stay untouched"
        );
        assert_eq!(old.matched_files, None, "since_ms is session-level only");

        let session_incl_file_before = HistoryFilters { since_ms: Some(200), ..no_filters() };
        let resp = query_history(old_start_new_file_fixture(), &session_incl_file_before, 0, 50);
        let new = resp
            .sessions
            .iter()
            .find(|s| s.session_id == "new")
            .expect("new session present");
        assert_eq!(
            new.files.len(),
            2,
            "a file completed before the cutoff does not shrink an included session's file set"
        );
        assert_eq!(
            new.matched_files, None,
            "a mutant applying since_ms to files without setting matched_files must fail"
        );
    }

    #[test]
    fn query_combined_filters() {
        let filters = HistoryFilters {
            since_ms: Some(100),
            statuses: Some(vec!["done".into()]),
            output_folder: Some("/out".into()),
            ..no_filters()
        };
        let resp = query_history(two_sessions(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s1");
        assert_eq!(resp.sessions[0].matched_files, Some(1));
        assert_eq!(resp.summary.files, 1);

        let no_match = HistoryFilters {
            statuses: Some(vec!["failed".into()]),
            output_folder: Some("/out".into()),
            ..no_filters()
        };
        assert_eq!(query_history(two_sessions(), &no_match, 0, 50).sessions.len(), 0);
    }

    #[test]
    fn query_summary_is_page_independent() {
        let first = query_history(two_sessions(), &no_filters(), 0, 1);
        let second = query_history(two_sessions(), &no_filters(), 1, 1);
        assert_eq!(second.page, 1);
        assert_eq!(second.sessions.len(), 1);
        assert_eq!(second.sessions[0].session_id, "s1");
        assert_eq!(first.total_sessions, second.total_sessions);
        assert_eq!(first.total_files, second.total_files);
        assert_eq!(first.summary, second.summary);
        assert_eq!(second.total_files, 2);
        assert_eq!(second.summary.saved_bytes, 400);
    }

    #[test]
    fn query_never_splits_session_across_pages() {
        let resp = query_history(two_sessions_two_files_each(), &no_filters(), 0, 1);
        assert_eq!(resp.page_size, 1);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s2");
        assert_eq!(resp.sessions[0].files.len(), 2, "both files travel with the session row");
        let resp = query_history(two_sessions_two_files_each(), &no_filters(), 1, 1);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s1");
        assert_eq!(resp.sessions[0].files.len(), 2);
    }

    #[test]
    fn query_output_folders_list_is_unfiltered_deduped_sorted() {
        let filters = HistoryFilters { output_folder: Some("/b".into()), ..no_filters() };
        let resp = query_history(mixed_folders(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 2);
        let ids: Vec<&str> = resp.sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "c"]);
        assert_eq!(
            resp.output_folders,
            vec!["/a".to_string(), "/b".to_string()],
            "unfiltered, deduped, sorted, non-empty"
        );
    }

    #[test]
    fn query_output_folder_filter_excludes_empty_folder_sessions() {
        let unfiltered = query_history(mixed_folders(), &no_filters(), 0, 50);
        assert_eq!(
            unfiltered.sessions.len(),
            4,
            "empty-folder session visible without a folder filter"
        );
        let filters = HistoryFilters { output_folder: Some("/b".into()), ..no_filters() };
        let resp = query_history(mixed_folders(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 2);
        assert!(resp.sessions.iter().all(|s| s.output_folder == "/b"));
        assert!(
            resp.sessions.iter().all(|s| s.matched_files.is_none()),
            "folder filter is session-level; matchedFiles stays None"
        );
        assert!(!resp.sessions.iter().any(|s| s.session_id == "d"));
    }

    fn folder_filter_sessions_with_files() -> FoldResult {
        let lines = vec![
            start_in("a", 400, "/b"),
            qfile("a", "f1", 401, "a.jpg", "/in/a.jpg", Some("/out/a.jpg"), "image", "done", (10, Some(5)), None),
            start_in("b", 300, "/a"),
            qfile("b", "f1", 301, "b.jpg", "/in/b.jpg", Some("/out/b.jpg"), "image", "failed", (10, None), Some("boom")),
            start_in("c", 200, "/b"),
            qfile("c", "f1", 201, "c.jpg", "/in/c.jpg", Some("/out/c.jpg"), "image", "done", (10, Some(5)), None),
        ];
        fold_records(&lines)
    }

    #[test]
    fn query_output_folder_filter_is_session_level() {
        let filters = HistoryFilters { output_folder: Some("/b".into()), ..no_filters() };
        let resp = query_history(folder_filter_sessions_with_files(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 2);
        assert!(
            resp.sessions.iter().all(|s| s.matched_files.is_none()),
            "folder filter is session-level; it must never set matchedFiles"
        );
        assert!(
            resp.sessions.iter().all(|s| s.files.len() == 1),
            "file sets stay untouched under a folder filter"
        );
        assert_eq!(resp.summary.files, 2);
    }

    #[test]
    fn query_page_beyond_end_clamps_with_active_filter() {
        let filters = HistoryFilters {
            statuses: Some(vec!["failed".into()]),
            ..no_filters()
        };
        let resp = query_history(five_sessions_mixed_statuses(), &filters, 9, 1);
        assert_eq!(
            resp.page, 2,
            "page clamps to the last page of the filtered set, not the unfiltered set"
        );
        assert_eq!(resp.sessions.len(), 1, "clamped page still returns a session");
        assert_eq!(resp.sessions[0].session_id, "s1");
        assert_eq!(resp.total_sessions, 3, "three of five sessions are failed");
    }

    fn three_status_session() -> FoldResult {
        let lines = vec![
            start_in("s1", 10, "/out"),
            qfile("s1", "f1", 11, "a.jpg", "/in/a.jpg", Some("/out/a.jpg"), "image", "done", (10, Some(5)), None),
            qfile("s1", "f2", 12, "b.jpg", "/in/b.jpg", Some("/out/b.jpg"), "image", "failed", (10, None), Some("boom")),
            qfile("s1", "f3", 13, "c.mp4", "/in/c.mp4", Some("/out/c.mp4"), "video", "cancelled", (10, None), None),
        ];
        fold_records(&lines)
    }

    #[test]
    fn query_multi_status_filters_are_a_union() {
        let filters = HistoryFilters {
            statuses: Some(vec!["failed".into(), "cancelled".into()]),
            ..no_filters()
        };
        let resp = query_history(three_status_session(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 1, "union keeps the session");
        assert_eq!(resp.sessions[0].files.len(), 2);
        assert!(resp.sessions[0].files.iter().all(|f| f.status != "done"));
        assert_eq!(resp.sessions[0].matched_files, Some(2));
        assert_eq!(resp.summary.files, 2);

        let categories = HistoryFilters {
            categories: Some(vec!["pdf".into(), "video".into()]),
            ..no_filters()
        };
        let resp = query_history(three_status_session(), &categories, 0, 50);
        assert_eq!(resp.sessions.len(), 1, "second category element matches");
        assert_eq!(resp.sessions[0].files.len(), 1);
        assert_eq!(resp.sessions[0].files[0].category, "video");
        assert_eq!(resp.sessions[0].matched_files, Some(1));
        assert_eq!(resp.summary.files, 1);
    }

    fn planned_three_actual_two() -> FoldResult {
        let lines = vec![
            line(serde_json::json!({
                "type": "session_start", "sessionId": "s1", "startedAt": 10,
                "fileCount": 3, "outputFolder": "/out"
            })),
            qfile("s1", "f1", 11, "a.jpg", "/in/a.jpg", Some("/out/a.jpg"), "image", "done", (10, Some(5)), None),
            qfile("s1", "f2", 12, "b.jpg", "/in/b.jpg", Some("/out/b.jpg"), "image", "failed", (10, None), Some("boom")),
        ];
        fold_records(&lines)
    }

    #[test]
    fn query_matched_files_uses_returned_len_not_planned_file_count() {
        let filters = HistoryFilters {
            statuses: Some(vec!["failed".into()]),
            ..no_filters()
        };
        let resp = query_history(planned_three_actual_two(), &filters, 0, 50);
        assert_eq!(resp.sessions[0].file_count, 3, "planned count stays on the session");
        assert_eq!(resp.sessions[0].files.len(), 1);
        assert_eq!(
            resp.sessions[0].matched_files,
            Some(1),
            "matchedFiles is the returned file count, never the planned fileCount"
        );
        assert_eq!(resp.summary.files, 1);
    }

    fn done_and_failed_session() -> FoldResult {
        let lines = vec![
            start_in("s1", 10, "/out"),
            qfile("s1", "f1", 11, "a.jpg", "/in/a.jpg", Some("/out/a.jpg"), "image", "done", (10, Some(5)), None),
            qfile("s1", "f2", 12, "b.jpg", "/in/b.jpg", None, "image", "failed", (10, None), Some("boom")),
            line(end("s1", 13)),
        ];
        fold_records(&lines)
    }

    #[test]
    fn query_summary_failed_files_respects_file_filter() {
        let done_only = HistoryFilters { statuses: Some(vec!["done".into()]), ..no_filters() };
        let resp = query_history(done_and_failed_session(), &done_only, 0, 50);
        assert_eq!(resp.sessions[0].files.len(), 1);
        assert_eq!(resp.summary.failed_files, 0, "only displayed files count");

        let failed_only = HistoryFilters { statuses: Some(vec!["failed".into()]), ..no_filters() };
        let resp = query_history(done_and_failed_session(), &failed_only, 0, 50);
        assert_eq!(resp.summary.failed_files, 1);

        let unfiltered = query_history(done_and_failed_session(), &no_filters(), 0, 50);
        assert_eq!(unfiltered.sessions[0].outcome.failed, 0, "end-record counts disagree");
        assert_eq!(
            unfiltered.summary.failed_files, 1,
            "summary comes from displayed files, not session outcome"
        );
    }

    fn search_status_fixture() -> FoldResult {
        let lines = vec![
            start_in("s1", 10, "/out"),
            qfile("s1", "f1", 11, "a.jpg", "/in/a.jpg", Some("/out/a.jpg"), "image", "failed", (10, Some(5)), Some("locked")),
            qfile("s1", "f2", 12, "b.jpg", "/in/b.jpg", None, "image", "failed", (10, None), Some("boom")),
            qfile("s1", "f3", 13, "c.jpg", "/in/c.jpg", Some("/out/c.jpg"), "image", "done", (10, Some(5)), Some("locked")),
        ];
        fold_records(&lines)
    }

    #[test]
    fn query_file_search_hit_intersects_status_filter() {
        let search_only = HistoryFilters { search: Some("locked".into()), ..no_filters() };
        let resp = query_history(search_status_fixture(), &search_only, 0, 50);
        assert_eq!(resp.sessions.len(), 1, "search alone keeps the session");
        assert_eq!(resp.sessions[0].files.len(), 2, "f1 and f3 match the searched error");
        assert_eq!(resp.sessions[0].matched_files, Some(2));

        let status_only = HistoryFilters {
            statuses: Some(vec!["failed".into()]),
            ..no_filters()
        };
        let resp = query_history(search_status_fixture(), &status_only, 0, 50);
        assert_eq!(resp.sessions[0].files.len(), 2, "f1 and f2 are failed");

        let filters = HistoryFilters {
            search: Some("locked".into()),
            statuses: Some(vec!["failed".into()]),
            ..no_filters()
        };
        let resp = query_history(search_status_fixture(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(
            resp.sessions[0].files.len(),
            1,
            "search ∩ status: status narrows within the search and search narrows within the status"
        );
        assert_eq!(resp.sessions[0].files[0].name, "a.jpg");
        assert_eq!(resp.sessions[0].matched_files, Some(1));
        assert_eq!(resp.summary.files, 1);
    }

    fn pdf_and_image_errors_fixture() -> FoldResult {
        let lines = vec![
            start_in("s1", 10, "/out"),
            qfile("s1", "f1", 11, "a.pdf", "/in/a.pdf", Some("/out/a.pdf"), "pdf", "failed", (10, None), Some("locked")),
            qfile("s1", "f2", 12, "b.pdf", "/in/b.pdf", Some("/out/b.pdf"), "pdf", "failed", (10, None), Some("boom")),
            qfile("s1", "f3", 13, "c.jpg", "/in/c.jpg", Some("/out/c.jpg"), "image", "failed", (10, None), Some("locked")),
        ];
        fold_records(&lines)
    }

    #[test]
    fn query_file_search_hit_intersects_category_filter() {
        let filters = HistoryFilters {
            search: Some("locked".into()),
            categories: Some(vec!["pdf".into()]),
            ..no_filters()
        };
        let resp = query_history(pdf_and_image_errors_fixture(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(
            resp.sessions[0].files.len(),
            1,
            "search ∩ category: category narrows within the search and search narrows within the category"
        );
        assert_eq!(resp.sessions[0].files[0].name, "a.pdf");
        assert_eq!(resp.sessions[0].matched_files, Some(1));
        assert_eq!(resp.summary.files, 1);
    }

    fn two_max_saved_files() -> FoldResult {
        let lines = vec![
            start_in("s1", 10, "/out"),
            qfile("s1", "f1", 11, "a.jpg", "/in/a.jpg", Some("/out/a.jpg"), "image", "done", (u64::MAX, Some(0)), None),
            qfile("s1", "f2", 12, "b.jpg", "/in/b.jpg", Some("/out/b.jpg"), "image", "done", (u64::MAX, Some(0)), None),
        ];
        fold_records(&lines)
    }

    #[test]
    fn query_summary_saved_bytes_saturates() {
        let resp = query_history(two_max_saved_files(), &no_filters(), 0, 50);
        assert_eq!(resp.total_files, 2);
        assert_eq!(resp.summary.saved_bytes, u64::MAX, "saturating add, no panic");
    }

    #[test]
    fn query_skipped_lines_passthrough() {
        let lines = vec![start_in("s1", 10, "/out"), "not json".to_string()];
        let resp = query_history(fold_records(&lines), &no_filters(), 0, 50);
        assert_eq!(resp.skipped_lines, 1);
        assert_eq!(resp.total_sessions, 1);
    }

    #[test]
    fn query_blank_and_whitespace_filters_are_inactive() {
        let blank_folder = HistoryFilters { output_folder: Some("  ".into()), ..no_filters() };
        assert_eq!(
            query_history(mixed_folders(), &blank_folder, 0, 50).sessions.len(),
            4,
            "blank output_folder is inactive"
        );

        let blank_status = HistoryFilters { statuses: Some(vec!["  ".into()]), ..no_filters() };
        assert_eq!(
            query_history(two_sessions(), &blank_status, 0, 50).sessions.len(),
            2,
            "blank-only status vec is inactive"
        );

        let mixed = HistoryFilters {
            statuses: Some(vec![" ".into(), "failed".into()]),
            ..no_filters()
        };
        assert_eq!(query_history(two_sessions(), &mixed, 0, 50).sessions.len(), 1);

        let padded = HistoryFilters { statuses: Some(vec![" failed ".into()]), ..no_filters() };
        let resp = query_history(two_sessions(), &padded, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s2");
        assert_eq!(resp.sessions[0].matched_files, Some(1));

        let padded_folder = HistoryFilters { output_folder: Some(" /outB ".into()), ..no_filters() };
        let resp = query_history(two_sessions(), &padded_folder, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s2");
    }

    #[test]
    fn query_stored_folder_trimmed_for_match_and_listing() {
        let lines = vec![
            start_in("plain", 300, "/outB"),
            start_in("padded", 200, " /outB "),
            start_in("blank", 100, "   "),
        ];
        let fold = fold_records(&lines);

        let unfiltered = query_history(fold, &no_filters(), 0, 50);
        assert_eq!(unfiltered.sessions.len(), 3, "whitespace-only folder still visible");
        assert_eq!(
            unfiltered.output_folders,
            vec!["/outB".to_string()],
            "folders are listed trimmed; whitespace-only is not an option"
        );

        let filtered = query_history(
            fold_records(&lines),
            &HistoryFilters { output_folder: Some("/outB".into()), ..no_filters() },
            0,
            50,
        );
        let ids: Vec<&str> = filtered.sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["plain", "padded"],
            "trimmed filter matches trimmed stored folder on both sides"
        );
        assert_eq!(filtered.total_sessions, 2);
        assert!(
            filtered.sessions.iter().all(|s| s.matched_files.is_none()),
            "folder filter is session-level; matchedFiles stays None"
        );
    }

    #[test]
    fn query_response_serde_keys_are_pinned() {
        let resp = query_history(two_sessions(), &no_filters(), 0, 50);
        let value = serde_json::to_value(&resp).unwrap();
        assert_eq!(
            sorted_keys(&value),
            vec![
                "outputFolders",
                "page",
                "pageSize",
                "sessions",
                "skippedLines",
                "summary",
                "totalFiles",
                "totalSessions",
            ]
        );
        assert_eq!(
            sorted_keys(&value["summary"]),
            vec!["failedFiles", "files", "savedBytes", "sessions"]
        );
        assert_eq!(DEFAULT_PAGE_SIZE, 50);
    }

    #[test]
    fn history_filters_deserialize_camel_case() {
        let filters: HistoryFilters = serde_json::from_str(
            r#"{"sinceMs":5,"outputFolder":"/x","statuses":["failed"]}"#,
        )
        .unwrap();
        assert_eq!(filters.since_ms, Some(5));
        assert_eq!(filters.output_folder, Some("/x".to_string()));
        assert_eq!(filters.statuses, Some(vec!["failed".to_string()]));
        assert_eq!(filters.search, None);
        assert_eq!(filters.categories, None);
    }

    #[test]
    fn history_filters_deserialize_rejects_unknown_keys() {
        let result = serde_json::from_str::<HistoryFilters>(r#"{"category":"image"}"#);
        assert!(
            result.is_err(),
            "typo'd filter key must fail deserialization instead of silently defaulting"
        );
    }
}
