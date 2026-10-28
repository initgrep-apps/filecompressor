# History Table Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current History file table with the locked batch summary + 3-column table + expandable 3-card detail design.

**Architecture:** Add pure history-table data helpers, then three focused components: `HistorySummaryCards`, `HistoryFileDetail`, and `HistoryTableToolbar`, all consumed by a rebuilt `HistoryFilesTable`. Integrate them into `HistoryView` so the summary sits above the table card. Table filtering/sorting/expansion is client-side; reveal actions reuse the existing `reveal_in_folder` command. Above 200 filtered rows, virtualize the row body with TanStack Virtual; the visual design is identical for small batches.

**Tech Stack:** React 19.3, TypeScript 7, TanStack Table v8, `@tanstack/react-virtual`, shadcn/ui (Base UI), Tailwind CSS v4, Vitest + Testing Library, Tauri 2.12.

**Spec:** `docs/superpowers/specs/2026-10-28-history-table-design.md`

**Mock reference:** `docs/superpowers/specs/2026-10-28-history-table/mock.html` and the PNGs in the same folder.

## Global Constraints

- Match the mock visually, but use app tokens: neutral surfaces, green primary progress, amber/red only as small status accents. No yellow/orange cards.
- The History view is not wrapped in another Card: batch header, summary and table card sit on the page background. Keep `min-h-0 flex-1` and put `aria-busy` on the content wrapper.
- Summary switches to 2×2 at ≤860px content (not 700); 4-up needs ≥~870px to fit the 190px scale plus the 24px current reading.
- Batch title is absolute `MMM D · h:mm A` from `startedAt`; subtitle is `Completed in …` with no file count.
- Under target uses a History-local muted tone; do not change shared `STATUS_TONES.already_under_target` (Compress view).
- Hide the current scale label at 0% and 100% so it cannot overlap endpoint labels.
- Files card and table total use `session.files.length`, not `session.fileCount`.
- Three **data** columns only: File · Size (current/new) · Status. No Saved or Method columns.
- No CSV, no paths, no retry, no row selection, no pagination.
- Card 1 is a **linear** size scale, not a ring.
- Summary card 1 current MB at right; saved MB below; linear scale original/current/percentage.
- Table row detail is exactly three cards: Size / Target & method / Timing; footer actions right.
- New size is intentionally present in the table Size column and in the detail Size card. Status stays in the table row only.
- History-facing copy uses **Under target**; update the history filter dialog copy to match.
- Use `formatSize`, `savedLabel`, `savedPercent`, `strategyLabel`, `countOutcome`, `tokens.ts` where possible.
- Do not change Compress-view copy or behavior.
- Keep existing loading/error/empty/cancelled/interrupted states.
- All new interactive controls must be keyboard accessible and have visible focus states.
- Run `yarn test` after each task; run the full gate in the final task.

## Review Focus

- **Failed/unsupported/cancelled files:** no output size, disabled compressed reveal, error card replacement, no divide-by-zero.
- **Under-target and zero-original files:** current = original, 0% saved, full green current bar, no NaN.
- **Filtered empty + expanded row:** empty table state with Clear; expanded detail closes when its row is filtered out.
- **Long values and narrow content:** file names truncate, detail values never truncate; fact rows stacked; no horizontal table scroll.
- **Sort/filter state reset:** switching selected sessions resets search/type/outcome/sort/expanded.
- **1000-file session:** virtualized row body above 200 filtered rows; sticky header, detail and actions remain usable.

---

## File Structure

**Create**
- `src/lib/historyTable.ts` — status labels/order, History status tones, batch/file size summaries, method labels, filters, precise duration, completed label, outcome groups, virtualization threshold.
- `src/lib/historyTable.test.ts`
- `src/components/history/HistorySummaryCards.tsx` — four-card batch dashboard.
- `src/components/history/HistorySummaryCards.test.tsx`
- `src/components/history/HistoryFileDetail.tsx` — three-card expanded row.
- `src/components/history/HistoryFileDetail.test.tsx`
- `src/components/history/HistoryTableToolbar.tsx` — search/type/count/chips/Clear.
- `src/components/history/HistoryTableToolbar.test.tsx`

