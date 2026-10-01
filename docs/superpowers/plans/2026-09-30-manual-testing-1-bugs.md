# Manual Testing 1 — Bug Fixes & UI Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 5 manual-testing findings — lost compress list after Settings visit (P0), hostile native number inputs, unpinned Settings footer, page-wide scrolling, drop-zone redesign — and align the shell with the shadcn `sidebar-03` block.

**Architecture:** App-level `CompressionProvider` owns file-list + compression state (context survives view switches); `NumberStepper` wraps Base UI `NumberField`; flex `min-h-0` chain pins footers and contains scrolling; Card composition for all views.

**Tech Stack:** React 19 + TypeScript + Vite, shadcn/ui (style `base-rhea`, icons `@remixicon/react`, `components.json` has NO preset field — CLI resolves via style), `@base-ui/react` v1.8.0 (namespace import `@base-ui/react/number-field` — NOT `@base-ui-components/react`), Vitest + Testing Library, yarn.

**Spec:** `docs/superpowers/specs/2026-09-30-manual-testing-1-bugs-design.md`

## Global Constraints

- Gate command (every task): `yarn build && yarn test && cd src-tauri && cargo test`
- Package manager: yarn. No new npm dependencies (Base UI already present via shadcn base).
- No comments in code (AGENTS.md) — except the GPL license header block on new files (project convention).
- New files carry the GPL header exactly as in `src/views/CompressView.tsx:1-15`.
- IPC structs untouched — no Rust changes in this plan; `cargo test` must stay green.
- Styling: semantic tokens only (`bg-muted/30`, `border-input`, `text-muted-foreground`) — never raw colors; `gap-*` not `space-y-*`; `size-*` for equal w/h; `cn()` for conditional classes; icons in buttons use `data-icon`, no manual sizing classes.
- Existing tests must keep passing unless this plan explicitly rewrites them.
- Gate runs `tsc` over `src/` including `*.test.tsx` (`noUnusedLocals`, `noUnusedParameters`, strict) — unused imports or locals in step snippets fail `yarn build`; keep snippets lint-clean.
- shadcn CLI resolves style/base automatically from `components.json` — never hand-edit added `src/components/ui/*` files, except the reviewer-approved Task 1 Step 3 `spinner.tsx` a11y hardening (keeps the added file honest without drifting from the registry).

---

### Task 1: Install shadcn blocks

**Files:**
- Create (via CLI): `src/components/ui/card.tsx`, `src/components/ui/field.tsx`, `src/components/ui/scroll-area.tsx`, `src/components/ui/select.tsx`, `src/components/ui/empty.tsx`, `src/components/ui/spinner.tsx`
- Create (hand-written): `src/components/ui/spinner.test.tsx` (see Required Tests)

**Interfaces:**
- Consumes: existing `components.json` (`style: "base-rhea"`, `iconLibrary: "remixicon"`, no preset field).
- Produces: `@/components/ui/{card,field,scroll-area,select,empty,spinner}` — later tasks import from these exact aliases.

**Acceptance Criteria:**
- 6 files exist under `src/components/ui/`; all import primitives from `@base-ui/react/*` (installed package name — NOT `@base-ui-components/react/*`) and icons from `@remixicon/react`
- No `lucide-react` imports in any added file
- `spinner.tsx` is hardened: type omits `children`, `dangerouslySetInnerHTML`, `aria-hidden` and `role` (with never-typed `children`/`dangerouslySetInnerHTML` so a wide-typed SVGProps spread cannot smuggle them); `data-slot="spinner"` and `aria-hidden="true"` are applied after the props spread (cannot be clobbered)
- Gate passes clean: `yarn build && yarn test`

**Required Tests:**
- `src/components/ui/spinner.test.tsx` (cross-task contract pin): spinner root carries `aria-hidden="true"` (even when a consumer passes a conflicting `aria-hidden` through a wide-typed spread); a button rendering `Compress` + `<Spinner />` resolves as `getByRole('button', { name: 'Compress' })`; `queryByRole('status', { hidden: true })` is null; `className` merges with `animate-spin` and `data-icon` passes through; the `data-slot="spinner"` marker is clobber-resistant; compile pins keep `children`/`dangerouslySetInnerHTML` banned. Deviation from the original "no named unit tests required" stance: that stance covered the mechanical CLI add and the compile gate; this test pins the a11y contract the PR reviewers flagged so a future `shadcn add spinner` re-run cannot silently reintroduce name pollution.

- [x] **Step 1: Add components via CLI**

Run from repo root:

```bash
yarn dlx shadcn@latest add card field scroll-area select empty spinner
```

Expected: 6 files created under `src/components/ui/`, no errors.

- [x] **Step 2: Read every added file and verify**

Per the shadcn skill workflow — check: no missing sub-components, imports resolve (`@/lib/utils` etc.), primitives imported from `@base-ui/react/*` (the installed package; `@base-ui-components/react/*` would fail to resolve), icons from `@remixicon/react`, no `lucide-react` leaks. Fix icon/primitive imports if any slipped through. Record the `data-slot` attribute names used by `card.tsx` and `scroll-area.tsx` (needed by Task 6's structural test).

- [x] **Step 3: Harden spinner + add contract test**

`src/components/ui/spinner.tsx`: type becomes
`Omit<React.ComponentProps<"svg">, "children" | "dangerouslySetInnerHTML" | "aria-hidden" | "role"> & { children?: never; dangerouslySetInnerHTML?: never }`;
the props spread moves BEFORE `data-slot="spinner"` and `aria-hidden="true"` so a
consumer cannot clobber the decorative default or the contract marker at runtime,
while `cn("size-4 animate-spin", className)` keeps the className
merge (`<Spinner data-icon="inline-start" />` and `className` must still typecheck).

Create `src/components/ui/spinner.test.tsx` (GPL header block from
`src/views/CompressView.tsx:1-15`) with the contract tests listed in Required Tests:
forced `aria-hidden` (incl. clobber-resistance via a wide-typed spread), exact button
name, no status role (`hidden: true` so the assertion is not vacuous), className merge,
`data-slot` clobber-resistance, and compile pins for the banned `children` /
`dangerouslySetInnerHTML` props.

- [x] **Step 4: Verify gate**

Run: `yarn build && yarn test`
Expected: both pass; no production behavior change (the spinner hardening and its test only tighten the added block).

- [x] **Step 5: Commit**

```bash
git add src/components/ui
git commit -m "feat(ui): add card, field, scroll-area, select, empty, spinner blocks"
```

---

### Task 2: CompressionProvider (Bug 2 — state survives navigation)

**Files:**
- Create: `src/providers/CompressionProvider.tsx`
- Create: `src/providers/CompressionProvider.test.tsx`
- Modify: `src/views/CompressView.tsx` (delete hook calls — full consumer rewrite lands in Task 6; here only swap hook usage to context so nothing breaks twice)
- Modify: `src/App.tsx` (minimal wiring: wrap return tree in `CompressionProvider` so no commit leaves the app runtime-broken; shell changes stay in Task 3)

**Interfaces:**
- Consumes: `useFileList()` from `@/hooks/useFileList` (returns `{ files, error, addFiles, browseFiles, removeFile, clearList, setFiles }`); `useCompression(files, setFiles, callbacks)` from `@/hooks/useCompression` (returns `{ isCompressing, progressByFile, compressAll, cancelFile, cancelAll, revealInFolder }`); `formatSize(bytes: number): string` from `@/components/FileList`.
- Produces: `CompressionProvider` (React component), `useCompressionContext()` returning exactly `{ files, error, addFiles, browseFiles, removeFile, clearList, isCompressing, progressByFile, compressAll, cancelFile, cancelAll, revealInFolder }`.

**Acceptance Criteria:**
- Provider mounts both hooks exactly once; consumer components remount freely without losing `files` state (Bug 2a)
- Re-dropping an already-added path shows still ONE row; a new path appends (Bug 2b visibility — dedup is Rust-side, `commands.rs:41-43`, frontend concat must surface it)
- Events fired while a consumer is unmounted reach the provider and the remounted consumer shows updated status/progress (latent bug: listeners live app-level)
- Toast callbacks (`onBatchComplete`, `onBatchError`) live in the provider; `CompressView` imports no `sonner`
- `useCompressionContext()` outside a provider throws
- Existing hook tests (`useCompression.test.ts`, `useFileList.test.ts`) stay untouched and green
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`

**Required Tests:**
- `shares list state across consumer remounts (view-switch survival)` — provider stays mounted, consumer remounts via `rerender`; row survives
- `re-drop of same path keeps one row and a new path appends` — Bug 2b: one `add_files` call per drop; `[]` (backend dedup) keeps exactly one row; a new entry appends (canonical test name)
- `events fired while consumer unmounted update the remounted consumer` — rerender consumer away, emit `file:complete` + `file:progress`, rerender consumer back, assert updated status/progress (spec §2.1 latent bug)
- `registers IPC listeners exactly once under StrictMode` — registry-style mock (Map<string, Set>), after flush each of the 6 event names has exactly ONE active handler (StrictMode double-mount must leave no duplicates)
- `provider fires batch toasts for complete and error batches` — emit `file:complete` + `batch:complete` → `toast.success` with saved total; emit `batch:error` → `toast.error` (AC: callbacks live in provider)
- `provider surfaces listener registration failure as batch error toast` — `listen` rejects once → `toast.error('Lost connection to compression worker')` (spec §8: port the hook-level guard to provider level)
- `useCompressionContext throws outside provider` — cheap guard assertion

- [x] **Step 1: Write the failing tests**

Create `src/providers/CompressionProvider.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, act } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import type { FileEntry } from '@/types'

