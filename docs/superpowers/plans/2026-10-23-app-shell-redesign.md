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
- Minimum window: 760×500. Default: 900×640. Sidebar width is stock: 16rem desktop, 18rem in the mobile Sheet.
- No router. `activeView` is React state.
- Sidebar is stock shadcn: `offcanvas` on desktop, the vendored `Sheet` below 768px. Never modify `src/components/ui/sidebar.tsx`. Every "sidebar showing" check uses `isMobile ? openMobile : open`. State is session-only; no new persistence.
- Theme is applied in `main.tsx` before `createRoot` and before the platform read; `useTheme` seeds from the applied class and never re-applies it on mount.
- One quit path: `onCloseRequested` → `preventDefault` → confirm when `isCompressing` → `quit`. `WindowControls` Close calls `getCurrentWindow().close()`.
- `src-tauri/tauri.windows.conf.json` is modified, never replaced — it already carries bundle engine config. No Linux overlay in this slice.
- Platform detection only via `@tauri-apps/plugin-os`; `platform()` is synchronous (compile-time injected); values map `macos → darwin`, `windows → win32`, `linux → linux`, anything else → `unknown`.
- macOS window: `titleBarStyle: "Overlay"`, `trafficLightPosition: { x: 16, y: 26 }`, empty title. Windows: `decorations: false`; no `transparent`. Linux: deferred, no config.
- Theme: `localStorage["yard-theme"]` = `"light" | "dark"`; absent means follow `prefers-color-scheme`; syncing `setTheme` failures are ignored.
- Settings auto-save debounce: 400 ms, flushed on close.
- Filter dialog commits with Apply/Cancel; Clear all resets only the draft.
- Sort has exactly two values: `newest` (default) and `oldest`.
- Gate: `yarn build && yarn test && cd src-tauri && cargo test`.

## Review Focus

1. **Minimum size (760×500):** the batch list is the only scroller; nav, search, pagination and Settings stay pinned. At 760 the sidebar is the stock Sheet, not the desktop rail. Task 11.
2. **Platform detection failure:** if the injected internals are missing (bare-browser dev), the app boots with `unknown` and renders non-macOS chrome. Task 1.
3. **Settings autosave race:** closing with a pending edit flushes exactly once; a failed save keeps the dialog open and toasts — which requires the close to await the flush. Task 8.
4. **History selection after filters/page changes:** a selected batch that no longer exists falls back to the first row, then to empty — never a stale detail pane. Task 6.
5. **Filter draft semantics:** Cancel discards, Apply commits, Clear all only clears the draft, and a custom date maps to `sinceMs`. Task 10.
6. **Quit while busy:** close is always intercepted; confirm-cancel leaves the window open; confirm or idle quits exactly once. Task 4.

---

### Task 1: Platform foundation

**Files:**
- Modify: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/src/lib.rs`, `src-tauri/src/commands.rs`, `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.windows.conf.json`, `src/main.tsx`
- Create: `src/lib/platform.ts`, `src/providers/PlatformProvider.tsx`, `src/lib/test-tauri.ts`
- Test: `src/lib/platform.test.ts`, `src/providers/PlatformProvider.test.tsx`

**Interfaces:**
- Produces: `type Platform = "darwin" | "win32" | "linux" | "unknown"`; `detectPlatform(): Platform` (synchronous); `<PlatformProvider platform={Platform}>`; `usePlatform(): Platform`; JS-invokable `quit` command.

- [x] **Step 1: Write the failing platform tests**

`src/lib/platform.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest"
const platformMock = vi.fn()
vi.mock("@tauri-apps/plugin-os", () => ({ platform: platformMock }))
import { detectPlatform } from "./platform"

