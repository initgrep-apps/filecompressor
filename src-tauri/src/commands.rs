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
    let mut list = state.0.lock().unwrap_or_else(|e| {
        eprintln!("warn: file list mutex was poisoned, recovering: {e}");
        e.into_inner()
    });
    add_files_core(&mut list, file_paths)
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
    fn test_add_files_skips_unresolvable_case_variant() {
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
        add_files_core(&mut list, vec![case_variant]);
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_deduplicates_exact_canonical() {
        let dir = tempdir().unwrap();
        let mut list = Vec::new();
        let path = make_file(dir.path(), "test.jpg");
        let canonical = fs::canonicalize(&path).unwrap().to_str().unwrap().to_string();
        let first = add_files_core(&mut list, vec![canonical.clone()]);
        assert_eq!(first.len(), 1);
        let second = add_files_core(&mut list, vec![canonical]);
        assert!(second.is_empty(), "same canonical path twice must dedup");
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
        add_files_core(&mut list, vec![p1.clone()]);
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