const listeners = new Map<string, Set<(e: { payload: unknown }) => void>>()
const unlistens: Array<() => void> = []

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    const set = listeners.get(event) ?? new Set()
    set.add(handler)
    listeners.set(event, set)
    const unlisten = () => {
      set.delete(handler)
    }
    unlistens.push(unlisten)
    return Promise.resolve(unlisten)
  }),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CompressionProvider, useCompressionContext } from '@/providers/CompressionProvider'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'sonner'

const flush = () => act(async () => {})

const emit = (event: string, payload: unknown) =>
  act(() => {
    listeners.get(event)?.forEach((h) => h({ payload }))
  })

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    id: 'f1',
    name: 'a.jpg',
    path: '/t/a.jpg',
    category: 'image',
    targetBytes: 204800,
    originalSize: 1024,
    status: 'pending',
    compressedSize: null,
    outputPath: null,
    error: null,
    ...overrides,
  }
}

function Row({ paths }: { paths: string[] }) {
  const { files, addFiles } = useCompressionContext()
  return (
    <div>
      <button type="button" onClick={() => addFiles(paths)}>
        add
      </button>
      <ul>
        {files.map((f) => (
          <li key={f.id}>
            {f.name}
            {f.status !== 'pending' ? ` (${f.status})` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}

describe('CompressionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listeners.clear()
    unlistens.length = 0
  })

  it('shares list state across consumer remounts (view-switch survival)', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    const { rerender } = render(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
    // Simulate CompressView unmount/remount: consumer dies, provider persists.
    rerender(<CompressionProvider>{null}</CompressionProvider>)
    rerender(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
  })

  it('re-drop of same path keeps one row and a new path appends', async () => {
    // First drop: backend accepts a.jpg.
    vi.mocked(invoke).mockResolvedValueOnce([entry()])
    // Second drop of the same path: backend dedups → returns nothing.
    vi.mocked(invoke).mockResolvedValueOnce([])
    // Third drop: same path + a new one → only the new entry comes back.
    vi.mocked(invoke).mockResolvedValueOnce([entry({ id: 'f2', name: 'b.jpg', path: '/t/b.jpg' })])
    const { rerender } = render(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    const add = async (paths: string[]) => {
      rerender(
        <CompressionProvider>
          <Row paths={paths} />
        </CompressionProvider>
      )
      await act(async () => {
        await screen.getByRole('button', { name: 'add' }).click()
      })
    }
    await add(['/t/a.jpg'])
    expect(screen.getAllByText('a.jpg')).toHaveLength(1)
    // Dedup drop: backend returns [] — frontend must still show exactly one row.
    await add(['/t/a.jpg'])
    expect(screen.getAllByText('a.jpg')).toHaveLength(1)
    // New file appends.
    await add(['/t/a.jpg', '/t/b.jpg'])
    expect(screen.getAllByText('a.jpg')).toHaveLength(1)
    expect(screen.getByText('b.jpg')).toBeInTheDocument()
  })

  it('events fired while consumer unmounted update the remounted consumer', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    const { rerender } = render(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
    // "Navigate away": unmount the consumer while the provider keeps listening.
    rerender(<CompressionProvider>{null}</CompressionProvider>)
    emit('file:progress', { fileId: 'f1', percent: 50 })
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 1024,
      compressedSize: 512,
      status: 'done',
      metTarget: true,
    })
    // "Come back": consumer remounts and must see the final state.
    rerender(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    expect(screen.getByText('a.jpg (done)')).toBeInTheDocument()
  })

  it('registers IPC listeners exactly once under StrictMode', async () => {
    render(
      <StrictMode>
        <CompressionProvider>
          <Row paths={[]} />
        </CompressionProvider>
      </StrictMode>
    )
    await flush()
    // StrictMode double-invokes the mount effect (register → cleanup → register).
    // Final active state: exactly one handler per event name.
    const expected = [
      'file:progress',
      'file:complete',
      'file:error',
      'file:cancelled',
      'batch:complete',
      'batch:error',
    ]
    for (const name of expected) {
      expect(listeners.get(name)?.size).toBe(1)
    }
    expect(listeners.size).toBe(expected.length)
  })

  it('useCompressionContext throws outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(<Row paths={[]} />)).toThrow(
      /must be used within CompressionProvider/
    )
    spy.mockRestore()
  })

  it('provider fires batch toasts for complete and error batches', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    render(
      <CompressionProvider>
        <Row paths={['/t/a.jpg']} />
      </CompressionProvider>
    )
    await flush()
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    emit('file:complete', {
      fileId: 'f1',
      outputPath: '/o/a.jpg',
      originalSize: 1024,
      compressedSize: 512,
      status: 'done',
      metTarget: true,
    })
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 2048 })
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain('Saved 2 KB total')
    emit('batch:error', { batchId: 'b2', errorMessage: 'Output folder not writable' })
    expect(toast.error).toHaveBeenCalledWith('Output folder not writable')
  })

  it('provider surfaces listener registration failure as batch error toast', async () => {
    vi.mocked(listen).mockRejectedValueOnce(new Error('ipc dead'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <CompressionProvider>
        <Row paths={[]} />
      </CompressionProvider>
    )
    await flush()
    expect(toast.error).toHaveBeenCalledWith('Lost connection to compression worker')
    spy.mockRestore()
  })
})
```

- [x] **Step 2: Run tests to verify they fail**

Run: `yarn test src/providers/CompressionProvider.test.tsx`
Expected: FAIL — `Cannot find module '@/providers/CompressionProvider'`

- [x] **Step 3: Create the provider**

Create `src/providers/CompressionProvider.tsx`:

```tsx
// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { createContext, useContext, type ReactNode } from 'react'
import { useFileList } from '@/hooks/useFileList'
import { useCompression } from '@/hooks/useCompression'
import { toast } from 'sonner'
import { formatSize } from '@/components/FileList'

function formatSavedBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  return formatSize(bytes)
}

interface CompressionContextValue {
  files: ReturnType<typeof useFileList>['files']
  error: ReturnType<typeof useFileList>['error']
  addFiles: ReturnType<typeof useFileList>['addFiles']
  browseFiles: ReturnType<typeof useFileList>['browseFiles']
  removeFile: ReturnType<typeof useFileList>['removeFile']
  clearList: ReturnType<typeof useFileList>['clearList']
  isCompressing: ReturnType<typeof useCompression>['isCompressing']
  progressByFile: ReturnType<typeof useCompression>['progressByFile']
  compressAll: ReturnType<typeof useCompression>['compressAll']
  cancelFile: ReturnType<typeof useCompression>['cancelFile']
  cancelAll: ReturnType<typeof useCompression>['cancelAll']
  revealInFolder: ReturnType<typeof useCompression>['revealInFolder']
}

const CompressionContext = createContext<CompressionContextValue | null>(null)

export function CompressionProvider({ children }: { children: ReactNode }) {
  const { files, error, addFiles, browseFiles, removeFile, clearList, setFiles } = useFileList()
  const { isCompressing, progressByFile, compressAll, cancelFile, cancelAll, revealInFolder } =
    useCompression(files, setFiles, {
      onBatchComplete: (saved, count, errorCount) => {
        toast.success(`Compressed ${count} files. Saved ${formatSavedBytes(saved)} total.`)
        if (errorCount > 0) toast.error(`${errorCount} files could not reach target.`)
      },
      onBatchError: (message) => toast.error(message),
    })

  const value: CompressionContextValue = {
    files,
    error,
    addFiles,
    browseFiles,
    removeFile,
    clearList,
    isCompressing,
    progressByFile,
    compressAll,
    cancelFile,
    cancelAll,
    revealInFolder,
  }

  return (
    <CompressionContext.Provider value={value}>{children}</CompressionContext.Provider>
  )
}

