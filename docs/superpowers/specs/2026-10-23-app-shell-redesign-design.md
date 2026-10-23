# App shell redesign — design

**Date:** 2026-10-23
**Status:** revised after review; awaiting spec review
**Scope:** window chrome, sidebar, history view, settings dialog, about, theme control

## 1. Intent

Make Yard feel like a native desktop app rather than a web page in a window. The top bar becomes part of the app surface, the sidebar carries only what belongs there, and settings/history stop competing with the main workflow.

Success criteria:

- On macOS the window has no visible OS title bar; traffic lights sit inside the sidebar band (`titleBarStyle: "Overlay"`).
- The content top bar contains the sidebar toggle, the current location, a theme control, and an app menu — nothing else.
- On Windows/Linux the window is frameless with custom minimize/maximize/close on the right, matching the reference app.
- The sidebar has exactly two entries, `Compress` and `History`, plus `Settings` at the bottom. No brand lockup, no version/license badges.
- `History` expands in place to a batch list; selecting a batch fills the main pane. No third column.
- Settings is a dialog with a section rail and auto-save. The full-page Settings view is gone.
- About (version + licenses) moves under the `⋯` menu.
- The app collapses and re-expands deterministically; no content-width heuristics move the sidebar.

## 2. Inputs, references, and evidence

### 2.1 Approved mocks (binding)

| Mock | Covers |
|---|---|
| [`mocks/app-shell/shell.html`](mocks/app-shell/shell.html) | macOS open/collapsed, Windows open/collapsed, ☰ menu, traffic lights, toggle, right controls |
| [`mocks/app-shell/history.html`](mocks/app-shell/history.html) | History as an expandable sidebar section, batch list, focused detail, one filter dropdown |
| [`mocks/app-shell/settings-about.html`](mocks/app-shell/settings-about.html) | Settings dialog (General, Targets), About dialog |
| [`mocks/app-shell/filter-dialog.html`](mocks/app-shell/filter-dialog.html) | Final filter dialog: two sorts, status/category chips, date picker with presets, at 760×500 and 900×640 |

Corrections recorded in `mocks/app-shell/README.md` are part of the design: offcanvas collapse, menu icons, History retention kept, auto-save, About copy, sidebar list, filter dialog with Apply/Cancel, shared category glyphs.

Implementation must match these mocks except where this spec states a correction. If implementation and mock disagree, stop and reconcile before coding.

### 2.2 Reference app (Nakso)

Repo: `/Users/irshadsheikh/dev/github/refs/nakso` (Tauri 2 + React 19 + Tailwind 4 + shadcn/ui; production builds on macOS, Windows, Linux).

| Concern | Nakso reference | Use |
|---|---|---|
| Platform detection | `src/main.tsx` (`detectPlatform`), `src/store/app-store.ts` | Copy the `@tauri-apps/plugin-os` approach and startup ordering |
| Top bar | `src/components/header/app-header.tsx` | Copy layout, traffic-light clearance, window controls, propagation guards |
| Drag / double-click zoom | `src/components/common/tauri-drag-region.tsx` | Copy, but spread caller props before handlers |
| Sidebar | `src/components/sidebar/app-sidebar.tsx`, `src/components/ui/sidebar.tsx` | Copy composition and `offcanvas` default; keep our width |
| Menus | `src/components/menu/menu.tsx`, `src/components/ui/dropdown-menu.tsx` | Copy composition idea; adapt to our preset’s generated API |
| Settings | `src/components/settings/settings-dialog.tsx`, `src/components/ui/dialog.tsx` | Copy dialog shell and auto-save pattern; improve rail semantics with Tabs |
| About | `src/components/dialogs/about-dialog.tsx` | Copy package.json version source and small-dialog layout; add notices |
| Theme toggle | `src/components/header/toggle-darkmode-button.tsx` | Copy button shape and `setTheme` sync |
| Window config | `src-tauri/tauri.conf.json`, `tauri.windows.conf.json`, `tauri.linux.conf.json` | Copy per-platform split |

