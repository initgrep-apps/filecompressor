# Compress Run View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-screen compress flow — staging (two-state dropzone + table) and a locked kanban run monitor with per-category lanes, interactive status-chip filters, and FLIP animations.

**Architecture:** All new UI is frontend-only (`src/`). Run-screen state (screen phase, batch roster, batch number) lives in `CompressionProvider` so it survives navigating to History/Settings mid-run. `file:complete` already carries `strategyUsed`/`qualityUsed` from Rust — the frontend just captures them. New pure modules (`lib/grouping.ts`, `lib/strategyLabels.ts`) hold all ordering/counting/label logic so components stay thin.

**Tech Stack:** React 19 + TypeScript + Vite + Tailwind 4 (existing), `motion` (new dep — Framer Motion successor, `motion/react` imports), Vitest + React Testing Library (existing), zero Rust changes.

**Spec:** `docs/superpowers/specs/2026-10-05-compress-run-view-design.md`
Mockups: `docs/mockups/2026-10-05-staging-states.html`, `docs/mockups/2026-10-05-compress-run-view.html`, `docs/mockups/2026-10-05-chip-filters.html`

## Global Constraints

- Package manager: `yarn`. Gate after every task: `yarn build && yarn test` (Rust unchanged; `cd src-tauri && cargo test` runs at final gate only).
- Theme: existing green oklch tokens from `src/index.css` only (`bg-primary/5`, `text-destructive`, `color-mix` for category tints). Never approximate theme colors with hex. Category accent colors (content-level): image=blue, video=violet, pdf=red/destructive, document=amber, other=muted — use Tailwind arbitrary `color-mix(in oklab, <var> x%, white)` or token-based opacity classes, consistent with mockups.
- IPC structs: frontend-facing types in `src/types.ts` mirroring Rust camelCase serde.
- Every new file starts with the GPLv3 header comment block (copy from any existing file, e.g. `src/types.ts:1-15`).
- No comments in code beyond the license header.
- Conventional commits: `feat(scope):`, `test:`, `refactor(scope):`, `fix(scope):`.
- Copy/labels exactly as spec: "All files", "Processing", "Complete", "Below target", "Failed", "Queued", "Batch #n", "Compressing", "New batch", "Back to files" is NOT used, "Reveal in Finder" tooltip, "Batch in progress — wait until it completes", "Batch cancelled".
- `motion` import path: `motion/react` (`yarn add motion`).

## Review Focus

Input classes the spec implies that component tests could miss — each is pinned by a named test in the task that owns it:

1. **Files dropped while a batch runs** → must show toast "Batch in progress — wait until it completes" and NOT add files. Test: `CompressView.test.tsx › run screen toasts and ignores drop while running` (Task 7).
2. **Row status changes while a chip filter is active** → row leaves the board (exit animation) without crashing; counts stay roster-based. Test: `KanbanBoard.test.tsx › filtered row unmounts when status leaves filter` (Task 6).
3. **CompressView unmount mid-run** (user visits History, comes back) → run screen with roster intact, not staging. Test: `CompressionProvider.test.tsx › run screen survives view switch` (Task 7).
4. **batch:error mid-run** (worker unavailable) → status pill `Failed`, error line under header, `New batch` available, no stale spinner. Test: `RunHeader.test.tsx › batch error shows failed pill and error` (Task 6).
5. **File renamed/long-name + long error text** → truncates with `title` attr (error wraps 2 lines). Test: `RunRow.test.tsx › long name truncates with title` (Task 5).

---

### Task 1: Capture strategy fields + cancelled-batch toast in `useCompression`

**Files:**
- Modify: `src/types.ts` (FileEntry — add 2 fields)
- Modify: `src/hooks/useCompression.ts:28-35` (CompletePayload) and `:116-129` (file:complete listener), `:211-217` (cancelAll)
- Test: `src/hooks/useCompression.test.ts`

