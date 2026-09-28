# Slice 2 Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all review findings from the Slice 2 audit — restore drag-and-drop on macOS via Tauri's `onDragDropEvent`, add IPC error surfacing, harden Rust command layer, remove dead code, and add frontend test infra.

**Architecture:** DropZone switches from HTML5 drag events (dead in Tauri 2 webview) to `getCurrentWebview().onDragDropEvent()`. `useFileList` gains try/catch + `error` state surfaced as an alert banner. Rust commands get poison-safe locking, `is_file()` + `canonicalize` validation, and delegate to core fns that tests exercise directly. Vitest infra added for frontend behavioral tests.

**Tech Stack:** Tauri 2 (`@tauri-apps/api/webview`), React 19, vitest 3 + @testing-library/react + jsdom, Rust std (`fs::canonicalize`)

## Global Constraints

- Gate: `yarn build && yarn test && cd src-tauri && cargo test` (update `AGENTS.md` `GATE_COMMAND`)
- No comments in code unless explicitly requested (project rule)
- Conventional commits
- Rust IPC structs camelCase / enums lowercase or snake_case (unchanged)
- Frontend stays UI-only; all file logic in Rust

---

## Task 1: Rust command layer hardening (F3, F4, F5, F8)

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/models.rs`

**Interfaces:**
- Produces: `pub(crate) fn add_files_core(list: &mut Vec<FileEntry>, file_paths: Vec<String>) -> Vec<FileEntry>`, `pub(crate) fn remove_file_core(list: &mut Vec<FileEntry>, file_id: &str)`, `pub(crate) fn clear_list_core(list: &mut Vec<FileEntry>)` — commands lock and delegate; tests call cores directly
- Produces: `FileEntry::new` uses `to_string_lossy()` for name extraction
- Consumes: existing `FileListState(Mutex<Vec<FileEntry>>)` unchanged (public shape kept for lib.rs `.manage`)

- [x] **Step 1: Fix models.rs name extraction**

In `src-tauri/src/models.rs`, change:

```rust
let name = std::path::Path::new(path)
    .file_name()
    .and_then(|n| n.to_str())
    .unwrap_or("unknown")
    .to_string();
```

to:

```rust
let name = std::path::Path::new(path)
    .file_name()
    .unwrap_or_default()
    .to_string_lossy()
    .to_string();
