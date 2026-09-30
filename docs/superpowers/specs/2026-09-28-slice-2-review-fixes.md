# Slice 2 Review Fixes — Spec

**Date:** 2026-09-28
**Status:** Approved
**Source:** Post-merge review of `2026-09-27-slice-2-file-detection.md` (4-agent pr-review-toolkit audit)
**Parent plan:** `docs/superpowers/plans/2026-09-27-slice-2-file-detection.md`

---

## 1. Problem Statement

Slice 2 (file detection + file list) was merged with defects found in code review and confirmed
by manual testing: drag-and-drop is entirely non-functional on macOS (acceptance criteria 1 and 9
fail), IPC failures are invisible to the user, and several production-code / test-quality defects
exist. This spec defines the fixes. No new features.

## 2. Findings to Fix

### F1 (CRITICAL): `File.path` does not exist in Tauri 2 — drag-and-drop dead

`src/components/DropZone.tsx` extracts dropped file paths via
`Array.from(e.dataTransfer.files).map((f) => f.path).filter(Boolean)`.
`File.path` was a Tauri v1 webview patch; Tauri 2 removed it (tauri#4496). On macOS WKWebView
every dropped file has no `path`, so `filter(Boolean)` yields `[]` and the drop is silently
ignored. HTML5 drag events also do not fire on Windows WebView2 while `dragDropEnabled` is true
(the Tauri default), so the current code would not work there either.

**Fix:** Rewrite `DropZone` to subscribe to Tauri's native drag-drop events via
`getCurrentWebview().onDragDropEvent(handler)` from `@tauri-apps/api/webview`. Event payload is a
discriminated union:

```typescript
type DragDropEvent =
  | { type: 'enter'; paths: string[]; position: PhysicalPosition }
  | { type: 'over'; position: PhysicalPosition }
  | { type: 'drop'; paths: string[]; position: PhysicalPosition }
  | { type: 'leave' }
```

The `drop` variant carries `paths: string[]` on all platforms. HTML5 handlers, the `dragCounter`
ref, and the `File.path` declaration in `src/vite-env.d.ts` are removed. Drops anywhere in the
webview are accepted (superset of "drop onto zone" — the zone remains the visual affordance and
click/keyboard-to-browse target).

### F2 (HIGH): Zero error handling on IPC calls

All four async ops in `src/hooks/useFileList.ts` (`addFiles`, `browseFiles`, `removeFile`,
`clearList`) have no try/catch, and call sites pass them directly to `onClick`/`onDrop`. Any IPC
failure (command panic, dialog failure) becomes an unhandled promise rejection: the user sees
nothing, Rust state and React state appear frozen.

**Fix:** Wrap every op in try/catch. Expose `error: string | null` from the hook; clear it on
success; render a visible error banner (`role="alert"`) in `CompressView`. State mutation stays
strictly after successful invoke (ordering already correct).

### F3 (HIGH): Mutex poisoning panics command threads

`src-tauri/src/commands.rs` uses `state.0.lock().unwrap()` in all three commands. A poisoned
mutex panics every subsequent command until app restart. The repo's own test
(`test_mutex_poison_recovery`) demonstrates the correct recovery
(`unwrap_or_else(|e| e.into_inner())`) but production never uses it.

**Fix:** All command-side locks use `.lock().unwrap_or_else(|e| e.into_inner())`.

### F4 (HIGH): Tests exercise copied code, not production commands

All 10 tests in `commands.rs` call `add_files_direct` / `remove_file_direct` / `clear_list_direct`
— verbatim duplicates of the command bodies. A regression in the real `add_files` (broken dedup,
swapped return) would pass all tests.

**Fix:** Extract core logic into `pub(crate)` fns operating on `&mut Vec<FileEntry>`; the
`#[tauri::command]` wrappers lock + delegate; tests call the core fns. Delete the copies.

### F5 (MEDIUM): `add_files` accepts directories; dedup is exact-string

- `std::path::Path::exists()` passes for directories → dead entries. Use `is_file()`.
- Dedup compares raw path strings: on case-insensitive APFS the same file can be added twice as
  `/a/B.jpg` and `/a/b.jpg`; `/a//b.jpg` variants also evade dedup.

**Fix:** Require `is_file()`, then `std::fs::canonicalize` before dedup compare; store the
canonical path in the entry (canonical paths also benefit the later compression stage). Files
that fail canonicalization are skipped.

### F6 (MEDIUM): Detection mis-handles dot-less filenames

`detect_category` uses `filename.rsplit('.').next()`. A file named `jpg` or `pdf` (no dot)
yields the whole string as the "extension" and is misdetected as Image/PDF.

**Fix:** Use `std::path::Path::extension()` semantics (`None` for `noextension`, `.hidden`,
`file.` trailing dot). New tests: `"jpg"` → Other, `"file."` → Other, `".hidden"` → Other.

### F7 (MEDIUM): Dead duplicated display strings

`detection.rs::category_label` / `category_formats` are unused (compiler warns) and duplicate
`categoryLabel` in `FileList.tsx` — drift risk.

**Fix:** Delete both functions and their tests; frontend owns display labels.

### F8 (MEDIUM): Non-UTF8 filenames become "unknown"

`models.rs` maps `file_name().and_then(|n| n.to_str())` → `unwrap_or("unknown")`. Legal non-UTF8
names silently render as "unknown".

**Fix:** Use `to_string_lossy()`.

### F9 (MEDIUM): `formatSize` has no GB tier

A 5 GB video renders "5120.0 MB". Add a GB tier (`bytes / 1024^3`, 2 decimals).

### F10 (MEDIUM): Icon-only remove button not accessible

Remove button has `title` but no `aria-label`. Add
`aria-label={`Remove ${file.name}`}`.

### F11 (HIGH, coverage): Zero frontend tests; no test runner

Plan Tasks 5–10 required ~47 frontend tests (`useFileList`, `DropZone`, `FileList`,
`CompressView`, types). None exist; `package.json` has no test script or runner. The gate
(`yarn build && cargo test`) never exercises frontend behavior.

**Fix:** Add vitest + @testing-library/react + jsdom infra; write behavioral tests for
`useFileList` (IPC mock), `DropZone` (drag-drop event mock), `formatSize`, and CompressView
wiring. Update `GATE_COMMAND` in `AGENTS.md` to `yarn build && yarn test && cd src-tauri && cargo test`.

### F12 (LOW): False-positive / spec-divergent Rust tests

- `test_file_entry_new_permission_denied` uses `/root/forbidden.jpg`, which on macOS is ENOENT —
  same path as the missing-file test. Replace with a real 0o000-permission directory under a
  tempdir.
- `test_file_entry_new_empty_filename` asserts `"to"` for `"/path/to/"` (Rust std behavior),
  diverging from the plan's `"unknown"` intent. Directories are rejected by F5's `is_file()`
  check before `FileEntry::new` is ever called on them; keep the std-behavior assertion but
  document it.

## 3. Out of Scope

- Sonner toasts (spec'd for a later slice; inline error banner suffices now).
- `FileId` newtype, zod runtime validation, specta codegen, status-transition state machine.
- Re-adding `file:added` event emission (plan prose mentioned it; current architecture resolves
  categories synchronously in `add_files` return — keep).
- Windows/UNC path nuances of `std::fs::canonicalize` beyond consistency of comparison.

## 4. Acceptance Criteria

1. Dropping files (any category) onto the app window in the production build adds them to the
   list — verified manually on macOS with `onDragDropEvent`.
2. Any drop/browse/remove/clear IPC failure shows a visible error banner; React state unchanged.
3. `cargo test` green; no `lock().unwrap()` in commands; no dead-code warnings in detection.
4. A file named `jpg`, `file.`, `.hidden` detects as Other.
5. Same file added via two APFS-case spellings is deduplicated; directories are rejected.
6. `yarn test` (vitest) green; covers useFileList IPC paths, DropZone events, formatSize tiers.
7. Gate `yarn build && yarn test && cd src-tauri && cargo test` passes clean.
8. Production bundle builds (`yarn tauri build`).