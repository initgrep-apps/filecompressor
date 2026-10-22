# App shell redesign — design

**Date:** 2026-10-23
**Status:** approved in chat, awaiting spec review
**Scope:** window chrome, sidebar, history view, settings dialog, about, theme control

## 1. Intent

Make Yard feel like a native desktop app rather than a web page in a window. The top bar becomes part of the app surface, the sidebar carries only what belongs there, and settings/history stop competing with the main workflow.

Success criteria:

- On macOS the window has no visible OS title bar; traffic lights sit inside the sidebar band.
- The content top bar contains the sidebar toggle, the current location, a theme control, and an app menu — nothing else.
- The sidebar has exactly two entries, `Compress` and `History`, plus `Settings` at the bottom. No brand lockup, no version/license badges.
- `History` expands in place to a batch list; selecting a batch fills the main pane. No third column.
- Settings is a dialog with a section rail and auto-save. The full-page Settings view is gone.
- About (version + licenses) moves under the `⋯` menu.
- The app collapses and re-expands deterministically; no content-width heuristics move the sidebar.

## 2. Non-goals

- No router. `activeView` stays in React state.
- No native macOS menu bar in this slice (explicitly deferred).
- No new persistence backend: sidebar state keeps its cookie, theme uses `localStorage`, settings keep `plugin-store` through Rust.
- No changes to compression behavior, queueing, history storage format, or the processors.
- No history schema changes beyond a sort parameter on the query.

## 3. Decisions

| Decision | Choice | Why |
|---|---|---|
| Window chrome, macOS | `titleBarStyle: "Overlay"`, traffic lights at `(16, 26)`, empty title | Matches the reference apps; traffic lights inside the sidebar band |
| Window chrome, Windows | `decorations: false`, `transparent: true`, custom min/max/close on the right | Reference parity; Windows 11 rounds and clips the transparent window |
| Window chrome, Linux | `decorations: false`, same custom controls | Keeps one shell layout; Linux is source-build only today |
| Drag | Custom wrapper: `startDragging()` on mousedown (skip `detail === 2`), `toggleMaximize()` on double-click | `data-tauri-drag-region` cannot express double-click zoom |
| Collapsed navigation | `☰` menu beside the toggle (all platforms), items Compress / History / Settings with sidebar icons | Visible in-window, one code path, no Rust menu |
| App menu | `⋯`: About Yard, separator, Quit | Keeps global actions out of navigation |
| Settings commit | Auto-save, debounced | A dialog has no natural “save” moment; no lost edits |
| Theme | Binary toggle, persisted, native window theme synced | Matches the mock; “system” remains the initial value only |
| Sidebar auto-collapse | Deleted | It fights the user (`docs/bugs.md`); deterministic sidebar is a goal |
| Fullscreen | No code | macOS hides/restores traffic lights natively; the in-app top bar stays |

## 4. Window chrome

### Configuration

`src-tauri/tauri.conf.json` (base):

```json
"title": "",
"width": 900, "height": 640, "minWidth": 760, "minHeight": 500,
"resizable": true,
"titleBarStyle": "Overlay",
"trafficLightPosition": { "x": 16, "y": 26 }
```

Platform overlays (add):

- `src-tauri/tauri.windows.conf.json`: `"decorations": false, "transparent": true`
- `src-tauri/tauri.linux.conf.json`: `"decorations": false`

`dragDropEnabled` stays at its default (`true`) because the app uses Tauri’s native file-drop events in `DropZone`.

### Capabilities

Add to `src-tauri/capabilities/default.json`:

- `core:window:allow-start-dragging`
- `core:window:allow-toggle-maximize`
- `core:window:allow-minimize`
- `core:window:allow-set-theme`

`core:default` is expected to cover `getVersion()` (`core:app:version`); verify during implementation and add the narrow permission if the call is denied.

### Platform detection

`src/lib/platform.ts`: read `navigator.userAgent` once and return `"darwin" | "win32" | "linux"`. No `tauri-plugin-os` dependency.

- `darwin`: traffic lights exist; the top bar gets 88px left clearance only while the sidebar is collapsed.
- everything else: render `WindowControls` (minimize, maximize, close) at the right end of the top bar after a vertical separator.

### Fullscreen