**Modify**
- `src/components/history/HistoryFilesTable.tsx` — rebuild as the table card with state, columns, sorting, filtering, expansion, actions, empty row, virtualization.
- `src/components/history/HistoryFilesTable.test.tsx`
- `src/views/HistoryView.tsx` — batch header + summary cards + table card; remove old `BatchStats`/stat cards.
- `src/views/HistoryView.test.tsx`
- `src/components/history/HistoryFilterDialog.tsx` — `Already under target` → `Under target`.
- `src/components/history/HistoryFilterDialog.test.tsx`
- `src/App.test.tsx` — only selectors/queries affected by the History layout.
- `docs/FEATURES.md` — update the History feature row.

---

### Task 1: History table data helpers

**Files:**
- Create: `src/lib/historyTable.ts`
- Test: `src/lib/historyTable.test.ts`

**Interfaces:**
- Consumes: `HistoryFile`, `HistorySession`, `FileStatus`, `Category` from `src/types.ts`; `savedPercent` from `src/lib/historyFormat.ts`; `strategyLabel` from `src/lib/strategyLabels.ts`; `formatSize` from `src/lib/sizeFormat.ts`.
- Produces:
  - `HISTORY_STATUS_LABELS: Record<FileStatus, string>`
  - `HISTORY_STATUS_ORDER: Record<FileStatus, number>`
  - `HISTORY_STATUS_TONES: Record<FileStatus, Tone>` — same as `STATUS_TONES` except `already_under_target` uses the muted `cancelled` tone
  - `type HistoryOutcomeFilter = 'all' | 'attention' | 'done' | 'under_target'`
  - `type HistoryTypeFilter = Category | 'all'`
  - `interface BatchSizeSummary { originalBytes: number; currentBytes: number; savedBytes: number; percent: number }`
  - `interface FileSizeSummary extends BatchSizeSummary`
  - `batchSizeSummary(files: HistoryFile[]): BatchSizeSummary`
  - `fileSizeSummary(file: HistoryFile): FileSizeSummary`
  - `historyMethodLabel(file: HistoryFile): string`
  - `needsAttention(file: HistoryFile): boolean`
  - `matchesOutcomeFilter(file: HistoryFile, filter: HistoryOutcomeFilter): boolean`
  - `filterHistoryFiles(files: HistoryFile[], filters: { search: string; type: HistoryTypeFilter; outcome: HistoryOutcomeFilter }): HistoryFile[]`
  - `formatPreciseDuration(ms: number): string`
  - `completedLabel(ms: number): string`
  - `shouldVirtualizeRows(count: number): boolean`
  - `outcomePillCounts(files: HistoryFile[]): { done: number; underTarget: number; bestEffort: number; failed: number; other: number }`

- [ ] **Step 1: Write failing tests for size summaries and edge cases**