Rules for reuse:

1. Nakso’s generated components predate ours. Never paste its `src/components/ui/*` files or its data-state classes; use the components generated for Yard’s current preset. Adapt composition only.
2. Nakso writes menus as JSON + a zustand store + a command manager. Yard has no such layer; menu contents are static React children. Do not port the JSON/keymap/zod architecture.
3. Deliberate deviations are listed in §3; everything else follows the reference.

### 2.3 shadcn/ui rule

shadcn/ui is the only UI primitive layer. Every interactive control (menus, popovers, dialogs, tabs, scroll areas, sidebar, buttons, inputs, selects, checks, radios, tooltips, separators) must be a vendored shadcn component. A custom file may only compose and style those primitives; it must not reimplement focus management, dismissal, positioning, or keyboard behavior.

If a needed behavior is missing from shadcn, first question the design. If it is still required, extend the shadcn component with a thin wrapper — never a parallel implementation, and never import a primitive library directly.

Compliance checklist for this slice:

- Items always inside their group: `DropdownMenuItem`/`DropdownMenuLabel` inside `DropdownMenuGroup`; `SelectItem` inside `SelectGroup`.
- Forms use `FieldSet`/`FieldGroup`/`Field`/`FieldLabel`/`FieldDescription`; never raw `div` + label.
- Dialog and Popover titles: `DialogTitle` present (may be `sr-only`).
- Icons inside `Button` use `data-icon`, no sizing classes.
- Status uses `Badge`; empty states use `Empty`; loading uses `Skeleton`; dividers use `Separator`.
- No custom `role="menu"`, no manual focus trap, no manual z-index on overlays.
- No new raw color classes; semantic tokens only.

Known acceptable non-shadcn pieces:

- `NumberStepper` (existing local component; shadcn has no number field).
- `DragSurface` (window-drag behavior, not a UI control).
- Layout containers (`div`s for rows, rails, grids).

### 2.4 Research sources

- shadcn project context: `npx shadcn@latest info` (base-rhea, remixicon, Vite, Tailwind v4).
- shadcn CLI dry-run resolves the shell set (`dialog`, `dropdown-menu`, `popover`, `toggle-group`, `calendar`, `tabs`, `collapsible`, `scroll-area`); `button` is identical and skipped, and `calendar` adds `react-day-picker` + `date-fns`.
- shadcn docs used: `dialog`, `dropdown-menu`, `popover`, `tabs`, `field`, `sidebar`.
- Tauri docs: window `transparent`/`shadow`/`decorations` fields; platform-specific config merge; `setTheme`.
- Persistent state in Tauri apps (Aptabase): localStorage for non-critical UI preferences; `tauri-plugin-store` for backend/critical preferences.
- Nakso source (read-only): listed in §2.2.

## 3. Decisions and deviations from the reference

| Decision | Choice | Why / deviation |
|---|---|---|
| Platform detection | `@tauri-apps/plugin-os` `platform()`, mapped to `darwin`/`win32`/`linux` | Same as Nakso; no user-agent guessing |
| Bootstrap | await platform before `createRoot` | Same as Nakso; platform is always known at first render |
| macOS chrome | `titleBarStyle: "Overlay"`, traffic lights `(16, 26)`, empty title | Same |
| Windows chrome | `decorations: false`, `shadow` left at its default (`true`), no `transparent` | Same frameless result as Nakso; transparency dropped per Tauri docs (see §4.2) |
| Linux chrome | `decorations: false`, same custom controls | Same |
| Sidebar collapse | `collapsible="offcanvas"` | Same as Nakso; matches mocks (fully hidden, no icon rail) |
| Collapse triggers | macOS: top bar only. Windows/Linux: sidebar header when open, top bar when closed | Same as Nakso and the mock |
| Drag | Custom `startDragging()` + `toggleMaximize()` wrapper | Same; keep our `dragDropEnabled: true` (native drop is core) |
| Collapsed navigation | `☰` menu in the top bar, all platforms | Deviation: Nakso has no nav menu; requirement from the brief |
| App menu | `⋯`: About, separator, Quit | Same content as Nakso minus shortcuts/devtools |
| Settings commit | Auto-save, debounced 400ms | Same idea as Nakso’s store-on-change; our settings go through Rust |
| Settings rail | shadcn `Tabs` with `orientation="vertical"` | Deviation: Nakso uses plain divs; shadcn rule wins, and shadcn documents the vertical variant |
| Theme | Binary toggle, `localStorage`, OS default, native `setTheme` | Researched: localStorage is the recommended home for non-critical UI preferences and is the only flash-free option (see §10) |
| About version | `package.json` import | Same as Nakso; no extra Tauri permission |
| Quit | New Rust `quit` command (`app.exit(0)`) | Deviation: Nakso adds `plugin-process`; a 3-line command avoids a plugin |
| History sort | Server-side `sort` param | New; keeps pagination coherent |
| Sidebar auto-collapse | Deleted | Existing bug; deterministic layout is a goal |
| Fullscreen | No code | macOS handles it natively; verified in research |

