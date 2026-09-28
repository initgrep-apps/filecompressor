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

**Interfaces:**
- Produces: store plugin registered in Tauri builder, `settings.json` store available via `app.store("settings.json")` (StoreExt), `store:default` capability granted

**Acceptance Criteria:**
- `tauri-plugin-store` present in `src-tauri/Cargo.toml` + `@tauri-apps/plugin-store` in `package.json`
- Plugin registered in `src-tauri/src/lib.rs` builder chain alongside existing opener + dialog plugins (both preserved)
- `store:default` added to `src-tauri/capabilities/default.json` — existing `core:default`, `opener:default`, `dialog:default` all preserved
- App launches clean: `yarn tauri dev` shows no plugin errors
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- No unit tests feasible (plugin wiring verified at runtime). Compile gate + `yarn tauri dev` launch is the verification.

- [x] **Step 1: Add store plugin to Cargo.toml**

Add to `[dependencies]`:
```toml
tauri-plugin-store = "2"
```

- [x] **Step 2: Register plugin in lib.rs**

Add `.plugin(tauri_plugin_store::Builder::default().build())` to the Tauri builder chain in `src-tauri/src/lib.rs`.

- [x] **Step 3: Add store permissions**

In `src-tauri/capabilities/default.json`, add `"store:default"` to the existing permissions array (do NOT remove `opener:default` — it is already present and required):
```json
{
  "permissions": [
    "core:default",
    "opener:default",
    "dialog:default",
    "store:default"
  ]
}
```

- [x] **Step 4: Install frontend package**

```bash
yarn add @tauri-apps/plugin-store
```

- [x] **Step 5: Verify compilation**

```bash
yarn tauri dev
```

Expected: App launches without errors.

- [x] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: add tauri-plugin-store for settings persistence"
```

---

## Task 2: Create Settings Model in Rust

**Files:**
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/Cargo.toml` (add `dirs = "7"`)

**Interfaces:**
- Produces: `Settings` struct with `Default::default()`, serde (de)serialization matching spec §7 JSON exactly (camelCase), `target_bytes_for(&str) -> u64`, and pure `parse_settings_value(Option<serde_json::Value>) -> Settings` fallback parser
- serde keys: `outputFolder`, `categoryTargets` (`image`/`video`/`pdf`/`document` → `{size, unit}`), `qualityFloors` (`image.minQuality`, `video.minCrf`+`minResolution`, `pdf.minDpi`+`minJpegQuality`, `document.minMediaQuality`)

**Acceptance Criteria:**
- Defaults match spec §3/§7 exactly: image 200/KB, video 10/MB, pdf 2/MB, document 1/MB; floors image minQuality 30, video minCrf 28 + minResolution "480p", pdf minDpi 72 + minJpegQuality 15, document minMediaQuality 40
- Default output folder `<documents>/Compressed` via `dirs` crate; falls back to `./Compressed` if documents dir unavailable
- Serialized JSON keys are camelCase per spec §7 (verified by serde round-trip test)
- `target_bytes_for` converts KB→1024×, MB→1048576×; unknown category → 0, unknown unit → KB multiplier
- `dirs = "7"` (per AGENTS.md pinned version — not "5")
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `test_default_settings` — all 4 category defaults (size+unit) and all 6 floor fields (incl. pdf.minJpegQuality 15, document.minMediaQuality 40, video.minResolution "480p")
- `test_target_bytes_conversion` — image→200×1024, video→10×1024², pdf→2×1024², document→1×1024²
- `test_settings_serde_roundtrip_camel_case` — `to_value` → assert exact camelCase keys (`outputFolder`, `minQuality`, `minCrf`, `minJpegQuality`, `minMediaQuality`) → `from_value` → struct equality (derive `PartialEq`)
- `test_target_bytes_unknown_unit_falls_back_to_kb` — unit `"gb"`/`""` → `size * 1024`
- `test_target_bytes_for_missing_category_returns_zero` — `"other"` and `""` → 0
- `test_target_bytes_zero_size_returns_zero` — custom target size 0 → 0
- `test_default_output_folder_ends_with_compressed` — path ends with `Compressed`
- `test_parse_settings_value_corrupt_falls_back_to_defaults` — wrong-typed field (e.g. `size: "not-a-number"`) → `Settings::default()`
- `test_parse_settings_value_partial_fills_missing_with_defaults` — only some fields present → missing filled from defaults

