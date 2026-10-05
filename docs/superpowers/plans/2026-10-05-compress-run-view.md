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

**Acceptance Criteria:**
- `FileEntry` requires `strategyUsed: string | null` and `qualityUsed: number | null`; `file:complete` persists them onto the mapped entry, defaulting to `null` when the payload omits either field
- `cancelAll()` → next `batch:complete` shows `toast.info('Batch cancelled')`; `onBatchComplete` NOT called at zero processed; called (plus cancelled toast) when ≥1 file was processed before cancel
- Uncancelled `batch:complete` shows no cancelled toast; cancelled flag resets on every new `compressAll` and is NOT set when the `cancel_all` invoke rejects
- `batch:error` after `cancelAll` also surfaces 'Batch cancelled' and resets the flag (no stale toast leaks into the next batch)
- Rust untouched — `file_complete_payload_carries_strategy_fields` (queue.rs) stays green
- All existing test fixtures constructing `FileEntry` gain the two new required fields; sonner mocks that assert new toasts gain `info: vi.fn()`
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`
- Boundary rules enforced (per docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture — frontend capture only, no Rust/queue changes)

**Required Tests:**
- `file:complete persists strategyUsed and qualityUsed onto the file entry` — payload fields land on the entry in state
- `file:complete without strategy fields defaults them to null` — older/partial payloads capture as null
- `cancelAll then batch:complete shows Batch cancelled toast and not success toast` — zero-processed: toast + no callback; some-processed: callback AND toast
- `batch:error after cancelAll shows Batch cancelled toast and resets the flag` — failed run post-cancel doesn't leak the toast into a later batch
- `compressAll after a cancelled batch runs to completion without cancelled toast` — ref reset on new run
- `cancelAll invoke rejection does not set the cancelled flag` — failed cancel leaves the normal complete path intact
- `batch:complete without cancel does not show cancelled toast` (guard)

- [x] **Step 1: Write failing tests in `useCompression.test.ts`** (follow existing mock-listen patterns in that file; update the sonner mock — it currently has only `success`/`error` — to add `info: vi.fn()`):
  - `file:complete persists strategyUsed and qualityUsed onto the file entry`: emit complete with `strategyUsed: "crf=24"`, `qualityUsed: 24` → file in state has those values.
  - `cancelAll then batch:complete shows Batch cancelled toast and not success toast`: invoke cancelAll, emit `batch:complete` → `toast.info` called with "Batch cancelled"; `onBatchComplete` callback NOT called when zero processed; when some files processed before cancel, `onBatchComplete` still called AND cancelled toast shown.
  - `batch:complete without cancel does not show cancelled toast` (guard).
- [x] **Step 2: Run `yarn test -- useCompression`. Expected: new tests FAIL (payload fields missing / no toast).**
- [x] **Step 3: Implement** in `src/types.ts` add to `FileEntry`: `strategyUsed: string | null`, `qualityUsed: number | null`. In `useCompression.ts`: extend `CompletePayload` with `strategyUsed?: string | null`, `qualityUsed?: number | null`; listener spreads them onto the mapped entry (default `null`). Add `cancelledRef`; set true in `cancelAll()` success; on `batch:complete` and `batch:error`: if `cancelledRef.current` → `toast.info('Batch cancelled')`, reset ref; always reset ref on new `compressAll`.
- [x] **Step 4: Run `yarn test -- useCompression`. Expected: PASS (old tests still pass — update any fixture FileEntries missing the new fields).**
- [x] **Step 5: Commit** `feat(compression): capture strategy metadata and cancelled-batch toast`

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

**Acceptance Criteria:**
- All exported signatures behave exactly as specified; `LANE_ORDER` fixed as image, video, pdf, document, other; only categories present in input produce lanes
- Lane-internal order: compressing → terminal (drop order preserved) → pending (queued last); original array order preserved within each rank
- Counts: complete = done + best_effort; belowTarget = already_under_target; failed = failed; queued = pending; processing = compressing; processed = terminal count (cancelled counts toward `processed`/`isTerminal` per spec §6.2 "x = terminal statuses")
- Unsupported files are excluded from lanes and counts (spec §11 names this case explicitly)
- `filterFiles` covers every `StatusFilter` value and never mutates the input array
- Empty input → no lanes, zero counts
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`
- Boundary rules enforced (per docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture)