```ts
it('computes batch original/current/saved/percent from files', () => {
  const files = [
    file({ originalSize: 1_000, compressedSize: 200, status: 'done' }),
    file({ originalSize: 2_000, compressedSize: 2_000, status: 'already_under_target' }),
    file({ originalSize: 1_000, compressedSize: null, status: 'failed' }),
  ]
  expect(batchSizeSummary(files)).toEqual({
    originalBytes: 4_000, currentBytes: 3_200, savedBytes: 800, percent: 20,
  })
})
it('never divides by zero', () => {
  expect(batchSizeSummary([file({ originalSize: 0, compressedSize: null })])).toMatchObject({ percent: 0, savedBytes: 0 })
})
it('computes per-file saved values for done/under-target/failed/best-effort', () => { /* exact values */ })
it('returns — for failed/under-target method and humanizes strategies', () => { /* exact values */ })
it('filters by search/type/outcome and needs attention', () => { /* exact values */ })
it('counts outcome pills including Other', () => { /* exact values */ })
it('ranks status severity', () => { /* exact order */ })
it('maps under target to the muted history tone without changing STATUS_TONES', () => {
  expect(HISTORY_STATUS_TONES.already_under_target.text).toBe('text-muted-foreground')
  expect(STATUS_TONES.already_under_target.text).toBe('text-primary')
})
it('formats precise durations and completed dates', () => {
  expect(formatPreciseDuration(2_100)).toBe('2.1 s')
  expect(formatPreciseDuration(26_400)).toBe('26.4 s')
  expect(formatPreciseDuration(102_000)).toBe('1m 42s')
  expect(completedLabel(new Date(2026, 9, 25, 20, 2).getTime())).toBe('Oct 25 · 8:02 PM')
})
it('virtualizes only above 200 rows', () => {
  expect(shouldVirtualizeRows(200)).toBe(false)
  expect(shouldVirtualizeRows(201)).toBe(true)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/lib/historyTable.test.ts`
Expected: FAIL — module/functions do not exist.

- [ ] **Step 3: Implement the helpers**

Rules:
- `currentBytes = sum(file.compressedSize ?? file.originalSize)`; `savedBytes = max(0, original - current)`.
- `needsAttention` includes failed, best_effort, unsupported, cancelled.
- Outcome “attention” = `needsAttention`; “done” = `done`; “under_target” = `already_under_target`.
- `search` is lowercase substring on `file.name` only; blank search matches all.
- `type` uses `file.category`; `all` matches all.
- Status order: `failed:0, best_effort:1, unsupported:2, cancelled:3, done:4, already_under_target:5, pending:6, compressing:7`.
- `other` count = files whose status is not done/best_effort/failed/already_under_target.
- `HISTORY_STATUS_TONES` must not mutate `STATUS_TONES`; spread and override only `already_under_target`.
- `completedLabel` uses an absolute month/day + time (`MMM D · h:mm A`), not relative Today/Yesterday.
- `formatPreciseDuration`: under 60s, one decimal + ` s`; ≥60s, `m ss s` style consistent with existing duration semantics; invalid/≤0 → `—`.
- `shouldVirtualizeRows(count) => count > 200`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test src/lib/historyTable.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/historyTable.ts src/lib/historyTable.test.ts
git commit -m "feat(history): add table data helpers"
```

---

### Task 2: Three-card row detail

**Files:**
- Create: `src/components/history/HistoryFileDetail.tsx`
- Test: `src/components/history/HistoryFileDetail.test.tsx`

**Interfaces:**
- Consumes: `HistoryFile`; helpers from Task 1 (`fileSizeSummary`, `historyMethodLabel`, `formatPreciseDuration`, `completedLabel`); `formatSize`; `savedLabel`; `Button`/`Badge`; icons `Folder`, `FolderOpen` from `lucide-react`.
- Produces: `HistoryFileDetail({ file, onReveal }: { file: HistoryFile; onReveal: (path: string) => void })` rendering a grid of three `.detail-card`s and a footer. The table will wrap it in a `colSpan` row.

- [ ] **Step 1: Write failing component tests**

Test names and key assertions:
```ts
it('renders the size scale with current/original/percent/saved values', () => {
  render(<HistoryFileDetail file={bestEffortFile()} onReveal={vi.fn()} />)
  expect(screen.getByText('0')).toBeInTheDocument()
  expect(screen.getByText('259 KB')).toBeInTheDocument()
  expect(screen.getByText('1.8 MB')).toBeInTheDocument()
  expect(screen.getByText('86% saved')).toBeInTheDocument()
  expect(screen.getByText('1.5 MB saved')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: /Current size 259 KB of 1.8 MB original; 86% saved/ })).toBeInTheDocument()
})
it('renders target/method and timing cards', () => { /* 200 KB, PNG palette · Lossy, 2.1 s, completed */ })
it('reveals original and compressed from footer actions', async () => { /* user click; onReveal paths */ })
it('disables compressed action when outputPath is null', () => { /* failed */ })
it('replaces size card with full error for failed file', () => { /* error text; no progress img */ })
it('shows 0% and current=original for under-target file', () => { /* 0% saved; no NaN; full bar; middle current label hidden */ })
it('shows fallback error copy for a no-output file with no error', () => { /* No output file. */ })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn test src/components/history/HistoryFileDetail.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement `HistoryFileDetail`**

