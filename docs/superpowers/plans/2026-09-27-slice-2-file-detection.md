# Slice 2: File Detection + File List — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drag files (or browse) → they appear in a file list with correct category badge, default target, and file size. Unsupported files show "Other" badge. User can remove files or clear the list.

**Architecture:** Tauri file dialog for browse, HTML5 drag-and-drop for drop zone. Rust category detection via a static extension→category registry. Tauri IPC commands (`add_files`, `remove_file`, `clear_list`) + `file:added` event. File list rendered as a table with shadcn Table + Badge components.

**Tech Stack:** Tauri 2, React, TypeScript, shadcn/ui (Table, Badge, Button), Tauri dialog plugin

## Global Constraints

- **No compression in this slice** — files are only detected and listed, not processed
- **Category detection:** extension-based, via static Rust registry
- **File list state:** lives in React state, populated by IPC responses
- **No settings persistence yet** — default targets from the spec are hardcoded in Rust

## File Structure

```
src-tauri/src/
├── lib.rs                    # Tauri commands registration
├── models.rs                 # Category enum, FileEntry, FileStatus
├── detection.rs              # Extension → category registry
└── commands.rs               # add_files, remove_file, clear_list commands

src/
├── views/CompressView.tsx    # Drop zone + file list table
├── components/
│   ├── DropZone.tsx          # Drag-drop + browse area
│   └── FileList.tsx          # Table of files with badges
├── hooks/
│   └── useFileList.ts        # React state + Tauri IPC calls
├── types.ts                  # TS types matching Rust models
```

## Acceptance Criteria

1. Drag files onto the drop zone → they appear in the file list
2. Click "browse" → native file dialog opens → selected files appear in list
3. Each file shows: filename, category badge, target size, file size, status (Pending)
4. JPEG/PNG/WebP/HEIC → "Image" badge, target "200 KB"
5. MP4/MOV → "Video" badge, target "10 MB"
6. PDF → "PDF" badge, target "2 MB"
7. DOCX/XLSX/PPTX → "Document" badge, target "1 MB"
8. Unknown extension (e.g. .zip, .xyz) → "Other" badge, target "—", status "Unsupported"
9. Can drag more files at any time — they append to the list
10. Each file row has a remove button (×) → removes that file from list
11. "Clear" button removes all files from list
12. File sizes displayed in human-readable format (KB/MB)

---

## Task 1: Define Rust Data Models

**Files:**
- Create: `src-tauri/src/models.rs`

**Interfaces:**
- Produces: `Category` enum, `FileStatus` enum, `FileEntry` struct — used by all subsequent Rust modules and serialized to frontend

- [ ] **Step 1: Create models.rs**

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Image,
    Video,
    Pdf,
    Document,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Pending,
    Compressing,
    Done,
    BestEffort,
    Failed,
    Cancelled,
    Unsupported,
    AlreadyUnderTarget,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub path: String,
    pub category: Category,
    pub target_bytes: u64,
    pub original_size: u64,
    pub status: FileStatus,
    pub compressed_size: Option<u64>,
    pub output_path: Option<String>,
    pub error: Option<String>,
}

impl FileEntry {
    pub fn new(path: &str) -> Self {
        let name = std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();

        let original_size = std::fs::metadata(path)
            .map(|m| m.len())
            .unwrap_or(0);

        let category = crate::detection::detect_category(&name);
        let status = if category == Category::Other {
            FileStatus::Unsupported
        } else {
            FileStatus::Pending
        };

        let target_bytes = crate::detection::default_target_bytes(category);

        FileEntry {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            path: path.to_string(),
            category,
            target_bytes,
            original_size,
            status,
            compressed_size: None,
            output_path: None,
            error: None,
        }
    }
}
```

- [ ] **Step 2: Add uuid dependency to Cargo.toml**

Add to `src-tauri/Cargo.toml` under `[dependencies]`:
```toml
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add Rust data models (Category, FileStatus, FileEntry)"
```

---

## Task 2: Implement Category Detection

**Files:**
- Create: `src-tauri/src/detection.rs`

**Interfaces:**
- Produces: `detect_category(filename: &str) -> Category` and `default_target_bytes(category: Category) -> u64`
- Consumed by: `models.rs` (`FileEntry::new`)

- [ ] **Step 1: Create detection.rs**

```rust
use crate::models::Category;

const KB: u64 = 1024;
const MB: u64 = 1024 * 1024;

