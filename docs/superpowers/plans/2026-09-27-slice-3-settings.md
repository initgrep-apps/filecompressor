# Slice 3: Settings (Storage + UI) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-step. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** User can change category targets, output folder, and quality floors in the Settings view. Changes persist across app restarts via tauri-plugin-store. Browse button opens native folder picker. Reset restores defaults.

**Architecture:** tauri-plugin-store for persistence. Rust `Settings` struct with serde serialization. Settings view with form inputs (number + unit selector, folder picker, quality floors in collapsible details). Tauri IPC commands: `get_settings`, `save_settings`, `reset_settings`, `browse_folder`.

**Tech Stack:** Tauri 2, tauri-plugin-store, tauri-plugin-dialog, React, shadcn/ui (Input, Select, Button, Badge, Accordion/Details)

## Global Constraints

- **Settings persist** across restarts via tauri-plugin-store
- **Default output folder:** `~/Documents/Compressed`
- **Settings JSON schema:** Must match the spec (Section 7) exactly
- **Settings apply to next compression run**, not retroactively
- **Quality floors collapsed** under "advanced" by default

## File Structure

```
src-tauri/src/
├── settings.rs               # Settings struct, defaults, load/save logic
├── commands.rs               # (modify) add settings commands
├── lib.rs                    # (modify) register store plugin + settings state

src/
├── views/SettingsView.tsx    # (replace placeholder) full settings form
├── hooks/
│   └── useSettings.ts        # Load/save/reset settings via IPC
├── types.ts                  # (modify) add Settings type
```

## Acceptance Criteria

1. Settings view shows output folder path + "Browse" button
2. Clicking Browse opens native OS folder picker → selected path appears
3. Category targets show 4 rows (Images, Videos, PDF, Documents) with number input + KB/MB selector
4. Each category row shows a badge and supported formats hint
5. Quality floors section is collapsed under "advanced" — click to expand
6. Quality floors show: image min quality %, video min CRF, video min resolution, PDF min DPI, PDF min JPEG quality %, documents media quality %
7. "Save Changes" persists settings → restart app → settings are restored
8. "Cancel" reverts to last saved settings
9. "Reset to defaults" restores all values to spec defaults
10. Settings from this slice are used by the file list (Slice 2) for target sizes

---

## Task 1: Add tauri-plugin-store

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/capabilities/default.json`
- Run: `yarn add @tauri-apps/plugin-store`

- [ ] **Step 1: Add store plugin to Cargo.toml**

Add to `[dependencies]`:
```toml
tauri-plugin-store = "2"
```

- [ ] **Step 2: Register plugin in lib.rs**

Add `.plugin(tauri_plugin_store::Builder::default().build())` to the Tauri builder chain in `src-tauri/src/lib.rs`.

- [ ] **Step 3: Add store permissions**

In `src-tauri/capabilities/default.json`, add `"store:default"` to permissions:
```json
{
  "permissions": [
    "core:default",
    "dialog:default",
    "store:default"
  ]
}
```

- [ ] **Step 4: Install frontend package**

```bash
yarn add @tauri-apps/plugin-store
```

- [ ] **Step 5: Verify compilation**

```bash
yarn tauri dev
```

Expected: App launches without errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: add tauri-plugin-store for settings persistence"
```

---

## Task 2: Create Settings Model in Rust

**Files:**
- Create: `src-tauri/src/settings.rs`

**Interfaces:**
- Produces: `Settings` struct with `default()`, `to_json()`, `from_json()` methods

- [ ] **Step 1: Create settings.rs**

