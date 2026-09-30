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

### 2.2 Number stepper (Bug 1) — shadcn InputGroup composition

**Root cause recap:** all 9 numeric controls are native `<Input type="number">`.
WKWebView renders no visible stepper; spin arrows are a tiny invisible hover region at
the corner, and corner clicks step the value — confirmed WebKit behavior.

**Design:** reusable `NumberStepper` component at `src/components/NumberStepper.tsx`,
composed from the `input-group` shadcn block (per skill rule: "buttons inside inputs use
InputGroup + InputGroupAddon"):

```
<InputGroup>
  <InputGroupInput type="text" inputMode="numeric" ... />
  <InputGroupAddon align="inline-start">
    <InputGroupButton size="icon-xs" aria-label="Decrease X"><MinusIcon/></InputGroupButton>
  </InputGroupAddon>
  <InputGroupAddon align="inline-end">
    <InputGroupButton size="icon-xs" aria-label="Increase X"><PlusIcon/></InputGroupButton>
  </InputGroupAddon>
</InputGroup>
```

- **Step: 1** everywhere (user decision: "keep it simple").
- Manual typing always allowed: text input with `inputMode="numeric"`, value clamped to
  `[min, max]` on change/blur (native `type="number"` is the bug source — not used).
- `[−]`/`[+]` buttons disabled at min/max; buttons never push value out of bounds.
- Integer-only: non-numeric/empty input resolves to current valid value on blur.
- Props: `value: number, onChange: (n: number) => void, min: number, max: number,
  ariaLabel: string, id?: string, className?: string`.
- Replaces all 9 native number inputs in `SettingsView.tsx` (4 category targets +
  5 quality floors); `aria-label`s preserved verbatim.
- Icons from the project icon library (`@remixicon/react`: `RiSubtractLine`, `RiAddLine`).

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

**Window minimums:** `tauri.conf.json` window config gains `minWidth: 480`,
`minHeight: 400` so layouts never collapse below usable size. Desktop apps do not use
breakpoint media queries; the flex/grid structure below is the responsive story.

### 2.4 Shell alignment — sidebar-03 pattern (user-requested)

From `https://ui.shadcn.com/blocks/sidebar#sidebar-03`:

- **Sidebar goes flush, full-height** — current `variant="floating"` (detached card look,
  `App.tsx:69`) is dropped; default variant attaches the sidebar edge-to-edge.
  `collapsible="icon"` stays.
- **Header breadcrumb:** header becomes the sidebar-03 pattern —
  `SidebarTrigger` · vertical `Separator` · `Breadcrumb` showing the current location
  (`Optimizer / Compress`, `Optimizer / History`, `Optimizer / Settings`). Breadcrumb
  follows `activeView`; gives orientation when the sidebar is collapsed to icons.
  `breadcrumb.tsx` is already installed.
- **Per-view duplicate headings removed:** "Compress Files" / "Settings" h1 headings go
  away — the header breadcrumb is the title (History has no heading today; same rule).

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

Add via CLI (style/base auto-resolved from `components.json`, preset `b3T38WToP`,
base `base`, icons `remixicon`):

```
npx shadcn@latest add card input-group field scroll-area select empty spinner
```

- `card` — §2.5
- `input-group` — §2.2 (stepper)
- `field` — Settings form rows migrate from raw div rows to
  `FieldGroup`/`Field`/`FieldLabel`/`FieldDescription` composition
- `scroll-area` — §2.3 scroll regions
- `select` — replaces the two raw native `<select>` elements (target unit, min resolution)
- `empty` — History placeholder + compress-page empty list state
- `spinner` — Compress button busy state (Button + Spinner + disabled)

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
| Stepper | click [−]/[+] steps ±1; typing works; clamp at min/max; buttons disabled at bounds; blur normalizes invalid input; Enter/Space unaffected |
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
| `src/components/NumberStepper.tsx` | **Create** |
| `src/components/ui/*` | Add via CLI: card, input-group, field, scroll-area, select, empty, spinner |
| `src/hooks/useFileList.ts`, `src/hooks/useCompression.ts` | Unchanged implementations; called from provider |
| `src-tauri/tauri.conf.json` | `minWidth: 480`, `minHeight: 400` |
| Tests | `useCompression.test.ts` ported to provider mount; `CompressView.test.tsx` + `FileList.test.tsx` updated for context/Card markup; new NumberStepper tests |

## 8. Risks

- **Listener lifetime change** is the riskiest move — mitigated by porting the existing
  StrictMode duplicate-fire guard and listener-registration-failure tests to provider level.
- `InputGroup` + preset `base-rhea` composition is verified upstream (docs fetched
  2026-09-30); `card`/`field`/`scroll-area`/`select`/`empty`/`spinner` come from the same
  registry — CLI resolves style automatically.
- Settings draft/save flow untouched — only control components swap; `hasChanges` JSON
  comparison semantics preserved (NumberStepper always emits integers).