Nothing to implement. In fullscreen macOS hides traffic lights and reveals them on hover; the content top bar remains. Windows/Linux keep their custom controls.

## 5. Shell layout

```
SidebarProvider (h-svh, overflow-hidden)
├── Sidebar (collapsible=icon, width 16rem)
│   ├── SidebarHeader (h-12): traffic lights on macOS; glyph + collapse button elsewhere
│   ├── SidebarContent: Compress, expandable History + batch list
│   └── SidebarFooter: Settings (icon + label)
├── SidebarInset
│   ├── TopBar (h-12)
│   │   ├── left: toggle, ☰ (collapsed only), breadcrumb
│   │   ├── right: theme, ⋯, window controls (non-mac)
│   └── view container (min-h-0, overflow-hidden): Compress | History
├── SettingsDialog
├── AboutDialog
└── Toaster
```

The top bar is a row inside `SidebarInset`, not a separate title bar. On macOS the sidebar runs full height under the traffic lights; on Windows/Linux the sidebar header carries the app glyph and the collapse button, mirroring the reference.

### New components

| File | Responsibility |
|---|---|
| `src/lib/platform.ts` | user-agent platform constant |
| `src/hooks/useTheme.ts` | theme state, persistence, `.dark` class, native `setTheme` |
| `src/components/shell/TopBar.tsx` | composition of the row |
| `src/components/shell/DragSurface.tsx` | drag + double-click zoom wrapper |
| `src/components/shell/WindowControls.tsx` | minimize / maximize / close (non-macOS) |
| `src/components/shell/NavMenu.tsx` | ☰ menu (collapsed only) |
| `src/components/shell/AppMenu.tsx` | ⋯ menu |
| `src/components/shell/ThemeToggle.tsx` | sun/moon button |
| `src/components/AboutDialog.tsx` | version, license rows, notices |
| `src/components/SettingsDialog.tsx` | dialog shell + sections |

Icons from the existing `@remixicon/react` set: `RiSidebarFoldLine` / `RiSidebarUnfoldLine`, `RiMenu2Line`, `RiSunLine` / `RiMoonLine`, `RiMoreLine`, `RiFilter3Line`, `RiArrowUpDownLine`, `RiCheckLine`, `RiSubtractLine`, `RiWindowLine`, `RiCloseLine`.

### Components to add from shadcn

`dialog` and `dropdown-menu` are not vendored yet. Add both through the shadcn CLI using the existing `components.json` (`base-rhea`, remixicon); they are required by Settings/About and by the three menus.

## 6. Sidebar

### Navigation

- `Compress`: existing behaviour and staged-file count badge.
- `History`: row with clock icon and label; on the right, a filter button and a chevron.
  - Clicking the row selects History and toggles the inline batch list.
  - Clicking the filter button toggles the filter dropdown without changing selection.
  - Chevron rotates 90°; expanded state persists for the session only.
- `Settings` (footer): gear + label; opens the dialog. No longer a view.

Removed: brand header, `v1.0.0` / `GPLv3` footer badges, `settings` nav entry, `navItems` settings member.

Collapse behaviour: `SidebarProvider` keeps the existing cookie-backed state and ⌘B shortcut. `useAutoCollapse` and its call sites/tests are deleted. In icon mode the sidebar shows the two glyphs and the settings glyph; the History list is hidden.

### History list inside the sidebar

- Rows: short relative date (`Today · 2:31 PM`, `Yesterday · 6:20 PM`, `Oct 21 · 4:48 PM`), then `N files · X saved`; right side shows `−NN%`, or `cancelled`/`N failed` in the destructive tone.
- Search: a compact input below the History row while expanded, placeholder `Search history`, debounced 300ms. It keeps the existing `search` filter (file name, path, output path, error) and feeds the active-filter dot.
- Selected row: subtle accent background plus a 2px primary bar on the left.
- Ordering follows the query sort. The list scrolls; Settings stays pinned.
- Empty state: `No batches yet.` with muted text.
- The list and search are rendered only when the sidebar is expanded and open.

## 7. History view

Two pieces share one provider:

- Sidebar list (`HistoryList` inside `SidebarContent`)
- Main detail (`HistoryView` in the content pane)

