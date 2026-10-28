# History table redesign — design spec

**Status:** locked design
**Date:** 2026-10-28
**Feature:** History batch dashboard, 3-column table, expandable 3-card row detail
**Reference mock:** [`mock.html`](2026-10-28-history-table/mock.html)
**Visuals:** [wide](2026-10-28-history-table/mock-wide.png) · [900](2026-10-28-history-table/mock-900.png) · [reference crop](2026-10-28-history-table/reference-wide.png) · [summary cards](2026-10-28-history-table/summary-cards.png) · [detail cards](2026-10-28-history-table/detail-cards.png) · [narrow](2026-10-28-history-table/narrow.png)

This document is the visual and behavioral source of truth. The saved mock is the pixel reference; this spec names every value, label, interaction and edge case that must survive implementation.

---

## 1. Intent

Make the History batch detail a usable audit surface, not a static list.

The screen must answer four jobs:

1. **Find** a file inside a batch (search, type, outcome filters).
2. **Compare** outcomes (sortable columns, batch size scale, outcome pills).
3. **Inspect** a single file without losing context (expandable row, three focused cards).
4. **Act** on a file (reveal original/compressed).

The batch summary is a dashboard above the table, not four isolated counters. The row detail is an inspector, not a repeat of the row.

---

## 2. Scope

### In scope

- Batch header: title, attention badge, completed duration, reveal-folder action.
- Four batch summary cards: linear size scale, Files + outcome pills, Best effort tile, Failed tile.
- Three-column table: File · Size (new) · Status.
- Table toolbar: search, type filter, result count.
- Outcome filter chips: All, Needs attention, Done, Under target, Clear.
- Sortable columns: File, Size, Status.
- Expandable row with 3-card detail: Size / Target & method / Timing.
- Footer actions in the expanded row: Show original, Show compressed.
- Existing row action menu (⋮) with Show compressed / Show original.
- Responsive 2×2 summary at narrow content widths; 3-up detail; vertically scrolling table with sticky header.
- Empty filtered state, failed-row detail, under-target and cancelled/unsupported handling.
- Tests and manual visual verification against the saved mock.

### Out of scope (do not add)

- CSV/export.
- Original/output paths in the UI.
- Retry/re-run from History.
- Saved and Method table columns.
- Ring/radial summary card (linear scale is final).
- Pagination.
- Per-row selection/checkboxes.
- Server-side filtering/sorting; batch files are already loaded client-side.

---

## 3. Reference data and calculations

The mock uses a demo batch. Production uses the selected `HistorySession`.

Reference mock batch:

| Value | Mock value |
|---|---|
| Files | 13 |
| Original bytes | 72.2 MB |
| Current (compressed/remaining) bytes | 13.7 MB |
| Saved bytes | 58.5 MB |
| Saved percent | 81% |
| Done | 7 |
| Under target | 4 |
| Best effort | 1 |
| Failed | 1 |
| Needs attention | 2 |

Per-file mock example:

| Value | Mock value |
|---|---|
| File | `3d-layout.png` |
| Status | Best effort |
| Original | 1.8 MB |
| Current | 259 KB |
| Saved | 1.5 MB |
| Saved percent | 86% |
| Target | 200 KB |
| Method | PNG palette · Lossy |
| Duration | 2.1 s |
| Completed | Oct 25 · 8:02 PM |

### 3.1 Batch size summary

Compute from the selected session files:

- `originalBytes = sum(file.originalSize)`
- `currentBytes = sum(file.compressedSize ?? file.originalSize)`
  - Failed, cancelled, unsupported and already-under-target files keep their original size in the current total.
  - A successfully compressed file contributes its compressed size.
- `savedBytes = max(0, originalBytes - currentBytes)`
- `percent = originalBytes > 0 ? Math.round(savedBytes / originalBytes * 100) : 0`

This keeps `original → current` and `saved` mathematically consistent. Do not mix the session’s `totalSavedBytes` into card 1 if it diverges from the file-derived values.

### 3.2 Per-file size summary

