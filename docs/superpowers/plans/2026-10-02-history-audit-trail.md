# History Audit Trail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every compression session to a local JSONL audit log and surface it in a filterable, searchable, paginated History view with source/output path actions.

**Architecture:** New `src-tauri/src/history.rs` (pure append/load/fold/query functions + `HistoryStore` Tauri state) writes three record kinds (`session_start` / `file` / `session_end`) from `queue.rs` write points. `get_history` executes search/filter/pagination core-side over the full log. Frontend replaces the `HistoryView` placeholder with a session-list + inline-expand UI backed by `useHistory` and a pure `historyFormat` module.

**Tech Stack:** Rust (std + serde + tauri Runtime generics, no new deps), React 19 + TS, shadcn/ui (base-ui), Vitest + Testing Library, Rust `tempfile` dev-dep.

**Spec:** `docs/superpowers/specs/2026-10-02-history-audit-trail-design.md`

## Global Constraints

- Gate command (every task): `yarn build && yarn test && cd src-tauri && cargo test`
- **No new Rust or npm dependencies.** Timestamps via `std::time` (SystemTime → epoch ms), not chrono.
- GPL license header block on every new file, copied exactly from `src-tauri/src/queue.rs:1-15` (Rust) / `src/views/HistoryView.tsx:1-15` (TS).
- No comments in code unless explicitly requested (AGENTS.md).
- IPC structs: `#[serde(rename_all = "camelCase")]`; snake_case in Rust, camelCase over IPC.
- Frontend = UI only; all filtering/folding/pagination executes in Rust.
- Compression behavior must not change: history write failures warn + toast, never fail a batch.
- History data is metadata only — never file contents. No file on disk is deleted by history features (clear/trim remove log records only).
- `HistoryStore` methods are Runtime-generic so MockRuntime queue tests can use them.

## Review Focus

- **Clock/DST boundaries** — "Today" starts at local midnight, not 24h ago; `sinceMs` computed webview-side (`Date`), inclusive comparison in Rust.
- **Interrupted sessions** — force-kill mid-batch must show partial files as Interrupted, never drop the session or invent one for preflight failures.
- **Search coverage** — search must match names/paths/errors across the *entire* retained log, not the loaded page; folder-text hits keep whole sessions.
- **Corrupt/foreign lines** — malformed or unknown-`type` lines are skipped, counted, and shown as a notice; old files keep loading.
- **Filter × pagination interaction** — any filter change resets to page 0; totals/summary stay page-independent; a session row is never split across pages.
- **Missing/changed files** — copy path always works; reveal/open-folder degrade gracefully with a toast.

---

### Task 1: History settings — `history.retentionDays`

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Test: existing `src-tauri/src/settings.rs` test module

**Interfaces:**
- Consumes: existing `Settings` struct + `parse_settings_value` fallback pattern (`settings.rs:229-234`).
- Produces: `Settings.history: HistorySettings` with `retention_days: u32`, serde-defaulted to 90 on missing/corrupt; `HistorySettings::effective_retention_days(&self) -> u32` clamping to `1..=3650` with 90 fallback for 0. Tasks 5, 8, 10 consume both.

**Acceptance Criteria:**
- `history` key serializes camelCase (`retentionDays`), roundtrips equal.
- Missing / empty / corrupt `history` falls back to 90 via serde default.
- Clamp pinned: 0 → 90, 5000 → 3650, valid values verbatim.
- All Required Tests pass; gate green.