`HistoryProvider` wraps both. It owns `useHistory` (already existing), the selected session id, the expanded section flag, the search text, and the filter/sort UI state. Selection defaults to the first session of the current page after a load; if the selected session disappears (filter/page change), fall back to the first, then to empty.

### Detail pane

- Header: `Today · 2:31 PM`, meta line `N files · duration · Output: <folder>`, `Reveal folder` button.
- Stats: Saved, Files (or `N / M` when filtered), Best effort, Failed.
- File rows: category glyph, name, strategy/quality meta, `original → compressed`, percent, status pill. Reuse `StatusMarker` semantics.
- No day-group headers, no per-session accordion; one batch per screen.

### Filter dropdown

One `DropdownMenu`, anchored to the funnel and offset to the right of the sidebar so it never covers the list. Contents, all in one panel:

- `Sort by`: Newest, Oldest, Most saved, Most files (single-select)
- `Show`: Done, Best effort, Failed, Cancelled, Already under target, Unsupported (multi-select)
- `Category`: Image, Video, PDF, Document (multi-select)
- `Since`: Any time, Last 7 days, Last 30 days (single-select)
- `Clear filters` (only enabled when something is set)

Checks apply immediately; the menu stays open while toggling. The funnel shows a small primary dot when any filter is active. Search lives in the sidebar above the list, not in this menu.

Pagination stays: previous/next controls at the bottom of the sidebar list (`Page N of M`).

### Sort

`HistoryFilters` gains `sort?: string` (`newest` default; `oldest`, `most_saved`, `most_files`). Rust sorts sessions before pagination and falls back to `newest` for unknown values. This is server-side so paging stays coherent.

## 8. Settings dialog

- Width 720, height 540, max 90% viewport; no close chrome except an × in the top-right and `Done`.
- Left rail (184px): General, Targets, Quality floors, Performance, History.
- General: output folder + read-only summary of the four targets.
- Targets: per-category number input + unit select (existing controls).
- Quality floors: image, video, PDF, document (existing controls).
- Performance: simultaneous files select.
- History: retention days.
- Footer: `Reset defaults` on the left, `Done` on the right.

Auto-save: the dialog keeps a local draft, applies changes through `saveSettings` debounced 400 ms, and surfaces failures with a toast. `Reset defaults` calls `resetSettings` and reflects the returned defaults immediately. Closing the dialog flushes a pending save.

`SettingsView.tsx` is deleted. Its card markup is repacked into section components inside `SettingsDialog`; the tests move with it.

## 9. About and menus

`⋯` menu:

- `About Yard` → About dialog
- separator
- `Quit` → new Rust `quit` command (`app.exit(0)`); closing the window via the custom close button uses the same command. `getCurrentWindow().close()` is not enough on macOS, where the app keeps running after its last window closes.

About dialog:

- App glyph, `Yard`, `Offline file compression tool`, `No accounts and no telemetry.`
- `Version X.Y.Z` from `getVersion()`; if the call fails, show `Version unavailable` rather than a hardcoded number.
- License rows: Yard (GPL-3.0), FFmpeg (GPL-2.0-or-later), Ghostscript (AGPL-3.0), libvips (LGPL-3.0), qpdf (Apache-2.0).
- `Third-party notices…` expands a scrollable view containing the bundled `THIRD_PARTY_LICENSES.md` (Vite `?raw` import). No network calls.

`☰` menu (collapsed sidebar only): Compress, History, separator, Settings — same icons as the sidebar, checkmark on the active view.

## 10. Theme

`useTheme`:

- Stored key: `localStorage["yard-theme"]` = `"light" | "dark"`.
- No stored value → follow `matchMedia("(prefers-color-scheme: dark)")` and keep following OS changes.
- Toggle → write an explicit value, stop following the OS.
- Effect toggles `.dark` on `document.documentElement` and calls `getCurrentWindow().setTheme(theme)`, ignoring failure (e.g. test/jsdom).
- `main.tsx` no longer owns the theme listener.

## 11. State ownership