- `originalBytes = file.originalSize`
- `currentBytes = file.compressedSize ?? file.originalSize`
- `savedBytes = max(0, originalBytes - currentBytes)`
- `percent = originalBytes > 0 ? Math.round(savedBytes / originalBytes * 100) : 0`

For failed/unsupported/cancelled files with no output, the size card is replaced by the error/no-output card (§7.4). Under-target files show 0% saved and current = original.

### 3.3 Outcome groups

- **Done:** `done`
- **Under target:** `already_under_target`
- **Best effort:** `best_effort`
- **Failed:** `failed`
- **Needs attention:** `failed + best_effort + unsupported + cancelled`
- **Other:** any remaining terminal status not represented by Done/Under/Best/Failed. Only render an “Other” pill if its count is greater than zero.

The Files card shows the four main pills in a 2×2 grid. If `other > 0`, add a fifth pill and let the grid grow to a third row; do not silently drop files.

### 3.4 Size formatting

Use the existing `formatSize` behavior and `savedLabel` for 0 B. Examples:

- `72.2 MB`, `13.7 MB`, `58.5 MB`
- `1.8 MB`, `259 KB`, `1.5 MB`
- `200 KB`
- Failed/unsupported/cancelled table size: `—`

Percentages are integers with `%`; negative/zero cases show `0%`.

### 3.5 Method label

Reuse `strategyLabel(strategy, category)`.

- `already_under_target` → `—`
- failed/unsupported/cancelled with no strategy → `—`
- `strategyUsed` present → `strategyLabel(...)`
- fallback `qualityUsed` → `strategyLabel(\`quality=${qualityUsed}\`, category)`
- unknown strategy → raw strategy string

Examples: `PNG palette · Lossy`, `Re-encode · Lossy`, `H.264 CRF · Lossy`.

### 3.6 Status labels

History-facing labels:

| Status | Label |
|---|---|
| `done` | Done |
| `already_under_target` | Under target |
| `best_effort` | Best effort |
| `failed` | Failed |
| `cancelled` | Cancelled |
| `unsupported` | Unsupported |
| `pending` | Pending |
| `compressing` | Compressing |

Use **Under target** consistently in the new table, pills, chips and the session filter dialog. Update the existing history filter copy/tests to match. (The Compress-view `FileList` copy is out of scope.)

### 3.7 Timing

- Duration: use a new precise duration formatter for the new History UI — one decimal below one minute, e.g. `2.1 s`, `26.4 s`; at 60s and above use the established `1m 42s` / `2h 05m` shape. The existing `formatDuration` (floored seconds) stays where already used; do not silently change its public behavior.
- Completed: absolute `MMM D · h:mm A` — `Oct 25 · 8:02 PM`. Do not use relative `Today`/`Yesterday` labels for the per-file completed timestamp.
- Batch header duration: `Completed in {precise duration}`; if no `endedAt`, use `—`.

---

## 4. Layout

The mock stage is 1180px wide with a 232px mock sidebar; the actual app uses the existing sidebar and content area. All mock measurements below refer to the **content width** (the area right of the sidebar, minus padding).

At the wide mock content width **906px**:

- Batch header
- 14px gap
- Summary grid: **342 / 249 / 140 / 140 px**, 12px gap; 113px min-height.
- 14px gap
- Table card: 906px wide; table card fills remaining height.
- Inside the table card: toolbar, chips, table, footer hint.

The actual app must let the table card fill the available height and let the table body scroll; do not hard-code the mock’s scroll heights.

### 4.1 Batch header

Above the summary cards, not inside the table card.

- Left:
  - Batch title: `Oct 25 · 8:02 PM` — 16px, 600 weight, `text-foreground`.
  - Badges next to title, 10px: `Needs attention` (amber tone) when `needsAttention > 0`; existing `Cancelled` / `Interrupted` badges remain.
  - Subtitle: `Completed in 26.4 s` — 10px, `text-muted-foreground`.
- Right:
  - Reveal-folder icon button: 28×28px outline button, `FolderOpen` icon, tooltip “Reveal folder”, existing `open_folder` action.

### 4.2 Summary cards

Grid:

