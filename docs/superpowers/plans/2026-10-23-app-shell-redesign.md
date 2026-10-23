# App shell redesign — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Yard's web-style shell with a native-feeling window chrome, a two-entry sidebar with an expandable history list, a focused batch view, a modern filter dialog, a settings dialog, and About.

**Architecture:** `PlatformProvider` detects the OS through `@tauri-apps/plugin-os` before React mounts. `App` composes `CompressionProvider` → `HistoryProvider` → `SidebarProvider` around a top bar, the sidebar, and one view. All interactive UI uses vendored shadcn components; no primitive library is imported directly and no menu/dialog/focus behavior is hand-rolled.

**Tech Stack:** Tauri 2.12, React 19.3, TypeScript 7, Vite 8, Tailwind 4.3, shadcn/ui (`base-rhea`, Base UI flavour, remixicon), `@tauri-apps/plugin-os`, `react-day-picker` + `date-fns` (via shadcn Calendar), Rust/Serde for the history sort.

**Spec:** `docs/superpowers/specs/2026-10-23-app-shell-redesign-design.md`
**Mocks:** `docs/superpowers/specs/mocks/app-shell/`

## Global Constraints

- shadcn/ui is the only primitive layer. Never import `@base-ui/react` or another primitive library in app code. Compose vendored components; do not reimplement positioning, dismissal, focus, or keyboard behavior.
- Use existing variants and semantic tokens. No raw colors, no `space-x-*`/`space-y-*`, use `size-*`, `truncate`, and `data-icon` for button icons.
- Minimum window: 760×500. Default: 900×640. Sidebar width stays 16rem.
- No router. `activeView` is React state.
- Sidebar collapse is `offcanvas`. Sidebar state is session-only; no new persistence.
- Platform detection only via `@tauri-apps/plugin-os`; values map `macos → darwin`, `windows → win32`, `linux → linux`, anything else → `unknown`.
- macOS window: `titleBarStyle: "Overlay"`, `trafficLightPosition: { x: 16, y: 26 }`, empty title. Windows/Linux: `decorations: false`; no `transparent`.
- Theme: `localStorage["yard-theme"]` = `"light" | "dark"`; absent means follow `prefers-color-scheme`; syncing `setTheme` failures are ignored.
- Settings auto-save debounce: 400 ms, flushed on close.
- Filter dialog commits with Apply/Cancel; Clear all resets only the draft.
- Sort has exactly two values: `newest` (default) and `oldest`.
- Gate: `yarn build && yarn test && cd src-tauri && cargo test`.

## Review Focus

1. **Minimum size (760×500):** the sidebar's Compress/History rows, search, pagination, and Settings must never scroll out of view; only the batch list scrolls. Task 11.
2. **Platform detection failure:** if `platform()` rejects, the app still boots and renders non-macOS chrome. Task 1.
3. **Settings autosave race:** closing with a pending edit flushes exactly once; a failed save keeps the dialog open and toasts. Task 8.
4. **History selection after filters/page changes:** a selected batch that no longer exists falls back to the first row, then to empty — never a stale detail pane. Task 6.
5. **Filter draft semantics:** Cancel discards, Apply commits, Clear all only clears the draft, and a custom date maps to `sinceMs`. Task 10.

---

### Task 1: Platform foundation

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json`, `src/main.tsx`
- Create: `src/lib/platform.ts`, `src/providers/PlatformProvider.tsx`, `src-tauri/tauri.windows.conf.json`, `src-tauri/tauri.linux.conf.json`
- Test: `src/lib/platform.test.ts`, `src/providers/PlatformProvider.test.tsx`

**Interfaces:**
- Produces: `type Platform = "darwin" | "win32" | "linux" | "unknown"`; `detectPlatform(): Promise<Platform>`; `<PlatformProvider platform={Platform}>`; `usePlatform(): Platform`.

- [ ] **Step 1: Write the failing platform tests**

`src/lib/platform.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"
const platformMock = vi.fn()
vi.mock("@tauri-apps/plugin-os", () => ({ platform: platformMock }))
import { detectPlatform } from "./platform"

