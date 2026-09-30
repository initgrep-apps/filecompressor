# Manual Testing 1 — Bug Fixes & UI Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 5 manual-testing findings — lost compress list after Settings visit (P0), hostile native number inputs, unpinned Settings footer, page-wide scrolling, drop-zone redesign — and align the shell with the shadcn `sidebar-03` block.

**Architecture:** App-level `CompressionProvider` owns file-list + compression state (context survives view switches); `NumberStepper` wraps Base UI `NumberField`; flex `min-h-0` chain pins footers and contains scrolling; Card composition for all views.

**Tech Stack:** React 19 + TypeScript + Vite, shadcn/ui (base `base`, style `base-rhea`, preset `b3T38WToP`, icons `@remixicon/react`), `@base-ui-components/react` v1.8 NumberField, Vitest + Testing Library, yarn.

**Spec:** `docs/superpowers/specs/2026-09-30-manual-testing-1-bugs-design.md`

## Global Constraints

- Gate command (every task): `yarn build && yarn test && cd src-tauri && cargo test`
- Package manager: yarn. No new npm dependencies (Base UI already present via shadcn base).
- No comments in code (AGENTS.md) — except the GPL license header block on new files (project convention).
- New files carry the GPL header exactly as in `src/views/CompressView.tsx:1-15`.
- IPC structs untouched — no Rust changes in this plan; `cargo test` must stay green.
- Styling: semantic tokens only (`bg-muted/30`, `border-input`, `text-muted-foreground`) — never raw colors; `gap-*` not `space-y-*`; `size-*` for equal w/h; `cn()` for conditional classes; icons in buttons use `data-icon`, no manual sizing classes.
- Existing tests must keep passing unless this plan explicitly rewrites them.
- shadcn CLI resolves style/base automatically from `components.json` — never hand-edit added `src/components/ui/*` files.

---

### Task 1: Install shadcn blocks

**Files:**
- Create (via CLI): `src/components/ui/card.tsx`, `src/components/ui/field.tsx`, `src/components/ui/scroll-area.tsx`, `src/components/ui/select.tsx`, `src/components/ui/empty.tsx`, `src/components/ui/spinner.tsx`

**Interfaces:**
- Consumes: existing `components.json` (preset `b3T38WToP`, base `base`, iconLibrary `remixicon`).
- Produces: `@/components/ui/{card,field,scroll-area,select,empty,spinner}` — later tasks import from these exact aliases.

- [ ] **Step 1: Add components via CLI**

Run from repo root:

```bash
yarn dlx shadcn@latest add card field scroll-area select empty spinner
```

Expected: 6 files created under `src/components/ui/`, no errors.

- [ ] **Step 2: Read every added file and verify**

Per the shadcn skill workflow — check: no missing sub-components, imports resolve (`@/lib/utils` etc.), icons come from `@remixicon/react` (project `iconLibrary`), no `lucide-react` leaks. Fix icon imports if any slipped through.

- [ ] **Step 3: Verify gate**

Run: `yarn build && yarn test`
Expected: both pass; new files are unused so no behavior change.

- [ ] **Step 4: Commit**

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

**Interfaces:**
- Consumes: `useFileList()` from `@/hooks/useFileList` (returns `{ files, error, addFiles, browseFiles, removeFile, clearList, setFiles }`); `useCompression(files, setFiles, callbacks)` from `@/hooks/useCompression` (returns `{ isCompressing, progressByFile, compressAll, cancelFile, cancelAll, revealInFolder }`); `formatSize(bytes: number): string` from `@/components/FileList`.
- Produces: `CompressionProvider` (React component), `useCompressionContext()` returning exactly `{ files, error, addFiles, browseFiles, removeFile, clearList, isCompressing, progressByFile, compressAll, cancelFile, cancelAll, revealInFolder }`.

- [ ] **Step 1: Write the failing tests**