- 4 columns, `2.2fr 1.6fr .9fr .9fr`, 12px gap.
- Each card: `bg-muted/40`, radius 14px, padding 13px 14px, min-height 112px, no border.
- Card 1 and 2 receive width from the square status tiles.
- At content ≤700px: 2×2 equal grid, 12px gap; card 1 scale width 150px; current reading 20px. Detail remains 3-up (§8).
- Numbers in cards 2/3/4 are centered horizontally and vertically in their remaining space; card 1’s current reading sits at the right.

#### Card 1 — Size scale

A **linear** scale, same language as the row detail size card. No radial, no ring.

Layout inside card:

- Left: scale block, 190px wide (150px at ≤700px).
  - Eyebrow: `SIZE`, 8px uppercase, `text-muted-foreground`.
  - Labels above bar, 8px:
    - `0` left.
    - `13.7 MB` at 19% (current marker; translated `-50%`).
    - `72.2 MB` right (original).
  - Bar: 7px high, radius 999.
    - `0 → 13.7 MB` green/current: `bg-primary`/primary gradient.
    - `13.7 MB → 72.2 MB` gray/gone: muted gray.
    - White 2px tick at 19% (current marker), extending 3px above/below the bar.
  - Foot: `81% saved` in primary green, 9px, 650 weight.
- Right: current reading block, text aligned right:
  - `13.7 MB` — 24px, 650 weight; `MB` 11px muted.
  - `CURRENT` — 7px uppercase, letter-spacing .08em, muted.
  - `58.5 MB saved` — 9px muted; 4px top margin.

Do not render a “Saved” label next to the scale; the `58.5 MB saved` line is the only saved caption. No old `72.2 MB → 13.7 MB` sub-line.

Accessibility: the bar has `role="img"` and `aria-label="Current size 13.7 MB of 72.2 MB original; 81% saved"`. The visual bar/tick are `aria-hidden`.

#### Card 2 — Files

- Label: `Files`, 10.5px, `text-muted-foreground`.
- Number: `13` — 27px, 650 weight, centered.
- Pills: 2×2 grid, 4px gap, full width, 5px top margin.
  - `Done` green dot + label + count `7`.
  - `Under target` gray dot + label + count `4`.
  - `Best` amber dot + label + count `1`.
  - `Failed` red dot + label + count `1`.
  - Pill: height 18px, radius 999, padding 0 6px, font 9px, 600 weight, dot 5px, count right aligned (`font-variant-numeric: tabular-nums`).
  - Tones: Done primary tint; Under target secondary/muted; Best amber tint; Failed destructive tint.
  - If `other > 0`, add an `Other` pill; grid grows to 2×3; card grows.
- No micro segmented bar. No “7 done · 4 under target” text line.

#### Card 3 — Best effort

- Label: amber dot + `Best effort`, 10.5px.
- Number: `1`, 27px, centered; foreground color (not amber).
- No sub-line. No “1 file”.
- Card is neutral; only the dot carries the status color.

#### Card 4 — Failed

- Label: red dot + `Failed`, 10.5px.
- Number: `1`, 27px, centered; foreground color (not red).
- No sub-line. No “1 file”.
- Card is neutral; only the dot carries the status color.

### 4.3 Table card

Card:

- `bg-card`, 1px `border-border`, radius 16px, padding 14px 16px 0.
- Fills available height.
- Header/toolbar at top; table scrolls; footer hint at bottom.

Toolbar:

- Title: `Files` — 12.5px, 600 weight.
- Search input: height 28px, radius 7px, `bg-background`/muted, border, 10.5px, placeholder `Search files…`, right `kbd /`.
  - `/` focuses the search. Escape clears search.
- Type filter: `All types` control, height 28px, radius 7px, options: All types, Image, Video, PDF, Document, Other.
- Right: `13 of 13` count — 10px, muted, tabular.
- Toolbar wraps at narrow widths; search max-width 300px (220px at ≤700px content).

Chips row:

- Height 22px, radius 999, padding 0 8px, font 10.5px, gap 5px.
- `All` + count; active state: `bg-muted`/foreground, border lighter.
- `Needs attention` + count: **neutral surface** (`bg-muted/30`) with amber dot and amber count; do not use a full amber filled chip.
- `Done` + count.
- `Under target` + count.
- `Clear` text button (transparent, muted).
- Single-select outcome filter. Counts are session-wide.
- Clear resets search, type and outcome.