export function useCompressionContext(): CompressionContextValue {
  const ctx = useContext(CompressionContext)
  if (!ctx) {
    throw new Error('useCompressionContext must be used within CompressionProvider')
  }
  return ctx
}
```

- [x] **Step 4: Point CompressView at the context (temporary bridge)**

In `src/views/CompressView.tsx`, replace the two hook imports (lines 17–18), the `formatSavedBytes` helper (lines 25–28), and the `useFileList()`/`useCompression(...)` call block (lines 31–45) with:

```tsx
import { useCompressionContext } from '@/providers/CompressionProvider'
```

and inside `CompressView()` replace the `useFileList()`/`useCompression(...)` destructures with a single:

```tsx
const {
  files,
  error,
  addFiles,
  browseFiles,
  removeFile,
  clearList,
  isCompressing,
  progressByFile,
  compressAll,
  cancelFile,
  cancelAll,
  revealInFolder,
} = useCompressionContext()
```

Delete the now-unused `formatSavedBytes` local function and the `toast` import (moved into provider). In `src/views/CompressView.test.tsx`, wrap every `render(<CompressView />)` with the provider:

```tsx
import { CompressionProvider } from '@/providers/CompressionProvider'
const renderView = (ui = <CompressView />) =>
  render(<CompressionProvider>{ui}</CompressionProvider>)
```

and replace each of the 17 bare `render(<CompressView />)` calls with `renderView()`.

- [x] **Step 5: Minimal App wiring (keep runtime working between commits)**

In `src/App.tsx` — import and wrap only (breadcrumb/sidebar/containment stay in Task 3):

```tsx
import { CompressionProvider } from '@/providers/CompressionProvider'
```

```tsx
  return (
    <CompressionProvider>
      <SidebarProvider>
```

close with:

```tsx
      </SidebarProvider>
    </CompressionProvider>
  )
```

- [x] **Step 6: Run tests to verify they pass**

Run: `yarn test src/providers src/views/CompressView.test.tsx src/hooks`
Expected: ALL PASS (provider tests + ported CompressView tests + untouched hook tests).

- [x] **Step 7: Run gate**

Run: `yarn build && yarn test`
Expected: pass.

- [x] **Step 8: Commit**

```bash
git add src/providers src/views/CompressView.tsx src/views/CompressView.test.tsx src/App.tsx
git commit -m "fix(state): lift file list + compression state into app-level provider"
```

---

### Task 3: App shell — flush sidebar, functional breadcrumb, height containment

**Files:**
- Modify: `src/App.tsx`
- Create: `src/App.test.tsx`

**Interfaces:**
- Consumes: `CompressionProvider` (already wrapping the tree since Task 2 — do NOT re-wrap); existing `@/components/ui/{sidebar,breadcrumb,separator}`; `navItems` structure already in `App.tsx:46-62`.
- Produces: shell other tasks render inside — `activeView` state stays in `App`; header breadcrumb shows current view; content wrapper carries `data-testid="view-container"` with `flex min-h-0 flex-1 flex-col overflow-hidden`.

**Acceptance Criteria:**
- Sidebar flush: `[data-slot="sidebar"]` has no `floating` variant (`data-variant` absent or ≠ floating); `collapsible="icon"` retained
- Breadcrumb functional: header shows `Optimizer` root + current view page label; updates on every sidebar navigation; correct for all three views (Compress/History/Settings)
- Content wrapper height-constrains views (`min-h-0 overflow-hidden`) so view-internal scroll regions engage
- Per-view h1 headings ("Compress Files", "Settings") removed in Task 5/6 rewrites — asserted at App level in Task 8 (`per-view headings are removed from the main region`)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`

**Required Tests:**
- `breadcrumb reflects the active view and updates on navigation` — navigate Compress → Settings → History → Compress; page label follows
- `breadcrumb stays correct while the sidebar is collapsed to icon` — click `Toggle Sidebar` (aria-label on `SidebarTrigger`), breadcrumb label unchanged (spec §2.4)
- `sidebar is flush (no floating variant)` — `[data-slot="sidebar"]` `data-variant` ≠ `floating`
- `content wrapper constrains view height (min-h-0 chain)` — `data-testid="view-container"` classes contain `min-h-0` + `overflow-hidden`
- `file list survives navigating to Settings and back (Bug 2a)` — real shell: add file → Settings → Compress → row still present (Step 1b)

- [x] **Step 1: Write the failing test**

Create `src/App.test.tsx`. Two jsdom pitfalls MUST be mocked before render:
1. `window.matchMedia` — `SidebarProvider` → `useIsMobile()` calls it; jsdom lacks it.
2. `sonner` mock must export `Toaster` (`@/components/ui/sonner` re-exports it; `App` renders `<Toaster />`).

```tsx
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  Toaster: () => null,
}))

beforeAll(() => {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList
})

import App from '@/App'

const headerEl = () => document.querySelector('main')!.querySelector('header')!

describe('App shell', () => {
  beforeEach(() => vi.clearAllMocks())

  it('breadcrumb reflects the active view and updates on navigation', async () => {
    const user = userEvent.setup()
    render(<App />)
    // Initial view: Compress
    expect(within(headerEl()).getByText('Optimizer')).toBeInTheDocument()
    expect(within(headerEl()).getByText('Compress')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(within(headerEl()).getByText('Settings')).toBeInTheDocument()
    expect(within(headerEl()).queryByText('Compress')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'History' }))
    expect(within(headerEl()).getByText('History')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    expect(within(headerEl()).getByText('Compress')).toBeInTheDocument()
  })

  it('sidebar is flush (no floating variant)', () => {
    render(<App />)
    const sidebar = document.querySelector('[data-slot="sidebar"]')
    expect(sidebar).not.toBeNull()
    expect(sidebar!.getAttribute('data-variant')).not.toBe('floating')
  })

  it('content wrapper constrains view height (min-h-0 chain)', () => {
    render(<App />)
    const wrapper = screen.getByTestId('view-container')
    expect(wrapper.className).toContain('min-h-0')
    expect(wrapper.className).toContain('overflow-hidden')
  })

  it('breadcrumb stays correct while the sidebar is collapsed to icon', async () => {
    const user = userEvent.setup()
    render(<App />)
    await user.click(screen.getByRole('button', { name: 'Toggle Sidebar' }))
    expect(within(headerEl()).getByText('Compress')).toBeInTheDocument()
  })
})
```

Note: `getByRole('button', { name: 'Settings' })` is unique here because the Settings
view itself is not mounted at query time (conditional rendering); keep name-exact
queries (no regex) to stay collision-safe.

- [x] **Step 1b: Add an App-level Bug 2a regression test**

The provider test simulates a remount; this proves the real shell keeps the provider above the view switch. Append to `src/App.test.tsx`:

```tsx
  it('file list survives navigating to Settings and back (Bug 2a)', async () => {
    const user = userEvent.setup()
    vi.mocked(open).mockResolvedValueOnce('/t/a.jpg')
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        id: 'f1',
        name: 'a.jpg',
        path: '/t/a.jpg',
        category: 'image',
        targetBytes: 204800,
        originalSize: 1024,
        status: 'pending',
        compressedSize: null,
        outputPath: null,
        error: null,
      },
    ])
    render(<App />)
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    expect(await screen.findByText('a.jpg')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    expect(await screen.findByText('a.jpg')).toBeInTheDocument()
  })
```

- [x] **Step 2: Run test to verify it fails**

Run: `yarn test src/App.test.tsx`
Expected: FAIL — no breadcrumb / no `data-testid="view-container"` / sidebar still floating.

- [x] **Step 3: Apply the shell changes**

The tree is already wrapped in `CompressionProvider` (Task 2) — leave that alone.

1. Flush sidebar — `App.tsx:69`: change

```tsx
<Sidebar collapsible="icon" variant="floating">
```

to

```tsx
<Sidebar collapsible="icon">
```

2. Functional breadcrumb header — `App.tsx:121-124` becomes (sidebar-03 pattern):

```tsx
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger />
          <Separator
            orientation="vertical"
            className="mr-2 data-[orientation=vertical]:h-4"
          />
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="#">Optimizer</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>
                  {navItems.find((item) => item.id === activeView)?.label}
                </BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </header>
```

with imports added:

```tsx
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { Separator } from '@/components/ui/separator'
```

3. Height containment — `App.tsx:125` becomes:

```tsx
        <div data-testid="view-container" className="flex min-h-0 flex-1 flex-col overflow-hidden">
```

- [x] **Step 4: Run tests to verify they pass**