- [x] **Step 1: Create settings.rs**

```rust
use serde::{Deserialize, Serialize};

const KB: u64 = 1024;
const MB: u64 = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryTarget {
    pub size: u64,
    pub unit: String, // "KB" or "MB"
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageQualityFloor {
    pub min_quality: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoQualityFloor {
    pub min_crf: u32,
    pub min_resolution: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfQualityFloor {
    pub min_dpi: u32,
    pub min_jpeg_quality: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentQualityFloor {
    pub min_media_quality: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityFloors {
    pub image: ImageQualityFloor,
    pub video: VideoQualityFloor,
    pub pdf: PdfQualityFloor,
    pub document: DocumentQualityFloor,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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

/// Pure fallback parser: corrupt or partial store value → defaults.
/// Keeps command layer thin and unit-testable without a Tauri AppHandle.
pub fn parse_settings_value(value: Option<serde_json::Value>) -> Settings {
    match value {
        Some(v) => serde_json::from_value(v).unwrap_or_default(),
        None => Settings::default(),
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
        assert_eq!(s.category_targets.get("video").unwrap().unit, "MB");
        assert_eq!(s.category_targets.get("pdf").unwrap().size, 2);
        assert_eq!(s.category_targets.get("document").unwrap().size, 1);
        assert_eq!(s.quality_floors.image.min_quality, 30);
        assert_eq!(s.quality_floors.video.min_crf, 28);
        assert_eq!(s.quality_floors.video.min_resolution, "480p");
        assert_eq!(s.quality_floors.pdf.min_dpi, 72);
        assert_eq!(s.quality_floors.pdf.min_jpeg_quality, 15);
        assert_eq!(s.quality_floors.document.min_media_quality, 40);
    }

    #[test]
    fn test_target_bytes_conversion() {
        let s = Settings::default();
        assert_eq!(s.target_bytes_for("image"), 200 * 1024);
        assert_eq!(s.target_bytes_for("video"), 10 * 1024 * 1024);
        assert_eq!(s.target_bytes_for("pdf"), 2 * 1024 * 1024);
        assert_eq!(s.target_bytes_for("document"), 1 * 1024 * 1024);
    }

    #[test]
    fn test_settings_serde_roundtrip_camel_case() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        assert!(value.get("outputFolder").is_some());
        let floors = value.get("qualityFloors").unwrap();
        assert!(floors.get("image").unwrap().get("minQuality").is_some());
        assert!(floors.get("video").unwrap().get("minCrf").is_some());
        assert!(floors.get("pdf").unwrap().get("minJpegQuality").is_some());
        assert!(floors.get("document").unwrap().get("minMediaQuality").is_some());
        let roundtripped: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(Settings::default(), roundtripped);
    }

    #[test]
    fn test_target_bytes_unknown_unit_falls_back_to_kb() {
        let mut s = Settings::default();
        s.category_targets.insert("image".to_string(), CategoryTarget { size: 500, unit: "gb".to_string() });
        assert_eq!(s.target_bytes_for("image"), 500 * 1024);
    }

    #[test]
    fn test_target_bytes_for_missing_category_returns_zero() {
        let s = Settings::default();
        assert_eq!(s.target_bytes_for("other"), 0);
        assert_eq!(s.target_bytes_for(""), 0);
    }

    #[test]
    fn test_target_bytes_zero_size_returns_zero() {
        let mut s = Settings::default();
        s.category_targets.insert("image".to_string(), CategoryTarget { size: 0, unit: "KB".to_string() });
        assert_eq!(s.target_bytes_for("image"), 0);
    }

    #[test]
    fn test_default_output_folder_ends_with_compressed() {
        let s = Settings::default();
        assert!(s.output_folder.ends_with("Compressed"));
    }

    #[test]
    fn test_parse_settings_value_corrupt_falls_back_to_defaults() {
        let corrupt = serde_json::json!({
            "outputFolder": "~/Documents/Compressed",
            "categoryTargets": { "image": { "size": "not-a-number", "unit": "KB" } }
        });
        assert_eq!(parse_settings_value(Some(corrupt)), Settings::default());
        assert_eq!(parse_settings_value(None), Settings::default());
    }

    #[test]
    fn test_parse_settings_value_partial_fills_missing_with_defaults() {
        let partial = serde_json::json!({
            "outputFolder": "/tmp/out"
        });
        let parsed = parse_settings_value(Some(partial));
        assert_eq!(parsed.output_folder, "/tmp/out");
        assert_eq!(parsed.category_targets.get("image").unwrap().size, 200);
        assert_eq!(parsed.quality_floors.pdf.min_dpi, 72);
    }
}
```