Table:

- Header: sticky top; height 32px; background `bg-card`/`#171717`; uppercase 9.5px, 600 weight, letter-spacing .06em, `text-muted-foreground`; bottom border.
- Columns:
  - Expand: 24px; chevron button.
  - File: flexible (all remaining); left.
  - Size: 92px; right aligned; tabular.
  - Status: 142px; left.
  - Actions: 34px; right.
- Body row: height 43px; 12px text; padding 0 9px; bottom border.
- Hover: `bg-muted/40` (existing table hover).
- Failed row: `bg-destructive/5`; error text under the file name in `text-destructive`, 9.5px, truncate with `title`.
- File cell: 24px rounded category icon tile; 8px gap; name 12px, 550 weight, truncate with `title`; error under.
- Size: new/current size only; right aligned; tabular. `—` for failed/unsupported/cancelled with no output.
- Status: `Badge` with 5px dot + label; 10px; radius 999; tone from `STATUS_TONES`.
- Actions: existing ellipsis row menu; Show compressed (disabled when `outputPath === null`), Show original.
- Expand: 17×17px chevron button; rotates down when open; `aria-expanded`, `aria-controls`.

Table body scroll:

- Sticky header.
- Scroll container fills card height; no horizontal scroll.
- The mock’s 536/543/585 scroll heights are presentation-only; do not hard-code them in the app.

Footer hint:

- Right aligned; 9px muted; `Expand a row for saved data, target, method and timing.`
- No batch totals or saved-percent in the footer; those live only in the summary cards.
- Narrow variant: `Table scrolls vertically.`

### 4.4 Empty filtered table

If filters produce zero rows, render one full-width table row:

- message `No files match these filters.`
- `Clear filters` button.
- Keep the header and toolbar; keep the summary cards (batch totals).

---

## 5. Expandable row detail

Only one row expanded at a time. The detail is a full-width row (`colSpan = 5`) inserted after the file row.

Detail row:

- Background `#101010` / `bg-muted/10`.
- Padding 13px 16px 13px 40px (left aligns with file name after the expand column).
- Grid: `1.4fr 1fr 1fr`, 12px gap, cards stretch to equal height.

Each of the three cards:

- `bg-muted/30`/`#1a1a1a`, 1px border, radius 12px, padding 11px 12px.
- Card eyebrow: 8px uppercase, letter-spacing .08em, muted.
- No amber/red card fills. Status color stays in the row.

### 5.1 Card 1 — Size scale

- Eyebrow `SIZE`.
- Labels 8px:
  - `0` left.
  - `259 KB` at 14% (current marker; translated -50%).
  - `1.8 MB` right (original).
- Bar: 7px; `0 → 259 KB` green/current; `259 KB → 1.8 MB` gray/gone; white 2px tick at 14%.
- Foot: `86% saved` green, 9px, 650; `1.5 MB saved` muted, 9px, right.
- This is the inverted progress: current size primary; the gone size is not.
- No 0-saved file hides the size card; failed uses the error card (§5.4).
- Accessibility: `role="img"`, `aria-label="Current size 259 KB of 1.8 MB original; 86% saved"`.

### 5.2 Card 2 — Target & method

- Eyebrow `TARGET & METHOD`.
- Stacked fact rows, label 8px muted, value 10px foreground, 1px gap, 8px between facts.
- `Target` → `200 KB`
- `Method` → `PNG palette · Lossy` (humanized; `—` when no method)
- Values must not truncate; the card is 242px wide at wide, 151px at 900 content; stacking the label/value is required.

### 5.3 Card 3 — Timing

- Eyebrow `TIMING`.
- Stacked fact rows:
  - `Duration` → `2.1 s`
  - `Completed` → `Oct 25 · 8:02 PM`
- Values must not truncate.

### 5.4 Failed / no-output rows

- The Size card is replaced by an error card with the full error text (`text-destructive`), no progress bar.
- Target & method and Timing cards remain.
- Footer actions remain; `Show compressed` disabled.
- Original path is still revealable.