```

Note: `.file_name().unwrap_or_default()` yields empty OsStr when None — but `FileEntry::new` is only invoked on paths that passed `is_file()` in commands, so "unknown" fallback is unnecessary; empty-string name is impossible for real files. The existing `test_file_entry_new_empty_filename` asserting `"to"` for `"/path/to/"` remains valid std-behavior (documented in spec F12).

- [x] **Step 2: Write failing tests for core fns + canonical dedup + dir rejection**

Replace the test module body in `src-tauri/src/commands.rs` with tests that call the core fns (they don't exist yet — compile fails):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Category;
    use std::fs;
    use tempfile::tempdir;

    fn make_file(dir: &std::path::Path, name: &str) -> String {
        let p = dir.join(name);
        fs::write(&p, b"x").unwrap();
        p.to_str().unwrap().to_string()
    }

    #[test]
    fn test_add_files_valid_paths() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        let result = add_files_core(&mut list, vec![path]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "test.jpg");
        assert_eq!(result[0].category, Category::Image);
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_skips_nonexistent() {
        let mut list = Vec::new();
        let result = add_files_core(&mut list, vec!["/nonexistent/path.jpg".to_string()]);
        assert!(result.is_empty());
        assert!(list.is_empty());
    }

    #[test]
    fn test_add_files_rejects_directory() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let subdir = dir.path().join("subdir");
        fs::create_dir(&subdir).unwrap();
        let result = add_files_core(&mut list, vec![subdir.to_str().unwrap().to_string()]);
        assert!(result.is_empty());
        assert!(list.is_empty());
    }

    #[test]
    fn test_add_files_deduplicates_case_insensitive() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        let canonical = fs::canonicalize(&path).unwrap().to_str().unwrap().to_string();
        let case_variant = if canonical.chars().any(|c| c.is_uppercase()) {
            canonical.to_lowercase()
        } else {
            canonical.to_uppercase()
        };
        add_files_core(&mut list, vec![canonical.clone()]);
        let result = add_files_core(&mut list, vec![case_variant]);
        assert!(result.is_empty(), "case-variant of same path must dedup");
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_deduplicates_redundant_separators() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        add_files_core(&mut list, vec![path.clone()]);
        let doubled = path.replace("/test.jpg", "//test.jpg");
        let result = add_files_core(&mut list, vec![doubled]);
        assert!(result.is_empty(), "canonicalize normalizes // before dedup");
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_stores_canonical_path() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        add_files_core(&mut list, vec![path]);
        let canonical = fs::canonicalize(dir.path().join("test.jpg")).unwrap();
        let stored: Vec<String> = list.iter().map(|e| e.path.clone()).collect();
        assert_eq!(stored[0], canonical.to_str().unwrap());
    }

    #[test]
    fn test_add_files_returns_new_only() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let p1 = make_file(dir.path(), "a.jpg");
        let p2 = make_file(dir.path(), "b.jpg");
        add_files_core(&mut list, vec![p1]);
        let result = add_files_core(&mut list, vec![p1, p2]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "b.jpg");
    }

    #[test]
    fn test_add_files_empty_vec() {
        let mut list = Vec::new();
        let result = add_files_core(&mut list, vec![]);
        assert!(result.is_empty());
        assert!(list.is_empty());
    }

    #[test]
    fn test_remove_file_existing() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        let entries = add_files_core(&mut list, vec![path]);
        remove_file_core(&mut list, &entries[0].id);
        assert!(list.is_empty());
    }

    #[test]
    fn test_clear_list() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let p1 = make_file(dir.path(), "a.jpg");
        let p2 = make_file(dir.path(), "b.jpg");
        add_files_core(&mut list, vec![p1, p2]);
        clear_list_core(&mut list);
        assert!(list.is_empty());
    }

    #[test]
    fn test_mutex_poison_recovery() {
        let state = FileListState(Mutex::new(Vec::new()));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _lock = state.0.lock().unwrap();
            panic!("intentional panic");
        }));
        assert!(result.is_err());
        let list = state.0.lock().unwrap_or_else(|e| e.into_inner());
        assert!(list.is_empty());
    }
}
```

- [x] **Step 3: Run tests to verify they fail**

Run: `cd src-tauri && cargo test commands`
Expected: FAIL — `add_files_core` etc. not found (compile error).

- [x] **Step 4: Implement core fns + poison-safe commands**

Replace the production section of `src-tauri/src/commands.rs` (above the test module) with:

```rust
use crate::models::FileEntry;
use std::sync::Mutex;
use tauri::State;

pub struct FileListState(pub Mutex<Vec<FileEntry>>);

pub(crate) fn add_files_core(
    list: &mut Vec<FileEntry>,
    file_paths: Vec<String>,
) -> Vec<FileEntry> {
    let mut new_entries = Vec::new();

    for path in file_paths {
        let p = std::path::Path::new(&path);
        if !p.is_file() {
            continue;
        }
        let canonical = match std::fs::canonicalize(p) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let canonical_str = canonical.to_string_lossy().to_string();
        if list.iter().any(|e| e.path == canonical_str) {
            continue;
        }
        let entry = FileEntry::new(&canonical_str);
        new_entries.push(entry.clone());
        list.push(entry);
    }

    new_entries
}

pub(crate) fn remove_file_core(list: &mut Vec<FileEntry>, file_id: &str) {
    list.retain(|e| e.id != file_id);
}

pub(crate) fn clear_list_core(list: &mut Vec<FileEntry>) {
    list.clear();
}

#[tauri::command]
pub fn add_files(file_paths: Vec<String>, state: State<FileListState>) -> Vec<FileEntry> {
    let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
    add_files_core(&mut list, file_paths)
}

#[tauri::command]
pub fn remove_file(file_id: String, state: State<FileListState>) {
    let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
    remove_file_core(&mut list, &file_id)
}

#[tauri::command]
pub fn clear_list(state: State<FileListState>) {
    let mut list = state.0.lock().unwrap_or_else(|e| e.into_inner());
    clear_list_core(&mut list)
}
```

- [x] **Step 5: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: all pass, zero warnings (dead code gone from tests referencing cores).

- [x] **Step 6: Gate**

