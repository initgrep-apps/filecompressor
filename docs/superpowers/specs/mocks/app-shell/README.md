# App shell — approved mocks

Static HTML fragments from the design session. Open directly in a browser; each file contains its own `<style>` block and a small script that scales the 900×640 stage to the page width.

| File | Covers | Status |
|---|---|---|
| `shell.html` | 900×640 frames: macOS sidebar open / collapsed with ☰ menu, Windows collapsed / collapsed with menu open | Approved in chat |
| `history.html` | History as an expandable sidebar section; batch list + focused detail | Approved in chat |
| `filter-dialog.html` | Final filter dialog: two sorts, status/category chips, date picker with presets, 760×500 and 900×640 | Approved in chat |
| `settings-about.html` | Settings dialog (General, Targets) and About dialog | Approved in chat |

## Corrections applied after approval (binding for implementation)

- Collapsed sidebar is fully hidden (`collapsible="offcanvas"`), not an icon rail.
- The detached ☰ menu uses the same icons as the sidebar rows.
- Settings keeps a **History** section (retention) — the approval that removed it was withdrawn.
- Settings saves automatically; there is no draft/Save footer.
- About copy: “Offline file compression tool” / “No accounts and no telemetry.”
- History is not a third column; the list lives inside the sidebar.
- The filter is a modal `Dialog` opened from the funnel, not a side panel. Controls are shadcn `ToggleGroup` chips (no checkboxes) and a `Calendar` date picker with presets.
- Sort is only `Newest first` / `Oldest first`.
- Category chips reuse the staging-area glyphs and tones via a shared `CategoryIcon`.
- Category chips ship **five** values — Image, Video, PDF, Document, **Other** — keeping the existing filter scope (the mock shows four; `Other` was cut, current behavior wins).
- Windows is frameless with the default shadow (Windows 11 rounded corners); no transparent window.

## Revision 2

The 760×500 frames are the **Sheet state**: that width is below the 768px breakpoint, so the desktop sidebar is replaced by the stock mobile Sheet. The 900×640 frames remain the desktop reference. Read both when checking the approved layout.

## Not shown in the mocks

- The search input above the history list (added to preserve the existing search feature).
- Window controls on Linux (same as Windows).
- Fullscreen (no in-app difference).
