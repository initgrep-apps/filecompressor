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
- Status chip palette is the **existing `CHIP_TONES` from `RunRow.tsx` ported verbatim** (kept
  token-driven; opacity levels are what ships today): primary `bg-primary/10` (done,
  compressing), amber `bg-amber-500/10` (best_effort), fail `bg-destructive/10` (failed),
  muted (pending, cancelled). Only `already_under_target` changes tone vs today: primary →
  muted `≤ target`.

## Review Focus

1. **Live-progress churn vs user order** — roster re-derives on every progress tick; a mid-run reorder must never be reset or reshuffled by `syncBoardState`. Test in Task 2 (`preserves user order across ...`, `pins compressing ...`).
2. **Wheel over a lane's scroll area** pan the board — the regression that produced `data-lane-scroll`. Test in Task 4 (`does not pan the board when wheeling inside a lane scroll list`).
3. **Compressing card displaced by a drag** — commit must clamp so nothing lands at index 0 over the pinned card. Test in Task 2 (`clamps drop index below the pinned compressing card`).
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

If the CLI cannot resolve `progress` under the project's `base-rhea` style (verified 404 on `shadcnstudio.com/r/base-rhea/progress.json` while `kanban-03.json` resolves), create `src/components/ui/progress.tsx` by hand from the Base UI progress root: `<Progress value className>` rendering `role='progressbar'`, a muted track and a `bg-primary` indicator sized via inline `width: <value>%` (`value` in 0–100). Test in Task 3 asserts the role + `aria-valuenow`/text, not internals, so either path satisfies it.

- [ ] **Step 2: Create stock `src/components/ui/kanban.tsx`**

Fetch the stock source from the registry item (pin, do not retype):
`https://shadcnstudio.com/r/base-rhea/kanban-03.json` — entries `components/shadcn-studio/kanban/kanban-03.tsx` (demo reference only, not copied into the app) and `components/ui/kanban.tsx` (the base, 19.4 KB). Place the base file at `src/components/ui/kanban.tsx`. Exactly two adaptations, no others:
1. GPL license header prepended **above** the `'use client'` line (copy from `src/components/run/KanbanBoard.tsx` lines 1–15).
2. `import { cn } from ...` → `@/lib/utils` (registry ships `@/registry/base/lib/utils`, which does not resolve here).
The registry file's own inline explanatory comments are part of the stock source and stay — the no-comments convention applies only to new code written in Tasks 2–4.

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
- Consumes: `Category`, `FileEntry` from `@/types`, `CATEGORIES`, `LANE_ORDER`; `filterFiles`, `StatusFilter` from `@/lib/grouping`.
- Produces (Task 4 consumes):

```ts
export interface BoardState {
  laneOrder: Category[]
  cardOrder: Partial<Record<Category, string[]>>
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
  move: { activeId: string; overId: string; activeContainer: string; overContainer: string; overIsColumn: boolean },
  files: FileEntry[]
): BoardState
export function applyLaneOrder(state: BoardState, keys: string[]): BoardState
```

Semantics fixed by the spec:
- `initialBoardState`: lanes in `LANE_ORDER` order for categories present; per-lane ids in arrival order except compressing ids first. Ids with `status === 'unsupported'` excluded.
- `syncBoardState`: merge — **files whose `status === 'unsupported'` are never admitted (skip on arrival, drop if present)**; new file ids appended to their lane's order (compressing new ids jump to front), removed ids dropped, **any compressing id forced to the front of its lane (stable among multiple)**, lanes emptied of all ids dropped from `laneOrder`. **Returns the same `BoardState` object reference when the roster id-set is unchanged** (React bailout — no setState→render loop when wired in an effect).
- `derivedColumns`: group roster by `cardOrder`, apply `filterFiles` with `statusFilter`, **omit empty lanes**, lane sequence = `laneOrder` filtered to visible lanes; **a roster category missing from `laneOrder` (never saw a sync, or stale state) is appended in `LANE_ORDER` order after the known lanes — nothing vanishes**.
- `applyCardMove`: takes the roster `files` as required third parameter — the **status source** for the compressing rules (an optional param would silently drop the rules when omitted; tsc-enforced at call sites). Returns state unchanged when `activeContainer !== overContainer`, when `activeContainer`/`overContainer` are not category keys, or when `activeId` is not in `cardOrder[activeContainer]`. `overIndex = cardOrder[overContainer].indexOf(overId)`; **`overIndex < 0` (unknown overId) → return state unchanged**; `cardOrder[overContainer].length` when `overIsColumn`; then **clamp `overIndex` to ≥ 1 when index 0 holds a compressing id** (if `activeId` itself is a compressing id, return unchanged), `arrayMove`.
- `cardOrder` is `Partial<Record<Category, string[]>>` (lanes are dynamically dropped/added — absence is representable).
- `applyLaneOrder`: reorder the **subset of `laneOrder` present in `keys`**, keeping lanes absent from `keys` in their previous relative order (visible lane counts are a subset when a filter is active — dropping absent lanes would lose categories behind the filter). Unknown keys ignored.