- [x] **Step 2: Add dirs dependency**

Add to `src-tauri/Cargo.toml`:
```toml
dirs = "7"
```

> AGENTS.md pins `dirs 7.0` — do not use "5".

- [x] **Step 3: Register module in lib.rs**

Add `mod settings;` to `src-tauri/src/lib.rs`.

- [x] **Step 4: Run tests**

```bash
cd src-tauri && cargo test settings -- --nocapture
```

Expected: All 8 settings tests pass.

- [x] **Step 5: Commit**

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
- Produces: `get_settings`, `save_settings`, `reset_settings` commands + `pub fn load_settings(app: &AppHandle)` helper. `browse_folder` is NOT a Rust command — spec §7 lists it, but this plan implements browse purely frontend-side via `@tauri-apps/plugin-dialog` (`dialog:default` capability already granted, plugin installed). Spec divergence logged in `docs/bugs.md`.
- `add_files_core` extended (NOT replaced) with a target-bytes resolver param — canonicalize, dedup, is_file check, and poisoned-mutex recovery from Slice 2 must be preserved

**Acceptance Criteria:**
- `get_settings` returns persisted settings or defaults; `save_settings` persists to store; `reset_settings` both returns AND persists defaults (restart must not resurrect old values)
- Corrupt/partial store value falls back to `Settings::default()` via `parse_settings_value` — never panics
- `add_files` resolves target bytes from settings via `settings.target_bytes_for(category_key)`; existing canonicalization + dedup + `is_file` behavior unchanged (Slice 2 regression guard)
- `FileEntry::new` signature change (path, target_bytes) — all existing models.rs/commands.rs test call sites updated in the same task
- Commands registered in `invoke_handler`: `get_settings`, `save_settings`, `reset_settings` (alongside existing 3)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `test_load_settings_corrupt_value_falls_back_to_defaults` — corrupt `serde_json::Value` through `parse_settings_value` → defaults (pure unit test)
- `test_add_files_core_uses_settings_targets` — pass target resolver returning custom image target (500 KB) → entry `target_bytes == 500*1024`; resolver for Other → 0
- Existing 11 `add_files_core` tests + 12 models tests updated for new signature and stay green (canonicalize/dedup/is_file regressions guard)

- [x] **Step 1: Add settings commands to commands.rs**

Add to `src-tauri/src/commands.rs`:

