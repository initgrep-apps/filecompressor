use std::path::{Path, PathBuf};
use std::sync::Mutex;

fn path_is_free(path: &Path) -> Result<bool, String> {
    path.try_exists()
        .map(|exists| !exists)
        .map_err(|e| format!("cannot check {}: {e}", path.display()))
}

#[derive(Default)]
pub(crate) struct ReservedNames(Mutex<std::collections::HashSet<String>>);

impl ReservedNames {
    pub(crate) fn new() -> Self {
        ReservedNames(Mutex::new(std::collections::HashSet::new()))
    }

    fn claim(&self, name: String) -> bool {
        let mut set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        set.insert(name)
    }
}

pub(crate) fn resolve_output_path_reserved(
    output_folder: &str,
    filename: &str,
    reserved: &ReservedNames,
) -> PathBuf {
    let folder = Path::new(output_folder);
    let stem = match Path::new(filename).file_stem() {
        Some(raw) => raw.to_str().unwrap_or_else(|| {
            eprintln!(
                "output filename stem not valid UTF-8, using fallback: {}",
                filename
            );
            "output"
        }),
        None => {
            eprintln!(
                "output filename has no usable stem, using fallback: {}",
                filename
            );
            "output"
        }
    };
    let ext = match Path::new(filename).extension() {
        None => "",
        Some(raw) => raw.to_str().unwrap_or_else(|| {
            eprintln!(
                "output filename extension not valid UTF-8, dropped: {}",
                filename
            );
            ""
        }),
    };

    let mut fs_broken = false;
    let mut claimed: Option<String> = None;

    let candidates = std::iter::once(filename.to_string()).chain((1..1000).map(|i| {
        if ext.is_empty() {
            format!("{}-{}", stem, i)
        } else {
            format!("{}-{}.{}", stem, i, ext)
        }
    }));

    for candidate in candidates {
        if !reserved.claim(candidate.clone()) {
            continue;
        }
        match path_is_free(&folder.join(&candidate)) {
            Ok(true) => {
                claimed = Some(candidate);
                break;
            }
            Ok(false) => {}
            Err(e) => {
                eprintln!("output path check failed, skipping collision loop: {e}");
                fs_broken = true;
                break;
            }
        }
    }

    if claimed.is_none() && !fs_broken {
        let overflow = if ext.is_empty() {
            format!("{}-overflow", stem)
        } else {
            format!("{}-overflow.{}", stem, ext)
        };
        if reserved.claim(overflow.clone()) {
            match path_is_free(&folder.join(&overflow)) {
                Ok(true) => claimed = Some(overflow),
                Ok(false) => {}
                Err(e) => {
                    eprintln!("output path check failed for overflow path: {e}");
                    fs_broken = true;
                }
            }
        }
    }

    if let Some(name) = claimed {
        return folder.join(name);
    }

    let unique = uuid::Uuid::new_v4().simple().to_string();
    if ext.is_empty() {
        folder.join(format!("{}-overflow-{}", stem, unique))
    } else {
        folder.join(format!("{}-overflow-{}.{}", stem, unique, ext))
    }
}

pub(crate) fn resolve_output_path(output_folder: &str, filename: &str) -> PathBuf {
    resolve_output_path_reserved(output_folder, filename, &ReservedNames::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn fresh_dir_returns_unchanged_filename() {
        let dir = tempdir().unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "photo.jpg");
        assert_eq!(path.file_name().unwrap(), "photo.jpg");
    }

    #[test]
    fn collision_appends_dash_one_suffix() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "photo.jpg");
        assert_eq!(path.file_name().unwrap(), "photo-1.jpg");
    }

    #[test]
    fn collision_increments_suffix_to_dash_two_when_dash_one_taken() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("photo-1.jpg"), b"x").unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "photo.jpg");
        assert_eq!(path.file_name().unwrap(), "photo-2.jpg");
    }

    #[test]
    fn collision_caps_at_999_then_uses_overflow_fallback() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        for i in 1..1000 {
            std::fs::write(dir.path().join(format!("photo-{}.jpg", i)), b"x").unwrap();
        }
        let path = resolve_output_path(dir.path().to_str().unwrap(), "photo.jpg");
        assert_eq!(path.file_name().unwrap(), "photo-overflow.jpg");
    }

    #[test]
    fn collision_overflow_taken_returns_unique_nonexistent_path() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        for i in 1..1000 {
            std::fs::write(dir.path().join(format!("photo-{}.jpg", i)), b"x").unwrap();
        }
        std::fs::write(dir.path().join("photo-overflow.jpg"), b"x").unwrap();

        let path = resolve_output_path(dir.path().to_str().unwrap(), "photo.jpg");
        assert!(
            !path.exists(),
            "returned path must not clobber an existing file, got: {}",
            path.display()
        );
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("photo-overflow-"), "got: {}", name);
        assert!(name.ends_with(".jpg"), "got: {}", name);
    }

    #[test]
    fn collision_overflow_taken_without_extension_returns_unique_nonexistent_path() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("README"), b"x").unwrap();
        for i in 1..1000 {
            std::fs::write(dir.path().join(format!("README-{}", i)), b"x").unwrap();
        }
        std::fs::write(dir.path().join("README-overflow"), b"x").unwrap();

        let path = resolve_output_path(dir.path().to_str().unwrap(), "README");
        assert!(
            !path.exists(),
            "returned path must not clobber an existing file, got: {}",
            path.display()
        );
        let name = path.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("README-overflow-"), "got: {}", name);
    }

    #[test]
    fn reserved_registry_two_claims_same_name_get_suffix() {
        let dir = tempdir().unwrap();
        let reserved = ReservedNames::new();
        let first = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &reserved);
        assert_eq!(first.file_name().unwrap(), "photo.jpg");
        let second = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &reserved);
        assert_eq!(second.file_name().unwrap(), "photo-1.jpg");
        let third = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &reserved);
        assert_eq!(third.file_name().unwrap(), "photo-2.jpg");
    }

    #[test]
    fn reserved_registry_cross_batch_isolated() {
        let dir = tempdir().unwrap();
        let batch_a = ReservedNames::new();
        let batch_b = ReservedNames::new();
        resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &batch_a);
        let b = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &batch_b);
        assert_eq!(b.file_name().unwrap(), "photo.jpg");
    }

    #[test]
    fn reserved_registry_disk_collision_still_suffixes() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        let reserved = ReservedNames::new();
        let path = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &reserved);
        assert_eq!(path.file_name().unwrap(), "photo-1.jpg");
    }

    #[test]
    fn collision_handles_file_without_extension() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("README"), b"x").unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "README");
        assert_eq!(path.file_name().unwrap(), "README-1");
    }
}
