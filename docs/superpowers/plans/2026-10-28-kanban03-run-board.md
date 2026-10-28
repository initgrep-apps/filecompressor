# Kanban-03 Run Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom motion/react run-monitor board with the stock shadcn-studio `kanban-03` component, mapping `FileEntry` data into its cards with drag-within-lane + lane-reorder semantics.

**Architecture:** Stock `kanban.tsx` base (unmodified) + `RunBoard` (lanes, wheel-pan, empty state) + `RunCard` (all file states) + `boardState.ts` (pure controlled-state sync: lane/card order, compressing pin, filter derivation).

**Tech Stack:** React 19.3, TypeScript, Tailwind CSS 4, @dnd-kit (core/sortable/utilities), @base-ui/react, shadcn/ui 4.21.

**Spec:** `docs/superpowers/specs/2026-10-28-kanban03-run-board-design.md`

## Global Constraints

- `kanban.tsx` and card/column styling stay **stock** — no visual forking; only theme-token classes from `src/lib/tokens.ts` / `HISTORY_STATUS_TONES` color Yard-specific content. No hardcoded hex in new code.
- No new comments in code unless explicitly requested (per AGENTS.md Conventions).
- No `avatar` component install; no motion/react in the board subtree.
- Column width exactly kanban-03's `16rem` minimum — lanes fixed `16rem`, no 1fr stretch.
- Conventional commits; GPL header block on every new/moved file (copy from `src/components/run/KanbanBoard.tsx` lines 1–15).
- Gate per task: `yarn build && yarn test`; task 4 additionally runs the full gate incl. `cd src-tauri && cargo test`.
- Rust untouched — no Windows-target cargo check needed.
- Status chip palette: done → `STATUS_TONES.done` (green, `-X%`), best_effort → amber chip, failed → destructive chip + whole-card `bg-destructive/5 border-destructive/25`, already_under_target → muted `≤ target`, pending/cancelled → muted, compressing → primary `Processing`.

## Review Focus

1. **Live-progress churn vs user order** — roster re-derives on every progress tick; a mid-run reorder must never be reset or reshuffled by `syncBoardState`. Test in Task 2 (`preserves user order across ...`, `pins compressing ...`).
2. **Wheel over a lane's scroll area** pan the board — the regression that produced `data-lane-scroll`. Test in Task 4 (`does not pan the board when wheeling inside a lane scroll list`).
3. **Compressing card displaced by a drag** — commit must clamp above-index 0 so nothing lands over the pinned card. Test in Task 2 (`clamps ... above the pinned compressing card`).
4. **Cross-lane drop** — must be a no-op (card returns), not a silent reorder. Test in Task 2 (`ignores cross-lane moves`).
5. **Windows WebView2 scroll feel** (wheel-pan + thin scrollbars + select-none) — untestable in jsdom; remains flagged in `docs/bugs.md` #1 after merge; Task 4 keeps mechanics verbatim.

---

### Task 1: Dependencies + stock kanban base

**Files:**
- Create: `src/components/ui/kanban.tsx` (stock, verbatim)
- Create (CLI): `src/components/ui/progress.tsx`
- Modify: `package.json`, `yarn.lock` (via CLI)

**Interfaces:**
- Produces: `Kanban`, `KanbanBoard`, `KanbanColumn`, `KanbanColumnHandle`, `KanbanItem`, `KanbanItemHandle`, `KanbanColumnContent`, `KanbanOverlay` from `@/components/ui/kanban`; `Progress` from `@/components/ui/progress`. Types re-exported by `kanban.tsx` (`KanbanMoveEvent`, `KanbanRootProps`).

- [ ] **Step 1: Install dnd deps + progress component**

```bash
yarn add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
yarn dlx shadcn@latest add progress
```

- [ ] **Step 2: Create stock `src/components/ui/kanban.tsx`**

Verbatim from the spec-approved shadcn-studio source (the file in the task prompt). Only allowed adaptation: none — `@/lib/utils` and `@/components/ui/*` aliases already match `components.json`. Keep GPL header on top.

- [ ] **Step 3: Verify build resolves imports**

Run: `yarn build`
Expected: tsc + vite build PASS (kanban.tsx compiles against installed `@base-ui/react`, `@dnd-kit/*`).

- [ ] **Step 4: Commit**

```bash
git add package.json yarn.lock src/components/ui/kanban.tsx src/components/ui/progress.tsx
git commit -m "feat(run): add stock kanban-03 base component and deps"
```

---

### Task 2: `boardState.ts` pure state logic

**Files:**
- Create: `src/lib/boardState.ts`
- Test: `src/lib/boardState.test.ts`