**Interfaces:**
- Consumes: existing Rust `file:complete` payload fields `strategyUsed: string | null`, `qualityUsed: number | null` (already emitted, queue.rs:650-662; serialization pinned by Rust test `file_complete_payload_carries_strategy_fields` — no Rust work).
- Produces: `FileEntry` with `strategyUsed: string | null`, `qualityUsed: number | null`; batch-cancelled toast behavior consumed by Task 7.

- [ ] **Step 1: Write failing tests in `useCompression.test.ts`** (follow existing mock-listen patterns in that file):
  - `file:complete persists strategyUsed and qualityUsed onto the file entry`: emit complete with `strategyUsed: "crf=24"`, `qualityUsed: 24` → file in state has those values.
  - `cancelAll then batch:complete shows Batch cancelled toast and not success toast`: invoke cancelAll, emit `batch:complete` → `toast.info` called with "Batch cancelled"; `onBatchComplete` callback NOT called when zero processed; when some files processed before cancel, `onBatchComplete` still called AND cancelled toast shown.
  - `batch:complete without cancel does not show cancelled toast` (guard).
- [ ] **Step 2: Run `yarn test -- useCompression`. Expected: new tests FAIL (payload fields missing / no toast).**
- [ ] **Step 3: Implement** in `src/types.ts` add to `FileEntry`: `strategyUsed: string | null`, `qualityUsed: number | null`. In `useCompression.ts`: extend `CompletePayload` with `strategyUsed?: string | null`, `qualityUsed?: number | null`; listener spreads them onto the mapped entry (default `null`). Add `cancelledRef`; set true in `cancelAll()` success; on `batch:complete` and `batch:error`: if `cancelledRef.current` → `toast.info('Batch cancelled')`, reset ref; always reset ref on new `compressAll`.
- [ ] **Step 4: Run `yarn test -- useCompression`. Expected: PASS (old tests still pass — update any fixture FileEntries missing the new fields).**
- [ ] **Step 5: Commit** `feat(compression): capture strategy metadata and cancelled-batch toast`

### Task 2: `lib/grouping.ts` — pure lane grouping, counts, filtering

**Files:**
- Create: `src/lib/grouping.ts`
- Test: `src/lib/grouping.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 6-7):
  - `export type StatusFilter = 'all' | 'compressing' | 'complete' | 'below_target' | 'failed' | 'queued'`
  - `export const LANE_ORDER: Category[]` = `['image', 'video', 'pdf', 'document', 'other']`
  - `export function isTerminal(status: FileStatus): boolean` — true for done, best_effort, already_under_target, failed, cancelled
  - `export function groupByCategory(files: FileEntry[]): Array<{ category: Category; files: FileEntry[] }>` — only categories present, in LANE_ORDER; within a lane: compressing first, then terminal, then queued (pending); original array order preserved inside each group
  - `export function batchCounts(files: FileEntry[]): { all: number; processing: number; complete: number; belowTarget: number; failed: number; queued: number; processed: number }` — complete = done + best_effort; belowTarget = already_under_target; failed = failed; queued = pending; processing = compressing; processed = terminal count (for "x/y processed")
  - `export function laneDonePill(files: FileEntry[]): { done: number; total: number }` — terminal count / lane size
  - `export function filterFiles(files: FileEntry[], filter: StatusFilter): FileEntry[]` — all → identity; compressing → status === 'compressing'; complete → done || best_effort; below_target → already_under_target; failed → failed; queued → pending

- [ ] **Step 1: Write failing tests** — fixtures built with a `makeFile(partial)` helper: statuses in one lane ordered pending, compressing, done, failed, cancelled, best_effort, already_under_target inserted shuffled → `groupByCategory` returns them compressing → terminal (in drop order) → queued; unknown category absent from input → no lane; all-one-category → single lane; `batchCounts` aggregation matches the 10-file scenario from the spec (2 processing, 4 complete, 1 belowTarget, 1 failed, 2 queued, 6 processed); `filterFiles` for every StatusFilter value; filtering does not mutate input.
- [ ] **Step 2: Run `yarn test -- grouping`. Expected: FAIL (module missing).**
- [ ] **Step 3: Implement** signatures above (simple sorts/filters, no deps).
- [ ] **Step 4: Run `yarn test -- grouping`. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(compress): add pure grouping/counts/filter lib for run board`