describe("detectPlatform", () => {
  beforeEach(() => platformMock.mockReset())
  it("maps macOS", () => {
    platformMock.mockReturnValue("macos")
    expect(detectPlatform()).toBe("darwin")
  })
  it("maps windows and linux", () => {
    platformMock.mockReturnValue("windows")
    expect(detectPlatform()).toBe("win32")
    platformMock.mockReturnValue("linux")
    expect(detectPlatform()).toBe("linux")
  })
  it("falls back to unknown when the injected internals are missing", () => {
    platformMock.mockImplementation(() => {
      throw new Error("__TAURI_OS_PLUGIN_INTERNALS__ is undefined")
    })
    expect(detectPlatform()).toBe("unknown")
  })
})
```

`src/providers/PlatformProvider.test.tsx`: render a probe that reads `usePlatform()` and assert it returns the supplied value; assert `usePlatform` outside the provider throws.

- [x] **Step 2: Run tests to verify they fail**

Run: `yarn test src/lib/platform.test.ts src/providers/PlatformProvider.test.tsx`
Expected: FAIL — modules not found.

- [x] **Step 3: Add the dependencies and native plugin**

```bash
yarn add @tauri-apps/plugin-os@^2.4.0
```

`src-tauri/Cargo.toml`: add `tauri-plugin-os = "2"` under `[dependencies]`.
`src-tauri/src/lib.rs`: register `.plugin(tauri_plugin_os::init())` before `run()`. Add `pub fn quit(app: tauri::AppHandle) { app.exit(0) }` to `commands.rs`, mark it `#[tauri::command]`, and include `commands::quit` in the `generate_handler!` list.
`src-tauri/capabilities/default.json`: add `"os:default"`, `"core:window:allow-start-dragging"`, `"core:window:allow-minimize"`, `"core:window:allow-toggle-maximize"`, `"core:window:allow-set-theme"`, `"core:window:allow-close"`, `"window-state:default"`.

`src-tauri/Cargo.toml`: add `tauri-plugin-window-state = "2"` and `tauri-plugin-single-instance = "2"`. Register single-instance **first**, then window-state: `.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| { if let Some(w) = app.get_webview_window("main") { let _ = w.set_focus(); } }))` then `.plugin(tauri_plugin_window_state::Builder::new().build())`.

`src/lib/test-tauri.ts`: one helper exporting `mockWindow()` (`getCurrentWindow` with `startDragging`, `minimize`, `toggleMaximize`, `close`, `setTheme`, `onCloseRequested`) and `mockPlatform(value)`; every new test file uses it instead of hand-rolling Tauri mocks.

- [x] **Step 4: Implement detection and the provider**

`src/lib/platform.ts`: `detectPlatform` calls `platform()` from `@tauri-apps/plugin-os` (synchronous — compile-time injected via `window.__TAURI_OS_PLUGIN_INTERNALS__`, no IPC), maps the three known values, and wraps the call in try/catch so a missing global logs once and returns `"unknown"`.
`src/providers/PlatformProvider.tsx`: context + `usePlatform` throwing outside the provider.

- [x] **Step 5: Window configuration**

Base `src-tauri/tauri.conf.json` window: `"title": ""`, `"titleBarStyle": "Overlay"`, `"trafficLightPosition": { "x": 16, "y": 26 }`. Keep 900×640, min 760×500, resizable, `"center": true` (window-state overrides on later launches).

Edit `tauri.windows.conf.json` in place with the **full** window object (arrays are replaced, not merged): keep the existing `bundle` object byte-for-byte and add `"app": { "windows": [{ label: main, title: "", 900×640, min 760×500, resizable, decorations: false }] }`. Do not create a Linux overlay.

Do not add `transparent` and keep `dragDropEnabled` at its default.

- [x] **Step 6: Bootstrap with the detected platform**

`src/main.tsx`: call `detectPlatform()` synchronously (no `async start()`, no await — the platform value and the pre-paint theme need nothing async), then render `PlatformProvider` → `ErrorBoundary` → `App`. Remove the theme listener block (Task 3 takes ownership). Log detection failures once inside `detectPlatform`.

- [x] **Step 7: Run tests and the build**

Run: `yarn test src/lib/platform.test.ts src/providers/PlatformProvider.test.tsx && yarn build`
Expected: PASS and a clean Vite build.

- [x] **Step 8: Commit**

```bash
git add package.json yarn.lock src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/capabilities/default.json src-tauri/tauri.conf.json src-tauri/tauri.windows.conf.json src/lib/platform.ts src/lib/platform.test.ts src/lib/test-tauri.ts src/providers/PlatformProvider.tsx src/providers/PlatformProvider.test.tsx src/main.tsx
git commit -m "feat(shell): add plugin-os platform detection and window chrome config"
```

