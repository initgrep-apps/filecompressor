# Manual Testing 1 — Bug Fixes & UI Consistency — Design Spec

**Date:** 2026-09-30
**Status:** Draft → Approved
**Source:** `docs/bugs.md` manual testing section, items 1, 2, 4a, 4b, 4c (+ triage section in same file)
**Out of scope:** item 3 (parallel compression) — tracked as a separate enhancement spec/plan

---

## 1. Overview

Five findings from manual testing, triaged 2026-09-30:

| # | Finding | Type | Severity |
|---|---------|------|----------|
| 2a/2b | Compress file list lost + drops silently ignored after visiting Settings | Functional bug | P0 |
| 1 | Settings number inputs: invisible WebKit corner spinners | UI defect | P1 |
| 4a | Settings Save/Cancel footer scrolls out of view | Layout bug | P1 |
| 4c | Compress page scrolls as one body; drop zone + summary not pinned | Layout bug | P2 |
| 4b | Drop zone visual design (reference: Google Cloud Translation panel, "but better") | Design feedback | P2 |

One root cause links 2a/2b; one root cause links 4a/4c. The spec also closes a latent
sibling of Bug 2 (event-listener loss during navigation) for free, and aligns the shell
with the sidebar-03 shadcn block per user direction (flush sidebar, header breadcrumb,
Card-based content).

## 2. Architecture Decisions

### 2.1 State architecture (Bug 2) — App-level provider

**Decision:** lift file-list + compression state out of `CompressView` into a single
provider mounted once in `App.tsx`, above the view switch. React context is the
industry-standard pattern for app state that must outlive view mounting.

- New `src/providers/CompressionProvider.tsx`:
  - Internally calls the existing `useFileList()` and `useCompression()` hooks **once**.
  - Exposes one context value:
    `{ files, error, addFiles, browseFiles, removeFile, clearList, isCompressing,
    progressByFile, compressAll, cancelFile, cancelAll, revealInFolder }`.
  - Toast callbacks (`onBatchComplete`, `onBatchError`) move into the provider — toast
    is app-level UI, and this keeps CompressView presentational.
- `CompressView` becomes a pure context consumer; its internal state hooks are deleted.
- `useFileList`/`useCompression` hook implementations are unchanged (only call site moves).
- Backend `FileListState` (Rust) is untouched.

Why not the alternatives:

- *Keep views mounted + hidden toggle:* a workaround that traps state inside one view's
  tree; does not scale to History view or future features.
- *Backend as source of truth + `get_files` on remount:* sound direction for multi-window
  v2, but requires status write-back + event replay to work correctly (backend statuses
  currently drift from frontend). Too large for a bug fix; can layer on later.

**Latent bug fixed for free:** `useCompression`'s event listeners currently mount inside
`CompressView` and die on navigation — a batch started before switching to Settings loses
all `file:progress`/`file:complete` events. Provider-level listeners live for the app
lifetime, so compressing while browsing other views works.

**Expected behavior after fix:** add files → switch to Settings → switch back → rows are
still there; re-dropping the same file stays deduped (single row); dropping a new file
appends; compression continues across view switches.

### 2.2 Number stepper (Bug 1) — Base UI `NumberField` wrapper

**Root cause recap:** all 9 numeric controls are native `<Input type="number">`.
WKWebView renders no visible stepper; spin arrows are a tiny invisible hover region at
the corner, and corner clicks step the value — confirmed WebKit behavior.

**Research verdict (2026-09-30):**
- The `@shadcn` registry has **no** number-field item for this project's style
  (`styles/base-rhea/number-field.json` → not found).