Run: `cd src-tauri && cargo test && cd .. && yarn build`
Expected: green.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "fix: harden command layer — poison-safe locks, is_file+canonicalize dedup, testable cores"
```

---

## Task 2: Detection edge cases + dead code removal (F6, F7)

**Files:**
- Modify: `src-tauri/src/detection.rs`

**Interfaces:**
- Produces: `detect_category` using `std::path::Path::extension()` semantics
- Removes: `category_label`, `category_formats` and their tests

- [x] **Step 1: Write failing tests**

Add to `detection.rs` test module:

```rust
    #[test]
    fn test_detect_dotless_names_not_extensions() {
        assert_eq!(detect_category("jpg"), Category::Other);
        assert_eq!(detect_category("pdf"), Category::Other);
        assert_eq!(detect_category("mp4"), Category::Other);
    }

    #[test]
    fn test_detect_trailing_dot() {
        assert_eq!(detect_category("file."), Category::Other);
    }

    #[test]
    fn test_detect_dotfile_no_ext() {
        assert_eq!(detect_category(".hidden"), Category::Other);
    }
```

- [x] **Step 2: Run to verify fail**

Run: `cd src-tauri && cargo test detection`
Expected: FAIL — `jpg`/`pdf`/`mp4` currently detect as their categories; `file.` returns `""`→Other passes already; `.hidden` returns `hidden`→Other passes already. Two new failures expected (dotless names).

- [x] **Step 3: Implement Path::extension-based detection + delete dead fns**

Replace `detect_category` with:

```rust
pub fn detect_category(filename: &str) -> Category {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "heic" | "heif" => Category::Image,
        "mp4" | "mov" => Category::Video,
        "pdf" => Category::Pdf,
        "docx" | "xlsx" | "pptx" => Category::Document,
        _ => Category::Other,
    }
}
```

Delete `category_label` and `category_formats` entirely (and their two tests).

- [x] **Step 4: Run tests to verify pass**

Run: `cd src-tauri && cargo test detection`
Expected: all pass, no dead-code warnings.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: Path::extension-based detection; drop dotless misdetection; remove dead label fns"
```

---

## Task 3: useFileList error handling + CompressView error banner (F2)

**Files:**
- Modify: `src/hooks/useFileList.ts`
- Modify: `src/views/CompressView.tsx`

**Interfaces:**
- Produces: `useFileList()` now returns `{ files, error, addFiles, browseFiles, removeFile, clearList }`; `error: string | null` set on any IPC failure, cleared on next successful op
- All four ops catch internally; they never throw to callers

- [x] **Step 1: Rewrite useFileList.ts**

```typescript
import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { FileEntry } from '@/types'

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err)

export function useFileList() {
  const [files, setFiles] = useState<FileEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  const addFiles = useCallback(async (paths: string[]) => {
    try {
      const newEntries = await invoke<FileEntry[]>('add_files', { filePaths: paths })
      setFiles((prev) => [...prev, ...newEntries])
      setError(null)
    } catch (err) {
      setError(`Could not add files: ${toMessage(err)}`)
      throw err
    }
  }, [])

  const browseFiles = useCallback(async () => {
    try {
      const selected = await open({ multiple: true, filters: [] })
      if (!selected) return
      const paths = Array.isArray(selected) ? selected : [selected]
      await addFiles(paths)
      setError(null)
    } catch (err) {
      setError(`Could not open file picker: ${toMessage(err)}`)
      throw err
    }
  }, [addFiles])

  const removeFile = useCallback(async (fileId: string) => {
    try {
      await invoke('remove_file', { fileId })
      setFiles((prev) => prev.filter((f) => f.id !== fileId))
      setError(null)
    } catch (err) {
      setError(`Could not remove file: ${toMessage(err)}`)
      throw err
    }
  }, [])

  const clearList = useCallback(async () => {
    try {
      await invoke('clear_list')
      setFiles([])
      setError(null)
    } catch (err) {
      setError(`Could not clear list: ${toMessage(err)}`)
      throw err
    }
  }, [])

  return { files, error, addFiles, browseFiles, removeFile, clearList }
}
```

- [x] **Step 2: Write failing test for error state**