```rust
use crate::settings::{parse_settings_value, Settings};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const STORE_FILE: &str = "settings.json";

pub fn load_settings(app: &AppHandle) -> Settings {
    match app.try_store(STORE_FILE) {
        Some(store) => parse_settings_value(store.get("settings")),
        None => Settings::default(),
    }
}

fn save_settings_to_store(app: &AppHandle, settings: &Settings) {
    let store = app
        .try_store(STORE_FILE)
        .unwrap_or_else(|| app.store_builder().build(STORE_FILE).expect("store build"));
    store.set("settings", serde_json::to_value(settings).expect("serialize settings"));
    store.save().expect("persist store");
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

- [x] **Step 2: Register commands in lib.rs**

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

- [x] **Step 3: Update add_files to use settings for target bytes**

> ⚠️ **Do NOT replace `add_files_core` body.** Existing implementation (commands.rs:23-48) has `is_file()` check, `fs::canonicalize` + canonical-path dedup with case-variant handling, and poisoned-mutex recovery. Preserve all of it — only extend with a target resolver. Plan originally replaced this body, dropping those behaviors (regression — see docs/bugs.md).

Extend `add_files_core` with a target-bytes resolver param:

```rust
pub fn add_files_core(
    list: &mut Vec<FileEntry>,
    paths: &[String],
    target_resolver: &dyn Fn(&Category) -> u64,
) -> Vec<FileEntry> {
    // ... same body as before, but where target_bytes was
    // detection::default_target_bytes(category), now use:
    //   target_resolver(&category)
}
```

Update `FileEntry::new` in `models.rs` to accept target bytes:

```rust
pub fn new(path: &str, target_bytes: u64) -> Self {
    // ... same as before but use the passed target_bytes
}
```

Update all existing models.rs + commands.rs test call sites (10 single-arg `FileEntry::new` calls in models.rs tests, 11 `add_files_core` calls in commands.rs tests) to the new signatures. In commands.rs tests, pass a resolver like `&|c| detection::default_target_bytes(c)` to keep existing expectations; update `models.rs:116` hardcoded `target_bytes == 200 * 1024` assertion accordingly.

Then wire the settings resolver in `add_files`:

```rust
#[tauri::command]
pub fn add_files(
    file_paths: Vec<String>,
    state: State<FileListState>,
    app: AppHandle,
) -> Vec<FileEntry> {
    let settings = load_settings(&app);
    let mut list = state
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let resolver = |category: &crate::models::Category| -> u64 {
        let key = match category {
            crate::models::Category::Image => "image",
            crate::models::Category::Video => "video",
            crate::models::Category::Pdf => "pdf",
            crate::models::Category::Document => "document",
            crate::models::Category::Other => "other",
        };
        settings.target_bytes_for(key)
    };

    add_files_core(&mut list, &file_paths, &resolver)
}
```

Keep the existing canonicalize/dedup/is_file/poison logic inside `add_files_core` untouched.

- [x] **Step 4: Run Rust tests + verify compilation**

```bash
cd src-tauri && cargo test
```

Expected: All existing tests (detection + models + commands, updated for new signatures) pass + new `test_load_settings_corrupt_value_falls_back_to_defaults`, `test_add_files_core_uses_settings_targets` pass.

```bash
yarn tauri dev
```

Expected: App launches without errors. File list still works but now uses settings-based targets.

- [x] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add settings commands (get/save/reset) + use settings for targets"
```

---

## Task 4: Add TypeScript Settings Types

**Files:**
- Modify: `src/types.ts`

**Interfaces:**
- Produces: `Settings`, `CategoryTarget`, `QualityFloors` types in `src/types.ts` mirroring Rust `settings.rs` camelCase wire format (spec §7)

**Acceptance Criteria:**
- Types match spec §7 JSON exactly: `outputFolder`, `categoryTargets` → `Record<string, CategoryTarget>` with `size: number` + `unit: 'KB' | 'MB'`, `qualityFloors` nested per-category floors (`minQuality`, `minCrf`, `minResolution`, `minDpi`, `minJpegQuality`, `minMediaQuality`)
- `yarn build` typechecks with new types exported
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- No runtime tests — type-only task. Contract verified by Rust serde round-trip test (Task 2) + `tsc` via gate. Fixture contract test skipped (TS structural typing adds nothing over compile check).

- [x] **Step 1: Add Settings types**

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