**Required Tests:**
- `groupByCategory orders lane rows compressing, then terminal, then queued` — shuffled fixture → compressing → terminal (drop order) → queued
- `groupByCategory omits lanes for categories not present and collapses all-one-category input to a single lane`
- `groupByCategory and batchCounts exclude unsupported files from lanes and counts` — fixture with unsupported rows
- `batchCounts matches the spec 10-file scenario` — 2 processing, 4 complete, 1 belowTarget, 1 failed, 2 queued, 6 processed
- `processed counts cancelled rows as terminal` — cancelled included in `processed`/terminal
- `laneDonePill returns done/total per lane` — empty → {done: 0, total: 0} (tested directly, not only via Lane)
- `isTerminal truth table` — done/best_effort/already_under_target/failed/cancelled true; pending/compressing false
- `filterFiles returns the right subset for every StatusFilter value`
- `filtering does not mutate the input array`
- `empty input yields no lanes and zero counts`

- [ ] **Step 1: Write failing tests** — fixtures built with a `makeFile(partial)` helper: statuses in one lane ordered pending, compressing, done, failed, cancelled, best_effort, already_under_target inserted shuffled → `groupByCategory` returns them compressing → terminal (in drop order) → queued; unknown category absent from input → no lane; all-one-category → single lane; unsupported exclusion; cancelled-counts-as-terminal; `batchCounts` aggregation matches the 10-file scenario from the spec (2 processing, 4 complete, 1 belowTarget, 1 failed, 2 queued, 6 processed); direct `laneDonePill` and `isTerminal` assertions; `filterFiles` for every StatusFilter value; filtering does not mutate input; empty array boundary.
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
  - contains `best-effort` → `Best effort` (must precede the `quality=` rules — real document.rs:1796 output `quality=60,best-effort` starts with `quality=`, and first match wins)
  - starts `quality=` AND category `document` → `Rebuild · Lossless`
  - starts `quality=` AND category `image` → `Re-encode · Lossy`
  - starts `quality=` AND category `pdf` → `Ghostscript · Lossy`
  - `null` → `''`; unknown → the raw strategy string.
  - Real processor strings the tests must use: `quality=80,dims=50%`, `two-pass h264 b=1200k scale=720`, `gs dpi=300,jpegq=85`, `qpdf-image-opt,jpeg-quality=70`, `quality=60`, `crf=24`, `qpdf-lossless`, `gs-screen`, `quality=60,best-effort` (document.rs:1796), `already-under-target` (document.rs:1334, image.rs:572).