`src/hooks/useFileList.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

import { useFileList } from '@/hooks/useFileList'

const mockEntry = {
  id: 'u1',
  name: 'a.jpg',
  path: '/t/a.jpg',
  category: 'image' as const,
  targetBytes: 204800,
  originalSize: 10,
  status: 'pending' as const,
  compressedSize: null,
  outputPath: null,
  error: null,
}

beforeEach(() => vi.clearAllMocks())

describe('useFileList', () => {
  it('adds files via IPC', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry])
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    expect(invoke).toHaveBeenCalledWith('add_files', { filePaths: ['/t/a.jpg'] })
    expect(result.current.files).toHaveLength(1)
    expect(result.current.error).toBeNull()
  })

  it('sets error and rethrows when add IPC fails', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() => useFileList())
    await expect(act(() => result.current.addFiles(['/t/a.jpg']))).rejects.toThrow('boom')
    expect(result.current.files).toHaveLength(0)
    expect(result.current.error).toContain('Could not add files')
    expect(result.current.error).toContain('boom')
  })

  it('browseFiles cancel (null) does nothing', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    vi.mocked(open).mockResolvedValueOnce(null)
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.browseFiles())
    expect(invoke).not.toHaveBeenCalled()
    expect(result.current.files).toHaveLength(0)
  })

  it('browseFiles wraps single string path', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    vi.mocked(open).mockResolvedValueOnce('/t/one.jpg')
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry])
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.browseFiles())
    expect(invoke).toHaveBeenCalledWith('add_files', { filePaths: ['/t/one.jpg'] })
  })

  it('browseFiles passes array through', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    vi.mocked(open).mockResolvedValueOnce(['/t/a.jpg', '/t/b.jpg'])
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry])
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.browseFiles())
    expect(invoke).toHaveBeenCalledWith('add_files', { filePaths: ['/t/a.jpg', '/t/b.jpg'] })
  })

  it('browseFiles surfaces picker errors', async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    vi.mocked(open).mockRejectedValueOnce(new Error('picker dead'))
    const { result } = renderHook(() => useFileList())
    await expect(act(() => result.current.browseFiles())).rejects.toThrow('picker dead')
    expect(result.current.error).toContain('Could not open file picker')
  })

  it('removeFile filters only after IPC success', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([mockEntry])
      .mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    await act(() => result.current.removeFile('u1'))
    expect(invoke).toHaveBeenLastCalledWith('remove_file', { fileId: 'u1' })
    expect(result.current.files).toHaveLength(0)
  })

  it('removeFile keeps row when IPC fails', async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce([mockEntry])
      .mockRejectedValueOnce(new Error('nope'))
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    await expect(act(() => result.current.removeFile('u1'))).rejects.toThrow('nope')
    expect(result.current.files).toHaveLength(1)
    expect(result.current.error).toContain('Could not remove file')
  })

  it('clearList empties and clears error', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry]).mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    await act(() => result.current.clearList())
    expect(invoke).toHaveBeenLastCalledWith('clear_list')
    expect(result.current.files).toHaveLength(0)
    expect(result.current.error).toBeNull()
  })

  it('clearList failure keeps files', async () => {
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry]).mockRejectedValueOnce(new Error('x'))
    const { result } = renderHook(() => useFileList())
    await act(() => result.current.addFiles(['/t/a.jpg']))
    await expect(act(() => result.current.clearList())).rejects.toThrow('x')
    expect(result.current.files).toHaveLength(1)
  })

  it('rapid adds do not corrupt ordering', async () => {
    const e2 = { ...mockEntry, id: 'u2', name: 'b.jpg' }
    vi.mocked(invoke).mockResolvedValueOnce([mockEntry]).mockResolvedValueOnce([e2])
    const { result } = renderHook(() => useFileList())
    await act(async () => {
      await Promise.all([result.current.addFiles(['/t/a.jpg']), result.current.addFiles(['/t/b.jpg'])])
    })
    await waitFor(() => expect(result.current.files).toHaveLength(2))
  })
})
```

- [x] **Step 3: Add vitest infra (Task 11 folds in here)**

Run: `yarn add -D vitest @vitest/coverage-v8 @testing-library/react @testing-library/dom jsdom`

Add `"test": "vitest run"` to `package.json` scripts. Create `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
})
```

Create `src/test-setup.ts`:

```typescript
import '@testing-library/jest-dom/vitest'
```

- [x] **Step 4: Run test to verify pass**

Run: `yarn test`
Expected: 11 useFileList tests pass.

- [x] **Step 5: Wire error banner in CompressView**

