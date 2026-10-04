use std::path::{Component, Path, PathBuf};

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

fn sidecar_candidates(exe_dir: &std::path::Path, name: &str) -> Vec<std::path::PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(filename) = sidecar_filename(name) {
        candidates.push(exe_dir.join(&filename));
    }
    candidates.push(exe_dir.join(name));
    candidates
}

pub(crate) fn resolve_sidecar_candidate(
    exe_dir: &std::path::Path,
    name: &str,
) -> Result<String, String> {
    let mut first_error: Option<String> = None;

    for path in sidecar_candidates(exe_dir, name) {
        match resolve_sidecar_path(&path, name) {
            Ok(resolved) => return Ok(resolved),
            Err(e) => {
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
    }

    Err(first_error.unwrap_or_else(|| {
        format!("Engine error: {} not available", name)
    }))
}

pub(crate) fn current_exe_dir() -> Result<std::path::PathBuf, String> {
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("Engine error: failed to resolve executable path: {}", e))?;
    exe_path
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Engine error: executable has no parent directory".to_string())
}

/// Ghostscript resource tree resolved next to the running binary. The staged
/// `gs-resources/` dir is what makes PDF compression work on a machine with no
/// Homebrew Ghostscript: without it `gs` resolves its resources from a
/// compiled-in brew prefix and fails on real PDFs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GsResources {
    /// `-I` search paths, in the order Ghostscript must be given them.
    pub search_paths: Vec<String>,
    /// ICC profile dir, passed as `-uICCProfilesDir`; `None` when the tree
    /// carries no `iccprofiles/`.
    pub icc_profiles_dir: Option<String>,
}

const GS_RESOURCE_SEARCH_DIRS: [&str; 4] = ["Resource/Init", "lib", "Resource/Font", "fonts"];
const GS_ICC_PROFILES_DIR: &str = "iccprofiles";
const GS_INIT_MARKER: &str = "Resource/Init/gs_init.ps";
const GS_SENTINEL_PREFIX: &str = "fso-sidecar-acceptance-";
const GS_FONT_DIRS: [&str; 2] = ["Resource/Font", "fonts"];

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn gs_resources_candidates(exe_dir: &Path) -> Vec<PathBuf> {
    vec![
        exe_dir.join("../Resources/gs-resources"),
        exe_dir.join("../../gs-resources"),
        exe_dir.join("resources/gs-resources"),
        exe_dir.join("gs-resources"),
    ]
}

fn is_gs_sentinel(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with(GS_SENTINEL_PREFIX)
}

fn dir_has_file(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        if path.is_file() {
            !is_gs_sentinel(&entry.file_name())
        } else if path.is_dir() {
            dir_has_file(&path)
        } else {
            false
        }
    })
}

/// Returns the resolved tree, or `None` when the candidate exists but cannot
/// actually serve one. Requiring the Init marker plus real font files in BOTH
/// `Resource/Font` and `fonts` (sentinels excluded — they are staged by the
/// audit's own smoke and must not make a hollow tree look populated) means a
/// present-but-empty `gs-resources/` never yields a `Some`, so the caller can
/// surface a `SidecarFailed` hint instead of letting gs silently fall back to
/// its compiled-in Homebrew prefix.
fn build_gs_resources(base: &Path) -> Option<GsResources> {
    let base = normalize_path(base);
    if !base.join(GS_INIT_MARKER).is_file() {
        eprintln!(
            "warn: ignoring gs resources at {} — {} is missing, so gs would fall back to its compiled-in Homebrew prefix",
            base.display(),
            GS_INIT_MARKER
        );
        return None;
    }
    for relative in GS_FONT_DIRS {
        let dir = base.join(relative);
        if !dir.is_dir() || !dir_has_file(&dir) {
            eprintln!(
                "warn: ignoring gs resources at {} — no real font files under {relative}, so gs could not render text from this tree",
                base.display()
            );
            return None;
        }
    }
    let search_paths = GS_RESOURCE_SEARCH_DIRS
        .iter()
        .map(|relative| base.join(relative))
        .filter(|candidate| candidate.is_dir())
        .map(|candidate| candidate.to_string_lossy().into_owned())
        .collect();
    let icc = base.join(GS_ICC_PROFILES_DIR);
    let icc_profiles_dir = icc
        .is_dir()
        .then(|| icc.to_string_lossy().into_owned());
    Some(GsResources {
        search_paths,
        icc_profiles_dir,
    })
}