### Task 3: `lib/strategyLabels.ts` — strategy display strings

**Files:**
- Create: `src/lib/strategyLabels.ts`
- Test: `src/lib/strategyLabels.test.ts`

**Interfaces:**
- Produces: `export function strategyLabel(strategy: string | null, category: Category): string` (consumed by RunRow, Task 5).
- Mapping (by prefix, first match wins; suffixes like `,dims=50%`, `b=1200k`, `scale=720` are NOT shown):
  - starts `two-pass h264` → `H.264 two-pass · Lossy`
  - starts `crf=` → `H.264 CRF · Lossy`
  - `qpdf-lossless` → `QPDF · Lossless`
  - starts `qpdf-image-opt` → `QPDF image optimize · Lossy`
  - starts `gs` (`gs-screen`, `gs dpi=…`) → `Ghostscript · Lossy`
  - starts `quality=` AND category `document` → `Rebuild · Lossless`
  - starts `quality=` AND category `image` → `Re-encode · Lossy`
  - starts `quality=` AND category `pdf` → `Ghostscript · Lossy`
  - contains `best-effort` → `Best effort`
  - `null` → `''`; unknown → the raw strategy string.

- [ ] **Step 1: Write failing tests** covering every row above (use real strings from spec §7).
- [ ] **Step 2: Run `yarn test -- strategyLabels`. Expected: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run `yarn test -- strategyLabels`. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(compress): strategy label mapping for completed rows`

### Task 4: `DropZone` — two variants (empty full-surface | compact hero)

**Files:**
- Modify: `src/components/DropZone.tsx` (full rewrite of render; keep the existing `onDragDropEvent` listener wiring)
- Test: `src/components/DropZone.test.tsx` (extend; keep existing cases passing)

**Interfaces:**
- Consumes: `@tauri-apps/api/webview` `getCurrentWebview().onDragDropEvent` (existing wiring in this file).
- Produces: `DropZoneProps { onBrowse: () => void; onDrop: (paths: string[]) => void; className?: string; compact?: boolean }`. `compact` false (default) → empty full-surface variant; true → compact hero bar. Drag-hover state exposes `Release to add files` + `N files detected` (N = `event.payload.paths.length` on enter/over).

- [ ] **Step 1: Write failing tests**:
  - empty variant: renders `Drag and drop files here`, `Browse your files` button, format pills (10 pills — JPEG, PNG, WebP, HEIC, MP4, MOV, PDF, DOCX, XLSX, PPTX) each with its category tint; surface has `role="button"`, `tabIndex=0`, aria-label; clicking the SURFACE (not the button) calls `onBrowse`; Enter/Space on surface calls `onBrowse`; Browse button click does not double-fire (`stopPropagation`).
  - compact variant: renders `Drop more files here`, `or`, `Browse` outline button, mono formats text line `JPEG, PNG, WebP, HEIC, MP4, MOV, PDF, DOCX, XLSX, PPTX`; no pills.
  - drag hover (mock the webview listener as existing tests do): enter event → text `Release to add files` and `3 files detected` visible.
- [ ] **Step 2: Run `yarn test -- DropZone`. Expected: new tests FAIL.**
- [ ] **Step 3: Implement** both variants in the one component (branch on `compact`). Keep whole-surface click/keyboard. Format pills: `const FORMATS: Array<{ ext: string; category: Category }>` with category-tinted pill classes (blue/violet/red/amber) + category icon svg (image/video/pdf/document glyphs — 11px, inline svg like FileList uses).
- [ ] **Step 4: Run `yarn test -- DropZone`. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(compress): two-state DropZone with format pills and drag-hover count`