Match spec §5:
- `.detail` grid `1.4fr 1fr 1fr`, gap 12; padding 13px 16px 13px 40px.
- Three `.detail-card`s: Size, Target & method, Timing; neutral surfaces, 12px radius.
- Size scale: `0 → current → original`; green current; gray gone; tick; labels; `% saved` and saved MB.
- Fact rows stacked (`label` above `value`), values never truncated.
- Footer right: `Show original` (Folder) and `Show compressed` (FolderOpen); disabled compressed when null.
- Failed: error card replaces the size card with `file.error ?? 'No output file.'`; target/method/timing remain; footer remains.
- Under target: 0% saved, current = original, full green bar, middle current label hidden.
- Progress `role="img"` with the full aria-label; visual bar/tick `aria-hidden`.

- [ ] **Step 4: Run tests**

Run: `yarn test src/components/history/HistoryFileDetail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/history/HistoryFileDetail.tsx src/components/history/HistoryFileDetail.test.tsx
git commit -m "feat(history): add three-card file detail"
```

---

### Task 3: Four-card batch summary

**Files:**
- Create: `src/components/history/HistorySummaryCards.tsx`
- Test: `src/components/history/HistorySummaryCards.test.tsx`

**Interfaces:**
- Consumes: `HistorySession`; `batchSizeSummary`, `outcomePillCounts` from Task 1; `countOutcome`/`savedLabel`/`fileCountLabel` from `src/lib/historyFormat.ts`; `formatSize`; status tones.
- Produces: `HistorySummaryCards({ session }: { session: HistorySession })`.

- [ ] **Step 1: Write failing tests**

```ts
it('card 1 shows linear scale, current right, saved below, no Saved label', () => {
  render(<HistorySummaryCards session={session13()} />)
  expect(screen.getByTestId('summary-current')).toHaveTextContent('13.7 MB')
  expect(screen.getByText('72.2 MB')).toBeInTheDocument()
  expect(screen.getByText('81% saved')).toBeInTheDocument()
  expect(screen.getByText('58.5 MB saved')).toBeInTheDocument()
  expect(screen.getByText('CURRENT')).toBeInTheDocument()
  expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  expect(screen.getByRole('img', { name: /Current size 13.7 MB of 72.2 MB original; 81% saved/ })).toBeInTheDocument()
})
it('Files card centers 13 and renders 2x2 outcome pills', () => {
  render(<HistorySummaryCards session={session13()} />)
  expect(screen.getByTestId('summary-files')).toHaveTextContent('13')
  expect(screen.getByTestId('summary-pill-done')).toHaveTextContent('Done7')
  expect(screen.getByTestId('summary-pill-under')).toHaveTextContent('Under target4')
  expect(screen.getByTestId('summary-pill-best')).toHaveTextContent('Best1')
  expect(screen.getByTestId('summary-pill-failed')).toHaveTextContent('Failed1')
})
it('Best effort and Failed tiles show centered counts without 1 file', () => {
  render(<HistorySummaryCards session={session13()} />)
  expect(screen.getByTestId('summary-best-effort')).toHaveTextContent('1')
  expect(screen.getByTestId('summary-failed')).toHaveTextContent('1')
  expect(screen.queryByText('1 file')).not.toBeInTheDocument()
})
it('adds an Other pill when unsupported/cancelled files exist', () => { /* Other 2 */ })
it('renders four neutral cards with the expected class contract', () => { /* data-testid summary-size/files/best-effort/failed; bg-muted; radius 14; grid 2.2/1.6/.9/.9; container-query 2x2 */ })
it('never renders an amber card surface', () => { /* assert classes do not include amber bg on card */ })
```

