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
- **Corrupt/foreign lines** — malformed lines are skipped + counted (shown as a notice); unknown-`type` lines are ignored silently for forward compatibility.
- **Filter × pagination interaction** — any filter change resets to page 0; totals/summary stay page-independent; a session row is never split across pages.
- **Missing/changed files** — copy path always works; reveal/open-folder degrade gracefully with a toast.

---

### Task 1: History settings — `history.retentionDays`

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Test: existing `src-tauri/src/settings.rs` test module

**Interfaces:**
- Consumes: existing `Settings` struct + `parse_settings_value` fallback pattern (`settings.rs:266-273`).
- Produces: `Settings.history: HistorySettings` with `retention_days: u32`, defaulted to 90 on missing/empty; corrupt values fall back to whole-Settings defaults (existing convention); `HistorySettings::effective_retention_days(&self) -> u32` clamping to `1..=3650` with 90 fallback for 0. Consumers: Tasks 6, 7, 11 call `effective_retention_days()`; Tasks 8, 10 carry `Settings.history` over IPC.

**Acceptance Criteria:**
- `history.retentionDays` roundtrips camelCase; max value 3650 roundtrips (spec §4.3).
- Missing/empty (`{}`) `history` resolves to 90 while other settings are preserved; corrupt `history` falls back to whole-Settings defaults (existing corrupt-value convention) (spec §4.3, §5.8).
- Clamp pinned including off-by-one neighbors: 0→90, 3649→3649, 3651→3650, 5000→3650 (spec §3.6).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `history_retention_defaults_to_90` — `Settings::default().history.retention_days == 90`
- `history_serde_roundtrip_camel_case` — serialized JSON contains `history.retentionDays`; roundtrip equal
- `history_retention_max_roundtrips` — 3650 survives a serialize/deserialize roundtrip
- `parse_settings_value_missing_history_fills_default` — `{ "outputFolder": "/tmp/out" }` → 90
- `parse_settings_value_empty_history_fills_default` — `{ "history": {} }` → 90 with `outputFolder` preserved (spec "old settings keep loading")
- `parse_settings_value_corrupt_history_fills_default` — `{ "history": { "retentionDays": "lots" } }` → whole Settings falls back to defaults (existing corrupt-value convention)
- `parse_settings_value_in_range_history_value_parses` — `{ "history": { "retentionDays": 30 } }` → 30
- `parse_settings_value_null_history_whole_settings_defaults` — `{ "history": null }` → whole Settings defaults
- `effective_retention_days_clamps` — 0→90, 1→1, 90→90, 3649→3649, 3650→3650, 3651→3650, 5000→3650
- `parse_history_effective_retention_integration_pins` — parse `{ "history": { "retentionDays": 5000 } }` → raw 5000 / effective 3650; parse `0` → effective 90

- [x] **Step 1: Write the failing tests**

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
    fn history_retention_max_roundtrips() {
        let mut s = Settings::default();
        s.history.retention_days = 3650;
        let value = serde_json::to_value(&s).unwrap();
        let roundtripped: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(roundtripped.history.retention_days, 3650);
    }

    #[test]
    fn parse_settings_value_missing_history_fills_default() {
        let parsed = parse_settings_value(Some(serde_json::json!({ "outputFolder": "/tmp/out" })));
        assert_eq!(parsed.history.retention_days, 90);
        assert_eq!(parsed.output_folder, "/tmp/out", "other settings preserved");
    }

    #[test]
    fn parse_settings_value_empty_history_fills_default() {
        let parsed = parse_settings_value(Some(serde_json::json!({
            "outputFolder": "/tmp/out",
            "history": {}
        })));
        assert_eq!(parsed.history.retention_days, 90);
        assert_eq!(parsed.output_folder, "/tmp/out", "other settings preserved");
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
    fn parse_settings_value_in_range_history_value_parses() {
        let parsed =
            parse_settings_value(Some(serde_json::json!({"history": {"retentionDays": 30}})));
        assert_eq!(parsed.history.retention_days, 30);
    }

    #[test]
    fn parse_settings_value_null_history_whole_settings_defaults() {
        let with_null = serde_json::json!({
            "outputFolder": "/tmp/out",
            "history": null
        });
        assert_eq!(parse_settings_value(Some(with_null)), Settings::default());
    }

    #[test]
    fn parse_history_effective_retention_integration_pins() {
        let parsed = parse_settings_value(Some(
            serde_json::json!({"history": {"retentionDays": 5000}}),
        ));
        assert_eq!(parsed.history.retention_days, 5000);
        assert_eq!(parsed.history.effective_retention_days(), 3650);

        let zero = parse_settings_value(Some(serde_json::json!({"history": {"retentionDays": 0}})));
        assert_eq!(zero.history.retention_days, 0);
        assert_eq!(zero.history.effective_retention_days(), 90);
    }

    #[test]
    fn effective_retention_days_clamps() {
        for (raw, want) in [
            (0u32, 90u32),
            (1, 1),
            (90, 90),
            (3649, 3649),
            (3650, 3650),
            (3651, 3650),
            (5000, 3650),
        ] {
            let mut s = Settings::default();
            s.history.retention_days = raw;
            assert_eq!(s.history.effective_retention_days(), want, "raw={raw}");
        }
    }
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test settings`
Expected: FAIL — no field `history` on `Settings`.

- [x] **Step 3: Implement**

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
        let raw = self.retention_days;
        let effective = if raw == 0 {
            default_retention_days()
        } else {
            raw.clamp(1, 3650)
        };
        if raw != effective {
            eprintln!("warn: invalid history.retentionDays {raw}, using {effective}");
        }
        effective
    }
}
```

Extend `Settings` with `#[serde(default)] pub history: HistorySettings,` (after `performance`), extend `Settings::default()` with `history: HistorySettings::default(),`.

Also update `parse_settings_value` so the serde error is logged (it currently discards it):
`eprintln!("warn: settings parse failed, using defaults: {e}");` inside the `unwrap_or_else` closure, then fall back to `Settings::default()`.

- [x] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test settings`
Expected: PASS (all).

- [x] **Step 5: Commit**

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
- Consumes: GPL header pattern; no new deps.
- Produces (all `pub` unless noted):
  - `SessionStartRecord { session_id: String, started_at: i64, file_count: usize, output_folder: String }` — camelCase serde
  - `FileResultRecord { session_id: String, file_id: String, completed_at: i64, name: String, path: String, output_path: Option<String>, category: String, target_bytes: u64, original_size: u64, compressed_size: Option<u64>, status: String, quality_used: Option<u32>, strategy_used: Option<String>, error: Option<String>, duration_ms: u64 }`
  - `SessionEndRecord { session_id: String, ended_at: i64, total_saved_bytes: u64, counts: Counts, cancelled: bool }`
  - `Counts { done: u32, best_effort: u32, failed: u32, cancelled: u32, unsupported: u32, already_under_target: u32 }` — camelCase
  - `HistoryStore::new_in(dir: &Path) -> HistoryStore` — path is `dir/history.jsonl`
  - `HistoryStore::file_path(&self) -> &Path` — `pub(crate)` (test accessor)
  - `HistoryStore::append_session_start / append_file / append_session_end -> Result<(), String>`
  - `HistoryStore::read_lines(&self) -> Result<Vec<String>, String>` (pub(crate); `Ok(vec![])` when the file does not exist)
  - `pub(crate) enum HistoryRecordRef<'a>::{SessionStart(&SessionStartRecord), File(&FileResultRecord), SessionEnd(&SessionEndRecord)}` — the single "type"-tagged serializer used by all three append methods (Task 6's helper takes `&HistoryRecordRef<'_>`; it must be `pub(crate)`, not private, because `queue.rs` is another module)

**Acceptance Criteria:**
- `new_in(dir)` resolves to `dir/history.jsonl`; append creates missing parent dirs and appends exactly one compact JSON line per call under a mutex (spec §3.1).
- Records serialize exactly as spec §3.2 with camelCase keys and `type` discriminator `session_start` / `file` / `session_end`; optional fields serialize as `null` (spec §3.2 field notes).
- `read_lines` returns `Ok(vec![])` for a missing file, filters blank lines, and returns `Err` (not panic, not empty) for IO failures — the error drives the UI error card (spec §5.6).
- Concurrent appends from two threads produce 2N parseable, non-interleaved lines (spec §3.4 mutex guarantee).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `append_session_start_writes_camel_case_line` — tag + camelCase keys + values
- `append_file_serializes_optional_fields_as_null` — nulls for outputPath/compressedSize; status verbatim
- `append_session_end_writes_counts_and_cancelled` — camelCase counts keys (`bestEffort`, `alreadyUnderTarget`)
- `read_lines_missing_file_returns_empty` — fresh store → `Ok(vec![])`
- `read_lines_skips_blank_lines` — file ending `\n\n` / containing a blank line → no empty entries
- `read_lines_io_error_returns_err` — `history.jsonl` replaced by a directory → `Err`, not `Ok(vec![])`
- `append_creates_parent_directories` — `new_in(dir/a/b)` + append succeeds
- `append_propagates_write_error` — `history.jsonl` occupied by a directory → `Err` starting `history write failed:`, no panic
- `append_creates_file_and_appends_in_order` — two appends → two ordered lines
- `append_session_end_roundtrips` — append → read → deserialize `SessionEndRecord` equal
- `concurrent_appends_keep_lines_intact` — 2 threads × 25 large appends → 50 parseable lines, every session id present exactly once
- `append_repairs_missing_trailing_newline` — raw partial line without trailing `\n` → append → both lines readable, new record intact
- `append_writes_single_terminated_line` — raw file bytes end with exactly one `\n` on every append
- `read_lines_tolerates_invalid_utf8_bytes` — valid line + invalid UTF-8 bytes + valid line → `Ok` with 3 entries
- `read_lines_trims_whitespace_around_lines` — blank-ish `"  "` line + JSON record padded with spaces/CRLF → only the trimmed JSON line; `load` skips 0
- `read_during_write_never_sees_torn_line` — reader loop during concurrent large appends → every returned line parses as JSON
- `record_schema_keys_are_pinned` — golden sorted key lists for session_start/file/session_end + Counts
- `append_and_read_roundtrip_unicode_paths` — café/漢字/😀 in names, paths and errors roundtrip
- `append_blocks_until_lock_released` — holding `store.lock` blocks a spawned append until release (direct mutual-exclusion check)
- `read_lines_blocks_until_lock_released` — holding `store.lock` blocks a spawned `read_lines` until release
- `write_failure_surfaces_write_stage_error` — read-only handle → `write_terminated` → `Err` starting `history write failed: write `