## 4. Window chrome and platform

### 4.1 Platform detection

Dependencies:

- `@tauri-apps/plugin-os` `^2.3.1` (`package.json`)
- `tauri-plugin-os = "2"` (`src-tauri/Cargo.toml`)
- `.plugin(tauri_plugin_os::init())` in `src-tauri/src/lib.rs`
- `"os:default"` in `src-tauri/capabilities/default.json`

`src/lib/platform.ts`:

```ts
export type Platform = "darwin" | "win32" | "linux" | "unknown"

export async function detectPlatform(): Promise<Platform> {
  const platform = await platformPlugin()
  switch (platform) {
    case "macos": return "darwin"
    case "windows": return "win32"
    case "linux": return "linux"
    default: return "unknown"
  }
}
```

`src/providers/PlatformProvider.tsx` exposes `platform` through context plus `usePlatform()`. Tests can supply a platform without touching the plugin. `unknown` is treated as non-darwin for control placement.

`src/main.tsx`:

```ts
async function start() {
  const platform = await detectPlatform()
  createRoot(rootEl).render(
    <StrictMode>
      <ErrorBoundary>
        <PlatformProvider platform={platform}>
          <App />
        </PlatformProvider>
      </ErrorBoundary>
    </StrictMode>,
  )
}
start()
```

If detection rejects, log once and continue with `"unknown"`; the app must still boot. The delay is one IPC call, not a setup phase, so no loading screen is needed.

### 4.2 Window configuration

`src-tauri/tauri.conf.json` (base / macOS):

```json
"title": "",
"width": 900, "height": 640, "minWidth": 760, "minHeight": 500,
"resizable": true,
"titleBarStyle": "Overlay",
"trafficLightPosition": { "x": 16, "y": 26 }
```

Platform overlays (new, JSON Merge Patch — window arrays are replaced):

- `src-tauri/tauri.windows.conf.json`: `decorations: false`
- `src-tauri/tauri.linux.conf.json`: `decorations: false`

Windows rounded corners come from Tauri’s `shadow` field, which defaults to `true`: the docs state an undecorated Windows window then gets a 1px border and rounded corners on Windows 11. Do **not** set `transparent`: it is only needed for see-through content, requires `macOSPrivateApi` on macOS, and adds composition cost on Windows. The reference app sets it while also painting an opaque background, so it buys nothing there; we deliberately omit it.

Keep `dragDropEnabled` default (`true`); `DropZone` relies on Tauri’s native drop events. Do not copy Nakso’s global `dragover`/`drop`/`contextmenu` suppression.

### 4.3 Capabilities

Add: `os:default`, `core:window:allow-start-dragging`, `core:window:allow-minimize`, `core:window:allow-toggle-maximize`, `core:window:allow-set-theme`. Keep existing `core:default`, `opener:default`, `dialog:default`, `store:default`.

### 4.4 Top bar and window controls

Height 48px. The whole row is a `DragSurface`. Interactive children stop propagation on `mousedown` and `dblclick`.