pub fn detect_category(filename: &str) -> Category {
    let ext = filename.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "jpg" | "jpeg" | "png" | "webp" | "heic" | "heif" => Category::Image,
        "mp4" | "mov" => Category::Video,
        "pdf" => Category::Pdf,
        "docx" | "xlsx" | "pptx" => Category::Document,
        _ => Category::Other,
    }
}

pub fn default_target_bytes(category: Category) -> u64 {
    match category {
        Category::Image => 200 * KB,
        Category::Video => 10 * MB,
        Category::Pdf => 2 * MB,
        Category::Document => 1 * MB,
        Category::Other => 0,
    }
}

pub fn category_label(category: Category) -> &'static str {
    match category {
        Category::Image => "Image",
        Category::Video => "Video",
        Category::Pdf => "PDF",
        Category::Document => "Document",
        Category::Other => "Other",
    }
}

pub fn category_formats(category: Category) -> &'static str {
    match category {
        Category::Image => "JPEG, PNG, WebP, HEIC",
        Category::Video => "MP4, MOV",
        Category::Pdf => "PDF",
        Category::Document => "DOCX, XLSX, PPTX",
        Category::Other => "",
    }
}
```

- [ ] **Step 2: Write unit tests for detection**

Add at the bottom of `detection.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_image_formats() {
        assert_eq!(detect_category("photo.jpg"), Category::Image);
        assert_eq!(detect_category("photo.JPEG"), Category::Image);
        assert_eq!(detect_category("photo.png"), Category::Image);
        assert_eq!(detect_category("photo.webp"), Category::Image);
        assert_eq!(detect_category("photo.heic"), Category::Image);
        assert_eq!(detect_category("photo.heif"), Category::Image);
    }

    #[test]
    fn test_detect_video_formats() {
        assert_eq!(detect_category("video.mp4"), Category::Video);
        assert_eq!(detect_category("video.MOV"), Category::Video);
    }

    #[test]
    fn test_detect_pdf() {
        assert_eq!(detect_category("doc.pdf"), Category::Pdf);
        assert_eq!(detect_category("doc.PDF"), Category::Pdf);
    }

    #[test]
    fn test_detect_document_formats() {
        assert_eq!(detect_category("report.docx"), Category::Document);
        assert_eq!(detect_category("sheet.xlsx"), Category::Document);
        assert_eq!(detect_category("slides.pptx"), Category::Document);
    }

    #[test]
    fn test_detect_unknown() {
        assert_eq!(detect_category("archive.zip"), Category::Other);
        assert_eq!(detect_category("file.xyz"), Category::Other);
        assert_eq!(detect_category("noextension"), Category::Other);
    }

    #[test]
    fn test_default_targets() {
        assert_eq!(default_target_bytes(Category::Image), 200 * 1024);
        assert_eq!(default_target_bytes(Category::Video), 10 * 1024 * 1024);
        assert_eq!(default_target_bytes(Category::Pdf), 2 * 1024 * 1024);
        assert_eq!(default_target_bytes(Category::Document), 1 * 1024 * 1024);
        assert_eq!(default_target_bytes(Category::Other), 0);
    }
}
```

- [ ] **Step 3: Run tests**

Run:
```bash
cd src-tauri && cargo test detection -- --nocapture
```

Expected: All 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add category detection with extension registry + tests"
```

---

## Task 3: Implement Tauri IPC Commands

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register commands)

**Interfaces:**
- Produces: `add_files`, `remove_file`, `clear_list` Tauri commands
- Consumes: `models.rs` (FileEntry), `detection.rs` (detect_category)

- [ ] **Step 1: Create commands.rs**

```rust
use crate::models::{Category, FileEntry, FileStatus};
use std::sync::Mutex;
use tauri::State;

pub struct FileListState(pub Mutex<Vec<FileEntry>>);

#[tauri::command]
pub fn add_files(file_paths: Vec<String>, state: State<FileListState>) -> Vec<FileEntry> {
    let mut list = state.0.lock().unwrap();
    let mut new_entries = Vec::new();

    for path in file_paths {
        if !std::path::Path::new(&path).exists() {
            continue;
        }
        if list.iter().any(|e| e.path == path) {
            continue;
        }
        let entry = FileEntry::new(&path);
        new_entries.push(entry.clone());
        list.push(entry);
    }

    new_entries
}

#[tauri::command]
pub fn remove_file(file_id: String, state: State<FileListState>) {
    let mut list = state.0.lock().unwrap();
    list.retain(|e| e.id != file_id);
}

#[tauri::command]
pub fn clear_list(state: State<FileListState>) {
    let mut list = state.0.lock().unwrap();
    list.clear();
}
```

- [ ] **Step 2: Register commands in lib.rs**

