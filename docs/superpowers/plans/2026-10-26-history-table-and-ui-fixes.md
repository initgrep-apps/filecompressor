# History Table + UI Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four verified UI bugs (kanban height/scroll, black menus, cursor, dead scroll containers) and replace the history detail list with a TanStack data table.

**Architecture:** Pure frontend slice — five React/TS areas under `src/`, no Rust changes. Shell fixes are one-token/global-CSS changes; the history list becomes `HistoryFilesTable` (new component, TanStack Table) consumed by `HistoryView`; clear-history moves into `SettingsDialog`'s History section.

**Tech Stack:** React 19 + TypeScript + Tailwind 4 + shadcn/ui (Base UI), `@tanstack/react-table` (new), vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-26-history-table-and-ui-fixes-design.md`

## Global Constraints

- License header on every new/modified source file: copy the existing GPL header block from neighbors verbatim.
- No code comments (project rule) except one-line `why` notes.
- Labels exactly: menu items "Show compressed file" / "Show original file"; status badges, method cells, and all other copy unchanged.
- No search or filter toolbar in the table.
- Conventional commits, scoped: `fix(shell):`, `feat(history):` etc.
- Gate (final task): `yarn build && yarn test && cd src-tauri && cargo test`.
- Windows-target compile gate not needed — no `src-tauri/src` changes.

## Review Focus

1. **Very long file names** truncate inside the File column — expect ellipsis, no row blowout. Pinned by `HistoryFilesTable.test.tsx → truncates long file names` (Task 3).
2. **Failed rows** have `outputPath: null` — "Show compressed file" must be disabled, not crash. Pinned in Task 3.
3. **Empty session** (cancelled/interrupted) — table absent, message shown. Pinned in Task 4.
4. **Wheel over kanban with no horizontal overflow** — panning must not throw or scroll vertically sideways; `scrollLeft` clamp makes it a no-op. Pinned in Task 2.
5. **Cursor rule must not turn disabled buttons into pointers** — `:not(:disabled)` guard. jsdom can't compute this; verified by review in Task 1.

---

### Task 1: Shell fixes — black menus + hand cursor

**Files:**
- Modify: `src/components/ui/dropdown-menu.tsx` (line 41 `DropdownMenuContent`, line 135 `DropdownMenuSubContent`)
- Modify: `src/index.css` (`@layer base` block, after line 130)
- Test: `src/components/shell/AppMenu.test.tsx` (extend existing)

**Interfaces:**
- Consumes: nothing.
- Produces: `DropdownMenuContent` popup without the stray `dark` class; global cursor rule in `index.css`. No exported API changes.

- [ ] **Step 1: Write the failing test**

In `AppMenu.test.tsx`, add (mock setup already exists — open the menu with `userEvent` on the trigger, `aria-label="App menu"`):

```tsx
it("renders the popup without a forced dark palette", async () => {
  renderAppMenu()
  await userEvent.click(screen.getByRole("button", { name: "App menu" }))
  const popup = await screen.findByRole("menu")
  expect(popup.className).not.toMatch(/(^|\s)dark(\s|$)/)
})
```

(Adapt `renderAppMenu()` to the file's existing render helper; if it renders inline, inline it the same way.)

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/components/shell/AppMenu.test.tsx`
Expected: FAIL — popup className starts with `"dark z-50 …"`.

- [ ] **Step 3: Remove the stray `dark` token**

In `dropdown-menu.tsx` delete the leading `dark ` token in exactly two places: the `MenuPrimitive.Popup` className in `DropdownMenuContent` (`"dark z-50 max-h-…"` → `"z-50 max-h-…"`) and in `DropdownMenuSubContent` (`"dark w-auto min-w-…"` → `"w-auto min-w-…"`).

- [ ] **Step 4: Add the cursor rule**

In `index.css` inside `@layer base`:

```css
button:not(:disabled),
[role="button"]:not(:disabled) {
  cursor: pointer;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `yarn test src/components/shell/AppMenu.test.tsx`
Expected: PASS (all tests in file).

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/dropdown-menu.tsx src/index.css src/components/shell/AppMenu.test.tsx
git commit -m "fix(shell): drop forced-dark dropdown palette and add pointer cursor"
```