- [x] **Step 1: Write the failing tests**

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
```

Plus a test-module helper:

```rust
    fn small_end(session_id: &str) -> SessionEndRecord {
        SessionEndRecord {
            session_id: session_id.into(),
            ended_at: 0,
            total_saved_bytes: 0,
            counts: Counts::default(),
            cancelled: false,
        }
    }
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test history`
Expected: FAIL — `HistoryStore` not defined.

- [x] **Step 3: Implement**

In `src-tauri/src/history.rs` (above the test module), implement:

- The four record structs (`SessionStartRecord`, `FileResultRecord`, `SessionEndRecord`, `Counts`) with `#[serde(rename_all = "camelCase")]` + `Serialize, Deserialize, Debug, Clone`. `Counts` derives `Default`; `SessionStartRecord`/`SessionEndRecord`/`FileResultRecord`/`Counts` derive `PartialEq` for test equality.
- `HistoryStore { path: PathBuf, lock: Mutex<()> }` with `new_in(dir)` = `dir.join("history.jsonl")`, `pub(crate)` `file_path()` accessor. Lock acquisition goes through the private `poison_recover` helper, which logs `warn: history mutex was poisoned, recovering: {e}` to stderr and recovers the guard via `into_inner()` instead of panicking; every `lock()` call site (append/read/trim/clear) uses it.
- Record-level serialization discriminator: a `pub(crate)` `#[derive(Serialize)] #[serde(tag = "type", rename_all = "snake_case")] enum HistoryRecordRef<'a> { SessionStart(&'a SessionStartRecord), File(&'a FileResultRecord), SessionEnd(&'a SessionEndRecord) }` so the `"type"` tag lives in exactly one place and `queue.rs` (Task 6) can name the type. `append()` serializes `HistoryRecordRef` to a compact line, creates parent dirs (`create_dir_all`) if missing, opens with `OpenOptions::new().create(true).append(true).read(true)`, then:
  - gets the current length via `seek(SeekFrom::End(0))` (error → `history write failed: seek {path}: {e}`);
  - if length > 0, probes the last byte (`seek(SeekFrom::End(-1))` + `read_exact`); probe errors log `warn: history append newline probe {path} failed, inserting separator: {e}` and are treated as "not a newline" (safe direction). When the tail is not `\n`, a separator `\n` is inserted before the new line — repairing torn/partial tails (spec §3.4).
  - builds one buffer (`separator? + line + "\n"`) and writes it via the private `write_terminated(file, buf, path)` helper in a single `write_all` inside `self.lock`. Write errors → `Err(format!("history write failed: write {path}: {e}"))`; all other append stages carry `path` + stage in their messages (serialize / create parent dir / open / seek / write).
- `read_lines`: `NotFound` → `Ok(vec![])`; other errors → `Err(format!("history read failed: read {path}: {e}"))`; reads the whole file inside the lock, then per line enumerates the split before decoding and warns `warn: history line {i} had invalid UTF-8, lossy-decoded ({path}): {e}` when `std::str::from_utf8` fails, lossy-decodes, trims, and filters blank lines (`i` is the 0-based split index — physical line — since blanks are still present at this stage).

- [x] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test history`
Expected: PASS.

- [x] **Step 5: Commit**

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
  - `pub fn fold_records(lines: &[String]) -> FoldResult` — pure (no file/state IO; skip diagnostics go to stderr)
  - `HistoryStore::load(&self) -> Result<FoldResult, String>`

**Acceptance Criteria:**
- Grouping by `sessionId`; files sorted by `completedAt`; sessions sorted newest-first by `startedAt` (spec §3.4).
- Missing `session_end` ⇒ `interrupted: true`, `ended_at: null`, outcome + `total_saved_bytes` computed from recorded files with saturating subtraction (spec §3.4).
- Present `session_end` ⇒ `ended_at`, `total_saved_bytes`, `cancelled`, and counts taken verbatim from the end record (spec §3.4).
- Malformed JSON lines skipped + counted; unknown record `type`s ignored silently; orphan file/end lines (unknown session) skipped + counted (plan Task 3 implementation note; spec §3.3). Lines with invalid UTF-8 are consumed lossy (stderr-warned by `read_lines`); if the lossy line still fails JSON parsing it is counted as malformed like any other bad line (spec §3.3). `fold_records` skip warns report a 0-based entry index among non-blank lines (`read_lines` filters blanks), not a physical-file line number; `read_lines`'s own UTF-8 warn uses the physical split index instead.
- Anomaly semantics: lines that parse as JSON but have no string `type` (`[]`, `123`, `"str"`, `null`, `{}`, `{"type":123}`) are counted as malformed; a typed record (`session_start`/`file`/`session_end`) whose struct parse fails is counted as malformed; a `file` record arriving after its session's `session_end` is skipped + counted (end-derived outcome/totals stay frozen).
- Duplicate `fileId` within a session: last record wins (spec §3.4).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `fold_single_complete_session` — end-derived values + quality passthrough
- `fold_uses_session_end_values_verbatim` — end fixture values (totalSavedBytes 100, counts) win over file-derived values
- `fold_missing_session_end_is_interrupted` — interrupted true, ended_at None, saved from files
- `fold_interrupted_computes_all_six_status_counts` — outcome built from files across all six statuses
- `fold_session_end_cancelled_flag` — `cancelled: true` in end record → session.cancelled
- `fold_orders_sessions_newest_first_and_files_by_time` — ordering both axes
- `fold_skips_malformed_counts_them_and_ignores_unknown_types` — malformed counted; unknown type silent; typed-invalid start/end counted
- `fold_orphan_file_lines_are_skipped` — file for unknown session → skipped + counted
- `fold_orphan_session_end_is_skipped` — end for unknown session → skipped + counted
- `fold_duplicate_file_id_last_wins` — replace semantics
- `fold_duplicate_session_end_is_skipped_and_counted` — first end wins; duplicate skipped + counted
- `fold_file_category_passthrough` — category value survives folding
- `fold_file_error_text_passthrough` — error string survives folding
- `fold_file_ids_are_scoped_per_session` — same fileId in two sessions stays independent; duplicate `f1` inside the non-first session is last-wins
- `fold_interrupted_unknown_status_not_counted` — unknown file status leaves all six outcome counts at zero
- `fold_saturates_when_compressed_exceeds_original` — original 5, compressed 10 → saved 0, no panic
- `fold_interrupted_saturates_total_saved` — large saved deltas saturate to u64::MAX without panic
- `fold_interrupted_flag_matches_ended_at_biconditional` — interrupted true + ended_at None on interrupted fixture; false + Some on complete fixture
- `fold_counts_non_object_and_non_string_type_lines` — `[]`/`123`/`"str"`/`null`/`{}`/`{"type":123}`/`{"type":null}` counted as malformed; `future_record` silent
- `fold_file_after_session_end_is_skipped_and_counted` — post-end file skipped; end-derived outcome/totals frozen
- `fold_output_serde_keys_are_pinned` — camelCase golden keys for `HistorySession` + `files[0]` (PathBuf outputPath wire format)
- `fold_tolerates_absent_optional_keys` — keys entirely absent (not just null) parse
- `fold_zero_file_interrupted_session_still_appears` — start-only session → session with empty files, Interrupted
- `load_roundtrips_through_file` — start + file appended → load
- `load_counts_lossy_non_json_line_as_skipped` — invalid-UTF-8 line lossy-decoded, not valid JSON → counted
- `load_surfaces_read_error` — history.jsonl as a directory → `Err`

- [x] **Step 1: Write the failing tests**

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
            line(serde_json::json!({ "type": "file", "sessionId": "s1" })),
            line(serde_json::json!({ "type": "session_start" })),
            line(serde_json::json!({ "type": "session_end", "sessionId": "nobody" })),
            line(start("s1", 10)),
        ];
        let out = fold_records(&lines);
        assert_eq!(out.skipped_lines, 4, "malformed and typed-invalid counted; unknown type ignored silently");
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

- [x] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test history`
Expected: FAIL — `fold_records` not defined.

- [x] **Step 3: Implement**

In `src-tauri/src/history.rs`:

- `history_file_from(rec: &FileResultRecord) -> HistoryFile` maps fields 1:1 (`output_path` via `PathBuf::from`).
- `fold_records(lines)`:
  - Parse each line with `serde_json::from_str::<serde_json::Value>`; on error → `skipped_lines += 1`.
  - Match `value["type"]`: `"session_start"` → deserialize `SessionStartRecord`, push session into an index map (`HashMap<String, usize>`) with empty files/outcome; `"file"` → deserialize `FileResultRecord`; unknown session id → `skipped_lines += 1`, else append/replace by `file_id` (last wins); `"session_end"` → deserialize `SessionEndRecord`, set `ended_at`, `total_saved_bytes`, `cancelled`, `outcome` from counts; **unknown types are ignored silently** (forward compatibility — a future record kind must not trigger the corrupt-line notice or be dropped on retention rewrite).
  - Anomaly counting: non-string/missing `type` lines counted; typed parse failures (e.g. `{"type":"session_start"}` missing fields) counted; orphan `file`/`session_end` (unknown session) skipped + counted with an stderr warn; a `file` after its session's `session_end` skipped + counted; a duplicate `session_end` skipped + counted (first end wins, values from the first end). Every skip warn carries the 0-based `entry {N}` index — an index among non-blank lines (`read_lines` filters blanks before folding), not a physical-file line number.
  - After the pass: for sessions without `ended_at`, compute `outcome` from files and `total_saved_bytes = Σ original − compressed` (saturating); `interrupted = true`.
  - Sort files by `completed_at`; sort sessions by `started_at` descending.
- `HistoryStore::load` = `read_lines()` → `fold_records`; `read_lines` failure → `Err`.
- `#[serde(rename_all = "camelCase")]` on `HistoryFile` / `HistorySession` (`outcome` uses the `Counts` struct from Task 2); `matched_files` serializes as `null` until Task 4 sets it.

