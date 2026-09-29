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

pub(crate) fn sidecar_filename_for(os: &str, arch: &str, name: &str) -> Result<String, String> {
    let target_triple = target_triple(os, arch)?;
    let suffix = exe_suffix(os);
    Ok(format!("{}-{}{}", name, target_triple, suffix))
}

pub(crate) fn sidecar_filename(name: &str) -> Result<String, String> {
    sidecar_filename_for(std::env::consts::OS, std::env::consts::ARCH, name)
}

fn resolve_sidecar_path(path: &std::path::Path, name: &str) -> Result<String, String> {
    let is_file = std::fs::metadata(path).map(|m| m.is_file());
    match is_file {
        Ok(true) => {}
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(format!("Engine error: {} not available", name));
        }
        Err(e) => {
            return Err(format!(
                "Engine error: {} not available (IO: {} at {})",
                name,
                e,
                path.display()
            ));
        }
        Ok(false) => {
            return Err(format!("Engine error: {} not available", name));
        }
    }

    path.to_str()
        .ok_or_else(|| {
            format!(
                "Engine error: {} not available (non-UTF-8 path: {:?})",
                name, path
            )
        })
        .map(|s| s.to_string())
}

fn get_sidecar_path_from(resource_dir: &std::path::Path, name: &str) -> Result<String, String> {
    let filename = sidecar_filename(name)?;
    let path = resource_dir.join(&filename);

    resolve_sidecar_path(&path, name)
}

pub(crate) fn get_sidecar_path(app: &AppHandle, name: &str) -> Result<String, String> {
    let resource_path = app
        .path()
        .resolve("binaries", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve binaries dir: {}", e))?;

    get_sidecar_path_from(&resource_path, name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_triple_returns_triple_per_platform() {
        assert_eq!(
            target_triple("macos", "aarch64"),
            Ok("aarch64-apple-darwin")
        );
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
        assert_eq!(err, "Unsupported platform: solaris sparc");
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
        let expected = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            "vips-aarch64-apple-darwin"
        } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
            "vips-x86_64-apple-darwin"
        } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            "vips-x86_64-pc-windows-msvc.exe"
        } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
            "vips-x86_64-unknown-linux-gnu"
        } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
            "vips-aarch64-unknown-linux-gnu"
        } else {
            panic!(
                "unexpected host platform: {} {}",
                std::env::consts::OS,
                std::env::consts::ARCH
            )
        };

        assert_eq!(filename, expected);
    }

    #[test]
    fn sidecar_filename_for_returns_exact_name_per_platform() {
        assert_eq!(
            sidecar_filename_for("macos", "aarch64", "vips"),
            Ok("vips-aarch64-apple-darwin".to_string())
        );
        assert_eq!(
            sidecar_filename_for("macos", "x86_64", "vips"),
            Ok("vips-x86_64-apple-darwin".to_string())
        );
        assert_eq!(
            sidecar_filename_for("windows", "x86_64", "vips"),
            Ok("vips-x86_64-pc-windows-msvc.exe".to_string())
        );
        assert_eq!(
            sidecar_filename_for("linux", "x86_64", "vips"),
            Ok("vips-x86_64-unknown-linux-gnu".to_string())
        );
        assert_eq!(
            sidecar_filename_for("linux", "aarch64", "vips"),
            Ok("vips-aarch64-unknown-linux-gnu".to_string())
        );
    }

    #[test]
    fn sidecar_filename_for_errors_on_unsupported_platform() {
        assert_eq!(
            sidecar_filename_for("solaris", "sparc", "vips"),
            Err("Unsupported platform: solaris sparc".to_string())
        );
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
    fn resolve_sidecar_path_returns_not_available_error_for_directory() {
        let dir = tempfile::TempDir::new().unwrap();
        let dir_path = dir.path().join("vips-dir");
        std::fs::create_dir(&dir_path).unwrap();

        let err = resolve_sidecar_path(&dir_path, "vips").unwrap_err();
        assert_eq!(err, "Engine error: vips not available");
    }

    #[test]
    fn get_sidecar_path_from_returns_path_for_existing_sidecar() {
        let dir = tempfile::TempDir::new().unwrap();
        let full = dir.path().join(sidecar_filename("vips").unwrap());
        std::fs::write(&full, b"stub").unwrap();

        assert_eq!(
            get_sidecar_path_from(dir.path(), "vips").unwrap(),
            full.to_str().unwrap()
        );
    }

    #[test]
    fn get_sidecar_path_from_returns_spec_error_for_missing_sidecar() {
        let dir = tempfile::TempDir::new().unwrap();

        let err = get_sidecar_path_from(dir.path(), "vips").unwrap_err();
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
        assert!(err.contains(&format!(" at {}", through_file.display())));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn resolve_sidecar_path_returns_non_utf8_error_for_invalid_paths() {
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::TempDir::new().unwrap();
        let file_path = dir.path().join(std::ffi::OsStr::from_bytes(b"vips-\xff"));
        std::fs::write(&file_path, b"stub").unwrap();

        let err = resolve_sidecar_path(&file_path, "vips").unwrap_err();
        assert!(err.starts_with("Engine error: vips not available (non-UTF-8 path: "));
        assert!(err.contains(&format!("{:?}", file_path)));
        assert!(err.ends_with(')'));
    }

    #[test]
    fn tauri_conf_json_lists_vips_as_external_bin() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let conf = std::fs::read_to_string(format!("{}/tauri.conf.json", manifest))
            .expect("tauri.conf.json readable from src-tauri");
        let value: serde_json::Value = serde_json::from_str(&conf).expect("valid JSON");
        let bins = value["bundle"]["externalBin"]
            .as_array()
            .expect("bundle.externalBin array");
        assert!(
            bins.iter().any(|b| b.as_str() == Some("binaries/vips")),
            "externalBin must list binaries/vips, got: {:?}",
            bins
        );
    }

    #[test]
    #[ignore = "requires sidecar binary present on this machine"]
    fn sidecar_binary_exists_for_current_target_triple() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let filename = sidecar_filename("vips").unwrap();
        let path = format!("{}/binaries/{}", manifest, filename);
        assert!(
            std::path::Path::new(&path).exists(),
            "sidecar missing at {} — run Task 6 Step 1",
            path
        );
    }
}