**Required Tests:**
- `history_retention_defaults_to_90` — `Settings::default().history.retention_days == 90`
- `history_serde_roundtrip_camel_case` — serialized JSON contains `history.retentionDays`; roundtrip equal
- `parse_settings_value_missing_history_fills_default` — `{ "outputFolder": "/tmp/out" }` → 90
- `parse_settings_value_corrupt_history_fills_default` — `{ "history": { "retentionDays": "lots" } }` → whole Settings falls back to defaults (existing corrupt-value convention)
- `effective_retention_days_clamps` — (0→90, 1→1, 90→90, 3650→3650, 5000→3650)

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/settings.rs` test module add:

```rust
    #[test]
    fn history_retention_defaults_to_90() {
        assert_eq!(Settings::default().history.retention_days, 90);
    }

    #[test]
    fn history_serde_roundtrip_camel_case() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        let history = value.get("history").unwrap();
        assert!(history.get("retentionDays").is_some());
        let roundtripped: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(Settings::default(), roundtripped);
    }

    #[test]
    fn parse_settings_value_missing_history_fills_default() {
        let parsed = parse_settings_value(Some(serde_json::json!({ "outputFolder": "/tmp/out" })));
        assert_eq!(parsed.history.retention_days, 90);
    }

    #[test]
    fn parse_settings_value_corrupt_history_fills_default() {
        let corrupt = serde_json::json!({
            "outputFolder": "/x",
            "history": { "retentionDays": "lots" }
        });
        assert_eq!(parse_settings_value(Some(corrupt)), Settings::default());
    }

    #[test]
    fn effective_retention_days_clamps() {
        for (raw, want) in [(0u32, 90u32), (1, 1), (90, 90), (3650, 3650), (5000, 3650)] {
            let mut s = Settings::default();
            s.history.retention_days = raw;
            assert_eq!(s.history.effective_retention_days(), want, "raw={raw}");
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test settings`
Expected: FAIL — no field `history` on `Settings`.

- [ ] **Step 3: Implement**

In `src-tauri/src/settings.rs`, add after `Performance` (line ~99):

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySettings {
    #[serde(default = "default_retention_days")]
    pub retention_days: u32,
}

fn default_retention_days() -> u32 {
    90
}

impl Default for HistorySettings {
    fn default() -> Self {
        HistorySettings {
            retention_days: default_retention_days(),
        }
    }
}

impl HistorySettings {
    pub fn effective_retention_days(&self) -> u32 {
        if self.retention_days == 0 {
            90
        } else {
            self.retention_days.clamp(1, 3650)
        }
    }
}
```

Extend `Settings` with `#[serde(default)] pub history: HistorySettings,` (after `performance`), extend `Settings::default()` with `history: HistorySettings::default(),`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test settings`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(settings): add history.retentionDays with clamp"
```

---

### Task 2: `history.rs` records + append

**Files:**
- Create: `src-tauri/src/history.rs`
- Modify: `src-tauri/src/lib.rs` (`mod history;` — module only, wiring lands in Task 8)
- Test: `src-tauri/src/history.rs` test module

**Interfaces:**
- Consumes: GPL header pattern; `uuid` crate (existing).
- Produces (all `pub` unless noted):
  - `SessionStartRecord { session_id: String, started_at: i64, file_count: usize, output_folder: String }` — camelCase serde
  - `FileResultRecord { session_id: String, file_id: String, completed_at: i64, name: String, path: String, output_path: Option<String>, category: String, target_bytes: u64, original_size: u64, compressed_size: Option<u64>, status: String, quality_used: Option<u32>, strategy_used: Option<String>, error: Option<String>, duration_ms: u64 }`
  - `SessionEndRecord { session_id: String, ended_at: i64, total_saved_bytes: u64, counts: Counts, cancelled: bool }`
  - `Counts { done: u32, best_effort: u32, failed: u32, cancelled: u32, unsupported: u32, already_under_target: u32 }` — camelCase
  - `HistoryStore::new_in(dir: &Path) -> HistoryStore` — path is `dir/history.jsonl`
  - `HistoryStore::file_path(&self) -> &Path` (test accessor)
  - `HistoryStore::append_session_start / append_file / append_session_end -> Result<(), String>`
  - `HistoryStore::read_lines(&self) -> Result<Vec<String>, String>` (pub(crate); `Ok(vec![])` when the file does not exist)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/history.rs` with the GPL header (`queue.rs:1-15` verbatim), `mod tests` included with:

```rust
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
```

Plus a test-module helper:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test history`
Expected: FAIL — `HistoryStore` not defined.

- [ ] **Step 3: Implement**

In `src-tauri/src/history.rs` (above the test module), implement:

- The five structs with `#[serde(rename_all = "camelCase")]` + `Serialize, Deserialize, Debug, Clone`. `Counts` derives the same; `SessionStartRecord`/`SessionEndRecord`/`Counts` derive `PartialEq` for test equality.
- `HistoryStore { path: PathBuf, lock: Mutex<()> }` with `new_in(dir)` = `dir.join("history.jsonl")`, `file_path()` accessor.
- Record-level serialization discriminator: a private `#[derive(Serialize)] #[serde(tag = "type", rename_all = "snake_case")] enum RecordRef<'a> { SessionStart(&'a SessionStartRecord), File(&'a FileResultRecord), SessionEnd(&'a SessionEndRecord) }` so the `"type"` tag lives in exactly one place. `append()` serializes `RecordRef` to a compact line, creates parent dirs (`create_dir_all`) if missing, opens with `OpenOptions::new().create(true).append(true)`, writes `line + "\n"` inside `self.lock`. Errors → `Err(format!("history write failed: {e}"))`.
- `read_lines`: `NotFound` → `Ok(vec![])`; other errors → `Err(String)`; reads whole file inside the lock, returns non-empty lines.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test history`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/history.rs src-tauri/src/lib.rs
git commit -m "feat(history): add JSONL records and append store"
```

---

### Task 3: Fold records into sessions

**Files:**
- Modify: `src-tauri/src/history.rs`
- Test: `src-tauri/src/history.rs` test module

**Interfaces:**
- Consumes: Task 2 record structs; `read_lines`.
- Produces:
  - `HistoryFile { name, path, output_path: Option<PathBuf>, category, target_bytes: u64, original_size: u64, compressed_size: Option<u64>, status, quality_used: Option<u32>, strategy_used: Option<String>, error: Option<String>, duration_ms: u64, completed_at: i64 }` — camelCase serde (all fields)
  - `HistorySession { session_id, started_at: i64, ended_at: Option<i64>, output_folder: String, file_count: usize, files: Vec<HistoryFile>, outcome: Counts, total_saved_bytes: u64, cancelled: bool, interrupted: bool, matched_files: Option<usize> }` — camelCase; `matched_files` = `None` when no file-level filter (set in Task 4); `outcome` reuses the `Counts` struct from Task 2 (one counts type, not two)
  - `FoldResult { sessions: Vec<HistorySession>, skipped_lines: usize }` — sessions newest-first by `started_at`
  - `pub fn fold_records(lines: &[String]) -> FoldResult` (pure)
  - `HistoryStore::load(&self) -> Result<FoldResult, String>`

- [ ] **Step 1: Write the failing tests**

Add to the `history.rs` test module:

```rust
    fn line(value: serde_json::Value) -> String {
        value.to_string()
    }

    fn start(sid: &str, at: i64) -> serde_json::Value {
        serde_json::json!({
            "type": "session_start", "sessionId": sid, "startedAt": at,
            "fileCount": 1, "outputFolder": "/out"
        })
    }

    fn file(sid: &str, fid: &str, at: i64, status: &str, sizes: (u64, Option<u64>)) -> serde_json::Value {
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
        assert_eq!(s.ended_at, Some(120));
        assert!(!s.interrupted);
        assert_eq!(s.outcome.done, 1);
        assert_eq!(s.files.len(), 1);
        assert_eq!(s.files[0].quality_used, Some(70));
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
        let names: Vec<&str> = out.sessions[0].files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names.len(), 2);
        assert!(out.sessions[0].files[0].completed_at <= out.sessions[0].files[1].completed_at);
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
    fn fold_skips_malformed_counts_them_and_ignores_unknown_types() {
        let lines = vec![
            "not json".to_string(),
            line(serde_json::json!({ "type": "future_record", "sessionId": "x" })),
            line(start("s1", 10)),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.skipped_lines, 1, "malformed counted; unknown type ignored silently");
        assert_eq!(out.sessions.len(), 1);
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
    fn fold_orphan_file_lines_are_skipped() {
        let lines = vec![line(file("nobody", "f1", 11, "done", (5, Some(1))))];
        let out = fold_records(&lines);
        assert_eq!(out.sessions.len(), 0);
        assert_eq!(out.skipped_lines, 1);
    }

    #[test]
    fn load_roundtrips_through_file() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        store.append_session_start(&SessionStartRecord {
            session_id: "s1".into(),
            started_at: 10,
            file_count: 1,
            output_folder: "/out".into(),
        }).unwrap();
        store.append_file(&FileResultRecord {
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
        }).unwrap();
        let out = store.load().unwrap();
        assert_eq!(out.sessions[0].session_id, "s1");
        assert_eq!(out.sessions[0].files[0].compressed_size, Some(1));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test history`
Expected: FAIL — `fold_records` not defined.

- [ ] **Step 3: Implement**

In `src-tauri/src/history.rs`:

- `history_file_from(rec: &FileResultRecord) -> HistoryFile` maps fields 1:1 (`output_path` via `PathBuf::from`).
- `fold_records(lines)`:
  - Parse each line with `serde_json::from_str::<serde_json::Value>`; on error → `skipped_lines += 1`.
  - Match `value["type"]`: `"session_start"` → deserialize `SessionStartRecord`, push session into an index map (`HashMap<String, usize>`) with empty files/outcome; `"file"` → deserialize `FileResultRecord`; unknown session id → `skipped_lines += 1`, else append/replace by `file_id` (last wins); `"session_end"` → deserialize `SessionEndRecord`, set `ended_at`, `total_saved_bytes`, `cancelled`, `outcome` from counts; **unknown types are ignored silently** (forward compatibility — a future record kind must not trigger the corrupt-line notice or be dropped on retention rewrite).
  - After the pass: for sessions without `ended_at`, compute `outcome` from files and `total_saved_bytes = Σ original − compressed` (saturating); `interrupted = true`.
  - Sort files by `completed_at`; sort sessions by `started_at` descending.
- `HistoryStore::load` = `read_lines()` → `fold_records`; `read_lines` failure → `Err`.
- `#[serde(rename_all = "camelCase")]` on `HistoryFile` / `HistorySession` (`outcome` uses the `Counts` struct from Task 2); `matched_files` serializes as `null` until Task 4 sets it.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test history`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/history.rs
git commit -m "feat(history): fold records into sessions with interrupted detection"
```

---

### Task 4: Core-side query — filters, pagination, summary

**Files:**
- Modify: `src-tauri/src/history.rs`
- Test: `src-tauri/src/history.rs` test module

**Interfaces:**
- Consumes: Task 3 `FoldResult`, `HistorySession`, `HistoryFile`.
- Produces:
  - `HistoryFilters { search: Option<String>, statuses: Option<Vec<String>>, categories: Option<Vec<String>>, since_ms: Option<i64>, output_folder: Option<String> }` — camelCase serde, `Default`
  - `HistorySummary { sessions: usize, files: usize, saved_bytes: u64, failed_files: usize }` — camelCase
  - `HistoryResponse { sessions: Vec<HistorySession>, page: u32, page_size: u32, total_sessions: usize, total_files: usize, summary: HistorySummary, output_folders: Vec<String>, skipped_lines: usize }` — camelCase
  - `pub fn query_history(fold: FoldResult, filters: &HistoryFilters, page: u32, page_size: u32) -> HistoryResponse`
  - `pub const DEFAULT_PAGE_SIZE: u32 = 50;`

**Filter semantics (locked with spec §3.5):**
- Date: `since_ms` absent or session `started_at >= since_ms` (inclusive). Session-level.
- Output folder: exact match on session `output_folder`; `None` when a session has an empty folder (excluded by an active folder filter). Session-level.
- Search: case-insensitive substring. File-level hit = name / path / output_path / error. **Session-level hit on `output_folder` keeps the session with `matched_files = None`.** Both hit → file set wins with `Some(n)`.
- Status / categories: file-level; a session is visible when ≥1 file matches and only matching files are returned; `matched_files = Some(returned_len)`. Category compares against `HistoryFile.category`.
- File-level filter active ⇔ any of search / statuses / categories present (search alone is file-level only when it also matches folder text? — no: search sets `matched_files = None` only when the hit is folder-only without file hits).
- `output_folders`: distinct non-empty session folders, sorted, from the **unfiltered** fold.
- `summary`: always the whole filtered set (independent of page): `files` = Σ displayed files (all files of visible sessions when `matched_files = None`, else matches); `saved_bytes` = Σ (`original_size - compressed_size`) saturating over those files; `failed_files` = count of `status == "failed"` over those files.
- Ordering: sessions already newest-first; then stable page slice: effective page = `page.min(max(0, ceil(total/page_size) - 1))`; empty set → page 0.
- `total_files` = same as `summary.files`.

- [ ] **Step 1: Write the failing tests**

Add to the `history.rs` test module (helpers: reuse `line`/`start`/`file`/`end` from Task 3, plus `sess(...)` builder as needed):

```rust
    fn two_sessions() -> FoldResult {
        let lines = vec![
            line(serde_json::json!({
                "type": "session_start", "sessionId": "s2", "startedAt": 200,
                "fileCount": 1, "outputFolder": "/outB"
            })),
            line(file("s2", "f2", 201, "failed", (100, None))),
            line(start("s1", 100)),
            line(file("s1", "f1", 101, "done", (500, Some(100)))),
            line(end("s1", 102)),
        ];
        fold_records(&lines)
    }

    fn no_filters() -> HistoryFilters {
        HistoryFilters::default()
    }

    #[test]
    fn query_returns_first_page_and_totals() {
        let resp = query_history(two_sessions(), &no_filters(), 0, 1);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s2");
        assert_eq!(resp.total_sessions, 2);
        assert_eq!(resp.total_files, 2);
        assert_eq!(resp.summary.sessions, 2);
        assert_eq!(resp.summary.failed_files, 1);
        assert_eq!(resp.summary.saved_bytes, 400);
    }

    #[test]
    fn query_page_beyond_end_clamps_to_last_page() {
        let resp = query_history(two_sessions(), &no_filters(), 9, 1);
        assert_eq!(resp.page, 1);
        assert_eq!(resp.sessions[0].session_id, "s1");
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
    fn query_search_hits_name_path_error_and_folder() {
        let by_name = HistoryFilters { search: Some("A.JPG".into()), ..no_filters() };
        assert_eq!(query_history(two_sessions(), &by_name, 0, 50).sessions.len(), 2);

        let by_folder = HistoryFilters { search: Some("outb".into()), ..no_filters() };
        let resp = query_history(two_sessions(), &by_folder, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.sessions[0].session_id, "s2");
        assert_eq!(resp.sessions[0].matched_files, None, "folder-only hit shows all files");

        let by_error = HistoryFilters { search: Some("no-such-error".into()), ..no_filters() };
        assert_eq!(query_history(two_sessions(), &by_error, 0, 50).sessions.len(), 0);
    }

    #[test]
    fn query_since_ms_inclusive_boundary() {
        let exact = HistoryFilters { since_ms: Some(100), ..no_filters() };
        assert_eq!(query_history(two_sessions(), &exact, 0, 50).sessions.len(), 2);
        let later = HistoryFilters { since_ms: Some(101), ..no_filters() };
        assert_eq!(query_history(two_sessions(), &later, 0, 50).sessions.len(), 1);
    }

    #[test]
    fn query_output_folders_list_is_unfiltered_and_sorted() {
        let filters = HistoryFilters { output_folder: Some("/outB".into()), ..no_filters() };
        let resp = query_history(two_sessions(), &filters, 0, 50);
        assert_eq!(resp.sessions.len(), 1);
        assert_eq!(resp.output_folders, vec!["/out", "/outB"],
            "distinct session folders from the unfiltered fold, sorted");
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
        assert_eq!(query_history(two_sessions(), &filters, 0, 50).sessions.len(), 2);
    }
```

(Note: the `file()` helper writes `outputPath: "/out/a.jpg"` and `category: "image"`; `start()` writes `outputFolder: "/out"`, `two_sessions()` overrides `s2` to `"/outB"` — so the unfiltered folder list is `["/out", "/outB"]` sorted. Keep assertions aligned with the fixtures you actually use.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test history`
Expected: FAIL — `query_history` not defined.

- [ ] **Step 3: Implement**

In `src-tauri/src/history.rs` implement `query_history` per the semantics block above. Helpers: `matches_search(s: &str, needle: &str) -> bool` (lowercase contains); `file_hit(f, needle)`; `session_folder_hit(s, needle)`; `file_filters_active(filters) -> bool`; per-session reduction builds a clone with `files` reduced + `matched_files` set. `output_folders` sorted via `BTreeSet`. Keep everything pure (no IO) so tests are trivial.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test history`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/history.rs
git commit -m "feat(history): core-side query with filters, summary and pagination"
```

---

### Task 5: Retention trim + clear

**Files:**
- Modify: `src-tauri/src/history.rs`
- Test: `src-tauri/src/history.rs` test module

**Interfaces:**
- Consumes: Task 3 `FoldResult`; Task 2 record structs; `read_lines`; `Settings.history.effective_retention_days()` (Task 1).
- Produces:
  - `pub fn split_by_retention(lines: Vec<String>, retention_days: u32, now_ms: i64) -> (Vec<String>, usize)` — pure; `(kept_lines, dropped_sessions)`; a whole session's lines move together; lines of unknown `type` are kept verbatim; orphan/malformed lines are kept (never dropped by retention).
  - `HistoryStore::trim(&self, retention_days: u32, now_ms: i64) -> Result<u32, String>` — rewrite only when `dropped > 0`; atomic via `history.jsonl.tmp` + `fs::rename`; returns dropped session count.
  - `HistoryStore::clear(&self) -> Result<(), String>` — remove file if present; also remove a stray `.tmp`.

**Retention semantics:** session is dropped when `max(started_at, all file completed_at, ended_at) < now_ms - retention_days * 86_400_000` (strictly older). Missing `session_end` → newest record is max of start + files.

- [ ] **Step 1: Write the failing tests**

Add to the `history.rs` test module:

```rust
    const DAY_MS: i64 = 86_400_000;

    #[test]
    fn trim_keeps_session_exactly_at_boundary() {
        let now = 10 * DAY_MS;
        let lines = vec![
            line(start("old", now - 11 * DAY_MS)),
            line(file("old", "f", now - 11 * DAY_MS + 1, "done", (1, Some(1)))),
            line(start("edge", now - 10 * DAY_MS)),
            line(file("edge", "f", now - 10 * DAY_MS + 1, "done", (1, Some(1)))),
            line(start("fresh", now - 1)),
        ];
        let (kept, dropped) = split_by_retention(lines, 10, now);
        assert_eq!(dropped, 1);
        let out = fold_records(&kept);
        let ids: Vec<&str> = out.sessions.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, vec!["fresh", "edge"]);
    }

    #[test]
    fn trim_counts_files_after_start_for_interrupted_sessions() {
        let now = 10 * DAY_MS;
        let lines = vec![
            line(start("interrupted-old", now - 20 * DAY_MS)),
            line(file("interrupted-old", "f", now - 2 * DAY_MS, "done", (1, Some(1)))),
        ];
        let (_, dropped) = split_by_retention(lines, 10, now);
        assert_eq!(dropped, 0, "newest record (file) is inside the window");
    }

    #[test]
    fn trim_keeps_malformed_and_orphan_lines() {
        let now = 10 * DAY_MS;
        let lines = vec![
            "not json".to_string(),
            line(file("orphan", "f", now - 99 * DAY_MS, "done", (1, Some(1)))),
        ];
        let (kept, dropped) = split_by_retention(lines, 10, now);
        assert_eq!(dropped, 0);
        assert_eq!(kept.len(), 2);
    }

    #[test]
    fn trim_rewrites_only_when_something_drops_and_is_atomic() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        store.append_session_start(&SessionStartRecord {
            session_id: "old".into(), started_at: 0, file_count: 1, output_folder: "/o".into(),
        }).unwrap();
        let dropped = store.trim(1, 100 * DAY_MS).unwrap();
        assert_eq!(dropped, 1);
        assert!(store.load().unwrap().sessions.is_empty());
        assert!(!dir.path().join("history.jsonl.tmp").exists());

        let dropped_again = store.trim(1, 100 * DAY_MS).unwrap();
        assert_eq!(dropped_again, 0);
    }

    #[test]
    fn trim_failure_leaves_original_intact() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("history.jsonl.tmp")).unwrap();
        let store = HistoryStore::new_in(dir.path());
        store.append_session_start(&SessionStartRecord {
            session_id: "old".into(), started_at: 0, file_count: 1, output_folder: "/o".into(),
        }).unwrap();
        let before = store.read_lines().unwrap();
        let err = store.trim(1, 100 * DAY_MS);
        assert!(err.is_err(), "tmp path occupied by a directory ⇒ rewrite fails");
        assert_eq!(store.read_lines().unwrap(), before);
    }

    #[test]
    fn clear_removes_file_and_is_idempotent() {
        let dir = tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        store.append_session_end(&small_end("s1")).unwrap();
        store.clear().unwrap();
        assert!(!store.file_path().exists());
        store.clear().unwrap();
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test history`
Expected: FAIL — `split_by_retention` not defined.

- [ ] **Step 3: Implement**

- `split_by_retention`: first pass parses lines into `(index, type, session_id, newest_ms)`; builds `drop: HashSet<String>` for sessions whose newest < cutoff; second pass keeps lines whose session is not in `drop`, plus all malformed/unknown/orphan lines; `dropped = drop.len()`.
- `HistoryStore::trim`: `lines = read_lines()`; `(kept, dropped) = split_by_retention(...)`; if `dropped == 0` → `Ok(0)`; else write `history.jsonl.tmp` (`create_new` after removing a stale tmp file), `fs::rename(tmp, path)`, errors leave the original untouched; guard with the mutex.
- `HistoryStore::clear`: remove `history.jsonl` (ignore `NotFound`) and any stale `history.jsonl.tmp` (ignore `NotFound`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test history`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/history.rs
git commit -m "feat(history): add 90-day retention trim and clear"
```

---

### Task 6: Queue write integration

**Files:**
- Modify: `src-tauri/src/queue.rs`
- Test: `src-tauri/src/queue.rs` test module

**Interfaces:**
- Consumes: `HistoryStore` (Tasks 2–5); existing `process_batch` / `process_single_job` / `finish_batch`; `CompressionResult`.
- Produces:
  - `FileCompletePayload` gains `quality_used: Option<u32>` and `strategy_used: Option<String>` (camelCase `qualityUsed` / `strategyUsed`) — additive for the frontend.
  - Private `FileRecordFields` accumulator + `struct HistoryCounts { done, best_effort, failed, cancelled, unsupported, already_under_target: u32 }` in `queue.rs` for `session_end`.
  - `fn history_counts_of(files: &[crate::history::FileResultRecord]) -> crate::history::Counts` — pure, maps the six statuses (unknown statuses are not counted).
  - `history:error` event: `{ "message": String }`, emitted **once per batch** on the first write failure.
  - Private helper `fn append_history<R: tauri::Runtime>(app: &AppHandle<R>, record: HistoryRecordRef<'_>) -> Result<(), String>` — resolves `app.try_state::<HistoryStore>()`, missing store → `Ok(())` (tests that don't manage history still pass), write error → first-failure `history:error` emit (per-batch flag in `QueueState`), returns the error.

**Write points:** `process_batch` after preflight passes → `append_session_start` (folder = settings `output_folder`, `file_count = file_ids.len()`). Every terminal outcome in `process_single_job` (done / best-effort / already-under-target, failed, cancelled, unsupported) → `append_file`. Cancel-all skipped files (both the sequential loop and the lane `on_skipped` closure) and the "cancelled while pending" skip paths → `append_file` with `status: "cancelled"`, `output_path: None`, `compressed_size: None`, `duration_ms: 0`. `finish_batch` → `append_session_end` (counts over all recorded file records, `cancelled` = batch was cancelled) then `trim(effective_retention_days, now_ms)`.

- [ ] **Step 1: Write the failing tests**

Add to the `queue.rs` test module (existing harness: `make_app`, `setup_app`, `add_entries`, `wait_idle` — update `make_app` to `.manage(HistoryStore::new_in(root))` so all queue tests exercise history; the store path is the same root as the mock settings store):

```rust
    #[test]
    fn history_counts_map_all_statuses() {
        use crate::history::FileResultRecord;
        let rec = |status: &str| FileResultRecord {
            session_id: "s".into(), file_id: uuid::Uuid::new_v4().to_string(),
            completed_at: 0, name: "a".into(), path: "/a".into(), output_path: None,
            category: "image".into(), target_bytes: 1, original_size: 1,
            compressed_size: None, status: status.into(), quality_used: None,
            strategy_used: None, error: None, duration_ms: 0,
        };
        let files = vec![
            rec("done"), rec("best_effort"), rec("failed"),
            rec("cancelled"), rec("unsupported"), rec("already_under_target"),
            rec("pending"),
        ];
        let counts = history_counts_of(&files);
        assert_eq!(counts.done, 1);
        assert_eq!(counts.best_effort, 1);
        assert_eq!(counts.failed, 1);
        assert_eq!(counts.cancelled, 1);
        assert_eq!(counts.unsupported, 1);
        assert_eq!(counts.already_under_target, 1);
    }

    #[test]
    fn file_complete_payload_carries_strategy_fields() {
        let payload = FileCompletePayload {
            file_id: "f1", output_path: "out".into(), original_size: 2,
            compressed_size: 1, status: FileStatus::Done, met_target: true,
            quality_used: Some(70), strategy_used: Some("quality=70".into()),
        };
        let v = serde_json::to_value(&payload).unwrap();
        assert_eq!(v["qualityUsed"], 70);
        assert_eq!(v["strategyUsed"], "quality=70");
    }

    #[tokio::test]
    async fn failed_batch_writes_session_records() {
        let _temp_guard = temp_guard();
        let (root, app, _out) = setup_app("1");
        let ids = add_entries(&app, &[
            ("a.jpg", crate::models::Category::Image, "/tmp/a.jpg"),
            ("b.jpg", crate::models::Category::Image, "/tmp/b.jpg"),
        ]);
        let rx = events_of(&app.handle(), &["file:error", "batch:complete"]);
        let queue = app.state::<QueueState<tauri::test::MockRuntime>>();
        QueueState::start_batch(queue.inner(), &app.handle(), "hist-1".into(), ids.clone());
        wait_idle(&queue, "hist-1");
        loop {
            let (topic, _) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            if topic == "batch:complete" { break; }
        }

        let store = app.state::<crate::history::HistoryStore>();
        let fold = store.load().unwrap();
        assert_eq!(fold.sessions.len(), 1);
        let s = &fold.sessions[0];
        assert_eq!(s.session_id, "hist-1");
        assert_eq!(s.file_count, 2);
        assert!(!s.interrupted, "session_end must be written by finish_batch");
        assert_eq!(s.outcome.failed, 2, "sidecar-less jobs fail");
        assert_eq!(s.files.len(), 2);
        let _ = root;
    }

    #[tokio::test]
    async fn preflight_failure_writes_nothing() {
        let root = tempfile::TempDir::new().unwrap();
        let blocker = root.path().join("blocker.txt");
        std::fs::write(&blocker, b"x").unwrap();
        let output_folder = blocker.join("child");
        let settings_store = root.path().join("settings.json");
        std::fs::write(
            &settings_store,
            serde_json::json!({ "settings": { "outputFolder": output_folder.to_str().unwrap() } }).to_string(),
        ).unwrap();

        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().app.app_directories_override =
            Some(tauri::utils::config::AppDirectoriesOverride::Root(root.path().to_path_buf()));
        ctx.config_mut().identifier = "com.app.test".into();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .manage(FileListState(std::sync::Mutex::new(Vec::new())))
            .build(ctx)
            .unwrap();
        app.manage(QueueState::new(app.handle().clone()));
        app.manage(crate::history::HistoryStore::new_in(root.path()));

        let entry = crate::models::FileEntry::new("x.jpg", 1024);
        app.state::<FileListState>().0.lock().unwrap().push(entry.clone());
        let queue = app.state::<QueueState<tauri::test::MockRuntime>>();
        QueueState::start_batch(queue.inner(), &app.handle(), "preflight".into(), vec![entry.id.clone()]);
        wait_idle(&queue, "preflight");

        let store = app.state::<crate::history::HistoryStore>();
        assert!(store.load().unwrap().sessions.is_empty(), "no phantom session");
    }

    #[tokio::test]
    async fn cancel_all_records_cancelled_files() {
        let _temp_guard = temp_guard();
        let (_root, app, _out) = setup_app("3");
        let ids = add_entries(&app, &[
            ("i1.jpg", crate::models::Category::Image, "/tmp/i1.jpg"),
            ("i2.jpg", crate::models::Category::Image, "/tmp/i2.jpg"),
            ("p1.pdf", crate::models::Category::Pdf, "/tmp/p1.pdf"),
        ]);
        let rx = events_of(&app.handle(), &["file:error", "file:cancelled", "batch:complete"]);
        let queue = app.state::<QueueState<tauri::test::MockRuntime>>();
        QueueState::start_batch(queue.inner(), &app.handle(), "hist-cancel".into(), ids.clone());
        let (topic, _) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(topic, "file:error");
        queue.cancel_all();
        wait_idle(&queue, "hist-cancel");
        loop {
            let (topic, _) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            if topic == "batch:complete" { break; }
        }

        let store = app.state::<crate::history::HistoryStore>();
        let fold = store.load().unwrap();
        let s = &fold.sessions[0];
        assert_eq!(s.files.len(), 3, "every file terminal outcome recorded once");
        assert!(s.files.iter().any(|f| f.status == "failed"));
        assert!(s.files.iter().any(|f| f.status == "cancelled"));
        assert_eq!(s.outcome.failed + s.outcome.cancelled, 3);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test queue`
Expected: FAIL — `history_counts_of` not defined / history assertions fail.

- [ ] **Step 3: Implement**

In `queue.rs`:
- Import `crate::history::{...}`; add `use tauri::Manager;` for `try_state` (already imported).
- Add `quality_used: Option<u32>, strategy_used: Option<String>` to `FileCompletePayload`; fill from `compression_result.quality_used` / `.strategy_used` for successful jobs; `None` everywhere else.
- Accumulator: thread-safe per batch — add to `QueueState`: `history_counts: Mutex<HashMap<String, Vec<crate::history::FileResultRecord>>>` keyed by batch id; worker pushes each recorded file record there; `finish_batch` drains the vector, computes `history_counts_of`, writes `session_end`, calls `trim` with `crate::settings::Settings` loaded from `load_settings(app)` (call `load_settings` in `finish_batch`; it is already pub).
- `history:error` once-per-batch: add `history_error_sent: Mutex<HashSet<String>>` keyed by batch id; helper clears entries on `finish_batch`.
- `duration_ms`: measure `std::time::Instant::now()` at job start, `elapsed().as_millis() as u64` at each terminal outcome.
- Unsupported branch currently returns before the generic match — record there too (`status "unsupported"`, no sizes/output).
- Cancel-skip paths: sequential loop cancel-all branch, lane `on_skipped`, and the two "cancelled while pending" guards in `process_single_job` → record `cancelled` with original sizes from the entry.
- Wrap helper: `fn record_file<R: Runtime>(app, batch_id, entry, status, output_path, compressed_size, quality_used, strategy_used, error, duration_ms)` builds the record, pushes to the accumulator, appends.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test queue`
Expected: PASS (existing + new).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/queue.rs
git commit -m "feat(queue): record session, file and end records to history"
```

---

### Task 7: `get_history` / `clear_history` / `open_folder` commands

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`
- Test: `src-tauri/src/commands.rs` test module (pure pieces), existing Rust patterns for command wiring

**Interfaces:**
- Consumes: `HistoryStore` (Tasks 2–5), `query_history` (Task 4).
- Produces:
  - `pub async fn get_history(filters: crate::history::HistoryFilters, page: u32, page_size: u32, app: tauri::AppHandle) -> Result<crate::history::HistoryResponse, String>` — clamps `page_size` to `1..=200` (0 → 50); folds + queries; missing store → all-empty `HistoryResponse`.
  - `pub fn clear_history(app: tauri::AppHandle) -> Result<(), String>`
  - `pub fn open_folder(path: String, app: tauri::AppHandle) -> Result<(), String>` — `opener().open_path`, error copy `Could not open folder {path}: {e}`
  - `lib.rs`: `mod history;`, manage `HistoryStore` in setup (`HistoryStore::new(app.handle())` — falls back to a store under `app_data_dir`; if app_data_dir is unavailable, log + skip managing, and Task 8's missing-store paths keep the app functional), register the three commands, and run startup `trim` via `settings.history.effective_retention_days()` + `now_ms`.
  - `HistoryStore::new<R: Runtime>(app: &AppHandle<R>) -> Result<HistoryStore, String>` — `app.path().app_data_dir()` + `create_dir_all`.

- [ ] **Step 1: Write the failing tests**

In `commands.rs` test module (pure):

```rust
    #[test]
    fn page_size_clamps_helper() {
        assert_eq!(clamp_page_size(0), 50);
        assert_eq!(clamp_page_size(1), 1);
        assert_eq!(clamp_page_size(200), 200);
        assert_eq!(clamp_page_size(201), 200);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test commands`
Expected: FAIL — `clamp_page_size` not defined.

- [ ] **Step 3: Implement**

- `fn clamp_page_size(n: u32) -> u32` (private, tested); `get_history` uses it.
- `get_history`: `app.try_state::<HistoryStore>()` → `None` ⇒ `Ok(empty_response(page, clamped))`; `Some(store)` ⇒ `fold = store.load()?` then `Ok(query_history(fold, &filters, page, clamped))`. Mark `async` and keep the body synchronous (async command runs off the main thread).
- `clear_history` / `open_folder` as above; `open_folder` reuses the plugin (`tauri_plugin_opener::OpenerExt`), matching `reveal_in_folder` error style (`commands.rs:232-237`).
- `lib.rs`: add `mod history;` (Task 2 added the declaration — confirm it exists once), `use history::HistoryStore`, manage in setup after `QueueState`, call `trim` right after managing (log `dropped` at debug via `eprintln!` only on error), register commands in `invoke_handler`.
- Empty response helper: `HistoryResponse { sessions: vec![], page: 0, page_size: clamped, total_sessions: 0, total_files: 0, summary: HistorySummary::default(), output_folders: vec![], skipped_lines: 0 }` (`HistorySummary` derives `Default`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test commands && cargo test history`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs
git commit -m "feat(ipc): add get_history, clear_history and open_folder commands"
```

---

### Task 8: Frontend types, hook, helpers

**Files:**
- Modify: `src/types.ts`
- Create: `src/hooks/useHistory.ts`, `src/lib/historyFormat.ts`
- Test: `src/hooks/useHistory.test.ts`, `src/lib/historyFormat.test.ts`

**Interfaces:**
- Produces (types, matching Rust §):
  - `HistoryFile { name, path, outputPath: string | null, category: Category, targetBytes, originalSize: number, compressedSize: number | null, status: FileStatus, qualityUsed: number | null, strategyUsed: string | null, error: string | null, durationMs: number, completedAt: number }`
  - `HistorySession { sessionId, startedAt, endedAt: number | null, outputFolder, fileCount, files: HistoryFile[], outcome: SessionOutcome, totalSavedBytes, cancelled, interrupted, matchedFiles: number | null }` where `SessionOutcome` mirrors Rust's `Counts` (`{ done, bestEffort, failed, cancelled, unsupported, alreadyUnderTarget }` — all `number`)
  - `HistoryFilters { search?: string; statuses?: FileStatus[]; categories?: Category[]; sinceMs?: number; outputFolder?: string }`
  - `HistorySummary { sessions, files, savedBytes, failedFiles }`
  - `HistoryResponse { sessions: HistorySession[]; page; pageSize; totalSessions; totalFiles; summary: HistorySummary; outputFolders: string[]; skippedLines: number }`
- `useHistory()` → `{ response, loading, error, filters, setFilters, page, setPage, refresh, clearHistory, clearError }`:
  - `setFilters(partial)` merges and resets page to 0 (functional compare — no-op when unchanged keeps identity).
  - Query on mount, on `filters`/`page` change, on manual `refresh`, and on `batch:complete` (listen; unlisten on unmount). Debounce search input updates 300 ms **in the component** (hook receives settled values).
  - `history:error` listener → `toast.error('History could not be saved — compression was not affected.')`.
  - `clearHistory` invokes `clear_history`, then `refresh()`; on failure `toast.error('Could not clear history')` + rethrow suppressed.
  - `clearError()` resets the error banner state for Retry.
- `src/lib/historyFormat.ts`:
  - `export function formatDuration(ms: number): string` — `<1s` → `1s`-style: `45s`, `1m 42s`, `2h 05m`; 0 → `—`.
  - `export function presetSinceMs(preset: 'today' | 'last7' | 'last30' | 'all', now: Date): number | undefined` — `all` → `undefined`; else local midnight of the range start (today = `new Date(y,m,d)`; last7 = today − 6 days; last30 = today − 29 days).
  - `export function dayKey(ms: number): string` and `export function dayLabel(ms: number, now: Date): string` — `Today` / `Yesterday` / localized date via `Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: ... })` (year omitted in the current year).
  - Reuse `formatSize` from `@/components/FileList` for all size rendering (import where needed).

- [ ] **Step 1: Write the failing tests**

`src/lib/historyFormat.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatDuration, presetSinceMs, dayLabel } from '@/lib/historyFormat'