Run: `yarn test src/App.test.tsx`
Expected: PASS.

- [x] **Step 5: Run gate**

Run: `yarn build && yarn test`
Expected: pass. (Existing view tests mock their own modules; shell change doesn't affect them.)

- [x] **Step 6: Commit**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "feat(ui): flush sidebar, functional breadcrumb header, view height containment"
```

---

### Task 4: NumberStepper — Base UI NumberField wrapper (Bug 1)

**Files:**
- Create: `src/components/NumberStepper.tsx`
- Create: `src/components/NumberStepper.test.tsx`

**Interfaces:**
- Consumes: `NumberField` from `@base-ui/react/number-field` (installed package name — Base UI v1.8, already a dependency; verify against `src/components/ui/accordion.tsx:1` import style); `RiAddLine`, `RiSubtractLine` from `@remixicon/react`; `cn` from `@/lib/utils`.
- Produces: `NumberStepper({ value, onValueChange, min, max, ariaLabel, id?, className? })` — controlled stepper; `onValueChange` receives the clamped integer; `null`/`NaN` emissions from Base UI are swallowed (never reach the consumer). SettingsView (Task 5) mounts 9 of these.

**Acceptance Criteria:**
- Standard stepper layout: `[−]` button, value input, `[+]` button — flanking the value (user requirement: "similar to how applications usually design them")
- Step 1 everywhere; clamped to `[min, max]`; buttons disabled at bounds (Base UI behavior)
- Manual typing works; empty/invalid input reverts to last valid value on blur; `onValueChange` NEVER receives `null` or `NaN` (contract pinned by spy test — spec §8)
- Input renders `type="text"` (Base UI behavior — NO spinbutton role; queries use `getByLabelText`)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `increments and decrements by 1` — buttons step ±1, display updates
- `disables buttons at bounds` — at `min` Decrease disabled; at `max` Increase disabled (fresh mount per bound — no stale-state rerender)
- `accepts typed values and clamps on blur` — type `999` → blur → display `100` (above-max); type `-50` with `min=-10` → blur → display `-10` (below-min)
- `normalizes invalid typed input to last valid value on blur` — clear → blur → display reverts to the controlled value; `onValueChange` spy NOT called with `null`/`NaN`
- `steps with ArrowUp/ArrowDown` — keyboard stepping ±1
- `Enter and Space in the input do not change the value` — Base UI treats whitespace-only as non-parseable; no step (spec §6)
- `null emissions never reach onValueChange` — stateful harness: clear → blur → spy never called with `null`/`NaN` and last emitted value stays finite (spec §8)

- [ ] **Step 1: Fetch the authoritative API doc**

Per AGENTS.md rules, fetch Context7 `/base-ui-components/react` (or open
`https://base-ui.com/react/components/number-field.md`) and confirm: `Root` props
(`value`, `onValueChange`, `min`, `max`, `step`, `snapOnStep`), and whether `onValueChange`
can emit `null`. Adjust the guard in Step 4 if the signature differs from `(number|null) => void`.

- [ ] **Step 2: Write the failing tests**

Create `src/components/NumberStepper.test.tsx`. Query facts (verified against installed
`@base-ui/react` v1.8): the input renders `type="text"` → role is **textbox**, so query by
label (`getByLabelText`) — never `getByRole('spinbutton')`. `toHaveDisplayValue` works on
text inputs.

```tsx
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NumberStepper } from '@/components/NumberStepper'

const LABEL = 'Images minimum quality'

function Harness({ min, max, initial }: { min: number; max: number; initial: number }) {
  const [value, setValue] = useState(initial)
  return (
    <NumberStepper
      value={value}
      onValueChange={setValue}
      min={min}
      max={max}
      ariaLabel={LABEL}
    />
  )
}

const input = () => screen.getByLabelText(LABEL)
const increase = () => screen.getByRole('button', { name: `Increase ${LABEL}` })
const decrease = () => screen.getByRole('button', { name: `Decrease ${LABEL}` })

describe('NumberStepper', () => {
  it('increments and decrements by 1', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.click(increase())
    expect(input()).toHaveDisplayValue('31')
    await user.click(decrease())
    expect(input()).toHaveDisplayValue('30')
  })

  it('disables buttons at bounds', async () => {
    // Fresh mount per bound — a rerender with new initial would leave stale state.
    const { unmount } = render(<Harness min={0} max={100} initial={0} />)
    expect(decrease()).toBeDisabled()
    expect(increase()).toBeEnabled()
    unmount()
    render(<Harness min={0} max={100} initial={100} />)
    expect(increase()).toBeDisabled()
    expect(decrease()).toBeEnabled()
  })

  it('accepts typed values and clamps on blur', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.clear(input())
    await user.type(input(), '999')
    await user.tab()
    expect(input()).toHaveDisplayValue('100')
    // Below-min clamp on a fresh mount (min=-10 allows the minus sign to be typed).
    const { unmount } = render(<Harness min={-10} max={100} initial={30} />)
    await user.clear(screen.getAllByLabelText(LABEL)[1])
    await user.type(screen.getAllByLabelText(LABEL)[1], '-50')
    await user.tab()
    expect(screen.getAllByLabelText(LABEL)[1]).toHaveDisplayValue('-10')
    unmount()
  })

  it('normalizes invalid typed input to last valid value on blur', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.clear(input())
    await user.tab()
    expect(input()).toHaveDisplayValue('30')
  })

  it('steps with ArrowUp/ArrowDown', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.click(input())
    await user.keyboard('{ArrowUp}')
    expect(input()).toHaveDisplayValue('31')
    await user.keyboard('{ArrowDown}')
    expect(input()).toHaveDisplayValue('30')
  })

  it('null emissions never reach onValueChange', async () => {
    const user = userEvent.setup()
    const spy = vi.fn()
    function SpyHarness() {
      const [value, setValue] = useState(30)
      return (
        <NumberStepper
          value={value}
          onValueChange={(n) => {
            setValue(n)
            spy(n)
          }}
          min={0}
          max={100}
          ariaLabel={LABEL}
        />
      )
    }
    render(<SpyHarness />)
    await user.clear(input())
    await user.tab()
    const calls = spy.mock.calls.flat()
    expect(calls.every((v) => typeof v === 'number' && Number.isFinite(v))).toBe(true)
    expect(calls).not.toContain(null)
    expect(input()).toHaveDisplayValue('30')
  })

  it('Enter and Space in the input do not change the value', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.click(input())
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
    expect(input()).toHaveDisplayValue('30')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `yarn test src/components/NumberStepper.test.tsx`
Expected: FAIL — `Cannot find module '@/components/NumberStepper'`

- [ ] **Step 4: Implement NumberStepper**

Create `src/components/NumberStepper.tsx`:

```tsx
// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { NumberField } from '@base-ui/react/number-field'
import { RiAddLine, RiSubtractLine } from '@remixicon/react'
import { cn } from '@/lib/utils'

interface NumberStepperProps {
  value: number
  onValueChange: (value: number) => void
  min: number
  max: number
  ariaLabel: string
  id?: string
  className?: string
}

export function NumberStepper({
  value,
  onValueChange,
  min,
  max,
  ariaLabel,
  id,
  className,
}: NumberStepperProps) {
  return (
    <NumberField.Root
      value={value}
      onValueChange={(next) => {
        if (next === null || !Number.isFinite(next)) return
        onValueChange(Math.round(next))
      }}
      min={min}
      max={max}
      step={1}
      className={cn('w-24', className)}
    >
      <NumberField.Group className="flex h-9 items-center rounded-md border border-input bg-background/50 shadow-xs outline-none transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <NumberField.Decrement
          aria-label={`Decrease ${ariaLabel}`}
          className="flex size-9 shrink-0 items-center justify-center rounded-l-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <RiSubtractLine data-icon="inline-start" />
        </NumberField.Decrement>
        <NumberField.Input
          id={id}
          aria-label={ariaLabel}
          className="h-full w-full min-w-0 border-x border-input bg-transparent px-2 text-right text-sm tabular-nums outline-none"
        />
        <NumberField.Increment
          aria-label={`Increase ${ariaLabel}`}
          className="flex size-9 shrink-0 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <RiAddLine data-icon="inline-start" />
        </NumberField.Increment>
      </NumberField.Group>
    </NumberField.Root>
  )
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test src/components/NumberStepper.test.tsx`
Expected: PASS (all 7). If Base UI emits typing-restrictions (input blocks letters), the
"invalid typed input" test still passes via empty→blur normalization path.

- [ ] **Step 6: Run gate + commit**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: pass.

```bash
git add src/components/NumberStepper.tsx src/components/NumberStepper.test.tsx
git commit -m "feat(ui): NumberStepper wrapping Base UI NumberField"
```

---

### Task 5: SettingsView rebuild — Cards, Field rows, steppers, selects (Bug 1 + 4a UI)

**Files:**
- Modify: `src/views/SettingsView.tsx` (full rebuild)
- Modify: `src/views/SettingsView.test.tsx`

**Interfaces:**
- Consumes: `NumberStepper` (Task 4), `@/components/ui/{card,field,select}`, existing `useSettings`, `Badge`, `Accordion*`, `Button`. (`Separator` already installed; not used by the rewrite.)
- Produces: unchanged draft/save behavior — `draft` state, `hasChanges`, `handleSave/handleCancel/handleReset/handleBrowse` stay behavior-identical; same `aria-label`s on every control. **Behavior decision pinned:** clearing a stepper input reverts to the last valid value on blur (spec §5 revert-on-blur) — it does NOT coerce to 0; Save stays disabled unless a real change is made.

**Acceptance Criteria:**
- All 9 numeric controls are `NumberStepper` (no native `type="number"` remains in the file)
- Both selects (target unit, min resolution) are shadcn `Select` — no raw `<select>` remains
- Settings rows composed as `FieldGroup`/`Field`/`FieldLabel`/`FieldDescription` inside three Cards (Output Folder, Category Targets, Quality Floors with Advanced accordion)
- Save/Cancel footer stays pinned outside the scroll region (`shrink-0` sibling of the `overflow-y-auto` content div)
- `hasChanges` semantics preserved: stepper controls emit integers, so JSON compare still works
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- Existing `SettingsView.test.tsx` scenarios (load, save, cancel, reset, browse, hasChanges) stay green after selector migration (concrete list in Step 2)
- `settings footer is sibling of the scroll region (pinned, 4a)` — structural: footer `shrink-0` NOT inside the `overflow-y-auto` container
- `renders three cards with card composition` — CardTitle/Description present for Output Folder, Category Targets, Quality Floors
- `stepper buttons step ±1 and mark the draft dirty` — click `Increase Images target size` → display 201 + Save enabled; typing covered by Task 4
- `no native number inputs or select elements remain` — `container.querySelectorAll('input[type="number"], select')` is empty
- `null onValueChange from a mismatched persisted value does not mutate the draft` — raw persisted value retained in the trigger, Save stays disabled; the `if (v !== null)` guard is retained as defense in depth so no invalid state can reach the draft (this flow emits no `onValueChange`)

- [ ] **Step 1: Rewrite SettingsView**

Full replacement body (imports then component — GPL header stays at top of file):

```tsx
import { useState, useEffect } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { NumberStepper } from '@/components/NumberStepper'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Settings, CategoryTarget } from '@/types'
```

Keep `categories`, `updateTarget`, `updateFloor`, `handleBrowse`, `handleSave`,
`handleCancel`, `handleReset`, `hasChanges` exactly as in the current file
(`SettingsView.tsx:31-114`). Replace the JSX return (current `SettingsView.tsx:116-328`) with:

```tsx
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-muted-foreground">Preferences</h2>
          <button
            type="button"
            onClick={handleReset}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            Reset to defaults
          </button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Output Folder</CardTitle>
            <CardDescription>
              Compressed files are saved here. Originals are never modified.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="flex h-9 flex-1 items-center gap-2 rounded-md border border-input bg-background/50 px-3 text-sm text-muted-foreground">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0"
                  aria-hidden="true"
                >
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span className="truncate">{draft.outputFolder}</span>
              </div>
              <Button variant="outline" size="sm" onClick={handleBrowse}>
                Browse
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Category Targets</CardTitle>
            <CardDescription>
              Maximum file size per category. Applied to all files in that category.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FieldGroup>
              {categories.map((cat) => {
                const target = draft.categoryTargets[cat.key] ?? { size: 0, unit: 'KB' }
                return (
                  <Field key={cat.key}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2.5">
                        <Badge variant="secondary">{cat.badge}</Badge>
                        <FieldLabel htmlFor={`${cat.key}-size`} className="text-sm">
                          {cat.label}
                        </FieldLabel>
                        <span className="text-xs text-muted-foreground">{cat.formats}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id={`${cat.key}-size`}
                          value={target.size}
                          onValueChange={(n) => updateTarget(cat.key, 'size', n)}
                          min={0}
                          max={4096}
                          ariaLabel={`${cat.label} target size`}
                          className="w-20"
                        />
                        <Select
                          value={target.unit}
                          onValueChange={(v) => { if (v !== null) updateTarget(cat.key, 'unit', v) }}
                        >
                          <SelectTrigger
                            aria-label={`${cat.label} target unit`}
                            className="w-20"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="KB">KB</SelectItem>
                            <SelectItem value="MB">MB</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  </Field>
                )
              })}
            </FieldGroup>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Quality Floors</CardTitle>
            <CardDescription>
              Engine stops compressing below these values and reports best effort.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion>
              <AccordionItem value="quality-floors">
                <AccordionTrigger className="text-sm font-medium">
                  Advanced
                </AccordionTrigger>
                <AccordionContent className="space-y-3 pt-2">
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="image-min-quality" className="text-sm">
                        Images minimum quality
                      </FieldLabel>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id="image-min-quality"
                          value={draft.qualityFloors.image.minQuality}
                          onValueChange={(n) => updateFloor('image.minQuality', n)}
                          min={0}
                          max={100}
                          ariaLabel="Images minimum quality"
                          className="w-20"
                        />
                        <span className="w-4 text-xs text-muted-foreground">%</span>
                      </div>
                    </div>
                    <FieldDescription>Minimum JPEG/PNG quality percentage.</FieldDescription>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="video-min-crf" className="text-sm">
                        Videos minimum CRF
                      </FieldLabel>
                      <NumberStepper
                        id="video-min-crf"
                        value={draft.qualityFloors.video.minCrf}
                        onValueChange={(n) => updateFloor('video.minCrf', n)}
                        min={0}
                        max={51}
                        ariaLabel="Videos minimum CRF"
                        className="w-20"
                      />
                    </div>
                    <FieldDescription>Higher CRF = lower quality floor.</FieldDescription>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel className="text-sm">Videos minimum resolution</FieldLabel>
                      <Select
                        value={draft.qualityFloors.video.minResolution}
                        onValueChange={(v) => { if (v !== null) updateFloor('video.minResolution', v) }}
                      >
                        <SelectTrigger
                          aria-label="Videos minimum resolution"
                          className="w-24"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="480p">480p</SelectItem>
                          <SelectItem value="720p">720p</SelectItem>
                          <SelectItem value="1080p">1080p</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="pdf-min-dpi" className="text-sm">
                        PDF minimum DPI
                      </FieldLabel>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id="pdf-min-dpi"
                          value={draft.qualityFloors.pdf.minDpi}
                          onValueChange={(n) => updateFloor('pdf.minDpi', n)}
                          min={0}
                          max={600}
                          ariaLabel="PDF minimum DPI"
                          className="w-20"
                        />
                        <span className="w-6 text-xs text-muted-foreground">dpi</span>
                      </div>
                    </div>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="pdf-min-jpeg-quality" className="text-sm">
                        PDF minimum JPEG quality
                      </FieldLabel>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id="pdf-min-jpeg-quality"
                          value={draft.qualityFloors.pdf.minJpegQuality}
                          onValueChange={(n) => updateFloor('pdf.minJpegQuality', n)}
                          min={0}
                          max={100}
                          ariaLabel="PDF minimum JPEG quality"
                          className="w-20"
                        />
                        <span className="w-4 text-xs text-muted-foreground">%</span>
                      </div>
                    </div>
                  </Field>
                  <Field>
                    <div className="flex items-center justify-between gap-3">
                      <FieldLabel htmlFor="document-min-media-quality" className="text-sm">
                        Documents media quality
                      </FieldLabel>
                      <div className="flex items-center gap-1.5">
                        <NumberStepper
                          id="document-min-media-quality"
                          value={draft.qualityFloors.document.minMediaQuality}
                          onValueChange={(n) => updateFloor('document.minMediaQuality', n)}
                          min={0}
                          max={100}
                          ariaLabel="Documents media quality"
                          className="w-20"
                        />
                        <span className="w-4 text-xs text-muted-foreground">%</span>
                      </div>
                    </div>
                  </Field>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      </div>

      {error && (
        <div
          role="alert"
          className="shrink-0 border-t border-destructive/50 bg-destructive/10 px-6 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <div className="flex shrink-0 justify-end gap-2 border-t border-border bg-card p-4">
        <Button variant="ghost" onClick={handleCancel} disabled={!hasChanges}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges || isSaving}>
          Save Changes
        </Button>
      </div>
    </div>
  )
```

Executor checks against the installed `field.tsx`/`select.tsx` (Task 1 files) and adapts
prop names if the base-style exports differ (e.g. `SelectTrigger` render prop). The
`Accordion` composition above matches the current installed `accordion.tsx` usage —
keep `<Accordion>`/`<AccordionItem value>` exactly as the existing file uses them.

- [ ] **Step 2: Update SettingsView tests**

`src/views/SettingsView.test.tsx` selector migration — concrete, per analyzer findings.
Base UI renders steppers as `type="text"` inputs and Selects as `role="combobox"` buttons,
so:

1. **Stepper value assertions** — every `toHaveValue(<number>)` on a numeric stepper input
   (lines 65-68, 85-86, 88-90, 148, 158, 174, 204, 215, 217, 218) becomes
   `toHaveDisplayValue('200')` (string form) — jest-dom only coerces numbers for
   `type="number"` inputs; Base UI renders steppers as `type="text"`.
2. **Stepper queries** — `getByLabelText('Images target size')` etc. keep working
   (aria-label preserved on the input); button steps use
   `getByRole('button', { name: 'Increase Images target size' })`.
3. **Select value assertions** — `toHaveValue('KB')` / `toHaveValue('480p')` on the
   unit/resolution selects (line 87 for `Videos minimum resolution`, lines 69-72, 216,
   219) becomes asserting the trigger's visible text:
   `expect(screen.getByLabelText('Images target unit')).toHaveTextContent('KB')`.
4. **Select interaction** — `user.selectOptions(...)` THROWS on non-`<select>` elements
   (lines 124, 232): replace with a click-open + option-pick helper (Base UI
   SelectContent portals, so `screen`/`within(document.body)` queries find it):

```tsx
async function pickOption(user: ReturnType<typeof userEvent.setup>, triggerLabel: string, option: string) {
  await user.click(screen.getByLabelText(triggerLabel))
  await user.click(await screen.findByRole('option', { name: option }))
}
// await pickOption(user, 'Images target unit', 'MB')
```

5. **Accordion trigger** — `user.click(screen.getByText(/Quality Floors/))`
   (line 84; line 225 for the other flow) breaks: that text moved to the non-interactive
   `CardTitle`; the trigger label is now `Advanced`. Click
   `getByRole('button', { name: /advanced/i })`. Line 77
   (`expect(screen.getByText(/Quality Floors/))`) survives — the CardTitle renders the
   same text.
6. **Empty-input semantics change** — the old "empty target input coerces to 0" test
   (lines 199-206) contradicts the pinned revert-on-blur behavior: `user.clear` + blur
   now REVERTS to the previous value and Save stays disabled. Rewrite the test to
   assert the new behavior: clear → blur → value unchanged → Save disabled.
7. Keep every scenario name and the load/save/cancel/reset/browse flows otherwise intact.
   Line 158/174 (`cancel reverts draft`, save assertion) and line 148's `toHaveValue(2005)`
   rely on Base UI's caret-at-end focus (`focusInput` in `NumberFieldRoot.mjs`) so
   `user.type(img, '5')` appends → `2005`; keep the append-style typing.
8. Both new structural tests must await load (first paint is the "Loading settings…" branch):
   use the file's existing `loadView()` helper or `await screen.findByText('Output Folder')`.
9. Add the five new tests (two structural + three control):

```tsx
  it('settings footer is sibling of the scroll region (pinned, 4a)', async () => {
    await loadView()
    const footer = screen.getByRole('button', { name: 'Save Changes' }).closest(
      '.shrink-0.border-t'
    )
    const scrollRegion = footer!.previousElementSibling!
    expect(scrollRegion.className).toContain('overflow-y-auto')
    expect(scrollRegion.contains(footer)).toBe(false)
  })

  it('renders three cards with card composition', async () => {
    await loadView()
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(3)
    expect(screen.getByText('Output Folder')).toBeInTheDocument()
    expect(screen.getByText('Category Targets')).toBeInTheDocument()
    expect(screen.getByText('Quality Floors')).toBeInTheDocument()
  })

  it('stepper buttons step ±1 and mark the draft dirty', async () => {
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Increase Images target size' }))
    expect(screen.getByLabelText('Images target size')).toHaveDisplayValue('201')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeEnabled()
  })

  it('no native number inputs or select elements remain', async () => {
    const { container } = render(<SettingsView />)
    await screen.findByLabelText('Images target size')
    expect(container.querySelectorAll('input[type="number"], select')).toHaveLength(0)
  })

  it('null onValueChange from a mismatched persisted value does not mutate the draft', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(
      structuredClone({
        ...baseSettings,
        qualityFloors: {
          ...baseSettings.qualityFloors,
          video: { ...baseSettings.qualityFloors.video, minResolution: '1280x720' },
        },
      })
    )
    await loadView()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /advanced/i }))
    const trigger = await screen.findByLabelText('Videos minimum resolution')
    expect(trigger).toHaveTextContent('1280x720')
    await user.click(trigger)
    await screen.findByRole('option', { name: '480p' })
    await user.keyboard('{Escape}')
    expect(trigger).toHaveTextContent('1280x720')
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
  })