Replace `src-tauri/src/lib.rs`:

```rust
mod commands;
mod detection;
mod models;

use commands::FileListState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(FileListState(Mutex::new(Vec::new())))
        .invoke_handler(tauri::generate_handler![
            commands::add_files,
            commands::remove_file,
            commands::clear_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify it compiles**

Run:
```bash
yarn tauri dev
```

Expected: App launches without errors. No visible change yet (no UI to call commands).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Tauri commands for file list management"
```

---

## Task 4: Add Tauri Dialog Plugin

**Files:**
- Modify: `src-tauri/Cargo.toml` (add tauri-plugin-dialog)
- Modify: `src-tauri/src/lib.rs` (register plugin)
- Modify: `src-tauri/capabilities/default.json` (add dialog permissions)
- Run: `yarn add @tauri-apps/plugin-dialog`

**Interfaces:**
- Produces: ability to open native file picker from frontend

- [ ] **Step 1: Add dialog plugin to Cargo.toml**

Add to `[dependencies]` in `src-tauri/Cargo.toml`:
```toml
tauri-plugin-dialog = "2"
```

- [ ] **Step 2: Register plugin in lib.rs**

Update `src-tauri/src/lib.rs` — add `.plugin(tauri_plugin_dialog::init())` to the builder:

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(FileListState(Mutex::new(Vec::new())))
    .invoke_handler(tauri::generate_handler![
        commands::add_files,
        commands::remove_file,
        commands::clear_list,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
```

- [ ] **Step 3: Add dialog permissions to capabilities**

Open `src-tauri/capabilities/default.json` and add `"dialog:default"` to the permissions array:

```json
{
  "permissions": [
    "core:default",
    "dialog:default"
  ]
}
```

- [ ] **Step 4: Install frontend dialog package**

Run:
```bash
yarn add @tauri-apps/plugin-dialog
```

- [ ] **Step 5: Verify it compiles**

Run:
```bash
yarn tauri dev
```

Expected: App launches without errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: add tauri-plugin-dialog for file picker"
```

---

## Task 5: Create TypeScript Types

**Files:**
- Create: `src/types.ts`

**Interfaces:**
- Produces: TS types matching Rust models — used by all frontend components

- [ ] **Step 1: Create types.ts**

```typescript
export type Category = 'image' | 'video' | 'pdf' | 'document' | 'other'

export type FileStatus =
  | 'pending'
  | 'compressing'
  | 'done'
  | 'best_effort'
  | 'failed'
  | 'cancelled'
  | 'unsupported'
  | 'already_under_target'

export interface FileEntry {
  id: string
  name: string
  path: string
  category: Category
  targetBytes: number
  originalSize: number
  status: FileStatus
  compressedSize: number | null
  outputPath: string | null
  error: string | null
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add TypeScript types matching Rust models"
```

---

## Task 6: Create useFileList Hook

**Files:**
- Create: `src/hooks/useFileList.ts`

**Interfaces:**
- Consumes: `FileEntry` from `src/types.ts`, Tauri `invoke` API
- Produces: `useFileList()` hook returning `{ files, addFiles, removeFile, clearList }`

- [ ] **Step 1: Create useFileList.ts**

```typescript
import { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { FileEntry } from '@/types'

export function useFileList() {
  const [files, setFiles] = useState<FileEntry[]>([])

  const addFiles = useCallback(async (paths: string[]) => {
    const newEntries = await invoke<FileEntry[]>('add_files', { filePaths: paths })
    setFiles((prev) => [...prev, ...newEntries])
    return newEntries
  }, [])

  const browseFiles = useCallback(async () => {
    const selected = await open({
      multiple: true,
      filters: [],
    })
    if (!selected) return
    const paths = Array.isArray(selected) ? selected : [selected]
    await addFiles(paths)
  }, [addFiles])

  const removeFile = useCallback(async (fileId: string) => {
    await invoke('remove_file', { fileId })
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
  }, [])

  const clearList = useCallback(async () => {
    await invoke('clear_list')
    setFiles([])
  }, [])

  return { files, addFiles, browseFiles, removeFile, clearList }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add useFileList hook for file list state + IPC"
```

---

## Task 7: Add shadcn Table + Badge Components

**Files:**
- Create: `src/components/ui/table.tsx` (auto-generated)
- Create: `src/components/ui/badge.tsx` (auto-generated)

- [ ] **Step 1: Add Table and Badge via shadcn CLI**

Run:
```bash
yarn dlx shadcn@latest add table badge
```

- [ ] **Step 2: Verify components exist**

Check that `src/components/ui/table.tsx` and `src/components/ui/badge.tsx` exist.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: add shadcn table and badge components"
```

---

## Task 8: Create DropZone Component

**Files:**
- Create: `src/components/DropZone.tsx`

**Interfaces:**
- Consumes: `browseFiles` from `useFileList` hook
- Produces: A drag-drop + click-to-browse area that calls `addFiles` on drop

- [ ] **Step 1: Create DropZone.tsx**

```tsx
import { useState, useCallback, useRef } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface DropZoneProps {
  onBrowse: () => void
  onDrop: (paths: string[]) => void
}

export function DropZone({ onBrowse, onDrop }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current += 1
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current -= 1
    if (dragCounter.current === 0) {
      setIsDragging(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    dragCounter.current = 0

    const files = Array.from(e.dataTransfer.files)
    const paths = files.map((f) => f.path).filter(Boolean)

    if (paths.length > 0) {
      onDrop(paths)
    }
  }, [onDrop])

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={onBrowse}
      className={`border border-dashed rounded-lg py-7 px-4 text-center cursor-pointer transition-colors ${
        isDragging
          ? 'border-primary bg-primary/5'
          : 'border-input bg-muted/30 hover:bg-muted/50'
      }`}
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

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add DropZone component with drag-drop and browse"
```

---

## Task 9: Create FileList Component

**Files:**
- Create: `src/components/FileList.tsx`

**Interfaces:**
- Consumes: `FileEntry[]` from `useFileList`, `removeFile` callback
- Produces: A table showing files with category badges, targets, sizes, status, remove button

- [ ] **Step 1: Create FileList.tsx**

```tsx
import type { FileEntry, Category, FileStatus } from '@/types'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'

interface FileListProps {
  files: FileEntry[]
  onRemove: (fileId: string) => void
}

const categoryVariant: Record<Category, string> = {
  image: 'bg-secondary text-secondary-foreground',
  video: 'bg-secondary text-secondary-foreground',
  pdf: 'bg-secondary text-secondary-foreground',
  document: 'bg-secondary text-secondary-foreground',
  other: 'bg-muted text-muted-foreground',
}

const categoryLabel: Record<Category, string> = {
  image: 'Image',
  video: 'Video',
  pdf: 'PDF',
  document: 'Document',
  other: 'Other',
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—'
  const KB = 1024
  const MB = 1024 * 1024
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(0)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

function formatTarget(bytes: number): string {
  if (bytes === 0) return '—'
  return formatSize(bytes)
}

function StatusBadge({ status }: { status: FileStatus }) {
  const styles: Record<FileStatus, string> = {
    pending: 'text-muted-foreground',
    compressing: 'text-primary',
    done: 'text-primary',
    best_effort: 'text-destructive',
    failed: 'text-destructive',
    cancelled: 'text-muted-foreground',
    unsupported: 'text-muted-foreground',
    already_under_target: 'text-primary',
  }
  const labels: Record<FileStatus, string> = {
    pending: 'Pending',
    compressing: 'Compressing',
    done: 'Done',
    best_effort: 'Best effort',
    failed: 'Failed',
    cancelled: 'Cancelled',
    unsupported: 'Unsupported',
    already_under_target: 'Already under target',
  }
  const dotColors: Record<FileStatus, string> = {
    pending: 'bg-muted-foreground/50',
    compressing: 'bg-primary',
    done: 'bg-primary',
    best_effort: 'bg-destructive',
    failed: 'bg-destructive',
    cancelled: 'bg-muted-foreground/50',
    unsupported: 'bg-muted-foreground/30',
    already_under_target: 'bg-primary',
  }
  return (
    <span className={`flex items-center gap-1.5 text-xs ${styles[status]}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${dotColors[status]}`} />
      {labels[status]}
    </span>
  )
}

export function FileList({ files, onRemove }: FileListProps) {
  if (files.length === 0) return null

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-background/50">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">File</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-8"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => (
            <TableRow
              key={file.id}
              className={file.status === 'unsupported' ? 'opacity-40' : ''}
            >
              <TableCell>
                <div className="text-sm font-medium truncate max-w-[200px]">{file.name}</div>
                <div className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                  {formatSize(file.originalSize)}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant="secondary" className={categoryVariant[file.category]}>
                  {categoryLabel[file.category]}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground tabular-nums">
                {formatTarget(file.targetBytes)}
              </TableCell>
              <TableCell>
                <StatusBadge status={file.status} />
              </TableCell>
              <TableCell>
                <button
                  onClick={() => onRemove(file.id)}
                  className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                  title="Remove from list"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add FileList component with category badges and status"
```

---

## Task 10: Wire Up CompressView

**Files:**
- Modify: `src/views/CompressView.tsx` (replace placeholder with DropZone + FileList + Clear button)

**Interfaces:**
- Consumes: `DropZone`, `FileList`, `useFileList`

- [ ] **Step 1: Replace CompressView.tsx**

```tsx
import { useFileList } from '@/hooks/useFileList'
import { DropZone } from '@/components/DropZone'
import { FileList } from '@/components/FileList'
import { Button } from '@/components/ui/button'

export function CompressView() {
  const { files, addFiles, browseFiles, removeFile, clearList } = useFileList()

  const hasFiles = files.length > 0

  return (
    <div className="flex flex-1 flex-col gap-3.5 p-5 min-h-0 overflow-hidden">
      <div className="flex items-center justify-between shrink-0">
        <h1 className="text-base font-semibold">Compress Files</h1>
        <span className="text-xs text-muted-foreground">Drag files into the area below</span>
      </div>

      <DropZone onBrowse={browseFiles} onDrop={addFiles} className="shrink-0" />

      {hasFiles && (
        <>
          <FileList files={files} onRemove={removeFile} />
          <div className="flex justify-between items-center pt-0.5 shrink-0">
            <span className="text-xs text-muted-foreground">
              <strong className="text-foreground font-semibold">{files.length} files</strong>
            </span>
            <Button variant="ghost" size="sm" onClick={clearList}>
              Clear List
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Update DropZone to accept className**

The `DropZone` component needs to accept a `className` prop. Update `src/components/DropZone.tsx`:

Change the interface:
```tsx
interface DropZoneProps {
  onBrowse: () => void
  onDrop: (paths: string[]) => void
  className?: string
}
```

And apply it to the root div:
```tsx
export function DropZone({ onBrowse, onDrop, className }: DropZoneProps) {
  // ...
  return (
    <div
      // ... event handlers
      className={`border border-dashed rounded-lg py-7 px-4 text-center cursor-pointer transition-colors ${
        isDragging
          ? 'border-primary bg-primary/5'
          : 'border-input bg-muted/30 hover:bg-muted/50'
      } ${className ?? ''}`}
    >
```

- [ ] **Step 3: Verify the app works end-to-end**

Run:
```bash
yarn tauri dev
```

Test:
1. Click the drop zone → file dialog opens → select files → they appear in list
2. Drag files onto the drop zone → they appear in list
3. Each file shows correct category badge and target
4. Unknown extensions show "Other" badge, "Unsupported" status
5. Click × on a file row → file removed from list
6. Click "Clear List" → list empties
7. Drag more files → they append to existing list

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: wire up CompressView with drop zone and file list"
```

---

## Task 11: Acceptance Check

**Acceptance criteria for Slice 2:**

1. ✅ Drag files onto the drop zone → they appear in the file list
2. ✅ Click "browse" → native file dialog opens → selected files appear in list
3. ✅ Each file shows: filename, category badge, target size, file size, status
4. ✅ JPEG/PNG/WebP/HEIC → "Image" badge, target "200 KB"
5. ✅ MP4/MOV → "Video" badge, target "10 MB"
6. ✅ PDF → "PDF" badge, target "2 MB"
7. ✅ DOCX/XLSX/PPTX → "Document" badge, target "1 MB"
8. ✅ Unknown extension → "Other" badge, target "—", status "Unsupported"
9. ✅ Can drag more files at any time — they append to the list
10. ✅ Each file row has a remove button → removes that file
11. ✅ "Clear List" button removes all files
12. ✅ File sizes displayed in human-readable format (KB/MB)

- [ ] **Step 1: Run acceptance checklist**

Go through each criterion. Test manually in the running app.

- [ ] **Step 2: Run Rust unit tests**

```bash
cd src-tauri && cargo test
```

Expected: All detection tests pass.

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: slice 2 complete — file detection + file list"
```

---

## Notes for the Implementer

1. **Drag-drop path access:** HTML5 drag-drop gives `File` objects with `.path` property in Tauri (not available in regular browsers). This is a Tauri-specific behavior.

2. **No compression yet:** The Compress button is not added in this slice. The file list shows "Pending" for supported files and "Unsupported" for others. No compress action.

3. **Default targets are hardcoded:** The target sizes (200 KB, 10 MB, etc.) are hardcoded in `detection.rs`. They will become configurable in Slice 3 (Settings).

4. **File list state is in-memory:** The Rust `FileListState` is a `Mutex<Vec<FileEntry>>`. It resets when the app restarts. This is fine for v1.