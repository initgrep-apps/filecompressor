# UI Overhaul — Bugs & Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Bug B1 (New Batch keeps old list) and deliver the 9 agreed UI improvements: sidebar redesign with content-driven auto-collapse, grouped format pills, compact-bar flicker fix, kanban shadow/scroll fix + card fidelity, history/settings color unification.

**Architecture:** Shared tone module (`src/lib/tokens.ts`) becomes the single source for category/status colors; every consumer imports it. Content-driven auto-collapse via a `useAutoCollapse` hook observing each view's primary content element and driving shadcn `useSidebar().setOpen`. All styling through existing Tailwind utilities + oklch theme tokens; `ui/sidebar.tsx` internals untouched.

**Tech Stack:** Tauri 2.12, React 19.3, TypeScript, Vite 8.3, shadcn/ui 4.21, Tailwind CSS 4.3, vitest + @testing-library, @remixicon/react, motion/react.

**Spec:** `docs/superpowers/specs/2026-10-07-ui-overhaul-bugs-design.md`

## Global Constraints

- GPLv3 header block on every new/modified source file — copy the existing header from any `src/` file verbatim, with `2026` copyright line.
- No comments in code unless explicitly requested.
- Colors: theme tokens / Tailwind palette utilities only (e.g. `bg-primary/15`, `text-blue-600`). No hex in source. (Hex is allowed in this plan's test snippets only for clarity.)
- Icons: `@remixicon/react` only; new icon `RiContractUpDownLine` (exists in installed package).
- Package manager: yarn. Test runner: vitest with @testing-library/react (existing pattern: `render`, `screen.getByTestId`, `user.click`).
- Do not modify `src/components/ui/sidebar.tsx` or other shadcn `ui/` internals.
- TypeScript types live in `src/types.ts`; do not change public types unless a task says so.

## Review Focus

Most likely to bite a person using this software, most likely first — each pinned by a test in its owning task:

1. **Manual sidebar collapse is overridden by auto-expand.** User manually collapses sidebar; auto-expand must not fight them. Expected: manual collapse respected indefinitely. Pinned: Task 3 hook test "does not expand when collapse was manual".
2. **User opens sidebar while view is cramped.** Expected: view re-collapses (content genuinely cannot fit), no rapid open/close loop, and manual toggling within 3 s does not double-toggle. Pinned: Task 3 hook test "re-collapses when cramped after manual open" + "suspends during 3 s window".
3. **Kanban last lane still hidden at scroll end.** Scroll must reach lane's right edge with content fully visible (no overlay dimming). Pinned: Task 7 test "no fade overlay element" + live check at 900×640 (Task 12).
4. **Compact bar still truncates format list.** No truncated mono string; grouped chips render fully or wrap. Pinned: Task 6 test "no truncation element, grouped groups present".
5. **`clear_list` backend failure on New Batch silently loses state.** Expected: list stays, error alert shown in staging screen. Pinned: Task 2 test "invoke rejection keeps files and shows error".

---

### Task 1: Shared tone module `src/lib/tokens.ts`

**Files:**
- Create: `src/lib/tokens.ts`
- Create: `src/lib/tokens.test.ts`

**Interfaces:**
- Consumes: `Category`, `FileStatus` from `src/types.ts`.
- Produces (all later tasks import):
  - `CATEGORY_TONES: Record<Category, { tint: string; text: string; border: string; accent: string }>`
  - `STATUS_TONES: Record<FileStatus, { tint: string; text: string; border: string; accent: string }>`
  - Field values are Tailwind class strings, e.g. image.tint = `'bg-blue-500/12'`, image.text = `'text-blue-600'`, image.border = `'border-blue-500/30'`, image.accent = `'bg-blue-500'`.

- [ ] **Step 1: Write the failing test** — `src/lib/tokens.test.ts`

```ts
import { describe, expect, it } from 'vitest'
import { CATEGORY_TONES, STATUS_TONES } from './tokens'
import type { Category, FileStatus } from '@/types'

const ALL_CATEGORIES: Category[] = ['image', 'video', 'pdf', 'document', 'other']
const ALL_STATUSES: FileStatus[] = [
  'pending', 'compressing', 'done', 'best_effort',
  'failed', 'cancelled', 'unsupported', 'already_under_target',
]

describe('CATEGORY_TONES', () => {
  it('covers every category', () => {
    for (const c of ALL_CATEGORIES) {
      expect(CATEGORY_TONES[c]).toBeDefined()
      expect(CATEGORY_TONES[c].tint).toMatch(/^bg-/)
      expect(CATEGORY_TONES[c].text).toMatch(/^text-/)
      expect(CATEGORY_TONES[c].border).toMatch(/^border-/)
      expect(CATEGORY_TONES[c].accent).toMatch(/^bg-/)
    }
  })
  it('maps image=blue, video=violet, pdf=destructive, document=amber, other=muted', () => {
    expect(CATEGORY_TONES.image.text).toContain('blue')
    expect(CATEGORY_TONES.video.text).toContain('violet')
    expect(CATEGORY_TONES.pdf.text).toBe('text-destructive')
    expect(CATEGORY_TONES.document.text).toContain('amber')
    expect(CATEGORY_TONES.other.text).toBe('text-muted-foreground')
  })
})

describe('STATUS_TONES', () => {
  it('covers every status', () => {
    for (const s of ALL_STATUSES) expect(STATUS_TONES[s]).toBeDefined()
  })
  it('maps done/already_under_target/compressing=primary, best_effort=amber, failed=destructive, cancelled/pending/unsupported=muted', () => {
    expect(STATUS_TONES.done.text).toBe('text-primary')
    expect(STATUS_TONES.already_under_target.text).toBe('text-primary')
    expect(STATUS_TONES.compressing.text).toBe('text-primary')
    expect(STATUS_TONES.best_effort.text).toContain('amber')
    expect(STATUS_TONES.failed.text).toBe('text-destructive')
    expect(STATUS_TONES.cancelled.text).toBe('text-muted-foreground')
    expect(STATUS_TONES.pending.text).toBe('text-muted-foreground')
    expect(STATUS_TONES.unsupported.text).toBe('text-muted-foreground')
  })
})
```

- [ ] **Step 2: Run test to verify it fails.** Run: `yarn vitest run src/lib/tokens.test.ts`. Expected: FAIL, cannot import `./tokens`.
- [ ] **Step 3: Implement `src/lib/tokens.ts`.** Two `Record`s with exact keys above; class strings using Tailwind palette (`blue`, `violet`, `amber`) at `/10`–`/15` opacities for tints, `/25`–`/35` for borders; `pdf`/`failed` use `destructive` token; `other`/muted use `muted`/`muted-foreground`. Exports only — no other symbols.
- [ ] **Step 4: Run test to verify it passes.** Run: `yarn vitest run src/lib/tokens.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/tokens.ts src/lib/tokens.test.ts && git commit -m "feat(ui): shared category and status tone module"`

### Task 2: B1 — New Batch clears staging list

**Files:**
- Modify: `src/providers/CompressionProvider.tsx:93-95` (add `clearList` to destructure at line 55, rewrite `endRun`)
- Test: `src/views/CompressView.test.tsx` (new-batch describe block, lines ~280-440)

**Interfaces:**
- Consumes: `clearList: () => Promise<void>` already returned by `useFileList` (provider line 55).
- Produces: `endRun(): void` — same signature; behavior changes to clear list before switching screen.

- [ ] **Step 1: Write the failing tests** in the existing new-batch describe in `src/views/CompressView.test.tsx`:

```ts
it('new batch clears the staging list — empty drop zone is shown', async () => {
  // existing setup: two files staged, batch completed
  await user.click(screen.getByTestId('new-batch'))
  expect(screen.queryByTestId('batch-summary')).not.toBeInTheDocument()
  expect(screen.getByText('Drag and drop files here')).toBeInTheDocument()
})

it('new batch failure path keeps the list and shows the error alert', async () => {
  // mock invoke('clear_list') rejection
  await user.click(screen.getByTestId('new-batch'))
  expect(await screen.findByRole('alert')).toBeInTheDocument()
  expect(screen.getByTestId('batch-summary')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run tests to verify they fail.** Run: `yarn vitest run src/views/CompressView.test.tsx`. Expected: first test FAIL (old list still rendered), second FAIL (no alert today).
- [ ] **Step 3: Implement** in `src/providers/CompressionProvider.tsx` — destructure `clearList` from `useFileList()` (line 55) and:

```ts
const endRun = useCallback(() => {
  void clearList()
  setRunScreen('staging')
}, [clearList])
```

- [ ] **Step 4: Run all provider/view tests.** Run: `yarn vitest run src/views/CompressView.test.tsx src/providers`. Expected: PASS (fix any of the existing new-batch assertions that relied on the old list persisting).
- [ ] **Step 5: Commit** `git add src/providers/CompressionProvider.tsx src/views/CompressView.test.tsx && git commit -m "fix(compression): new batch clears staging list"`

### Task 3: `useAutoCollapse` hook

**Files:**
- Create: `src/hooks/useAutoCollapse.ts`
- Create: `src/hooks/useAutoCollapse.test.ts`

**Interfaces:**
- Consumes: `useSidebar()` from `@/components/ui/sidebar` (exports `setOpen: (open: boolean) => void`).
- Produces: `useAutoCollapse(contentRef: RefObject<HTMLElement | null>): void`.

Behavior pinned by spec: cramped = `el.scrollWidth > el.clientWidth + 1`; cramped → `setOpen(false)` once; not-cramped → `setOpen(true)` only if the hook performed the collapse; manual `setOpen(false)` by user (state went closed without the hook) is respected — never auto-expanded; manual open while cramped → re-collapse; any manual toggle suspends auto-collapse for 3 s.

- [ ] **Step 1: Write the failing tests.** Mock `useSidebar` to return a spy `setOpen` and controllable `open`; mock `ResizeObserver` globally (capture instances, trigger manually):

```ts
const cases = [
  ['collapses when content overflows', makeObserved(1000, 800), ['setOpen', false]],
  ['does not expand when collapse was manual', 'manual-close', ['noop']],
  ['re-collapses when cramped after manual open', 'manual-open-cramped', ['setOpen', false]],
  ['restores when space returns', 'auto-restore', ['setOpen', true]],
  ['suspends auto-collapse for 3 s after manual toggle', 'suspends'],
]
```

Each case: render `TestProbe` (component calling hook with a div ref), trigger RO callback with given client/scroll widths and sidebar state, assert `setOpen` calls (use `vi.useFakeTimers()` for the 3 s window).

- [ ] **Step 2: Run to verify failure.** Run: `yarn vitest run src/hooks/useAutoCollapse.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `useAutoCollapse`.** Per spec §3: `ResizeObserver` in effect; `cramped` boolean; `autoCollapsedRef: boolean`; `lastManualRef` timestamp vs 3 s suspension; cleanup `disconnect()`. No debounce beyond suspension.
- [ ] **Step 4: Run to verify pass.** Run: `yarn vitest run src/hooks/useAutoCollapse.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/hooks/useAutoCollapse.ts src/hooks/useAutoCollapse.test.ts && git commit -m "feat(ui): content-driven sidebar auto-collapse hook"`

### Task 4: Sidebar redesign (expanded + collapsed)

**Files:**
- Modify: `src/components/SidebarNav.tsx` (navItems icon: `RiUploadCloud2Line` → `RiContractUpDownLine`; item anatomy lines 60-74)
- Modify: `src/App.tsx:66-68` (app icon → `RiFileShield2Line`), `App.tsx:88-92` (footer → pills + collapsed variant)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `navItems`, `ViewId` unchanged (App.tsx imports them).
- Produces: rendered sidebar contract used by App tests:
  - Active nav item: `SidebarMenuButton` with `isActive` + card container carrying `border border-primary/30 bg-primary/10`.
  - Icon inside `flex size-7 items-center justify-center rounded-lg` container — neutral `bg-muted` inactive, `bg-primary/15 text-primary` active.
  - Compress count pill: right-aligned `inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[10px] font-bold text-primary`, rendered when `files.length > 0`.
  - Footer expanded: `v1.0.0` pill (neutral border) + `GPLv3` pill (primary-tinted border). Collapsed: `size-1.5 rounded-full bg-primary` dot + `h-2.5 w-5 rounded-full border border-primary/30` ring; `group-data-[collapsible=icon]:hidden` on the text pill row.

- [ ] **Step 1: Write failing tests** in `src/App.test.tsx`:

```ts
it('compress nav uses squeeze icon container and active border highlight', () => {
  expect(document.querySelector('[data-testid="nav-compress"]')).toBeTruthy()
  // assert active button container has border-primary/30 in className
})
it('footer shows version and license pills; collapsed shows dot + ring, no text', () => {
  // expanded: getByText('v1.0.0') + 'GPLv3' inside pill elements
  // simulate collapsible=icon data attr: text pills hidden
})
```

- [ ] **Step 2: Run to verify failure.** Run: `yarn vitest run src/App.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** SidebarNav item anatomy + App header/footer per Interfaces block. Inactive labels `text-muted-foreground`.
- [ ] **Step 4: Run to verify pass** — `yarn vitest run src/App.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/App.tsx src/components/SidebarNav.tsx src/App.test.tsx && git commit -m "feat(ui): sidebar redesign with icon containers and pill footer"`

### Task 5: DropZone full variant — rounded + grouped labeled pills

**Files:**
- Modify: `src/components/DropZone.tsx:226-271` (full variant) + FORMAT grouping (lines 31-44)
- Test: `src/components/DropZone.test.tsx`

**Interfaces:**
- Consumes: `CATEGORY_TONES` from `@/lib/tokens`.
- Produces: full-variant DOM contract: container `rounded-2xl`; groups rendered as bordered containers with uppercase label `IMAGES:` / `VIDEOS:` / `DOCS:`; chips mini `text-[10.5px]` tinted by tones; drag state toggles only border color + `bg-primary/5`.

- [ ] **Step 1: Write failing tests** in `src/components/DropZone.test.tsx`:

```ts
it('groups format pills under labeled containers IMAGES/VIDEOS/DOCS', () => {
  render(<DropZone onBrowse={noop} onDrop={noop} />)
  expect(screen.getByText('IMAGES:')).toBeInTheDocument()
  expect(screen.getByText('VIDEOS:')).toBeInTheDocument()
  expect(screen.getByText('DOCS:')).toBeInTheDocument()
  expect(screen.getAllByText('JPEG').length).toBeGreaterThan(0)
})
it('zone container is rounded (rounded-2xl class present)', () => {
  // assert className includes 'rounded-2xl'
})
```

- [ ] **Step 2: Run to verify failure.** Run: `yarn vitest run src/components/DropZone.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Group FORMATS by category into the three display groups (image→IMAGES:, video→VIDEOS:, pdf+document→DOCS:); render `FormatPill` inside group containers; add `rounded-2xl`; keep `isDragging` color-only transitions.
- [ ] **Step 4: Run to verify pass.** Run: `yarn vitest run src/components/DropZone.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/components/DropZone.tsx src/components/DropZone.test.tsx && git commit -m "feat(ui): rounded drop zone with grouped labeled format pills"`

### Task 6: DropZone compact variant — two rows, no flicker

**Files:**
- Modify: `src/components/DropZone.tsx:189-224` (compact variant)
- Test: `src/components/DropZone.test.tsx`

**Interfaces:**
- Consumes: grouping from Task 5 (same module scope).
- Produces: compact DOM contract: row 1 = icon + fixed-width label slot + `or` + Browse; row 2 = mini labeled groups wrapping; no `ml-auto` truncated mono element (assert `MONO_FORMATS` string absent from DOM); drag changes border color/bg only; text slot widths constant between states (assert same label element, class contains `w-` fixed width or `min-w-`).

- [ ] **Step 1: Write failing tests** in `src/components/DropZone.test.tsx`:

```ts
it('compact bar has grouped mini pills row and no truncated mono string', () => {
  render(<DropZone compact onBrowse={noop} onDrop={noop} />)
  expect(screen.getByText('IMAGES:')).toBeInTheDocument()
  expect(screen.queryByText(/JPEG, PNG, WebP/)).not.toBeInTheDocument()
})
it('compact drag state keeps same label slot — no layout-shifting text swap', async () => {
  // fire tauri drag-drop enter event → label element identical (same testid), text unchanged
})
```

- [ ] **Step 2: Run to verify failure.** Run: `yarn vitest run src/components/DropZone.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Restructure compact markup; label/count as fixed-width slots (`min-w-` classes); drag feedback = border + tint classes only; keep Enter/Space browse behavior.
- [ ] **Step 4: Run to verify pass.** Run: `yarn vitest run src/components/DropZone.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/components/DropZone.tsx src/components/DropZone.test.tsx && git commit -m "fix(ui): compact drop bar two-row layout, no flicker"`

### Task 7: KanbanBoard — remove phantom shadow, fix scroll end

**Files:**
- Modify: `src/components/run/KanbanBoard.tsx:74-103` (remove overlay div lines 98-101; add `pr-3`/right padding to scroll container line 77; keep wrapper `relative` only if needed)
- Test: `src/components/run/KanbanBoard.test.tsx`

**Interfaces:**
- Consumes: unchanged props.
- Produces: board DOM without overlay; scroll container ends with lane fully visible.

- [ ] **Step 1: Write failing test** in `src/components/run/KanbanBoard.test.tsx`:

```ts
it('renders no right-edge fade overlay', () => {
  render(<KanbanBoard {...minProps} />)
  expect(document.querySelector('[aria-hidden]')).toBeNull()
})
```

- [ ] **Step 2: Run to verify failure.** Run: `yarn vitest run src/components/run/KanbanBoard.test.tsx`. Expected: FAIL (overlay exists).
- [ ] **Step 3: Implement.** Delete overlay; add right padding inside `overflow-x-auto` container; drop `relative` wrapper if nothing else uses it.
- [ ] **Step 4: Run to verify pass.** Run: `yarn vitest run src/components/run/KanbanBoard.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/components/run/KanbanBoard.tsx src/components/run/KanbanBoard.test.tsx && git commit -m "fix(ui): remove kanban right-edge overlay, add scroll-end padding"`

### Task 8: RunRow — gradient bar, tinted bg, done accent

**Files:**
- Modify: `src/components/run/RunRow.tsx:113-127` (status classes), `:218-232` (progress fill), `:33-40` (CHIP_TONES → STATUS_TONES import)
- Modify: `src/components/run/Lane.tsx:30-36` (LANE_META → CATEGORY_TONES import)
- Test: `src/components/run/RunRow.test.tsx`, `src/components/run/Lane.test.tsx` (existing)

**Interfaces:**
- Consumes: `CATEGORY_TONES`, `STATUS_TONES` from `@/lib/tokens`; `progress?.[file.id]` percent unchanged.
- Produces: card class contract:
  - `compressing`: `border-primary/30` + lane `CATEGORY_TONES[category].tint` bg + existing inset accent replaced by `.accent` class from tone map.
  - `done`: `shadow-[inset_3px_0_0_theme colors]` — use `STATUS_TONES.done.accent` inside `shadow-[inset_3px_0_0_var(--primary)]`.
  - progress fill: gradient referencing theme vars only — exact class: `bg-[linear-gradient(90deg,var(--color-cyan-400),var(--color-primary))]`.

- [ ] **Step 1: Write failing tests** in `src/components/run/RunRow.test.tsx`:

```ts
it('compressing card shows gradient progress fill', () => {
  render(<RunRow file={compressingFile} percent={42} />)
  expect(screen.getByTestId('run-progress-fill').className).toContain('linear-gradient')
})
it('done card carries green inset accent bar', () => {
  render(<RunRow file={doneFile} />)
  expect(screen.getByTestId('run-row-done').className).toContain('inset_3px_0_0')
})
```

- [ ] **Step 2: Run to verify failure.** Run: `yarn vitest run src/components/run/RunRow.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.** Swap LANE_META/CHIP_TONES literals for tone-module values; progress fill class = `bg-[linear-gradient(90deg,var(--color-cyan-400),var(--color-primary))]` (Tailwind v4 palette vars — no hex in source); compressing accent uses `STATUS_TONES.compressing.accent`; done card gets `shadow-[inset_3px_0_0_var(--primary)]`.
- [ ] **Step 4: Run to verify pass** — also run Lane tests (values changed). Run: `yarn vitest run src/components/run`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/components/run && git commit -m "feat(ui): kanban card fidelity — gradient bars, tinted bg, done accent"`

### Task 9: FileList — category tones in staging table

**Files:**
- Modify: `src/components/FileList.tsx:31-37` (categoryVariant → CATEGORY_TONES import)
- Test: `src/components/FileList.test.tsx`

**Interfaces:**
- Consumes: `CATEGORY_TONES`.
- Produces: table category badges tinted (blue/violet/red/amber); `other` muted.

- [ ] **Step 1: Write failing test** in `src/components/FileList.test.tsx`:

```ts
it('category badges use shared tones', () => {
  render(<FileList files={filesWithMixedCategories} onRemove={noop} />)
  const imageBadge = screen.getByText('Image')
  expect(imageBadge.className).toContain('blue')
})
```

- [ ] **Step 2: Run to verify failure.** Run: `yarn vitest run src/components/FileList.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** — replace `categoryVariant` map values with tone-module fields.
- [ ] **Step 4: Run to verify pass.** Run: `yarn vitest run src/components/FileList.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/components/FileList.tsx src/components/FileList.test.tsx && git commit -m "feat(ui): staging table category badges use shared tones"`

### Task 10: HistoryView — tone-matched uniformity

**Files:**
- Modify: `src/views/HistoryView.tsx:71-84` (STATUS_META → STATUS_TONES), `:206-229` (Chip active tone), `:274` (session card accent), `:311-320` (outcome badges tone)
- Test: `src/views/HistoryView.test.tsx`

**Interfaces:**
- Consumes: `CATEGORY_TONES`, `STATUS_TONES`.
- Produces: history DOM contract: filter chips active = tone-matched tint/border; outcome badges tinted; session card carries left accent bar by dominant outcome (done=green, failed=red, cancelled=gray).

- [ ] **Step 1: Write failing tests** in `src/views/HistoryView.test.tsx`:

```ts
it('done filter chip is tone-matched, not gray', () => {
  render(<HistoryView />)
  expect(screen.getByRole('button', { name: /Done/ }).className).toContain('primary')
})
it('session card shows accent bar colored by dominant outcome', () => {
  // dominant done → primary accent class on card container
})
```

- [ ] **Step 2: Run to verify failure.** Run: `yarn vitest run src/views/HistoryView.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** per contract; keep chip semantics (`aria-pressed`, toggle lists) unchanged.
- [ ] **Step 4: Run to verify pass.** Run: `yarn vitest run src/views/HistoryView.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/views/HistoryView.tsx src/views/HistoryView.test.tsx && git commit -m "feat(ui): history view tone-matched with kanban"`

### Task 11: SettingsView — tinted icons + badges

**Files:**
- Modify: `src/views/SettingsView.tsx:45-50` (categories map: add icon+tone), `:158-189` (folder card icon), `:191-243` (targets card icon + badge tones), `:245-273` (performance icon), `:275-408` (quality floors icon), `:410-435` (history icon)
- Test: `src/views/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `CATEGORY_TONES`.
- Produces: settings DOM contract: each card header has tinted icon square; category badges tinted via shared tones.

- [ ] **Step 1: Write failing test** in `src/views/SettingsView.test.tsx`:

```ts
it('category target rows use tinted badges', async () => {
  renderSettings()
  expect(await screen.findByText('Image').then(el => el.className)).toContain('blue')
})
```

- [ ] **Step 2: Run to verify failure.** Run: `yarn vitest run src/views/SettingsView.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** per contract (icons: `RiFolderLine`-family/`RiLineChartLine`/`RiFlashlightLine`/`RiTimeLine`/`RiShieldLine` — pick from installed remixicon exports, verify names by grep before use).
- [ ] **Step 4: Run to verify pass.** Run: `yarn vitest run src/views/SettingsView.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `git add src/views/SettingsView.tsx src/views/SettingsView.test.tsx && git commit -m "feat(ui): settings view tinted icons and badges"`

### Task 12: Wire auto-collapse into views + window minWidth bump

**Files:**
- Modify: `src/views/CompressView.tsx` (StagingScreen Card + RunMonitor kanban wrapper → `useAutoCollapse` refs)
- Modify: `src/views/HistoryView.tsx:519` (Card ref)
- Modify: `src/views/SettingsView.tsx:146` (scroll container ref)
- Modify: `src-tauri/tauri.conf.json:18` (`"minWidth": 700` → `760`)
- Test: manual live verification (documented steps below)

**Interfaces:**
- Consumes: `useAutoCollapse` from Task 3.
- Produces: app behavior — sidebar auto-collapses when active view cramped at 900×640, expands on grow.

- [ ] **Step 1: Wire refs.** One `useAutoCollapse` call per active view root content element; refs attach to: staging `Card` (CompressView), board wrapper `div.relative` (RunMonitor), History `Card`, Settings scroll container.
- [ ] **Step 2: Live verification.** Run: `yarn dev`, open browser at window size 900×640 (devtools). Verify and record:
  1. Staging: add files → table fully visible; no clipping at default size.
  2. History: sessions render fully; no right-edge cut.
  3. Kanban: scroll right → last lane fully visible, no dimming.
  4. Resize below ~860px → sidebar collapses; grow back → expands.
  5. Compact bar shows grouped chips, no truncation, no flicker on drag (native drag cannot run in browser — verify state classes via `isDragging` simulation or defer to dev build check).
- [ ] **Step 3: minWidth bump** in `tauri.conf.json` and confirm staging table still fits at min width.
- [ ] **Step 4: Commit** `git add src/views src-tauri/tauri.conf.json && git commit -m "feat(ui): wire auto-collapse into views, raise window min width"`

### Task 13: Full gate

- [ ] **Step 1: Run the gate.** Run: `yarn build && yarn test && cd src-tauri && cargo test`. Expected: all green; no Rust changes expected.
- [ ] **Step 2: Fix any fallout** (test updates only; no scope creep).
- [ ] **Step 3: Commit remaining fixes** if any: `git commit -m "fix(ui): address gate fallout"`.