```tsx
import { useFileList } from '@/hooks/useFileList'
import { DropZone } from '@/components/DropZone'
import { FileList } from '@/components/FileList'
import { Button } from '@/components/ui/button'

export function CompressView() {
  const { files, error, addFiles, browseFiles, removeFile, clearList } = useFileList()

  const hasFiles = files.length > 0

  const handleBrowse = () => {
    browseFiles().catch(() => {})
  }
  const handleDrop = (paths: string[]) => {
    addFiles(paths).catch(() => {})
  }
  const handleRemove = (id: string) => {
    removeFile(id).catch(() => {})
  }
  const handleClear = () => {
    clearList().catch(() => {})
  }

  return (
    <div className="flex flex-1 flex-col gap-3.5 p-5 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-base font-semibold">Compress Files</h1>
        <span className="text-xs text-muted-foreground">Drag files into the area below</span>
      </div>

      {error && (
        <div
          role="alert"
          className="shrink-0 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {error}
        </div>
      )}

      <DropZone onBrowse={handleBrowse} onDrop={handleDrop} className="shrink-0" />

      {hasFiles && (
        <>
          <FileList files={files} onRemove={handleRemove} />
          <div className="flex justify-between items-center pt-0.5 shrink-0">
            <span className="text-xs text-muted-foreground">
              <strong className="text-foreground font-semibold">{files.length} files</strong>
            </span>
            <Button variant="ghost" size="sm" onClick={handleClear}>
              Clear List
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
```

(Close the `div` tag properly — `<div>` … `</div>`.)

- [x] **Step 6: Run full gate**

Run: `yarn build && yarn test`
Expected: green.

- [x] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: surface IPC errors via error state + alert banner; add vitest infra + hook tests"
```

---

## Task 4: DropZone rewrite with onDragDropEvent (F1)

**Files:**
- Modify: `src/components/DropZone.tsx`
- Modify: `src/vite-env.d.ts` (remove File.path shim)

**Interfaces:**
- Consumes: `getCurrentWebview().onDragDropEvent` (`@tauri-apps/api/webview`), `DragDropEvent` union `{type:'enter'|'over'|'drop'|'leave'}`
- Produces: same props `{ onBrowse, onDrop, className? }` — `onDrop(paths: string[])` called with Tauri-provided paths
- Behavior: dragging anywhere over the webview sets visual state; drop anywhere adds files; zone remains click/keyboard browse target

- [x] **Step 1: Write failing test**

`src/components/DropZone.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { UnlistenFn } from '@tauri-apps/api/event'

const handlers: Array<(evt: unknown) => void> = []
const unlisten = vi.fn()

vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (h: (evt: unknown) => void) => {
      handlers.push(h)
      return Promise.resolve(unlisten as UnlistenFn)
    },
  }),
}))

import { DropZone } from '@/components/DropZone'

function emit(evt: unknown) {
  for (const h of handlers) h(evt)
}

describe('DropZone', () => {
  it('calls onDrop with Tauri-provided paths on drop event', async () => {
    const onDrop = vi.fn()
    const onBrowse = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    const h = handlers[handlers.length - 1]
    h({ payload: { type: 'drop', paths: ['/a/b.jpg', '/a/c.mp4'], position: { x: 0, y: 0 } } })
    expect(onDrop).toHaveBeenCalledWith(['/a/b.jpg', '/a/c.mp4'])
  })

  it('ignores enter/over/leave for onDrop', async () => {
    const onDrop = vi.fn()
    render(<DropZone onBrowse={vi.fn()} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    const h = handlers[handlers.length - 1]
    h({ payload: { type: 'enter', paths: ['/a.jpg'], position: { x: 0, y: 0 } } })
    h({ payload: { type: 'over', position: { x: 0, y: 0 } } })
    h({ payload: { type: 'drop', paths: ['/a.jpg'], position: { x: 0, y: 0 } } })
    h({ payload: { type: 'leave' } })
    expect(onDrop).toHaveBeenCalledTimes(1)
  })

  it('does not call onDrop when drop has empty paths', async () => {
    const onDrop = vi.fn()
    render(<DropZone onBrowse={vi.fn()} onDrop={onDrop} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    const h = handlers[handlers.length - 1]
    h({ payload: { type: 'drop', paths: [], position: { x: 0, y: 0 } } })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('sets and clears isDragging visual state', async () => {
    render(<DropZone onBrowse={vi.fn()} onDrop={vi.fn()} />)
    await waitFor(() => expect(handlers.length).toBeGreaterThan(0))
    const h = handlers[handlers.length - 1]
    const zone = screen.getByRole('button', { name: /drop files/i })
    h({ payload: { type: 'enter', paths: ['/a.jpg'], position: { x: 0, y: 0 } } })
    expect(zone.className).toContain('border-primary')
    h({ payload: { type: 'leave' } })
    expect(zone.className).not.toContain('border-primary')
  })

  it('click triggers browse', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /drop files/i }))
    expect(onBrowse).toHaveBeenCalled()
  })

  it('Enter and Space trigger browse', async () => {
    const user = userEvent.setup()
    const onBrowse = vi.fn()
    render(<DropZone onBrowse={onBrowse} onDrop={vi.fn()} />)
    const zone = screen.getByRole('button', { name: /drop files/i })
    zone.focus()
    await user.keyboard('{Enter}')
    expect(onBrowse).toHaveBeenCalledTimes(1)
    await user.keyboard(' ')
    expect(onBrowse).toHaveBeenCalledTimes(2)
  })
})
```

Note: run `yarn add -D @testing-library/user-event` if not already installed.

- [x] **Step 2: Rewrite DropZone.tsx**

```tsx
import { useState, useCallback, useEffect, useRef } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'

