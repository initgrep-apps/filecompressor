# History Audit Trail — Design Spec

**Date:** 2026-10-02
**Status:** Approved (design review) → pending spec review
**Source:** User request — filterable/searchable compression history with session grouping and file-path links
**Scope:** v1 history feature (replaces the `HistoryView` placeholder)

---

## 1. Overview

The app currently records nothing about completed compressions. The History view is an
empty-state placeholder. This spec defines a **local audit trail**: every compression
session and every file result is persisted on-device (offline, metadata only) and surfaced
in a filterable, searchable History view with links to the actual source and output paths.

### Goals

1. Answer "what happened to my files?" across app restarts — sizes, statuses, savings,
   output locations, timings, errors.
2. Group records by **session** (= existing `batch_id` from `compress_all`), with a flat
   file table available inline per session.
3. Search (name / path / error) and filter (status, category, date preset, output folder).
4. Act on results: reveal source/output files, copy paths, open a session's output folder.
5. Honest audit semantics: interrupted runs are visible as **Interrupted**, not hidden.

### Non-goals (v1)

- CSV/JSON export (deferred slice; model supports it).
- Per-session delete (retention + clear-all cover hygiene).
- Charts/trend dashboards, column sorting, server-side pagination.
- Live per-file streaming into History (refresh on mount / batch completion / manual).
- Recording files that were never part of a batch (added then cleared without compressing).

---

## 2. Decisions (locked with user 2026-10-02)

| Decision | Choice |
|---|---|
| History layout | Session list + inline expand (row click/Enter expands file table) |
| Storage | **JSONL append file** in OS app-data dir (same dir as `settings.json`) — no DB, no new deps |
| Path | Tauri `app.path().app_data_dir()/history.jsonl` — OS-native per platform, app-owned |
| Session identity | Existing `batch_id` from `compress_all` (no new identity concept) |
| Record cadence | Append as-you-go: `session_start` → one record per file outcome → `session_end` |
| Interrupted runs | Missing `session_end` ⇒ **Interrupted** badge; recorded files still shown |
| Retention | **Configurable in Settings**, default **90 days**; auto-trim on startup + after each batch |
| Search scope | Name, source path, output path, **and error text** (one box) |
| Filters | Status (multi), Category (multi), Date presets (single), Output folder (single) |
| Overview | Filtered summary bar (sessions · files · saved · failed) |
| Row actions | Reveal source, copy source path, reveal output, copy output path, open session output folder |
| Refresh | On view mount, on `batch:complete`, manual refresh button |
| Clear | "Clear history" with confirm dialog (clears all, not just filtered) |

---

## 3. Storage

### 3.1 File & format

- `history.jsonl` under `app.path().app_data_dir()`, created (`create_dir_all`) on first use.
- Append-only JSONL: **one JSON object per line**, one line per event.
- Timestamps: **epoch milliseconds, UTC** (no new Rust dependency; the UI formats via
  `Intl.DateTimeFormat` in user locale/timezone).
- A crash/kill mid-run loses at most the line being written — never the file.
- Rewrite happens **only** for retention trim and clear. Trim rewrite is atomic:
  write `history.jsonl.tmp` in the same dir → rename over `history.jsonl`. On failure the
  original file is left intact.

### 3.2 Records

Three record kinds, discriminated by `"type"`. All fields camelCase.

```jsonl
{"type":"session_start","sessionId":"<batch-uuid>","startedAt":1759400000000,"fileCount":12,"outputFolder":"/Users/x/Documents/Compressed"}
{"type":"file","sessionId":"<batch-uuid>","fileId":"…","completedAt":1759400012345,"name":"photo.jpg","path":"/Users/x/photo.jpg","outputPath":"/Users/x/Documents/Compressed/photo.jpg","category":"image","targetBytes":204800,"originalSize":5242880,"compressedSize":183500,"status":"done","qualityUsed":75,"strategyUsed":"quality=75","error":null,"durationMs":1234}
{"type":"session_end","sessionId":"<batch-uuid>","endedAt":1759400050000,"totalSavedBytes":5100000,"counts":{"done":10,"bestEffort":1,"failed":1,"cancelled":0,"unsupported":0,"alreadyUnderTarget":0},"cancelled":false}
```

Field notes:

- `category`: existing snake_case category values (`image`, `video`, `pdf`, `document`, `other`).
- `status`: existing `FileStatus` values (`done`, `best_effort`, `failed`, `cancelled`,
  `unsupported`, `already_under_target`).