**Acceptance Criteria:**
- Every known strategy string from spec §7 maps per the table; suffixes (`dims=…`, `b=…k`, `scale=…`, `jpegq=…`, `jpeg-quality=…`) never leak into the label
- First match wins: a document `quality=60,best-effort` string maps to `Best effort` (best-effort rule must be checked BEFORE the `quality=` rules — real processor output, document.rs:1796)
- `null` → `''`; unknown strings pass through raw (`already-under-target` passthrough pinned); `quality=` with a category that has no branch falls through to raw
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`
- Boundary rules enforced (per docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture)

**Required Tests:**
- `maps every known strategy format to its label` — one assertion per mapping row using the real strings from spec §7
- `strips numeric/format suffixes from the label` — explicit `not.toContain('dims=')` / `'b='` / `'scale='` / `'jpegq='` assertions
- `best-effort rule wins over quality= for document rezip fallback` — `quality=60,best-effort` + document → `Best effort`; `rezip-deflate9,best-effort` + document → `Best effort`
- `quality= with unmatched category falls through to the raw string`
- `null returns empty string; unknown passes through raw` (incl. `already-under-target`)

- [ ] **Step 1: Write failing tests** covering every row above (use real strings from spec §7), plus explicit suffix-stripping and precedence assertions per Required Tests.
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

**Acceptance Criteria:**
- Empty variant: dashed full-surface with `Drag and drop files here`, `Browse your files`, 10 category-tinted format pills (JPEG PNG WebP HEIC MP4 MOV PDF DOCX XLSX PPTX, each with its category icon)
- Surface is a click/keyboard hit target: `role="button"`, `tabIndex=0`, aria-label; surface click / Enter / Space → `onBrowse` exactly once; inner Browse button click does not double-fire (`stopPropagation`)
- Compact variant: `Drop more files here`, `or`, `Browse` outline button, right-aligned mono formats line; no pills; remains click/keyboard/drop target
- Drop event with paths → `onDrop` called with the payload paths
- Drag enter/over → `Release to add files` + `N files detected` (from `payload.paths.length`, with a safe fallback when the mock's `over`/`enter` event omits `paths`); drag LEAVE restores the rest state (copy + classes)
- Existing listener wiring kept; listener setup failure is caught and swallowed (component still renders)
- Existing test `getByText('Drag and drop')` (exact match, DropZone.test.tsx:155) must be updated to the new full copy; update the existing drag-event fixture at DropZone.test.tsx:88 to include `paths` on `over`
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`
- Boundary rules enforced (per docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture)

**Required Tests:**
- `empty variant renders heading, browse button, and 10 format pills with per-category tints`
- `surface click, Enter, and Space each call onBrowse; browse button does not double-fire`
- `compact variant renders hero bar with mono formats line and no pills; compact Browse click calls onBrowse`
- `drop event delivers payload paths to onDrop` — emit the final `drop` event from the mocked listener and assert `onDrop` received the exact paths array
- `drag enter/over shows Release to add files and N files detected; drag leave restores rest state` — hover copy appears on enter/over and is gone after leave
- `compact variant reacts to drag hover the same way`
- `listener setup failure is caught and the component still renders`

- [ ] **Step 1: Write failing tests** (update sonner-irrelevant fixtures as needed; update the existing drag fixture to carry `paths`, and the exact-copy test at DropZone.test.tsx:155):
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

**Acceptance Criteria:**
- `yarn add motion` before implementation (not currently in package.json); imports from `motion/react` only
- RunRow root is `motion.div layout layoutId={file-${file.id}}` with `data-testid="run-row-{status}"`; variants render per spec §6.3 anatomy:
  - compressing: inset left accent bar, `bg-primary/5`, name in primary with `title`, `61.5 MB → …` mono, 4px progress bar tracking `percent ?? 0`, `NN%` + spinner line, cancel button aria-label `Cancel {name}`
  - done: name + `-%` chip, `original → result` mono, strategy line from `strategyLabel`, Reveal (aria-label `Reveal {name}`) only when `outputPath` present
  - best_effort: amber `-%` chip + `Best effort` prefix; shows error text when present (spec §6.3)
  - already_under_target: `≤ target` chip, original-size-only line + `Already under {formatSize(targetBytes)}`, Reveal present
  - failed: destructive tint/inset, `Failed` chip, error wraps (2-line clamp) with `title` full text, no Reveal
  - cancelled: muted `Cancelled` chip, opacity-60, no Reveal
  - pending: dashed border, muted name, size + `Queued` chip, remove button aria-label `Remove {name}`