interface DropZoneProps {
  onBrowse: () => void
  onDrop: (paths: string[]) => void
  className?: string
}

export function DropZone({ onBrowse, onDrop, className }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const onDropRef = useRef(onDrop)
  onDropRef.current = onDrop

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (cancelled) return
        if (event.payload.type === 'enter') {
          setIsDragging(true)
        } else if (event.payload.type === 'over') {
          setIsDragging(true)
        } else if (event.payload.type === 'drop') {
          setIsDragging(false)
          if (event.payload.paths.length > 0) {
            onDropRef.current(event.payload.paths)
          }
        } else {
          setIsDragging(false)
        }
      })
      .then((fn) => {
        if (cancelled) fn()
        else unlisten = fn
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  return (
    <div
      onClick={onBrowse}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onBrowse()
        }
      }}
      role="button"
      tabIndex={0}
      aria-label="Drop files to compress or click to browse"
      className={`border border-dashed rounded-lg py-7 px-4 text-center cursor-pointer transition-colors ${
        isDragging
          ? 'border-primary bg-primary/5'
          : 'border-input bg-muted/30 hover:bg-muted/50'
      } ${className ?? ''}`}
    >
      <div className="inline-flex items-center justify-center w-10 h-10 rounded-lg border border-border bg-card mb-3">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="17 8 12 3 7 8" />
          <line x1="12" y1="3" x2="12" y2="15" />
        </svg>
      </div>
      <p className="text-sm font-medium text-foreground mb-0.5">Drop files to compress</p>
      <p className="text-xs text-muted-foreground">or <span className="text-primary underline">browse from your computer</span></p>
    </div>
  )
}
```

- [x] **Step 3: Remove File.path shim**

Delete `src/vite-env.d.ts`'s File interface block so the file is:

```typescript
/// <reference types="vite/client" />
```

- [x] **Step 4: Run tests to verify pass**

Run: `yarn test`
Expected: DropZone tests + earlier tests green. `yarn build` green (no `f.path` usage remains).

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "fix: restore drag-drop via Tauri onDragDropEvent; drop dead File.path shim"
```

---

## Task 5: FileList polish (F9, F10) + component tests

**Files:**
- Modify: `src/components/FileList.tsx`
- Test: `src/components/FileList.test.tsx`

**Interfaces:**
- Produces: `formatSize` with GB tier; remove button with aria-label

- [x] **Step 1: Write failing tests**