- `outputPath`, `compressedSize`, `qualityUsed`, `strategyUsed`, `error` are optional
  (absent/`null` for outcomes that don't have them).
- `qualityUsed` / `strategyUsed` are captured from `CompressionResult` — currently computed
  by the engine and dropped before the `file:complete` event. Per-file "what the engine
  actually did" detail for the audit tooltip.
- `durationMs` measured in the worker per file (start → terminal outcome; 0 for files
  cancelled before their worker slot).
- `counts` in `session_end` is accumulated in the worker (not derived from UI state).
- `cancelled` in `session_end` is true when the batch ended via cancel-all.

### 3.3 Compatibility rules

- **Append-only schema.** Readers ignore unknown `type` values and tolerate unknown/missing
  fields (parse per line into the specific struct; failures fall back to skip + count).
- Any future field must be optional or serde-defaulted — old files keep loading.
- Malformed lines are **skipped and counted**; the count surfaces to the UI as a muted
  notice. Corrupt lines never crash the app and never block reading the rest.
- No migration needed: no history file exists before this feature.

### 3.4 Folding (read path)

`get_history` parses records and folds them into sessions:

- Session = records sharing `sessionId`. Files sorted by `completedAt`.
- Duplicate `fileId` within a session: last record wins (defensive; worker writes once).
- `session_end` present ⇒ `endedAt`, exact `counts`, `cancelled` flag.
- `session_end` absent ⇒ `interrupted: true`; `endedAt = null`; counts and
  `totalSavedBytes` computed from the recorded files.
- Sessions returned **newest first** (by `startedAt`). Reads and writes share a mutex, so a
  read never observes a partially written line.

### 3.5 Retention (90-day default, configurable)

- Trim runs on **app startup** and **after each batch** (`finish_batch`).
- A whole session is dropped when its **newest** record (`max(startedAt, all completedAt,
  endedAt)`) is older than `now - retentionDays`. Files of a dropped session drop with it.
- Rewrite only when something actually drops; atomic as described in §3.1.
- `retentionDays` clamps to `1..=3650`; invalid/missing ⇒ 90.
- Trim failure is non-fatal: warn to stderr, retry next startup/batch.
- Manual **Clear history** removes the file entirely (after confirm).

### 3.6 Module design — `src-tauri/src/history.rs`

Pure functions over `&Path` + thin Tauri wrappers, same style as `output.rs` / `temp.rs`:

```rust
pub struct HistoryStore { path: PathBuf, lock: Mutex<()> }   // managed Tauri state

impl HistoryStore {
    pub fn new_in(dir: &Path) -> Self;                       // history.jsonl under dir
    pub fn new<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String>; // app_data_dir
    pub fn append_session_start(&self, rec: &SessionStartRecord) -> Result<(), String>;
    pub fn append_file(&self, rec: &FileResultRecord) -> Result<(), String>;
    pub fn append_session_end(&self, rec: &SessionEndRecord) -> Result<(), String>;
    pub fn load(&self) -> Result<HistoryResponse, String>;   // fold + skippedLines
    pub fn trim(&self, retention_days: u32, now_ms: i64) -> Result<u32, String>; // dropped
    pub fn clear(&self) -> Result<(), String>;
}
```

`now_ms` is injectable for retention boundary tests. All file access serialized by the
mutex. Registered in `lib.rs` setup; `queue.rs` reaches it via `app.state::<HistoryStore>()`.

---

## 4. Backend integration

### 4.1 `queue.rs` write points

| Point | Action |
|---|---|
| `process_batch` after preflight passes | `append_session_start` — preflight failures create **no** phantom sessions |
| Each terminal file outcome (done/best-effort/failed/cancelled/unsupported/already-under-target) | `append_file` — includes worker skip paths and cancel-all skips inside the batch |
| `finish_batch` | `append_session_end` (exact worker-accumulated counts + totalSaved) then `trim` using current settings |

- Write failures: warn to stderr; at most **one `history:error` event per batch**
  (`{ "message": string }`) → UI toast "History could not be saved — compression was not
  affected." **Compression never depends on history I/O succeeding.**
- Files cancelled before their worker slot: recorded with sizes and no output path.
- Unsupported files never enter batches (`compress_all` filters Pending only) ⇒ no records.

### 4.2 Commands (`commands.rs` + `lib.rs` registration)

| Command | Payload | Returns |
|---|---|---|
| `get_history` | — | `{ sessions: HistorySession[], skippedLines: number }`, newest first |
| `clear_history` | — | `()` — `Err(String)` on failure |
| `open_folder` | `path: String` | `()` — opens folder in OS file manager (`opener().open_path`); errors as `Err(String)` |

- `get_history` is `async` (parses off the main thread).
- Existing `reveal_in_folder` is reused for both source and output file reveal.

### 4.3 Settings addition

`Settings` gains a serde-defaulted section (old settings files keep loading):

```json
"history": { "retentionDays": 90 }
```

Rust: `history: HistorySettings` with `#[serde(default)]`; `HistorySettings { retention_days: u32 }`
defaulting to 90; clamp at use site (`1..=3650`). Settings UI: new **History** card after
Quality Floors — `NumberStepper` (min 1, max 3650, labelled "History retention (days)") +
description "Sessions older than this are removed automatically. Files on disk are never
deleted." Reset-to-defaults restores 90.

---

## 5. UI design

### 5.1 Layout (inside existing inset; filter bar + summary pinned, list scrolls)

```
┌ History ─────────────────────────────────────────────────────────────┐
│ [🔍 Search name, path, error…]  Status: [✓][⚠][✕][○] …  [Date ▾] [Folder ▾] │
│ 12 sessions · 340 files · 1.2 GB saved · 9 failed        [Clear history]│
├──────────────────────────────────────────────────────────────────────┤
│ Today                                                                 │  ← sticky day header
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ 2:14 PM · 12 files · 5.0 MB → 1.2 MB · 76% saved · 1m 42s    ⌄   │ │  ← session row (disclosure)
│ │ [✓ 10] [⚠ 1] [✕ 1]                        [Open output folder]   │ │
│ ├──────────────────────────────────────────────────────────────────┤ │
│ │ File             Type    Status    Target    Result          Act │ │  ← expanded file table
│ │ photo.jpg        Image   Done      200 KB   5.0 MB → 1.2 MB  📂⧉ │ │
│ │   ~/Pictures                                                 …   │ │
│ │ broken.pdf       PDF     Failed    2 MB     —                ⧉   │ │
│ │   Cannot read file: locked                                       │ │
│ └──────────────────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────────────────┐ │
│ │ 11:03 AM · 4 files · [Interrupted] 3.1 MB → 900 KB · partial  ⌄  │ │
│ └──────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 Session row (disclosure button)

- Line 1: time · file count · `original → compressed` · `% saved` · duration ·
  state chip only when `Interrupted` or `Cancelled`.
- Line 2: outcome chips — icon + text (`✓ Done 10`, `⚠ Best effort 1`, `✕ Failed 1`,
  `⏭ Skipped`, `○ Cancelled`, `= Already under target`); never color-only.
- Right: `Open output folder` (disabled if the session has no output paths) + chevron.
- Real disclosure semantics: `<button>` with `aria-expanded` / `aria-controls`, native
  Enter/Space toggle, visible focus ring. Collapsed by default.
- Sessions grouped under sticky day headers: `Today`, `Yesterday`, then localized dates.

### 5.3 Expanded file table

- Semantic `<table>`. Columns: **File** (name + muted parent dir; full path in tooltip),
  **Type** (category badge), **Status** (badge), **Target**, **Result**
  (`5.0 MB → 1.2 MB · 76%`; strategy/quality in tooltip), **Actions**.
- Failed rows show the error message inline under the name in destructive color — failure
  info is never hidden.
- Actions (icon buttons with `aria-label`s): reveal output (`📂`, disabled when no output
  path), copy output path (`⧉`), reveal source, copy source path. Copy confirms via toast.

### 5.4 Search & filters

- **Search**: one input, case-insensitive substring over file name, source path, output
  path, and error text. ~200 ms debounce; Esc clears.
- **Status** + **Category**: toggle chip rows (multi-select, `aria-pressed`), wrapping on
  narrow width. Six status chips, five category chips.
- **Date**: Select with presets `Today / Last 7 days / Last 30 days / All time`
  (session `startedAt` within range; default All time).
- **Output folder**: Select of distinct `outputFolder` values present in history.
- A session is visible if it passes session-level criteria (date, folder, text match, or
  any file match). When a file-level filter is active (search, status, category), matching
  sessions **auto-expand showing only matching files**; the session row's file-count slot
  reads `N matches` instead of the total. Sessions that match only at session level (date,
  folder) stay collapsed and show all files when opened.
- Active-filter count + **Clear filters** appears when anything is active.
- Filters are view-local state (reset when leaving the view — acceptable for v1).

### 5.5 Summary bar

Client-side from the filtered set: `N sessions · N files · X saved · N failed`.
"Filtered set" means: all files of visible sessions when no file-level filter is active;
when one is active, only the matching files (same set the auto-expanded session shows).
Saved = Σ `originalSize − compressedSize`; failed = failed count. Updates live with filters. **Clear history** sits on the right with a
shadcn AlertDialog confirm: "Permanently deletes all compression history. Files on disk
are not affected." (also mentions retention).

### 5.6 States

- No history at all: existing Empty card, copy updated ("Compressed files and their
  results will appear here.").
- No filter matches: Empty with "No matches" + Clear filters action.
- Load failure: error card with Retry.
- `skippedLines > 0`: muted one-line notice above the list ("Some history entries could
  not be read.").
- Loading: skeleton session rows.
- Refresh: fetch on mount, on `batch:complete`, manual refresh icon (`aria-label`); no
  live per-file streaming.

### 5.7 Frontend structure (per project conventions)

| File | Purpose |
|---|---|
| `src/views/HistoryView.tsx` (rewrite) | composition, states, refresh wiring |
| `src/hooks/useHistory.ts` | fetch/clear/refresh, `history:error` toast listener |
| `src/lib/historyFilters.ts` | pure: filter sessions (incl. folder/date/text), summary, day grouping — unit-testable |
| `src/components/HistoryFilterBar.tsx` | search input + chip rows + selects + clear |
| `src/components/HistorySessionRow.tsx` | session summary row + inline file table |
| `src/types.ts` | `HistorySession`, `HistoryFile`, `HistoryCounts`, `HistoryFilters`, `HistorySummary` |

- New shadcn components via CLI: `alert-dialog` (confirm). Toggle chips reuse existing
  `Badge`/`Button` patterns; no other new primitives needed.
- Reuse `formatSize` (from `FileList`) for size formatting; percentages via local helper.
- A11y: WCAG AA from existing green oklch tokens; status = icon + text; semantic table;
  disclosure pattern; sonner toasts announced; no expansion animation beyond default.

### 5.8 Error handling summary

| Case | Behavior |
|---|---|
| Corrupt/malformed lines | skip + count; muted notice; never crash |
| Write failure | stderr warn; one `history:error` per batch → toast; compression unaffected |
| Trim failure | non-fatal; retried next startup/batch; original file intact (atomic rewrite) |
| Clear failure | error toast; data left in place |
| Moved/missing files | copy path always works; reveal uses existing error toast; open-folder disabled when no outputs |
| Bad retention value | clamps `1..=3650`, fallback 90 |

---

## 6. Testing

### Rust unit (`history.rs`, tempdir)

Append/read roundtrip for all three record kinds; fold into sessions (newest first, files
sorted); unknown record `type` ignored; malformed line skipped + counted; interrupted
detection; cancelled flag; duplicate fileId last-wins; retention boundary (exactly-at vs
older-than, injected `now`); trim rewrite atomicity (original intact on simulated failure);
clear; empty/missing file. Settings: default 90, clamp, partial-fill.

### Rust integration (`queue.rs`, MockRuntime harness in existing style)

Batch writes `session_start` + one record per terminal outcome + `session_end` with exact
counts (covers done / best-effort / failed / cancelled / unsupported / already-under-target);
preflight failure writes nothing; cancel-all records cancelled files; simulated history
write failure does not fail the batch.

### Commands

`get_history` newest-first + `skippedLines`; `clear_history`; `open_folder` error path.

### Frontend (vitest + Testing Library, existing patterns)

Empty state; skeleton; error + retry; day grouping; disclosure keyboard behavior
(`aria-expanded`, Enter/Space); Interrupted/Cancelled chips; failed-row inline error;
each filter + combination incl. auto-expand-with-only-matches and `N matches`; summary bar
reflects filters; clear-history confirm flow; copy/reveal invokes; refetch on
`batch:complete`; `history:error` toast; skipped-lines notice.

### Gate

`yarn build && yarn test && cd src-tauri && cargo test` (project `GATE_COMMAND`).

---

## 7. Acceptance criteria

1. Complete a batch → session appears in History without restart; counts, sizes, statuses
   and per-file rows match what happened.
2. Force-kill mid-batch → reopen → session shows **Interrupted** with the files that
   finished; preflight failures create no session.
3. Every filter and combination narrows correctly; summary bar reflects the filtered set;
   one click clears filters.
4. Reveal/copy work for source and output; missing outputs disable gracefully.
5. Retention setting (default 90) removes old sessions on the next trim; Clear history
   wipes after confirm.
6. Corrupt/old history files load without crashing; unknown records ignored.
7. Keyboard-only users can filter, expand, and action; labels announced.
8. Zero behavior change to the compression pipeline: gate command green.

---

## 8. Risks

- **File size growth** — bounded by retention (90-day default) + clear; worst case a few MB.
- **Read latency at large counts** — capped set + async parse; in-memory filtering is fine
  at this scale (deferred: server-side pagination if 10k+ sessions ever materialize).
- **Clock changes** — timestamps monotonic enough for display/retention; retention uses
  wall-clock by design.
- **Batch id reuse** — uuid v4, collision-free in practice.
