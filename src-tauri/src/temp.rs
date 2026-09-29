use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tauri::{AppHandle, Manager};

const STALE_AFTER_SECS: u64 = 86_400;

pub(crate) fn create_temp_dir(app: &AppHandle) -> Result<PathBuf, String> {
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

pub(crate) fn cleanup_temp_dir(path: &Path) {
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Removes entries under `app_temp` whose mtime is older than 24 hours.
/// Directories are removed recursively; regular files with `remove_file`.
/// `now` is injectable so the 24h boundary is testable without a Tauri harness.
pub(crate) fn cleanup_stale_temp_files_in(app_temp: &Path, now: SystemTime) {
    if !app_temp.exists() {
        return;
    }

    let entries = match std::fs::read_dir(app_temp) {
        Ok(entries) => entries,
        Err(e) => {
            eprintln!(
                "temp cleanup skipped, cannot read {}: {e}",
                app_temp.display()
            );
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();

        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(e) => {
                eprintln!("temp cleanup: cannot stat {}: {e}", path.display());
                continue;
            }
        };

        let modified = match metadata.modified() {
            Ok(modified) => modified,
            Err(e) => {
                eprintln!("temp cleanup: no mtime for {}: {e}", path.display());
                continue;
            }
        };

        let age = match now.duration_since(modified) {
            Ok(age) => age,
            Err(_) => {
                eprintln!(
                    "temp cleanup: mtime in the future for {}, keeping it",
                    path.display()
                );
                continue;
            }
        };

        if age.as_secs() > STALE_AFTER_SECS {
            let result = if metadata.is_dir() {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_file(&path)
            };
            if let Err(e) = result {
                eprintln!("temp cleanup: failed to remove {}: {e}", path.display());
            }
        }
    }
}

pub(crate) fn cleanup_stale_temp_files(app: &AppHandle) {
    let temp_base = match app.path().temp_dir() {
        Ok(temp_base) => temp_base,
        Err(e) => {
            eprintln!("temp cleanup skipped: {e}");
            return;
        }
    };
    cleanup_stale_temp_files_in(&temp_base.join("file-compressor"), SystemTime::now());
}

#[cfg(test)]
mod tests {
    use super::*;
    use filetime::{set_file_mtime, FileTime};
    use std::fs;

    fn set_age_secs(path: &Path, now: SystemTime, age_secs: i64) {
        let now_secs = now
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        set_file_mtime(path, FileTime::from_unix_time(now_secs - age_secs, 0)).unwrap();
    }

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
        let parent = tempfile::tempdir().unwrap();
        let missing = parent.path().join("missing-session");
        cleanup_temp_dir(&missing);
        cleanup_temp_dir(&missing);

        assert!(parent.path().exists(), "parent tempdir must survive");
        let remaining: Vec<_> = fs::read_dir(parent.path()).unwrap().flatten().collect();
        assert!(
            remaining.is_empty(),
            "no entries should appear: {remaining:?}"
        );
    }

    #[test]
    fn cleanup_stale_temp_files_removes_only_dirs_older_than_24h() {
        let base = tempfile::tempdir().unwrap();
        let old = base.path().join("old-session");
        let fresh = base.path().join("fresh-session");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&fresh).unwrap();

        let now = SystemTime::now();
        set_age_secs(&old, now, 86_401);
        set_age_secs(&fresh, now, 3_600);

        cleanup_stale_temp_files_in(base.path(), now);
        assert!(!old.exists(), "dir older than 24h must be removed");
        assert!(fresh.exists(), "dir newer than 24h must be kept");
    }

    #[test]
    fn cleanup_stale_temp_files_keeps_dir_at_exact_24h_boundary() {
        let base = tempfile::tempdir().unwrap();
        let boundary = base.path().join("boundary-session");
        fs::create_dir_all(&boundary).unwrap();

        let now = SystemTime::now();
        set_age_secs(&boundary, now, 86_400);

        cleanup_stale_temp_files_in(base.path(), now);
        assert!(
            boundary.exists(),
            "age == 86400s is not > 86400, dir must be kept"
        );
    }

    #[test]
    fn cleanup_stale_temp_files_removes_stale_regular_files_not_fresh_ones() {
        let base = tempfile::tempdir().unwrap();
        let stale_file = base.path().join("attempt-0.jpg");
        let fresh_file = base.path().join("attempt-1.jpg");
        fs::write(&stale_file, b"x").unwrap();
        fs::write(&fresh_file, b"x").unwrap();

        let now = SystemTime::now();
        set_age_secs(&stale_file, now, 90_000);
        set_age_secs(&fresh_file, now, 3_600);

        cleanup_stale_temp_files_in(base.path(), now);
        assert!(!stale_file.exists(), "stale regular file must be removed");
        assert!(fresh_file.exists(), "fresh file must be kept");
    }

    #[test]
    fn cleanup_stale_temp_files_safe_when_app_temp_missing() {
        let missing = tempfile::tempdir().unwrap();
        let app_temp = missing.path().join("file-compressor");
        cleanup_stale_temp_files_in(&app_temp, SystemTime::now());
        assert!(!app_temp.exists());
    }
}
