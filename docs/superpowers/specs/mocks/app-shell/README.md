# App shell — approved mocks

Static HTML fragments from the design session. Open directly in a browser; each file contains its own `<style>` block and a small script that scales the 900×640 stage to the page width.

| File | Covers | Status |
|---|---|---|
| `shell.html` | 900×640 frames: macOS sidebar open / collapsed with ☰ menu, Windows collapsed / collapsed with menu open | Approved in chat |
| `history.html` | History as an expandable sidebar section; batch list + focused detail; single filter dropdown | Approved in chat |
| `settings-about.html` | Settings dialog (General, Targets) and About dialog | Approved in chat |

## Corrections applied after approval (binding for implementation)

- Collapsed sidebar is fully hidden (`collapsible="offcanvas"`), not an icon rail.
- The detached ☰ menu uses the same icons as the sidebar rows.
- Settings keeps a **History** section (retention) — the approval that removed it was withdrawn.
- Settings saves automatically; there is no draft/Save footer.
- About copy: “Offline file compression tool” / “No accounts and no telemetry.”
- History is not a third column; the list lives inside the sidebar.
- The filter is one dropdown with no submenus, anchored to the right of the sidebar.

## Not shown in the mocks

- The search input above the history list (added to preserve the existing search feature).
- Window controls on Linux (same as Windows).
- Fullscreen (no in-app difference).