**Interfaces:**
- Consumes: `Category`, `FileEntry` from `@/types`, `CATEGORIES`; `filterFiles`, `StatusFilter` from `@/lib/grouping`; `isTerminal` from `@/lib/grouping`.
- Produces (Task 4 consumes):

```ts
export interface BoardState {
  laneOrder: Category[]
  cardOrder: Record<Category, string[]>
}

export function initialBoardState(files: FileEntry[]): BoardState
export function syncBoardState(state: BoardState, files: FileEntry[]): BoardState
export function derivedColumns(
  state: BoardState,
  files: FileEntry[],
  statusFilter: StatusFilter
): Array<{ category: Category; files: FileEntry[] }>
export function applyCardMove(
  state: BoardState,
  move: { activeId: string; overId: string; activeContainer: string; overContainer: string; overIsColumn: boolean }
): BoardState
export function applyLaneOrder(state: BoardState, keys: string[]): BoardState
```

Semantics fixed by the spec:
- `initialBoardState`: lanes in `LANE_ORDER` order for categories present; per-lane ids in arrival order except compressing ids first.
- `syncBoardState`: merge — new file ids appended to their lane's order (compressing new ids jump to front), removed ids dropped, **any compressing id forced to the front of its lane (stable among multiple)**, lanes emptied of all ids dropped from `laneOrder`.
- `derivedColumns`: group roster by `cardOrder`, apply `filterFiles` with `statusFilter`, **omit empty lanes**, lane sequence = `laneOrder` filtered to visible lanes.
- `applyCardMove`: returns state unchanged when `activeContainer !== overContainer`. Same lane: `overIndex = cardOrder[cat].indexOf(overId)` (`cardOrder[cat].length` when `overIsColumn`), then **clamp `overIndex` to ≥ 1 when index 0 holds a compressing id** (if `activeId` itself is a compressing id, return unchanged), `arrayMove`.
- `applyLaneOrder`: reorder `laneOrder` to match `keys` (ignore unknown keys).

- [ ] **Step 1: Write failing tests** — `src/lib/boardState.test.ts`, cases:
  - `initial board orders lanes by LANE_ORDER and pins compressing ids front`
  - `sync appends new ids, drops removed ids, and drops an emptied lane`
  - `sync pins a file that became compressing to the front and preserves user order otherwise`
  - `derivedColumns filters by status, omits empty lanes, and keeps user card order`
  - `applyCardMove reorders within a lane` (expected state: `b` moved above `a` with plain ids)
  - `applyCardMove clamps to index 1 above the pinned compressing card`
  - `applyCardMove ignores cross-lane moves and returns the same state`
  - `applyCardMove appends to the lane end on column-body drop` (`overIsColumn: true`)
  - `applyLaneOrder reorders lanes from onValueChange keys`
  - `applyCardMove is a no-op for a compressing active id`
- [ ] **Step 2: Run** `yarn vitest run src/lib/boardState.test.ts` — Expected: FAIL (module not found)
- [ ] **Step 3: Implement `src/lib/boardState.ts`** per signatures above; GPL header; `arrayMove` from `@dnd-kit/sortable`.
- [ ] **Step 4: Run** `yarn vitest run src/lib/boardState.test.ts` — Expected: PASS (10/10)
- [ ] **Step 5: Commit**

```bash
git add src/lib/boardState.ts src/lib/boardState.test.ts
git commit -m "feat(run): pure board order state with compressing pin and dnd rules"
```

---

### Task 3: `RunCard.tsx` (all 8 states)

**Files:**
- Create: `src/components/run/RunCard.tsx`
- Test: `src/components/run/RunCard.test.tsx`

**Interfaces:**
- Consumes: stock `Card size='sm'`, `CardContent`, `Badge`, `Progress`, `Separator`, `Button size='icon-xs' variant='ghost'`; `KanbanItem`, `KanbanItemHandle` from `@/components/ui/kanban`; `formatSize`, `reductionPercentOrNull` from `@/lib/sizeFormat`; `strategyLabel` from `@/lib/strategyLabels`; `RESULT_STATUSES` from `@/components/FileList`; lucide `Square`, `FolderOpen`, `X`.
- Produces (Task 4 consumes):

```tsx
export interface RunCardProps {
  file: FileEntry
  percent?: number
  onCancel?: (fileId: string) => void
  onReveal?: (outputPath: string) => void
  onRemove?: (fileId: string) => void
  isOverlay?: boolean
}
export function RunCard(props: RunCardProps): ReactElement
```