| State | Owner |
|---|---|
| `activeView` (`compress` \| `history`) | `App` |
| sidebar open | `SidebarProvider` (cookie) |
| History expanded in sidebar | `App` (passed to sidebar + provider) |
| selected batch | `HistoryProvider` |
| history filters/sort/page/data | `HistoryProvider` (over `useHistory`) |
| settings dialog open | `App` |
| about dialog open | `App` (opened from `AppMenu`) |
| theme | `useTheme` |
| staged files, run state | `CompressionProvider` (unchanged) |

## 12. IPC and Rust changes

- `HistoryFilters` (Rust + TS) gains `sort`.
- `query_history(fold, filters, page, page_size)` sorts after filtering and before pagination.
- New command `quit` (`app.exit(0)`), registered in `lib.rs`; used by the app menu and the custom close button.
- No new events or plugins.
- Frontend adds `getVersion()` and `getCurrentWindow()` usage.

## 13. Error handling and edge cases

- Settings auto-save failure: keep the draft, toast `Could not save settings: …`, do not close the dialog.
- `getVersion()` failure: show `Version unavailable`.
- Theme `setTheme()` failure: log once, keep the webview theme.
- History load failure: existing error banner in the detail pane; sidebar list shows the same message instead of rows.
- No history: sidebar shows `No batches yet.`; detail pane shows the empty state with a hint to run a batch.
- Selected batch filtered out: fall back to the first row; if none, show the empty state.
- Very long paths/filenames: truncate with ellipsis; never widen the sidebar.
- Collapsed sidebar while a filter menu is open: close the menu.
- Narrow window (760px minimum): top bar keeps toggle, breadcrumb, theme, ⋯; breadcrumb truncates; window controls stay reachable on Windows/Linux.

## 14. Accessibility and keyboard

- The toggle, `☰`, theme, `⋯`, filter, and window controls are real buttons with `aria-label` and tooltips.
- Menus are keyboard-navigable through the shadcn dropdown primitives; checkable items expose their checked state.
- Dialogs trap focus and close on Escape.
- The sidebar toggle keeps ⌘B / Ctrl+B.
- No new global shortcut for settings; the menu is the entry point.

## 15. Testing

Rust:

- `query_history` sorts newest/oldest/most saved/most files; unknown value falls back to newest.
- Sorting happens before pagination and does not change totals.
- Existing history tests continue to pass.

Frontend:

- App shell: two nav entries; no brand, version, or GPL badge; toggle present in both states; `☰` appears only when collapsed and navigates; breadcrumb reflects the view.
- ThemeToggle: OS default, toggle persists, class flips, `setTheme` called.
- AboutDialog: version from `getVersion`, notice content renders, failure shows `Version unavailable`.
- SettingsDialog: sections render; auto-save debounces and calls `save_settings`; reset applies defaults; save failure toasts.
- History: expand/collapse; filter menu toggles statuses/categories/since/sort and refetches; selecting a row shows the detail; clearing filters restores the list.
- Delete `useAutoCollapse` tests; remove call-site mocks.

Gate: `yarn build && yarn test && cd src-tauri && cargo test`.

## 16. Documentation and cleanup

- `docs/ARCHITECTURE.md` §3 and §4: shell components, views (no settings view), state ownership, IPC note for `sort`.
- `docs/FEATURES.md`: rows 1, 3, 11, 12 updated; add a row for this slice.
- `docs/bugs.md`: remove the sidebar auto-collapse item; note the Windows loader diagnostics item is untouched.
- `docs/adr/0007-platform-window-chrome.md`: overlay title bar on macOS, frameless on Windows/Linux, custom drag/double-click, no native menu.
- `GLOSSARY.md`: add “shell”, “top bar”, “batch list”.
- Delete the spec after the slice merges, per the documentation lifecycle.

## 17. Risks

- `transparent: true` on Windows can interact badly with some GPUs/compositors; the fallback is `decorations: false` without transparency (square corners).
- shadcn `dialog` / `dropdown-menu` are new dependencies to vendor; their Base UI variants differ from the Radix API (`render` prop, not `asChild`).
- Keeping dropdowns open while toggling checkbox items depends on the Base UI primitive’s `onSelect` behaviour; verify early and fall back to a Popover with the same layout if needed.
- The history list inside the sidebar reduces list rows visible at 640px height; the list scrolls instead of paginating inside the sidebar.
- `navigator.userAgent` can be spoofed or unusual in a WebView, but only affects cosmetic control placement.
