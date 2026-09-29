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

use crate::models::{Category, FileEntry};
use std::sync::Mutex;
use tauri::State;
use tauri_plugin_store::StoreExt;

pub struct FileListState(pub Mutex<Vec<FileEntry>>);

pub(crate) fn add_files_core(
    list: &mut Vec<FileEntry>,
    file_paths: Vec<String>,
    target_resolver: &dyn Fn(&Category) -> u64,
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
        let category = crate::detection::detect_category(
            std::path::Path::new(&canonical_str)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
        );
        let entry = FileEntry::new(&canonical_str, target_resolver(&category));
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

const STORE_FILE: &str = "settings.json";

pub fn load_settings(app: &tauri::AppHandle) -> crate::settings::Settings {
    let value = match app.store(STORE_FILE) {
        Ok(store) => store.get("settings"),
        Err(e) => {
            eprintln!("warn: settings store unreadable, using defaults: {e}");
            None
        }
    };
    let corrupt = value
        .as_ref()
        .is_some_and(|v| serde_json::from_value::<crate::settings::Settings>(v.clone()).is_err());
    if corrupt {
        eprintln!("warn: corrupt settings store, falling back to defaults");
    }
    crate::settings::parse_settings_value(value)
}

fn save_settings_to_store(
    app: &tauri::AppHandle,
    settings: &crate::settings::Settings,
) -> Result<(), String> {
    let store = match app.store(STORE_FILE) {
        Ok(store) => store,
        Err(e) => {
            eprintln!("warn: existing settings store unavailable, creating fresh: {e}");
            app.store_builder(STORE_FILE)
                .build()
                .map_err(|e| format!("failed to build settings store: {e}"))?
        }
    };
    let value =
        serde_json::to_value(settings).map_err(|e| format!("failed to serialize settings: {e}"))?;
    store.set("settings", value);
    store
        .save()
        .map_err(|e| format!("failed to persist settings store: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> crate::settings::Settings {
    load_settings(&app)
}

#[tauri::command]
pub fn save_settings(
    app: tauri::AppHandle,
    settings: crate::settings::Settings,
) -> Result<(), String> {
    save_settings_to_store(&app, &settings)
}

#[tauri::command]
pub fn reset_settings(app: tauri::AppHandle) -> Result<crate::settings::Settings, String> {
    let defaults = crate::settings::Settings::default();
    save_settings_to_store(&app, &defaults)?;
    Ok(defaults)
}

#[tauri::command]
pub fn add_files(
    file_paths: Vec<String>,
    state: State<FileListState>,
    app: tauri::AppHandle,
) -> Vec<FileEntry> {
    let settings = load_settings(&app);
    let mut list = state.0.lock().unwrap_or_else(|e| {
        eprintln!("warn: file list mutex was poisoned, recovering: {e}");
        e.into_inner()
    });

    let resolver = |category: &Category| -> u64 {
        let key = match category {
            Category::Image => "image",
            Category::Video => "video",
            Category::Pdf => "pdf",
            Category::Document => "document",
            Category::Other => "other",
        };
        settings.target_bytes_for(key)
    };

    add_files_core(&mut list, file_paths, &resolver)
}

#[tauri::command]
pub fn remove_file(file_id: String, state: State<FileListState>) {
    let mut list = state.0.lock().unwrap_or_else(|e| {
        eprintln!("warn: file list mutex was poisoned, recovering: {e}");
        e.into_inner()
    });
    remove_file_core(&mut list, &file_id)
}

#[tauri::command]
pub fn clear_list(state: State<FileListState>) {
    let mut list = state.0.lock().unwrap_or_else(|e| {
        eprintln!("warn: file list mutex was poisoned, recovering: {e}");
        e.into_inner()
    });
    clear_list_core(&mut list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detection;
    use crate::models::Category;
    use std::fs;
    use tempfile::tempdir;

    fn make_file(dir: &std::path::Path, name: &str) -> String {
        let p = dir.join(name);
        fs::write(&p, b"x").unwrap();
        p.to_str().unwrap().to_string()
    }

    fn default_resolver() -> impl Fn(&Category) -> u64 {
        |c| detection::default_target_bytes(*c)
    }

    #[test]
    fn test_add_files_valid_paths() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        let result = add_files_core(&mut list, vec![path], &default_resolver());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "test.jpg");
        assert_eq!(result[0].category, Category::Image);
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_skips_nonexistent() {
        let mut list = Vec::new();
        let result = add_files_core(
            &mut list,
            vec!["/nonexistent/path.jpg".to_string()],
            &default_resolver(),
        );
        assert!(result.is_empty());
        assert!(list.is_empty());
    }

    #[test]
    fn test_add_files_rejects_directory() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let subdir = dir.path().join("subdir");
        fs::create_dir(&subdir).unwrap();
        let result = add_files_core(
            &mut list,
            vec![subdir.to_str().unwrap().to_string()],
            &default_resolver(),
        );
        assert!(result.is_empty());
        assert!(list.is_empty());
    }

    #[test]
    fn test_add_files_skips_unresolvable_case_variant() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        let canonical = fs::canonicalize(&path)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let case_variant = if canonical.chars().any(|c| c.is_uppercase()) {
            canonical.to_lowercase()
        } else {
            canonical.to_uppercase()
        };
        add_files_core(&mut list, vec![canonical.clone()], &default_resolver());
        add_files_core(&mut list, vec![case_variant], &default_resolver());
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_deduplicates_exact_canonical() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        let canonical = fs::canonicalize(&path)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let first = add_files_core(&mut list, vec![canonical.clone()], &default_resolver());
        assert_eq!(first.len(), 1);
        let second = add_files_core(&mut list, vec![canonical], &default_resolver());
        assert!(second.is_empty(), "same canonical path twice must dedup");
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_deduplicates_redundant_separators() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        add_files_core(&mut list, vec![path.clone()], &default_resolver());
        let doubled = path.replace("/test.jpg", "//test.jpg");
        let result = add_files_core(&mut list, vec![doubled], &default_resolver());
        assert!(result.is_empty(), "canonicalize normalizes // before dedup");
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_stores_canonical_path() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        add_files_core(&mut list, vec![path], &default_resolver());
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
        add_files_core(&mut list, vec![p1.clone()], &default_resolver());
        let result = add_files_core(&mut list, vec![p1, p2], &default_resolver());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "b.jpg");
    }

    #[test]
    fn test_add_files_empty_vec() {
        let mut list = Vec::new();
        let result = add_files_core(&mut list, vec![], &default_resolver());
        assert!(result.is_empty());
        assert!(list.is_empty());
    }

    #[test]
    fn test_remove_file_existing() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        let entries = add_files_core(&mut list, vec![path], &default_resolver());
        remove_file_core(&mut list, &entries[0].id);
        assert!(list.is_empty());
    }

    #[test]
    fn test_clear_list() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let p1 = make_file(dir.path(), "a.jpg");
        let p2 = make_file(dir.path(), "b.jpg");
        add_files_core(&mut list, vec![p1, p2], &default_resolver());
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

    #[test]
    fn test_add_files_core_uses_settings_targets() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let image_path = make_file(dir.path(), "photo.jpg");
        let other_path = make_file(dir.path(), "data.xyz");
        let custom = |category: &Category| -> u64 {
            match category {
                Category::Image => 500 * 1024,
                _ => 0,
            }
        };
        let result = add_files_core(&mut list, vec![image_path, other_path], &custom);
        assert_eq!(result.len(), 2);
        let image_entry = result
            .iter()
            .find(|e| e.category == Category::Image)
            .unwrap();
        assert_eq!(image_entry.target_bytes, 500 * 1024);
        let other_entry = result
            .iter()
            .find(|e| e.category == Category::Other)
            .unwrap();
        assert_eq!(other_entry.target_bytes, 0);
    }

    #[test]
    fn test_load_settings_corrupt_value_falls_back_to_defaults() {
        let corrupt = serde_json::json!({
            "outputFolder": "/tmp/out",
            "categoryTargets": { "image": { "size": "not-a-number", "unit": "KB" } }
        });
        let parsed: crate::settings::Settings =
            crate::settings::parse_settings_value(Some(corrupt));
        assert_eq!(parsed, crate::settings::Settings::default());
        assert_eq!(
            crate::settings::parse_settings_value(None),
            crate::settings::Settings::default()
        );
    }
}