describe("detectPlatform", () => {
  beforeEach(() => platformMock.mockReset())
  it("maps macOS", async () => {
    platformMock.mockResolvedValue("macos")
    await expect(detectPlatform()).resolves.toBe("darwin")
  })
  it("maps windows and linux", async () => {
    platformMock.mockResolvedValue("windows")
    await expect(detectPlatform()).resolves.toBe("win32")
    platformMock.mockResolvedValue("linux")
    await expect(detectPlatform()).resolves.toBe("linux")
  })
  it("falls back to unknown on rejection", async () => {
    platformMock.mockRejectedValue(new Error("ipc down"))
    await expect(detectPlatform()).resolves.toBe("unknown")
  })
})
```

`src/providers/PlatformProvider.test.tsx`: render a probe that reads `usePlatform()` and assert it returns the supplied value; assert `usePlatform` outside the provider throws.

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/lib/platform.test.ts src/providers/PlatformProvider.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Add the dependencies and native plugin**

```bash
yarn add @tauri-apps/plugin-os@^2.3.1
```

`src-tauri/Cargo.toml`: add `tauri-plugin-os = "2"` under `[dependencies]`.
`src-tauri/src/lib.rs`: register `.plugin(tauri_plugin_os::init())` before `run()`.
`src-tauri/capabilities/default.json`: add `"os:default"`, `"core:window:allow-start-dragging"`, `"core:window:allow-minimize"`, `"core:window:allow-toggle-maximize"`, `"core:window:allow-set-theme"`.

- [ ] **Step 4: Implement detection and the provider**

`src/lib/platform.ts`: `detectPlatform` calls `platform()` from `@tauri-apps/plugin-os`, maps the three known values, and catches rejection to `"unknown"`.
`src/providers/PlatformProvider.tsx`: context + `usePlatform` throwing outside the provider.

- [ ] **Step 5: Window configuration**

Base `src-tauri/tauri.conf.json` window: `"title": ""`, `"titleBarStyle": "Overlay"`, `"trafficLightPosition": { "x": 16, "y": 26 }`. Keep 900×640, min 760×500, resizable.

Create both overlays with the **full** window object (arrays are replaced, not merged):
- `tauri.windows.conf.json`: label `main`, title `""`, 900×640, min 760×500, resizable, `"decorations": false`.
- `tauri.linux.conf.json`: same plus `"decorations": false`.

Do not add `transparent` and keep `dragDropEnabled` at its default.

- [ ] **Step 6: Bootstrap with the detected platform**

`src/main.tsx`: `async function start()` awaits `detectPlatform()`, then renders `PlatformProvider` → `ErrorBoundary` → `App`. Remove the theme listener block (Task 3 takes ownership). Log detection failures once inside `detectPlatform`.

- [ ] **Step 7: Run tests and the build**

Run: `yarn test src/lib/platform.test.ts src/providers/PlatformProvider.test.tsx && yarn build`
Expected: PASS and a clean Vite build.

- [ ] **Step 8: Commit**

```bash
git add package.json yarn.lock src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json src-tauri/tauri.conf.json src-tauri/tauri.windows.conf.json src-tauri/tauri.linux.conf.json src/lib/platform.ts src/lib/platform.test.ts src/providers/PlatformProvider.tsx src/providers/PlatformProvider.test.tsx src/main.tsx
git commit -m "feat(shell): add plugin-os platform detection and window chrome config"
```

---

### Task 2: shadcn primitives and shared CategoryIcon

**Files:**
- Create: `src/components/ui/{dialog,dropdown-menu,popover,toggle,toggle-group,calendar,tabs,collapsible,scroll-area}.tsx`, `src/components/CategoryIcon.tsx`, `src/components/CategoryIcon.test.tsx`
- Modify: `src/components/DropZone.tsx`

**Interfaces:**
- Produces: `<CategoryIcon category={Category} className?: string size?: number />` rendering the same glyphs as staging. Exports are tested by the vendored consumers.

- [ ] **Step 1: Add the shadcn components**

```bash
yarn dlx shadcn@latest add dialog dropdown-menu popover toggle-group calendar tabs collapsible scroll-area --yes
```

Read every generated file. Replace any non-remixicon icon import with the remixicon equivalent. Do not modify behavior; only imports/formatting. `calendar` adds `react-day-picker` and `date-fns`.

- [ ] **Step 2: Write the failing CategoryIcon test**

```tsx
import { render } from "@testing-library/react"
import { CategoryIcon } from "./CategoryIcon"