---

### Task 2: Kanban fills height, lane scroll works, wheel pans, thin scrollbars

**Files:**
- Modify: `src/components/run/KanbanBoard.tsx`
- Modify: `src/components/run/Lane.tsx:82` (root div) and `:117` (list div)
- Modify: `src/components/run/RunRow.tsx` (root className only)
- Modify: `src/index.css` (append after Task 1's rule)
- Test: `src/components/run/KanbanBoard.test.tsx` (extend existing)

**Interfaces:**
- Consumes: existing `KanbanBoardProps` (unchanged).
- Produces: board root `div[data-testid="kanban-board"]` with `h-full` and an `onWheel` handler; no `max-h-[533px]` anywhere. `RunRow` roots carry `shrink-0`.

- [ ] **Step 1: Write the failing tests**

In `KanbanBoard.test.tsx` add two tests to the existing `describe("KanbanBoard")`:

```tsx
it("fills its container height and drops the fixed lane cap", () => {
  render(boardFor([makeFile()]))
  const board = document.querySelector('[data-testid="kanban-board"]') as HTMLElement
  expect(board.className).toContain("h-full")
  expect(document.body.innerHTML).not.toContain("max-h-[533px]")
})

it("pans horizontally from a vertical wheel", () => {
  render(boardFor([makeFile()]))
  const board = document.querySelector('[data-testid="kanban-board"]') as HTMLElement
  Object.defineProperty(board, "scrollLeft", { value: 0, writable: true })
  fireEvent.wheel(board, { deltaY: 240 })
  expect(board.scrollLeft).toBe(240)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/components/run/KanbanBoard.test.tsx`
Expected: both FAIL (board has no `h-full`; `scrollLeft` stays 0).

- [ ] **Step 3: Implement**

`KanbanBoard.tsx`:
- Add `useRef<HTMLDivElement | null>(null)` and attach `ref` to the `data-testid="kanban-board"` div.
- Board div className: `"flex h-full items-start gap-3 select-none overflow-x-auto pb-3 pr-6"`.
- Handler on that div:

```tsx
onWheel={(event) => {
  if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
    event.currentTarget.scrollLeft += event.deltaY
  }
}}
```

- Delete the `[&>*]:max-h-[533px]` class from the `motion.div`; give it `className="shrink-0 h-full"` (keep the existing `initial/animate/transition` props).

`Lane.tsx`:
- Root div (line 82): add `h-full` → `"flex h-full w-[318px] shrink-0 flex-col overflow-hidden …"`.
- List div (line 117): add `min-h-0` → `"flex min-h-0 flex-1 flex-col gap-[7px] overflow-y-auto p-[9px]"`.

`RunRow.tsx`:
- Add `shrink-0` to the root element's className (root only; do not touch props or markup).

`index.css` (append inside `@layer base`):

```css
* {
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: var(--border);
}
::-webkit-scrollbar-track {
  background: transparent;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/components/run/KanbanBoard.test.tsx && yarn test src/components/run/RunRow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/run/KanbanBoard.tsx src/components/run/Lane.tsx src/components/run/RunRow.tsx src/index.css src/components/run/KanbanBoard.test.tsx
git commit -m "fix(compress): fill-height kanban with working lane scroll and wheel panning"
```

---

### Task 3: `HistoryFilesTable` component

**Files:**
- Create: `src/components/history/HistoryFilesTable.tsx`
- Test: `src/components/history/HistoryFilesTable.test.tsx`

**Interfaces:**
- Consumes: `HistoryFile` from `@/types`; `formatSize` from `@/lib/sizeFormat`; `savedPercent` from `@/lib/historyFormat`; `STATUS_TONES`, `CATEGORY_TONES` from `@/lib/tokens`; `CategoryIcon`; ui `Badge`, `Button`, `DropdownMenu*`; `invoke` from `@tauri-apps/api/core`; `toast` from `sonner`.
- Produces: `export function HistoryFilesTable({ session }: { session: HistorySession }): ReactElement` — the only export. Later tasks render it inside the `CardContent`.

- [ ] **Step 1: Install the dependency**

Run: `yarn add @tanstack/react-table`

- [ ] **Step 2: Write the failing tests**

File shape copies `HistoryView.test.tsx` conventions (license header, `vi.mock("@tauri-apps/api/core")`, `vi.mock("sonner")`, a `doneFile()`/`failedFile()` fixture factory with the same field values as `HistoryView.test.tsx`'s, wrapped in a minimal `session(files)` builder). Tests:

```tsx
it("renders one row per file with the pinned columns", () => {
  render(<HistoryFilesTable session={session([doneFile()])} />)
  expect(screen.getByRole("columnheader", { name: "File" })).toBeTruthy()
  expect(screen.getByRole("columnheader", { name: "Size" })).toBeTruthy()
  expect(screen.getByRole("columnheader", { name: "Method" })).toBeTruthy()
  expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy()
  expect(screen.getByText("a.jpg")).toBeTruthy()
  expect(screen.getByText("1 KB → 512 B")).toBeTruthy()
  expect(screen.getByText("quality=70")).toBeTruthy()
})

it("truncates long file names", () => {
  render(<HistoryFilesTable session={session([doneFile({ name: "x".repeat(300) + ".pdf" })])} />)
  const name = screen.getByText(/\.pdf$/)
  expect(name.className).toContain("truncate")
})

it("disables 'Show compressed file' for failed rows and keeps 'Show original file' enabled", async () => {
  const user = userEvent.setup()
  render(<HistoryFilesTable session={session([failedFile(), doneFile()])} />)
  const kebabs = screen.getAllByRole("button", { name: "File actions" })
  await user.click(kebabs[0])
  const menu = await screen.findByRole("menu")
  const showCompressed = within(menu).getByRole("menuitem", { name: "Show compressed file" })
  expect(showCompressed).toHaveAttribute("aria-disabled")
  await user.click(within(menu).getByRole("menuitem", { name: "Show original file" }))
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("reveal_in_folder", { filePath: "/in/broken.pdf" })
  )
})

it("reveals the compressed file for done rows", async () => {
  const user = userEvent.setup()
  render(<HistoryFilesTable session={session([doneFile()])} />)
  await user.click(screen.getByRole("button", { name: "File actions" }))
  await user.click(await screen.findByRole("menuitem", { name: "Show compressed file" }))
  await waitFor(() =>
    expect(invokeMock).toHaveBeenCalledWith("reveal_in_folder", { filePath: "/out/a.jpg" })
  )
})

it("shows the row error text under failed file names", () => {
  render(<HistoryFilesTable session={session([failedFile()])} />)
  expect(screen.getByText("Cannot read file: locked")).toBeTruthy()
})
```

(If jsdom lacks `columnheader` role for `th`, assert `screen.getByText` per header text instead — keep the same names "File"/"Size"/"Method"/"Status".)

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn test src/components/history/HistoryFilesTable.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `HistoryFilesTable`**

- `ColumnDef<HistoryFile>[]` (no column helper), columns in spec order: File / Size / Method / Status / actions. No `getRowId` complexity; `key` from `${file.path}:${file.completedAt}` on the row via `getRowProps`-style `row.className` is unnecessary — render with the default table markup from `ui/table.tsx`.
- File cell: colored icon chip (`CATEGORY_TONES` + `CategoryIcon`, the exact markup the old `BatchFiles` list used for the icon span) + name `span` with `truncate` + `title={file.name}`; when `file.error !== null`, a second `div` with `text-destructive` error text (truncate + title).
- Size cell: `formatSize(originalSize) → formatSize(compressedSize)` with `—` when `compressedSize === null`; `tabular-nums`.
- Method cell: `fileDetail` logic moved verbatim from `HistoryView.tsx` (`strategyUsed ?? quality N ?? —`), rendered `text-muted-foreground`.
- Status cell: move `StatusMarker` verbatim from `HistoryView.tsx` (keep it there too — `STATUS_LABELS`/`StatusMarker` stay exported from `HistoryView.tsx`? No: move `STATUS_LABELS` + `StatusMarker` into `HistoryFilesTable.tsx` and delete them from `HistoryView.tsx` in Task 4; until then duplicate locally).
- Actions cell: `DropdownMenu` with trigger `Button variant="ghost" size="icon-xs" aria-label="File actions"` + `Ellipsis` icon; menu items with `FolderOpen` icon "Show compressed file" (`disabled={file.outputPath === null}`) and `Folder` icon "Show original file"; both call a local `revealFile` (move `revealFile` + `toastOpenError` verbatim from `HistoryView.tsx` into this file; Task 4 deletes them there).
- Scroll contract: the component renders

```tsx
<div className="min-h-0 flex-1 overflow-auto">
  <Table>… sticky header …</Table>
</div>
```

with `thead` `th` carrying `sticky top-0 z-10 bg-card`; the component's own root is `flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-card` and every direct child that must not collapse carries `shrink-0` (the flex-shrink RCA). Table content `min-w-[640px]` for narrow-window horizontal scroll.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test src/components/history/HistoryFilesTable.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/history/HistoryFilesTable.tsx src/components/history/HistoryFilesTable.test.tsx package.json yarn.lock
git commit -m "feat(history): add data-table component for batch files"
```

---

### Task 4: Integrate the table into `HistoryView` + header changes

**Files:**
- Modify: `src/views/HistoryView.tsx` (replace `BatchFiles`, rework header, delete moved helpers)
- Test: `src/views/HistoryView.test.tsx` (extend + prune)

**Interfaces:**
- Consumes: `HistoryFilesTable({ session })` from Task 3.
- Produces: `HistoryView` renders the table; no `ClearHistoryButton` in this file; `Output:` line gone; icon-only reveal button with tooltip.

- [ ] **Step 1: Update the tests**

In `HistoryView.test.tsx`:
- Add: icon-only reveal button — `screen.getByRole("button", { name: "Reveal folder" })` exists and is icon-only (assert it has no text content, `expect(el.textContent).toBe("")`).
- Add: clicking it calls `invoke` with `"open_folder"` and `{ path: "/out" }` (session outputFolder).
- Add: `expect(screen.queryByText(/Output:/)).toBeNull()`.
- Add: `expect(screen.queryByText("Clear history")).toBeNull()`.
- Add: table renders — `screen.getByText("a.jpg")` (from the existing `session()` fixture).
- Prune: tests asserting the old list markers (the `files-header` "Files" count line, per-row list items) — rewrite them to the table equivalents from Task 3's test names.
- Existing tests already mock `HistoryProvider`, `invoke`, `sonner` — reuse the fixtures as-is.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/views/HistoryView.test.tsx`
Expected: FAIL (icon button still has text; Output: line still present).

- [ ] **Step 3: Implement**

- Replace the `<BatchFiles session={session} />` branch in `CardContent` with `<HistoryFilesTable session={session} />` (empty-session message stays in `HistoryView`).
- Delete `BatchFiles`, `fileDetail`, `fileResult`, `filePercent`, `StatusMarker`, `STATUS_LABELS`, `revealFile`, `toastOpenError`, and now-unused imports (`CATEGORY_TONES`, `CategoryIcon`, `Folder`, `FolderOpen` icon import stays for the header button, dropdown imports if unused).
- Header: "Reveal folder" button becomes

```tsx
<Tooltip>
  <TooltipTrigger
    render={
      <Button variant="outline" size="icon-sm" aria-label="Reveal folder" />
    }
  />
  <TooltipContent>Reveal folder</TooltipContent>
</Tooltip>
```

  keeping the `onClick` via the `render` prop (`onClick={() => void openSessionFolder(session.outputFolder)}` on the `Button`). Wrap the app usage with `TooltipProvider` at the top of `HistoryView`'s returned tree.
- `BatchTitle`: drop the ` · Output: {session.outputFolder}` segment (keep file count + duration).
- Delete `ClearHistoryButton` and its `AlertDialog*` imports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/views/HistoryView.test.tsx && yarn test src/components/history/HistoryFilesTable.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/HistoryView.tsx src/views/HistoryView.test.tsx
git commit -m "feat(history): replace detail list with data table and slim header"
```

---

### Task 5: Clear history moves to Settings → History

**Files:**
- Modify: `src/components/SettingsDialog.tsx` (`HistorySection` + `panelsFor` + `SettingsDialog` wiring)
- Test: `src/components/SettingsDialog.test.tsx` (extend)

**Interfaces:**
- Consumes: `useHistoryContext()` → `{ clearHistory }` from `@/providers/HistoryProvider` (SettingsDialog already renders inside `HistoryProvider` — verified in `App.tsx`).
- Produces: `HistorySection` gains prop `clearHistory: () => Promise<void>`; `panelsFor(current, clearHistory)` passes it. No other component changes.

- [ ] **Step 1: Write the failing tests**

In `SettingsDialog.test.tsx`, mock the provider next to the existing `vi.mock`s:

```tsx
const { useHistoryContextMock } = vi.hoisted(() => ({ useHistoryContextMock: vi.fn() }))
vi.mock("@/providers/HistoryProvider", () => ({ useHistoryContext: useHistoryContextMock }))
```

Default it in the `beforeEach` reset block: `useHistoryContextMock.mockReturnValue({ clearHistory: vi.fn().mockResolvedValue(undefined) })`. Add:

```tsx
it("offers clear history in the History section behind a destructive confirm", async () => {
  const clearHistory = useHistoryContextMock().clearHistory
  const user = userEvent.setup()
  renderDialog()
  await user.click(await screen.findByRole("tab", { name: "History" }))
  await user.click(screen.getByRole("button", { name: "Clear history" }))
  await user.click(await screen.findByRole("button", { name: "Delete history" }))
  await waitFor(() => expect(clearHistory).toHaveBeenCalledOnce())
})

it("does not clear history when the confirm is dismissed", async () => {
  const clearHistory = useHistoryContextMock().clearHistory
  const user = userEvent.setup()
  renderDialog()
  await user.click(await screen.findByRole("tab", { name: "History" }))
  await user.click(screen.getByRole("button", { name: "Clear history" }))
  await user.click(await screen.findByRole("button", { name: "Cancel" }))
  expect(clearHistory).not.toHaveBeenCalled()
})
```

(Adapt `renderDialog()` to the file's existing render helper name.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/components/SettingsDialog.test.tsx`
Expected: FAIL — no "Clear history" button.

- [ ] **Step 3: Implement**

- In `SettingsDialog`: `const { clearHistory } = useHistoryContext()`; `panelsFor(current, clearHistory)`; `HistorySection({ draft, onChange, clearHistory }: SectionProps & { clearHistory: () => Promise<void> })`.
- In `HistorySection`, below the retention `Field`:

```tsx
<Field orientation="horizontal">
  <FieldContent>
    <FieldLabel>Clear history</FieldLabel>
    <FieldDescription>Permanently deletes all compression history. Files on disk are not affected.</FieldDescription>
  </FieldContent>
  <AlertDialog>
    <AlertDialogTrigger render={<Button variant="destructive" size="sm" />}>Clear history</AlertDialogTrigger>
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Clear history?</AlertDialogTitle>
        <AlertDialogDescription>
          Permanently deletes all compression history. Files on disk are not affected.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" onClick={() => void clearHistory()}>
          Delete history
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</Field>
```

- Import `AlertDialog*` from `@/components/ui/alert-dialog` (the same import block `HistoryView.tsx` used before Task 4 deleted it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/components/SettingsDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Full gate**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: build clean, all vitest suites green, all cargo tests green.

- [ ] **Step 6: Commit**

```bash
git add src/components/SettingsDialog.tsx src/components/SettingsDialog.test.tsx
git commit -m "feat(settings): move clear history into History section with confirm"
```