Left cluster:

- toggle (`RiSidebarFoldLine` when open, `RiSidebarUnfoldLine` when collapsed) calling `toggleSidebar()`. Shown always on macOS; on Windows/Linux only while collapsed, because the sidebar header carries the collapse trigger while open.
- `☰` (`RiMenu2Line`) only while collapsed
- breadcrumb: `Compress` or `History › <batch label>`

Right cluster:

- theme toggle (`RiSunLine` / `RiMoonLine`), native `title`
- `⋯` app menu (`RiMoreLine`), native `title`
- non-darwin: `Separator orientation="vertical"`, then minimize / maximize / close `Button size="icon-sm" variant="ghost"` with native `title` tooltips, each with `onMouseDown` stopPropagation
- close calls the `quit` command, not `window.close()`

macOS traffic-light clearance: when the sidebar is collapsed, add `pl-22` (88px) on macOS only. When the sidebar is open its 16rem width provides the clearance. No clearance on Windows/Linux.

`WindowControls` is rendered only for `platform !== "darwin"`, at the far right after the separator, exactly as in the mock.

### 4.5 Drag surface

Copy Nakso’s `TauriDragRegion` semantics:

```tsx
onMouseDown={(e) => { if (e.buttons === 1 && e.detail !== 2) getCurrentWindow().startDragging() }}
onDoubleClick={() => getCurrentWindow().toggleMaximize()}
```

Spread caller props before these handlers so a caller cannot silently disable dragging. Buttons must stop both events.

### 4.6 Fullscreen

No implementation. macOS hides and restores traffic lights natively; the in-app top bar stays. Windows/Linux keep custom controls.

## 5. Shell layout

```
PlatformProvider
└── CompressionProvider
    └── HistoryProvider
        └── SidebarProvider (h-svh, overflow-hidden)
            ├── Sidebar (collapsible="offcanvas")
            │   ├── SidebarHeader (h-12)
            │   ├── SidebarContent: Compress, History + list
            │   └── SidebarFooter: Settings
            ├── SidebarInset
            │   ├── TopBar (h-12)
            │   └── view container (min-h-0, overflow-hidden): Compress | History
            ├── SettingsDialog
            ├── AboutDialog
            └── Toaster
```

Sidebar open state is owned by `SidebarProvider` (no second store). All toggles call `toggleSidebar()`; ⌘B / Ctrl+B continues to work. State is session-only, like today; the existing cookie remains write-only and is not a source of truth.

### 5.1 shadcn components

Add via the project CLI (no flags; `components.json` drives style, aliases, icons):

```bash
yarn shadcn add dialog dropdown-menu popover toggle-group calendar tabs collapsible scroll-area --yes
```

`calendar` brings `react-day-picker` and `date-fns`; both are required by the shadcn Calendar and are the only new runtime dependencies in this slice.

| Component | Used by |
|---|---|
| `Sidebar*` (existing) | shell, nav rows, sub-list, footer, search input, badges |
| `Button` (existing) | every icon/text action |
| `DropdownMenu*` (add) | ☰ and ⋯ menus |
| `Popover` + `Calendar` (add) | filter dialog’s Date Picker (presets + custom date); `react-day-picker` and `date-fns` come with Calendar |
| `ToggleGroup` (add) | filter dialog chips/segments (single and multiple); pulls `Toggle` |
| `Dialog*` (add) | Settings, About |
| `Tabs*` (add) | Settings rail, vertical |
| `Collapsible` (add) | History list expand/collapse |
| `ScrollArea` (add) | sidebar history list (the only scroller), Settings sections, notices |
| `Field*`, `Input`, `Select`, `Label` (existing) | settings rows and controls |
| `Separator`, `Tooltip`, `Breadcrumb`, `Badge`, `Empty`, `Skeleton` (existing) | chrome details, empty and loading states |
| `AlertDialog` (existing) | clear-history confirmation |

Use the components as generated for Yard’s preset and the shadcn docs for their API. The generated files are the source of truth for available parts and props; never reach below them.

