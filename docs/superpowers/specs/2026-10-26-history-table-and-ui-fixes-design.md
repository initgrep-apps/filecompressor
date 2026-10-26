# History table + UI fixes — design

Date: 2026-10-26
Status: Approved in chat (brainstorming), pending implementation plan
Path: bounded (existing flows: history detail view, kanban board, shell menus)

## Goals

Fix four UI bugs in the Tauri desktop shell and replace the history detail
file list with a proper data table. All root causes verified live in the
running app with DOM measurements and screenshots.

## Non-goals

- No search or filter toolbar in the new table (sidebar History Filter dialog
  remains the only filtering surface).
- No server-side table sorting UI beyond default file order.
- No Windows-build verification loop in this slice (manual check afterwards).

## Root causes (verified 2026-10-25, live app, macOS)

### 1. History detail does not scroll

Measured in the live webview with a 60-row session:
`scrollHeight=632 clientHeight=632 overflowY=auto` — the scroll container
believes its content fits. `BatchFiles` renders the files card as a flex
child of `CardContent` (flex-col). Default `flex-shrink: 1` shrinks the card
to the container height; its own `overflow-hidden` then clips rows. Content
never overflows `CardContent`, so `overflow-y-auto` never activates.

### 2a. Kanban lanes capped at half height, lane scroll dead

Measured: board area `parent h=740 | board h=545 | lane h=531`, with ~209 px
dead space below the lanes.

- `KanbanBoard.tsx` hardcodes `[&>*]:max-h-[533px]` and the board never fills
  its parent.
- Same flex-shrink gotcha as (1): `lane scrollH=531 = clientH` — `RunRow`s
  shrink to fit instead of overflowing the lane's scroll list, so the lane's
  internal `overflow-y-auto` never activates and rows clip mid-row.

### 2b. Windows horizontal scrolling nearly impossible

Board uses `overflow-x-auto`. WebView2 renders classic always-visible fat
scrollbars; a mouse wheel only scrolls vertically, so the only pan gesture is
dragging the scrollbar thumb; dragging on the board selects text (no
`select-none`). Fix is standard kanban handling; needs eyes on a Windows
build after the slice.

### 3. Topbar dropdown menus render black in every theme

`DropdownMenuContent` and `DropdownMenuSubContent` in
`src/components/ui/dropdown-menu.tsx` start their popup className with a
stray literal `dark` class. That applies `.dark` CSS variables to the popup
subtree regardless of theme. Confirmed live: light theme, black popup.

### 4. Buttons show arrow cursor on macOS

Tailwind 4 preflight sets no cursor on buttons (verified in preflight.css);
WebKit's UA stylesheet uses the arrow cursor for buttons on macOS, Chromium
on Windows uses the pointer. Fix once globally in `index.css`.

## Design

### A. Kanban board (`src/components/run/KanbanBoard.tsx`, `Lane.tsx`, `index.css`)

- Board container: `h-full` so it fills the `RunMonitor` area.
- Lanes: `h-full` (flex column), the 533 px cap is deleted.
- Lane rows (`RunRow` wrapper): `shrink-0` so the lane's list overflows and
  its `overflow-y-auto` works.
- Board: `select-none` and an `onWheel` handler that translates vertical
  `deltaY` into horizontal `scrollLeft` (mouse users can pan lanes).
- Global scrollbar styling in `index.css`: thin, rounded, low-contrast
  thumbs for WebKit/WebView2 — fixes the fat always-visible Windows
  scrollbars app-wide.

### B. History detail data table

New dependency: `@tanstack/react-table` (standard shadcn data table pairing;
only new dependency in this slice).

New component `src/components/history/HistoryFilesTable.tsx` replaces the
`BatchFiles` list in `src/views/HistoryView.tsx`.

Columns (plain-language headers):

| Column | Cell content |
|---|---|
| File | Colored category icon + file name; red error text under the name when status = failed |
| Size | `6.3 MB → 1.5 MB` (`originalSize → compressedSize`; `—` when null) |
| Method | `strategyUsed`/`qualityUsed` as today (`Ghostscript · Lossy`); `—` when absent |
| Status | Existing `StatusMarker` badge |
| Actions | ⋮ button opening a dropdown menu |

⋮ menu items (icon + label, verb wording chosen over alternatives):

- **Show compressed file** — `reveal_in_folder(file.outputPath)`; disabled
  when `outputPath` is null (failed/cancelled rows).
- **Show original file** — `reveal_in_folder(file.path)`.

Table behavior: sticky header, vertical scroll inside the card (flex-shrink
lesson applied — scroll container children must not shrink), horizontal
scroll on narrow windows, no toolbar.

### C. HistoryView header

- "Reveal folder" button becomes icon-only (FolderOpen) with tooltip, same
  `open_folder(session.outputFolder)` behavior.
- `Output: {session.outputFolder}` line removed from `BatchTitle`.
- "Clear history" button and its `AlertDialog` removed from this view.

### D. Settings → History (`src/components/SettingsDialog.tsx`)

- `HistorySection` gains a "Clear history" destructive-zone button that
  opens the existing red `AlertDialog` confirm ("Permanently deletes all
  compression history. Files on disk are not affected.") and then calls
  `clearHistory` from `useHistoryContext`.
- Toast feedback on success is not added (silent success, list refreshes).

### E. Shell fixes (`src/components/ui/dropdown-menu.tsx`, `index.css`)

- Remove the stray `dark` token from `DropdownMenuContent` and
  `DropdownMenuSubContent` popup classNames.
- `index.css` base layer:
  `button:not(:disabled), [role="button"]:not(:disabled) { cursor: pointer; }`

## Error handling

- Reveal actions keep existing `toastOpenError` handling (labeled toasts).
- `clearHistory` keeps existing error toast.
- Table renders the existing empty-state messages (cancelled / interrupted /
  no files).

## Testing

- Update `src/views/HistoryView.test.tsx`: table rows render, reveal actions
  via menu, clear-history button absent, output path absent, icon-only
  reveal button present.
- New `src/components/history/HistoryFilesTable.test.tsx`: column rendering,
  disabled compressed action on failed rows, menu interaction.
- Update `src/components/run/KanbanBoard.test.tsx`: 533 px cap removed,
  wheel-to-horizontal handler.
- Update `src/components/SettingsDialog.test.tsx`: clear history flow with
  confirmation.
- Gate: `yarn build && yarn test && cd src-tauri && cargo test`.

## Risks

- Windows scrollbar appearance and wheel panning need a manual Windows
  build check (bug 2b acceptance).
- `@tanstack/react-table` adds bundle weight (~15 kB gzipped) — accepted for
  standard table semantics.