describe('historyFormat', () => {
  it('formats durations', () => {
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(102_000)).toBe('1m 42s')
    expect(formatDuration(7_500_000)).toBe('2h 05m')
  })

  it('maps presets to local midnights', () => {
    const now = new Date(2026, 9, 2, 14, 30)
    const today = new Date(2026, 9, 2).getTime()
    expect(presetSinceMs('today', now)).toBe(today)
    expect(presetSinceMs('last7', now)).toBe(new Date(2026, 8, 26).getTime())
    expect(presetSinceMs('last30', now)).toBe(new Date(2026, 8, 3).getTime())
    expect(presetSinceMs('all', now)).toBeUndefined()
  })

  it('labels today and yesterday', () => {
    const now = new Date(2026, 9, 2, 14, 30)
    expect(dayLabel(new Date(2026, 9, 2, 9, 0).getTime(), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 9, 1, 9, 0).getTime(), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 8, 20).getTime(), now)).toMatch(/Sep/)
  })
})
```

`src/hooks/useHistory.test.ts` (mock `@tauri-apps/api/core` + `@tauri-apps/api/event` + `sonner`, same registry pattern as `useCompression.test.ts:7-28`):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const registry = new Map<string, Set<(e: { payload: unknown }) => void>>()
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    if (!registry.has(event)) registry.set(event, new Set())
    registry.get(event)!.add(handler)
    return Promise.resolve(vi.fn(() => registry.get(event)?.delete(handler)))
  }),
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { useHistory } from '@/hooks/useHistory'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'

const emptyResponse = {
  sessions: [], page: 0, pageSize: 50, totalSessions: 0, totalFiles: 0,
  summary: { sessions: 0, files: 0, savedBytes: 0, failedFiles: 0 },
  outputFolders: [], skippedLines: 0,
}

const emit = (event: string, payload: unknown) =>
  act(() => { registry.get(event)?.forEach((h) => h({ payload })) })

beforeEach(() => {
  vi.clearAllMocks()
  registry.clear()
})

describe('useHistory', () => {
  it('loads on mount', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(invoke).toHaveBeenCalledWith('get_history', {
      filters: {}, page: 0, pageSize: 50,
    })
    expect(result.current.response?.totalSessions).toBe(0)
  })

  it('setFilters merges and resets page', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    act(() => result.current.setPage(2))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('get_history', expect.objectContaining({ page: 2 })))
    act(() => result.current.setFilters({ search: 'abc' }))
    await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('get_history', expect.objectContaining({ page: 0, filters: { search: 'abc' } })))
  })

  it('refetches on batch:complete', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    const calls = vi.mocked(invoke).mock.calls.length
    emit('batch:complete', { batchId: 'b', totalSavedBytes: 0 })
    await waitFor(() => expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(calls))
  })

  it('toasts on history:error', async () => {
    vi.mocked(invoke).mockResolvedValue(emptyResponse)
    renderHook(() => useHistory())
    await waitFor(() => expect(registry.get('history:error')?.size).toBe(1))
    emit('history:error', { message: 'disk full' })
    expect(toast.error).toHaveBeenCalledWith('History could not be saved — compression was not affected.')
  })

  it('surfaces load errors and clearHistory refetches', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(emptyResponse)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...emptyResponse, skippedLines: 2 })
    const { result } = renderHook(() => useHistory())
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => { await result.current.clearHistory() })
    expect(invoke).toHaveBeenCalledWith('clear_history')
    await waitFor(() => expect(result.current.response?.skippedLines).toBe(2))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test historyFormat useHistory`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