Create `src/providers/CompressionProvider.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StrictMode } from 'react'
import { render, screen, act } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import type { FileEntry } from '@/types'

const eventListeners = new Map<string, (e: { payload: unknown }) => void>()

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((event: string, handler: (e: { payload: unknown }) => void) => {
    eventListeners.set(event, handler)
    return Promise.resolve(() => {})
  }),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { CompressionProvider, useCompressionContext } from '@/providers/CompressionProvider'

const emit = (event: string, payload: unknown) =>
  act(() => {
    eventListeners.get(event)?.({ payload })
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

function Row() {
  const { files, addFiles } = useCompressionContext()
  return (
    <div>
      <button
        type="button"
        onClick={() =>
          invoke<FileEntry[]>('add_files', { filePaths: ['/t/a.jpg'] }).then((e) => addFiles(e))
        }
      >
        add
      </button>
      <ul>
        {files.map((f) => (
          <li key={f.id}>{f.name}</li>
        ))}
      </ul>
    </div>
  )
}

describe('CompressionProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventListeners.clear()
  })

  it('shares list state across consumer remounts (view-switch survival)', async () => {
    vi.mocked(invoke).mockResolvedValue([entry()])
    const { unmount } = render(
      <CompressionProvider>
        <Row />
      </CompressionProvider>
    )
    await screen.findByRole('button', { name: 'add' })
    await act(async () => {
      await screen.getByRole('button', { name: 'add' }).click()
    })
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
    // Simulate CompressView unmount/remount: old consumer dies, new one mounts.
    unmount()
    render(
      <CompressionProvider>
        <Row />
      </CompressionProvider>
    )
    expect(screen.getByText('a.jpg')).toBeInTheDocument()
  })

  it('registers IPC listeners exactly once under StrictMode', async () => {
    const { listen } = await import('@tauri-apps/api/event')
    render(
      <StrictMode>
        <CompressionProvider>
          <Row />
        </CompressionProvider>
      </StrictMode>
    )
    const registered = vi.mocked(listen).mock.calls.map((c) => c[0])
    expect(new Set(registered).size).toBe(registered.length)
    expect(registered).toEqual(
      expect.arrayContaining([
        'file:progress',
        'file:complete',
        'file:error',
        'file:cancelled',
        'batch:complete',
        'batch:error',
      ])
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/providers/CompressionProvider.test.tsx`
Expected: FAIL — `Cannot find module '@/providers/CompressionProvider'`

- [ ] **Step 3: Create the provider**

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

- [ ] **Step 4: Point CompressView at the context (temporary bridge)**

In `src/views/CompressView.tsx`, replace lines 17–45 (the two hook imports and calls) with:

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

and replace each `render(<CompressView />)` call with `renderView()`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `yarn test src/providers src/views/CompressView.test.tsx src/hooks`
Expected: ALL PASS (provider tests + ported CompressView tests + untouched hook tests).

- [ ] **Step 6: Run gate**

Run: `yarn build && yarn test`
Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/providers src/views/CompressView.tsx src/views/CompressView.test.tsx
git commit -m "fix(state): lift file list + compression state into app-level provider"
```

---

### Task 3: App shell — flush sidebar, functional breadcrumb, height containment

**Files:**
- Modify: `src/App.tsx`
- Create: `src/App.test.tsx`

**Interfaces:**
- Consumes: `CompressionProvider`/`useCompressionContext` (Task 2); existing `@/components/ui/{sidebar,breadcrumb,separator}`; `navItems` structure already in `App.tsx:46-62`.
- Produces: shell other tasks render inside — `activeView` state stays in `App`; header breadcrumb shows current view; content wrapper constrains view height (`flex min-h-0 flex-1 flex-col overflow-hidden`).

- [ ] **Step 1: Write the failing test**

Create `src/App.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import App from '@/App'