### 5.2 File map

| File | Responsibility |
|---|---|
| `src/lib/platform.ts` | plugin-os detection + `Platform` type |
| `src/providers/PlatformProvider.tsx` | platform context + `usePlatform` |
| `src/hooks/useTheme.ts` | theme state, persistence, `.dark`, native `setTheme` |
| `src/components/shell/TopBar.tsx` | composition |
| `src/components/shell/DragSurface.tsx` | drag/zoom wrapper |
| `src/components/shell/WindowControls.tsx` | non-mac controls |
| `src/components/shell/NavMenu.tsx` | ☰ menu |
| `src/components/shell/AppMenu.tsx` | ⋯ menu |
| `src/components/shell/ThemeToggle.tsx` | theme button |
| `src/components/history/HistoryList.tsx` | sidebar list + search + pagination |
| `src/components/history/HistoryFilterDialog.tsx` | filter dialog: ToggleGroups, Date Picker, Apply/Cancel |
| `src/components/CategoryIcon.tsx` | shared category glyphs + tones, used by DropZone and filter chips |
| `src/components/AboutDialog.tsx` | version + licenses + notices |
| `src/components/SettingsDialog.tsx` | dialog, tabs, sections |
| `src/providers/HistoryProvider.tsx` | data + selection + filters |
| `src/views/HistoryView.tsx` | detail pane |

## 6. Sidebar

Composition uses only `Sidebar*` parts:

```
SidebarHeader (h-12)
  DragSurface
    macOS: empty (traffic lights live here)
    Windows/Linux: app glyph + SidebarTrigger (collapse)
SidebarContent
  SidebarGroup > SidebarMenu
    Compress row  (SidebarMenuButton, badge = staged count)
    History row   (SidebarMenuButton + SidebarMenuAction filter)
    Collapsible > SidebarMenuSub
      SidebarSearch (SidebarInput)
      SidebarMenuSubItem > SidebarMenuSubButton × batches
      pagination (Button ghost, xs/icons)
SidebarFooter
  SidebarMenuButton size="lg": gear + "Settings"
```

History row:

- `SidebarMenuButton` with clock icon, label, and a trailing `RiArrowDownSLine` (decorative, `pointer-events-none`, rotates 180° when expanded).
- Click selects the History view and toggles the expanded list. `aria-expanded` reflects state.
- `SidebarMenuAction` sibling for the filter, `aria-label="Filter history"`, `title="Filter"`, bumped to a 24px hit target. The button already reserves right padding.
- Active view styling via `isActive`; no nested buttons.

Rows:

- `SidebarMenuSub` for the list (indent + left rule).
- `SidebarMenuSubButton` per batch, `render={<button type="button" />}`, `className="h-auto py-1.5 items-start"`, `isActive` on the selected batch.
- Two lines: `Today · 2:31 PM` / `12 files · 48.2 MB saved`; right-aligned percent or `cancelled`.
- Long labels truncate; meta text is single-line.

Scrolling model:

- `SidebarContent` is a flex column: nav rows, search, list, pagination, and Settings never scroll as one block.
- The batch list is the only scroller: shadcn `ScrollArea` with `className="min-h-0 flex-1"` wrapping `SidebarMenuSub`.
- Search and filter stay pinned above the list; pagination and Settings stay pinned below it.
- At 500px window height the nav and footer remain visible; the list scrolls independently (see the approved mock’s first frame).

Search: `SidebarInput` above the list, placeholder `Search history`, debounced 300ms, `aria-label="Search history"`. It preserves the existing search filter (name, path, output path, error).

Pagination: `Button size="icon-xs" variant="ghost"` previous/next plus `Page N of M` text; disabled at bounds.

Empty/error states: `No batches yet.` and the existing error message, both muted, no layout shift.

Removed: brand header, `v1.0.0` / `GPLv3` pills, Settings view entry, `useAutoCollapse` and its tests.

## 7. History

`HistoryProvider` wraps the sidebar list and the detail pane. It owns `useHistory`, selected session id, expanded state, search text, and filter/sort state. Selection defaults to the first session after a load; if it disappears, fall back to the first, then empty.

