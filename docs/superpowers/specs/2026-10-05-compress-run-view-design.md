# Compress Flow Redesign — Staging + Run Monitor

**Date:** 2026-10-05
**Status:** Approved design, pending implementation plan
**Mockups:** `docs/mockups/2026-10-05-compress-run-view.html` (approved v2)

---

## 1. Problem

Today one screen handles everything: drop zone, flat table in drop order, Compress, and a live status column. When a parallel batch runs, actively compressing files are scattered among pending/finished rows and the user must hunt for them. Failures are easy to miss, and there is no aggregate view of batch progress.

## 2. Goal

A two-screen compress flow:

1. **Staging** — drop/browse, review staged files, Compress. The app always opens here.
2. **Run monitor** — opened by pressing Compress. A kanban-style board with one lane per file category present in the batch. Actively compressing rows are visually pinned at the top of their lane, finished rows below, queued rows last. The screen is locked while the batch runs; results and the exit action appear when it completes.

Non-goals (explicitly cut from the Stitch mockups and this iteration): Pause All (backend has no pause), Batch Presets / Auto-Quality panel (overlaps Settings; future feature), CPU/RAM/AVX2/SIMD/throughput/ETA telemetry (not provided by the core; fabricated data is a trust risk), "Show Finished" collapse toggle (rows stay expanded; no expand/collapse controls), interactive filter chips, "Archives/Data" category, PRO badge, CLI status, flavor text, Thread/Seq numbering, history sidebar badge.

## 3. Locked decisions (from design review)

| Decision | Value |
|---|---|
| Theme | Existing green oklch light preset (`src/index.css`). No dark mode in this scope. |
| Layout | Horizontal kanban lanes, one per category present in the batch. Single-type batch = one lane, left-aligned. Lanes scroll horizontally when the window is narrow. |
| Lane row order | Compressing (top) → completed (drop order) → queued/pending (bottom). No section headers; state conveyed by row styling and icons. |
| Collapse | None, anywhere. |
| Status chips | Non-interactive summary counters: All files · Processing · Complete · Below target · Failed · Queued. Zero-count chips are hidden; `All files` is always shown. |
| Batch header | `Batch #<n>` pill + status pill that transitions `Compressing` (pulsing dot) → `Complete` (solid, check icon). |
| Run screen lock | No drop zone, no add-files, no back button while running. Dropping during a run shows a toast: "Batch in progress — wait until it completes". |
| Exit | `New batch` button appears when the batch completes (or is cancelled). Returns to staging with final statuses intact. |
| App launch | Always staging. The run screen is transient state, never a persisted route. |
| Row controls | Cancel on compressing rows; remove on queued rows; Reveal in Finder on rows with output (done, best_effort, already_under_target). |
| Strategy metadata | Shown on completed rows only (post-compression IPC extension, §7). Live rows show percent only. |
| Nav badge | Compress sidebar badge = number of staged files (`files.length`). |
| History nav badge | Removed. |
| Unsupported files | Not part of a batch; visible only on staging (dimmed row, no target). |
| Animations | `motion` (Framer Motion successor) — FLIP layout animations; honors `prefers-reduced-motion`. |

## 4. Flow and state machine

```
staging ── Compress (≥1 pending) ──▶ run:compressing ── batch:complete ──▶ run:complete
   ▲                                     │                                    │
   └────────────── New batch ────────────┴────────────────────────────────────┘
```

- `screen: 'staging' | 'run'` lives in `CompressView` (or a small `useRunScreen` hook). Transitions:
  - `staging → run` when `compressAll` succeeds (returns batch roster, §6).
  - `run → staging` only via the `New batch` button (enabled when the batch is no longer running).
- Sidebar navigation to History/Settings mid-run is allowed; the batch continues (backend is async). Returning to Compress shows the run screen in its current phase.
- App restart always lands on staging (no persistence of run state; file list itself is also session-scoped today — unchanged).

### Batch roster

At `compressAll`, capture the ids of all `pending` files — this snapshot is the **batch roster**. The run screen renders exactly the roster files (never files added later, never unsupported files). This makes re-Compress after a completed batch well-defined: the next batch shows only newly processed files.