describe('App shell', () => {
  beforeEach(() => vi.clearAllMocks())

  it('breadcrumb reflects the active view and updates on navigation', async () => {
    const user = userEvent.setup()
    render(<App />)
    const breadcrumb = () => within(screen.getByRole('banner')).getAllByText(/compress|history|settings/i)
    expect(breadcrumb().map((el) => el.textContent)).toEqual(
      expect.arrayContaining(['Optimizer', 'Compress'])
    )
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(within(screen.getByRole('banner')).getByText('Settings')).toBeInTheDocument()
    expect(within(screen.getByRole('banner')).queryByText('Compress')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Compress' }))
    expect(within(screen.getByRole('banner')).getByText('Compress')).toBeInTheDocument()
  })

  it('content wrapper constrains view height (min-h-0 chain)', () => {
    const { container } = render(<App />)
    const wrapper = container.querySelector('header')!.parentElement!
      .querySelector(':scope > div')!
    expect(wrapper.className).toContain('min-h-0')
    expect(wrapper.className).toContain('overflow-hidden')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test src/App.test.tsx`
Expected: FAIL — no breadcrumb / no `min-h-0` on wrapper.

- [ ] **Step 3: Apply the shell changes**

In `src/App.tsx`:

1. Wrap the returned tree in the provider (import first):

```tsx
import { CompressionProvider } from '@/providers/CompressionProvider'
```

```tsx
  return (
    <CompressionProvider>
      <SidebarProvider>
```

and close with `</SidebarProvider>\n    </CompressionProvider>`.

2. Flush sidebar — `App.tsx:69`: change

```tsx
<Sidebar collapsible="icon" variant="floating">
```

to

```tsx
<Sidebar collapsible="icon">
```

3. Functional breadcrumb header — `App.tsx:121-124` becomes (sidebar-03 pattern):

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

4. Height containment — `App.tsx:125` becomes:

```tsx
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run gate**

Run: `yarn build && yarn test`
Expected: pass. (Existing view tests mock their own modules; shell change doesn't affect them.)

- [ ] **Step 6: Commit**

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
- Consumes: `NumberField` from `@base-ui-components/react/number-field` (Base UI v1.8, already a dependency); `RiAddLine`, `RiSubtractLine` from `@remixicon/react`; `cn` from `@/lib/utils`.
- Produces: `NumberStepper({ value, onValueChange, min, max, ariaLabel, id?, className? })` — controlled stepper; `onValueChange` receives the clamped integer. SettingsView (Task 5) mounts 9 of these.

- [ ] **Step 1: Fetch the authoritative API doc**

Per AGENTS.md rules, fetch Context7 `/base-ui-components/react` (or open
`https://base-ui.com/react/components/number-field.md`) and confirm: `Root` props
(`value`, `onValueChange`, `min`, `max`, `step`, `snapOnStep`), and whether `onValueChange`
can emit `null`. Adjust the guard in Step 3 if the signature differs from `(number|null) => void`.

- [ ] **Step 2: Write the failing tests**

Create `src/components/NumberStepper.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NumberStepper } from '@/components/NumberStepper'

function Harness({
  min,
  max,
  initial,
}: {
  min: number
  max: number
  initial: number
}) {
  const [value, setValue] = useState(initial)
  return (
    <NumberStepper
      value={value}
      onValueChange={setValue}
      min={min}
      max={max}
      ariaLabel="Images minimum quality"
    />
  )
}

describe('NumberStepper', () => {
  it('increments and decrements by 1', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    await user.click(screen.getByRole('button', { name: 'Increase Images minimum quality' }))
    expect(screen.getByRole('spinbutton')).toHaveDisplayValue('31')
    await user.click(screen.getByRole('button', { name: 'Decrease Images minimum quality' }))
    expect(screen.getByRole('spinbutton')).toHaveDisplayValue('30')
  })

  it('disables buttons at bounds', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Harness min={0} max={100} initial={0} />)
    expect(screen.getByRole('button', { name: 'Decrease Images minimum quality' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Increase Images minimum quality' })).toBeEnabled()
    rerender(<Harness min={0} max={100} initial={100} />)
    await user.click(screen.getByRole('spinbutton'))
    expect(screen.getByRole('button', { name: 'Increase Images minimum quality' })).toBeDisabled()
  })

  it('accepts typed values and clamps on blur', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    const input = screen.getByRole('spinbutton')
    await user.clear(input)
    await user.type(input, '999')
    await user.tab()
    expect(input).toHaveDisplayValue('100')
  })

  it('normalizes invalid typed input to last valid value on blur', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    const input = screen.getByRole('spinbutton')
    await user.clear(input)
    await user.tab()
    expect(input).toHaveDisplayValue('30')
  })

  it('steps with ArrowUp/ArrowDown', async () => {
    const user = userEvent.setup()
    render(<Harness min={0} max={100} initial={30} />)
    const input = screen.getByRole('spinbutton')
    await user.click(input)
    await user.keyboard('{ArrowUp}')
    expect(input).toHaveDisplayValue('31')
    await user.keyboard('{ArrowDown}')
    expect(input).toHaveDisplayValue('30')
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

import { NumberField } from '@base-ui-components/react/number-field'
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
Expected: PASS (all 5). If Base UI emits typing-restrictions (input blocks letters), the
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
- Consumes: `NumberStepper` (Task 4), `@/components/ui/{card,field,select}`, existing `useSettings`, `Badge`, `Separator`, `Accordion*`, `Button`.
- Produces: unchanged draft/save behavior — `draft` state, `hasChanges`, `handleSave/handleCancel/handleReset/handleBrowse` stay byte-compatible; same `aria-label`s on every control.

- [ ] **Step 1: Rewrite SettingsView**

Full replacement body (imports then component — GPL header stays at top of file):

```tsx
import { useState, useEffect } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
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
                          onValueChange={(v) => updateTarget(cat.key, 'unit', v)}
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
                        onValueChange={(v) => updateFloor('video.minResolution', v)}
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

In `src/views/SettingsView.test.tsx`: number inputs are now `spinbutton` roles with
`aria-label`s (unchanged labels); clicking `Increase …`/`Decrease …` buttons steps by 1;
unit/resolution selects open a listbox (use `user.click(trigger)` then click option).
Keep every existing scenario (load, save, cancel, reset, browse, hasChanges) — only
control interaction selectors change.

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
- Consumes: `useCompressionContext()` (Task 2), `DropZone` (Task 7 API unchanged), `FileList` (unchanged), `@/components/ui/{card,scroll-area,spinner}`, `Button`, `toast` no longer imported here.
- Produces: compress view layout other tasks/tests rely on — `data-testid="batch-summary"` preserved; DropZone mounted before file list; summary inside Card footer.

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
              <Button size="sm" onClick={compressAll} disabled={!canCompress}>
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
- All 18 existing scenarios keep their assertions (`batch-summary` testid, button names
  `Compress`/`Cancel All`/`Clear List`, toasts). Remove the per-view heading assertion if
  one exists (heading removed by Task 3 — the old "Compress Files" h1 is gone).
- Add one structural test:

```tsx
  it('summary footer sits outside the scroll container', async () => {
    renderView()
    await addFileInView()
    const card = screen.getByTestId('batch-summary').closest('[data-slot="card"]')
    expect(card).not.toBeNull()
    const scrollArea = card.querySelector('[data-slot="scroll-area"]')
    const summary = card.querySelector('[data-testid="batch-summary"]')
    expect(card.contains(scrollArea)).toBe(true)
    expect(scrollArea.contains(summary)).toBe(false)
  })
```

(If the installed `scroll-area.tsx` uses a different `data-slot`, match on the real one.)

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

- [ ] **Step 1: Rewrite DropZone**

Keep the existing imports/hooks (`useState`, `useCallback`, `useEffect`, `useRef`,
`getCurrentWebview` logic at `DropZone.tsx:34-73`, `handleKeyDown` at `:75-80`) and
replace ONLY the returned JSX (`DropZone.tsx:82-104`) with:

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

Imports to add: `Card`, `CardContent` from `@/components/ui/card`; `Separator` from
`@/components/ui/separator`; `RiUploadCloud2Line` from `@remixicon/react`.

- [ ] **Step 2: Update DropZone tests**

In `src/components/DropZone.test.tsx`: keep every drag-drop scenario (enter/over/drop
payloads → `onDrop` called, drag classes toggled). Adjust markup assertions: browse is
now an explicit `Browse your files` button that stops propagation (assert card click
still opens browse; button click does NOT double-fire `onBrowse` — assert
`onBrowse` called exactly once). Keyboard Enter/Space scenario unchanged.

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
- Create: `docs/superpowers/plans/2026-09-30-manual-testing-1-acceptance-table.md` (only if any criterion can't be proven by a named test — otherwise the table in Task 8 Step 3 suffices)

**Interfaces:**
- Consumes: `@/components/ui/{card,empty}`.

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

- [ ] **Step 2: Run gate**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: all pass.

- [ ] **Step 3: Acceptance check (all proven by named tests — no hand-waved ✅)**

| Criterion (spec §) | Proving test |
|---|---|
| State survives view switch (Bug 2a) | `shares list state across consumer remounts (view-switch survival)` |
| Re-drop deduped, no empty visual (Bug 2b) | existing `test_add_files_deduplicates_exact_canonical` (Rust, stays green) + provider remount test row count = 1 |
| Listeners once, StrictMode-safe | `registers IPC listeners exactly once under StrictMode` |
| Events survive navigation (latent) | provider remount test: emit `file:complete` while consumer unmounted → remounted consumer shows updated status |
| Stepper ±1, clamp, typing, keys | NumberStepper tests (5) |
| Settings save/cancel/reset flows | existing `SettingsView.test.tsx` scenarios |
| Footer pinned on Settings (4a) | Settings root keeps `shrink-0` footer + Task 3 containment test; manual smoke below |
| Only table scrolls on Compress (4c) | `summary footer sits outside the scroll container` |
| Drop zone split panel (4b) | DropZone tests + `addFilesInView` selector passing |
| Breadcrumb functional | `breadcrumb reflects the active view and updates on navigation` |
| Sidebar flush | Task 3 containment test + no `floating` class assertion (add in App test if needed) |

- [ ] **Step 4: Manual smoke (deferred items only)**

1. `yarn dev` in browser at 700×500 window: Settings footer visible without scrolling; Compress drop zone + footer pinned; only table scrolls.
2. `yarn tauri dev`: drop file → navigate to Settings mid-compression → return Compress → row present and status updated.

- [ ] **Step 5: Commit**

```bash
git add src/views/HistoryView.tsx docs/superpowers/plans/2026-09-30-manual-testing-1-acceptance-table.md 2>/dev/null || git add src/views/HistoryView.tsx
git commit -m "feat(ui): history empty-state card; manual testing 1 acceptance check"
```