### 5.5 Footer actions

- Full-width footer row inside the detail grid (`grid-column: 1 / -1`).
- Border-top; padding-top 9px; right aligned.
- Buttons: height 24px, radius 6px, 10px, outline/secondary; folder-closed icon for `Show original`, folder-open icon for `Show compressed`; gap 6px.
- `Show compressed` disabled when no output.
- `Show original` always available; invoke error toast uses the existing message rules.
- The row action menu duplicates the same two actions as a shortcut; keep it.

---

## 6. Table filters, sorting, state

Local to the selected session; no backend changes.

### 6.1 Search

- Case-insensitive substring on file name.
- Immediate client-side filtering.
- `/` focuses the search input; Escape clears it.
- Search input has placeholder `Search files…` and `aria-label="Search files"`.

### 6.2 Type filter

- Single-select: All types, Image, Video, PDF, Document, Other.
- Uses `Category` values and the existing category labels/icons.
- Displayed as `All types` when no type filter.

### 6.3 Outcome filter

- Single-select: All, Needs attention, Done, Under target.
- `Needs attention` includes failed + best effort + unsupported + cancelled.
- Counts are session-wide (not reduced by search/type); the table result count is filtered.
- Active chip uses `aria-pressed`.
- `Clear` resets outcome, type and search.

### 6.4 Table count

- `N of M` where N is the filtered visible count and M is `session.files.length`.
- Example `13 of 13`; `2 of 13` when filters produce two rows.

### 6.5 Sorting

- Columns File, Size, Status only.
- Default: source order (the order returned by the backend, completion order); no active sort.
- Click cycles ascending → descending → off (source order) or asc/desc toggle; use TanStack `getToggleSortingHandler` and expose `aria-sort` on the header.
- File: locale string compare on name.
- Size: numeric current/compressed size; null/no-output last.
- Status: severity order **Failed → Best effort → Unsupported → Cancelled → Done → Under target → Pending → Compressing** for ascending; reverse for descending. Test the rank function. The mock shows neutral sort icons until clicked.
- Do not show two active sorted columns; the mock’s dual arrows are a visual artifact.

### 6.6 Expand/collapse

- Expand button toggles the row detail.
- One expanded row at a time; opening another closes the previous.
- If the expanded file is filtered/sorted out, close the detail.
- The detail row uses the `HistoryFileDetail` component; no status/no file name repeated.
- The new size is present in the table Size column **and** in the size card by design (the size card needs the current value for its scale). Status is only in the table row.

### 6.7 Reset

Reset filters, sort and expanded row when the selected session changes. Prefer `<HistoryFilesTable key={session.sessionId} … />` in `HistoryView`.

---

## 7. Responsive behavior

Content container query width is the area right of the sidebar, after page padding.

- **> 700px content:** summary 4-up (`2.2fr 1.6fr .9fr .9fr`); scale width 190; current 24; table search max 300.
- **≤ 700px content:** summary 2×2 equal; scale width 150; current 20; table search max 220; table remains 3 columns + expand/actions; no horizontal scroll.
- **Detail:** remains 3-up at all supported widths (900 window with sidebar open ≈592px content; 760 window with sidebar collapsed ≈712px content). Cards shrink; fact rows are stacked so `PNG palette · Lossy` and `Oct 25 · 8:02 PM` never truncate.
- **Table:** fills available height; vertical scroll; sticky header; no horizontal scroll. File names truncate; values do not.
- **Summary cards 3/4:** square-ish at wide (140×113); 2×2 at narrow (equal width).

The mock’s 1180/900 stages are reference artboards; the app uses the real `HistoryView` width and min window width 760.

---

## 8. Visual system

Use the app’s existing shadcn tokens and `src/lib/tokens.ts` status tones. The mock’s hex values are reference approximations; do not hard-code the yellow/orange palette.

- Surfaces:
  - Page `bg-background`; sidebar existing.
  - Table card `bg-card border-border`.
  - Summary cards `bg-muted/40`, radius 14, no border.
  - Detail cards `bg-muted/30`/`bg-muted/25`, border `border-border/60`, radius 12.
  - Table header `bg-card`/slightly raised, sticky.