- [ ] **Step 1: Write failing tests** — `src/lib/boardState.test.ts`, cases:
  - `initial board orders lanes by LANE_ORDER and pins compressing ids front`
  - `unsupported files are excluded from initial state and from sync`
  - `sync appends new ids, drops removed ids, and drops an emptied lane`
  - `sync returns the same state reference when the roster id-set is unchanged`
  - `sync pins a file that became compressing to the front and preserves user order otherwise`
  - `derivedColumns filters by status, omits empty lanes, and keeps user card order`
  - `derivedColumns appends a lane missing from laneOrder instead of dropping its files`
  - `applyCardMove reorders within a lane` (expected state: `b` moved above `a` with plain ids)
  - `applyCardMove clamps drop index below the pinned compressing card` (lands at index 1, never 0)
  - `applyCardMove ignores cross-lane moves and returns the same state`
  - `applyCardMove is a no-op for unknown overId and for lanes that are not categories`
  - `applyCardMove appends to the lane end on column-body drop` (`overIsColumn: true`)
  - `applyLaneOrder reorders the visible subset and keeps lanes absent from keys in place`
  - `applyCardMove is a no-op for a compressing active id`
  - `applyCardMove pinning depends only on files contents` (proves the roster param is the status source)
- [ ] **Step 2: Run** `yarn vitest run src/lib/boardState.test.ts` — Expected: FAIL (module not found)
- [ ] **Step 3: Implement `src/lib/boardState.ts`** per signatures above; GPL header; `arrayMove` from `@dnd-kit/sortable`.
- [ ] **Step 4: Run** `yarn vitest run src/lib/boardState.test.ts` — Expected: PASS (15/15)
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
- Consumes: stock `Card size='sm'`, `CardContent`, `Badge`, `Progress`, `Separator`, `Button size='icon-xs' variant='ghost'`, `Spinner` from `@/components/ui/spinner`; `KanbanItem`, `KanbanItemHandle` from `@/components/ui/kanban`; `formatSize`, `reductionPercentOrNull` from `@/lib/sizeFormat`; `strategyLabel` from `@/lib/strategyLabels`; `RESULT_STATUSES` from `@/components/FileList`; lucide `Square`, `FolderOpen`, `X`.
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