```

Verified against Base UI v1.8 in jsdom: with a mismatched controlled value the
trigger renders the raw persisted value, and open + Escape emits no `onValueChange`
(in this option list, null is only emitted when the item registry changes while the
popup is mounted — e.g. an option unmounts — which the static option list never does).
This test therefore pins the observable contract: no crash, raw `'1280x720'` retained
in the trigger, draft untouched so Save stays disabled. The `if (v !== null)` guard
stays as defensive hardening so any future Base UI emission that does reach
`onValueChange` can never write `null` into the settings JSON — no invalid state can
reach the draft.

(Use the real `data-slot="card"` value recorded in Task 1 Step 2.)

- [ ] **Step 3: Run tests**

Run: `yarn test src/views/SettingsView.test.tsx`
Expected: PASS.

- [ ] **Step 4: Run gate + commit**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: pass.

```bash
git add src/views/SettingsView.tsx src/views/SettingsView.test.tsx
git commit -m "feat(ui): settings cards, field rows, NumberStepper and Select controls"
```

---

### Task 6: CompressView rebuild + pinned summary footer (Bug 4c UI)

**Files:**
- Modify: `src/views/CompressView.tsx` (full rebuild)
- Modify: `src/views/CompressView.test.tsx`

**Interfaces:**
- Consumes: `useCompressionContext()` (Task 2), `DropZone` (Task 7 API unchanged), `FileList` (unchanged), `@/components/ui/{card,scroll-area,spinner,empty}`, `Button`, `toast` no longer imported here.
- Produces: compress view layout other tasks/tests rely on — `data-testid="batch-summary"` preserved; DropZone mounted before file list; summary inside Card footer.

**Acceptance Criteria:**
- Layout per spec §2.5/§2.3: DropZone + error banner pinned (`shrink-0`); file list Card scrolls internally (`ScrollArea` + `flex-1 min-h-0`); summary/actions in `CardFooter` always visible
- All 17 existing CompressView scenarios keep passing (only `renderView()` wrap + heading removal)
- Spinner shows inside the Compress button while compressing
- Empty state (no files) renders the `Empty` composition Card
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`