- Progress:
  - Current size = primary green (`bg-primary`, primary gradient).
  - Gone size = muted gray (`bg-muted-foreground/20` or `bg-muted`).
  - Track = muted.
  - Saved % text = `text-primary`.
- Status:
  - Done = primary/green.
  - Under target = muted/secondary.
  - Best effort = amber (`text-amber-600`, `bg-amber-500/10`, border amber/25) — only small dots, pills, badges.
  - Failed = destructive red — only small dots, pills, row badge/error.
  - Numbers in summary status cards are foreground, not amber/red.
  - No full amber/yellow cards. No orange secondary surfaces.
  - “Needs attention” chip is neutral with an amber dot and count.
- Typography:
  - Inter.
  - Batch title 16/600; batch subtitle 10/muted.
  - Summary label 10.5; numbers 27/650; current 24 (20 narrow); current label 7; saved 9; scale labels 8; scale foot 9; pills 9.
  - Table title 12.5/600; search/type/chips 10.5; table header 9.5 uppercase/600; body 12; badge 10; count 10; footer 9.
  - Detail eyebrow 8 uppercase; scale labels 8; fact labels 8; fact values 10; footer buttons 10.
  - Use arbitrary sizes if the Tailwind token scale does not match; match the mock.
- Radii: summary 14; table card 16; detail cards 12; pills/badges 999; buttons 6–7.
- Spacing: summary gap 12; page/table gaps 14; detail gap 12; card padding as above.

---

## 9. Accessibility

- Table semantics preserved: `<table>`, `<thead>`, `<tbody>`, `<th>`.
- Sortable headers: `<button>` with accessible name `Sort by File` etc.; `aria-sort` on the `<th>`; icon `aria-hidden`.
- Expand button: `aria-expanded`, `aria-controls` pointing to the detail row id; accessible label `Expand {file.name}` / `Collapse {file.name}`.
- Detail row `id` matches.
- Row action menu: accessible label `File actions`; menu items.
- Reveal buttons: `Show original` / `Show compressed`; disabled state with `disabled`.
- Progress visuals: `role="img"` with a full text `aria-label`; bars/ticks decorative `aria-hidden`.
- Status dots are `aria-hidden`; text labels carry meaning.
- Filter chips: `aria-pressed`; search input label; type filter label; visible focus rings.
- Color is never the only signal: every status/percentage has text.
- Keyboard: `/` focuses search; Escape clears search; table buttons reachable; focus visible.
- Truncated names use `title`; detail values are not truncated.
- `prefers-reduced-motion`: no decorative animation; any expand transition ≤150ms and disabled when reduced motion.

---

## 10. Edge cases

- **No files in session:** existing “No files in this batch” / cancelled / interrupted message; no table.
- **Filters return zero:** table empty row with clear action; summary cards still visible.
- **Failed/unsupported/cancelled file:** size `—` in table; detail error card replaces size card; Show compressed disabled.
- **Under target:** size = original; detail size card shows 0% saved; current = original; green current bar full; gray gone 0; target/method/timing; Show compressed enabled if output exists.
- **Zero-byte/zero-original file:** percent 0; do not divide by zero.
- **Long file names:** truncate in table with `title`; full name visible in detail? The detail does not repeat the name; the table name title. 
- **Long method/completed:** stacked fact rows; no truncation at supported widths.
- **1000-file batch:** table scrolling must remain responsive; see §12 performance.
- **Cancelled/interrupted session:** batch header badges; summary counts; files; existing states.
- **Missing output path:** reveal compressed disabled; original still enabled.
- **Reveal errors:** existing toast prefix rules; no silent failure.
- **Session switch:** reset filters/sort/expanded; summary recalculated.
- **Filter + expanded row:** close if the expanded row is no longer visible.
- **Dark/light theme:** semantic tokens; progress primary; status tones; no hard-coded dark-only colors beyond the reference mock.

---

## 11. Testing

### Unit (history helpers)