- [x] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add Settings TypeScript types"
```

---

## Task 5: Create useSettings Hook
**Files:**
- Create: `src/hooks/useSettings.ts`
- Create: `src/hooks/useSettings.test.ts`

**Interfaces:**
- Produces: `useSettings()` hook returning `{ settings, loading, saveSettings, resetSettings, browseFolder, error }` — must follow the `useFileList.ts` error-handling convention (try/catch, non-throwing IPC ops, `toMessage`-style error state). Plan's original hook had no try/catch (drift — logged in docs/bugs.md).

**Acceptance Criteria:**
- Loads settings on mount via `invoke('get_settings')`; `loading` true until resolved
- `saveSettings(s)` invokes `save_settings` then syncs local state; on IPC failure, state unchanged and `error` set
- `resetSettings()` invokes `reset_settings`, returns defaults, applies to state
- `browseFolder()` returns selected path string, or `null` on cancel/non-string result (never throws)
- IPC rejection never leaves app stuck in `loading` — error surfaced via `error` state
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `it('loads settings on mount')` — mocked `invoke('get_settings')` resolves → state set, `loading` false
- `it('saveSettings invokes save_settings and syncs state')`
- `it('does not update state when save rejects')` — error state set instead
- `it('resetSettings returns and applies defaults')`
- `it('browseFolder returns null when dialog cancelled')` — mocked `open` → `null`
- `it('browseFolder returns selected path')`
- `it('browseFolder returns null for non-string selection')` — mocked `open` → array
- `it('keeps error state and ends loading when get_settings rejects')` — no infinite loading

- [ ] **Step 1: Create useSettings.ts**

```typescript
import { useState, useEffect, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { Settings } from '@/types'

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const s = await invoke<Settings>('get_settings')
        if (!cancelled) setSettings(s)
      } catch (err) {
        if (!cancelled) setError(toMessage(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
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

  const browseFolder = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await open({ directory: true, multiple: false })
      return typeof selected === 'string' ? selected : null
    } catch {
      return null
    }
  }, [])

  return { settings, loading, error, saveSettings, resetSettings, browseFolder }
}
```

- [ ] **Step 2: Create useSettings.test.ts**

Vitest + `renderHook`, mocking `@tauri-apps/api/core` and `@tauri-apps/plugin-dialog` (pattern: existing `useFileList.test.ts`):

- `it('loads settings on mount')`
- `it('saveSettings invokes save_settings and syncs state')`
- `it('does not update state when save rejects')`
- `it('resetSettings returns and applies defaults')`
- `it('browseFolder returns null when dialog cancelled')`
- `it('browseFolder returns selected path')`
- `it('browseFolder returns null for non-string selection')`
- `it('keeps error state and ends loading when get_settings rejects')`

- [ ] **Step 3: Run frontend tests**

```bash
yarn test
```

Expected: new useSettings tests pass; existing useFileList/CompressView/FileList/DropZone tests stay green.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add useSettings hook for settings IPC"
```

---

## Task 6: Build SettingsView UI

**Files:**
- Modify: `src/views/SettingsView.tsx` (replace placeholder)
- Create: `src/views/SettingsView.test.tsx`
- Create: shadcn `accordion` component

**Interfaces:**
- Produces: `SettingsView` with 3 sections per spec §4: Output Folder (path + Browse), Category Targets (4 rows: badge + formats hint + number input + KB/MB selector), Quality Floors (collapsed accordion, 6 fields), sticky footer Save/Cancel, header Reset link
- Draft state pattern: `draft` diverges from `settings`; `hasChanges` gates Save/Cancel

**Acceptance Criteria:**
- Output folder path + Browse button; Browse opens native picker → selected path appears in draft only (not saved until Save)
- 4 category target rows (Images, Videos, PDF, Documents) with number input + KB/MB selector + badge + formats hint
- Quality floors collapsed by default under accordion; 6 fields: image min quality %, video min CRF, video min resolution, PDF min DPI, PDF min JPEG quality %, documents media quality %
- Save Changes persists → restart restores (manual). Cancel reverts draft to last saved. Reset restores spec defaults and disables Save
- **Cancel bug fixed:** plan's original Cancel used undefined `setSettings` — cancel must use `setDraft(settings)` (see docs/bugs.md)
- Save/Cancel disabled until draft differs from saved settings
- Number inputs coerce invalid input (`parseInt` fallback → 0); quality floor inputs get `min`/`max` attrs (0–100 for %, 0–51 CRF)
- **shadcn add: only `accordion`** — `input`/`separator` already exist (CLI would overwrite customized base-ui variants); `select` never used in JSX (unit/resolution pickers are native `<select>`). Do NOT run `add input select separator`.
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `it('shows loading state while settings load')`
- `it('renders output folder, 4 category rows with badge + formats hint, unit selectors')`
- `it('quality floors collapsed by default')` — trigger visible, 6 fields not rendered until expanded
- `it('disables Save and Cancel until draft differs')`
- `it('save calls saveSettings with current draft')`
- `it('cancel reverts draft to last saved settings')`
- `it('reset to defaults replaces draft and disables save')`
- `it('browse updates output folder in draft only')` + `it('browse cancel leaves draft unchanged')`
- `it('empty target input coerces to 0')`
- `it('renders default KB target row for missing category key')`
- `it('updates nested quality floors')` — image.minQuality, video.minCrf, video.minResolution, pdf.minDpi, pdf.minJpegQuality, document.minMediaQuality

