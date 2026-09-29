use std::path::{Path, PathBuf};

fn path_is_free(path: &Path) -> bool {
    match path.try_exists() {
        Ok(false) => true,
        Ok(true) => false,
        Err(e) => {
            eprintln!("output path check failed for {}: {e}", path.display());
            false
        }
    }
}

pub(crate) fn resolve_output_path(output_folder: &str, filename: &str) -> PathBuf {
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

    let mut candidate = folder.join(filename);

    if path_is_free(&candidate) {
        return candidate;
    }

    for i in 1..1000 {
        let name = if ext.is_empty() {
            format!("{}-{}", stem, i)
        } else {
            format!("{}-{}.{}", stem, i, ext)
        };
        candidate = folder.join(name);
        if path_is_free(&candidate) {
            return candidate;
        }
    }

    let overflow = if ext.is_empty() {
        folder.join(format!("{}-overflow", stem))
    } else {
        folder.join(format!("{}-overflow.{}", stem, ext))
    };
    if path_is_free(&overflow) {
        return overflow;
    }

    let unique = uuid::Uuid::new_v4().simple().to_string();
    if ext.is_empty() {
        folder.join(format!("{}-overflow-{}", stem, unique))
    } else {
        folder.join(format!("{}-overflow-{}.{}", stem, unique, ext))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_no_collision() {
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
    fn collision_handles_file_without_extension() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("README"), b"x").unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "README");
        assert_eq!(path.file_name().unwrap(), "README-1");
    }
}