---

### Task 2: shadcn primitives and shared CategoryIcon

**Files:**
- Create: `src/components/ui/{dialog,dropdown-menu,popover,toggle,toggle-group,calendar,tabs,collapsible,scroll-area}.tsx`, `src/components/CategoryIcon.tsx`, `src/components/CategoryIcon.test.tsx`
- Modify: `src/components/DropZone.tsx`

**Interfaces:**
- Produces: `<CategoryIcon category={Category} className?: string size?: number />` rendering the same glyphs as staging. Exports are tested by the vendored consumers.

- [x] **Step 1: Add the shadcn components**

```bash
yarn shadcn add dialog dropdown-menu popover toggle-group calendar tabs collapsible scroll-area --yes
```

Read every generated file. Replace any non-remixicon icon import with the remixicon equivalent. Do not modify behavior; only imports/formatting. `calendar` adds `react-day-picker` and `date-fns`.

- [x] **Step 2: Write the failing CategoryIcon test**

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

- [x] **Step 3: Run the test to verify it fails**

Run: `yarn test src/components/CategoryIcon.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 4: Extract the glyphs**

Move `CATEGORY_GLYPHS` and the `CategoryIcon` markup out of `DropZone.tsx` into `src/components/CategoryIcon.tsx`. The component sets `data-category={category}` and keeps the 11px default size overridable. `DropZone` imports it; delete its local copy. No glyph path changes.

- [x] **Step 5: Run tests and the build**

Run: `yarn test src/components/CategoryIcon.test.tsx src/components/DropZone.test.tsx && yarn build`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/components/ui src/components/CategoryIcon.tsx src/components/CategoryIcon.test.tsx src/components/DropZone.tsx package.json yarn.lock
git commit -m "feat(ui): add shell primitives and shared category icon"
```

---

### Task 3: Theme system and toggle

**Files:**
- Create: `src/lib/theme.ts`, `src/lib/theme.test.ts`, `src/hooks/useTheme.ts`, `src/hooks/useTheme.test.ts`, `src/components/shell/ThemeToggle.tsx`, `src/components/shell/ThemeToggle.test.tsx`
- Modify: `src/main.tsx`

**Interfaces:**
- Produces: `useTheme(): { theme: "light" | "dark"; toggleTheme: () => void }`; `<ThemeToggle />` with `aria-label="Toggle theme"` and native `title`.

- [x] **Step 1: Write failing tests**

Cover:
- `readInitialTheme()`: stored value wins; absent follows `matchMedia`; `useTheme` seeds from the class `main.tsx` already applied;
- clicking the toggle writes `"light"` when starting dark and removes `.dark`;
- `getCurrentWindow().setTheme` is called with the resolved value (mock `@tauri-apps/api/window`);
- a stored `"light"` wins over a dark OS preference.

- [x] **Step 2: Run to verify failure**

Run: `yarn test src/hooks/useTheme.test.ts src/components/shell/ThemeToggle.test.tsx`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement**

Create `src/lib/theme.ts` with `readInitialTheme()`. `main.tsx` applies `.dark` from it as its first statement, **before** `createRoot` and before the `detectPlatform()` await. `useTheme` seeds from `readInitialTheme()`, does not re-apply on mount, subscribes to `matchMedia` only while no stored value exists, persists explicit choices, and calls `setTheme` once after bootstrap (failures swallowed). `ThemeToggle` is an icon-only shadcn `Button` (`variant="ghost"`, `size="icon-sm"`) using `RiSunLine`/`RiMoonLine`. Remove the theme listener from `main.tsx`.

- [x] **Step 4: Run tests**

Run: `yarn test src/hooks/useTheme.test.ts src/components/shell/ThemeToggle.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/lib/theme.ts src/lib/theme.test.ts src/hooks/useTheme.ts src/hooks/useTheme.test.ts src/components/shell/ThemeToggle.tsx src/components/shell/ThemeToggle.test.tsx src/main.tsx
git commit -m "feat(shell): add persisted theme toggle with native window sync"
```