- [ ] **Step 2: Run tests to verify failure**

Run: `yarn test src/components/history/HistorySummaryCards.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `HistorySummaryCards`**

Match spec §4.2:
- Grid 4-up `2.2fr 1.6fr .9fr .9fr`, 12px gap; 2×2 at container ≤860 (`@min-[860px]` for the wide grid).
- Card 1 linear scale + current reading; exact labels and green/gray split; no ring; hide the middle current label at 0/100.
- Card 2 Files + 2×2 pills; Other optional.
- Cards 3/4 centered numbers, no sub-line, neutral surface, colored dot only.
- `role="img"` aria-label on the scale; `data-testid="summary-scale"`.
- Test ids: `summary-current`, `summary-files`, `summary-pill-done|under|best|failed`, `summary-best-effort`, `summary-failed`.
- Under-target pill/dot uses `HISTORY_STATUS_TONES`, not the primary shared tone.
- Files count is `session.files.length`.
- No “Saved” label; no “1 file”; no amber/red card surfaces.

- [ ] **Step 4: Run tests**

Run: `yarn test src/components/history/HistorySummaryCards.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/history/HistorySummaryCards.tsx src/components/history/HistorySummaryCards.test.tsx
git commit -m "feat(history): add batch summary cards"
```

---

### Task 4: Table toolbar

**Files:**
- Create: `src/components/history/HistoryTableToolbar.tsx`
- Test: `src/components/history/HistoryTableToolbar.test.tsx`

**Interfaces:**
- Consumes: `HistoryOutcomeFilter`, `HistoryTypeFilter` from Task 1; `Input`, `Button`, dropdown/select components.
- Produces: `HistoryTableToolbar({ search, onSearchChange, type, onTypeChange, outcome, onOutcomeChange, counts, visibleCount, totalCount, onClear }: HistoryTableToolbarProps)`.

`counts` shape: `{ all: number; attention: number; done: number; underTarget: number }`.
- Search `ref` exposed via `searchInputRef` prop or the toolbar owns it and supports `/` focus internally. Own it internally.

- [ ] **Step 1: Write failing tests**

```ts
it('renders search, type filter, count and outcome chips', () => { /* /Search files/, All types, 13 of 13, chips */ })
it('calls search/type/outcome handlers', async () => { /* user.type/click */ })
it('marks the active chip and calls Clear', () => { /* aria-pressed; clear resets */ })
it('focuses search on / and clears with Escape', async () => { /* keyboard */ })
it('keeps Needs attention chip neutral with amber dot/count', () => { /* no amber bg class */ })
```

- [ ] **Step 2: Run tests to verify failure**

Run: `yarn test src/components/history/HistoryTableToolbar.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement toolbar**

Match spec §4.3 and §6.1–6.4:
- Title `Files` 12.5/600; search 28px with `/` hint; All types control; right count.
- Chips 22px; active All; Needs attention neutral + amber dot/count; Done/Under target; Clear.
- `/` focuses search unless focus is in an input/textarea/select/contenteditable; Escape clears search.
- Counts are session-wide; visible/total count from props.
- Counts are session-wide; visible/total count from props.
- Accessible labels; `aria-pressed`.

- [ ] **Step 4: Run tests**

Run: `yarn test src/components/history/HistoryTableToolbar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/history/HistoryTableToolbar.tsx src/components/history/HistoryTableToolbar.test.tsx
git commit -m "feat(history): add table toolbar"
```

---

### Task 5: Rebuild table with sort, filters, expansion, actions