Detail pane:

- Header: batch label (`Today · 2:31 PM`), meta (`N files · duration · Output: <folder>`), `Button variant="outline"` Reveal folder.
- Stats: Saved, Files (or `N / M` when filtered), Best effort, Failed.
- Files: `Card`-style list using existing row markup; category glyph, name, strategy/quality, `original → compressed`, percent, status `Badge`.
- States: loading skeleton (`Skeleton`), error banner, empty message.
- No day groups, no per-session accordion; one batch per screen.

### Filter dialog

The funnel (`SidebarMenuAction`) opens a shadcn `Dialog` — not a dropdown. Reason: the panel has several independent multi-select controls plus a calendar, and a menu would close after each pick or need custom keep-open behavior. A modal fits at the 760×500 minimum, where a nested menu of submenus does not. Approved mock: `mocks/app-shell/filter-dialog.html`.

Layout:

- `DialogContent` 560–600px wide, `max-h-[90%]`, body scrolls only if a section is added.
- Title row: `DialogTitle` “Filter history”, `Badge` with the active-filter count, close button.
- Groups use `FieldSet` + `FieldLegend`; hairlines between groups; no checkboxes.

Controls, all shadcn:

- **Sort by** — single-select `ToggleGroup` with two items: `Newest first`, `Oldest first`.
- **Status** — multi-select `ToggleGroup` (`multiple`): Done, Best effort, Failed, Cancelled, Already under target, Unsupported. Each chip carries a status dot using the existing status tones.
- **Category** — multi-select `ToggleGroup`: Image, Video, PDF, Document. Each chip uses the shared `CategoryIcon` glyphs and category tones from `src/lib/tokens.ts`, identical to the staging area.
- **Since** — shadcn Date Picker: `Popover` + `Calendar` (`react-day-picker`). Preset column (All time, Today, Last 7 days, Last 30 days, This month, Last 3 months) plus a custom start date. The trigger shows the resolved label; the value maps to the existing `sinceMs` filter.
- Footer: `Button variant="ghost"` Clear all, `Button variant="outline"` Cancel, `Button` Apply.

Commit model:

- The dialog edits a draft copy of the filters. Apply writes the draft to `HistoryProvider` and refetches; Cancel discards; Clear all resets the draft only.
- The funnel shows a primary dot when the applied filters are non-default.
- Opening the dialog seeds the draft from the applied filters.

Category icon reuse: extract `CATEGORY_GLYPHS` and `CategoryIcon` from `DropZone.tsx` into `src/components/CategoryIcon.tsx`; `DropZone` imports it, the filter dialog imports it. No duplicated SVG paths, no icon drift.

Sort: `HistoryFilters` gains `sort?: "newest" | "oldest"`. Rust sorts after filtering and before pagination; unknown values fall back to `newest`.

## 8. Settings dialog

- `Dialog` + `DialogContent` 720×540 (`max-h-[90%]`, `p-0`, `overflow-hidden`); `DialogHeader` visually hidden but present for a11y; default close button kept.
- `Tabs orientation="vertical"`: rail (184px) with General, Targets, Quality floors, Performance, History. Triggers are shadcn `TabsTrigger`; content in `ScrollArea`.
- General: output folder (`Input readOnly` + `Button variant="outline"` Choose…), summary of the four targets.
- Targets: existing number/unit controls. Numbers use `NumberStepper`; units use `Select`.
- Quality floors: image, video, PDF, document fields with `Field` + `NumberStepper` / `Select`.
- Performance: simultaneous files `Select`.
- History: retention days `NumberStepper`.
- Rows use `FieldSet` / `FieldGroup` / `Field` / `FieldLabel` / `FieldDescription`; no hand-rolled form semantics.
- Footer: `Button variant="ghost"` Reset defaults, `Button` Done.

Auto-save: local draft, `saveSettings` debounced 400ms, flush on close. Failures toast via sonner and keep the dialog open. Reset calls `resetSettings` and replaces the draft with the returned defaults. No Save button, no dirty state.