it.each(["image", "video", "pdf", "document", "other"] as const)(
  "renders one glyph for %s",
  (category) => {
    const { container } = render(<CategoryIcon category={category} />)
    expect(container.querySelectorAll("svg")).toHaveLength(1)
    expect(container.querySelector("svg")?.getAttribute("data-category")).toBe(category)
  }
)
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `yarn test src/components/CategoryIcon.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Extract the glyphs**

Move `CATEGORY_GLYPHS` and the `CategoryIcon` markup out of `DropZone.tsx` into `src/components/CategoryIcon.tsx`. The component sets `data-category={category}` and keeps the 11px default size overridable. `DropZone` imports it; delete its local copy. No glyph path changes.

- [ ] **Step 5: Run tests and the build**

Run: `yarn test src/components/CategoryIcon.test.tsx src/components/DropZone.test.tsx && yarn build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui src/components/CategoryIcon.tsx src/components/CategoryIcon.test.tsx src/components/DropZone.tsx package.json yarn.lock
git commit -m "feat(ui): add shell primitives and shared category icon"
```

---

### Task 3: Theme system and toggle

**Files:**
- Create: `src/hooks/useTheme.ts`, `src/hooks/useTheme.test.ts`, `src/components/shell/ThemeToggle.tsx`, `src/components/shell/ThemeToggle.test.tsx`
- Modify: `src/main.tsx`

**Interfaces:**
- Produces: `useTheme(): { theme: "light" | "dark"; toggleTheme: () => void }`; `<ThemeToggle />` with `aria-label="Toggle theme"` and native `title`.

- [ ] **Step 1: Write failing tests**

Cover:
- no stored key + `matchMedia` dark → `theme` is `"dark"` and `.dark` is on `<html>`;
- clicking the toggle writes `"light"` when starting dark and removes `.dark`;
- `getCurrentWindow().setTheme` is called with the resolved value (mock `@tauri-apps/api/window`);
- a stored `"light"` wins over a dark OS preference.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/hooks/useTheme.test.ts src/components/shell/ThemeToggle.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`useTheme`: read `localStorage["yard-theme"]`; when absent subscribe to `matchMedia`; apply `.dark` in an effect; persist explicit choices; call `setTheme` and swallow errors. `ThemeToggle` is an icon-only shadcn `Button` (`variant="ghost"`, `size="icon-sm"`) using `RiSunLine`/`RiMoonLine`. Remove the theme listener from `main.tsx`.

- [ ] **Step 4: Run tests**

Run: `yarn test src/hooks/useTheme.test.ts src/components/shell/ThemeToggle.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTheme.ts src/hooks/useTheme.test.ts src/components/shell/ThemeToggle.tsx src/components/shell/ThemeToggle.test.tsx src/main.tsx
git commit -m "feat(shell): add persisted theme toggle with native window sync"
```

---

### Task 4: Drag surface and window controls

**Files:**
- Create: `src/components/shell/DragSurface.tsx`, `src/components/shell/DragSurface.test.tsx`, `src/components/shell/WindowControls.tsx`, `src/components/shell/WindowControls.test.tsx`

**Interfaces:**
- Produces: `<DragSurface {...divProps} />`; `<WindowControls />` calling `minimize`, `toggleMaximize`, and `invoke("quit")`.

- [ ] **Step 1: Write failing tests**

DragSurface: left `mousedown` with `detail === 1` calls `startDragging`; `detail === 2` does not; `dblclick` calls `toggleMaximize`; a child button's `onMouseDown` stopPropagation prevents the call.
WindowControls: three buttons with accessible names `Minimize`, `Maximize`, `Close`; each calls the expected API; Close calls `invoke("quit")`; every button stops mousedown propagation.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/components/shell/DragSurface.test.tsx src/components/shell/WindowControls.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`DragSurface` uses `getCurrentWindow()`; spread caller props before its handlers so callers cannot silently disable dragging. `WindowControls` renders `Separator orientation="vertical"` then three shadcn ghost icon buttons (`RiSubtractLine`, `RiWindowLine`, `RiCloseLine`), native `title`, mousedown stopPropagation.

- [ ] **Step 4: Run tests**

Run: `yarn test src/components/shell/DragSurface.test.tsx src/components/shell/WindowControls.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/shell/DragSurface.tsx src/components/shell/DragSurface.test.tsx src/components/shell/WindowControls.tsx src/components/shell/WindowControls.test.tsx
git commit -m "feat(shell): add drag surface and custom window controls"
```

---

### Task 5: History sort in Rust and types

**Files:**
- Modify: `src-tauri/src/history.rs`, `src/types.ts`
- Test: `src-tauri/src/history.rs` (tests module)

**Interfaces:**
- Produces: `HistoryFilters.sort?: "newest" | "oldest"`; `query_history` sorts filtered sessions before pagination; unknown values behave as `newest`.

- [ ] **Step 1: Write the failing Rust tests**

Add tests: `sort_newest_is_default`, `sort_oldest_reverses_started_at`, `sort_unknown_falls_back_to_newest`, `sort_applies_before_pagination` (page 0 of size 1 returns the same session for both sorts only when it is the extreme; totals unchanged).

- [ ] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test history::tests::sort_`
Expected: FAIL — `HistoryFilters` has no `sort` field.