- Base UI — which is this project's shadcn base (`@base-ui/react` 1.8.0 already a
  dependency; existing `src/components/ui/*` import from `@base-ui/react/*`) — ships a
  native
  [`Number Field`](https://base-ui.com/react/components/number-field): *"A numeric input
  element with increment and decrement buttons, and a scrub area"* with
  `min`/`max`/`step`/`snapOnStep`/`allowOutOfRange`, clamped values, ArrowUp/ArrowDown
  keyboard stepping, blur normalization, and disabled-at-bound buttons.

**Design:** `NumberStepper` at `src/components/NumberStepper.tsx` — a thin shadcn-style
wrapper around Base UI `NumberField` primitives (import path `@base-ui/react/number-field`
— the installed package name; `@base-ui-components/react` does not exist in this repo),
styled to match the project's
`Input` component visuals (same border, radius, focus ring, semantic tokens — no raw
colors). Standard stepper layout, buttons flanking the value:

```
┌─────────────────────────────────┐
│ [−] │        value         │ [+] │
└─────┴──────────────────────┴─────┘
  NumberField.Group
    ├── NumberField.Decrement  (icon button, RiSubtractLine, aria "Decrease X")
    ├── NumberField.Input      (typed + keyboard ↑/↓ + select-on-focus)
    └── NumberField.Increment  (icon button, RiAddLine, aria "Increase X")
```

- **Step: 1** everywhere (user decision); Base UI handles clamping to `[min, max]`,
  blur normalization (invalid/empty → last valid value), and button disabled state at
  bounds — no hand-rolled logic.
- Manual typing always allowed (user decision: "can also manually change").
- Icons from `@remixicon/react`; buttons follow the project `Button` visual treatment
  with `data-icon` rule respected; no manual sizing classes on icons.
- Props: `value: number, onValueChange: (n: number) => void, min: number, max: number,
  ariaLabel: string, id?: string, className?: string` — mapped 1:1 onto `NumberField.Root`.
- Replaces all 9 native number inputs in `SettingsView.tsx` (4 category targets +
  5 quality floors); `aria-label`s preserved verbatim.

### 2.3 Scroll containment (4a + 4c) — flex `min-h-0` chain + ScrollArea

**Root cause recap:** `App.tsx:125` wrapper (`flex flex-1 flex-col`) lacks `min-h-0`.
Flex children refuse to shrink below content height by default (`min-height: auto`), so
views grow past the window and the *page body* scrolls as one unit — pushing the
Settings footer out of view (4a) and scrolling the drop zone away with the table (4c).
The views themselves already carry correct `shrink-0`/`overflow` classes; they are just
never given a bounded height to scroll within.

**Fix chain:**

1. `App.tsx` content wrapper (`App.tsx:125`) gains `min-h-0 overflow-hidden` so each
   view is height-constrained.
2. **Compress view:** title row + drop zone + action row + summary footer are
   `shrink-0`; only the file table region scrolls.
3. **Settings view:** header + form region scroll (`flex-1`); Save/Cancel footer is
   always visible (`shrink-0` — already in place; works once the parent constrains).

**ScrollArea:** the scrolling table region uses the `scroll-area` shadcn block — styled
native scrolling consistent across all three Tauri WebViews (WKWebView / WebView2 /
WebKitGTK). Same for the Settings form region.

**Window minimums:** `tauri.conf.json:18-19` already pins `minWidth: 700`,
`minHeight: 500` — kept as-is (stricter than the 480×400 first proposed). No config
change needed. Desktop apps do not use breakpoint media queries; the flex/grid structure
below is the responsive story.

### 2.4 Shell alignment — sidebar-03 block applied as base (user-required)

From `https://ui.shadcn.com/blocks/sidebar#sidebar-03` — **the block's page structure is
the base this shell is built from**, applied with only the adjustments below (our app is
a single-window 3-view app, no routes/data-fetching page needed):

- Block structure applied verbatim: `SidebarProvider` → `AppSidebar` → `SidebarInset` →
  `header` (`SidebarTrigger` · vertical `Separator` · `Breadcrumb`) → content column.
- **Sidebar goes flush, full-height** — current `variant="floating"` (detached card look,
  `App.tsx:69`) is dropped; default variant attaches the sidebar edge-to-edge.
  `collapsible="icon"` stays.
- **Breadcrumb must be functional** (user-tested complaint): it renders the real current
  location and **updates on every navigation** — `Optimizer` (link, non-clicking visual
  root) / current view as `BreadcrumbPage` (`Compress`, `History`, `Settings`), driven by
  `activeView` state so any sidebar click updates it. It remains visible and correct
  while the sidebar is collapsed to icons — this is its purpose per the block. Clicking
  breadcrumb items is a no-op (single-level location display, not navigation history).
- **Per-view duplicate headings removed:** "Compress Files" / "Settings" h1 headings go
  away — the header breadcrumb is the title (History has no heading today; same rule).
- Vertical `Separator` styling follows the block:
  `mr-2 data-[orientation=vertical]:h-4`.

### 2.5 Card-based content (user decision: Cards everywhere)

Add the `card` shadcn block (not yet installed) and structure all three views with full
Card composition (skill rule: CardHeader/CardTitle/CardDescription/CardContent/CardFooter —
never dump everything in CardContent):

- **Compress view:**
  - Card 1 — Drop zone (design in §2.6).
  - Card 2 — File list: `CardContent` = `ScrollArea` (flex-1, min-h-0) holding the
    Table; `CardFooter` = batch summary (`data-testid="batch-summary"` preserved) +
    Clear List + Compress/Cancel All actions. Summary always visible — directly answers 4c.
- **Settings view:** three Cards — Output Folder, Category Targets, Quality Floors
  (accordion stays inside Card 3). Footer (Save/Cancel) remains a pinned bar below the
  scroll region.
- **History view:** single empty-state Card (placeholder view stays minimal).

### 2.6 Drop zone redesign (4b)

Adapted from the user's reference (Google Cloud Translation upload panel), "but better":
one full-width drop target instead of drag-on-left-half-only, green theme tokens instead
of Google blue, and the whole card click-to-browses.

```
┌─ Card ───────────────────────────────────────────────────────────┐
│                              │                                   │
│        ☁ (RiUploadCloud2Line)│         Or choose a file          │
│                              │                                   │
│         Drag and drop        │     [ Browse your files ]         │
│                              │                                   │
│                              │  Supported: JPEG PNG WebP HEIC    │
│                              │  MP4 MOV PDF DOCX XLSX PPTX       │
│                              │                                   │
└──────────────────────────────┴───────────────────────────────────┘
```

- Left cell: cloud-upload icon (remixicon, existing dep) + "Drag and drop" label.
- Vertical `Separator` between cells; right cell: "Or choose a file" +
  primary **Browse your files** button + supported-formats hint line.
- **Entire card** is the drag-drop target and click target (better than reference);
  keyboard access preserved (`role="button"`, `tabIndex`, Enter/Space opens browse).
- Visual states via semantic tokens only (no raw colors): idle
  `bg-muted/30 border-input`, hover `bg-muted/50`, dragging
  `border-primary bg-primary/5` (current behavior kept).
- `DropZone.tsx` public API unchanged (`onBrowse`, `onDrop`, `className`) — visual
  restructure only; tests updated for new markup.
- Drop zone remains always visible when files exist (pinned, per 4c).

## 3. Component & Data Flow

```
App.tsx
├── SidebarProvider
│   ├── Sidebar (variant: default/flush, collapsible="icon")
│   └── SidebarInset
│       ├── header: SidebarTrigger · Separator · Breadcrumb(activeView)
│       └── div (flex-1 flex-col min-h-0 overflow-hidden)
│           ├── CompressView   ─┐
│           ├── HistoryView     ├─ consume CompressionContext
│           └── SettingsView   ─┘
└── CompressionProvider  ← owns useFileList + useCompression + IPC listeners
    (mounted once, above view switch)
```

- IPC event listeners (`file:progress`, `file:complete`, `file:error`,
  `file:cancelled`, `batch:complete`, `batch:error`) registered once in the provider's
  effect — same implementation as today, new home.
- No new IPC commands or Rust changes anywhere in this spec.

## 4. shadcn Components

Add via CLI (style/base auto-resolved from `components.json` — which has `style:
"base-rhea"`, `iconLibrary: "remixicon"`, and NO preset field):

```
npx shadcn@latest add card field scroll-area select empty spinner
```

- `card` — §2.5
- `field` — Settings form rows migrate from raw div rows to
  `FieldGroup`/`Field`/`FieldLabel`/`FieldDescription` composition
- `scroll-area` — §2.3 scroll regions
- `select` — replaces the two raw native `<select>` elements (target unit, min resolution)
- `empty` — History placeholder + compress-page empty list state
- `spinner` — Compress button busy state (Button + Spinner + disabled)

Not from the CLI: `NumberStepper` (§2.2) — no registry item exists for this style; it
wraps Base UI `NumberField` primitives directly
(`@base-ui/react/number-field`, already a project dependency via the shadcn base),
styled with the existing `input` component's token classes.

Icon rule: icons inside buttons use `data-icon`, no manual sizing classes.

## 5. Error Handling

- Provider surfaces the same errors as today: `add_files`/`remove`/`clear` failures set
  `error` (alert row above drop zone); cancel/reveal/save failures toast.
- Stepper invalid input: resolves to last valid value on blur; `[−]/[+]` clamp — no
  invalid state can reach the draft.
- No new failure modes introduced; no backend changes.

## 6. Testing Strategy

Vitest + Testing Library (existing setup). Rust untouched → no `cargo test` surface
beyond keeping the existing gate green.

| Area | Tests |
|------|-------|
| Provider (Bug 2) | add file → simulated view switch → return → row present; re-drop same path → still one row; new path → appended; listeners registered once (StrictMode-safe: existing duplicate-fire guard test ported to provider level) |
| Stepper | click [−]/[+] steps ±1; clamp at min/max (button disabled at bounds); typing works; blur normalizes invalid/empty input to last valid value; ArrowUp/ArrowDown keyboard step; Enter/Space unaffected |
| Layout | structural assertions: drop zone + summary + action row outside the scroll container; Settings footer outside scroll region |
| Drop zone | dragging/hover state classes; click opens browse; Enter/Space keyboard; drops call onDrop with paths |
| Settings | Field/Select/Stepper composition renders; existing save/cancel/reset tests stay green |
| Shell | breadcrumb reflects activeView; sidebar has no floating variant class |

Manual smoke (small window: 480×400): footer pinned on Settings; drop zone pinned on
Compress; only table scrolls.

## 7. File Change List

| File | Change |
|------|--------|
| `src/providers/CompressionProvider.tsx` | **Create** — context + provider (owns both hooks) |
| `src/App.tsx` | Wrap tree in provider; add `min-h-0 overflow-hidden` wrapper; sidebar variant default; breadcrumb header |
| `src/views/CompressView.tsx` | Consume context; delete hook calls; Card composition; heading removed |
| `src/views/SettingsView.tsx` | Field composition; NumberStepper ×9; Select ×2; three Cards |
| `src/views/HistoryView.tsx` | Empty-state Card |
| `src/components/DropZone.tsx` | Rewrite visuals (split panel), API unchanged |
| `src/components/FileList.tsx` | ScrollArea wrap; summary/actions to CardFooter (in CompressView) |
| `src/components/NumberStepper.tsx` | **Create** — Base UI `NumberField` wrapper (stepper visuals, − / + flanking value) |
| `src/components/ui/*` | Add via CLI: card, field, scroll-area, select, empty, spinner |
| `src/hooks/useFileList.ts`, `src/hooks/useCompression.ts` | Unchanged implementations; called from provider |
| `src-tauri/tauri.conf.json` | No change — `minWidth: 700`/`minHeight: 500` already present (§2.3) |
| Tests | `useCompression.test.ts` / `useFileList.test.ts` kept as-is (hook-internals guard); `CompressionProvider.test.tsx` NEW; `CompressView.test.tsx` + `FileList.test.tsx` updated for context/Card markup; new `NumberStepper.test.tsx`, `App.test.tsx`, `HistoryView.test.tsx` |

## 8. Risks

- **Listener lifetime change** is the riskiest move — mitigated by porting the existing
  StrictMode duplicate-fire guard and listener-registration-failure tests to provider level.
- `card`/`field`/`scroll-area`/`select`/`empty`/`spinner` come from the `@shadcn`
  registry — CLI resolves style/base automatically (verified 2026-09-30). `NumberStepper`
  wraps Base UI `NumberField` (v1.8.0, verified upstream 2026-09-30) — its
  `value`/`onValueChange` contract must be pinned by unit tests so a Base UI upgrade
  cannot silently change clamping semantics.
- Settings draft/save flow untouched — only control components swap; `hasChanges` JSON
  comparison semantics preserved (NumberStepper always emits integers).