---

### Task 4: Drag surface, window controls, and quit guard

**Files:**
- Create: `src/components/shell/DragSurface.tsx`, `src/components/shell/DragSurface.test.tsx`, `src/components/shell/WindowControls.tsx`, `src/components/shell/WindowControls.test.tsx`, `src/components/shell/QuitGuard.tsx`, `src/components/shell/QuitGuard.test.tsx`

**Interfaces:**
- Produces: `<DragSurface {...divProps} />`; `<WindowControls />` calling `minimize`, `toggleMaximize`, and `invoke("quit")`.

- [x] **Step 1: Write failing tests**

DragSurface: left `mousedown` with `detail === 1` calls `startDragging`; `detail === 2` does not; `dblclick` calls `toggleMaximize`; a child button's `onMouseDown` stopPropagation prevents the call.
WindowControls: three buttons with accessible names `Minimize`, `Maximize`, `Close`; each calls the expected API; Close calls `getCurrentWindow().close()`; every button stops mousedown propagation.
QuitGuard: `preventDefault` always; `confirm` false → no `quit`; `confirm` true → exactly one `quit`; idle → one `quit`.

- [x] **Step 2: Run to verify failure**

Run: `yarn test src/components/shell/DragSurface.test.tsx src/components/shell/WindowControls.test.tsx src/components/shell/QuitGuard.test.tsx`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement**

`DragSurface` uses `getCurrentWindow()`; spread caller props before its handlers so callers cannot silently disable dragging. `WindowControls` renders `Separator orientation="vertical"` then three shadcn ghost icon buttons (`RiSubtractLine`, `RiWindowLine`, `RiCloseLine`), native `title`, mousedown stopPropagation. Close calls `getCurrentWindow().close()`, never `invoke("quit")` directly.

`QuitGuard` (mounted once in `App`) registers `getCurrentWindow().onCloseRequested`: always `event.preventDefault()`, then `if (isCompressing && !(await confirm(...)))` return, else `await invoke("quit")`. Tests: preventDefault always; confirm false → no quit; confirm true → one quit; idle → one quit. Note in a comment: `shortcut: ⌘Q bypasses onCloseRequested and exits directly, acceptable for a deliberate OS quit`.

- [x] **Step 4: Run tests**

Run: `yarn test src/components/shell/DragSurface.test.tsx src/components/shell/WindowControls.test.tsx src/components/shell/QuitGuard.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/components/shell/DragSurface.tsx src/components/shell/DragSurface.test.tsx src/components/shell/WindowControls.tsx src/components/shell/WindowControls.test.tsx src/components/shell/QuitGuard.tsx src/components/shell/QuitGuard.test.tsx
git commit -m "feat(shell): add drag surface, window controls, and quit guard"
```

---

### Task 5: History sort in Rust and types

**Files:**
- Modify: `src-tauri/src/history.rs`, `src/types.ts`
- Test: `src-tauri/src/history.rs` (tests module)

**Interfaces:**
- Produces: `HistoryFilters.sort?: "newest" | "oldest"`; `query_history` sorts filtered sessions before pagination; unknown values behave as `newest`.

- [x] **Step 1: Write the failing Rust tests**

Add tests: `sort_newest_is_default`, `sort_oldest_reverses_started_at`, `sort_unknown_falls_back_to_newest`, `sort_applies_before_pagination` (page 0 of size 1 returns the same session for both sorts only when it is the extreme; totals unchanged).

- [x] **Step 2: Run to verify failure**

Run: `cd src-tauri && cargo test history::tests::sort_`
Expected: FAIL — `HistoryFilters` has no `sort` field.

- [x] **Step 3: Implement**

Add `pub sort: Option<String>` to `HistoryFilters` (`deny_unknown_fields` is on, so this must land before any TS caller sends `sort`; `Option` defaults to `None`, no `#[serde(default)]` needed). In `query_history`, after filtering and before `skip/take`, sort sessions by `started_at`; `oldest` → ascending, absent/unknown/`null` → descending. Add `sort?: "newest" | "oldest"` to the TS interface.

- [x] **Step 4: Run tests**