**Files:**
- Modify: `src/components/history/HistoryFilesTable.tsx`
- Modify: `src/components/history/HistoryFilesTable.test.tsx`

**Interfaces:**
- Consumes: `HistorySession`; Task 1 helpers; `HistoryTableToolbar`; `HistoryFileDetail`; `@tanstack/react-table`; existing `invoke`/`toast` reveal logic.
- Produces: `HistoryFilesTable({ session }: { session: HistorySession })` as the complete table card (toolbar + chips + table + footer hint), with local state.

- [ ] **Step 1: Write failing tests**

Test names:
```ts
it('renders exactly File, Size, Status data columns; no Method or Saved', () => { /* headers; queryByText Method/Saved null */ })
it('renders the new size only, — for failed', () => { /* 185 KB, 259 KB, — */ })
it('filters by search, type, outcome and shows N of M', async () => { /* user interactions */ })
it('clears filters and restores all rows', async () => { /* Clear */ })
it('sorts File/Size/Status and exposes aria-sort', async () => { /* click header; order; aria */ })
it('expands one row at a time and renders HistoryFileDetail', async () => { /* chevron; detail cards; second row closes first */ })
it('closes detail when its row is filtered out', async () => { /* expand then search no match */ })
it('shows empty filtered state with Clear', async () => { /* no files match */ })
it('keeps failed reveal in row menu and detail footer disabled for compressed', async () => { /* actions */ })
it('renders sticky header/vertical scroll/no horizontal scroll contract', () => { /* classes include overflow-x-hidden, sticky, table-fixed */ })
it('uses the History muted tone for Under target badges', () => { /* no text-primary on under-target badge */ })
it('closes expanded detail on session key change', () => { /* key remount; no detail */ })
```

- [ ] **Step 2: Run tests to verify failure**

Run: `yarn test src/components/history/HistoryFilesTable.test.tsx`
Expected: FAIL against the old table.

- [ ] **Step 3: Implement the table**

Match spec §4.3, §6:
- Columns: expand, File, Size, Status, actions; no Saved/Method. Status badges use `HISTORY_STATUS_TONES`; failed rows get `bg-destructive/5`.
- Sorting: TanStack `getSortedRowModel`; default source order; File locale, Size numeric/null-last, Status severity rank; single active sort; `aria-sort`.
- Local state: search/type/outcome/sorting/expanded path; reset via remount key from HistoryView.
- Filter via Task 1 helpers; visible/total count; toolbar props.
- One expanded row; detail after row; close if no longer visible.
- Row kebab: existing Show compressed/Show original; toast handling.
- Empty filtered row with Clear.
- Table fills card; sticky header; vertical scroll; no horizontal; narrow widths Size 78 / Status 126; table card 12px 13px 0 at ≤860.
- Footer hint right; no batch aggregate.
- Keep the summary outside this component.

- [ ] **Step 4: Run tests**

Run: `yarn test src/components/history/HistoryFilesTable.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/history/HistoryFilesTable.tsx src/components/history/HistoryFilesTable.test.tsx
git commit -m "feat(history): rebuild files table with filters and detail"
```

---

### Task 6: Virtualize large batches

**Files:**
- Modify: `package.json` / `yarn.lock` (add `@tanstack/react-virtual`)
- Modify: `src/components/history/HistoryFilesTable.tsx`
- Test: `src/lib/historyTable.test.ts` (threshold already) + `HistoryFilesTable.test.tsx` (small-batch contract unchanged)

**Interfaces:**
- Consumes: `shouldVirtualizeRows` from Task 1.
- Produces: table body renders normally ≤200; above 200, uses `useVirtualizer` on the scroll container. Header sticky, expanded detail, row menu and footer unchanged.

- [ ] **Step 1: Add failing tests for the virtualized branch marker**