**Required Tests:**
- 17 ported scenarios (unchanged assertions): summary counts, toasts, cancel visibility, banner — via `renderView()`
- `summary footer sits outside the scroll container` — structural (summary + action buttons NOT inside the scroll region)
- `drop zone is pinned outside the file-list card` — structural (DropZone NOT inside the list Card)
- `compress button shows spinner while compressing` — busy state visible (spec §4); asserts NO spinner before click, exact `[data-slot="spinner"]` marker while compressing, and spinner gone after `batch:complete`
- `compress button exposes aria-busy while compressing` — busy state announced (spec §4)
- `renders empty state when no files` — `Empty` composition visible (no files yet)

- [ ] **Step 1: Rewrite CompressView**

Full replacement body (GPL header stays; keep `formatSavedBytes` removed in Task 2 —
do not re-add it here):

```tsx
import { useCompressionContext } from '@/providers/CompressionProvider'
import { DropZone } from '@/components/DropZone'
import { FileList } from '@/components/FileList'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Card, CardContent, CardFooter } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { RiFileAddLine } from '@remixicon/react'
import type { FileStatus } from '@/types'

export function CompressView() {
  const {
    files,
    error,
    isCompressing,
    progressByFile,
    compressAll,
    cancelFile,
    cancelAll,
    revealInFolder,
    removeFile,
    clearList,
    addFiles,
    browseFiles,
  } = useCompressionContext()

  const pendingCount = files.filter((f) => f.status === 'pending').length
  const doneCount = files.filter(
    (f) => f.status === 'done' || f.status === 'already_under_target'
  ).length
  const canCompress = pendingCount > 0 && !isCompressing
  const hasFiles = files.length > 0

  const statusCount = (status: FileStatus) => files.filter((f) => f.status === status).length

  const summarySegments: string[] = [`${files.length} files`]
  if (doneCount > 0) summarySegments.push(`${doneCount} done`)
  if (statusCount('compressing') > 0)
    summarySegments.push(`${statusCount('compressing')} compressing`)
  if (pendingCount > 0) summarySegments.push(`${pendingCount} pending`)
  if (statusCount('best_effort') > 0)
    summarySegments.push(`${statusCount('best_effort')} warning`)
  if (statusCount('unsupported') > 0)
    summarySegments.push(`${statusCount('unsupported')} skipped`)
  if (statusCount('failed') > 0) summarySegments.push(`${statusCount('failed')} failed`)
  if (statusCount('cancelled') > 0)
    summarySegments.push(`${statusCount('cancelled')} cancelled`)
  const summaryText = summarySegments.join(' · ')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-hidden p-5">
      {error && (
        <div
          role="alert"
          className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <DropZone onBrowse={browseFiles} onDrop={addFiles} className="shrink-0" />

      {hasFiles ? (
        <Card className="flex min-h-0 flex-1 flex-col">
          <CardContent className="min-h-0 flex-1 p-0">
            <ScrollArea className="h-full">
              <FileList
                files={files}
                onRemove={removeFile}
                progress={progressByFile}
                onReveal={revealInFolder}
                onCancel={cancelFile}
                removeDisabled={isCompressing}
              />
            </ScrollArea>
          </CardContent>
          <CardFooter className="justify-between gap-2 border-t px-4">
            <div
              data-testid="batch-summary"
              className="text-xs text-muted-foreground tabular-nums"
            >
              {summaryText}
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={compressAll} disabled={!canCompress} aria-busy={isCompressing}>
                {isCompressing && <Spinner data-icon="inline-start" />}
                Compress
              </Button>
              {isCompressing && (
                <Button size="sm" variant="destructive" onClick={cancelAll}>
                  Cancel All
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={clearList}
                disabled={isCompressing}
              >
                Clear List
              </Button>
            </div>
          </CardFooter>
        </Card>
      ) : (
        <Card className="flex flex-1 flex-col justify-center">
          <CardContent>
            <Empty className="border-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RiFileAddLine />
                </EmptyMedia>
                <EmptyTitle>No files yet</EmptyTitle>
                <EmptyDescription>
                  Drop files above to get started.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
```