- [x] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test history`
Expected: PASS.

- [x] **Step 5: Commit**

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
  - `HistoryFilters { search: Option<String>, statuses: Option<Vec<String>>, categories: Option<Vec<String>>, since_ms: Option<i64>, output_folder: Option<String> }` — camelCase serde, `Default`, `deny_unknown_fields`
  - `HistorySummary { sessions: usize, files: usize, saved_bytes: u64, failed_files: usize }` — camelCase (response-only, no `Deserialize`)
  - `HistoryResponse { sessions: Vec<HistorySession>, page: u32, page_size: u32, total_sessions: usize, total_files: usize, summary: HistorySummary, output_folders: Vec<String>, skipped_lines: usize }` — camelCase
  - `pub fn query_history(fold: FoldResult, filters: &HistoryFilters, page: u32, page_size: u32) -> HistoryResponse`
  - `pub const DEFAULT_PAGE_SIZE: u32 = 50;`

**Filter semantics (locked with spec §3.5):**
- Normalization: `output_folder` is trimmed; blank/whitespace-only is inactive. `statuses`/`categories` entries are trimmed and empties dropped; a resulting empty vec is inactive (same as absent). Unknown JSON keys are rejected (`deny_unknown_fields`) so a typo'd filter fails loudly instead of silently defaulting.
- Date: `since_ms` absent or session `started_at >= since_ms` (inclusive). Session-level — compares `started_at`, never file times.
- Output folder: exact match after trimming both sides (filter value and stored session `output_folder`); a session with an empty/whitespace-only folder is excluded by an active folder filter. Session-level.
- Search: case-insensitive substring. File-level hit = name / path / output_path / error. **Session-level hit on `output_folder` keeps the session with `matched_files = None`** unless a file also hits (then the file set wins with `Some(n)`). `Some("")` or whitespace-only search is treated as absent (no filter); `Some(vec![])` for statuses/categories is treated as absent.
- Status / categories: file-level; a session is visible when ≥1 file matches and only matching files are returned; `matched_files = Some(returned_len)`. Category compares against `HistoryFile.category`.
- File-level filter active ⇔ (non-empty search that has file hits) OR non-empty statuses OR non-empty categories.
- `output_folders`: distinct non-empty session folders, sorted, from the **unfiltered** fold.
- `summary`: always the whole filtered set (independent of page): `files` = Σ displayed files (all files of visible sessions when `matched_files = None`, else matches); `saved_bytes` = Σ (`original_size - compressed_size`) saturating over those files; `failed_files` = count of `status == "failed"` over those files. `summary.sessions == total_sessions`; `total_files == summary.files`.
- Ordering: sessions already newest-first; then stable page slice: `page_size` clamped to ≥1; effective page = `page.min(max(0, ceil(total/page_size) - 1))`; empty set → page 0. Clamp ownership: `query_history` clamps only 0-size → 1; the command layer (Task 7) owns 0 → `DEFAULT_PAGE_SIZE` (50) and 500 → 200.

**Acceptance Criteria:**
- Every filter combination narrows correctly over the full session set; file-level filters reduce each session's files and set `matchedFiles`; session-level-only matches keep `matchedFiles = null` (spec §3.5, §5.4).
- Search positively covers name, source path, output path, error text, and session output folder; folder-only hit keeps all files (spec §5.4, review focus).
- Totals and summary are page-independent and never split a session's file set across pages; page clamps for middle, last partial, beyond-end, and empty result; `page_size = 0` does not panic (spec §3.5).
- `output_folders` is unfiltered, deduped, sorted, excludes empty folders (spec §3.5).
- `since_ms` compares session `started_at` only — inclusive at the boundary (spec §3.5).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `query_returns_first_page_and_totals` — page 1 of 2, totals + summary
- `query_page_middle_and_last_partial_page` — 5 sessions, page_size 2: pages 0/1/2 sizes 2/2/1
- `query_page_beyond_end_clamps_to_last_page` — page 9 → last page
- `query_empty_result_is_page_zero` — no matches → page 0, empty sessions, zeroed summary
- `query_page_size_zero_is_safe` — no panic; effective size clamped (test calls with 0 and asserts a sane page slice)
- `query_status_filter_reduces_files_and_counts_them` — file reduction + matchedFiles Some
- `query_category_filter` — negative then positive
- `query_search_hits_name_source_path_output_path_error_and_folder` — five positive targets + one negative; folder-only hit `matchedFiles = None`
- `query_search_file_and_folder_hit_file_set_wins` — both hit → Some(n) with reduced files
- `query_empty_and_whitespace_search_are_inactive` — `Some("")`/`Some("  ")` treated as absent
- `query_empty_status_and_category_vecs_are_inactive` — toggling last chip off does not hide everything
- `query_since_ms_inclusive_boundary` — at boundary included; one ms later excluded
- `query_since_ms_uses_session_start_not_file_times` — session started before cutoff with a file after → excluded
- `query_combined_filters` — since_ms + statuses + output_folder together
- `query_summary_is_page_independent` — page 1 request returns page 0's totals/summary under filters
- `query_never_splits_session_across_pages` — session with 2 files + page_size 1 → both files in the row
- `query_output_folders_list_is_unfiltered_deduped_sorted` — active filter still returns all folders sorted
- `query_output_folder_filter_excludes_empty_folder_sessions` — empty-folder session excluded by active filter
- `query_multi_status_filters_are_a_union` — done+failed+cancelled files; `["failed","cancelled"]` → session visible, `matchedFiles Some(2)`, summary files 2; category union variant where only the second element matches
- `query_matched_files_uses_returned_len_not_planned_file_count` — fixture `fileCount = 3` with 2 files, one matching → `matchedFiles Some(1)` (never 3)
- `query_summary_failed_files_respects_file_filter` — `["done"]` → `failed_files 0`; `["failed"]` → 1; end-record counts disagree → summary still from displayed files
- `query_file_search_hit_intersects_status_filter` — three files: two match the searched error (one failed, one done) and two are failed (one matching); search + `["failed"]` → only the failed-matching file remains, `matchedFiles Some(1)` (search alone → 2 files, status alone → 2 files)
- `query_file_search_hit_intersects_category_filter` — three failed files (two pdf, one jpg); the searched error hits one pdf and the jpg; search + `["pdf"]` → only the pdf hit file remains, `matchedFiles Some(1)`
- `query_output_folder_filter_is_session_level` — file-bearing sessions; folder filter keeps `matchedFiles = None` and file sets untouched
- `query_page_beyond_end_clamps_with_active_filter` — five sessions mixed statuses, `["failed"]` → page 9 clamps to the filtered last page (2), sessions non-empty
- `query_summary_saved_bytes_saturates` — two files `(u64::MAX, Some(0))` → `summary.saved_bytes == u64::MAX`, no panic
- `query_skipped_lines_passthrough` — fold with one valid + one malformed line → `skippedLines == 1`
- `query_blank_and_whitespace_filters_are_inactive` — blank `output_folder` inactive; blank-only status vec inactive; padded `" failed "` / `" /outB "` normalized and active
- `query_stored_folder_trimmed_for_match_and_listing` — stored folders `"/outB"`, `" /outB "`, `"   "`; `output_folders == ["/outB"]`; filter `"/outB"` matches both padded/unpadded sessions, whitespace-only session never selectable/listed
- `query_response_serde_keys_are_pinned` — exact sorted keys for response + summary; `DEFAULT_PAGE_SIZE == 50`
- `history_filters_deserialize_camel_case` — `{"sinceMs":5,"outputFolder":"/x","statuses":["failed"]}` → fields set, others `None`
- `history_filters_deserialize_rejects_unknown_keys` — `{"category":"image"}` fails deserialization (`deny_unknown_fields`)

- [x] **Step 1: Write the failing tests**

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
    fn query_search_hits_name_source_path_output_path_error_and_folder() {
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
    fn query_output_folders_list_is_unfiltered_deduped_sorted() {
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

- [x] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test history`
Expected: FAIL — `query_history` not defined.

- [x] **Step 3: Implement**

In `src-tauri/src/history.rs` implement `query_history` per the semantics block above. Helpers: `matches_search(s: &str, needle: &str) -> bool` (lowercase contains); `file_hit(f, needle)`; `normalize_list(Option<&[String]>) -> Option<Vec<String>>` (trim entries, drop empties, empty result → `None`); `file_matches(file, statuses: Option<&[String]>, categories: Option<&[String]>, needle: Option<&str>) -> bool` via `is_none_or` chains (needle `None` = session matched at folder level only, do not constrain files by search). Compute normalized statuses/categories once before the loop; reduce each session with `files.retain(...)` only when file-level constraints are active (`matchedFiles = Some(returned len)`; skip empty sessions), otherwise keep files untouched with `matchedFiles = None`. `saved_for` logs `info: history file {path} output {compressed} larger than original {original}, saved clamped to 0` when a best-effort result grew the file (legitimate, not corruption) and saturates the subtraction at 0. Clamp `page_size` to `max(1, page_size)` before the page math (`query_history` clamps only 0 → 1; Task 7 owns 0 → 50 and 500 → 200 at the command layer). `output_folders` sorted via `BTreeSet`, built from stored folders trimmed, excluding those empty after trim. `normalize_text(Option<&str>) -> Option<&str>` (trim + drop empty) is shared by search/output_folder normalization and stored-folder comparison; the folder filter trims both sides (filter value and stored folder); search trims only the filter value. Keep everything pure (no file IO; warnings go to stderr) so tests are trivial. Optionally add a `debug_assert_eq!` tying `response.total_sessions`/`total_files` to `summary.sessions`/`files` where the response is built.

**Note on the `fold_repeated_session_start` edge (from analysis):** duplicate `session_start` for the same id resets the session header (last start wins) — already added in Task 3 (`fold_repeated_session_start_last_wins` in `history.rs` tests); no further test needed here.