Run: `cd src-tauri && cargo test history::tests::sort_`
Expected: PASS.

- [x] **Step 5: Commit**

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
- `historyFormat` adds `batchLabel(ms: number, now: Date): string` (`Today · 2:31 PM`), `savedPercent(original, compressed): number`, and `describeSince(ms: number | undefined, now: Date): string`, and absorbs `savedLabel`, `fileCountLabel`, `countOutcome` from `HistoryView.tsx:196-268` (single source; Task 12 deletes the local copies).

- [x] **Step 1: Write failing tests**

Provider: with two sessions and no selection, the first is selected after load; selecting the second then filtering it out selects the first; filtering out everything yields `null`. Search updates debounce 300 ms into `filters.search`. Format helpers: `batchLabel` today/yesterday/other; `describeSince` for today, 7 days, 30 days, month start, and a custom date.

- [x] **Step 2: Run to verify failure**

Run: `yarn test src/providers/HistoryProvider.test.tsx src/lib/historyFormat.test.ts`
Expected: FAIL — exports missing.

- [x] **Step 3: Implement**

Provider wraps `useHistory`, owns `selectedSessionId`, `expanded`, and `searchText`, and syncs selection whenever `response.sessions` changes. It mounts at app level, so `get_history` runs once at boot and once per `batch:complete` (async IPC, off the UI thread; no per-file fetch). Record in `docs/bugs.md`: cache the fold in `HistoryStore` keyed by `(mtime, len)` if history grows past ~10k records. `setSearchText` debounces into `setFilters({ search: trimmed || undefined })` via a ref, like the old view. Selection fallback: first session, then `null`.

- [x] **Step 4: Run tests**

Run: `yarn test src/providers/HistoryProvider.test.tsx src/lib/historyFormat.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/providers/HistoryProvider.tsx src/providers/HistoryProvider.test.tsx src/lib/historyFormat.ts src/lib/historyFormat.test.ts
git commit -m "feat(history): add history provider and formatting helpers"
```

---

### Task 7: Nav menu, app menu, About, native menu

**Files:**
- Create: `src/components/shell/NavMenu.tsx`, `src/components/shell/NavMenu.test.tsx`, `src/components/shell/AppMenu.tsx`, `src/components/shell/AppMenu.test.tsx`, `src/components/AboutDialog.tsx`, `src/components/AboutDialog.test.tsx`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- `NavMenu({ activeView, onNavigate, onOpenSettings })`, trigger `aria-label="Open navigation"`.
- `AppMenu({ onAbout, onQuit })`, trigger `aria-label="App menu"`.
- `AboutDialog({ open, onOpenChange })`.

- [x] **Step 1: Write failing tests**

NavMenu: `☰` shows Compress, History, separator, Settings; clicking History calls `onNavigate("history")`; the active view has a checkmark.
AppMenu: About calls `onAbout`; Quit calls `onQuit`; exactly one separator.
AboutDialog: shows `Yard`, `Offline file compression tool`, `No accounts and no telemetry.`, `Version 0.1.0` (from package.json), five license rows, and expands the raw notices text.

- [x] **Step 2: Run to verify failure**

Run: `yarn test src/components/shell/NavMenu.test.tsx src/components/shell/AppMenu.test.tsx src/components/AboutDialog.test.tsx`
Expected: FAIL — modules not found.

- [x] **Step 3: Implement**

Both menus use `DropdownMenu` + `DropdownMenuTrigger render={<Button …/>}` + `DropdownMenuGroup`; items carry the sidebar glyphs via `data-icon`. `AboutDialog` uses `Dialog`, `DialogTitle`, `DialogHeader` and a `ScrollArea` for `THIRD_PARTY_LICENSES.md?raw`; version comes from `import { version } from "../../package.json"`. `AppMenu`'s Quit item executes `onQuit`; the wiring (Task 9) connects it to `getCurrentWindow().close()` — never `invoke("quit")` — so the click crosses QuitGuard.