- `batchSizeSummary` original/current/saved/percent with done, under-target, best-effort, failed, cancelled, unsupported, zero original.
- `fileSizeSummary` for done, under-target, failed, best-effort.
- `historyMethodLabel` for strategy, best-effort, under-target, failed, quality fallback, unknown.
- `status label` mapping including “Under target”.
- Outcome counts and “Needs attention” grouping.
- Filter helpers: search, type, outcome, combination; clear.
- Sort helpers/ranks if extracted.
- `batchLabel`/duration formatting used in detail.

### Component

- `HistorySummaryCards`: 4 cards; card 1 labels 0/current/original/percent/saved; card 2 pills 2×2; cards 3/4 centered numbers/no sub; responsive class contract.
- `HistoryFileDetail`: 3 cards; scale labels/tick/aria; target/method/timing; footer actions; failed error replaces size card; Show compressed disabled; no new/status duplication (only current in size card as designed).
- `HistoryFilesTable`: three column headers only (File/Size/Status); no Saved/Method columns; sort toggles/aria-sort; search/type/outcome filters; result count; chips; expand/collapse; one expanded; detail; empty filtered row; failed/under-target rows; row menu; reveal calls.
- `HistoryView`: batch header; Needs attention badge; summary; table; key session reset; no old stat cards; empty/loading/error states preserved.

### Manual visual verification

Run the app via `yarn tauri dev` and compare against the saved mock at:

- 1800 / 1250 / 900 / 760px window widths.
- Dark and light themes.
- 13-file batch, filtered-empty batch, failed file, under-target file, single-file batch.
- Check: no clipped text; no horizontal table scroll; summary 4-up/2×2; detail 3-up; sticky header; scroll; footer visible; colors match tokens; no yellow/orange cards.

Save final screenshots in the feature folder if useful.

---

## 12. Performance

The design uses a vertically scrolling table, no pagination. For a 1000-file session, rendering every row is the known debt from `docs/bugs.md`.

Implementation requirement:

- Render rows in the scroll container with the exact visual design.
- Below or equal to **200 filtered rows**, render normally.
- Above **200 filtered rows**, virtualize the row body with `@tanstack/react-virtual`; keep the sticky header, expanded detail row, row menu, scrollbar and summary unchanged. Measure dynamic row/detail heights. The visual output must be identical at 13 and 1000 files.
- No pagination. No change to the mock layout.

---

## 13. Acceptance criteria

The implementation is accepted when:

1. History shows the batch header + 4-card summary + table card, matching the mock hierarchy.
2. Card 1 is a **linear** scale with `0 → current MB → original MB`; green current, gray gone; current big right; saved below; 81% saved example.
3. Files card uses the 2×2 outcome pills; card numbers 13/1/1 centered; no “1 file”.
4. Table has only File, Size, Status data columns + expand/actions, and no Saved/Method columns.
5. Search, type filter, outcome chips, Clear, sortable headers, result count work client-side.
6. Row expansion shows the 3-card detail: Size scale / Target & method / Timing; footer actions right; failed error state.
7. New size and status are not repeated in a way that violates the mock (current size is intentionally in the size card; status stays in the row).
8. Responsive behavior matches §7 at 900/760 content widths; no horizontal table scroll, no clipped detail values.
9. Colors use the app tokens: neutral surfaces, green progress, amber/red only small status accents.
10. All listed tests pass; manual visual comparison against the saved mock passes.
11. No CSV, paths, retry, ring summary, pagination, selection, or Saved/Method columns.
12. Existing History loading/error/empty/cancelled/interrupted states still work.

---

## 14. Mock reference notes

- `mock.html` is the self-contained final mock. Open it in a browser; it needs no server.
- The mock uses two stages (1180 wide and 900 wide) to show wide and narrow behavior. The app uses the real sidebar/window; do not force the mock stage widths.
- The mock’s fixed table scroll heights are presentation-only; production uses the card’s available height and vertical scrolling.
- The mock’s demo numbers are the reference values in §3; production computes from the session.
- The mock’s summary/detail sections are chosen-state displays; implementation should not ship the mock’s option/selection chrome.
- The mock’s row action ⋮ and the detail footer both expose reveal actions; keep both.
- The mock’s `Under target` copy is the final short label; update the history filter dialog copy to match.