- [ ] **Step 1: Write failing tests** — port from `src/components/run/RunRow.test.tsx` (existing behavioral set, ~13 tests) with the same names where they carry over: compressing (name, percent clamped/rounded: `NaN → 0%`, `-20 → 0%`, `150 → 100%`, progressbar role with 45, cancel wiring), done (-% chip tone `text-primary bg-primary/10`, sizes, strategy label via `strategyLabel`, Reveal wiring `onReveal(outputPath)`), best_effort (amber chip `text-amber-600 bg-amber-500/10`, "Best effort" badge, destructive error), best_effort null strategy ("Best effort" badge), already_under_target (`≤ target` **muted** chip — tone change is spec'd —, "Already under 1.5 MB" badge, original size only, Reveal, no -% chip), failed (Failed chip, clamped error with full-text `title`, no Reveal), cancelled (muted, no Reveal, no buttons), pending (`Queued` chip, dashed card, Remove wiring), `no Reveal when outputPath is null`, `no action buttons rendered when handlers are omitted` (no dead affordances). Drop by name and consciously: shimmer/gradient tests (replaced by `Progress`) and stripe tests (stripes were removed by design). Add: `compressing card has no drag handle and no remove/reveal buttons`, `overlay card renders without action wiring`.
- [ ] **Step 2: Run** `yarn vitest run src/components/run/RunCard.test.tsx` — Expected: FAIL
- [ ] **Step 3: Implement** `src/components/run/RunCard.tsx` per structure; GPL header; no body-code beyond `chipFor`/`sizesFor`/`strategyLineFor` helpers (port verbatim from `RunRow.tsx`, minus shimmer/CSS work now delegated to `Progress`).
- [ ] **Step 4: Run** `yarn vitest run src/components/run/RunCard.test.tsx` — Expected: PASS (13/13)
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
- Modify: `src/lib/grouping.ts` (delete `groupByCategory` + dead helpers; keep `laneDonePill`), `src/lib/grouping.test.ts` (drop groupByCategory cases)
- Delete: `src/components/run/KanbanBoard.tsx`, `KanbanBoard.test.tsx`, `Lane.tsx`, `Lane.test.tsx`, `RunRow.tsx`, `RunRow.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–3; from `@/lib/grouping`: `batchCounts` (via `RunHeader`, untouched), `filterFiles`, `StatusFilter`, `LANE_ORDER`; `CATEGORY_TONES` from `@/lib/tokens`; `laneDonePill` from `@/lib/grouping` (kept — spec's Files table already retains it; RunBoard uses it for the pill over the **unfiltered** lane roster).
- Deletions in `grouping.ts` (H1 fix): delete `groupByCategory` **and its now-dead private helpers** `laneOf`, `laneRank`, plus the `MissingLanes`/`AssertNever`/`LaneOrderCoverage` type machinery — unexported leftovers fail `noUnusedLocals`. **`laneDonePill` stays.** Update `src/lib/grouping.test.ts`: drop the `groupByCategory` cases (≈3) and fold its two behavioral pins (`unsupported excluded`, `unknown category → warnOnce + filed under other`) into `boardState.test.ts` as sync/derivedColumns assertions.
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
- Inner `useState<BoardState>` seeded via `initialBoardState(roster)`. `rosterFiles = useMemo(files.filter(f => roster.includes(f.id)), [files, roster])`, keyed by `const rosterKey = rosterFiles.map(f => f.id).join(',')` (useMemo'd). Sync effect: `useEffect(() => { const next = syncBoardState(stateRef.current, rosterFiles); if (next !== stateRef.current) setState(next); }, [rosterKey])` — effect reads state through a ref (`stateRef.current = state` each render) so re-runs of the effect reuse latest state without adding it to deps; `syncBoardState`'s same-reference guarantee (Task 2) prevents the setState→render→identity-change loop.
- `columns` = `useMemo(() => derivedColumns(state, rosterFiles, statusFilter))` → `Record<string, FileEntry[]>`; `<Kanban value onValueChange getItemValue={(f) => f.id} onMove>`:
  - `onMove`: `setState(applyCardMove(state, { activeId: String(event.active.id), overId: over ? String(over.id) : '', activeContainer, overContainer, overIsColumn: over ? Object.keys(columns).includes(String(over.id)) : false }, rosterFiles))` — third arg REQUIRED (tsc-enforced): the roster is the status source for the compressing clamp/active-id rules. `overIsColumn` = the drop target id is a column key (stock `kanban.tsx` passes the column's `value` as `over.id` for column-body drops).
  - `onValueChange`: keys of the incoming value → `setState(applyLaneOrder(state, Object.keys(value)))`.
- `<KanbanOverlay>` after `KanbanBoard` inside `<Kanban>` (render-prop `({ value, variant })`): `variant === 'column'` → lane markup with `isOverlay` (the same lane-header + column-content structure, reading `columns[String(value)]`); else locate the file by id across `rosterFiles` and render `<RunCard file isOverlay isOverlay-variant />`. Lookup miss → `null`. This is also what keeps drag ghosts out of the scroll containers (spec §Scrolling).
- `KanbanBoard` (stock default className carries `sm:grid-cols-3` — it must not win): pass `className` `cn('h-full gap-3 w-max min-w-full')` **and** `style={{ gridTemplateColumns: `repeat(<n>, 16rem)` }}` inline where `<n>` = visible lane count. Inline style beats the stock utility at every breakpoint; dynamic Tailwind arbitrary values are not generated (no safelist) — never set grid columns via class.
- Per lane: `KanbanColumn value className='h-full min-h-0'` → transparent (no bg/border classes) → inner `flex h-full flex-col` → lane header (bordered tinted icon chip 24px from `CATEGORY_TONES` tint/border/text + lucide `Image`/`Film`/`FileText`/`File`/`FileQuestion` at 13px; lane title 13px semibold; done/total pill `data-testid="lane-pill"` from `laneDonePill` over the **unfiltered** roster of that lane, live tint when any compressing; `KanbanColumnHandle` with `Button size='icon-xs' variant='ghost'` + `GripVerticalIcon`, stock classes) + `KanbanColumnContent value className='min-h-0 flex-1 gap-2.5 overflow-y-auto'` + `data-lane-scroll` attr on the content element (scroll-guard contract) rendering `RunCard` per file (`percent={progress?.[file.id]}`, `onRemove={removeDisabled ? undefined : onRemove}` — same suppression contract as the old board). Height chain is load-bearing for lane scroll: board wrapper `h-full` → `KanbanBoard h-full` → column `h-full min-h-0` → content `flex-1 min-h-0` — without it lanes grow unbounded and `CompressView`'s `overflow-hidden` clips the scroll area.
- Board wrapper: `data-testid="kanban-board"` scroll container with `h-full overflow-x-auto select-none` + wheel-pan handler and lane guard **verbatim from old `KanbanBoard.tsx`** (incl. `pb-3 pr-6`); the `w-max` KanbanBoard inside it is what makes horizontal scroll engage.
- Empty state: `data-testid="board-empty"` + "Nothing {x} right now" wording + `data-testid="show-all"` → `onFilterChange('all')` — verbatim from old board (`EMPTY_WORDS` map moves here).
- `CompressView.tsx`: swap `KanbanBoard` import/usage → `RunBoard` (same props).
- No motion/react imports.
- Add a self-check note in `RunBoard.test.tsx` (or a comment-free throwaway check while developing, then remove): the `KanbanOverlay` render-prop paths are not exercised in jsdom (drag simulation required) — overlay correctness is human-verified in the next dev build; plan records this as accepted residual risk.

- [ ] **Step 1: Write failing tests** — port from `KanbanBoard.test.tsx` with lane-label helper updated to the new header (`laneLabels()` now reads lane title next to icon chip): lane ordering/single-lane, failed-filter lane subset, filtered row unmount + header counts stay roster-based, filtered-empty + Show all across the 6 filter cases, populated→filtered-empty rerender, Show all resets filter, height chain (`kanban-board` has `h-full`; column content scrollable within `min-h-0`/`flex-1`), `pans horizontally from a vertical wheel`, `does not pan the board when wheeling inside a lane scroll list` (guard via `data-lane-scroll`), removeDisabled suppresses then wires Remove, lane header shows count pill `1/2 done` **over the unfiltered roster** and live tint while compressing, card content present per state (`run-chip` visible, progress percent text), unsupported files never render a card, pill excludes unsupported counts. Rendering dnd-kit in jsdom: render, no drag simulation (overlay + drag interplay = human check, see self-check note above).
- [ ] **Step 2: Run** `yarn vitest run src/components/run/RunBoard.test.tsx` — Expected: FAIL (module not found)
- [ ] **Step 3: Implement** `RunBoard.tsx` per structure; make `CompressView.tsx` swap; delete the three old components + three old test files; in `grouping.ts` delete `groupByCategory` + `laneOf` + `laneRank` + `MissingLanes`/`AssertNever`/`LaneOrderCoverage` (keep `laneDonePill`, `batchCounts`, `filterFiles`, `isTerminal`, `StatusFilter`, `LANE_ORDER`); update `grouping.test.ts` per the Interfaces block (verify via grep: no remaining `groupByCategory` importer).
- [ ] **Step 4: Run full gate**

```bash
yarn build && yarn test && cd src-tauri && cargo test
```
Expected: PASS (boardState 15, RunCard 13, RunBoard ~15, updated `grouping.test.ts` green, all other pre-existing suites green).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(run): run board on stock kanban-03 with within-lane dnd and pinned compressing"
```

---

## Self-review notes

- Spec coverage: stock rule (T1, T3/T4 token-only classes), transparency + 16rem (T4 inline
  grid style), lucide icon chips (T4), DnD rules incl. clamp/pin/no-handle (T2+T3), state
  model with filter preservation + missing-lane + unsupported exclusion (T2+T4), overlay item
  + column (T4), lane-scroll height chain (T4), scroll mechanics verbatim + Windows flag (T4,
  Review Focus), card slot table incl. error clamp, no stripes, chip tones ported (T3), deps
  exact (T1), deletions with grouping.test.ts update (T4).
- Second-pass review (independent agent, 2026-10-28) raised C1–C3, H1–H4; all six mandatory
  fixes plus M1–M5 and L1–L7 applied to this plan and the spec.
- Step scan: bodies reduced to helper porting + structure bullets; algorithms only in
  `applyCardMove` semantics (test-pinned).
- Type consistency: `BoardState`/`applyCardMove`/`RunCardProps`/`RunBoardProps` used
  consistently across T2–T4; `KanbanMoveEvent` field names (`activeContainer`,
  `overContainer`, `overIndex`) matched from stock `kanban.tsx`.
- Proportion: 4 tasks, all logic decisions in signatures + test names; no transcripts.