- `src/types.ts`: add the interfaces exactly as in Interfaces above (GPL header already present; append at the end).
- `src/hooks/useHistory.ts`: state `response/loading/error/filters/page`; effect keyed on `JSON.stringify({filters, page})` invoking `get_history` (cancelled-flag guard like `useSettings.ts:37-58`); one effect for listeners (`batch:complete` → refetch, `history:error` → toast) with the disposed/unlisten pattern from `useCompression.ts:79-185`; `refresh` bumps a numeric nonce included in the effect key.
- `src/lib/historyFormat.ts`: pure helpers as specified; use `toLocaleDateString`/`Intl.DateTimeFormat` for labels. Add the GPL header to both new TS files (copy from `src/views/HistoryView.tsx:1-15`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test historyFormat useHistory && yarn build`
Expected: PASS + clean build.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/hooks/useHistory.ts src/hooks/useHistory.test.ts src/lib/historyFormat.ts src/lib/historyFormat.test.ts
git commit -m "feat(history): add frontend types, query hook and format helpers"
```

---

### Task 9: History view UI

**Files:**
- Rewrite: `src/views/HistoryView.tsx`
- Create: `src/components/HistoryPagination.tsx`
- Modify: `src/App.test.tsx` (empty-state selector still valid), `src/views/HistoryView.test.tsx` (rewrite for new UI)
- Components: `src/components/ui/alert-dialog.tsx` via `yarn dlx shadcn@latest add alert-dialog`

**Interfaces:**
- Consumes: `useHistory`, `HistorySession`, `HistoryFile`, `formatSize`, `historyFormat` helpers, existing `Table`, `Badge`, `Button`, `Select`, `Skeleton`, `Empty`, `Card`, `Input` (create if missing: `src/components/ui/input.tsx` already exists per file list — reuse).
- Produces: exported `HistoryView` (same name/signature, App.tsx unchanged), `HistoryPagination` component.

**UI composition (spec §5):**
- Filter bar (pinned): search `Input` (placeholder "Search name, path, error…", Esc clears), Status chips (6 toggle buttons, `aria-pressed`), Category chips (5), Date `Select` (4 presets, default All time), Output folder `Select` (options from `response.outputFolders`, plus an "All folders" reset), `Clear filters` button + active count when any filter set.
- Summary line (pinned): from `response.summary` — `{sessions} sessions · {files} files · {saved} saved · {failed} failed`; `Clear history` button (destructive ghost) → `AlertDialog` confirm (title "Clear history?", body "Permanently deletes all compression history. Files on disk are not affected.", confirm button "Delete history") → `clearHistory`.
- `skippedLines > 0` → muted notice line above the list.
- Session list: sticky day headers (`dayLabel`), each session = disclosure `<button aria-expanded aria-controls aria-label="Toggle session details">` row: time (`Intl`), `fileCount`/`N matches` label, `original → compressed` (Σ original, Σ compressed over displayed files), `% saved`, `formatDuration(endedAt - startedAt)` (or `—` when interrupted), Interrupted/Cancelled chip, outcome chips (icon + text; count from `outcome` filtered to displayed files when `matchedFiles != null`), `Open output folder` icon button (disabled when no file has `outputPath`).
- Expanded file table (semantic `<table>`): File (name + muted parent dir, title = full path), Type badge, Status → reuse status presentation (copy the label/style maps or export from FileList — do **not** refactor FileList), Target (`formatSize`), Result (`x → y · z%` or `—`), error inline under name in destructive text, Actions: reveal output (disabled without `outputPath`), copy output path, reveal source, copy source path — each `aria-label`ed; copy uses `navigator.clipboard.writeText` + `toast.success('Path copied')`.
- Auto-expand: sessions with `matchedFiles != null` start expanded; user toggles override per session id (state map reset when `response` identity changes).
- Pagination footer: `HistoryPagination { page, pageSize, totalSessions, onPageChange }` → `Page X of Y` + Prev/Next (disabled bounds).
- States: loading → 3 skeleton rows; error → card + Retry (`clearError` + `refresh`); empty (no filters, zero sessions) → existing Empty card copy "Compressed files and their results will appear here."; no matches → Empty "No matches" + `Clear filters`.

- [ ] **Step 1: Write the failing tests**

Rewrite `src/views/HistoryView.test.tsx` (GPL header + mock `@tauri-apps/api/core`/`event`/`sonner` like Task 8; helper `session(overrides)` builds a `HistorySession`; `renderView()` renders `<HistoryView />`):

```tsx
  it('renders empty state when history is empty', async () => {
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    expect(await screen.findByText('No history yet')).toBeInTheDocument()
  })

  it('renders a session row with outcome chips and metrics', async () => {
    invokeMock.mockResolvedValue(responseWith(session({ sessionId: 's1' })))
    renderView()
    expect(await screen.findByText(/files? ·/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Toggle session details' })[0])
      .toHaveAttribute('aria-expanded', 'false')
  })

  it('expands on keyboard and shows the file table with inline errors', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(responseWith(session({ sessionId: 's1', files: [failedFile()] })))
    renderView()
    const toggle = (await screen.findAllByRole('button', { name: 'Toggle session details' }))[0]
    toggle.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('table')).toBeInTheDocument()
    expect(screen.getByText('Cannot read file: locked')).toBeInTheDocument()
  })

  it('shows Interrupted chip for interrupted sessions', async () => {
    invokeMock.mockResolvedValue(responseWith(session({ interrupted: true, endedAt: null })))
    renderView()
    expect(await screen.findByText('Interrupted')).toBeInTheDocument()
  })

  it('search input debounces into a filtered query', async () => {
    vi.useFakeTimers()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).type(screen.getByRole('textbox', { name: /search/i }), 'photo')
    await act(async () => { await vi.advanceTimersByTimeAsync(300) })
    expect(invokeMock).toHaveBeenLastCalledWith('get_history', expect.objectContaining({ filters: { search: 'photo' }, page: 0 }))
    vi.useRealTimers()
  })

  it('renders pagination and requests next page', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue({ ...responseWith(session({ sessionId: 's1' })), totalSessions: 120 })
    renderView()
    expect(await screen.findByText('Page 1 of 3')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /next/i }))
    expect(invokeMock).toHaveBeenLastCalledWith('get_history', expect.objectContaining({ page: 1 }))
  })

  it('auto-expands filtered sessions with match count', async () => {
    invokeMock.mockResolvedValue(responseWith(session({ sessionId: 's1', matchedFiles: 1, files: [doneFile()] })))
    renderView()
    expect(await screen.findByText('1 match')).toBeInTheDocument()
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('clear history confirms before invoking', async () => {
    const user = userEvent.setup()
    invokeMock.mockResolvedValue(emptyResponse)
    renderView()
    await user.click(await screen.findByRole('button', { name: /clear history/i }))
    await user.click(screen.getByRole('button', { name: /delete history/i }))
    expect(invokeMock).toHaveBeenCalledWith('clear_history')
  })

  it('shows a notice when lines were skipped', async () => {
    invokeMock.mockResolvedValue({ ...emptyResponse, skippedLines: 3 })
    renderView()
    expect(await screen.findByText(/could not be read/i)).toBeInTheDocument()
  })
```

Also update the old `renders history empty state` test (keeps asserting `[data-slot="empty"]` with new copy) and check `src/App.test.tsx:122-124` still passes (History heading removed by design — it asserts absence, so it should pass).

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test HistoryView`
Expected: FAIL — new UI not implemented.

- [ ] **Step 3: Implement**

- `yarn dlx shadcn@latest add alert-dialog` then adapt to base-ui composition if the CLI emits Radix-style (existing repo components are base-ui — follow `dropdown-menu.tsx` patterns).
- Add a small `copyToClipboard(text: string)` helper inside `HistoryView.tsx` (`navigator.clipboard.writeText` → toast; catch → `toast.error('Could not copy path')`).
- Build the view per composition above; keep files focused: session row + file table in `HistoryView.tsx` (single consumer today), pagination in its own component file.
- Status chip styling: reuse the dot+label pattern from `FileList.tsx:67-104` by copying the maps into the view (no FileList refactor — YAGNI).
- A11y: disclosure buttons get `aria-expanded`/`aria-controls`; day headers non-interactive; every icon button labelled; table has a `<caption className="sr-only">` or `aria-label`; chips are `<button aria-pressed>`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test HistoryView && yarn build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/HistoryView.tsx src/views/HistoryView.test.tsx src/components/HistoryPagination.tsx src/components/ui/alert-dialog.tsx src/App.test.tsx
git commit -m "feat(history): build filterable session list UI with pagination"
```

---

### Task 10: Settings History card

**Files:**
- Modify: `src/views/SettingsView.tsx`, `src/views/SettingsView.test.tsx`, `src/hooks/useSettings.test.ts` (only if the fixture Settings object is typed — add `history`)
- Test: `src/views/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `Settings.history.retentionDays` (type in Task 8's `types.ts` update: add `history: { retentionDays: number }` to `Settings`), existing `NumberStepper`, `Card` composition (`SettingsView.tsx:268-401`).
- Produces: new **History** card (between Quality Floors and the footer) with `NumberStepper` min 1 max 3650 + description; `updateHistoryRetention` draft updater.

- [ ] **Step 1: Write the failing tests**

Add to `SettingsView.test.tsx` (follow its existing `loadView()`/`pickOption` patterns; fixture settings include `history: { retentionDays: 90 }`):

```tsx
  it('saves a changed history retention value', async () => {
    const user = userEvent.setup()
    await loadView()
    const input = screen.getByLabelText('History retention (days)')
    expect(input).toHaveValue(90)
    await user.clear(input)
    await user.type(input, '30')
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    expect(invoke).toHaveBeenCalledWith('save_settings', expect.objectContaining({
      settings: expect.objectContaining({ history: { retentionDays: 30 } }),
    }))
  })

  it('clamps history retention through the stepper bounds', async () => {
    const user = userEvent.setup()
    await loadView()
    await user.click(screen.getByRole('button', { name: /increase history retention/i }))
    expect(screen.getByLabelText('History retention (days)')).toHaveValue(91)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test SettingsView`
Expected: FAIL — no History retention control.

- [ ] **Step 3: Implement**

- Add the History card after the Quality Floors card; wire `NumberStepper` with `id="history-retention-days"`, `ariaLabel="History retention (days)"`, `min={1}`, `max={3650}`, `updateHistoryRetention` writes `draft.history.retentionDays`.
- Update `types.ts` `Settings` with `history: { retentionDays: number }` and any SettingsView fixtures.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test SettingsView && yarn build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/SettingsView.tsx src/views/SettingsView.test.tsx src/types.ts src/hooks/useSettings.test.ts
git commit -m "feat(settings): add history retention control"
```

---

### Task 11: Acceptance — end-to-end verification pass

**Files:**
- Create: `docs/superpowers/plans/2026-10-02-history-audit-trail-acceptance-table.md`

This task is **verification only** — no production code changes. It runs the spec's acceptance criteria against the built app and records evidence. Use `yarn tauri dev`.

- [ ] **Step 1: Gate**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: all green.

- [ ] **Step 2: Manual pass (record evidence per row)**

| # | Spec AC | How to prove | Result |
|---|---|---|---|
| 1 | Batch appears without restart | Compress 2+ files → open History → session present, counts/sizes match | |
| 2 | Interrupted after force-kill | Start large batch → `kill -9` the app → relaunch → Interrupted with finished files only | |
| 3 | Filters over full history | Seed >50 sessions (or lower page size temporarily in dev) → search older-than-page-1 file → result appears; summary stays page-independent | |
| 4 | Reveal/copy actions | Reveal + copy source/output; moved file → reveal error toast, copy still works | |
| 5 | Retention + clear | Set retention 1 day → relaunch → old sessions gone; Clear history wipes after confirm | |
| 6 | Corrupt lines tolerated | Append `garbage` + unknown-type line manually → app loads, notice shows count | |
| 7 | Keyboard-only flow | Tab through filter bar → toggle chips → expand session → paginate → activate action | |
| 8 | Compression unchanged | Full gate green; compress a mixed batch and compare events/toasts to pre-change behavior | |

- [ ] **Step 3: Write the acceptance table file with evidence + deviations**

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-10-02-history-audit-trail-acceptance-table.md
git commit -m "docs(history): record acceptance evidence for history audit trail"
```

---

## Self-Review Notes

- Spec §3.1–3.7 → Tasks 2–5; §4.1 → Task 6; §4.2 → Task 7; §4.3 → Tasks 1 + 10; §5 → Tasks 8–9; §6 → tests inside every task + Task 11; §7 ACs → Task 11 table.
- `HistoryStore` stays Runtime-generic (`new_in` takes a path for tests; `new` takes `&AppHandle<R>`) so queue MockRuntime tests can manage it.
- Task 6's helper resolves the store via `try_state` — queue tests that predate history keep passing without managing one, while the updated `make_app` exercises it deliberately.
- Date presets: webview computes `sinceMs` (local midnight); Rust compares inclusively — no new dependency, correct DST.