### Task 5: `RunRow` + `Lane` — animated run-board rows

Install dependency first: `yarn add motion`.

**Files:**
- Create: `src/components/run/RunRow.tsx`
- Create: `src/components/run/Lane.tsx`
- Test: `src/components/run/RunRow.test.tsx`
- Test: `src/components/run/Lane.test.tsx`

**Interfaces:**
- Consumes: `FileEntry` (with strategy fields, Task 1), `strategyLabel` (Task 3), `motion/react` (`motion`, `AnimatePresence`).
- Produces:
  - `RunRowProps { file: FileEntry; percent?: number; onCancel?: (fileId: string) => void; onReveal?: (outputPath: string) => void; onRemove?: (fileId: string) => void }` — root is `<motion.div layout layoutId={`file-${file.id}`} data-testid="run-row-{status}">`. Variants by status:
    - `compressing`: green inset left bar (`shadow-[inset_3px_0_0_var(--primary)]`), `bg-primary/5`, name `text-primary font-semibold` + `title`, `61.5 MB → …` mono, 4px progress bar (`percent ?? 0`, `transition-[width]`), live line `NN%` with spinner; cancel button (aria-label `Cancel {name}`).
    - terminal `done`/`best_effort`/`already_under_target`: name + `-%` chip (best_effort: amber chip + `Best effort` prefix; already_under_target: `≤ target` chip, sizes line = original only + `Already under {formatSize(targetBytes)}`), sizes `original → result` mono, strategy line `strategyLabel(file.strategyUsed, file.category)`, Reveal button when `outputPath` (aria-label `Reveal {name}`). `failed`: destructive tint/inset bar, `Failed` chip, error text wraps (no truncation, `max-w` 2-line clamp with `title` full text). `cancelled`: muted `Cancelled` chip, opacity-60, no Reveal.
    - `pending`: dashed border, muted name, size + `Queued` chip, remove button (aria-label `Remove {name}`).
  - `LaneProps { category: Category; files: FileEntry[]; ...row callbacks; progress?: Record<string, number> }` — header: category icon (tinted square) + label (`Image`, `Video`, `PDF`, `Document`, `Other`) + `x/y done` pill (green-tinted while lane has compressing rows); body wraps rows in `<AnimatePresence mode="popLayout">`; rows ordered as given (caller pre-sorts via grouping lib).

- [ ] **Step 1: Write failing tests** (`RunRow.test.tsx`): one per variant — compressing row shows name/percent/progress bar/cancel; done row shows sizes, `-%` chip, strategy label, Reveal; best_effort shows amber `Best effort` chip; already_under_target shows `≤ target` chip and no arrow-sizes; failed shows `Failed` chip + error text and no Reveal; cancelled muted; pending dashed + remove; Review Focus #5: 200-char name truncates and `title` attribute equals full name; long error gets `title` with full error.
- [ ] **Step 2: Run `yarn test -- RunRow`. Expected: FAIL.** Implement `RunRow`.
- [ ] **Step 3: Run `yarn test -- RunRow`. Expected: PASS. Commit** `feat(compress): run row variants with strategy display`.
- [ ] **Step 4: Write failing `Lane.test.tsx`**: renders header with category label + `x/y done` pill from `laneDonePill`; rows render in given order; removing a row from props unmounts it (AnimatePresence exit keeps it briefly — assert it disappears after a tick with `waitFor`); pill gets green tint when any row is compressing.
- [ ] **Step 5: Run `yarn test -- Lane`. Expected: FAIL → implement → PASS. Commit** `feat(compress): lane component with animated rows`

### Task 6: `KanbanBoard` + `RunHeader` — board, chips filters, batch header

**Files:**
- Create: `src/components/run/KanbanBoard.tsx`
- Create: `src/components/run/RunHeader.tsx`
- Test: `src/components/run/KanbanBoard.test.tsx`
- Test: `src/components/run/RunHeader.test.tsx`