## 5. Screen 1 — Staging

- Hero: split layout — dashed drop zone (left, larger) + "Or choose a file from your system", primary **Browse your files** button, and the supported-formats line in mono (`JPEG, PNG, WebP, HEIC, MP4, MOV, PDF, DOCX, XLSX, PPTX`). Implemented by extending the existing `DropZone`.
- Table (existing `FileList`, kept): columns File · Original Size · Category · Target Size · Status (status column shows results when returning from a run) · remove. Unsupported rows dimmed with an `Unsupported` chip and no target.
- Footer: `N files selected · Total size: ~X MB` (counts only compressible files) + `Clear List` + `▶ Compress` (disabled unless ≥ 1 pending and not running). Footer stays in the view's `CardFooter` as today.

## 6. Screen 2/3 — Run monitor

### 6.1 Header

- Left: `Batch #<n>` mono pill + status pill. `n` is a per-session counter incremented on each successful `compressAll` (frontend ref — no backend change; resets on app restart, which always lands on staging). Status pill: `● Compressing` (pulsing) while `isCompressing`; `✓ Complete` (solid primary) when finished; `✓ Complete` with a "Batch cancelled" toast when cancelled.
- Right: `Cancel All` (destructive outline) while running; `New batch` (primary) when finished/cancelled.

### 6.2 Chips row

Counters computed from the roster: `All files n · Processing n · Complete n · Below target n · Failed n · Queued n`, plus right-aligned `x/y processed` (y = roster size, x = terminal statuses) with a thin overall progress bar. `Complete` counts `done` + `best_effort`; `Below target` counts `already_under_target`; `Queued` counts `pending`; `Processing` counts `compressing`.

### 6.3 Kanban board

- Container: horizontal flex, `overflow-x: auto`, fixed lane width (~318px), gap 12px, subtle right-edge fade to hint scrollability. Lanes left-aligned; only categories present in the roster get lanes. Lane order: image, video, pdf, document, other (stable).
- Lane header: category icon (tinted per category) + category label + `x/y done` pill (x = terminal statuses in lane, green-tinted while the lane has live work).
- Row anatomy (div-based, not a table):
  - **Compressing:** green left accent bar (inset box-shadow), `bg-primary/5` tint, name in primary, `61.5 MB → …`, 4px progress bar, live line `<spinner> NN%` (+ strategy hint only if/when the core emits it — v1 shows percent only), cancel button.
  - **Completed** (`done`, `best_effort`, `already_under_target`, `failed`, `cancelled` — in drop order):
    - `done`: name, `-%` chip (primary tint), `original → result` mono, strategy note (`Ghostscript · JPEG re-encode · Lossy`), Reveal button.
    - `best_effort`: as done but `-%` chip amber and note prefixed `Best effort`; error text shown if present.
    - `already_under_target`: `≤ target` chip, original size only, note `Already under <target>`, Reveal button.
    - `failed`: red tint + left accent, `Failed` chip, error line (full text, no truncation), no Reveal.
    - `cancelled`: muted `Cancelled` chip, dimmed, no Reveal.
  - **Queued** (`pending`): dashed border, muted name, size + `Queued` chip, remove button.
- Empty state: a lane with zero rows never renders. A roster with a single category renders one lane, left-aligned.

### 6.4 Colors

All from existing tokens: primary for active/success, destructive for failed, amber (content color, `oklch(0.666 0.179 58.318)`) for best_effort, muted for queued/cancelled/unsupported. Category accents: image = blue, video = violet, pdf = red, document = amber, other = muted (content-level tints, `color-mix` at ~10% backgrounds — matches the mockup; these are content colors, not theme changes).

## 7. IPC changes (Rust)

1. **`file:complete` payload gains strategy fields.** `queue.rs` already computes `strategy_used: Option<String>` and `quality_used: Option<u32>` when writing history records; add both to the emitted `CompletePayload` (serde camelCase: `strategyUsed`, `qualityUsed`). No processor changes.
2. `compress_all` return value stays a `String` batchId (roster + batch number are frontend-derived). No other backend changes.