Native macOS menu (`src-tauri/src/lib.rs`, `#[cfg(target_os = "macos")]` in `setup`): build a `MenuBuilder` with three `SubmenuBuilder`s — app (`hide`, `hide_others`, separator, `quit`), `Edit` (`undo`, `redo`, separator, `cut`, `copy`, `paste`, `select_all`), `Window` (`minimize`, `maximize`, separator, `close_window`) — and `app.set_menu(menu)?`. **No About item**, so the only About is the dialog. Windows/Linux get no menu bar. This is the app's only native code in this task; `cargo test` must stay green.

- [x] **Step 4: Run tests**

Run: `yarn test src/components/shell/NavMenu.test.tsx src/components/shell/AppMenu.test.tsx src/components/AboutDialog.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/components/shell/NavMenu.tsx src/components/shell/NavMenu.test.tsx src/components/shell/AppMenu.tsx src/components/shell/AppMenu.test.tsx src/components/AboutDialog.tsx src/components/AboutDialog.test.tsx src-tauri/src/lib.rs
git commit -m "feat(shell): add menus, about dialog, and a native macOS menu without About"
```

---

### Task 8: Settings dialog

**Files:**
- Create: `src/components/SettingsDialog.tsx`, `src/components/SettingsDialog.test.tsx`
- Modify: `src/hooks/useSettings.ts`, `src/hooks/useSettings.test.ts`: `saveSettings` returns `Promise<boolean>` (false on failure) and a repeated identical failure must still notify (bump a counter or rethrow). The existing test file pins the old `Promise<void>`/error-state contract — update it in this task. The dialog awaits the flush before it accepts a close.

**Interfaces:**
- `SettingsDialog({ open, onOpenChange })`; sections `general | targets | floors | performance | history`; changes call `save_settings` after 400 ms; a close request awaits the flush and only then commits.

- [x] **Step 1: Write failing tests**

Render with mocked `invoke` (`get_settings` returns defaults). Assert: the five `TabsTrigger`s render; changing retention to 30 then advancing 400 ms calls `save_settings` once; closing within 400 ms flushes the save once; a rejected save shows `Could not save settings` and keeps the dialog open; Reset calls `reset_settings` and shows returned defaults. Update `src/hooks/useSettings.test.ts` for the new contract (boolean return, repeated-failure notification still fires).

- [x] **Step 2: Run to verify failure**

Run: `yarn test src/components/SettingsDialog.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

`Dialog` + `DialogContent` (720×540, `max-h-[90%]`, `p-0`, `overflow-hidden`) + visually hidden `DialogHeader`. Vertical `Tabs` rail; `ScrollArea` body; `FieldSet`/`FieldGroup`/`Field` rows; existing `NumberStepper`, `Select`, `Input`. Repack the five cards from `SettingsView.tsx` into section components inside this file. Debounce with a ref. On a close request: `await flush()`; if `saveSettings` returned false, keep the dialog open and toast (`Could not save settings`); otherwise let the owner close. Reset replaces the draft and handles a `null` return.

- [x] **Step 4: Run tests**

Run: `yarn test src/components/SettingsDialog.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/components/SettingsDialog.tsx src/components/SettingsDialog.test.tsx src/hooks/useSettings.ts src/hooks/useSettings.test.ts
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

- [x] **Step 1: Write failing shell tests**

Replace `App.test.tsx` assertions: no `Yard` brand in the sidebar, no version/GPL badges; nav has Compress and History; Settings exists only in the footer; toggling collapses the sidebar and shows `☰`; breadcrumb reads Compress/History; macOS shows the toggle in both states; win32 shows window controls and hides the top-bar toggle while the sidebar is visible; no `SidebarRail`; the ⋯ menu's Quit calls `getCurrentWindow().close()` (never `invoke("quit")`); at a 760px viewport (set `window.innerWidth` before render — `useIsMobile` reads it directly in its initial effect) the sidebar renders as the `Sheet` and selecting a nav row closes it. `SidebarNav.test.tsx`: Settings click calls `onOpenSettings`; History click calls `onNavigate("history")`.

- [x] **Step 2: Run to verify failure**

Run: `yarn test src/App.test.tsx src/components/shell/SidebarNav.test.tsx`
Expected: FAIL — old shell renders brand/settings nav.

- [x] **Step 3: Implement the shell**