**Interfaces:**
- Consumes: `groupByCategory`, `laneDonePill`, `filterFiles`, `batchCounts`, `StatusFilter` (Task 2); `Lane` (Task 5); `motion/react` `MotionConfig`.
- Produces:
  - `KanbanBoardProps { roster: FileEntry[]; statusFilter: StatusFilter; onFilterChange: (f: StatusFilter) => void; progress?: Record<string, number>; onCancel: (fileId: string) => void; onReveal: (path: string) => void; onRemove: (fileId: string) => void; removeDisabled?: boolean }` — board root wraps `<MotionConfig reducedMotion="user"><LayoutGroup>`; renders `groupByCategory(filterFiles(roster, statusFilter))` lanes (fixed width `w-[318px]`), horizontal `overflow-x-auto` container, right-edge fade (`after:` gradient), lanes left-aligned; lanes get a `max-h` with `overflow-y-auto` lane body so large batches scroll vertically within the board. When the filtered set is empty → `board-empty` message: `Nothing {processing|complete|below target|failed|queued} right now` + `Show all` link → `onFilterChange('all')`.
  - `RunHeaderProps { batchNumber: number; running: boolean; batchError: string | null; counts: ReturnType<typeof batchCounts>; total: number; statusFilter: StatusFilter; onFilterChange: (f: StatusFilter) => void; onCancelAll: () => void; onNewBatch: () => void }` — left: `Batch #{batchNumber}` mono pill + status pill (`Compressing` pulsing dot while running; `Complete` solid when !running && !batchError; `Failed` destructive when batchError). `batchError` renders a destructive error line under the header. Right: `Cancel All` (destructive outline) while running, else `New batch` (primary). Chips row = interactive filter buttons with `aria-pressed`; zero-count chips hidden except `All files`; `Batch: {processed}/{total} processed` + 5px progress bar right-aligned (width `processed/total*100%`).