- [ ] **Step 3: Implement**

Add `pub sort: Option<String>` with `#[serde(default)]` to `HistoryFilters`. In `query_history`, after filtering and before `skip/take`, sort sessions ascending or descending by `started_at`; `oldest` → ascending, everything else → descending. Add `sort?: "newest" | "oldest"` to the TS interface.

- [ ] **Step 4: Run tests**

Run: `cd src-tauri && cargo test history::tests::sort_`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/history.rs src/types.ts
git commit -m "feat(history): add newest/oldest sort to the history query"
```

---

### Task 6: History data layer

**Files:**
- Create: `src/providers/HistoryProvider.tsx`, `src/providers/HistoryProvider.test.tsx`
- Modify: `src/lib/historyFormat.ts`, `src/lib/historyFormat.test.ts`

**Interfaces:**
- Produces:
```ts
type HistoryContextValue = {
  response: HistoryResponse | null
  loading: boolean
  error: string | null
  filters: HistoryFilters
  setFilters: (partial: Partial<HistoryFilters>) => void
  page: number
  setPage: (page: number) => void
  searchText: string
  setSearchText: (text: string) => void
  selectedSessionId: string | null
  selectSession: (id: string) => void
  expanded: boolean
  setExpanded: (open: boolean) => void
  refresh: () => void
  clearHistory: () => Promise<void>
  clearError: () => void
}
useHistoryContext(): HistoryContextValue
```
- `historyFormat` adds `batchLabel(ms: number, now: Date): string` (`Today · 2:31 PM`), `savedPercent(original, compressed): number`, and `describeSince(ms: number | undefined, now: Date): string`.

- [ ] **Step 1: Write failing tests**

Provider: with two sessions and no selection, the first is selected after load; selecting the second then filtering it out selects the first; filtering out everything yields `null`. Search updates debounce 300 ms into `filters.search`. Format helpers: `batchLabel` today/yesterday/other; `describeSince` for today, 7 days, 30 days, month start, and a custom date.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/providers/HistoryProvider.test.tsx src/lib/historyFormat.test.ts`
Expected: FAIL — exports missing.

- [ ] **Step 3: Implement**

Provider wraps `useHistory`, owns `selectedSessionId`, `expanded`, and `searchText`, and syncs selection whenever `response.sessions` changes. `setSearchText` debounces into `setFilters({ search: trimmed || undefined })` via a ref, like the old view. Selection fallback: first session, then `null`.

- [ ] **Step 4: Run tests**

Run: `yarn test src/providers/HistoryProvider.test.tsx src/lib/historyFormat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/providers/HistoryProvider.tsx src/providers/HistoryProvider.test.tsx src/lib/historyFormat.ts src/lib/historyFormat.test.ts
git commit -m "feat(history): add history provider and formatting helpers"
```

---

### Task 7: Nav menu, app menu, About

**Files:**
- Create: `src/components/shell/NavMenu.tsx`, `src/components/shell/NavMenu.test.tsx`, `src/components/shell/AppMenu.tsx`, `src/components/shell/AppMenu.test.tsx`, `src/components/AboutDialog.tsx`, `src/components/AboutDialog.test.tsx`

**Interfaces:**
- `NavMenu({ activeView, onNavigate, onOpenSettings })`, trigger `aria-label="Open navigation"`.
- `AppMenu({ onAbout, onQuit })`, trigger `aria-label="App menu"`.
- `AboutDialog({ open, onOpenChange })`.