`App`: `CompressionProvider` → `HistoryProvider` → `SidebarProvider` → `Sidebar collapsible="offcanvas"` + `SidebarInset`. Pass `className="overflow-hidden"` to `SidebarContent` (vendored default is `overflow-auto`). Do not render `SidebarRail`. On macOS the `SidebarHeader` is empty on desktop; inside the mobile Sheet it shows the collapse trigger on every platform. Mount `QuitGuard` under `CompressionProvider` (it reads `isCompressing`), then `SettingsDialog`, `AboutDialog`, and `HistoryFilterDialog` (wired in Task 11). Wire `AppMenu` with `onQuit={() => getCurrentWindow().close()}` so every quit crosses the guard — never `invoke("quit")` from the menu. The sidebar's History row and batch rows close the Sheet on mobile (`if (isMobile) setOpenMobile(false)`). `activeView` is local state; Settings no longer a view. Remove the `SettingsView` route and its import. `TopBar`: `DragSurface` row, left cluster (toggle rules by platform, `☰` when hidden, breadcrumb `History › batch` via `batchLabel`), right cluster (`ThemeToggle`, `AppMenu`, `WindowControls` on non-darwin). Use `const visible = isMobile ? openMobile : open`; the `pl-22` clearance applies whenever `!visible` on darwin. `SidebarHeader`: empty on macOS desktop; otherwise glyph + `SidebarTrigger` (in the Sheet: close). Remove `useAutoCollapse(boardRef)` from `CompressView` only (HistoryView/Settings cleanup comes in Tasks 12/13).

- [x] **Step 4: Run tests**

Run: `yarn test src/App.test.tsx src/components/shell/SidebarNav.test.tsx src/components/shell/TopBar.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

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

- [x] **Step 1: Write failing tests**

Assert: two sort segments (`Newest first`, `Oldest first`); toggling Cancelled marks it pressed (multi); toggling Image and Other marks them pressed; the category group renders five chips; choosing `Last 7 days` sets `sinceMs` to start of day six days ago; a custom calendar date sets that day's start; Apply emits the draft; Cancel emits nothing; Clear all resets chips and sort; reopening after Apply seeds the applied values.

- [x] **Step 2: Run to verify failure**

Run: `yarn test src/components/history/HistoryFilterDialog.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

`Dialog` + title row (`DialogTitle`, active `Badge`, close). Groups with `FieldSet`/`FieldLegend`. Sort/Since use single `ToggleGroup`; Status/Category use `ToggleGroup multiple`. Base UI single-select allows deselecting the pressed value (emitting an empty array) — guard the sort callback with `value[0] ?? previousSort` so a sort is always set. Category chips render `CategoryIcon` with category tones for all five values (Image, Video, PDF, Document, Other). Since is a `Popover` + `Calendar` (`mode="single"`) with preset buttons; use `date-fns` (`startOfDay`, `subDays`, `startOfMonth`, `subMonths`) and `describeSince` for the trigger label. Footer `Clear all` / `Cancel` / `Apply`.

- [x] **Step 4: Run tests**

Run: `yarn test src/components/history/HistoryFilterDialog.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

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
- `HistoryList({ onOpenFilter })`; consumes `useHistoryContext`. Renders `SidebarInput` search, `ScrollArea` list, `Button` pagination. History row gets `aria-expanded` + `aria-controls`, the list wrapper `role="group"`, and the filter `SidebarMenuAction className="size-6"` (24px; stock is 20px on desktop). Selecting a batch closes the mobile Sheet (`if (isMobile) setOpenMobile(false)`).
- `SidebarNav` gains `onOpenFilter` and passes it to `HistoryList`.
- `App` owns `filterOpen`; mounts `HistoryFilterDialog` with `applied={filters}` and `onApply={setFilters}`.

- [x] **Step 1: Write failing tests**

Assert: only the list is inside `ScrollArea` (nav/search/pagination/footer are siblings, list wrapper has `min-h-0 flex-1`); rows show label, `N files · X saved`, and percent or `cancelled`; clicking a row calls `selectSession`; search debounce updates `setFilters`; pagination is disabled at bounds; the funnel calls `onOpenFilter`; `aria-expanded` flips with `expanded`.

- [x] **Step 2: Run to verify failure**

Run: `yarn test src/components/history/HistoryList.test.tsx`
Expected: FAIL — module not found.

- [x] **Step 3: Implement**

History row click toggles `expanded` and selects History. List uses `SidebarMenuSub`/`SidebarMenuSubItem`/`SidebarMenuSubButton` with `h-auto py-1.5`; selected row `isActive`. ScrollArea contains only rows. Search uses `SidebarInput`; pagination uses ghost icon `Button`s. Wire `filterOpen` in `App`; close it when the sidebar collapses (`useEffect(() => { if (!visible) setFilterOpen(false) }, [visible])`).

- [x] **Step 4: Run tests**

Run: `yarn test src/components/history/HistoryList.test.tsx src/components/shell/SidebarNav.test.tsx src/App.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

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

