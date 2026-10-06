# UI Overhaul — Bugs & Improvements Design

**Date:** 2026-10-07
**Source:** Notion page [Improvement and bugs list](https://app.notion.com/p/3f12327a7252807494d3f9b0a0d12d7c) (10 inline screenshots, all reviewed)
**Status:** Approved in conversation; pending written-spec review

## 1. Problem summary

Ten UI issues (1 functional bug, 9 UX/style improvements) reported against the desktop app:

| # | Item | Type |
|---|------|------|
| B1 | New Batch keeps old list in staging zone | Bug |
| I1 | Sidebar design (expanded + collapsed) | Style |
| I2 | Drag-drop zone corners not rounded | Style |
| I3 | Default-size responsive breakage + auto-collapse missing + compact-bar flicker | UX defect |
| I4 | Batch category pills not grouped | Style |
| I5 | Compact bar chips unreachable/truncated at default size | UX defect |
| I6 | Kanban never fully scrolls right + phantom shadow at right edge | UX defect |
| I7 | Kanban card fidelity vs mock (s9) | Style |
| I8 | History view mono-colored, not uniform with app | Style |
| I9 | History view partially not shown at default size | UX defect |
| I10 | Settings screen mono/basic | Style |

Out of scope (decided): mock s9 stage text + ETA ("H.265 Pass 2… · ETA 2s") — not needed.

## 2. Decisions (agreed via browser mockups)

1. **Compress nav icon:** `RiContractUpDownLine` (vertical squeeze-inward). Cloud upload/download rejected both.
2. **Sidebar expanded:** every nav item gets its own rounded icon container (`size-7 rounded-lg`, neutral `bg-muted`; active = `bg-primary/15` + `text-primary`). Active item additionally carries a **highlight border** (`border border-primary/30 bg-primary/10`). Count = right-aligned green pill (`border-primary/30 bg-primary/10 text-primary`, mono). App icon = `RiFileShield2Line` in green-tinted rounded square.
3. **Sidebar collapsed (48px):** tinted icon buttons (active tinted), tooltips; footer = green status dot + small license ring, no text (kills the `v1.0.0 · GPLv3` overflow seen in screenshot).
4. **Drop zone (full):** rounded container (`rounded-2xl`) with dashed border; format pills grouped into labeled bordered containers — `IMAGES:` (blue), `VIDEOS:` (violet), `DOCS:` (PDF red + document amber), groups wrap.
5. **Compact bar:** two rows — row 1 icon + label + `or` + Browse; row 2 = mini labeled groups (same language, 9.5px), wrapping. Drag state changes only border color + bg tint (no layout shift → no flicker). Truncated mono format string removed.
6. **Kanban cards:** compressing = gradient progress fill (`linear-gradient(90deg, cyan → primary)`) + subtle lane-tinted card bg + existing left accent; done = green left accent bar; queued unchanged (dashed + chip); failed keeps red accent.
7. **Kanban board:** delete the always-painted `w-12 to-card` right fade overlay (phantom shadow); add right padding so last lane clears the edge at full scroll.
8. **History:** tone-matched filter chips, outcome badges, and session-card left accent bars; category badges tinted.
9. **Settings:** keep one-column card structure; add tinted card icons (folder=primary, targets=blue, performance=violet, quality floors=red, history=amber) + tinted category badges; steppers/selects stay shadcn.
10. **Responsive strategy:** content-driven auto-collapse (decision below).

## 3. Responsive system (architectural core)

**Chosen: content-driven collapse (Option B).**

- `useAutoCollapse(contentRef)` hook: `ResizeObserver` on the view's primary content element; cramped = `el.scrollWidth > el.clientWidth + 1` (works under `overflow: hidden` clipping — browser reports real content width).
- Cramped → `setOpen(false)` (shadcn `useSidebar`) → sidebar collapses to 48px strip → content gains ~208px.
- Window grows → no longer cramped → expand again.
- Only auto-expands what it auto-collapsed; manual user collapse is respected. Manual open while cramped re-collapses; manual toggling suspends auto-collapse for 3 s so the two don't fight.
- Applied to: staging table Card, kanban board wrapper, History Card, Settings scroll area.
- Window default stays 900×640; `minWidth` raised 700 → 760 so the post-collapse state always fits. Verified against live repro (Vite dev server in browser at exact Tauri size) during implementation.

**Rejected alternatives:** window-size-driven fixed thresholds (magic numbers per view); CSS container queries (cannot drive shadcn's JS sidebar state).

## 4. Shared tone module

New `src/lib/tokens.ts` (no comments):

- `CATEGORY_TONES: Record<Category, {tint, text, border, accent}>` — image=blue, video=violet, pdf=red, document=amber, other=muted. Single source replacing divergent `DropZone.CATEGORY_TINTS` / `Lane.LANE_META` / `RunRow.CHIP_TONES` values.
- `STATUS_TONES: Record<FileStatus, ...>` — done/already_under_target/compressing=primary, best_effort=amber, failed=destructive, cancelled/pending/unsupported=muted.
- Exports composable class strings for pills, chips, lane headers, accent bars.

Consumers: DropZone, Lane, RunRow, FileList, HistoryView, SettingsView.

## 5. Bug B1 — New Batch clears staging

```ts
const endRun = useCallback(() => {
  void clearList()          // backend clear_list + setFiles([])
  setRunScreen('staging')
}, [clearList])
```

- Clicking New Batch switches to staging with an **empty** drop zone (empty-screen branch renders same tick).
- Edge: `clear_list` invoke failure → message surfaces via existing staging `error` alert; list remains (fail-safe, not silent).
- `clear_list` remains safe here: New Batch is only enabled when `!running`.

## 6. Files touched

| File | Change |
|------|--------|
| `src/providers/CompressionProvider.tsx` | B1: `endRun` clears list |
| `src/App.tsx` | Sidebar header icon, footer pills + collapsed footer, view-container wiring |
| `src/components/SidebarNav.tsx` | Item anatomy: icon containers, active border, count pill, icon swap |
| `src/hooks/useAutoCollapse.ts` | New hook (content-driven collapse) |
| `src/components/DropZone.tsx` | Rounded container, grouped labeled pills, flicker fix, tone-module import |
| `src/components/run/KanbanBoard.tsx` | Remove fade overlay, right padding |
| `src/components/run/RunRow.tsx` | Gradient bar, lane-tinted bg, done accent bar, tone-module import |
| `src/components/run/Lane.tsx` | Tone-module import (values may shift slightly to match shared map) |
| `src/components/FileList.tsx` | Category badges → shared tones |
| `src/views/HistoryView.tsx` | Tone-matched chips/badges/accents |
| `src/views/SettingsView.tsx` | Tinted icons + badges |
| `src/types.ts` | No change expected |

## 7. Testing

- **B1:** update `CompressView.test.tsx` new-batch cases — assert list emptied / empty DropZone state on click; failure path leaves list + shows error.
- **Auto-collapse:** unit-test hook with mocked ResizeObserver + sidebar context (cramped → collapsed → restored; manual-collapse respected; toggle-suspension).
- **Tone module:** unit-test maps are exhaustive over `Category` / `FileStatus` (type-level exhaustive + runtime snapshot).
- **Visual/UX items:** update affected component tests (DropZone grouped pills present; KanbanBoard no overlay element; RunRow done-accent class present); live browser verification at 900×640 via Vite dev server for: staging table fits, History fits, kanban scroll reaches last lane with no overlay dimming, compact bar shows grouped chips without truncation.
- Full gate per project config: `yarn build && yarn test && cd src-tauri && cargo test` (no Rust changes expected unless live repro contradicts assumptions).

## 8. Risks / open points

- shadcn `SidebarMenuButton` anatomy may constrain the icon-container-per-item look — fallback: render the container as the button's child node (plain div) rather than fighting component internals; `ui/sidebar.tsx` stays untouched.
- Kanban cramped-detection must observe the scroll container's *content* width (`scrollWidth` of the flex row), not the clipped wrapper — verified in implementation.
- Settings/History min-widths may exceed 644px content even with sidebar collapsed at very narrow windows — accepted: sidebar stays collapsed; content scrolls/falls back (760 min-width covers primary case).