Structure (approved v2 mock; spec slot table):
- `<KanbanItem value={file.id}>` wrapping; **no `KanbanItemHandle` when `file.status === 'compressing'`** (undraggable pin); otherwise `<KanbanItemHandle>` wraps the card.
- Card = stock `Card size='sm'` + `CardContent className='space-y-3'`:
  - Top row: filename (12px semibold, truncate, `title`) + right-aligned action buttons (`Square`/Cancel when compressing with `onCancel`; `FolderOpen`/Reveal for terminal statuses with `outputPath` and `onReveal`; `X`/Remove when pending with `onRemove`). aria-labels identical to `RunRow` (`Cancel ${name}` / `Reveal ${name}` / `Remove ${name}`).
  - Strategy badge slot: `<Badge variant='secondary' className='rounded'>` with `strategyLineFor(file)`; hidden when empty (pending, compressing, failed, no strategy).
  - Progress block **only when `status === 'compressing'`**: row `[Spinner] Progress` + right `%` text (`data-testid="run-card-percent"`), then `<Progress value={clampedPercent} className='h-1' />`, then sizes row shows `${formatSize(original)} → …`.
  - `Separator`.
  - Bottom row: status chip `<Badge>` (palette per Global Constraints; chips keep `data-testid="run-chip"`) + right sizes text (mono tabular): `orig → out`, `orig` alone (already_under_target/cancelled/pending), `—` (failed).
  - Error paragraph (failed, best_effort, `error` present): 2-line clamp, full text in `title`, classes `text-destructive`; placed below bottom row.
- Card container classes from `RunRow` (no stripes): failed gets `border-destructive/25 bg-destructive/5`; pending gets `border-dashed`; cancelled gets `opacity-60`; overlay variant gets stock `ring-primary/20 rotate-1 ring-2`.
- Overlay mode (`isOverlay`): plain card, no actions wiring.

- [ ] **Step 1: Write failing tests** — port all cases from `src/components/run/RunRow.test.tsx` with names preserved: compressing (name, percent, progressbar role with 45, cancel wiring), done (-% chip tone, sizes, strategy label via `strategyLabel`, Reveal wiring `onReveal(outputPath)`), best_effort (amber chip, "Best effort" badge, destructive error), best_effort null strategy ("Best effort" badge), already_under_target (`≤ target` muted chip, "Already under 1.5 MB" badge, original size only, Reveal, no -% chip), failed (Failed chip, clamped error with title, no Reveal), cancelled (muted, no Reveal, no buttons), pending (`Queued` chip, dashed card, Remove wiring). Add: `compressing card has no drag handle and no remove/reveal buttons`, `overlay card renders without action wiring`.
- [ ] **Step 2: Run** `yarn vitest run src/components/run/RunCard.test.tsx` — Expected: FAIL
- [ ] **Step 3: Implement** `src/components/run/RunCard.tsx` per structure; GPL header; no body-code beyond `chipFor`/`sizesFor`/`strategyLineFor` helpers (port verbatim from `RunRow.tsx`, minus shimmer/CSS work now delegated to `Progress`).
- [ ] **Step 4: Run** `yarn vitest run src/components/run/RunCard.test.tsx` — Expected: PASS (10/10)
- [ ] **Step 5: Commit**

```bash
git add src/components/run/RunCard.tsx src/components/run/RunCard.test.tsx
git commit -m "feat(run): file card for all eight states on stock kanban shell"
```

---

### Task 4: `RunBoard.tsx` + wiring + deletion of old board