```ts
it('does not virtualize 200 or fewer rows', () => {
  render(<HistoryFilesTable session={sessionWithFiles(200)} />)
  expect(screen.getByRole('table').closest('[data-virtualized]')).toHaveAttribute('data-virtualized', 'false')
})
it('virtualizes above 200 rows', () => {
  render(<HistoryFilesTable session={sessionWithFiles(201)} />)
  expect(screen.getByRole('table').closest('[data-virtualized]')).toHaveAttribute('data-virtualized', 'true')
})
```
The 13-row table keeps rendering all rows; the marker is on the scroll container.

- [ ] **Step 2: Run and verify failure**

Run: `yarn test src/components/history/HistoryFilesTable.test.tsx`
Expected: FAIL — `data-virtualized` does not exist.

- [ ] **Step 3: Implement virtualization**

- Install with the project package manager: `yarn add @tanstack/react-virtual`.
- Use the table scroll container as `getScrollElement`; measure row heights; render virtual items only above 200 filtered rows.
- Set `data-virtualized="true|false"` on the scroll container as the tested branch marker.
- Keep the header outside the virtual body; the expanded detail row is a measured virtual item or rendered after its row with measured height.
- Do not change the ≤200 DOM/class contract.
- Manual 1000-file check required.

- [ ] **Step 4: Run tests and build**

Run: `yarn test src/components/history/HistoryFilesTable.test.tsx src/lib/historyTable.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json yarn.lock src/components/history/HistoryFilesTable.tsx src/components/history/HistoryFilesTable.test.tsx src/lib/historyTable.test.ts
git commit -m "perf(history): virtualize large table bodies"
```

---

### Task 7: Integrate HistoryView and finish copy

**Files:**
- Modify: `src/views/HistoryView.tsx`
- Modify: `src/views/HistoryView.test.tsx`
- Modify: `src/components/history/HistoryFilterDialog.tsx`
- Modify: `src/components/history/HistoryFilterDialog.test.tsx`
- Modify: `src/App.test.tsx` (affected queries only)
- Modify: `docs/FEATURES.md`

**Interfaces:**
- Consumes: `HistorySummaryCards`, `HistoryFilesTable`, `useHistoryContext`, existing empty/loading/error states.
- Produces: the final History view layout: batch header → summary cards → table card.

- [ ] **Step 1: Write failing integration tests**

```ts
it('shows absolute batch header, Completed in duration, Needs attention badge, and summary cards', () => { /* no relative Today/Yesterday; no file count in subtitle */ })
it('does not wrap the view in an outer card and marks the content busy', () => { /* [data-testid=history-content] aria-busy; no card-content */ })
it('shows linear size scale and current 13.7 MB at right', () => { /* getByTestId('summary-current'); no "Saved" label; 58.5 MB saved */ })
it('shows the three-column table below the summary', () => { /* headers; no Saved/Method */ })
it('keeps old empty/loading/error/cancelled/interrupted states', () => { /* existing coverage */ })
it('uses Under target and the History muted tone in the filter dialog', () => { /* label; muted dot */ })
it('resets table state when the selected session changes', () => { /* key/remount or filter reset */ })
```

- [ ] **Step 2: Run tests to verify failure**

Run: `yarn test src/views/HistoryView.test.tsx src/components/history/HistoryFilterDialog.test.tsx`
Expected: FAIL against the old `BatchStats`/labels.

- [ ] **Step 3: Implement integration**

- Remove `BatchStats`, the old stat-card markup, and the outer `Card` wrapper around the selected-session layout.
- Batch header: absolute title from `startedAt`, attention badge, `Completed in …` subtitle (no file count), 28px reveal folder icon button.
- Place `HistorySummaryCards` above the table card, 14px gaps; content container query 2×2 at ≤860.
- `HistoryFilesTable` as the table card; `key={session.sessionId}` to reset local state.
- Keep the existing TooltipProvider/Empty/Skeleton/error behavior and the reveal folder action. Put `aria-busy` on `[data-testid="history-content"]` and update the old `[data-slot="card-content"]` tests.
- Update the history filter dialog label to `Under target`, use `HISTORY_STATUS_TONES` for its status dots, and update tests.
- Update existing HistoryView tests that expected `batchLabel` (relative), `2 files · 45s`, `Method`, and the old stat test ids.
- Update `docs/FEATURES.md` row 20 (History data table) and row 11 if needed with the new summary/table/detail/filter behavior. Keep the spec/plan until the PR merges; delete them only after merge per AGENTS.md documentation lifecycle.
- Update affected App tests.

