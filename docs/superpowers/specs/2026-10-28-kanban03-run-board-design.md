# Run board on kanban-03 — Design

Date: 2026-10-28
Status: Approved (design chat with mockup iteration v1–v2)

## Context

The run-monitor board (`KanbanBoard.tsx`, `Lane.tsx`, `RunRow.tsx`) is a custom motion/react
implementation with accumulated weaknesses (density, polish, maintenance cost). The
shadcn-studio `kanban-03` component (registry: `shadcnstudio.com/docs/components/kanban`)
provides the same board pattern with drag-and-drop built in and a design that matches the
shadcn/ui direction the app already follows.

Goal: replace the custom board with the stock kanban-03 implementation, mapping existing
`FileEntry` data into its card structure. No feature loss from today's run monitor.

**Stock rule (user requirement):** the base `kanban.tsx` and the card/column styling stay
**stock** — no visual forking of the component. Yard-specific color comes only through theme
tokens (`CATEGORY_TONES`, `STATUS_TONES` in `src/lib/tokens.ts`, `HISTORY_STATUS_TONES` in
`src/lib/historyTable.ts`), never hardcoded values. The dark demo colors seen in mockups are
mock-only; final code uses `bg`, `bg-card`, `muted`, `primary`, `destructive` tokens.

## What survives today (feature inventory)

- Lanes = file categories (image / video / pdf / document / other), unchanged
- Status-filter chips in `RunHeader` filter the board; empty-filter message + "Show all"
- `RunHeader` untouched (batch pill, status pill, Cancel All / New Batch, batch progress)
- All 8 file states render distinct cards: pending, compressing, done, best_effort, failed,
  cancelled, unsupported (never on board), already_under_target
- Per-card info: filename, status chip, sizes `orig → out`, strategy note, live % progress,
  error text (failed / best_effort), per-status actions (Cancel / Reveal / Remove)
- Live progress from `progressByFile` map
- `batchCounts`, `filterFiles`, `laneDonePill` logic retained in `src/lib/grouping.ts`

## What changes

- **Layout**: lanes transparent on the app background (no lane card/border); cards carry the
  subtle `bg-card`. Fixed column width of `16rem` exactly like kanban-03 (`minmax(16rem,1fr)`
  minimum without the 1fr stretch — no widening when few lanes); board scrolls horizontally
  when > viewport.