`SettingsView.tsx` is deleted; its tests move to `SettingsDialog`.

## 9. About and menus

`⋯` (`AppMenu`, `DropdownMenu`):

- `DropdownMenuItem` About Yard → opens About
- `DropdownMenuSeparator`
- `DropdownMenuItem` Quit → `invoke("quit")`

About (`AboutDialog`):

- App glyph, `Yard`, `Offline file compression tool`, `No accounts and no telemetry.`
- `Version {version}` from `import { version } from "../../package.json"` (same source as the reference app; `resolveJsonModule` is enabled).
- License rows: Yard GPL-3.0; FFmpeg GPL-2.0-or-later; Ghostscript AGPL-3.0; libvips LGPL-3.0; qpdf Apache-2.0.
- `Button variant="link"` Third-party notices… toggles a `ScrollArea` containing `THIRD_PARTY_LICENSES.md?raw` with `whitespace-pre-wrap font-mono text-xs`. No network.
- Footer: `© 2026 Yard Contributors`.

`☰` (`NavMenu`, collapsed only): Compress, History, separator, Settings. Items use `DropdownMenuItem` with the same Remix icons as the sidebar (`RiContractUpDownLine`, `RiHistoryLine`, `RiSettings3Line`); the active view gets `RiCheckLine` in `DropdownMenuShortcut`.

## 10. Theme

`useTheme`:

- `localStorage["yard-theme"]` = `"light" | "dark"`.
- No stored value → follow `matchMedia("(prefers-color-scheme: dark)")`, including changes.
- Toggle writes an explicit value and stops following the OS.
- Effect toggles `.dark` on `document.documentElement` and calls `getCurrentWindow().setTheme(theme)`, ignoring failure.
- `main.tsx` no longer owns the theme listener.

Why localStorage rather than `plugin-store` / Rust settings:

- Theme is a non-critical UI preference. The Tauri-focused guidance (Aptabase, “Persistent state in Tauri apps”) recommends localStorage for exactly this category and `tauri-plugin-store` for backend or critical preferences (keys, licenses) that Rust must read. Our settings that affect compression already live in Rust; theme does not belong there.
- localStorage is synchronous, so the `.dark` class can be applied before the first React render. The store plugin is async over IPC and would need another bootstrap await or accept a light flash.
- It is the common pattern in Tauri/Vite React apps and the one shadcn’s own dark-mode guidance implies (a small provider reading a stored preference).
- Caveat recorded: webview storage is per-origin; Tauri’s v1→v2 Windows scheme change reset it once. That is a migration event, not normal operation, and the value is trivially recoverable (falls back to OS preference).

Moving theme into Rust settings later is a one-file change (`useTheme` + a settings field); no UI changes.

## 11. State ownership

| State | Owner |
|---|---|
| `activeView` (`compress` \| `history`) | `App` |
| sidebar open | `SidebarProvider` (`useSidebar`), session-only |
| History expanded in sidebar | `HistoryProvider` |
| selected batch | `HistoryProvider` |
| history filters/sort/page/data | `HistoryProvider` over `useHistory` |
| settings dialog open | `App` |
| about dialog open | `App` (opened from `AppMenu`) |
| platform | `PlatformProvider` |
| theme | `useTheme` |
| staged files, run state | `CompressionProvider` (unchanged) |

## 12. IPC and Rust changes

- `HistoryFilters` (Rust + TS) gains `sort` (`newest` default, `oldest`); `query_history` sorts before pagination.
- New command `quit` (`app.exit(0)`), registered in `lib.rs`; used by the app menu and the custom close button.
- No new events.
- Plugins: add `tauri-plugin-os` only.
- Frontend adds `plugin-os` and `getCurrentWindow()` usage.

## 13. Error handling and edge cases