`src/components/FileList.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FileEntry } from '@/types'
import { FileList } from '@/components/FileList'

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

describe('FileList', () => {
  it('renders nothing when empty', () => {
    const { container } = render(<FileList files={[]} onRemove={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows name, size, category badge, target, status', () => {
    render(
      <FileList
        files={[entry({ name: 'photo.jpg', originalSize: 512, category: 'image', targetBytes: 204800 })]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('photo.jpg')).toBeInTheDocument()
    expect(screen.getByText('512 B')).toBeInTheDocument()
    expect(screen.getByText('Image')).toBeInTheDocument()
    expect(screen.getByText('200 KB')).toBeInTheDocument()
    expect(screen.getByText('Pending')).toBeInTheDocument()
  })

  it('formats sizes across tiers', () => {
    render(
      <FileList
        files={[
          entry({ id: 'a', name: 'a.jpg', originalSize: 500 }),
          entry({ id: 'b', name: 'b.jpg', originalSize: 2048 }),
          entry({ id: 'c', name: 'c.jpg', originalSize: 2097152 }),
          entry({ id: 'd', name: 'd.mp4', originalSize: 5 * 1024 ** 3 }),
        ]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getByText('500 B')).toBeInTheDocument()
    expect(screen.getByText('2 KB')).toBeInTheDocument()
    expect(screen.getByText('2.0 MB')).toBeInTheDocument()
    expect(screen.getByText('5.00 GB')).toBeInTheDocument()
  })

  it('zero size and zero target render em-dash', () => {
    render(
      <FileList
        files={[entry({ originalSize: 0, category: 'other', targetBytes: 0, status: 'unsupported' })]}
        onRemove={vi.fn()}
      />
    )
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Other')).toBeInTheDocument()
    expect(screen.getByText('Unsupported')).toBeInTheDocument()
  })

  it('unsupported rows are dimmed', () => {
    render(
      <FileList
        files={[entry({ category: 'other', status: 'unsupported' })]}
        onRemove={vi.fn()}
      />
    )
    const row = screen.getByText('a.jpg').closest('tr')
    expect(row?.className).toContain('opacity-40')
  })

  it('remove button calls onRemove with id and has aria-label', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    render(<FileList files={[entry()]} onRemove={onRemove} />)
    const btn = screen.getByRole('button', { name: /remove a\.jpg/i })
    await user.click(btn)
    expect(onRemove).toHaveBeenCalledWith('f1')
  })
})
```

- [x] **Step 2: Run to verify fail (GB tier + aria-label missing)**

Run: `yarn test`
Expected: GB test and aria-label test FAIL.

- [x] **Step 3: Implement**

In `FileList.tsx`:

1. Extend `formatSize`:

```typescript
function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const KB = 1024
  const MB = 1024 * 1024
  const GB = 1024 * 1024 * 1024
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(0)} KB`
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`
  return `${(bytes / GB).toFixed(2)} GB`
}
```

2. Add `aria-label` to remove button:

```tsx
<button
  onClick={() => onRemove(file.id)}
  aria-label={`Remove ${file.name}`}
  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
  title="Remove from list"
>
```

- [x] **Step 4: Run tests to verify pass**

Run: `yarn test`
Expected: green.

- [x] **Step 6: Gate + commit**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: all green.

```bash
git add -A
git commit -m "feat: GB tier in formatSize, aria-label remove buttons, FileList tests"
```

---

## Task 6: Update gate command + final acceptance

**Files:**
- Modify: `AGENTS.md` (`GATE_COMMAND`)
- Modify: `docs/superpowers/plans/2026-09-27-slice-2-file-detection.md` (annotate the two plan-doc errors: 8 statuses not 9; 10 fields not 12)

**Interfaces:**
- Produces: gate includes `yarn test`

- [x] **Step 1: Update AGENTS.md**

Change:

```
- `GATE_COMMAND` — `yarn build && cd src-tauri && cargo test`
```

to:

```
- `GATE_COMMAND` — `yarn build && yarn test && cd src-tauri && cargo test`
```

- [x] **Step 2: Annotate plan doc**

In `docs/superpowers/plans/2026-09-27-slice-2-file-detection.md` add after the header block:

```markdown
> **Post-merge note (2026-09-28):** Plan prose said FileStatus has 9 variants and FileEntry has
> 12 fields; actual spec/code have 8 and 10. Prose was in error — code is correct. Drag-and-drop
> guidance to use HTML5 `File.path` was Tauri v1-era and wrong for Tauri 2 (see
> `docs/superpowers/specs/2026-09-28-slice-2-review-fixes.md` F1).
```

- [x] **Step 3: Full gate**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: all green, zero warnings.

- [ ] **Step 4: Production build**

Run: `yarn tauri build`
Expected: `.app` + `.dmg` bundle successfully.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: gate now runs frontend tests; annotate slice-2 plan doc errata"
```