- [x] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test history`
Expected: PASS.

- [x] **Step 5: Commit**

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
  - `pub fn split_by_retention(lines: Vec<String>, retention_days: u32, now_ms: i64) -> (Vec<String>, usize)` — pure; `(kept_lines, dropped_sessions)`; a whole session's lines move together; lines of unknown `type` are kept verbatim; orphan/malformed lines are kept (never dropped by retention). Cutoff math must widen before multiplying: `i64::from(retention_days) * 86_400_000`.
  - `HistoryStore::trim(&self, retention_days: u32, now_ms: i64) -> Result<u32, String>` — rewrite only when `dropped > 0`; atomic via `history.jsonl.tmp` + `fs::rename`; returns dropped session count.
  - `HistoryStore::clear(&self) -> Result<(), String>` — remove file if present; also remove a stray `.tmp`.

**Retention semantics:** session is dropped when `max(started_at, all file completed_at, ended_at) < now_ms - i64::from(retention_days) * 86_400_000` (strictly older; widen to i64 before multiplying so `u32` retention values cannot overflow; the subtraction saturates so an extreme `now_ms` cannot panic). Missing `session_end` → newest record is max of start + files. `retention_days = 0` is treated as 90 (callers clamp, but the pure function must still be safe).

**Acceptance Criteria:**
- Exactly-at-cutoff sessions are kept; strictly older drop — with `ended_at` counted as a session record (spec §3.6).
- Whole session moves together; malformed, unknown-type, and orphan lines are never dropped (spec §3.6, forward compat).
- Rewrite happens only when something drops; atomic temp-file + rename; on failure the original file is byte-identical (spec §3.1).
- `clear()` is idempotent and also removes a stray `history.jsonl.tmp` (spec §3.6).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `trim_keeps_session_exactly_at_boundary` — edge kept, older dropped
- `trim_newest_exactly_at_cutoff_kept` — session whose newest record == cutoff is kept (strict `<`)
- `trim_ended_at_counts_as_newest_record` — old start + fresh end → kept; fresh start + old end → kept (ended_at counts toward newest)
- `trim_counts_files_after_start_for_interrupted_sessions` — file after start keeps the session
- `trim_dropped_session_lines_move_together` — dropped session's start/file/end lines all drop; kept vector is exactly the survivor
- `trim_store_removes_whole_session_lines` — store trim drops a complete old session; load() reports zero skipped lines
- `trim_keeps_malformed_and_orphan_lines` — never dropped
- `trim_keeps_unknown_type_lines_verbatim` — future record kinds survive
- `trim_wide_retention_does_not_overflow` — wide retention keeps a 200-day-old record (a wrapped cutoff would drop it)
- `trim_extreme_now_ms_does_not_panic` — `now_ms = i64::MIN` saturates the cutoff; nothing drops
- `trim_rewrites_only_when_something_drops_and_is_atomic` — dropped count, no tmp leftover, second trim no-op (file bytes identical; unix: inode unchanged)
- `trim_zero_retention_days_behaves_like_ninety` — retention 0 keeps an 89-day record and drops a 91-day one
- `trim_blocks_until_lock_released` — held mutex blocks `trim` until released (mirrors the append lock test)
- `clear_blocks_until_lock_released` — held mutex blocks `clear` until released
- `trim_failure_leaves_original_intact` — tmp path as directory → Err at the stale-remove stage + original bytes unchanged
- `trim_direct_write_and_rename_paths_are_used` — successful trim leaves no tmp, writes each kept line followed by `\n`; an empty kept set writes a 0-byte file
- `trim_rewrite_replaces_inode` — `#[cfg(unix)]`; successful rewrite changes the file's inode (rename replaces; in-place truncate-write would keep it)
- `trim_orphan_end_before_start_does_not_anchor_session` — orphan `session_end` before any start for that id must not seed `newest_by_session`; start+file at now-30d decide the drop, orphan line kept verbatim
- `trim_missing_file_is_noop` — fresh store → Ok(0), no tmp created
- `trim_missing_file_cleans_stale_regular_tmp` — no history file + stale regular tmp → Ok(0), tmp gone
- `trim_stale_tmp_regular_file_is_replaced` — pre-existing regular tmp file does not break trim
- `clear_removes_file_and_is_idempotent` — plus stray tmp removal
- `clear_failure_returns_err` — history.jsonl as a non-empty directory → Err, data left in place
- `clear_tmp_failure_leaves_main_intact` — tmp removal failure → Err, history.jsonl still present and readable
- `trim_read_error_propagates` — history.jsonl as a directory → trim returns `history read failed: read …` and creates no tmp

- [x] **Step 1: Write the failing tests**

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

        let after_first_drop = std::fs::read(store.file_path()).unwrap();
        let dropped_again = store.trim(1, 100 * DAY_MS).unwrap();
        assert_eq!(dropped_again, 0);
        assert_eq!(
            std::fs::read(store.file_path()).unwrap(),
            after_first_drop,
            "no-op trim leaves the file byte-identical"
        );
    }

    #[test]
    fn trim_failure_leaves_original_intact() {
        let dir = tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("history.jsonl.tmp")).unwrap();
        let store = HistoryStore::new_in(dir.path());
        store.append_session_start(&SessionStartRecord {
            session_id: "old".into(), started_at: 0, file_count: 1, output_folder: "/o".into(),
        }).unwrap();
        let before = std::fs::read(store.file_path()).unwrap();
        let err = store.trim(1, 100 * DAY_MS).unwrap_err();
        assert!(
            err.contains("remove stale temp"),
            "tmp occupied by a directory fails at the stale-remove stage: {err}"
        );
        assert_eq!(
            std::fs::read(store.file_path()).unwrap(),
            before,
            "original bytes are byte-identical after a failed rewrite"
        );
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

- [x] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test history`
Expected: FAIL — `split_by_retention` not defined.

- [x] **Step 3: Implement**

- `split_by_retention`: first pass parses each line via `parse_line_ref` → `(session_id, timestamp, is_start)`; non-start lines arriving before that session's start stay unbound (orphans kept, and they do not seed the newest tracker); the newest timestamp is folded per session via the entry API + `max`. Builds `drop: HashSet<String>` for sessions whose newest < cutoff; second pass keeps lines whose session is not in `drop`, plus all malformed/unknown/orphan lines; `dropped = drop.len()`. Treat `retention_days == 0` as 90 inside the pure function. Cutoff uses `now_ms.saturating_sub(i64::from(retention_days) * 86_400_000)`.
- `HistoryStore::trim`: `lines = read_lines()`; `(kept, dropped) = split_by_retention(...)`; compute `tmp_path`; remove a stale regular `history.jsonl.tmp` (ignore `NotFound`; do NOT remove a directory — that failure surfaces as Err) **before** the `dropped == 0` early return so a stale tmp never survives a no-op trim; if `dropped == 0` → `Ok(0)`; else join the kept lines (`line + '\n'` per line), write them via `File::create` + the shared `write_terminated` helper + `sync_all` (fsync before rename), drop the handle, `fs::rename(tmp, path)`, errors leave the original untouched; return `u32::try_from(dropped).unwrap_or(u32::MAX)`; guard with the mutex.
- `HistoryStore::clear`: remove any stale `history.jsonl.tmp` first (ignore `NotFound`; a tmp directory errors out so the failure is visible), then remove `history.jsonl` (ignore `NotFound`; a directory → Err) — tmp removal before main means a failure leaves the history data in place (spec §5.8).

- [x] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test history`
Expected: PASS.

