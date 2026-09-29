use std::path::{Path, PathBuf};

pub fn resolve_output_path(output_folder: &str, filename: &str) -> PathBuf {
    let folder = Path::new(output_folder);
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let ext = Path::new(filename)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let mut candidate = folder.join(filename);

    if !candidate.exists() {
        return candidate;
    }

    for i in 1..1000 {
        let name = if ext.is_empty() {
            format!("{}-{}", stem, i)
        } else {
            format!("{}-{}.{}", stem, i, ext)
        };
        candidate = folder.join(&name);
        if !candidate.exists() {
            return candidate;
        }
    }

    let overflow_name = if ext.is_empty() {
        format!("{}-overflow", stem)
    } else {
        format!("{}-overflow.{}", stem, ext)
    };
    folder.join(overflow_name)
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
    fn collision_handles_file_without_extension() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("README"), b"x").unwrap();
        let path = resolve_output_path(dir.path().to_str().unwrap(), "README");
        assert_eq!(path.file_name().unwrap(), "README-1");
    }
}
