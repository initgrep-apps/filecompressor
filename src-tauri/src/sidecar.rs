use tauri::{AppHandle, Manager};

pub(crate) fn target_triple(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-gnu"),
        (os, arch) => Err(format!("Unsupported platform: {} {}", os, arch)),
    }
}

fn exe_suffix(os: &str) -> &'static str {
    if os == "windows" {
        ".exe"
    } else {
        ""
    }
}

pub(crate) fn sidecar_filename(name: &str) -> Result<String, String> {
    let target_triple = target_triple(std::env::consts::OS, std::env::consts::ARCH)?;
    let suffix = exe_suffix(std::env::consts::OS);
    Ok(format!("{}-{}{}", name, target_triple, suffix))
}

fn resolve_sidecar_path(path: &std::path::Path, name: &str) -> Result<String, String> {
    match std::fs::metadata(path) {
        Ok(_) => {}
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("Engine error: {} not available", name));
        }
        Err(e) => {
            return Err(format!(
                "Engine error: {} not available (IO: {})",
                name, e
            ));
        }
    }

    path.to_str()
        .ok_or_else(|| format!("Engine error: {} not available (non-UTF-8 path)", name))
        .map(|s| s.to_string())
}

pub(crate) fn get_sidecar_path(app: &AppHandle, name: &str) -> Result<String, String> {
    let resource_path = app
        .path()
        .resolve("binaries", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve binaries dir: {}", e))?;

    let filename = sidecar_filename(name)?;
    let path = resource_path.join(&filename);

    resolve_sidecar_path(&path, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_triple_returns_triple_per_platform() {
        assert_eq!(target_triple("macos", "aarch64"), Ok("aarch64-apple-darwin"));
        assert_eq!(target_triple("macos", "x86_64"), Ok("x86_64-apple-darwin"));
        assert_eq!(
            target_triple("windows", "x86_64"),
            Ok("x86_64-pc-windows-msvc")
        );
        assert_eq!(
            target_triple("linux", "x86_64"),
            Ok("x86_64-unknown-linux-gnu")
        );
        assert_eq!(
            target_triple("linux", "aarch64"),
            Ok("aarch64-unknown-linux-gnu")
        );
    }

    #[test]
    fn target_triple_errors_on_unsupported_platform() {
        let err = target_triple("solaris", "sparc").unwrap_err();
        assert!(err.contains("Unsupported platform"));
    }

    #[test]
    fn exe_suffix_returns_exe_for_windows_and_empty_for_other_platforms() {
        assert_eq!(exe_suffix("windows"), ".exe");
        assert_eq!(exe_suffix("macos"), "");
        assert_eq!(exe_suffix("linux"), "");
    }

    #[test]
    fn sidecar_filename_composes_name_with_host_triple_and_suffix() {
        let filename = sidecar_filename("vips").unwrap();
        let expected_triple = target_triple(std::env::consts::OS, std::env::consts::ARCH).unwrap();
        let expected = format!(
            "vips-{}{}",
            expected_triple,
            exe_suffix(std::env::consts::OS)
        );

        assert!(filename.starts_with("vips-"));
        assert!(filename.contains(expected_triple));
        assert_eq!(filename, expected);
    }

    #[test]
    fn resolve_sidecar_path_returns_path_for_existing_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let file_path = dir.path().join("vips-binary");
        std::fs::write(&file_path, b"stub").unwrap();

        assert_eq!(
            resolve_sidecar_path(&file_path, "vips").unwrap(),
            file_path.to_str().unwrap()
        );
    }

    #[test]
    fn resolve_sidecar_path_returns_not_found_error_for_missing_file() {
        let dir = tempfile::TempDir::new().unwrap();
        let file_path = dir.path().join("vips-missing");

        let err = resolve_sidecar_path(&file_path, "vips").unwrap_err();
        assert_eq!(err, "Engine error: vips not available");
    }

    #[test]
    fn resolve_sidecar_path_returns_io_error_for_other_io_failures() {
        let dir = tempfile::TempDir::new().unwrap();
        let file_path = dir.path().join("vips-regular");
        std::fs::write(&file_path, b"stub").unwrap();
        let through_file = file_path.join("child");

        let err = resolve_sidecar_path(&through_file, "vips").unwrap_err();
        assert!(err.starts_with("Engine error: vips not available (IO: "));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resolve_sidecar_path_returns_non_utf8_error_for_invalid_paths() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::TempDir::new().unwrap();
        let file_path = dir.path().join(std::ffi::OsStr::from_bytes(b"vips-\xff"));
        std::fs::write(&file_path, b"stub").unwrap();

        let err = resolve_sidecar_path(&file_path, "vips").unwrap_err();
        assert!(err.contains("non-UTF-8 path"));
    }
}