- Platform detection failure: `unknown`, treated as non-darwin; log once.
- Settings auto-save failure: keep draft, toast, dialog stays open.
- Theme `setTheme` failure: log once, webview theme still applies.
- History load failure: error message in the list area and detail pane; filters remain usable.
- No history: `No batches yet.`; detail shows an empty state.
- Selected batch filtered out: fall back to first, then empty.
- Filter menu open while sidebar collapses: close the menu.
- Very long paths/labels: truncate, never widen the sidebar.
- Narrow window (760px): breadcrumb truncates; toggle, theme, ⋯ and window controls stay visible.
- Closing the window on macOS: `quit` command, not window close.

## 14. Accessibility and keyboard

- Every icon button has `aria-label` plus native `title` (Windows users see native tooltips).
- History row exposes `aria-expanded` and `aria-controls`; the list has `role="group"`.
- Batch rows are buttons and support Tab/Enter.
- Menus, popovers, tabs, dialogs, and scroll areas inherit the shadcn primitives’ keyboard behavior; do not override it.
- ⌘B / Ctrl+B toggles the sidebar.
- Settings dialog traps focus, closes on Escape/backdrop, and restores focus to the sidebar trigger when possible.

## 15. Testing

Rust:

- `query_history` sorts newest/oldest/most saved/most files; unknown falls back to newest.
- Sorting precedes pagination; totals unchanged.
- Existing history tests pass.

Frontend:

- Platform provider: explicit platform drives macOS vs Windows chrome; plugin failure yields `unknown` with non-darwin controls.
- App shell: two nav entries, no brand/version/license badges, toggle in both states, ☰ only collapsed, breadcrumb updates, window controls only non-darwin.
- Top bar drag surface: startDragging called on mousedown, not on the second click of a double-click; buttons do not trigger drag.
- Theme: OS default, toggle persists, class flips, `setTheme` called.
- About: version renders from package.json, notices render, dialog opens from ⋯.
- Settings: tabs switch sections; auto-save debounces and calls `save_settings`; reset applies defaults; failure toasts.
- History: expand/collapse; search debounce; filter dialog draft/Apply/Cancel/Clear all; two sort options; status/category chip selection; date presets and a custom date; selecting a row shows detail; empty/error states; pagination.
- CategoryIcon: staging area and filter dialog render identical glyphs/tones.
- Delete `useAutoCollapse` tests and call-site mocks; delete `SettingsView` tests after migrating.

Gate: `yarn build && yarn test && cd src-tauri && cargo test`.

## 16. Documentation and cleanup

- `docs/ARCHITECTURE.md` §3–§4: shell components, views (no settings view), state table, IPC `sort` note, plugin-os.
- `docs/FEATURES.md`: update rows 1, 3, 11, 12; add a row for this slice.
- `docs/bugs.md`: remove the sidebar auto-collapse item.
- `docs/adr/0007-platform-window-chrome.md`: overlay on macOS, frameless on Windows/Linux, custom drag, plugin-os, no native menu.
- `GLOSSARY.md`: add “shell”, “top bar”, “batch list”.
- Keep `docs/superpowers/specs/mocks/app-shell/` until the slice merges, then delete with the spec.

## 17. Risks

- Sidebar batch rows are denser than the mock’s 56px rows at 640px height; the list scrolls, so verify at least 5 rows remain visible.
- Removing `useAutoCollapse` changes Compress/History sizing behavior; the boards must remain usable at 760px with the sidebar open (horizontal scroll is acceptable).
- plugin-os adds a native dependency; the bootstrap now awaits one IPC call before first paint.
- The filter dialog is more modal than the earlier popover mock; verify chip density and calendar fit at 760×500 (calendar popover must escape the dialog bounds without clipping).
- `Calendar` adds `react-day-picker` + `date-fns`; keep their versions pinned with the rest of the lockfile.
- `Tabs` vertical orientation is documented by shadcn but must be checked in the generated component; if it is missing, fall back to a horizontal `TabsList` with a left rail layout driven by `TabsTrigger` buttons, not a new component.
- The About dialog imports `THIRD_PARTY_LICENSES.md?raw`; confirm the bundler includes it in the production build and bump the notices file when engines change.