- [x] **Step 5: Commit**

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
  - Per-batch accumulator `history_records: Mutex<HashMap<String, Vec<crate::history::FileResultRecord>>>` on `QueueState` (keyed by batch id) feeding `session_end` counts via the shared `crate::history::Counts` struct — no private counts type.
  - `fn history_counts_of(files: &[crate::history::FileResultRecord]) -> crate::history::Counts` — pure, maps the six statuses; unknown statuses are not counted but warn to stderr.
  - `history:error` event: `{ "message": String }`, emitted **once per batch** on the first write failure.
  - Private helper `fn append_history<R: tauri::Runtime>(app: &AppHandle<R>, record: HistoryRecordRef<'_>) -> Result<(), String>` — resolves `app.try_state::<HistoryStore>()`, missing store → warn to stderr + `Ok(())` (tests that don't manage history still pass), write error → first-failure `history:error` emit (per-batch flag in `QueueState`), returns the error.
  - Method `fn record_file(&self, app, batch_id, entry, status, output_path, compressed_size, quality_used, strategy_used, error, duration_ms)` — builds the record with `status_key` / `category_key`, pushes to the accumulator, appends via the `HistoryRecordRef::File` variant; `fn record_cancelled(&self, app, batch_id, entry, duration_ms)` wraps the six cancelled/skip call sites plus the mid-flight cancel path.

**Write points:** `process_batch` after preflight passes → `append_session_start` (folder = settings `output_folder`, `file_count = file_ids.len()` — **capture `file_ids.len()` before `process_batch`'s N≤1 loop consumes the vec by value**). Every terminal outcome in `process_single_job` (done / best-effort / already-under-target, failed, cancelled, unsupported) → `append_file`. Cancel-all skipped files (both the sequential loop and the lane `on_skipped` closure), the "cancelled while pending" skip paths, and entries individually cancelled while Pending (never placed into a lane) → `append_file` with `status: "cancelled"`, `output_path: None`, `compressed_size: None`, `duration_ms: 0`. `finish_batch` → `append_session_end` (counts over all recorded file records, `cancelled` = batch was cancelled — **read the cancellation state before `finish_batch` removes the batch token**) then `trim(effective_retention_days, now_ms)` (trim failure is logged, never propagated; missing store skips the trim with a once-per-batch warn that includes the batch id).

**Status string format (must not drift):** `FileResultRecord.status` is the snake_case `FileStatus` string exactly as serialized by serde (`"done"`, `"best_effort"`, `"already_under_target"`, `"failed"`, `"cancelled"`, `"unsupported"`) — never `format!("{:?}")` (which would emit `"AlreadyUnderTarget"` and silently break Task 4 filters). Add a helper `fn status_key(status: &FileStatus) -> &'static str` with an exhaustive match that is **total and safe for every `FileStatus` variant** (including `Pending` / `Compressing`) — map each variant to its snake_case serde string; no `unreachable!()`, no panic.

**Category string:** `FileResultRecord.category` for file records is always `category_key(&entry.category)` — reuse the existing `category_key` helper (do not add a second mapping).

**Acceptance Criteria:**
- Preflight failure writes nothing (no phantom session); successful preflight writes `session_start` with the settings folder and the batch's file count (spec §4.1).
- Every terminal outcome is recorded exactly once per file, including unsupported (early-return branch) and cancel-all skips in both sequential and lane paths (spec §4.1).
- Cancel-skipped records carry original sizes, `outputPath`/`compressedSize` null, `durationMs` 0; processed records carry positive duration (spec §3.2).
- `session_end` carries worker-accumulated counts (all six statuses) and totals matching the recorded file lines; `cancelled` true only for cancel-all batches (spec §3.2).
- History write failure: batch still completes with normal events; at most one `history:error` `{ message }` per batch; missing `HistoryStore` state → recording warns to stderr once per batch (batch id + record kind in the message) and no-ops (spec §4.1, §5.8).
- `FileCompletePayload` gains `qualityUsed` / `strategyUsed`, additive (spec §3.2).
- Existing queue tests unchanged and green (spec AC8).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `history_counts_map_all_statuses` — six counted, `"pending"` excluded
- `file_complete_payload_carries_strategy_fields` — camelCase additive keys
- `failed_batch_writes_session_records` — start + 2 files + end, not interrupted, `cancelled` false, counts exact, timestamps ordered: started_at > 0, ended_at >= started_at, each file completed_at within [started_at, ended_at]
- `session_end_totals_match_accumulated_records` — totalSavedBytes + all six counts exactness; batch:complete payload total equals the recorded total; processed record pins exact output path, category `"document"`, quality 100 and the already-under-target strategy string
- `preflight_failure_writes_nothing` — sessions empty
- `cancel_all_records_cancelled_files` — 6 ids, recorded fileId set equals the batch ids exactly (no duplicates, no gaps); failed + cancelled count cover all 6; every cancelled record carries `duration_ms` 0
- `sequential_cancel_all_records_cancelled` — max_concurrent "1" path records cancelled skips; cancelled records carry `duration_ms` 0
- `cancel_skipped_records_have_zero_duration_and_no_output` — real 1KB file pre-cancelled: original_size == 1024, duration 0, null output/compressed; all cancelled records keep entry sizes (mid-flight duration is measured per spec §3.2 and not asserted here — not deterministically simulatable without sidecars)
- `unsupported_outcome_recorded` — Category::Other → status `unsupported`, category `"other"`, nulls for output/quality/strategy, duration_ms > 0
- `history_write_failure_does_not_fail_batch` — history path unwritable → batch:complete still fires, file outcomes unchanged, exactly 1 `history:error` event
- `history_error_emitted_once_per_batch` — persistent failure across 2 files → exactly 1 `history:error` `{ message }`
- `missing_store_still_completes_batch` — no HistoryStore managed → batch completes normally
- `finish_batch_trims_old_history` — seeded 11-day-old session + retention 10 → gone after batch
- `session_start_output_folder_matches_settings` — folder equals settings value
- `duration_ms_positive_for_processed_outcome` — processed file record has duration_ms > 0 (sidecar-less failure path still measures)
- `lane_pending_cancelled_entry_recorded_once` — maxConcurrent "3", one entry pre-marked Cancelled before start_batch: every batch id recorded exactly once, cancelled count includes it, no `file:cancelled` re-emitted by the lane sweep
- `cancel_skip_entry_ignores_non_pending` — Done/Failed/unknown ids not swept; Cancelled returned as-is; Pending flips
- `done_entry_not_recorded_on_skip_path` — a stale Done row is never recorded by cancel skips and is not clobbered
- `trim_failure_does_not_fail_batch` — rewrite temp path occupied by a directory with a seeded old session: batch completes, original history intact, outcomes unchanged
- `history_error_flag_cleared_between_batches` — two sequential failing batches in one app emit 2 `history:error` events and clear both flag entries
- `history_records_accumulator_cleared_after_batch` — accumulator drained after batch; second batch session counts unaffected
- `queued_entry_individually_cancelled_records_on_dispatch` — maxConcurrent "3", one entry marked Cancelled via `set_status` then `process_single_job` called directly: saved 0, exactly one file record with status `cancelled`, duration 0, null output/compressed/quality/strategy
- `status_key_snake_case` — `status_key` returns `"already_under_target"` etc. for all variants including `pending` / `compressing` (exhaustive, total match pinned; no panic paths)
- `category_key_snake_case` — `category_key` returns lowercase strings (`"image"` / `"video"` / `"pdf"` / `"document"` / `"other"`), so file records never carry `format!("{:?}")`-style casing

- [x] **Step 1: Write the failing tests**

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
            ("p2.pdf", crate::models::Category::Pdf, "/tmp/p2.pdf"),
            ("v1.mp4", crate::models::Category::Video, "/tmp/v1.mp4"),
            ("v2.mp4", crate::models::Category::Video, "/tmp/v2.mp4"),
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
        let recorded: Vec<String> = raw_file_records(&store).iter().map(|r| r.file_id.clone()).collect();
        assert_eq!(
            recorded.iter().cloned().collect::<std::collections::HashSet<_>>(),
            ids.iter().cloned().collect::<std::collections::HashSet<_>>(),
            "recorded file ids must equal the batch ids exactly, got {recorded:?}"
        );
        assert_eq!(recorded.len(), ids.len(), "no duplicate file records");

        let fold = store.load().unwrap();
        let s = &fold.sessions[0];
        assert_eq!(s.files.len(), ids.len(), "every file terminal outcome recorded once");
        assert!(s.files.iter().any(|f| f.status == "failed"));
        assert!(s.files.iter().any(|f| f.status == "cancelled"));
        assert_eq!(
            s.outcome.failed + s.outcome.cancelled,
            u32::try_from(ids.len()).unwrap(),
            "counts must cover every recorded file"
        );
        for f in s.files.iter().filter(|f| f.status == "cancelled") {
            assert_eq!(f.duration_ms, 0, "cancelled-before-slot records carry zero duration: {f:?}");
        }
        assert!(s.cancelled, "batch ended via cancel-all");
    }
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test queue`
Expected: FAIL — `history_counts_of` not defined / history assertions fail.

- [x] **Step 3: Implement**

In `queue.rs`:
- Import `crate::history::{...}`; add `use tauri::Manager;` for `try_state` (already imported).
- Add `quality_used: Option<u32>, strategy_used: Option<String>` to `FileCompletePayload`; fill from `compression_result.quality_used` / `.strategy_used` for successful jobs; `None` everywhere else.
- `fn status_key(status: &FileStatus) -> &'static str` — exhaustive match to the serde snake_case strings; all history `status` values come from this helper.
- Accumulator: thread-safe per batch — add to `QueueState`: `history_records: Mutex<HashMap<String, Vec<crate::history::FileResultRecord>>>` keyed by batch id; worker pushes each recorded file record there; `finish_batch` drains the vector, computes `history_counts_of`, writes `session_end`, calls `trim` with `crate::settings::Settings` loaded from `load_settings(app)` (call `load_settings` in `finish_batch`; it is already pub). `trim` errors are logged via `eprintln!`, never propagated. A missing `HistoryStore` state warns to stderr on the append/trim skip paths.
- `history:error` once-per-batch: add `history_error_sent: Mutex<HashSet<String>>` keyed by batch id; helper checks+inserts before emitting; `finish_batch` removes the batch's entry.
- Write-failure test technique: point the store at a path whose parent is a regular file (e.g. `HistoryStore::new_in(&blocker.join("child"))`) or put a directory at `history.jsonl` — `append` must return Err; the batch must still complete.
- `duration_ms`: measure `std::time::Instant::now()` at job start; attempted terminal outcomes use `(started.elapsed().as_millis() as u64).max(1)` (never 0); pre-slot cancel/skip paths record `0`; the mid-flight `Err(Cancelled)` path records `elapsed_ms()`.
- Unsupported branch currently returns before the generic match — record there too (`status "unsupported"`, no sizes/output, duration measured).
- Cancel-skip paths: sequential loop cancel-all branch, lane `on_skipped`, the "cancelled while pending" guards in `process_single_job`, and the `!flipped` race branch (reuse `cancel_skip_entry` for the lookup) → `record_cancelled` with original sizes from the entry.
- Methods on `QueueState`: `fn record_file(&self, app, batch_id, entry, status, output_path, compressed_size, quality_used, strategy_used, error, duration_ms)` builds the record with `status_key` / `category_key`, pushes to the accumulator, appends via the `HistoryRecordRef::File` variant; `fn record_cancelled(&self, app, batch_id, entry, duration_ms)` wraps the cancelled/skip call sites.

- [x] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test queue`
Expected: PASS (existing + new).

- [x] **Step 5: Commit**

```bash
git add src-tauri/src/queue.rs
git commit -m "feat(queue): record session, file and end records to history"
```

---

### Task 7: `get_history` / `clear_history` / `open_folder` commands

**Files:**
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/history.rs`, `src-tauri/src/queue.rs` (`now_ms` made `pub(crate)`), `src-tauri/src/temp.rs` (runtime-generic cleanup)
- Test: `src-tauri/src/commands.rs` test module (pure pieces), existing Rust patterns for command wiring

**Interfaces:**
- Consumes: `HistoryStore` (Tasks 2–5), `query_history` (Task 4).
- Produces:
  - `pub async fn get_history<R: tauri::Runtime>(filters: crate::history::HistoryFilters, page: u32, page_size: u32, app: tauri::AppHandle<R>) -> Result<crate::history::HistoryResponse, String>` — clamps `page_size` via `crate::history::clamp_page_size` (0 → `DEFAULT_PAGE_SIZE` (50), 500 → 200); folds + queries; missing store → `HistoryResponse::empty(page_size)` (empty clamps internally) with `page: 0` and the clamped `page_size` echoed (once-guarded stderr warn — diagnostics only, still `Ok`).
  - `pub fn clear_history<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> Result<(), String>` — missing store → once-guarded stderr warn + `Ok(())`.
  - `pub fn open_folder<R: tauri::Runtime>(path: String, app: tauri::AppHandle<R>) -> Result<(), String>` — `opener().open_path(&path, None::<&str>)`, error copy `Could not open folder {path}: {e}`
  - `history.rs`: `pub(crate) fn clamp_page_size(n: u32) -> u32` (0 → 50, else `.min(MAX_PAGE_SIZE)`); `HistoryResponse` has NO `Default` derive — manual `impl Default` delegates to `empty(DEFAULT_PAGE_SIZE)`, and `empty(page_size)` clamps internally, so `empty()`/`default()` cannot construct invalid states; raw struct literals remain possible (crate-internal), with `clamp_page_size` at the command boundary + `debug_assert!` in `query_history` as enforcement; `pub const MAX_PAGE_SIZE: u32 = 200`; `query_history` carries `debug_assert!(page_size >= 1 && page_size <= MAX_PAGE_SIZE, ...)` pinning the command-layer clamp.
  - `lib.rs`: `mod history;`, `pub(crate) fn setup_history<R: Runtime>(app: &AppHandle<R>)` — constructs `HistoryStore::new`, on Ok runs startup `trim` via effective retention (`settings.history.effective_retention_days()`) + `queue::now_ms()` (trim failure logs the effective retention and continues), then `app.manage(store)` with the bool checked (already-managed → warn, new store discarded); on Err logs + skips managing (missing-store paths keep the app functional).
  - `lib.rs`: `pub(crate) fn setup_hook<R: Runtime>(app: &mut tauri::App<R>) -> Result<(), Box<dyn std::error::Error>>` — the entire `setup()` closure body (manage `QueueState`, stale-temp cleanup, `setup_history`); `run()` uses `.setup(setup_hook)`; `macro_rules! invoke_handlers { () => { tauri::generate_handler![...all commands...] } }` single-sources the command list for `run()` and the wiring tests. `temp::cleanup_stale_temp_files` is runtime-generic accordingly. Commands taking `AppHandle` are runtime-generic so the handler list registers under MockRuntime.
  - Wiring tests (`#[cfg(test)] mod wiring_tests` in lib.rs) build `tauri::test::mock_builder()` with the opener+dialog+store plugins, `.setup(setup_hook)` + `.invoke_handler(invoke_handlers!())`, run `app.run_iteration`, assert both managed states, dispatch `get_history` via `tauri::test::get_ipc_response`, and pin the trim-failure-still-manages path.
  - `HistoryStore::new<R: Runtime>(app: &AppHandle<R>) -> Result<HistoryStore, String>` — error strings prefixed `history store: ` (`app data dir unavailable: {e}`, `create data dir {path}: {e}`)
  - `commands.rs` needs `use tauri::Manager;` added for `app.try_state::<HistoryStore>()` (current imports only carry `State`; `Manifest` — verified `Manager::try_state` requires the trait in scope).

**Acceptance Criteria:**
- `get_history` clamps `pageSize` (0→50, 500→200) in both the query and the echoed response; missing store returns an empty response, never `Err` (spec §4.2, review focus).
- `get_history` propagates load errors as `Err` so the UI error card can render (spec §5.6).
- `clear_history` success/idempotent; failure returns `Err` leaving data in place (spec §5.8).
- `open_folder` error copy pinned `Could not open folder {path}: {e}` (spec §4.2).
- Startup trim runs with effective retention and never blocks launch; trim failure logged (spec §3.6).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `page_size_clamps_helper` — 0→50, 1→1, 200→200, 201→200
- `get_history_empty_response_when_store_missing` — helper-level: `page: 0`, clamped page_size echoed, empty totals, `summary` default, no error
- `get_history_over_tempdir_store_filters_and_counts_skipped` — **deviation from the snippet: invokes the real `get_history` command** on a MockRuntime app with a tempdir store (exercises the command path, not only `query_history`): filtered sessions, totals, `skippedLines > 0`
- `get_history_propagates_load_error` — history.jsonl as a directory → `Err`
- `get_history_clamped_page_size_in_response` — response.pageSize reflects the clamp
- `get_history_page_argument_is_clamped_and_echoed` — page 9 with 2 sessions at page_size 1 → `page == 1` and the requested/clamped `pageSize` echoed
- `clear_history_removes_file_and_is_idempotent` — command-level success + second call ok
- `clear_history_missing_store_is_noop_ok` — no managed store → `Ok(())`
- `clear_history_error_when_remove_fails` — directory in place → `Err`
- `open_folder_error_path` — nonexistent path → `Err` starting `Could not open folder {path}: `
- `history_store_new_resolves_under_app_data_dir` — `HistoryStore::new` success path writes under `app_data_dir`
- `trim_runs_with_effective_retention_from_settings` — **startup wiring + effective-retention distinction**: seeded 30-, 300- and 4000-day-old sessions + `retentionDays: 5000` in the settings store → setup trims the 4000-day session (effective clamps 5000→3650) and keeps the 30- and 300-day sessions; a mutant using raw 5000 keeps all three and a mutant falling back to the 90-day default keeps only the 30-day session — both fail
- `missing_app_data_dir_skips_manage_and_app_still_works` — `setup_history` on an unresolvable data dir skips managing; `get_history` keeps working with the clamped echo (50, and the 500→200 clamp) and `clear_history` returns `Ok(())`
- `setup_hook_manages_queue_and_history_states` (lib.rs `wiring_tests`) — mock builder with `.setup(setup_hook)` + `.invoke_handler(invoke_handlers!())` + plugins, `run_iteration`, both states managed; deleting `setup_history` from the hook fails it
- `registered_commands_answer_ipc_dispatch` (lib.rs `wiring_tests`) — `get_ipc_response` dispatches of `get_history` (returns `Ok` with `page: 0`, clamped `pageSize: 50`), `clear_history` (returns `Ok`), and `open_folder` on a nonexistent path (returns the pinned `Could not open folder {path}: {e}` error); dropping any of them from `invoke_handlers!` fails it
- `startup_trim_failure_still_manages_history_store` (lib.rs `wiring_tests`) — `history.jsonl` as a directory + retention settings → `HistoryStore` still managed; an early-return on trim error fails it

- [x] **Step 1: Write the failing tests**

In `commands.rs` test module (pure):

```rust
    #[test]
    fn page_size_clamps_helper() {
        assert_eq!(clamp_page_size(0), 50);
        assert_eq!(clamp_page_size(1), 1);
        assert_eq!(clamp_page_size(200), 200);
        assert_eq!(clamp_page_size(201), 200);
    }

    #[test]
    fn get_history_empty_response_when_store_missing() {
        let resp = empty_history_response(0);
        assert_eq!(resp.page, 0);
        assert_eq!(resp.page_size, 50);
        assert_eq!(resp.total_sessions, 0);
        assert_eq!(resp.sessions.len(), 0);
        assert_eq!(resp.summary.files, 0);
    }

    #[test]
    fn get_history_over_tempdir_store_filters_and_counts_skipped() {
        use crate::history::{HistoryFilters, HistoryStore};
        let dir = tempfile::tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        store.append_session_start(&crate::history::SessionStartRecord {
            session_id: "s1".into(), started_at: 100, file_count: 1,
            output_folder: "/out".into(),
        }).unwrap();
        store.append_file(&crate::history::FileResultRecord {
            session_id: "s1".into(), file_id: "f1".into(), completed_at: 101,
            name: "a.jpg".into(), path: "/in/a.jpg".into(),
            output_path: Some("/out/a.jpg".into()), category: "image".into(),
            target_bytes: 1, original_size: 5, compressed_size: Some(1),
            status: "done".into(), quality_used: Some(70),
            strategy_used: Some("quality=70".into()), error: None, duration_ms: 3,
        }).unwrap();
        std::fs::OpenOptions::new().append(true).open(store.file_path()).unwrap()
            .write_all(b"garbage\n").unwrap();

        let fold = store.load().unwrap();
        let resp = crate::history::query_history(fold, &HistoryFilters::default(), 0, 50);
        assert_eq!(resp.total_sessions, 1);
        assert_eq!(resp.skipped_lines, 1);
    }

    #[test]
    fn trim_runs_with_effective_retention_from_settings() {
        use crate::history::HistoryStore;
        use crate::settings::Settings;
        let dir = tempfile::tempdir().unwrap();
        let store = HistoryStore::new_in(dir.path());
        store.append_session_start(&crate::history::SessionStartRecord {
            session_id: "old".into(), started_at: 0, file_count: 1,
            output_folder: "/o".into(),
        }).unwrap();
        let mut settings = Settings::default();
        settings.history.retention_days = 10;
        let dropped = store
            .trim(settings.history.effective_retention_days(), 100 * 86_400_000)
            .unwrap();
        assert_eq!(dropped, 1);
    }
```

- [x] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test commands`
Expected: FAIL — `clamp_page_size` not defined.

- [x] **Step 3: Implement**

- `fn clamp_page_size(n: u32) -> u32` (private, tested; 0 → `crate::history::DEFAULT_PAGE_SIZE`, cap 200); `get_history` uses it.
- `fn empty_history_response(requested_size: u32) -> HistoryResponse` — `page: 0`, `page_size: clamp_page_size(requested_size)`, zeroed `HistorySummary::default()` (Default derived in Task 4).
- `get_history`: `app.try_state::<HistoryStore>()` → `None` ⇒ `Ok(empty_history_response(page_size))`; `Some(store)` ⇒ `fold = store.load()?` then `Ok(query_history(fold, &filters, page, clamp_page_size(page_size)))`. Mark `async` and keep the body synchronous (async command runs off the main thread). Add `use tauri::Manager;` to `commands.rs` for `try_state`.
- `clear_history` / `open_folder` as above; `open_folder` reuses the plugin (`tauri_plugin_opener::OpenerExt`) with `open_path(path, None::<&str>)`, matching `reveal_in_folder` error style (`commands.rs:232-237`).
- `lib.rs`: add `mod history;` (Task 2 added the declaration — confirm it exists once), `use history::HistoryStore`, manage in setup after `QueueState`, call `trim` right after managing (log errors via `eprintln!`; never fail setup), register commands in `invoke_handler`.

- [x] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test commands && cargo test history`
Expected: PASS.

- [x] **Step 5: Commit**

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
  - `Settings` gains `history: HistorySettings` where `HistorySettings { retentionDays: number }` (named interface mirroring Rust `HistorySettings`, sibling pattern of `PerformanceSettings`↔`performance`, spec §4.3)
- `useHistory()` → `{ response, loading, error, filters, setFilters, page, setPage, refresh, clearHistory, clearError }`:
  - `setFilters(partial)` merges partials and resets page to 0 **only when the merged filters actually change** (compare before touching state — no-op when unchanged keeps filters identity, keeps the current page, and causes no refetch). Tolerance: one `setFilters` call per render/event cycle (component calls `setFilters` once per discrete event; same-tick double calls are not supported).
  - Query on mount, on `filters`/`page` change, on manual `refresh`, and on `batch:complete` (listen; unlisten on unmount). Debounce search input updates 300 ms **in the component** (hook receives settled values).
  - `history:error` listener → `toast.error('History could not be saved — compression was not affected.')`. Listener registration failure for `history:error` degrades gracefully: `console.error` + one-shot `toast.error('History error notifications are unavailable.')` (not error state); `batch:complete` registration failure stays log-only (manual refresh is the fallback).
  - `clearHistory` invokes `clear_history`, then `refresh()`; on failure `console.error('clear_history failed:', err)` + `toast.error('Could not clear history')` + rethrow suppressed.
  - `clearError()` resets the error banner state for Retry.
  - Hook-return note: `response` is retained during a refetch — Task 9 derives the busy state via `loading && response` (spec §5.4); the skeleton shows only when `loading && !response`.
  - Typing tolerance note: `HistoryFile.status` / `HistoryFilters.statuses` keep the full `FileStatus` union — `pending`/`compressing` can never occur in history records (spec §3.2 records only terminal statuses); accepted tolerance, Task 9 maps chips off `FileStatus` keys.
- `src/lib/historyFormat.ts`:
  - `export function formatDuration(ms: number): string` — exact semantics: `0` or negative → `—`; `1..59_999` → floored seconds with a 1s minimum (`999` → `1s`, `45_000` → `45s`, `59_999` → `59s`); `60_000..3_599_999` → `Xm YYs` zero-padded (`102_000` → `1m 42s`, `60_000` → `1m 00s`); `≥3_600_000` → `Xh YYm` zero-padded (`7_500_000` → `2h 05m`).
  - `export function presetSinceMs(preset: 'today' | 'last7' | 'last30' | 'all', now: Date): number | undefined` — `all` → `undefined`; else local midnight of the range start (today = `new Date(y,m,d)`; last7 = today − 6 days; last30 = today − 29 days).
  - `export function dayKey(ms: number): string` and `export function dayLabel(ms: number, now: Date): string` — `Today` / `Yesterday` / localized date via `Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: ... })` (year omitted in the current year).
  - Reuse `formatSize` from `@/components/FileList` for all size rendering (import where needed).

**Acceptance Criteria:**
- Types match Rust camelCase field-for-field, including `SessionOutcome` mirroring `Counts` (spec §3.2, §5.7).
- `setFilters` merges partials and resets page to 0; unchanged filters are a no-op identity (no redundant refetch); stale responses never overwrite newer ones (spec §5.4).
- Hook refetches on mount, filter/page change, manual refresh, and `batch:complete`; unlistens on unmount; `history:error` maps to the pinned toast copy; load rejection surfaces `error` (spec §5.6, §4.1).
- `presetSinceMs` uses local midnight via `Date` construction, correct on DST transition days and year rollover; `all` → `undefined` (spec §3.5, §8 risks).
- `dayKey` groups by local calendar day; `dayLabel` renders Today/Yesterday/localized with year only when not the current year (spec §5.2).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `formats durations` — 0→`—`, 45s, 1m 42s, 2h 05m
- `formatDuration_boundaries` — 999/1000 ms, 59_999/60_000, 3_599_999/3_600_000, negative → `—`
- `maps presets to local midnights` — today/last7/last30/all
- `presetSinceMs_dst_transition_days` — US spring-forward and fall-back local dates resolve to local midnight, not ±1h
- `presetSinceMs_year_rollover` — Jan 1 `last7` → Dec 26 previous year
- `labels today and yesterday` — plus cross-month and different-year label (year shown)
- `dayKey_same_day_and_midnight_boundary` — 09:00 and 23:59 same key; next day differs
- `loads on mount` — invoke payload `{ filters: {}, page: 0, pageSize: 50 }`
- `setFilters merges and resets page` — page 2 → filter change → page 0 payload
- `setFilters unchanged keeps identity` — same value → no new invoke; `setPage(2)` → exactly one new invoke (dedupe count)
- `refetches on batch:complete` — invoke count grows
- `toasts on history:error` — pinned copy
- `load rejection sets error` — rejected invoke → `error` set, `loading` false
- `clearHistory refetches` — clear_history called + response updated
- `clearHistory failure toasts` — rejection → `console.error('clear_history failed:', …)`, `toast.error('Could not clear history')`, response kept
- `clearError resets error` — Retry dependency
- `manual refresh refetches` — refresh() triggers a new invoke
- `response retained during refetch` — refresh() held pending mid-flight: `loading` true and previous response non-null; resolves → new response, error null
- `unlisten on unmount` — registry handlers removed
- `stale response ignored` — page-2 resolves before the held page-1 promise; resolving the held stale page-1 payload after page 2 wins does not overwrite the response (may be split as `stale response ignored` + `stale rejection ignored after newer resolves`: rejecting the held page-1 promise after a newer resolve is also ignored — `error` stays null, response kept; resolve/reject wrapped in awaited `act` so microtasks flush before asserts)
- `setFilters merge accumulation` — successive partials accumulate: `statuses` then `search` → last invoke payload contains both keys, page 0
- `setFilters unchanged page-preserving` — on page 2, an unchanged `setFilters` leaves page and filters untouched, no refetch (covered by `setFilters unchanged keeps identity`)
- `error clears on successful reload` — rejection then success → `error` null with populated response
- `listener registration failure degrades gracefully` — listen rejects → data still loads, no unhandled rejection, degraded toast fires (`batch:complete` variant log-only: no toast, hook loads fine, emit has no effect)
- `unmount before listen resolves unregisters handlers` — unmount while the listen() promises are still pending unregisters both handlers once they resolve (covers the disposed branch in `done`)
- `listener rejection after unmount stays silent` — held listen() promises rejected after unmount → no degraded toast and no console.error (both listener catches consult `disposed`)
- `stale response ignored` rejection extension — superseded by the split above (`stale rejection ignored after newer resolves` rejects a still-pending page-1 promise; a reject on an already-settled promise is a no-op and was removed from the resolve-half test)
- `presetSinceMs_dst_transition_days` extension — EU transition dates (Mar 29 / Oct 25 2026) alongside US (Mar 8 / Nov 1), plus a `last7` case spanning a transition (now = Oct 26 2026 15:00 → `new Date(2026,9,20).getTime()`; the 25-hour EU fall-back day Oct 25 lies inside the window, so the test discriminates naive hour arithmetic on timezones whose fall-back transition falls inside the window — EU Oct 25/26, e.g. dev CEST; US runners transition Nov 1, other TZs unchanged — `setDate` is correct by construction regardless)
- `dayLabel yesterday across year boundary` — now = Jan 1 2027 03:00, label for Dec 31 2026 20:00 → `Yesterday`
- `formats duration boundaries` extension — `3_599_999` → `59m 59s` (plan-required boundary pair completion)

Required-test title mapping (bullets above are behavior aliases; shipped `it()` titles):
- `formatDuration_boundaries` → `formats duration boundaries`
- `presetSinceMs_dst_transition_days` → `pins DST transition midnights and year rollover`
- `presetSinceMs_year_rollover` → covered by `pins DST transition midnights and year rollover`
- `dayKey_same_day_and_midnight_boundary` → `keys days by local calendar date`
- `clearHistory refetches` → `clearHistory refetches and updates response`
- `clearHistory failure toasts` → `clearHistory failure toasts and keeps response`
- `dayLabel yesterday across year boundary` → `labels yesterday across year boundary`

- [x] **Step 1: Write the failing tests**

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
    const sep = dayLabel(new Date(2026, 8, 20).getTime(), now)
    expect(sep).toMatch(/Sep/)
    expect(sep).not.toMatch(/2026/)
    expect(dayLabel(new Date(2025, 8, 20).getTime(), now)).toMatch(/2025/)
  })

  it('pins DST transition midnights and year rollover', () => {
    const spring = new Date(2026, 2, 8, 15, 0)
    expect(presetSinceMs('today', spring)).toBe(new Date(2026, 2, 8).getTime())
    const fall = new Date(2026, 10, 1, 15, 0)
    expect(presetSinceMs('today', fall)).toBe(new Date(2026, 10, 1).getTime())
    const rollover = new Date(2027, 0, 1, 1, 0)
    expect(presetSinceMs('last7', rollover)).toBe(new Date(2026, 11, 26).getTime())
  })

  it('keys days by local calendar date', () => {
    const now = new Date(2026, 9, 2, 14, 30)
    const morning = new Date(2026, 9, 2, 9, 0).getTime()
    const night = new Date(2026, 9, 2, 23, 59).getTime()
    const nextDay = new Date(2026, 9, 3, 0, 1).getTime()
    expect(dayKey(morning)).toBe(dayKey(night))
    expect(dayKey(morning)).not.toBe(dayKey(nextDay))
  })

  it('formats duration boundaries', () => {
    expect(formatDuration(-5)).toBe('—')
    expect(formatDuration(999)).toBe('1s')
    expect(formatDuration(1_000)).toBe('1s')
    expect(formatDuration(59_999)).toBe('59s')
    expect(formatDuration(60_000)).toBe('1m 00s')
    expect(formatDuration(3_600_000)).toBe('1h 00m')
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

- [x] **Step 2: Run tests to verify they fail**

Run: `yarn test historyFormat useHistory`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement**

- `src/types.ts`: add the interfaces exactly as in Interfaces above, including `Settings.history` (GPL header already present; append at the end).
- `src/hooks/useHistory.ts`: state `response/loading/error/filters/page`; effect keyed on `JSON.stringify({filters, page})` invoking `get_history` (cancelled-flag guard like `useSettings.ts:37-58`); one effect for listeners (`batch:complete` → refetch, `history:error` → toast) with the disposed/unlisten pattern from `useCompression.ts:79-185`; `refresh` bumps a numeric nonce included in the effect key.
- `src/lib/historyFormat.ts`: pure helpers as specified; use `toLocaleDateString`/`Intl.DateTimeFormat` for labels. Add the GPL header to both new TS files (copy from `src/views/HistoryView.tsx:1-15`).

- [x] **Step 4: Run tests to verify they pass**

Run: `yarn test historyFormat useHistory && yarn build`
Expected: PASS + clean build.

- [x] **Step 5: Commit**

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
- Note: status/category chip maps reuse `FileStatus` keys — filters accept the full `FileStatus` union (`pending`/`compressing` never occur in history records, spec §3.2), but the UI offers only the 6 terminal statuses.

**UI composition (spec §5):**
- Filter bar (pinned): search `Input` (placeholder "Search name, path, error…", Esc clears), Status chips (6 toggle buttons, `aria-pressed`), Category chips (5), Date `Select` (4 presets, default All time), Output folder `Select` (options from `response.outputFolders`, plus an "All folders" reset), `Clear filters` button + active count when any filter set. Date preset maps through `presetSinceMs` → `sinceMs` filter (omit when undefined).
- Summary line (pinned): from `response.summary` — `{sessions} sessions · {files} files · {saved} saved · {failed} failed`; `Clear history` button (destructive ghost) → `AlertDialog` confirm (title "Clear history?", body "Permanently deletes all compression history. Files on disk are not affected.", confirm button "Delete history", cancel dismisses) → `clearHistory`.
- `skippedLines > 0` → muted notice line above the list.
- Session list: sticky day headers (`dayLabel`), each session = disclosure `<button aria-expanded aria-controls aria-label="Toggle session details">` row: time (`Intl`), `fileCount`/`N matches` label (singular "1 match" / plural "N matches"), `original → compressed` (Σ original, Σ compressed over displayed files), `% saved`, `formatDuration(endedAt - startedAt)` (or `—` when interrupted), Interrupted/Cancelled chip, outcome chips (icon + text; count from `outcome` filtered to displayed files when `matchedFiles != null`), `Open output folder` icon button (disabled when no file has `outputPath`).
- Expanded file table (semantic `<table>` with `aria-label`): File (name + muted parent dir, title = full path), Type badge, Status → reuse status presentation (copy the label/style maps from `FileList.tsx:67-104` — no export exists, do **not** refactor FileList), Target (`formatSize`), Result (`x → y · z%` or `—`), error inline under name in destructive text, Actions: reveal output (disabled without `outputPath`), copy output path (same), reveal source, copy source path — each `aria-label`ed; reveal calls `invoke('reveal_in_folder', { filePath })`; copy uses `navigator.clipboard.writeText` + `toast.success('Path copied')`, failure → `toast.error('Could not copy path')`.
- Auto-expand: sessions with `matchedFiles != null` start expanded; user toggles override per session id (state map reset when `response` identity changes).
- Pagination footer: `HistoryPagination { page, pageSize, totalSessions, onPageChange }` → `Page X of Y` + Prev/Next (Prev disabled page 0, Next disabled last page).
- States: loading → 3 skeleton rows; error → card + Retry (`clearError` + `refresh`); empty (no filters, zero sessions) → existing Empty card copy "Compressed files and their results will appear here."; no matches → Empty "No matches" + `Clear filters`.

**Acceptance Criteria:**
- Filter bar produces correct `get_history` payloads for every control (search debounce + Esc, status/category chips, date preset → `sinceMs`, output folder, Clear filters, active count); any filter change resets page to 0 (spec §5.4, review focus).
- Summary bar renders `response.summary` (page-independent), not per-page sums (spec §5.5, review focus).
- Sessions group under day headers; disclosure is keyboard-operable (Enter/Space, `aria-expanded`/`aria-controls`), collapsed by default; `matchedFiles != null` sessions auto-expand with `N matches` and user toggle overrides (spec §5.2, §5.4).
- Actions: reveal/copy source and output invoke the right commands with the right paths; disabled states when `outputPath` is null; `Open output folder` disabled when the session has no outputs (spec §5.3, §5.8, AC4).
- States: loading skeletons, error + Retry, empty, no-matches + Clear filters, skipped-lines notice (spec §5.6).
- Clear history confirms via AlertDialog; dismiss does nothing; confirm invokes (spec §5.5).
- Day headers render `Today`/`Yesterday`/localized dates (spec §5.2).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `renders empty state when history is empty` — `No history yet` empty card
- `shows loading skeleton rows` — 3 skeletons while pending
- `load error card retries` — error card + Retry clears error and refetches
- `renders a session row with outcome chips and metrics` — aria-expanded false, chips
- `groups sessions by day headers` — two sessions on different days → Today + Yesterday headers
- `expands on keyboard and shows the file table with inline errors` — Enter expand, error text
- `disclosure space toggles and collapse works` — Space toggles open then closed; `aria-controls` target exists
- `shows Interrupted chip for interrupted sessions` — `Interrupted` text; duration `—`
- `shows Cancelled chip for cancelled sessions` — `Cancelled` text
- `search input debounces into a filtered query` — payload `{ search, page: 0 }` after 300 ms
- `esc clears search` — Esc → filter removed
- `status chips produce payload and aria-pressed` — click failed chip → payload statuses; pressed state
- `date preset maps to sinceMs payload` — Today → sinceMs present; All time → absent
- `output folder select produces payload` — folder chosen → filter; All folders → removed
- `clear filters resets all and page` — active count gone, payload empty
- `filter change resets page from pagination` — page 2 → chip click → page 0 request
- `renders pagination and requests next page` — `Page 1 of 3`, Next → page 1
- `pagination prev next bounds` — Prev disabled page 0; Next disabled last page
- `summary bar renders response summary` — page-independent numbers from `response.summary`
- `auto-expands filtered sessions with match count` — `1 match`, table visible
- `session level matches stay collapsed and show all files when opened` — `matchedFiles: null` → no auto-expand
- `user toggle overrides auto expand` — click collapse on auto-expanded session stays collapsed
- `clear history confirms before invoking` — confirm button → `clear_history`
- `clear history cancel does not invoke` — dismiss → no call
- `copy output path writes clipboard and toasts` — `writeText` called + toast
- `reveal actions invoke with correct paths` — output reveal → outputPath; source reveal → path
- `actions disabled without output path` — reveal/copy output disabled; still enabled for source
- `copy failure toasts` — clipboard rejection → error toast
- `shows a notice when lines were skipped` — muted notice

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

Also update the old `renders history empty state` test (keeps asserting `[data-slot="empty"]` with new copy). Fix `src/App.test.tsx`: its `invoke` mock currently resolves `undefined`, but the new HistoryView calls `get_history` on mount (`App.test.tsx:48`, `:122`) — configure the mock to resolve an empty `HistoryResponse` so the click-through tests do not skeleton-flake (the History heading assertion spans `:122-125`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test HistoryView`
Expected: FAIL — new UI not implemented.

- [ ] **Step 3: Implement**

- `yarn dlx shadcn@latest add alert-dialog` then adapt to base-ui composition if the CLI emits Radix-style (existing repo components are base-ui — follow `dropdown-menu.tsx` patterns).
- Add a small `copyToClipboard(text: string)` helper inside `HistoryView.tsx` (`navigator.clipboard.writeText` → `toast.success('Path copied')`; catch → `toast.error('Could not copy path')`).
- Build the view per composition above; keep files focused: session row + file table in `HistoryView.tsx` (single consumer today), pagination in its own component file.
- Status chip styling: copy the dot+label maps from `FileList.tsx:67-104` into the view (no export exists; no FileList refactor — YAGNI).
- A11y: disclosure buttons get `aria-expanded`/`aria-controls`; day headers non-interactive; every icon button labelled; table has an `aria-label`; chips are `<button aria-pressed>`.
- Search input debounce lives in the view (300 ms) before calling `setFilters`.

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
- Modify: `src/views/SettingsView.tsx`, `src/views/SettingsView.test.tsx`, `src/hooks/useSettings.test.ts` (typed fixture — REQUIRED: add `history`)
- Test: `src/views/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `Settings.history.retentionDays` (type added in Task 8), existing `NumberStepper`, `Card` composition (`SettingsView.tsx:268-401`).
- Produces: new **History** card (between Quality Floors and the footer) with `NumberStepper` min 1 max 3650 + description "Sessions older than this are removed automatically. Files on disk are never deleted."; `updateHistoryRetention` draft updater.

**Acceptance Criteria:**
- History card renders after Quality Floors with the exact description copy; stepper min 1 / max 3650, `ariaLabel="History retention (days)"` (spec §4.3).
- Saving sends `settings.history.retentionDays` for the draft value; reset-to-defaults restores 90 (spec §4.3).
- All typed `Settings` fixtures updated (`useSettings.test.ts`, `SettingsView.test.tsx` baseSettings/resetDefaults); the existing "four cards" assertion updated to five (spec AC gate `yarn build`).
- All Required Tests pass.
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`.
- Boundary rules enforced (per `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`).

**Required Tests:**
- `saves a changed history retention value` — 30 → save_settings payload includes `history: { retentionDays: 30 }`
- `clamps history retention through the stepper bounds` — increase from 90 → 91; decrease at 1 stays 1; increase at 3650 stays 3650
- `reset to defaults restores history retention 90` — set 30, reset, save payload has 90
- `renders history card after quality floors` — card order + description copy
- `cancel discards history retention draft` — cancel → re-render shows 90

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

  it('reset to defaults restores history retention 90', async () => {
    const user = userEvent.setup()
    await loadView()
    const input = screen.getByLabelText('History retention (days)')
    await user.clear(input)
    await user.type(input, '30')
    await user.click(screen.getByRole('button', { name: /reset to defaults/i }))
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    expect(invoke).toHaveBeenCalledWith('save_settings', expect.objectContaining({
      settings: expect.objectContaining({ history: { retentionDays: 90 } }),
    }))
  })
```

Fixture updates (REQUIRED — the Settings type gained `history` in Task 8):
- `src/hooks/useSettings.test.ts` `mockSettings` and `src/views/SettingsView.test.tsx` `baseSettings`/`resetDefaults`: add `history: { retentionDays: 90 }`.
- `src/views/SettingsView.test.tsx:281` "renders four cards" — update to five cards.
- Update the reset defaults fixture to include `history: { retentionDays: 90 }` so the reset payload is complete.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test SettingsView`
Expected: FAIL — no History retention control.

- [ ] **Step 3: Implement**

- Add the History card after the Quality Floors card; wire `NumberStepper` with `id="history-retention-days"`, `ariaLabel="History retention (days)"`, `min={1}`, `max={3650}`, `updateHistoryRetention` writes `draft.history.retentionDays`.
- Update the typed fixtures listed above and the card-count assertion (both would otherwise fail `yarn build`/`yarn test`).
- Note: the stepper input renders `type="text"` (base-ui) — repo convention asserts with `toHaveDisplayValue` (`NumberStepper.test.tsx:31-41`); `toHaveValue` also works but prefer the convention.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test SettingsView && yarn build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/SettingsView.tsx src/views/SettingsView.test.tsx src/hooks/useSettings.test.ts
git commit -m "feat(settings): add history retention control"
```

---

### Task 11: Acceptance — end-to-end verification pass

**Files:**
- Create: `docs/superpowers/plans/2026-10-02-history-audit-trail-acceptance-table.md`
- Test: `src-tauri/src/history.rs` test module (automated AC proxies below)

This task is **verification only** for production code — no production behavior changes. It adds automated AC proxies (tests) and runs the spec's acceptance criteria against the built app, recording evidence. Use `yarn tauri dev`.

**Acceptance Criteria:**
- Automated AC proxies pass in CI (`cargo test history`): search beyond page 1, retention-after-settings-change wiring, mixed corrupt file through load, partial-write/restart fold, keyboard proxy where testable.
- Manual rows (kill -9, native reveal, keyboard-only flow) recorded with evidence or explicit deviations in the acceptance table (spec §7).
- Gate green: `yarn build && yarn test && cd src-tauri && cargo test` (AGENTS.md GATE_COMMAND; `GATE_E2E_COMMAND = none`).
- Acceptance table committed with per-row result.

**Required Tests:**
- `ac3_search_finds_file_beyond_first_page` — seed 60 sessions where the last (oldest) contains a uniquely named file; `query_history(filters{search}, page 0, 50)` → `total_sessions == 1` and the response includes it (search covers full history, not the page)
- `ac5_trim_uses_effective_retention_from_settings` — settings retention 10 + seeded old session → `trim(settings.history.effective_retention_days(), now)` drops it
- `ac6_mixed_corrupt_file_loads_with_count` — real file with malformed + unknown-type + valid lines → `load().skipped_lines` matches malformed count; sessions intact
- `ac2_partial_write_restart_folds_interrupted` — write start + 2 files, no end, reload from disk → Interrupted with exactly those 2 files (restart proxy)
- `ac8_compression_pipeline_unchanged` — proxy is the existing queue suite staying green (no new test; recorded in the acceptance table)

**Verification debt note:** the mid-flight cancel path (`Err(Cancelled)` → `record_cancelled` with measured duration) and the `!flipped` race branch in `process_single_job` are not deterministically simulatable in the sidecar-less test environment (no real compression to interrupt mid-flight, no way to interleave `cancel_file` between the status clone and the flip). They must be covered by the manual acceptance pass (row 2 `kill -9` and a cancel-during-compression run) or recorded as accepted verification debt in the acceptance table.

- [ ] **Step 1: Gate**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: all green.

- [ ] **Step 2: Add the automated AC proxies**

Add the five `ac*` tests from Required Tests to `src-tauri/src/history.rs`; run `cd src-tauri && cargo test history` and expect PASS.

- [ ] **Step 3: Manual pass (record evidence per row)**

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

- [ ] **Step 4: Write the acceptance table file with evidence + deviations**

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-10-02-history-audit-trail-acceptance-table.md src-tauri/src/history.rs
git commit -m "docs(history): record acceptance evidence for history audit trail"
```

---

## Self-Review Notes

- Spec §3.1–3.7 → Tasks 2–5; §4.1 → Task 6; §4.2 → Task 7; §4.3 → Tasks 1 + 10; §5 → Tasks 8–9; §6 → tests inside every task + Task 11; §7 ACs → Task 11 table.
- `HistoryStore` stays Runtime-generic (`new_in` takes a path for tests; `new` takes `&AppHandle<R>`) so queue MockRuntime tests can manage it.
- Task 6's helper resolves the store via `try_state` — queue tests that predate history keep passing without managing one, while the updated `make_app` exercises it deliberately.
- Date presets: webview computes `sinceMs` (local midnight); Rust compares inclusively — no new dependency, correct DST.