- [x] **Step 1: Write failing tests**

Render inside a mocked provider: selected batch shows label, file count, duration, output folder, and `Reveal folder`; file rows show sizes/percent/status; `null` selection shows the empty state; load error shows the banner; filtered counts show `N / M`; `Clear history` opens the `AlertDialog` and confirming calls `clearHistory`.

- [x] **Step 2: Run to verify failure**

Run: `yarn test src/views/HistoryView.test.tsx`
Expected: FAIL — old view still expects filters/pagination.

- [x] **Step 3: Implement**

Rewrite the view as a detail pane. Import `savedLabel`, `fileCountLabel`, `savedPercent`, `formatDuration`, `countOutcome` from `src/lib/historyFormat.ts` and **delete the local copies at `HistoryView.tsx:196-268`**; keep `StatusMarker` as a component. Keep `openSessionFolder`/`revealFile` behavior. Remove `useAutoCollapse`. Add the `Clear history` ghost button + `AlertDialog` in the detail header, disabled when there are no sessions.

- [x] **Step 4: Run tests**

Run: `yarn test src/views/HistoryView.test.tsx`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/views/HistoryView.tsx src/views/HistoryView.test.tsx
git rm src/components/HistoryPagination.tsx
git commit -m "feat(history): focus the history view on the selected batch"
```

---

### Task 13: Cleanup, ADR, and full gate

**Files:**
- Delete: `src/hooks/useAutoCollapse.ts`, `src/hooks/useAutoCollapse.test.ts`
- Modify: `docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/bugs.md`, `GLOSSARY.md`, `docs/superpowers/specs/mocks/app-shell/README.md`
- Create: `docs/adr/0007-platform-window-chrome.md`

- [ ] **Step 1: Delete the auto-collapse hook and remaining references**

Remove the hook, its tests, and any remaining imports. `grep -r useAutoCollapse src` must return nothing. Also remove the ResizeObserver assertions it left behind in `App.test.tsx:305-334` and `CompressView.test.tsx:636-660`.

- [ ] **Step 2: Write the ADR**

Record: overlay title bar on macOS, frameless on Windows with default shadow (Linux deferred), plugin-os detection, custom drag/zoom, stock shadcn sidebar (offcanvas + Sheet, no fork), custom macOS menu without About, guarded quit path, window-state + single-instance, no transparent windows, Overlay drag limitation (window cannot be dragged while unfocused, tauri#4316), rejected alternatives.

- [ ] **Step 3: Update the durable docs**

ARCHITECTURE §3–§4 (components, state ownership, no settings view, `sort`, plugin-os, window-state, single-instance, stock sidebar); FEATURES rows 1/3/11/12 plus this slice; bugs (remove the auto-collapse item; add `history.jsonl` fold-cache note and "Linux chrome unverified"); GLOSSARY (shell, top bar, batch list). ADR 0007 records the custom macOS menu and the guarded quit path.

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
- Revision 2 coverage: stock sidebar (Tasks 2/9/11), pre-paint theme (3), guarded quit (4), sort null (5), shared helpers (6/12), settings save contract (8), five categories (10), conf overlay/clobber (1), window-state + single-instance (1), filter close (11), test helper (1).
- Every Review Focus line has a test named in its owning task (1 → Task 11, 2 → Task 1, 3 → Task 8, 4 → Task 6, 5 → Task 10).