/// Resolves the staged Ghostscript resource tree, first existing candidate wins.
/// Returns `None` when no tree is staged — callers fall back to the engine's
/// own defaults instead of failing.
pub(crate) fn resolve_gs_resources(exe_dir: &Path) -> Option<GsResources> {
    gs_resources_candidates(exe_dir)
        .into_iter()
        .filter(|candidate| candidate.is_dir())
        .find_map(|candidate| build_gs_resources(&candidate))
}

pub(crate) fn resolve_all_sidecar_paths() -> Result<crate::engine::SidecarPaths, String> {
    let exe_dir = current_exe_dir()?;
    Ok(crate::engine::SidecarPaths::resolve_for(&exe_dir))
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXTERNAL_BIN: &str = "binaries/vips";

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
    fn sidecar_candidates_prefer_triple_then_plain_name() {
        let dir = std::path::PathBuf::from("/opt/engine");
        let candidates = sidecar_candidates(&dir, "vips");

        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates[0],
            std::path::PathBuf::from("/opt/engine/vips-aarch64-apple-darwin")
        );
        assert_eq!(
            candidates[1],
            std::path::PathBuf::from("/opt/engine/vips")
        );
    }

    #[test]
    fn get_sidecar_path_from_returns_path_for_existing_sidecar() {
        let dir = tempfile::TempDir::new().unwrap();
        let full = dir.path().join(sidecar_filename("vips").unwrap());
        std::fs::write(&full, b"stub").unwrap();

        assert_eq!(
            resolve_sidecar_candidate(dir.path(), "vips").unwrap(),
            full.to_str().unwrap()
        );
    }

    #[test]
    fn get_sidecar_path_from_returns_spec_error_for_missing_sidecar() {
        let dir = tempfile::TempDir::new().unwrap();

        let err = resolve_sidecar_candidate(dir.path(), "vips").unwrap_err();
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
    fn tauri_conf_json_lists_all_sidecar_engines_as_external_bin() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let conf = std::fs::read_to_string(format!("{}/tauri.conf.json", manifest))
            .expect("tauri.conf.json readable from src-tauri");
        let value: serde_json::Value = serde_json::from_str(&conf).expect("valid JSON");
        let bins = value["bundle"]["externalBin"]
            .as_array()
            .expect("bundle.externalBin array");
        for required in ["binaries/vips", "binaries/qpdf", "binaries/gs", "binaries/ffmpeg", "binaries/ffprobe"] {
            assert!(
                bins.iter().any(|b| b.as_str() == Some(required)),
                "externalBin must list {required}, got: {:?}",
                bins
            );
        }
    }

    #[test]
    fn sidecar_paths_reaches_both_qpdf_and_gs() {
        let dir = tempfile::TempDir::new().unwrap();
        let qpdf_path = dir.path().join(sidecar_filename("qpdf").unwrap());
        let gs_path = dir.path().join(sidecar_filename("gs").unwrap());
        std::fs::write(&qpdf_path, b"stub").unwrap();
        std::fs::write(&gs_path, b"stub").unwrap();

        let paths = crate::engine::SidecarPaths::resolve_for(dir.path());
        assert_eq!(
            paths.qpdf.as_deref(),
            qpdf_path.to_str(),
            "qpdf must resolve to the exe-dir triple-suffixed binary"
        );
        assert_eq!(
            paths.gs.as_deref(),
            gs_path.to_str(),
            "gs must resolve to the exe-dir triple-suffixed binary"
        );
        assert!(
            paths.vips.is_none() && paths.ffmpeg.is_none() && paths.ffprobe.is_none(),
            "missing engines must resolve to None (collected), not abort resolution"
        );
    }

    #[cfg(unix)]
    fn write_gs_resources(base: &std::path::Path, dirs: &[&str]) {
        for dir in dirs {
            let path = base.join(dir);
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("gs_init.ps"), b"%!PS\n").unwrap();
        }
    }

    #[cfg(unix)]
    fn empty_dir(base: &std::path::Path, dirs: &[&str]) {
        for dir in dirs {
            let path = base.join(dir);
            std::fs::create_dir_all(&path).unwrap();
            for entry in std::fs::read_dir(&path).unwrap() {
                std::fs::remove_file(entry.unwrap().path()).unwrap();
            }
        }
    }

    #[cfg(unix)]
    fn gs_resource_root(root: &std::path::Path, relative: &str) -> std::path::PathBuf {
        let base = root.join(relative);
        std::fs::create_dir_all(base.join("Resource/Init")).unwrap();
        std::fs::write(base.join("Resource/Init/gs_init.ps"), b"%!PS\n").unwrap();
        base
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_prefers_bundle_layout() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let resources = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(
            &resources,
            &["lib", "Resource/Font", "fonts", "iccprofiles"],
        );

        let resolved = resolve_gs_resources(&exe_dir).expect("bundle layout resolves");
        assert_eq!(
            resolved.search_paths,
            vec![
                resources.join("Resource/Init").to_str().unwrap().to_string(),
                resources.join("lib").to_str().unwrap().to_string(),
                resources.join("Resource/Font").to_str().unwrap().to_string(),
                resources.join("fonts").to_str().unwrap().to_string(),
            ],
            "search paths are ordered Init, lib, Resource/Font, fonts"
        );
        assert_eq!(
            resolved.icc_profiles_dir.as_deref(),
            Some(resources.join("iccprofiles").to_str().unwrap()),
            "icc_profiles_dir is Some iff iccprofiles/ exists"
        );
        assert!(
            resolved.search_paths.iter().all(|p| !p.contains("/../")),
            "search paths must be normalized, got: {:?}",
            resolved.search_paths
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_omits_absent_dirs_and_icc_profiles() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let resources = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&resources, &["Resource/Font", "fonts"]);

        let resolved = resolve_gs_resources(&exe_dir).expect("bundle layout resolves");
        assert_eq!(
            resolved.search_paths,
            vec![
                resources.join("Resource/Init").to_str().unwrap().to_string(),
                resources.join("Resource/Font").to_str().unwrap().to_string(),
                resources.join("fonts").to_str().unwrap().to_string(),
            ],
            "only dirs that exist are passed as -I flags, in the fixed order"
        );
        assert!(
            resolved.icc_profiles_dir.is_none(),
            "no iccprofiles dir means no -sICCProfilesDir"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_returns_none_when_absent() {
        let dir = tempfile::TempDir::new().unwrap();
        assert!(
            resolve_gs_resources(dir.path()).is_none(),
            "a machine without staged gs resources must resolve to None, never abort"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_dev_layout_candidate_resolves_alone() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("target/debug");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let dev_layout = gs_resource_root(dir.path(), "target/debug/gs-resources");
        write_gs_resources(&dev_layout, &["lib", "Resource/Font", "fonts"]);

        let resolved = resolve_gs_resources(&exe_dir).expect("dev layout resolves");
        assert_eq!(
            resolved.search_paths.first().map(String::as_str),
            Some(dev_layout.join("Resource/Init").to_str().unwrap()),
            "the dev layout candidate resolves on its own"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_dev_target_layout_candidate_resolves() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("target/debug");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let layout = gs_resource_root(dir.path(), "gs-resources");
        write_gs_resources(&layout, &["lib", "Resource/Font", "fonts"]);

        let resolved = resolve_gs_resources(&exe_dir)
            .expect("exe_dir/../../gs-resources (the tauri dev layout) resolves");
        assert_eq!(
            resolved.search_paths.first().map(String::as_str),
            Some(layout.join("Resource/Init").to_str().unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_resources_subdir_candidate_resolves() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let layout = gs_resource_root(dir.path(), "Contents/MacOS/resources/gs-resources");
        write_gs_resources(&layout, &["lib", "Resource/Font", "fonts"]);

        let resolved = resolve_gs_resources(&exe_dir)
            .expect("exe_dir/resources/gs-resources resolves");
        assert_eq!(
            resolved.search_paths.first().map(String::as_str),
            Some(layout.join("Resource/Init").to_str().unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_returns_none_for_tree_without_font_files() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let resources = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&resources, &["lib", "Resource/Font", "fonts"]);
        empty_dir(&resources, &["fonts", "Resource/Font"]);

        assert!(
            resolve_gs_resources(&exe_dir).is_none(),
            "a tree with no font files must not resolve: gs would silently use its compiled-in prefix"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_returns_none_when_a_font_dir_holds_only_sentinels() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let resources = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&resources, &["lib", "Resource/Font", "fonts"]);
        empty_dir(&resources, &["Resource/Font", "fonts"]);
        for name in [GS_SENTINEL_PREFIX, &format!("{GS_SENTINEL_PREFIX}fonts-sentinel.ps")] {
            std::fs::write(resources.join("Resource/Font").join(name), b"%!\n").unwrap();
            std::fs::write(resources.join("fonts").join(name), b"%!\n").unwrap();
        }

        assert!(
            resolve_gs_resources(&exe_dir).is_none(),
            "a sentinel-only font dir must not resolve: the sentinels are staged by the audit's own smoke and would otherwise make a hollow tree look populated, defeating the SidecarFailed hint"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_returns_none_when_only_one_font_dir_is_populated() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let resources = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&resources, &["lib", "Resource/Font"]);
        empty_dir(&resources, &["fonts"]);
        std::fs::create_dir_all(resources.join("fonts")).unwrap();

        assert!(
            resolve_gs_resources(&exe_dir).is_none(),
            "both font dirs are required, not just one of them"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_accepts_font_files_nested_in_subdirectories() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let resources = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&resources, &["lib"]);
        empty_dir(&resources, &["Resource/Font", "fonts"]);
        for dir_name in ["Resource/Font", "fonts"] {
            let nested = resources.join(dir_name).join("type1");
            std::fs::create_dir_all(&nested).unwrap();
            std::fs::write(nested.join("NimbusRoman-Regular"), b"font").unwrap();
        }

        let resolved = resolve_gs_resources(&exe_dir)
            .expect("fonts staged only in subdirectories still resolve, like the JS gates");
        assert_eq!(
            resolved.search_paths,
            vec![
                resources.join("Resource/Init").to_str().unwrap().to_string(),
                resources.join("lib").to_str().unwrap().to_string(),
                resources.join("Resource/Font").to_str().unwrap().to_string(),
                resources.join("fonts").to_str().unwrap().to_string(),
            ],
            "the recursive check must not drop a font dir whose files live one level down"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_returns_none_when_init_marker_missing() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let resources = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&resources, &["lib", "Resource/Font", "fonts"]);
        std::fs::remove_file(resources.join(GS_INIT_MARKER)).unwrap();

        assert!(
            resolve_gs_resources(&exe_dir).is_none(),
            "without gs_init.ps the tree cannot start gs"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_skips_unusable_candidate_for_a_usable_later_one() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let hollow = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&hollow, &["Resource/Font", "fonts"]);
        empty_dir(&hollow, &["Resource/Font", "fonts"]);
        let usable = gs_resource_root(dir.path(), "Contents/MacOS/resources/gs-resources");
        write_gs_resources(&usable, &["lib", "Resource/Font", "fonts"]);

        let resolved = resolve_gs_resources(&exe_dir).expect("a later usable candidate wins");
        assert_eq!(
            resolved.search_paths.first().map(String::as_str),
            Some(usable.join("Resource/Init").to_str().unwrap()),
            "an unusable earlier candidate must not mask a usable later one"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_gs_resources_takes_the_first_existing_candidate() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let bundle = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&bundle, &["lib", "Resource/Font", "fonts"]);
        let dev = gs_resource_root(dir.path(), "target/debug/gs-resources");
        write_gs_resources(&dev, &["lib", "Resource/Font", "fonts"]);

        let resolved = resolve_gs_resources(&exe_dir).expect("bundle layout resolves");
        assert_eq!(
            resolved.search_paths.first().map(String::as_str),
            Some(bundle.join("Resource/Init").to_str().unwrap()),
            "the bundle candidate wins over every later one"
        );
        assert!(
            !resolved.search_paths.iter().any(|p| p.starts_with(&dev.to_string_lossy().to_string())),
            "later candidates must not leak into the resolved search paths"
        );
    }

    #[cfg(unix)]
    #[test]
    fn resolve_for_attaches_gs_resources() {
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        std::fs::write(exe_dir.join(sidecar_filename("gs").unwrap()), b"stub").unwrap();
        std::fs::write(exe_dir.join(sidecar_filename("qpdf").unwrap()), b"stub").unwrap();
        let resources = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&resources, &["lib", "Resource/Font", "fonts"]);

        let paths = crate::engine::SidecarPaths::resolve_for(&exe_dir);
        let attached = paths
            .gs_resources
            .as_ref()
            .expect("SidecarPaths carries the resolved gs resources");
        assert_eq!(
            attached.search_paths.first().map(String::as_str),
            Some(resources.join("Resource/Init").to_str().unwrap())
        );
        assert!(paths.gs.is_some(), "the gs sidecar itself still resolves");
        assert!(attached.icc_profiles_dir.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_for_leaves_gs_resources_none_when_absent() {
        let dir = tempfile::TempDir::new().unwrap();
        let paths = crate::engine::SidecarPaths::resolve_for(dir.path());
        assert!(
            paths.gs_resources.is_none(),
            "missing gs resources must stay None, never abort resolution"
        );
    }

    #[test]
    #[ignore = "requires sidecar binary present on this machine"]
    fn sidecar_binary_exists_for_current_target_triple() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let filename = sidecar_filename("vips").unwrap();
        let (dir, name) = EXTERNAL_BIN.rsplit_once('/').unwrap();
        assert_eq!(name, "vips", "EXTERNAL_BIN must name the vips sidecar");
        let path = format!("{}/{}/{}", manifest, dir, filename);
        let bin = std::path::Path::new(&path);
        assert!(
            bin.exists(),
            "sidecar missing at {} — run Task 6 Step 1",
            path
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(bin).unwrap().permissions().mode();
            assert!(
                mode & 0o111 != 0,
                "sidecar at {} is not executable (mode {:o})",
                path,
                mode
            );
        }

        let output = std::process::Command::new(bin)
            .arg("--version")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .expect("spawn sidecar --version");
        assert!(
            output.status.success(),
            "sidecar --version failed at {}: {}",
            path,
            String::from_utf8_lossy(&output.stderr)
        );
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            text.contains("vips"),
            "sidecar --version output did not mention vips at {}: {}",
            path,
            text
        );
    }

    #[cfg(unix)]
    #[test]
    fn sidecars_are_self_contained() {
        let script = format!(
            "{}/../scripts/audit-sidecars.sh",
            env!("CARGO_MANIFEST_DIR")
        );
        let out = std::process::Command::new("bash")
            .arg(&script)
            .output()
            .expect("audit-sidecars.sh runs");
        assert!(
            out.status.success(),
            "self-contained audit failed:\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(
            stdout.contains("gs clean-room smoke: PASS"),
            "the audit reported PASS without running the gs clean-room smoke; a \
             silently skipped smoke hides a missing/hollow gs-resources tree. \
             stdout:\n{}\nstderr:\n{}",
            stdout,
            stderr,
        );
        let summary = stdout
            .lines()
            .find(|line| line.starts_with("sidecar audit: PASS"))
            .expect("audit PASS summary line present");
        let counts = summary
            .trim_start_matches("sidecar audit: PASS (")
            .trim_end_matches(')');
        let mut parts = counts.split(", ");
        let binaries: usize = parts
            .next()
            .expect("binaries count present")
            .trim_end_matches(" binaries")
            .parse()
            .expect("binaries count parses");
        let dylibs: usize = parts
            .next()
            .expect("framework dylibs count present")
            .trim_end_matches(" framework dylibs")
            .parse()
            .expect("framework dylibs count parses");
        assert!(binaries > 0, "audit covered 0 binaries");
        assert!(dylibs > 0, "audit covered 0 framework dylibs");
    }

    #[test]
    fn tauri_conf_json_maps_gs_resources_into_the_bundle() {
        let manifest = env!("CARGO_MANIFEST_DIR");
        let conf = std::fs::read_to_string(format!("{}/tauri.conf.json", manifest))
            .expect("tauri.conf.json readable from src-tauri");
        let value: serde_json::Value = serde_json::from_str(&conf).expect("valid JSON");
        let resources = value["bundle"]["resources"]
            .as_object()
            .expect("bundle.resources must be an object (map notation)");
        let mapped = resources
            .get("gs-resources/")
            .and_then(serde_json::Value::as_str);
        assert_eq!(
            mapped,
            Some("gs-resources/"),
            "gs-resources/ must map to gs-resources/ in the bundle, got: {:?}",
            resources
        );
    }
}
