# History Audit Trail — Acceptance Table

> Plan: `docs/superpowers/plans/2026-10-02-history-audit-trail.md` (Task 11) ·
> Spec §7: `docs/superpowers/specs/2026-10-02-history-audit-trail-design.md` ·
> Automated pass date: 2026-10-03

Environment note: rows that require the interactive desktop app (`yarn tauri dev`)
or OS-level actions (SIGKILL of the built app, native Finder reveal, keyboard-only
manual flow) could not be driven from the automated environment. They are recorded
below as explicit deviations, each with the exact manual step to run.

| # | Spec AC | How proven | Result |
|---|---------|------------|--------|
| 1 | Complete a batch → session appears in History without restart; counts, sizes, statuses and per-file rows match what happened | Queue write-point records pinned by Task 6 integration tests (`src-tauri/src/queue.rs` MockRuntime suite); view rendering covered by `src/views/HistoryView.test.tsx` suite | **PENDING-MANUAL — requires interactive GUI verification (`yarn tauri dev`):** compress 2+ files, open History without restart, verify the new session row appears with counts/sizes/statuses per file matching the batch |
| 2 | Force-kill mid-batch → reopen → session shows **Interrupted** with the files that finished; preflight failures create no session | Fold-side restart proxy: `ac2_partial_write_restart_folds_interrupted` (`src-tauri/src/history.rs`) — start + 2 file records, no session_end, reload from disk → Interrupted, exactly the 2 files, outcome computed from files; preflight failure "no session" pinned by queue tests | **PENDING-MANUAL — requires interactive GUI verification (`yarn tauri dev`):** start a large batch, `kill -9` the app, relaunch, verify Interrupted with finished files only |
| 3 | Every filter and combination narrows correctly over the full retained history; summary bar reflects the entire filtered set regardless of page; pager navigates; one click clears filters | **AUTOMATED** — `ac3_search_finds_file_beyond_first_page` (60 seeded sessions, unique file on the oldest beyond page 1 → `total_sessions == 1`, page-independent summary); the Task 4 query suite covers filter combinations (`query_combined_filters`, `query_multi_status_filters_are_a_union`, `query_since_ms_inclusive_boundary`, …), page-independence (`query_summary_is_page_independent`) and pager clamps; UI pager + clear-filters covered by `HistoryView` tests `renders pagination and requests next page` / `clear filters resets all and page` / `filter change resets page from pagination` | AUTOMATED — all green |
| 4 | Reveal/copy work for source and output; missing outputs disable gracefully | Frontend proxies: `reveal actions invoke with correct paths`, `copy source path writes clipboard and toasts`, `copy output path writes clipboard and toasts`, `actions disabled without output path`, `open output folder disabled when session lacks outputs`, `reveal failure toasts`, `copy failure toasts` (`src/views/HistoryView.test.tsx`) | **PENDING-MANUAL — requires interactive GUI verification (`yarn tauri dev`) + OS-level native Finder reveal:** confirm reveal opens Finder/Explorer at the real path and a moved file shows the error toast while copy still works; automated frontend tests cannot exercise the OS shell handler |
| 5 | Retention setting (default 90) removes old sessions on the next trim; Clear history wipes after confirm | Trim proxy: `ac5_trim_uses_effective_retention_from_settings` — settings `retentionDays: 10` → `effective_retention_days()` drives `trim(…, now)` and drops the 11-day-old session; retention trim edge cases pinned in the trim suite (`trim_keeps_session_exactly_at_boundary`, …); clear-history wiring covered by `useHistory`/`HistoryView` tests + `trim_store_removes_whole_session_lines` | **PENDING-MANUAL — requires interactive GUI verification (`yarn tauri dev`):** set retention to 1 day, relaunch, verify old sessions gone; run Clear history and verify wipe after the confirm dialog |
| 6 | Corrupt/old history files load without crashing; unknown records ignored | **AUTOMATED** — `ac6_mixed_corrupt_file_loads_with_count` (real file: 3 malformed + 1 unknown-type + valid session → `skipped_lines == 3`, sessions intact); `load_counts_lossy_non_json_line_as_skipped`, `fold_skips_malformed_counts_them_and_ignores_unknown_types`; the corrupt-lines notice rendering is covered by `HistoryView` test `shows a notice when lines were skipped` (`src/views/HistoryView.test.tsx:817`) | AUTOMATED — all green |
| 7 | Keyboard-only users can filter, expand, paginate, and action; labels announced | Automated proxies (attentionable keyboard semantics per Testing Library): `expands on keyboard and shows the file table with inline errors`, `disclosure space toggles and collapse works`, `status chips produce payload and aria-pressed` (`src/views/HistoryView.test.tsx`) | **PENDING-MANUAL — requires interactive GUI verification (`yarn tauri dev`):** tab through the filter bar, toggle chips, expand a session, paginate, activate an action keyboard-only; confirm labels are announced by a real screen reader |
| 8 | Zero behavior change to the compression pipeline: gate command green | **AUTOMATED** — full `GATE_COMMAND` green in this environment: `yarn build` ✓, `yarn test` 247/247 (14 files), `cd src-tauri && cargo test` 386 passed, 0 failed, 4 ignored (382 pre-existing + 4 new AC proxies); queue suite green: 50/50 (`cargo test queue`) | AUTOMATED — all green (record) |

## Verification debt

Recorded per plan "Verification debt note" — the following behaviors are not
deterministically simulatable without the sidecar binaries and a running app:

- **Mid-flight cancel path** (`Err(Cancelled)` → `record_cancelled` with measured
  duration in `queue.rs`): no real sidecar compression can be interrupted mid-flight
  in the test environment. Requires the manual pass (row 1 with a cancel during an
  active compression, or row 2's `kill -9`).
- **`!flipped` race branch** in `process_single_job` (cancel_file interleaving
  between the status clone and the flip): not interleaveable from tests.
- **GUI rows above** (1, 2, 4, 5, 7): require the interactive desktop app and/or
  OS-level actions and await a manual acceptance pass.

These are accepted verification debt until a human runs the manual acceptance pass
(`yarn tauri dev`) and updates each PENDING-MANUAL row with evidence.

## Task 11 deferred item

- **Manual refresh button follow-up:** per plan Task 8, `batch:complete` listener
  registration failure degrades log-only ("manual refresh is the fallback" /
  "manual refresh arrives with the Task 11 follow-up; until then, view remount
  re-fetches"). A visible manual-refresh affordance in the History view remains a
  follow-up item after this feature branch.

## Gate evidence (automated run, 2026-10-03)

- `yarn build` — passed (Rolldown build; chunk-size warning pre-existing).
- `yarn test` — 247 passed / 0 failed across 14 files.
- `cargo test` — 386 passed / 0 failed / 4 ignored (3 suites); including:
  - `history.rs` test module: 111 passed (includes ac2/ac3/ac5/ac6 proxies).
  - `queue.rs` suite: 50 passed / 0 failed.
- Spec §6 testing targets met; no production behavior changes in this task
  (tests + this table only).