- **Lane header**: bordered tinted icon chip (24px, `CATEGORY_TONES` tint/border/text) using
  **lucide icons** — `Image`, `Film`, `FileText`, `File`, `FileQuestion` — replacing the custom
  SVG glyphs; + lane title + done/total count pill + always-visible grip handle
  (`KanbanColumnHandle`).
  - **Behavior change (acknowledged):** the count pill always reflects the **unfiltered** lane
    roster (matches `RunHeader`'s roster-based counts under an active filter); `unsupported`
    files are always excluded from both card rendering and the pill.
- **Cards**: kanban-03 card with these slot mappings:

| kanban-03 slot | Yard field |
|---|---|
| area badge (top) | strategy note, hidden until known |
| title | filename (truncate single line + tooltip) |
| avatar (top-right) | action buttons: Cancel / Reveal / Remove |
| progress + % | live while compressing: spinner + "Progress" + % + solid bar (no gradient); terminal cards omit this block |
| health badge (bottom-left) | status chip |
| due date (bottom-right) | sizes `orig → out` (`→ …` while compressing; `—` for failed) |
| — (no slot) | error text, 2-line clamp, below bottom row (failed, best_effort) |

- **Status chip palette** (token-driven):
  - done → `STATUS_TONES.done` (primary green) with `-X%`
  - best_effort → `STATUS_TONES.best_effort` (amber) with `-X%`; error text stays destructive
  - failed → `STATUS_TONES.failed` (destructive) chip + whole-card destructive tint background
  - already_under_target → muted (same as history tables) with `≤ target`
  - pending / cancelled → muted
  - compressing → primary with `Processing`
- **No left accent stripes** on any card (dropped from v1 mock).
- **Visual states**: failed = red-tinted whole card; pending = dashed border; cancelled =
  dimmed; no other decoration.

## DnD semantics (no fork of `kanban.tsx`)

1. **Items drag within their own lane only.** `onMove` callback is provided; commit applies
   `arrayMove` only when `activeContainer === overContainer`; cross-lane moves are ignored and
   the card animates back.
2. **Compressing card is pinned and undraggable.** Rendered inside `KanbanItem` without
   `KanbanItemHandle` (the handle attaches all drag listeners) → physically undraggable. When
   its status becomes `compressing`, the card jumps to the front of its lane. Commit logic
   clamps drop index to ≥ 1 so nothing lands above it. Accepted edge: dnd-kit's displacement
   preview may briefly show the pinned card shifting; the commit still lands it correctly.
3. **Lanes reorder freely** via the header grip (`KanbanColumnHandle`), any order, any time.
4. When a file completes it un-pins and becomes draggable in place.

## State model

`kanban.tsx` is a controlled component (`value: Record<string, T[]>` +
`onValueChange`). Pure sync logic lives in a new `src/lib/boardState.ts`, testable without
dnd-kit:

- Durable session state: `laneOrder: Category[]`, `cardOrder: Record<Category, string[]>`
- `columns` (the controlled value) derived from `{ laneOrder, cardOrder, roster, statusFilter }`
- Roster diff merge, preserving user order:
  - files with `status === 'unsupported'` are never admitted into `BoardState` (excluded in
    `initialBoardState`, `syncBoardState`, and `derivedColumns` — same as today's
    `groupByCategory` skip)
  - new files → appended to their lane's order; compressing ones jump to front
  - removed files → dropped
  - empty lanes → omitted from columns (current behavior: empty lanes hidden)
- `onMove` rewrites `cardOrder` (same lane only; cross-lane ignored). Lane drags arrive
  instead as the whole `onValueChange` value with reordered keys — the key order **is** the
  new `laneOrder`, synced from it.
- **Compressing pin** applied during merge, not on every render
- User order owned for the session only; **not persisted** across runs (a new batch is a new
  roster). The old auto-ranking (processing → processed → queued) is dropped except the
  compressing pin.
- Status filtering applies at derivation time, so toggling a filter chip preserves user order.

## Scrolling

- Board: horizontal `overflow-x-auto`; vertical wheel → horizontal pan on the board container,
  with the existing guard skipping wheel events originating inside a lane's vertical scroll
  area (kept verbatim from `KanbanBoard.tsx` incl. tests).
- Lane content: vertical `overflow-y-auto` per lane.
- `DragOverlay` portals to `document.body` — never inside a scroll container, so dragging does
  not fight scroll.
- **Windows risk (existing known issue, keep flagged):** wheel pan + thin scrollbar styling +
  `select-none` on WebView2 is unverified (`docs/bugs.md` #1). This redesign keeps those
  mechanics; the manual Windows build check remains required after this lands and stays
  tracked in `docs/bugs.md`.

## Dependencies

- npm: `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (new)
- shadcn: `progress` (new; avatar/badge/button/card/separator already installed)
- `avatar` is NOT installed — the avatar slot becomes action buttons
- `@base-ui/react`, `lucide-react`, `react-dom` present. `motion` has no remaining importers
  after this slice's merge (its only importers were the three deleted files) — dep stays in
  `package.json` for now; candidate for removal in a later cleanup slice.
- kanban-03's demo CSS additions: none required by the registry component beyond existing
  tokens; `Card size='sm'` variant and `Progress` need to exist in `src/components/ui/`

## Files

| Action | Path |
|---|---|
| Add (stock, unmodified) | `src/components/ui/kanban.tsx` |
| Add | `src/components/run/RunBoard.tsx` (replaces `KanbanBoard.tsx`) |
| Add | `src/components/run/RunCard.tsx` (replaces `RunRow.tsx`) |
| Add | `src/lib/boardState.ts` |
| Delete | `src/components/run/KanbanBoard.tsx`, `Lane.tsx`, `RunRow.tsx` + their tests |
| Rewrite | `src/views/CompressView.tsx` `RunMonitor` wiring (same provider contract) |
| Keep | `RunHeader.tsx`, `src/lib/grouping.ts` (`batchCounts`/`filterFiles`/`laneDonePill`), `src/lib/tokens.ts` |
| Add tests | `src/lib/boardState.test.ts`, `src/components/run/RunBoard.test.tsx`, `src/components/run/RunCard.test.tsx` |

## Testing

- `boardState.test.ts`: order sync (new/removed files), compressing pin to front, clamp ≥ 1,
  cross-lane move ignored, lane reorder, filter-toggle preserves order, empty-lane omission
- `RunCard.test.tsx`: ports the 8 `RunRow.test.tsx` cases (chips, sizes, strategy lines,
  error clamp, action wiring, dimming, dashed pending)
- `RunBoard.test.tsx`: lane render order, empty state + Show all, wheel-pan guard, count pill,
  card content presence per state
- Gate: `yarn build && yarn test && cd src-tauri && cargo test`

## Dropped intentionally

- motion/react in the board subtree (`LayoutGroup`, `AnimatePresence`, shimmer gradient) —
  dnd-kit is the one animation/interaction system here
- auto row ranking beyond the compressing pin
- lane persistence across runs
- avatar displays (no owner concept for files)