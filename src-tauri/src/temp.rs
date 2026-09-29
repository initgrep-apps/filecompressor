use std::path::PathBuf;
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

pub fn create_temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let temp_base = app
        .path()
        .temp_dir()
        .map_err(|e| format!("Failed to get temp dir: {}", e))?;

    let app_temp = temp_base.join("file-compressor");
    std::fs::create_dir_all(&app_temp).map_err(|e| format!("Failed to create temp dir: {}", e))?;

    let session_temp = app_temp.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&session_temp)
        .map_err(|e| format!("Failed to create session temp dir: {}", e))?;

    Ok(session_temp)
}

pub fn cleanup_temp_dir(path: &PathBuf) {
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Removes session dirs under `app_temp` whose mtime is older than 24h.
pub fn cleanup_stale_temp_files_in(app_temp: &std::path::Path, now: SystemTime) {
    if !app_temp.exists() {
        return;
    }

    if let Ok(entries) = std::fs::read_dir(app_temp) {
        for entry in entries.flatten() {
            if let Ok(metadata) = entry.metadata() {
                if let Ok(modified) = metadata.modified() {
                    if now
                        .duration_since(modified)
                        .map(|d| d.as_secs() > 86400)
                        .unwrap_or(false)
                    {
                        let _ = std::fs::remove_dir_all(entry.path());
                    }
                }
            }
        }
    }
}

pub fn cleanup_stale_temp_files(app: &AppHandle) {
    let Ok(temp_base) = app.path().temp_dir() else {
        return;
    };
    cleanup_stale_temp_files_in(&temp_base.join("file-compressor"), SystemTime::now());
}

#[cfg(test)]
mod tests {
    use super::*;
    use filetime::{set_file_mtime, FileTime};
    use std::fs;

    #[test]
    fn cleanup_temp_dir_removes_directory_tree() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("session").join("nested");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("attempt-1.jpg"), b"x").unwrap();

        cleanup_temp_dir(&dir.path().join("session"));
        assert!(!dir.path().join("session").exists());
    }

    #[test]
    fn cleanup_temp_dir_no_op_on_missing_path() {
        let missing = PathBuf::from("/definitely/not/a/real/dir/file-compressor-test");
        cleanup_temp_dir(&missing);
        cleanup_temp_dir(&missing);
    }

    #[test]
    fn cleanup_stale_temp_files_removes_only_dirs_older_than_24h() {
        let base = tempfile::tempdir().unwrap();
        let old = base.path().join("old-session");
        let fresh = base.path().join("fresh-session");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&fresh).unwrap();

        let now = SystemTime::now();
        let now_secs = now.duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs() as i64;
        set_file_mtime(&old, FileTime::from_unix_time(now_secs - 86401, 0)).unwrap();
        set_file_mtime(&fresh, FileTime::from_unix_time(now_secs - 3600, 0)).unwrap();

        cleanup_stale_temp_files_in(base.path(), now);
        assert!(!old.exists(), "dir older than 24h must be removed");
        assert!(fresh.exists(), "dir newer than 24h must be kept");
    }

    #[test]
    fn cleanup_stale_temp_files_safe_when_app_temp_missing() {
        let missing = tempfile::tempdir().unwrap();
        let app_temp = missing.path().join("file-compressor");
        cleanup_stale_temp_files_in(&app_temp, SystemTime::now());
        assert!(!app_temp.exists());
    }
}