- [ ] **Step 1: Write failing tests**

NavMenu: `☰` shows Compress, History, separator, Settings; clicking History calls `onNavigate("history")`; the active view has a checkmark.
AppMenu: About calls `onAbout`; Quit calls `onQuit`; exactly one separator.
AboutDialog: shows `Yard`, `Offline file compression tool`, `No accounts and no telemetry.`, `Version 0.1.0` (from package.json), five license rows, and expands the raw notices text.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/components/shell/NavMenu.test.tsx src/components/shell/AppMenu.test.tsx src/components/AboutDialog.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Both menus use `DropdownMenu` + `DropdownMenuTrigger render={<Button …/>}` + `DropdownMenuGroup`; items carry the sidebar glyphs via `data-icon`. `AboutDialog` uses `Dialog`, `DialogTitle`, `DialogHeader` and a `ScrollArea` for `THIRD_PARTY_LICENSES.md?raw`; version comes from `import { version } from "../../package.json"`.

- [ ] **Step 4: Run tests**

Run: `yarn test src/components/shell/NavMenu.test.tsx src/components/shell/AppMenu.test.tsx src/components/AboutDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/shell/NavMenu.tsx src/components/shell/NavMenu.test.tsx src/components/shell/AppMenu.tsx src/components/shell/AppMenu.test.tsx src/components/AboutDialog.tsx src/components/AboutDialog.test.tsx
git commit -m "feat(shell): add navigation menu, app menu, and about dialog"
```

---

### Task 8: Settings dialog

**Files:**
- Create: `src/components/SettingsDialog.tsx`, `src/components/SettingsDialog.test.tsx`
- Modify: `src/hooks/useSettings.ts` only if a flush is needed (do not change the public shape otherwise)

**Interfaces:**
- `SettingsDialog({ open, onOpenChange })`; sections `general | targets | floors | performance | history`; changes call `save_settings` after 400 ms; close flushes.

- [ ] **Step 1: Write failing tests**

Render with mocked `invoke` (`get_settings` returns defaults). Assert: the five `TabsTrigger`s render; changing retention to 30 then advancing 400 ms calls `save_settings` once; closing within 400 ms flushes the save once; a rejected save shows `Could not save settings` and keeps the dialog open; Reset calls `reset_settings` and shows returned defaults.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/components/SettingsDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`Dialog` + `DialogContent` (720×540, `max-h-[90%]`, `p-0`, `overflow-hidden`) + visually hidden `DialogHeader`. Vertical `Tabs` rail; `ScrollArea` body; `FieldSet`/`FieldGroup`/`Field` rows; existing `NumberStepper`, `Select`, `Input`. Repack the five cards from `SettingsView.tsx` into section components inside this file. Debounce with a ref; flush on `onOpenChange(false)`; toast failures.

- [ ] **Step 4: Run tests**

Run: `yarn test src/components/SettingsDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/SettingsDialog.tsx src/components/SettingsDialog.test.tsx src/hooks/useSettings.ts
git commit -m "feat(settings): move settings into an auto-saving dialog"
```

---

### Task 9: New shell (App, TopBar, sidebar frame)

**Files:**
- Create: `src/components/shell/TopBar.tsx`, `src/components/shell/TopBar.test.tsx`, `src/components/shell/SidebarNav.tsx`, `src/components/shell/SidebarNav.test.tsx`
- Delete: `src/components/SidebarNav.tsx`, `src/views/SettingsView.tsx`, `src/views/SettingsView.test.tsx`
- Modify: `src/App.tsx`, `src/App.test.tsx`, `src/views/CompressView.tsx`

**Interfaces:**
- `TopBar({ activeView, onOpenAbout })`; consumes `usePlatform`, `useSidebar`, `useHistoryContext`.
- `SidebarNav({ activeView, onNavigate, onOpenSettings })`; renders Compress, History (expandable trigger placeholder), footer Settings.
- `ViewId = "compress" | "history"`.

- [ ] **Step 1: Write failing shell tests**