Executor checks the installed `spinner.tsx`/`scroll-area.tsx`/`empty.tsx` exports
(Task 1 files) and adapts subcomponent names if the base-style exports differ.

- [ ] **Step 2: Port the view tests**

In `src/views/CompressView.test.tsx` (already provider-wrapped since Task 2):
- Update the click target used by `addFilesInView` — DropZone markup changes in Task 7;
  at THIS task keep the `getByRole('button', { name: /drop files/i })` selector working by
  keeping an accessible name on the DropZone root (Task 7 preserves `aria-label`).
- All 17 existing scenarios keep their assertions (`batch-summary` testid, button names
  `Compress`/`Cancel All`/`Clear List`, toasts). No heading assertion exists today
  (verified) — the "Compress Files" h1 removal needs no test edit.
- Replace the old structural draft with these five tests:

```tsx
  it('summary footer sits outside the scroll container', async () => {
    renderView()
    await addFileInView()
    const card = screen.getByTestId('batch-summary').closest('[data-slot="card"]')!
    const scrollArea = card.querySelector('[data-slot="scroll-area"]')!
    const summary = card.querySelector('[data-testid="batch-summary"]')!
    expect(card.contains(scrollArea)).toBe(true)
    expect(scrollArea.contains(summary)).toBe(false)
  })

  it('drop zone is pinned outside the file-list card', async () => {
    renderView()
    await addFileInView()
    const listCard = screen.getByTestId('batch-summary').closest('[data-slot="card"]')
    const dropzone = screen.getByRole('button', { name: /drop files/i })
    expect(listCard!.contains(dropzone)).toBe(false)
  })

  it('renders empty state when no files', () => {
    renderView()
    const emptyCard = screen.getByText('No files yet').closest('[data-slot="card"]')
    expect(emptyCard).not.toBeNull()
  })

  it('compress button shows spinner while compressing', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    const btn = screen.getByRole('button', { name: 'Compress' })
    expect(btn.querySelector('[data-slot="spinner"]')).toBeNull()
    await user.click(btn)
    await screen.findByRole('button', { name: 'Cancel All' })
    expect(btn.querySelector('[data-slot="spinner"]')).not.toBeNull()
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 0 })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Cancel All' })).not.toBeInTheDocument()
    )
    expect(btn.querySelector('[data-slot="spinner"]')).toBeNull()
  })

  it('compress button exposes aria-busy while compressing', async () => {
    const user = userEvent.setup()
    renderView()
    await addFileInView()
    const btn = screen.getByRole('button', { name: 'Compress' })
    expect(btn).toHaveAttribute('aria-busy', 'false')
    await user.click(btn)
    await screen.findByRole('button', { name: 'Cancel All' })
    expect(btn).toHaveAttribute('aria-busy', 'true')
    emit('batch:complete', { batchId: 'b1', totalSavedBytes: 0 })
    await waitFor(() => expect(btn).toHaveAttribute('aria-busy', 'false'))
  })
```

(Use the real `data-slot` names recorded in Task 1 Step 2 if they differ. The
`expect(...)!.` non-null form keeps strict `tsc` happy — `querySelector`/`closest`
return `Element | null`.)

- [ ] **Step 3: Run tests**

Run: `yarn test src/views/CompressView.test.tsx src/components/FileList.test.tsx`
Expected: PASS.

- [ ] **Step 4: Run gate + commit**

Run: `yarn build && yarn test`
Expected: pass.

```bash
git add src/views/CompressView.tsx src/views/CompressView.test.tsx
git commit -m "feat(ui): compress view cards with pinned summary footer and scroll containment"
```

---

### Task 7: DropZone redesign — split panel (Bug 4b)

**Files:**
- Modify: `src/components/DropZone.tsx` (full rewrite)
- Modify: `src/components/DropZone.test.tsx`

**Interfaces:**
- Consumes: `@/components/ui/{card,separator,button}`, `RiUploadCloud2Line` from `@remixicon/react`; existing webview drag-drop effect (kept verbatim from current `DropZone.tsx:34-73`).
- Produces: same props `{ onBrowse, onDrop, className? }`; root keeps accessible name matching `/drop files/i` (CompressView tests depend on it) and the drag-state behavior.

**Acceptance Criteria:**
- Split panel per spec §2.6 sketch: left = cloud icon + "Drag and drop"; vertical Separator; right = "Or choose a file" + primary Browse button + supported-formats hint
- Entire card is the drop target AND click-to-browse target; keyboard access preserved (`role="button"`, `tabIndex`, Enter/Space)
- Browse opens EXACTLY once per interaction — mouse click on inner button, mouse click on card, and Enter on focused inner button all fire `onBrowse` once (no double-fire)
- Drag states via semantic tokens only; `border-primary bg-primary/5` while dragging
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test`

**Required Tests:**
- All 8 existing DropZone scenarios stay green (enter/over/drop payloads, drag classes, empty drop, subscription failures)
- `inner browse button fires onBrowse exactly once` — click `Browse your files` → `toHaveBeenCalledTimes(1)`
- `card click outside the button fires onBrowse exactly once` — click card body → `toHaveBeenCalledTimes(1)`
- `Enter on focused browse button fires onBrowse exactly once` — keyboard double-fire guard (button keydown must not bubble into card handler)
- `Space on focused browse button fires onBrowse exactly once` — same guard for the Space key path

- [ ] **Step 1: Rewrite DropZone**

Keep the existing imports/hooks (`useState`, `useCallback`, `useEffect`, `useRef`,
`getCurrentWebview` logic at `DropZone.tsx:34-73`, `handleKeyDown` at `:75-80`) and
replace ONLY the returned JSX (`DropZone.tsx:82-105`) with:

```tsx
  return (
    <Card
      onClick={onBrowse}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-label="Drop files to compress or click to browse"
      className={`cursor-pointer transition-colors ${
        isDragging
          ? 'border-primary bg-primary/5'
          : 'bg-muted/30 hover:bg-muted/50'
      } ${className ?? ''}`}
    >
      <CardContent className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 py-8">
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <RiUploadCloud2Line size={24} />
          </div>
          <p className="text-sm font-medium">Drag and drop</p>
        </div>
        <Separator orientation="vertical" className="h-20" />
        <div className="flex flex-col items-center gap-2.5">
          <p className="text-sm font-medium">Or choose a file</p>
          <Button
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              onBrowse()
            }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            Browse your files
          </Button>
          <p className="text-xs text-muted-foreground">
            Supported: JPEG, PNG, WebP, HEIC, MP4, MOV, PDF, DOCX, XLSX, PPTX
          </p>
        </div>
      </CardContent>
    </Card>
  )
