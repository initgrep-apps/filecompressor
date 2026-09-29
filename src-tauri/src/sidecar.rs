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

pub(crate) fn sidecar_filename(name: &str) -> Result<String, String> {
    let target_triple = target_triple(std::env::consts::OS, std::env::consts::ARCH)?;
    let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
    Ok(format!("{}-{}{}", name, target_triple, suffix))
}

pub fn get_sidecar_path(app: &AppHandle, name: &str) -> Result<String, String> {
    let resource_path = app
        .path()
        .resolve("binaries", tauri::path::BaseDirectory::Resource)
        .map_err(|e| format!("Failed to resolve binaries dir: {}", e))?;

    let filename = sidecar_filename(name)?;
    let path = resource_path.join(&filename);

    if !path.exists() {
        return Err(format!("Engine error: {} not available", name));
    }

    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_filename_returns_triple_suffixed_name_per_platform() {
        assert_eq!(target_triple("macos", "aarch64"), Ok("aarch64-apple-darwin"));
        assert_eq!(target_triple("macos", "x86_64"), Ok("x86_64-apple-darwin"));
        assert_eq!(target_triple("windows", "x86_64"), Ok("x86_64-pc-windows-msvc"));
        assert_eq!(target_triple("linux", "x86_64"), Ok("x86_64-unknown-linux-gnu"));
        assert_eq!(target_triple("linux", "aarch64"), Ok("aarch64-unknown-linux-gnu"));
    }

    #[test]
    fn sidecar_filename_errors_on_unsupported_platform() {
        let err = target_triple("solaris", "sparc").unwrap_err();
        assert_eq!(err, "Unsupported platform: solaris sparc");
    }

    #[test]
    fn sidecar_filename_includes_exe_suffix_on_windows() {
        let current = sidecar_filename("vips").unwrap();
        assert!(current.starts_with("vips-"));
        if cfg!(target_os = "windows") {
            assert!(current.ends_with(".exe"));
        } else {
            assert!(!current.ends_with(".exe"));
        }
    }
}