- Long names truncate with `title` = full name; long errors clamp with `title` = full text (Review Focus #5)
- Lane renders header (icon + label + `x/y done` pill from `laneDonePill`, green tint while any row compressing), rows in given order, wraps rows in `AnimatePresence mode="popLayout"`; row unmount is observable after exit tick
- Buttons are wired: cancel → `onCancel(file.id)`, Reveal → `onReveal(outputPath)`, remove → `onRemove(file.id)`
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`
- Boundary rules enforced (per docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture)

**Required Tests:**
- `compressing row shows name, percent, progress bar, and cancel button bound to onCancel(file.id)`
- `done row shows sizes, -% chip, strategy label, and Reveal bound to onReveal(outputPath)`
- `best_effort row shows amber Best effort chip and error text when present`
- `already_under_target row shows ≤ target chip, Already under target line, and Reveal`
- `failed row shows Failed chip, wrapped error with full title, and no Reveal`
- `cancelled row is muted with no Reveal; pending row is dashed with remove bound to onRemove(file.id)`
- `long name truncates and title attribute equals full name`
- `long error text clamps and title attribute equals full error`
- `aria labels match Cancel {name} / Reveal {name} / Remove {name}` — the a11y contract in the interface
- `outputPath absent on a done row → no Reveal rendered`
- `progress bar width tracks percent ?? 0`
- `Lane renders header pill from laneDonePill and rows in given order`
- `Lane unmounts a removed row after AnimatePresence exit (assert with waitFor)` — uses fake timers if flaky
- `Lane pill gets green tint while any row is compressing`
- `Lane renders no rows for empty files array; missing progress entry for a row does not crash`

- [ ] **Step 1: Write failing tests** (`RunRow.test.tsx`): one per variant — compressing row shows name/percent/progress bar/cancel; done row shows sizes, `-%` chip, strategy label, Reveal; best_effort shows amber `Best effort` chip (+ error when present); already_under_target shows `≤ target` chip and no arrow-sizes; failed shows `Failed` chip + error text and no Reveal; cancelled muted; pending dashed + remove; callback wiring assertions (cancel/reveal/remove dispatch the row's id/outputPath); aria-label contract; Review Focus #5: 200-char name truncates and `title` attribute equals full name; long error gets `title` with full error.
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

**Acceptance Criteria:**
- Header: `Batch #{n}` mono pill; `Compressing` (pulsing dot) while running; `Complete` when !running && !batchError; `Failed` destructive pill + destructive error line under the header when `batchError` is set; while failed, `New batch` is available and no stale `Cancel All`/spinner remains (Review Focus #4)
- Right action: `Cancel All` (destructive outline) only while running; `New batch` (primary) otherwise; both wired to `onCancelAll` / `onNewBatch`
- Chips: single-select filter buttons with `aria-pressed`; zero-count chips hidden except `All files`; clicking a chip calls `onFilterChange` with its value; clicking the ACTIVE chip again resets to `'all'` (spec §3 locked decision); active failed chip shows destructive styling
- Chip counts always render full-roster values (never filtered) — counts are a prop, board filtering is the consumer's job
- `Batch: {processed}/{total} processed` + progress bar width `processed/total*100%`
- Board: lanes from `groupByCategory(filterFiles(roster, statusFilter))`; fixed `w-[318px]`, horizontal `overflow-x-auto`, right-edge fade, left-aligned; lane bodies vertically scrollable (`max-h` + `overflow-y-auto`) for 100+ file batches
- Filtered-empty board → `Nothing {processing|complete|below target|failed|queued} right now` (copy keyed to the active filter) + `Show all` → `onFilterChange('all')`
- Row status change while a filter is active → row leaves the board (AnimatePresence exit) without crashing; rendered chip counts stay roster-based (Review Focus #2)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`
- Boundary rules enforced (per docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture)

**Required Tests:**
- `renders Batch #{n}, status pill per running/complete/error state, and error line on batchError`
- `batch error shows Failed pill + error text and New batch available, no Cancel All` (Review Focus #4)
- `Cancel All and New batch are wired to onCancelAll / onNewBatch`
- `chips render roster counts, hide zero-count chips except All files, and expose aria-pressed`
- `clicking a chip calls onFilterChange with its value; clicking the active chip resets to 'all'`
- `processed label and progress bar width reflect processed/total`
- `renders one lane per category present in LANE_ORDER; single-category roster renders a single lane`
- `failed filter renders only lanes containing failed rows`
- `filtered row unmounts when its status leaves the filter without crashing and header counts stay roster-based` (Review Focus #2 — assert the rendered chip-count UI elements remain unchanged through the rerender)
- `filtered-empty board shows Nothing {x} right now keyed to the active filter with a working Show all link`
- `lane rows receive progress percent; removeDisabled suppresses row remove`

- [ ] **Step 1: Write failing `RunHeader.test.tsx`**: renders `Batch #12`; running → `Compressing` pill + Cancel All, no New batch; not running → `Complete` + New batch, no Cancel All; batchError → `Failed` pill + error text visible, `New batch` available, no `Cancel All` (Review Focus #4); chips render counts, zero-count chips absent (e.g. failed=0 → no Failed chip), `All files` always present; `aria-pressed` on chips; clicking a chip calls `onFilterChange` with its value; clicking the ACTIVE chip calls `onFilterChange('all')`; Cancel All / New batch click wiring.
- [ ] **Step 2: Run `yarn test -- RunHeader`. Expected: FAIL → implement → PASS. Commit** `feat(compress): run header with status pill and interactive chips`.
- [ ] **Step 3: Write failing `KanbanBoard.test.tsx`**: renders one lane per category present, LANE_ORDER; single-category roster → single lane; applying `failed` filter renders only lanes containing failed rows; Review Focus #2: rerender with a row's status changed so it leaves the filter → row unmounts, header-count UI elements stay roster-based (not just the counts prop — assert rendered chip counts too); filtered-empty → board-empty message keyed to the active filter (`Nothing failed right now` etc.) with working `Show all`; lane rows receive progress percent; `removeDisabled` suppresses the remove control.
- [ ] **Step 4: Run `yarn test -- KanbanBoard`. Expected: FAIL → implement → PASS. Commit** `feat(compress): kanban board with chip filtering`

### Task 7: Provider run-state + `CompressView` two screens

**Files:**
- Modify: `src/providers/CompressionProvider.tsx` (run state machine)
- Modify: `src/views/CompressView.tsx` (full rewrite of body)
- Modify: `src/components/FileList.tsx` (staging table slim-down: remove the compressing-row progress bar and per-row Cancel button — unreachable now that a run always shows the run screen; keep Status badges for terminal statuses, remove button, reveal for rows with output from a finished run)
- Modify: `src/providers/CompressionProvider.test.tsx`
- Test: `src/views/CompressView.test.tsx` (rewrite cases that assert the old single-screen flow)
- Test: `src/components/FileList.test.tsx` (drop progress-bar/cancel cases, keep status/remove/reveal cases)

**Interfaces:**
- Consumes: `useCompression` (Task 1), `useFileList`, grouping lib (Task 2), `RunHeader`/`KanbanBoard` (Task 6), `DropZone` (Task 4), `FileList` (existing staging table).
- Produces (context value additions consumed by Task 8): `runScreen: 'staging' | 'run'`, `batchNumber: number`, `startRun(): void` (captures roster = current pending ids, increments batch number, sets screen 'run'), `endRun(): void` (screen 'staging'). Roster snapshot kept in provider state; `CompressView` filters `files` by roster for the board (roster FileEntry objects are read live from `files` so status updates flow).

**Acceptance Criteria:**
- Provider: `startRun()` captures pending-only roster (fixture with done/unsupported/pending mixed → only `pending` ids captured; spec §4: "never files added later, never unsupported"), increments `batchNumber`, sets `runScreen='run'`; `endRun()` returns 'staging'
- Run state survives consumer unmount/remount — screen phase + roster intact (Review Focus #3)
- CompressView staging-empty: full-surface DropZone only — NO table, NO `No files yet` card (removed entirely per spec §5)
- CompressView staging-populated: compact hero + table + footer `N files selected · Total size: ~X MB` (sum of non-unsupported originalSize; Compress disabled with 0 pending)
- Compress press → `startRun()` + `compressAll()`, screen run: `Batch #1` + `Compressing` pill + lanes render roster categories; NO DropZone, NO back button while running; batch number increments on second compress
- Drop while running → toast "Batch in progress — wait until it completes", files unchanged (run screen mounts a minimal webview drop listener, same try/catch pattern as DropZone.tsx:42–77)
- `batch:error` → header Failed pill + error (integration of Task 6)
- `New batch` after completion → staging with final statuses listed
- FileList slim-down: remove the compressing progress bar (FileList.tsx:163-178) and per-row Cancel (FileList.tsx:200-210); keep status badges, remove, reveal-for-output
- All fixture FileEntries in touched test files gain the two required strategy fields (App.test.tsx fixture included once Task 8 lands)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`
- Boundary rules enforced (per docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture — frontend only, zero Rust changes)

**Required Tests:**
- `startRun captures pending roster and increments batch number` — with a mixed-status fixture (done from prior run + unsupported + pending) asserting ONLY pending ids captured
- `endRun returns to staging`
- `run screen survives view switch (remount of a fresh consumer within the same provider)` (Review Focus #3)
- `staging empty renders only full-surface DropZone, no table, no No files yet card`
- `staging with files renders compact hero, table, footer N files selected · Total size ~X MB (sum of non-unsupported sizes); Compress disabled with 0 pending`
- `Compress press calls startRun + compressAll, switches to run screen: Batch #1, Compressing pill, roster lanes; NO DropZone, NO back button`
- `run screen toasts and ignores drop while running` (Review Focus #1)
- `batch:error event shows Failed pill + error on run screen`
- `New batch after completion returns to staging with files (final statuses) still listed`
- `batch number increments on second compress`
- `chips reflect full-roster counts while a filter is active` (spec §11 CompressView clause, integration)
- FileList tests: progress-bar/cancel cases dropped; status/remove/reveal cases kept passing

- [ ] **Step 1: Write failing provider tests**: `startRun captures pending roster and increments batch number` (fixture with done/unsupported/pending rows — pin pending-only capture), `endRun returns to staging`, Review Focus #3: start run → simulate unmount/remount of a consumer (rerender a fresh consumer component within same provider) → runScreen still 'run', roster intact.
- [ ] **Step 2: Run `yarn test -- CompressionProvider`. Expected: FAIL.**
- [ ] **Step 3: Implement provider run state** (`runScreen`, `batchNumber` ref/state, `rosterRef`, `startRun`, `endRun` in context value).
- [ ] **Step 4: Run provider tests. Expected: PASS. Commit** `feat(compress): provider-owned run screen state`.
- [ ] **Step 5: Write failing `CompressView.test.tsx` cases** (rewrite obsolete ones; fixtures gain the Task 1 strategy fields):
  - staging empty → only full-surface DropZone, no table, no `No files yet` card.
  - staging with files → compact hero + table + footer `N files selected · Total size: ~X MB` (sum of non-unsupported originalSize) + Compress disabled with 0 pending.
  - Compress press → calls `startRun` + `compressAll`, screen switches to run: `Batch #1` + `Compressing` pill + lanes render roster categories; NO DropZone, NO back button.
  - `New batch` after completion → screen back to staging, files (with final statuses) still listed.
  - Review Focus #1: while running, simulated webview drop (mock listener) → toast "Batch in progress — wait until it completes", files unchanged. Implement: run screen mounts a minimal `getCurrentWebview().onDragDropEvent` listener (same try/catch pattern as DropZone) that calls `toast.info` on drop and ignores paths.
  - batch:error event → header shows Failed pill + error (integration of Task 6 component).
  - batch number increments on second compress.
- [ ] **Step 6: Run `yarn test -- CompressView FileList`. Expected: FAIL → implement view + FileList slim-down → PASS.**
- [ ] **Step 7: Full gate: `yarn build && yarn test`. Expected: PASS. Commit** `feat(compress): two-screen compress flow with locked run monitor`

### Task 8: Sidebar Compress badge

**Files:**
- Create: `src/components/SidebarNav.tsx`
- Modify: `src/App.tsx:105-123` (render `<SidebarNav activeView setActiveView />` inside the existing SidebarGroupContent; move `navItems` into the new component)
- Test: `src/App.test.tsx` (extend)

**Interfaces:**
- Consumes: `useCompressionContext().files` (Task 7's provider already provides `files`).
- Produces: sidebar nav with Compress badge = `files.length`, hidden when 0. History/Settings unchanged.

**Acceptance Criteria:**
- `SidebarNav.tsx` (GPLv3 header) renders nav items; `App.tsx` renders it inside the existing `SidebarGroupContent`, `navItems` moved from App.tsx:56-72 into the new component
- Compress badge = `files.length`, hidden at 0; badge updates live when files are added/removed
- History/Settings rows unchanged; History shows NO badge (spec §3 locked decision "History nav badge: Removed"; nothing exists today — test pins absence so it doesn't regress later)
- Component renders inside `CompressionProvider` (App already wraps it); clicking History still switches views (regression)
- App.test.tsx fixture FileEntry gains the Task 1 strategy fields
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`
- Boundary rules enforced (per docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture)

**Required Tests:**
- `0 files → no badge text next to Compress; 5 files → badge '5' visible`
- `badge count updates when files are added or removed` — live reactivity, not one static render
- `History nav item has no badge` — pins the "History nav badge: Removed" decision
- `clicking History still switches views` (regression)

- [ ] **Step 1: Write failing tests in `App.test.tsx`**: 0 files → no badge text next to Compress; 5 files → badge `5` visible; badge reactively updates on file add/remove; History item shows NO badge (spec §3 decision pinned); clicking History still switches views (regression). Update the App.test.tsx FileEntry fixture to include the Task 1 strategy fields.
- [ ] **Step 2: Run `yarn test -- App`. Expected: FAIL.**
- [ ] **Step 3: Implement `SidebarNav.tsx`** (GPLv3 header; component must be rendered inside `CompressionProvider` so the hook works — App already wraps everything in it).
- [ ] **Step 4: Run `yarn test -- App`. Expected: PASS.**
- [ ] **Step 5: Commit** `feat(compress): staged-files badge on sidebar`

### Task 9: Final gate + manual smoke

**Files:** none new.

**Acceptance Criteria:**
- Full gate green: `yarn build && yarn test && cd src-tauri && cargo test` (`file_complete_payload_carries_strategy_fields` still passes — Rust untouched)
- Manual smoke checklist from spec §5–§6/§10 completed without fixes left unfixed: empty staging dropzone + pills → drag-hover count → files → compact hero + table → Compress → lanes in order, live rows pinned top with progress → cancel/remove/reveal work → chips filter + reset (active chip re-click resets to All) → Cancel All → toast + statuses → `New batch` → staging with results → History mid-run and back → run screen intact → reduced motion transitions instant
- `git log --oneline` shows one conventional commit per task
- All Required Tests pass: (final gate — all test files)
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- Full gate + manual smoke only — no new unit tests (all task-level suites already exist from Tasks 1-8; verify the full suite passes, not just per-task subsets)

- [ ] **Step 1: Full gate**: `yarn build && yarn test && cd src-tauri && cargo test`. Expected: all PASS (Rust untouched; `file_complete_payload_carries_strategy_fields` still green).
- [ ] **Step 2: Manual smoke** (`yarn tauri dev`): empty staging centered dropzone with pills → drag hover shows count → add files → compact hero + table → Compress → run board lanes in order, live rows pinned top with progress, cancel/remove/reveal work, chips filter + reset, Cancel All → toast + statuses → `New batch` → staging with results → switch to History mid-run and back → run screen intact. Reduced-motion (OS setting) → transitions instant.
- [ ] **Step 3: Fix anything found; commit fixes; final `git log --oneline` review.**