```

The `onKeyDown={(e) => e.stopPropagation()}` on the inner Button is REQUIRED — without
it, Enter/Space on the focused button bubbles to the card's `handleKeyDown` and fires
browse twice.

Imports to add: `Card`, `CardContent` from `@/components/ui/card`; `Separator` from
`@/components/ui/separator`; `RiUploadCloud2Line` from `@remixicon/react`.

- [ ] **Step 2: Add the double-fire tests**

In `src/components/DropZone.test.tsx` — keep all 8 existing scenarios (markup
assertions survive: card keeps `role="button"` + the same `aria-label`; dragging class
`border-primary` kept), then add:

```tsx
  it('inner browse button fires onBrowse exactly once', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    await user.click(screen.getByRole('button', { name: 'Browse your files' }))
    expect(onBrowse).toHaveBeenCalledTimes(1)
  })

  it('card click outside the button fires onBrowse exactly once', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    await user.click(screen.getByText('Drag and drop'))
    expect(onBrowse).toHaveBeenCalledTimes(1)
  })

  it('Enter on focused browse button fires onBrowse exactly once', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    const btn = screen.getByRole('button', { name: 'Browse your files' })
    btn.focus()
    await user.keyboard('{Enter}')
    expect(onBrowse).toHaveBeenCalledTimes(1)
  })

  it('Space on focused browse button fires onBrowse exactly once', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    const onDrop = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    const btn = screen.getByRole('button', { name: 'Browse your files' })
    btn.focus()
    await user.keyboard(' ')
    expect(onBrowse).toHaveBeenCalledTimes(1)
  })
```

Declare the `onBrowse`/`onDrop` mocks inside each `it` exactly as above (the existing file
declares its mocks per test — do not hoist them to module scope).

- [ ] **Step 3: Run tests**

Run: `yarn test src/components/DropZone.test.tsx src/views/CompressView.test.tsx`
Expected: PASS (CompressView's drop-files selector still matches the card's
`aria-label`).

- [ ] **Step 4: Run gate + commit**

Run: `yarn build && yarn test`
Expected: pass.

```bash
git add src/components/DropZone.tsx src/components/DropZone.test.tsx
git commit -m "feat(ui): split-panel drop zone with browse button and format hints"
```

---

### Task 8: HistoryView + final verification

**Files:**
- Modify: `src/views/HistoryView.tsx`
- Modify: `src/App.test.tsx` (Step 1c heading-removal test)
- Create: `docs/superpowers/plans/2026-09-30-manual-testing-1-acceptance-table.md` (only if any criterion can't be proven by a named test — otherwise the table in Task 8 Step 3 suffices)

**Interfaces:**
- Consumes: `@/components/ui/{card,empty}`.
- Produces: History placeholder; final acceptance mapping below is the implementer's AC gate.

**Acceptance Criteria:**
- History renders one empty-state Card with `Empty` composition ("No history yet")
- Every plan-level criterion maps to a NAMED passing test (table below) — no hand-waved ✅
- Rust untouched: `cargo test` stays green (dedup contract still guarded by `test_add_files_deduplicates_exact_canonical`, `commands.rs:317`)
- Full manual smoke performed (Step 4)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `renders history empty state` — 'No history yet' text + one Card (new, Step 1b)
- `per-view headings are removed from the main region` — App-level h1 removal assertion appended in Step 1c
- Acceptance matrix below (every row = a named test that exists by Task 8)

- [ ] **Step 1: Rewrite HistoryView**

```tsx
import { Card, CardContent } from '@/components/ui/card'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty'
import { RiHistoryLine } from '@remixicon/react'

export function HistoryView() {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-6">
      <Card className="flex flex-1 flex-col justify-center">
        <CardContent>
          <Empty className="border-0">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <RiHistoryLine />
              </EmptyMedia>
              <EmptyTitle>No history yet</EmptyTitle>
              <EmptyDescription>
                Compression history will appear here in a future update.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    </div>
  )
}
```

Executor adapts `Empty` subcomponent names to the installed `empty.tsx`.

- [ ] **Step 1b: Add HistoryView test**

Create `src/views/HistoryView.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { HistoryView } from '@/views/HistoryView'

describe('HistoryView', () => {
  it('renders history empty state', () => {
    render(<HistoryView />)
    expect(screen.getByText('No history yet')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-slot="card"]')).toHaveLength(1)
  })
})
```

- [ ] **Step 1c: Add App-level heading-removal test**

Both view rewrites (Tasks 5/6) are done by now. Append to `src/App.test.tsx`:

```tsx
  it('per-view headings are removed from the main region', async () => {
    const user = userEvent.setup()
    render(<App />)
    const main = document.querySelector('main')!
    expect(
      within(main).queryByRole('heading', { name: 'Compress Files' })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(
      within(main).queryByRole('heading', { name: 'Settings' })
    ).not.toBeInTheDocument()
  })
```

- [ ] **Step 2: Run gate**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: all pass.

- [ ] **Step 3: Acceptance check (all proven by named tests — no hand-waved ✅)**

| Criterion (spec §) | Proving test (exact name, exists by this task) |
|---|---|
| State survives view switch (Bug 2a) | `shares list state across consumer remounts (view-switch survival)` (CompressionProvider.test.tsx) + `file list survives navigating to Settings and back (Bug 2a)` (App.test.tsx, real shell) |
| Re-drop deduped, no empty visual (Bug 2b) | `re-drop of same path keeps one row and a new path appends` (CompressionProvider.test.tsx) + Rust `test_add_files_deduplicates_exact_canonical` stays green |
| Listeners once, StrictMode-safe | `registers IPC listeners exactly once under StrictMode` (CompressionProvider.test.tsx) |
| Events survive navigation (latent) | `events fired while consumer unmounted update the remounted consumer` (CompressionProvider.test.tsx) |
| Context guard | `useCompressionContext throws outside provider` |
| Provider toast callbacks | `provider fires batch toasts for complete and error batches` + `provider surfaces listener registration failure as batch error toast` (CompressionProvider.test.tsx) |
| Stepper ±1, clamp, typing, keys, Enter/Space, null-guard | 7 NumberStepper.test.tsx tests |
| Settings save/cancel/reset flows | existing `SettingsView.test.tsx` scenarios (migrated per Task 5 Step 2) |
| Footer pinned on Settings (4a) | `settings footer is sibling of the scroll region (pinned, 4a)` (SettingsView.test.tsx) |
| Only table scrolls on Compress (4c) | `summary footer sits outside the scroll container` + `drop zone is pinned outside the file-list card` (CompressView.test.tsx) |
| Compress busy state | `compress button shows spinner while compressing` (no spinner → spinner → gone) + `compress button exposes aria-busy while compressing` |
| Empty states | `renders empty state when no files` + `renders history empty state` |
| Drop zone split panel + single-fire (4b) | 4 double-fire tests (DropZone.test.tsx) + all 8 existing scenarios |
| Breadcrumb functional (all 3 views, collapse-safe) | `breadcrumb reflects the active view and updates on navigation` + `breadcrumb stays correct while the sidebar is collapsed to icon` (App.test.tsx) |
| Sidebar flush | `sidebar is flush (no floating variant)` (App.test.tsx) |
| Height containment (4a/4c root) | `content wrapper constrains view height (min-h-0 chain)` (App.test.tsx) |
| Per-view headings removed | `per-view headings are removed from the main region` (App.test.tsx) |

- [ ] **Step 4: Manual smoke (deferred items only)**

1. `yarn dev` in browser at 700×500 window: Settings footer visible without scrolling; Compress drop zone + footer pinned; only table scrolls.
2. `yarn tauri dev`: drop file → navigate to Settings mid-compression → return Compress → row present and status updated.

- [ ] **Step 5: Commit**

```bash
git add src/views/HistoryView.tsx src/App.test.tsx docs/superpowers/plans/2026-09-30-manual-testing-1-acceptance-table.md 2>/dev/null || git add src/views/HistoryView.tsx src/App.test.tsx
git commit -m "feat(ui): history empty-state card; manual testing 1 acceptance check"
```
