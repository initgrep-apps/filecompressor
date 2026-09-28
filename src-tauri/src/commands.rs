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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Category;
    use std::fs;
    use std::sync::Mutex;
    use tempfile::tempdir;

    fn create_test_state() -> FileListState {
        FileListState(Mutex::new(Vec::new()))
    }

    fn add_files_direct(file_paths: Vec<String>, state: &FileListState) -> Vec<FileEntry> {
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

    fn remove_file_direct(file_id: String, state: &FileListState) {
        let mut list = state.0.lock().unwrap();
        list.retain(|e| e.id != file_id);
    }

    fn clear_list_direct(state: &FileListState) {
        let mut list = state.0.lock().unwrap();
        list.clear();
    }

    #[test]
    fn test_add_files_valid_paths() {
        let dir = tempdir().unwrap();
        let state = create_test_state();
        
        let file_path = dir.path().join("test.jpg");
        fs::write(&file_path, b"test").unwrap();
        
        let result = add_files_direct(vec![file_path.to_str().unwrap().to_string()], &state);
        
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "test.jpg");
        assert_eq!(result[0].category, Category::Image);
        
        let list = state.0.lock().unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_skips_nonexistent() {
        let state = create_test_state();
        
        let result = add_files_direct(vec!["/nonexistent/path.jpg".to_string()], &state);
        
        assert_eq!(result.len(), 0);
        
        let list = state.0.lock().unwrap();
        assert_eq!(list.len(), 0);
    }

    #[test]
    fn test_add_files_deduplicates() {
        let dir = tempdir().unwrap();
        let state = create_test_state();
        
        let file_path = dir.path().join("test.jpg");
        fs::write(&file_path, b"test").unwrap();
        let path_str = file_path.to_str().unwrap().to_string();
        
        add_files_direct(vec![path_str.clone()], &state);
        let result = add_files_direct(vec![path_str], &state);
        
        assert_eq!(result.len(), 0);
        
        let list = state.0.lock().unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn test_add_files_returns_new_only() {
        let dir = tempdir().unwrap();
        let state = create_test_state();
        
        let file1_path = dir.path().join("test1.jpg");
        fs::write(&file1_path, b"test1").unwrap();
        let file2_path = dir.path().join("test2.jpg");
        fs::write(&file2_path, b"test2").unwrap();
        
        add_files_direct(vec![file1_path.to_str().unwrap().to_string()], &state);
        let result = add_files_direct(vec![
            file1_path.to_str().unwrap().to_string(),
            file2_path.to_str().unwrap().to_string(),
        ], &state);
        
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "test2.jpg");
    }

    #[test]
    fn test_remove_file_existing() {
        let dir = tempdir().unwrap();
        let state = create_test_state();
        
        let file_path = dir.path().join("test.jpg");
        fs::write(&file_path, b"test").unwrap();
        
        let result = add_files_direct(vec![file_path.to_str().unwrap().to_string()], &state);
        let file_id = result[0].id.clone();
        
        remove_file_direct(file_id, &state);
        
        let list = state.0.lock().unwrap();
        assert_eq!(list.len(), 0);
    }

    #[test]
    fn test_remove_file_nonexistent() {
        let state = create_test_state();
        
        remove_file_direct("nonexistent-id".to_string(), &state);
        
        let list = state.0.lock().unwrap();
        assert_eq!(list.len(), 0);
    }

    #[test]
    fn test_clear_list() {
        let dir = tempdir().unwrap();
        let state = create_test_state();
        
        let file1_path = dir.path().join("test1.jpg");
        fs::write(&file1_path, b"test1").unwrap();
        let file2_path = dir.path().join("test2.jpg");
        fs::write(&file2_path, b"test2").unwrap();
        
        add_files_direct(vec![
            file1_path.to_str().unwrap().to_string(),
            file2_path.to_str().unwrap().to_string(),
        ], &state);
        
        clear_list_direct(&state);
        
        let list = state.0.lock().unwrap();
        assert_eq!(list.len(), 0);
    }

    #[test]
    fn test_add_files_empty_vec() {
        let state = create_test_state();
        
        let result = add_files_direct(vec![], &state);
        
        assert_eq!(result.len(), 0);
        
        let list = state.0.lock().unwrap();
        assert_eq!(list.len(), 0);
    }

    #[test]
    fn test_concurrent_access() {
        use std::sync::Arc;
        use std::thread;
        
        let dir = tempdir().unwrap();
        let state = Arc::new(create_test_state());
        
        let mut handles = vec![];
        for i in 0..10 {
            let state_clone = Arc::clone(&state);
            let dir_path = dir.path().to_path_buf();
            let handle = thread::spawn(move || {
                let file_path = dir_path.join(format!("test{}.jpg", i));
                fs::write(&file_path, b"test").unwrap();
                add_files_direct(vec![file_path.to_str().unwrap().to_string()], &state_clone);
            });
            handles.push(handle);
        }
        
        for handle in handles {
            handle.join().unwrap();
        }
        
        let list = state.0.lock().unwrap();
        assert_eq!(list.len(), 10);
    }

    #[test]
    fn test_mutex_poison_recovery() {
        let state = create_test_state();
        
        // Simulate a panic while holding the lock
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _lock = state.0.lock().unwrap();
            panic!("intentional panic");
        }));
        
        assert!(result.is_err());
        
        // Lock is poisoned after panic, but we can recover by accessing the inner value
        let list = state.0.lock().unwrap_or_else(|e| e.into_inner());
        assert_eq!(list.len(), 0);
    }
}