```rust
use serde::{Deserialize, Serialize};

const KB: u64 = 1024;
const MB: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTarget {
    pub size: u64,
    pub unit: String, // "KB" or "MB"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageQualityFloor {
    pub min_quality: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoQualityFloor {
    pub min_crf: u32,
    pub min_resolution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfQualityFloor {
    pub min_dpi: u32,
    pub min_jpeg_quality: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentQualityFloor {
    pub min_media_quality: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityFloors {
    pub image: ImageQualityFloor,
    pub video: VideoQualityFloor,
    pub pdf: PdfQualityFloor,
    pub document: DocumentQualityFloor,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub output_folder: String,
    pub category_targets: std::collections::HashMap<String, CategoryTarget>,
    pub quality_floors: QualityFloors,
}

impl Default for Settings {
    fn default() -> Self {
        let mut category_targets = std::collections::HashMap::new();
        category_targets.insert("image".to_string(), CategoryTarget { size: 200, unit: "KB".to_string() });
        category_targets.insert("video".to_string(), CategoryTarget { size: 10, unit: "MB".to_string() });
        category_targets.insert("pdf".to_string(), CategoryTarget { size: 2, unit: "MB".to_string() });
        category_targets.insert("document".to_string(), CategoryTarget { size: 1, unit: "MB".to_string() });

        Settings {
            output_folder: default_output_folder(),
            category_targets,
            quality_floors: QualityFloors {
                image: ImageQualityFloor { min_quality: 30 },
                video: VideoQualityFloor { min_crf: 28, min_resolution: "480p".to_string() },
                pdf: PdfQualityFloor { min_dpi: 72, min_jpeg_quality: 15 },
                document: DocumentQualityFloor { min_media_quality: 40 },
            },
        }
    }
}

fn default_output_folder() -> String {
    if let Some(docs) = dirs::document_dir() {
        docs.join("Compressed").to_string_lossy().to_string()
    } else {
        "./Compressed".to_string()
    }
}

impl Settings {
    pub fn target_bytes_for(&self, category: &str) -> u64 {
        if let Some(target) = self.category_targets.get(category) {
            let multiplier = match target.unit.as_str() {
                "MB" => MB,
                _ => KB,
            };
            target.size * multiplier
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_settings() {
        let s = Settings::default();
        assert_eq!(s.category_targets.get("image").unwrap().size, 200);
        assert_eq!(s.category_targets.get("image").unwrap().unit, "KB");
        assert_eq!(s.category_targets.get("video").unwrap().size, 10);
        assert_eq!(s.quality_floors.image.min_quality, 30);
        assert_eq!(s.quality_floors.video.min_crf, 28);
        assert_eq!(s.quality_floors.pdf.min_dpi, 72);
    }

    #[test]
    fn test_target_bytes_conversion() {
        let s = Settings::default();
        assert_eq!(s.target_bytes_for("image"), 200 * 1024);
        assert_eq!(s.target_bytes_for("video"), 10 * 1024 * 1024);
        assert_eq!(s.target_bytes_for("pdf"), 2 * 1024 * 1024);
        assert_eq!(s.target_bytes_for("document"), 1 * 1024 * 1024);
        assert_eq!(s.target_bytes_for("other"), 0);
    }
}
```

- [ ] **Step 2: Add dirs dependency**

Add to `src-tauri/Cargo.toml`:
```toml
dirs = "5"
```

- [ ] **Step 3: Register module in lib.rs**

Add `mod settings;` to `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run tests**

```bash
cd src-tauri && cargo test settings -- --nocapture
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Settings model with defaults + tests"
```

---

## Task 3: Implement Settings Commands

**Files:**
- Modify: `src-tauri/src/commands.rs` (add settings commands)
- Modify: `src-tauri/src/lib.rs` (register new commands + store-managed state)

**Interfaces:**
- Produces: `get_settings`, `save_settings`, `reset_settings`, `browse_folder` commands

- [ ] **Step 1: Add settings commands to commands.rs**

Add to `src-tauri/src/commands.rs`:

```rust
use crate::settings::Settings;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";

fn load_settings(app: &AppHandle) -> Settings {
    let store = app.store(STORE_FILE).unwrap();
    if let Some(value) = store.get("settings") {
        serde_json::from_value(value).unwrap_or_default()
    } else {
        Settings::default()
    }
}