**Files:**
- Create: `src/components/run/RunBoard.tsx`
- Test: `src/components/run/RunBoard.test.tsx`
- Modify: `src/views/CompressView.tsx` (import + JSX swap, ~4 lines)
- Delete: `src/components/run/KanbanBoard.tsx`, `KanbanBoard.test.tsx`, `Lane.tsx`, `Lane.test.tsx`, `RunRow.tsx`, `RunRow.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–3; `batchCounts` stays only in `RunHeader` usage; `groupByCategory`, `laneDonePill`, `laneRank` usage in `grouping.ts` — `groupByCategory` and `laneDonePill` move into `boardState.ts` territory; `grouping.ts` keeps `batchCounts`, `filterFiles`, `isTerminal`, `StatusFilter`, `LANE_ORDER` (delete `groupByCategory` and `laneDonePill` with their `LaneOrderCoverage` machinery).
- Produces:

```tsx
export interface RunBoardProps {
  roster: FileEntry[]
  statusFilter: StatusFilter
  onFilterChange: (f: StatusFilter) => void
  progress?: Record<string, number>
  onCancel: (fileId: string) => void
  onReveal: (path: string) => void
  onRemove: (fileId: string) => void
  removeDisabled?: boolean
}
export function RunBoard(props: RunBoardProps): ReactElement
```

Structure:
- Inner `useState<BoardState>` seeded via `initialBoardState(roster)`; `useEffect` on identity `syncBoardState` per render-computed roster (`useMemo(() => rosterFiles)`, id-keyed).
- `columns` = `useMemo(derivedColumns(state, rosterFiles, statusFilter))` → `Record<string, FileEntry[]>`; `<Kanban value onValueChange getItemValue={(f) => f.id} onMove>`:
  - `onMove`: `setState(applyCardMove(state, { activeId: String(event.active.id), overId: over ? String(over.id) : '', activeContainer, overContainer, overIsColumn: over ? Object.keys(columns).includes(String(over.id)) : false }))` — `overIsColumn` = the drop target id is a column key (stock `kanban.tsx` passes the column's `value` as `over.id` for column-body drops).
  - `onValueChange`: keys of the incoming value → `setState(applyLaneOrder(state, Object.keys(value)))`.
- `KanbanBoard className`: grid fixed 16rem columns — `cn('grid auto-rows-fr gap-3 grid-cols-[repeat(<n>,16rem)] w-max min-w-full')` where `<n>` = visible lane count (inline template literal).
- Per lane: `KanbanColumn value` → transparent (no bg/border classes) → lane header (bordered tinted icon chip 24px from `CATEGORY_TONES` tint/border/text + lucide `Image`/`Film`/`FileText`/`File`/`FileQuestion` at 13px; lane title 13px semibold; done/total pill `data-testid="lane-pill"` from per-lane `done/total` computation over the **unfiltered** roster of that lane, live tint when any compressing; `KanbanColumnHandle` with `Button size='icon-xs' variant='ghost'` + `GripVerticalIcon`, stock classes) + `KanbanColumnContent className='min-h-64 gap-2.5 overflow-y-auto'` + `data-lane-scroll` attr on the content element (scroll-guard contract) rendering `RunCard` per file (pass `progress={progress?.[file.id]}` via prop `percent`).
- Board wrapper: `data-testid="kanban-board"` scroll container with `overflow-x-auto select-none` + wheel-pan handler and lane guard **verbatim from old `KanbanBoard.tsx`** (incl. `pb-3 pr-6`).
- Empty state: `data-testid="board-empty"` + "Nothing {x} right now" wording + `data-testid="show-all"` → `onFilterChange('all')` — verbatim from old board (`EMPTY_WORDS` map moves here).
- `CompressView.tsx`: swap `KanbanBoard` import/usage → `RunBoard` (same props).
- No motion/react imports.

- [ ] **Step 1: Write failing tests** — port from `KanbanBoard.test.tsx` with lane-label helper updated to the new header (`laneLabels()` now reads lane title next to icon chip): lane ordering/single-lane, failed-filter lane subset, filtered row unmount + header counts stay roster-based, filtered-empty + Show all across the 6 filter cases, populated→filtered-empty rerender, Show all resets filter, h-full/w-max container, `pans horizontally from a vertical wheel`, `does not pan the board when wheeling inside a lane scroll list` (guard via `data-lane-scroll`), removeDisabled suppresses then wires Remove, lane header shows count pill `1/2 done` and live tint while compressing, card content present per state (`run-chip` visible, progress percent text). Rendering dnd-kit in jsdom: render, no drag simulation.
- [ ] **Step 2: Run** `yarn vitest run src/components/run/RunBoard.test.tsx` — Expected: FAIL (module not found)
- [ ] **Step 3: Implement** `RunBoard.tsx` per structure; make `CompressView.tsx` swap; delete the three old components + three old test files; delete `groupByCategory`/`laneDonePill`/`LaneOrderCoverage` from `grouping.ts` (check no remaining importer via grep).
- [ ] **Step 4: Run full gate**

```bash
yarn build && yarn test && cd src-tauri && cargo test
```
Expected: PASS (boardState 10, RunCard 10, RunBoard ~13, all pre-existing suites green).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(run): run board on stock kanban-03 with within-lane dnd and pinned compressing"
```

---

## Self-review notes

- Spec coverage: stock rule (T1, T3/T4 token-only classes), transparency + 16rem (T4), lucide icon chips (T4), DnD rules incl. clamp/pin/no-handle (T2+T3), state model with filter preservation (T2+T4), scroll mechanics verbatim + Windows flag (T4, Review Focus), card slot table incl. error clamp + no stripes (T3), deps exact (T1), deletions (T4). All spec sections have owning tasks.
- Step scan: bodies reduced to helper porting + structure bullets; algorithms only in `applyCardMove` semantics (test-pinned).
- Type consistency: `BoardState`/`applyCardMove`/`RunCardProps`/`RunBoardProps` used consistently across T2–T4; `KanbanMoveEvent` field names (`activeContainer`, `overContainer`, `overIndex`) matched from stock `kanban.tsx`.
- Proportion: 4 tasks, all logic decisions in signatures + test names; no transcripts.