- [ ] **Step 1: Write failing `RunHeader.test.tsx`**: renders `Batch #12`; running → `Compressing` pill + Cancel All, no New batch; not running → `Complete` + New batch, no Cancel All; batchError → `Failed` pill + error text visible; chips render counts, zero-count chips absent (e.g. failed=0 → no Failed chip), `All files` always present; clicking a chip calls `onFilterChange` with its value; Review Focus #4 pinned here.
- [ ] **Step 2: Run `yarn test -- RunHeader`. Expected: FAIL → implement → PASS. Commit** `feat(compress): run header with status pill and interactive chips`.
- [ ] **Step 3: Write failing `KanbanBoard.test.tsx`**: renders one lane per category present, LANE_ORDER; single-category roster → single lane; applying `failed` filter renders only lanes containing failed rows (Review Focus #2: rerender with a row's status changed so it leaves the filter → row unmounts, counts prop unchanged); filtered-empty → board-empty message with working `Show all`; lane rows receive progress percent.
- [ ] **Step 4: Run `yarn test -- KanbanBoard`. Expected: FAIL → implement → PASS. Commit** `feat(compress): kanban board with chip filtering`

### Task 7: Provider run-state + `CompressView` two screens

**Files:**
- Modify: `src/providers/CompressionProvider.tsx` (run state machine)
- Modify: `src/views/CompressView.tsx` (full rewrite of body)
- Modify: `src/providers/CompressionProvider.test.tsx`
- Test: `src/views/CompressView.test.tsx` (rewrite cases that assert the old single-screen flow)

**Interfaces:**
- Consumes: `useCompression` (Task 1), `useFileList`, grouping lib (Task 2), `RunHeader`/`KanbanBoard` (Task 6), `DropZone` (Task 4), `FileList` (existing staging table).
- Produces (context value additions consumed by Task 8): `runScreen: 'staging' | 'run'`, `batchNumber: number`, `startRun(): void` (captures roster = current pending ids, increments batch number, sets screen 'run'), `endRun(): void` (screen 'staging'). Roster snapshot kept in provider state; `CompressView` filters `files` by roster for the board (roster FileEntry objects are read live from `files` so status updates flow).

- [ ] **Step 1: Write failing provider tests**: `startRun captures pending roster and increments batch number`; `endRun returns to staging`; Review Focus #3: start run → simulate unmount/remount of a consumer (rerender a fresh consumer component within same provider) → runScreen still 'run', roster intact.
- [ ] **Step 2: Run `yarn test -- CompressionProvider`. Expected: FAIL.**
- [ ] **Step 3: Implement provider run state** (`runScreen`, `batchNumber` ref/state, `rosterRef`, `startRun`, `endRun` in context value).
- [ ] **Step 4: Run provider tests. Expected: PASS. Commit** `feat(compress): provider-owned run screen state`.
- [ ] **Step 5: Write failing `CompressView.test.tsx` cases** (rewrite obsolete ones):
  - staging empty → only full-surface DropZone, no table, no `No files yet` card.
  - staging with files → compact hero + table + footer `N files selected · Total size: ~X MB` (sum of non-unsupported originalSize) + Compress disabled with 0 pending.
  - Compress press → calls `startRun` + `compressAll`, screen switches to run: `Batch #1` + `Compressing` pill + lanes render roster categories; NO DropZone, NO back button.
  - `New batch` after completion → screen back to staging, files (with final statuses) still listed.
  - Review Focus #1: while running, simulated webview drop (mock listener) → toast "Batch in progress — wait until it completes", files unchanged. Implement: run screen mounts a minimal `getCurrentWebview().onDragDropEvent` listener (same try/catch pattern as DropZone) that calls `toast.info` on drop and ignores paths.
  - batch:error event → header shows Failed pill + error (integration of Task 6 component).
  - batch number increments on second compress.
- [ ] **Step 6: Run `yarn test -- CompressView`. Expected: FAIL → implement view (staging + run screens; footer summary format change) → PASS.**
- [ ] **Step 7: Full gate: `yarn build && yarn test`. Expected: PASS. Commit** `feat(compress): two-screen compress flow with locked run monitor`

### Task 8: Sidebar Compress badge

**Files:**
- Create: `src/components/SidebarNav.tsx`
- Modify: `src/App.tsx:105-123` (render `<SidebarNav activeView setActiveView />` inside the existing SidebarGroupContent; move `navItems` into the new component)
- Test: `src/App.test.tsx` (extend)

**Interfaces:**
- Consumes: `useCompressionContext().files` (Task 7's provider already provides `files`).
- Produces: sidebar nav with Compress badge = `files.length`, hidden when 0. History/Settings unchanged.

- [ ] **Step 1: Write failing tests in `App.test.tsx`**: 0 files → no badge text next to Compress; 5 files → badge `5` visible; clicking History still switches views (regression).
- [ ] **Step 2: Run `yarn test -- App`. Expected: FAIL.**
- [ ] **Step 3: Implement `SidebarNav.tsx`** (GPLv3 header; component must be rendered inside `CompressionProvider` so the hook works — App already wraps everything in it).
- [ ] **Step 4: Run `yarn test -- App`. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(compress): staged-files badge on sidebar`

### Task 9: Final gate + manual smoke

**Files:** none new.

- [ ] **Step 1: Full gate**: `yarn build && yarn test && cd src-tauri && cargo test`. Expected: all PASS (Rust untouched; `file_complete_payload_carries_strategy_fields` still green).
- [ ] **Step 2: Manual smoke** (`yarn tauri dev`): empty staging centered dropzone with pills → drag hover shows count → add files → compact hero + table → Compress → run board lanes in order, live rows pinned top with progress, cancel/remove/reveal work, chips filter + reset, Cancel All → toast + statuses → `New batch` → staging with results → switch to History mid-run and back → run screen intact. Reduced-motion (OS setting) → transitions instant.
- [ ] **Step 3: Fix anything found; commit fixes; final `git log --oneline` review.**