fn save_settings_to_store(app: &AppHandle, settings: &Settings) {
    let store = app.store(STORE_FILE).unwrap();
    store.set("settings", serde_json::to_value(settings).unwrap());
    store.save();
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Settings {
    load_settings(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) {
    save_settings_to_store(&app, &settings);
}

#[tauri::command]
pub fn reset_settings(app: AppHandle) -> Settings {
    let defaults = Settings::default();
    save_settings_to_store(&app, &defaults);
    defaults
}
```

- [ ] **Step 2: Register commands in lib.rs**

Update the `invoke_handler` in `src-tauri/src/lib.rs`:

```rust
.invoke_handler(tauri::generate_handler![
    commands::add_files,
    commands::remove_file,
    commands::clear_list,
    commands::get_settings,
    commands::save_settings,
    commands::reset_settings,
])
```

- [ ] **Step 3: Update add_files to use settings for target bytes**

Update `FileEntry::new` in `models.rs` to accept target from settings instead of hardcoded defaults. Change the signature:

```rust
pub fn new(path: &str, target_bytes: u64) -> Self {
    // ... same as before but use the passed target_bytes
}
```

And update `commands.rs` `add_files`:

```rust
#[tauri::command]
pub fn add_files(
    file_paths: Vec<String>,
    state: State<FileListState>,
    app: AppHandle,
) -> Vec<FileEntry> {
    let settings = crate::commands::load_settings(&app);
    let mut list = state.0.lock().unwrap();
    let mut new_entries = Vec::new();

    for path in file_paths {
        if !std::path::Path::new(&path).exists() {
            continue;
        }
        if list.iter().any(|e| e.path == path) {
            continue;
        }
        let name = std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown")
            .to_string();
        let category = crate::detection::detect_category(&name);
        let category_key = match category {
            crate::models::Category::Image => "image",
            crate::models::Category::Video => "video",
            crate::models::Category::Pdf => "pdf",
            crate::models::Category::Document => "document",
            crate::models::Category::Other => "other",
        };
        let target_bytes = settings.target_bytes_for(category_key);
        let entry = FileEntry::new(&path, target_bytes);
        new_entries.push(entry.clone());
        list.push(entry);
    }

    new_entries
}
```

Make `load_settings` public: change `fn load_settings` to `pub fn load_settings` in commands.rs.

- [ ] **Step 4: Verify compilation**

```bash
yarn tauri dev
```

Expected: App launches without errors. File list still works but now uses settings-based targets.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add settings commands (get/save/reset) + use settings for targets"
```

---

## Task 4: Add TypeScript Settings Types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add Settings types**

Add to `src/types.ts`:

```typescript
export interface CategoryTarget {
  size: number
  unit: 'KB' | 'MB'
}

export interface QualityFloors {
  image: { minQuality: number }
  video: { minCrf: number; minResolution: string }
  pdf: { minDpi: number; minJpegQuality: number }
  document: { minMediaQuality: number }
}

export interface Settings {
  outputFolder: string
  categoryTargets: Record<string, CategoryTarget>
  qualityFloors: QualityFloors
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add Settings TypeScript types"
```

---

## Task 5: Create useSettings Hook

**Files:**
- Create: `src/hooks/useSettings.ts`

- [ ] **Step 1: Create useSettings.ts**

```typescript
import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { Settings } from '@/types'

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = useCallback(async () => {
    const s = await invoke<Settings>('get_settings')
    setSettings(s)
    setLoading(false)
  }, [])

  const saveSettings = useCallback(async (s: Settings) => {
    await invoke('save_settings', { settings: s })
    setSettings(s)
  }, [])

  const resetSettings = useCallback(async () => {
    const defaults = await invoke<Settings>('reset_settings')
    setSettings(defaults)
    return defaults
  }, [])

  const browseFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false })
    if (typeof selected === 'string') {
      return selected
    }
    return null
  }, [])

  return { settings, loading, saveSettings, resetSettings, browseFolder }
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add useSettings hook for settings IPC"
```

---

## Task 6: Build SettingsView UI

**Files:**
- Modify: `src/views/SettingsView.tsx` (replace placeholder)
- Create: shadcn Input, Select, Accordion components

- [ ] **Step 1: Add required shadcn components**

```bash
yarn dlx shadcn@latest add input select accordion separator
```

- [ ] **Step 2: Replace SettingsView.tsx**

```tsx
import { useState, useEffect } from 'react'
import { useSettings } from '@/hooks/useSettings'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import type { Settings, CategoryTarget } from '@/types'

const categories = [
  { key: 'image', label: 'Images', badge: 'Image', formats: 'JPEG, PNG, WebP, HEIC' },
  { key: 'video', label: 'Videos', badge: 'Video', formats: 'MP4, MOV' },
  { key: 'pdf', label: 'PDF', badge: 'PDF', formats: 'PDF documents' },
  { key: 'document', label: 'Documents', badge: 'Document', formats: 'DOCX, XLSX, PPTX' },
] as const

export function SettingsView() {
  const { settings, loading, saveSettings, resetSettings, browseFolder } = useSettings()
  const [draft, setDraft] = useState<Settings | null>(null)

  useEffect(() => {
    if (settings) setDraft(settings)
  }, [settings])

  if (loading || !draft) {
    return <div className="p-6 text-sm text-muted-foreground">Loading settings…</div>
  }

  const updateTarget = (key: string, field: keyof CategoryTarget, value: string | number) => {
    setDraft((prev) => {
      if (!prev) return prev
      const target = prev.categoryTargets[key] ?? { size: 0, unit: 'KB' }
      return {
        ...prev,
        categoryTargets: {
          ...prev.categoryTargets,
          [key]: { ...target, [field]: value },
        },
      }
    })
  }

  const updateFloor = (path: string, value: string | number) => {
    setDraft((prev) => {
      if (!prev) return prev
      const keys = path.split('.')
      const floors = { ...prev.qualityFloors }
      // Navigate and set nested value
      if (keys.length === 2) {
        const [category, field] = keys
        // Handle each category's floor
        if (category === 'image') {
          floors.image = { ...floors.image, [field]: value }
        } else if (category === 'video') {
          floors.video = { ...floors.video, [field]: value }
        } else if (category === 'pdf') {
          floors.pdf = { ...floors.pdf, [field]: value }
        } else if (category === 'document') {
          floors.document = { ...floors.document, [field]: value }
        }
      }
      return { ...prev, qualityFloors: floors }
    })
  }

  const handleBrowse = async () => {
    const folder = await browseFolder()
    if (folder) {
      setDraft((prev) => prev ? { ...prev, outputFolder: folder } : prev)
    }
  }

  const handleSave = () => {
    if (draft) saveSettings(draft)
  }

  const handleReset = async () => {
    const defaults = await resetSettings()
    setDraft(defaults)
  }

  const hasChanges = JSON.stringify(draft) !== JSON.stringify(settings)

  return (
    <div className="flex flex-1 flex-col min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-base font-semibold">Settings</h1>
          <button
            onClick={handleReset}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Reset to defaults
          </button>
        </div>

        {/* Output Folder */}
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-medium">Output Folder</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Compressed files are saved here. Originals are never modified.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 h-9 px-3 rounded-md border border-input bg-background/50 text-sm text-muted-foreground">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="truncate">{draft.outputFolder}</span>
            </div>
            <Button variant="outline" size="sm" onClick={handleBrowse}>Browse</Button>
          </div>
        </div>

        <Separator />

        {/* Category Targets */}
        <div className="space-y-4">
          <div>
            <h2 className="text-sm font-medium">Category Targets</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Maximum file size per category. Applied to all files in that category.
            </p>
          </div>
          {categories.map((cat) => {
            const target = draft.categoryTargets[cat.key] ?? { size: 0, unit: 'KB' }
            return (
              <div key={cat.key} className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2.5">
                  <Badge variant="secondary">{cat.badge}</Badge>
                  <span className="text-sm">{cat.label}</span>
                  <span className="text-xs text-muted-foreground">{cat.formats}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    value={target.size}
                    onChange={(e) => updateTarget(cat.key, 'size', parseInt(e.target.value) || 0)}
                    className="w-16 text-right tabular-nums"
                  />
                  <select
                    value={target.unit}
                    onChange={(e) => updateTarget(cat.key, 'unit', e.target.value)}
                    className="h-9 px-2 rounded-md border border-input bg-background/50 text-sm text-muted-foreground"
                  >
                    <option value="KB">KB</option>
                    <option value="MB">MB</option>
                  </select>
                </div>
              </div>
            )
          })}
        </div>

        <Separator />

        {/* Quality Floors */}
        <Accordion type="single" collapsible>
          <AccordionItem value="quality-floors">
            <AccordionTrigger className="text-sm font-medium">
              Quality Floors <span className="text-xs font-normal text-muted-foreground ml-2">advanced</span>
            </AccordionTrigger>
            <AccordionContent className="space-y-4 pt-2">
              <p className="text-xs text-muted-foreground">
                Engine stops compressing below these values and reports "best effort".
              </p>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Images minimum quality</span>
                  <div className="flex items-center gap-1.5">
                    <Input type="number" value={draft.qualityFloors.image.minQuality}
                      onChange={(e) => updateFloor('image.minQuality', parseInt(e.target.value) || 0)}
                      className="w-16 text-right tabular-nums" />
                    <span className="text-xs text-muted-foreground w-4">%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Videos minimum CRF</span>
                  <Input type="number" value={draft.qualityFloors.video.minCrf}
                    onChange={(e) => updateFloor('video.minCrf', parseInt(e.target.value) || 0)}
                    className="w-16 text-right tabular-nums" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Videos minimum resolution</span>
                  <select
                    value={draft.qualityFloors.video.minResolution}
                    onChange={(e) => updateFloor('video.minResolution', e.target.value)}
                    className="h-9 px-2.5 rounded-md border border-input bg-background/50 text-sm"
                  >
                    <option value="480p">480p</option>
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">PDF minimum DPI</span>
                  <div className="flex items-center gap-1.5">
                    <Input type="number" value={draft.qualityFloors.pdf.minDpi}
                      onChange={(e) => updateFloor('pdf.minDpi', parseInt(e.target.value) || 0)}
                      className="w-16 text-right tabular-nums" />
                    <span className="text-xs text-muted-foreground w-6">dpi</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">PDF minimum JPEG quality</span>
                  <div className="flex items-center gap-1.5">
                    <Input type="number" value={draft.qualityFloors.pdf.minJpegQuality}
                      onChange={(e) => updateFloor('pdf.minJpegQuality', parseInt(e.target.value) || 0)}
                      className="w-16 text-right tabular-nums" />
                    <span className="text-xs text-muted-foreground w-4">%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Documents media quality</span>
                  <div className="flex items-center gap-1.5">
                    <Input type="number" value={draft.qualityFloors.document.minMediaQuality}
                      onChange={(e) => updateFloor('document.minMediaQuality', parseInt(e.target.value) || 0)}
                      className="w-16 text-right tabular-nums" />
                    <span className="text-xs text-muted-foreground w-4">%</span>
                  </div>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {/* Sticky footer */}
      <div className="border-t border-border p-4 flex justify-end gap-2 shrink-0 bg-card">
        <Button variant="ghost" onClick={() => setSettings(settings)} disabled={!hasChanges}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges}>
          Save Changes
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify settings view works**

Run:
```bash
yarn tauri dev
```

Test:
1. Navigate to Settings → see output folder, category targets, quality floors
2. Change a target value → Save Changes button enables
3. Click Save → button disables
4. Expand quality floors → see all 6 fields
5. Click Reset to defaults → values reset
6. Restart app → settings persist

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: build SettingsView with category targets, output folder, quality floors"
```

---

## Task 7: Acceptance Check

- [ ] **Step 1: Run all acceptance criteria**

1. ✅ Settings view shows output folder + Browse button
2. ✅ Browse opens native folder picker
3. ✅ Category targets: 4 rows with number + unit selector
4. ✅ Each row shows badge + formats hint
5. ✅ Quality floors collapsed under "advanced"
6. ✅ All 6 quality floor fields present
7. ✅ Save persists → restart restores
8. ✅ Cancel reverts to last saved
9. ✅ Reset to defaults works
10. ✅ File list (Slice 2) now uses settings-based targets

- [ ] **Step 2: Run Rust tests**

```bash
cd src-tauri && cargo test
```

Expected: All tests pass (detection + settings).

- [ ] **Step 3: Final commit**

```bash
git add -A
git commit -m "feat: slice 3 complete — settings storage + UI"
```