- [ ] **Step 4: Run tests**

Run: `yarn test src/views/HistoryView.test.tsx src/components/history/HistoryFilterDialog.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run full gate**

Run: `yarn build && yarn test && (cd src-tauri && cargo test)`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/views/HistoryView.tsx src/views/HistoryView.test.tsx src/components/history/HistoryFilterDialog.tsx src/components/history/HistoryFilterDialog.test.tsx src/App.test.tsx docs/FEATURES.md
git commit -m "feat(history): integrate batch summary and redesigned table"
```

---

### Task 8: Manual visual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the app**

Run: `yarn tauri dev`

- [ ] **Step 2: Compare against the saved mock**

At 1800, 1250, 900 and 760px window widths, dark and light, check:

- Summary card 1 linear: 0 → 13.7 MB current → 72.2 MB original; 19% green current; 81% gray gone; 81% saved; current 13.7 right; 58.5 saved below; no ring, no “Saved” label.
- Files card: 13 centered; 2×2 outcome pills; no “1 file”.
- Status cards: 1/1 centered; white number; dots only.
- Table: exactly File/Size/Status; no Saved/Method; sort; search/type/chips; expand; row menu; footer hint.
- Detail: three cards; size scale current green/gone gray; target/method; timing; actions right; failed error state.
- No horizontal scroll; file names truncate; detail values never truncate; sticky header; table scroll; footer visible. Hide the current scale label at 0/100 and show fallback error copy for no-output files.
- Colors: neutral cards, green progress, amber/red only small status accents; no yellow/orange cards.
- Light theme contrast and semantic tokens.

- [ ] **Step 3: Record results**

If a visual mismatch is found, fix it in the owning component and rerun the relevant test plus the manual check. Do not change the locked design to match a shortcut.

---

## Plan Self-Review

- **Spec coverage:** Tasks 1–8 cover data rules, card 1–4 visuals, table/toolbar/chips/sorting/filters/expansion, 3-card detail, actions, failed/under-target/empty states, responsive, tokens, accessibility, virtualization, tests, docs and manual verification.
- **Type consistency:** `HistoryOutcomeFilter`, `HistoryTypeFilter`, `BatchSizeSummary`, `FileSizeSummary`, `HistorySummaryCards`, `HistoryFileDetail`, `HistoryTableToolbar` are defined once and consumed by later tasks.
- **Review Focus tests:** failed/unsupported/cancelled, under-target/zero-original, 0/100 scale labels, filtered-empty + expanded, long values/narrow, header copy/no outer Card, session reset, 1000-file virtualization each have a task test or manual check.
- **Proportion:** The plan names files, interfaces, tests and key values; it leaves implementation bodies to the implementer. Visual values live in the locked spec and mock.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-10-28-history-table.md`.** The design spec and mock are saved alongside it:

- Spec: `docs/superpowers/specs/2026-10-28-history-table-design.md`
- Mock: `docs/superpowers/specs/2026-10-28-history-table/mock.html`
- Wide: `docs/superpowers/specs/2026-10-28-history-table/mock-wide.png`
- Narrow: `docs/superpowers/specs/2026-10-28-history-table/mock-900.png`

Please review the spec and plan. For execution, choose:

- **Subagent-driven** (recommended: independent implementation + review per task; safest for this many visual/state edge cases)
- **Native** (I implement task-by-task in this session, then one branch review; fastest)

Does the plan capture every locked detail?