Replace `App.test.tsx` assertions: no `Yard` brand in the sidebar, no version/GPL badges; nav has Compress and History; Settings exists only in the footer; toggling collapses the sidebar and shows `☰`; breadcrumb reads Compress/History; macOS shows the toggle in both states; win32 shows window controls and hides the top-bar toggle while the sidebar is open. `SidebarNav.test.tsx`: Settings click calls `onOpenSettings`; History click calls `onNavigate("history")`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/App.test.tsx src/components/shell/SidebarNav.test.tsx`
Expected: FAIL — old shell renders brand/settings nav.

- [ ] **Step 3: Implement the shell**

`App`: `CompressionProvider` → `HistoryProvider` → `SidebarProvider` → `Sidebar collapsible="offcanvas"` + `SidebarInset`. Mount `SettingsDialog` and `AboutDialog`. `activeView` is local state; Settings no longer a view. Remove the `SettingsView` route and its import. `TopBar`: `DragSurface` row, left cluster (toggle rules by platform, `☰` when collapsed, breadcrumb `History › batch` via `batchLabel`), right cluster (`ThemeToggle`, `AppMenu`, `WindowControls` on non-darwin). `SidebarHeader`: empty on macOS; glyph + `SidebarTrigger` on non-darwin. Remove `useAutoCollapse(boardRef)` from `CompressView` only (HistoryView/Settings cleanup comes in Tasks 12/13).

- [ ] **Step 4: Run tests**

Run: `yarn test src/App.test.tsx src/components/shell/SidebarNav.test.tsx src/components/shell/TopBar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/shell/TopBar.tsx src/components/shell/TopBar.test.tsx src/components/shell/SidebarNav.tsx src/components/shell/SidebarNav.test.tsx src/views/CompressView.tsx
git rm src/components/SidebarNav.tsx src/views/SettingsView.tsx src/views/SettingsView.test.tsx
git commit -m "feat(shell): replace the app shell with native-style chrome"
```

---

### Task 10: Filter dialog

**Files:**
- Create: `src/components/history/HistoryFilterDialog.tsx`, `src/components/history/HistoryFilterDialog.test.tsx`

**Interfaces:**
- `HistoryFilterDialog({ open, onOpenChange, applied, onApply })` where `applied: HistoryFilters` and `onApply(filters: HistoryFilters): void`.
- Draft seeded on open; Apply calls `onApply` then closes; Cancel closes; Clear all resets the draft (`{ sort: "newest" }`).

- [ ] **Step 1: Write failing tests**

Assert: two sort segments (`Newest first`, `Oldest first`); toggling Cancelled marks it pressed (multi); toggling Image marks it pressed; choosing `Last 7 days` sets `sinceMs` to start of day six days ago; a custom calendar date sets that day's start; Apply emits the draft; Cancel emits nothing; Clear all resets chips and sort; reopening after Apply seeds the applied values.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/components/history/HistoryFilterDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`Dialog` + title row (`DialogTitle`, active `Badge`, close). Groups with `FieldSet`/`FieldLegend`. Sort/Since use single `ToggleGroup`; Status/Category use `ToggleGroup multiple`. Category chips render `CategoryIcon` with category tones. Since is a `Popover` + `Calendar` (`mode="single"`) with preset buttons; use `date-fns` (`startOfDay`, `subDays`, `startOfMonth`, `subMonths`) and `describeSince` for the trigger label. Footer `Clear all` / `Cancel` / `Apply`.

- [ ] **Step 4: Run tests**

Run: `yarn test src/components/history/HistoryFilterDialog.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/history/HistoryFilterDialog.tsx src/components/history/HistoryFilterDialog.test.tsx
git commit -m "feat(history): add filter dialog with chips and date presets"
```

---

### Task 11: Sidebar history list

**Files:**
- Create: `src/components/history/HistoryList.tsx`, `src/components/history/HistoryList.test.tsx`
- Modify: `src/components/shell/SidebarNav.tsx`, `src/App.tsx`, `src/components/shell/SidebarNav.test.tsx`

**Interfaces:**
- `HistoryList({ onOpenFilter })`; consumes `useHistoryContext`. Renders `SidebarInput` search, `ScrollArea` list, `Button` pagination. History row gets `aria-expanded`, filter `SidebarMenuAction`.
- `App` owns `filterOpen`; mounts `HistoryFilterDialog` with `applied={filters}` and `onApply={setFilters}`.

- [ ] **Step 1: Write failing tests**

Assert: only the list is inside `ScrollArea` (nav/search/pagination/footer are siblings, list wrapper has `min-h-0 flex-1`); rows show label, `N files · X saved`, and percent or `cancelled`; clicking a row calls `selectSession`; search debounce updates `setFilters`; pagination is disabled at bounds; the funnel calls `onOpenFilter`; `aria-expanded` flips with `expanded`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/components/history/HistoryList.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

History row click toggles `expanded` and selects History. List uses `SidebarMenuSub`/`SidebarMenuSubItem`/`SidebarMenuSubButton` with `h-auto py-1.5`; selected row `isActive`. ScrollArea contains only rows. Search uses `SidebarInput`; pagination uses ghost icon `Button`s. Wire `filterOpen` in `App`.

- [ ] **Step 4: Run tests**

Run: `yarn test src/components/history/HistoryList.test.tsx src/components/shell/SidebarNav.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/history/HistoryList.tsx src/components/history/HistoryList.test.tsx src/components/shell/SidebarNav.tsx src/components/shell/SidebarNav.test.tsx src/App.tsx
git commit -m "feat(history): add scrollable sidebar batch list and filter trigger"
```

---

### Task 12: History detail view

**Files:**
- Modify: `src/views/HistoryView.tsx`, `src/views/HistoryView.test.tsx`
- Delete: `src/components/HistoryPagination.tsx` if no longer imported

**Interfaces:**
- `HistoryView()` consumes `useHistoryContext`; renders only the selected batch; no filters, no day groups, no pagination of its own.

- [ ] **Step 1: Write failing tests**

Render inside a mocked provider: selected batch shows label, file count, duration, output folder, and `Reveal folder`; file rows show sizes/percent/status; `null` selection shows the empty state; load error shows the banner; filtered counts show `N / M`.

- [ ] **Step 2: Run to verify failure**

Run: `yarn test src/views/HistoryView.test.tsx`
Expected: FAIL — old view still expects filters/pagination.

- [ ] **Step 3: Implement**

Rewrite the view as a detail pane. Reuse `StatusMarker`, badges, and helpers (`savedLabel`, `fileCountLabel`, `savedPercent`, `formatDuration`, `countOutcome`) from the shared format module. Keep `openSessionFolder`/`revealFile` behavior. Remove `useAutoCollapse`.

- [ ] **Step 4: Run tests**

Run: `yarn test src/views/HistoryView.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/HistoryView.tsx src/views/HistoryView.test.tsx
git rm src/components/HistoryPagination.tsx
git commit -m "feat(history): focus the history view on the selected batch"
```

---

### Task 13: Cleanup, ADR, and full gate

**Files:**
- Delete: `src/hooks/useAutoCollapse.ts`, `src/hooks/useAutoCollapse.test.ts`
- Modify: `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/bugs.md`, `GLOSSARY.md`
- Create: `docs/adr/0007-platform-window-chrome.md`

- [ ] **Step 1: Delete the auto-collapse hook and remaining references**

Remove the hook, its tests, and any remaining imports. `grep -r useAutoCollapse src` must return nothing.

- [ ] **Step 2: Write the ADR**

Record: overlay title bar on macOS, frameless on Windows/Linux with default shadow, plugin-os detection, custom drag/zoom, no native menu, no transparent windows, rejected alternatives.

- [ ] **Step 3: Update the durable docs**

ARCHITECTURE §3–§4 (components, state ownership, no settings view, `sort`, plugin-os); FEATURES rows 1/3/11/12 plus this slice; bugs (remove the auto-collapse item); GLOSSARY (shell, top bar, batch list).

- [ ] **Step 4: Run the full gate**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(shell): remove auto-collapse and document the new chrome"
```

---

## Self-Review Notes

- Spec coverage: platform/window (§4), shell/sidebar (§5–6), history/filter (§7), settings (§8), about/menus (§9), theme (§10), state/IPC (§11–12), errors (§13), a11y (§14), tests (§15), docs (§16) each map to a task.
- Deliberate order: Settings and filter components are built standalone before the shell mounts them, so no task leaves dead state or a half-wired route.
- Types are introduced in the Interfaces block of the task that creates them; later tasks reference those names exactly (`HistoryContextValue`, `Platform`, `ViewId`).
- Every Review Focus line has a test named in its owning task (1 → Task 11, 2 → Task 1, 3 → Task 8, 4 → Task 6, 5 → Task 10).