- [ ] **Step 1: Add required shadcn component**

```bash
yarn dlx shadcn@latest add accordion
```

> Do not add `input`, `select`, or `separator` — input + separator already exist in `src/components/ui/` (customized base-ui variants; regenerating would overwrite them), and the plan's JSX uses native `<select>` for unit/resolution pickers so a shadcn select would be dead code.

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
  const { settings, loading, error, saveSettings, resetSettings, browseFolder } = useSettings()
  const [draft, setDraft] = useState<Settings | null>(null)

  useEffect(() => {
    if (settings) setDraft(settings)
  }, [settings])

  if (loading || !draft) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {error ?? 'Loading settings…'}
      </div>
    )
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

  const handleCancel = () => {
    setDraft(settings)
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
                    <Input type="number" min={0} max={100} value={draft.qualityFloors.image.minQuality}
                      onChange={(e) => updateFloor('image.minQuality', parseInt(e.target.value) || 0)}
                      className="w-16 text-right tabular-nums" />
                    <span className="text-xs text-muted-foreground w-4">%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Videos minimum CRF</span>
                    <Input type="number" min={0} max={51} value={draft.qualityFloors.video.minCrf}
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
                    <Input type="number" min={0} value={draft.qualityFloors.pdf.minDpi}
                      onChange={(e) => updateFloor('pdf.minDpi', parseInt(e.target.value) || 0)}
                      className="w-16 text-right tabular-nums" />
                    <span className="text-xs text-muted-foreground w-6">dpi</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">PDF minimum JPEG quality</span>
                  <div className="flex items-center gap-1.5">
                    <Input type="number" min={0} max={100} value={draft.qualityFloors.pdf.minJpegQuality}
                      onChange={(e) => updateFloor('pdf.minJpegQuality', parseInt(e.target.value) || 0)}
                      className="w-16 text-right tabular-nums" />
                    <span className="text-xs text-muted-foreground w-4">%</span>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Documents media quality</span>
                  <div className="flex items-center gap-1.5">
                    <Input type="number" min={0} max={100} value={draft.qualityFloors.document.minMediaQuality}
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
        <Button variant="ghost" onClick={handleCancel} disabled={!hasChanges}>
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

- [ ] **Step 3: Create SettingsView.test.tsx**

Vitest + `render`, mocking `@tauri-apps/api/core` and `@tauri-apps/plugin-dialog` (pattern: `CompressView.test.tsx`). Cover all Required Tests listed above.

- [ ] **Step 4: Run frontend tests**

```bash
yarn test
```

Expected: SettingsView tests pass; all existing frontend tests stay green.

- [ ] **Step 5: Verify settings view works**

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

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: build SettingsView with category targets, output folder, quality floors"
```

---

## Task 7: Acceptance Check

**Interfaces:**
- Verifies: full slice against plan Acceptance Criteria 1–10, spec §4 Settings View, spec §7 schema; full GATE_COMMAND green

**Acceptance Criteria:**
- All 10 plan acceptance criteria verified (1-2 native picker + folder browse, 3-4 target rows + badges, 5-6 quality floors collapsed + 6 fields, 7 restart persistence, 8 cancel reverts, 9 reset defaults, 10 file list uses settings targets)
- Corrupt-store resilience verified manually (see Step 2)
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- Full gate: `yarn build && yarn test && cd src-tauri && cargo test` (frontend unit tests incl. useSettings + SettingsView; Rust tests incl. settings suite)
- Manual walkthrough below (native picker, store file, restart persistence — not unit-testable)

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

- [ ] **Step 2: Run full gate**

```bash
yarn build && yarn test && cd src-tauri && cargo test
```

Expected: Build clean, all frontend tests pass (useSettings + SettingsView + existing), all Rust tests pass (detection + models + commands + settings).

- [ ] **Step 3: Corrupt-store resilience check (manual)**

1. Locate store file in app data dir (e.g. `~/Library/Application Support/<app-id>/settings.json` on macOS)
2. Hand-edit to invalid JSON / wrong-typed field (e.g. `"size": "not-a-number"`)
3. Relaunch app → settings show defaults, no crash

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: slice 3 complete — settings storage + UI"
```