Frontend types (`src/types.ts`): `FileEntry` gains `strategyUsed: string | null`, `qualityUsed: number | null`.

## 8. Frontend architecture

```
src/
  views/CompressView.tsx            # state machine: staging | run; owns batch roster + batch number
  components/staging/DropZone.tsx   # extended: split hero + supported line (existing component)
  components/FileList.tsx           # staging table (existing, footer counts move here or stay in view)
  components/run/RunHeader.tsx      # batch pills, chips row, overall progress, actions
  components/run/KanbanBoard.tsx    # horizontal lanes container
  components/run/Lane.tsx           # lane header + rows
  components/run/RunRow.tsx         # row variants (compressing/completed/queued)
  lib/grouping.ts                   # pure: roster → lanes + counts + lane ordering
  lib/strategyLabels.ts             # pure: strategy id → { label, lossless } display mapping
  hooks/useCompression.ts           # + strategyUsed/qualityUsed capture into files; + cancelled flag ref
```

- `grouping.ts` is a pure module (unit-testable without DOM): `groupByCategory(files)`, `laneOrder(files)`, `batchCounts(files)`.
- `strategyLabels.ts` maps known strategy ids emitted by processors to human labels + a lossless flag; unknown ids render raw without a lossy/lossless tag.
- `App.tsx`: Compress nav badge = staged file count (needs `files` from context — already available via `useCompressionContext`).

## 9. Animation

- Library: `motion` (yarn dep, `motion/react` imports).
- Rows are `motion.div layout` elements keyed by `file.id` inside `AnimatePresence`: a queued row that starts compressing travels up within its lane; a completing row travels into the completed block; queued rows below slide down. Enter/exit fades for remove/cancel. Lane pills and chips are plain (no layout animation) to keep motion calm.
- Progress bars keep the existing width transition.
- All motion gated on `prefers-reduced-motion` (motion's `MotionConfig reducedMotion="user"`).

## 10. Edge cases

- Drop during run → toast, file not added (no drop handlers active on run screen).
- `cancel_all`: `file:cancelled` per in-flight file; queued files revert to `pending` (current behavior: they were never started). Batch ends → run:complete phase with "Batch cancelled" toast. Cancelled in-flight rows show `Cancelled`; never-started rows show `Queued` again and can be re-compressed from staging.
- Per-file cancel mid-run: row transitions to `Cancelled` in the completed block.
- `batch:error` (worker unavailable): header status pill switches to `Failed` (destructive) with the error message shown under the header; `New batch` available.
- Empty roster (no pending files): Compress button disabled on staging — run screen unreachable.
- Long filenames: ellipsis in rows, full name in `title` attr. Long error text wraps (max 2 lines + `title`).
- Large batches (100+ files): lanes are vertically scrollable within the board container; no virtualization in this scope (desktop, local data).

## 11. Testing

- `lib/grouping.test.ts`: lane assignment, lane ordering (compressing → terminal → pending), counts aggregation, single-category case, unsupported exclusion.
- `lib/strategyLabels.test.ts`: known ids map to label + lossless flag; unknown id passthrough.
- `useCompression.test.ts`: `file:complete` with `strategyUsed`/`qualityUsed` updates the file entry; cancelled-batch flag exposes "Batch cancelled" path.
- `CompressView.test.tsx`: staging → run on compress; locked screen (no drop zone/back) while running; `New batch` returns to staging; chips reflect counts; batch number increments across runs.
- `RunHeader`/`Lane`/`RunRow` render tests: status pill transitions, zero-count chip hiding, reveal/cancel/remove wiring.
- Rust: extend existing queue tests to assert the `file:complete` event payload includes strategy fields.
- Gate: `yarn build && yarn test && cd src-tauri && cargo test`.

## 12. Rollout

Single feature branch; no data migration (history format unchanged). The existing `FileList` stays for staging; the run board is additive. Suggested sequence: IPC fields → grouping lib → run screen components → state machine + staging hero → animations → polish.
