use std::path::{Component, Path, PathBuf};

pub(crate) fn target_triple(os: &str, arch: &str) -> Result<&'static str, String> {
    match (os, arch) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("windows", "x86_64") => Ok("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Ok("aarch64-pc-windows-msvc"),
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

/// Windows engines cannot sit next to the app binary: each one needs its own
/// folder of sibling DLLs, which `prep-windows.mjs` stages under
/// `binaries/engines/<name>/` and `tauri.windows.conf.json` ships as
/// `Resources/engines/`. Resolution therefore probes the bundled layout first,
/// then the repo checkout layout.
pub(crate) fn engine_candidates(
    exe_dir: &std::path::Path,
    name: &str,
) -> Vec<std::path::PathBuf> {
    let file = format!("{name}.exe");
    vec![
        exe_dir.join("resources").join("engines").join(name).join(&file),
        exe_dir.join("../../binaries/engines").join(name).join(&file),
    ]
}

/// Prepends `dir` to an existing PATH, leaving an already-present entry alone.
/// Windows DLL resolution walks PATH in order, so the engine's own folder must
/// come first or a same-named DLL elsewhere on PATH wins.
pub(crate) fn path_with_dir_front(
    existing: Option<&std::ffi::OsStr>,
    dir: &std::path::Path,
) -> std::ffi::OsString {
    let Some(existing) = existing else {
        return dir.as_os_str().to_os_string();
    };
    let existing = existing.to_string_lossy();
    let separator = ';';
    let dir_text = dir.to_string_lossy();
    let entries: Vec<&str> = existing.split(separator).filter(|e| !e.is_empty()).collect();
    if entries.iter().any(|entry| *entry == dir_text.as_ref()) {
        return existing.into_owned().into();
    }
    let mut parts = vec![dir_text.into_owned()];
    parts.extend(entries.into_iter().map(str::to_string));
    parts.join(&separator.to_string()).into()
}

pub(crate) fn resolve_engine_candidate(
    exe_dir: &std::path::Path,
    name: &str,
) -> Result<String, String> {
    let mut first_error: Option<String> = None;
    for path in engine_candidates(exe_dir, name) {
        match resolve_sidecar_path(&path, name) {
            Ok(resolved) => return Ok(resolved),
            Err(error) => {
                if first_error.is_none() {
                    first_error = Some(error);
                }
            }
        }
    }
    Err(first_error.unwrap_or_else(|| format!("Engine error: {name} not available")))
}

/// Sets the child PATH so the engine's own DLL folder is searched first.
/// Returns the PATH that was set, or `None` when the sidecar is not a Windows
/// engine folder (macOS/Linux resolve rpaths at load time).
pub fn prepend_engine_dir_to_path(
    cmd: &mut std::process::Command,
    sidecar_path: &str,
) -> Option<std::ffi::OsString> {
    if !cfg!(windows) {
        return None;
    }
    let path = std::path::Path::new(sidecar_path);
    let dir = path.parent()?;
    let existing = std::env::var_os("PATH");
    let fronted = path_with_dir_front(existing.as_deref(), dir);
    cmd.env("PATH", &fronted);
    Some(fronted)
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

#[derive(Debug, PartialEq, Eq)]
enum DirContents {
    Populated,
    Empty,
    Unreadable(std::io::ErrorKind),
}

fn dir_contents(dir: &Path) -> DirContents {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) => return DirContents::Unreadable(error.kind()),
    };
    let mut populated = false;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if !is_gs_sentinel(&entry.file_name()) {
                populated = true;
            }
        } else if path.is_dir() && dir_contents(&path) != DirContents::Empty {
            populated = true;
        }
    }
    if populated {
        DirContents::Populated
    } else {
        DirContents::Empty
    }
}

fn dir_has_file(dir: &Path) -> bool {
    match dir_contents(dir) {
        DirContents::Populated => true,
        DirContents::Empty => false,
        DirContents::Unreadable(kind) => {
            eprintln!(
                "warn: could not read {} ({kind}) — treating it as unusable rather than empty, \
                 because reporting 'no real files' would send you to restage the tree when the \
                 actual problem is {kind}",
                dir.display(),
            );
            false
        }
    }
}

fn missing_gs_search_dirs(base: &Path) -> Vec<&'static str> {
    GS_RESOURCE_SEARCH_DIRS
        .iter()
        .filter(|relative| !base.join(relative).is_dir())
        .copied()
        .collect()
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
    let missing = missing_gs_search_dirs(&base);
    for relative in &missing {
        eprintln!(
            "warn: {relative} is absent from the staged gs resources at {} — no -I flag will be \
             passed for it, so gs falls back to its compiled-in Homebrew prefix for anything it \
             holds. Run 'yarn binaries:prep' to restage.",
            base.display()
        );
    }
    let search_paths: Vec<String> = GS_RESOURCE_SEARCH_DIRS
        .iter()
        .filter(|relative| !missing.contains(relative))
        .map(|relative| base.join(relative).to_string_lossy().into_owned())
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
            target_triple("windows", "aarch64"),
            Ok("aarch64-pc-windows-msvc")
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
            sidecar_filename_for("windows", "aarch64", "gs"),
            Ok("gs-aarch64-pc-windows-msvc.exe".to_string())
        );
        assert_eq!(
            sidecar_filename_for("windows", "aarch64", "qpdf"),
            Ok("qpdf-aarch64-pc-windows-msvc.exe".to_string())
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
    fn engine_folder_candidates_windows_layout() {
        let exe_dir = std::path::PathBuf::from("/opt/app/resources");
        let candidates = engine_candidates(&exe_dir, "vips");

        assert!(
            !candidates.is_empty(),
            "Windows engines live in per-engine folders beside their DLLs, so they need their own \
             candidate list"
        );
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.to_string_lossy().ends_with("vips.exe")),
            "every engine candidate must name the <dest>.exe the prep staged: {:?}",
            candidates
        );
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.ends_with("binaries/engines/vips/vips.exe")),
            "the dev layout lives under binaries/engines, which is what the repo checkout runs \
             against: {:?}",
            candidates
        );
        assert!(
            candidates
                .iter()
                .any(|candidate| candidate.ends_with("resources/engines/vips/vips.exe")),
            "the bundled layout puts engines/ under Resources: {:?}",
            candidates
        );
    }

    #[test]
    fn path_with_dir_front_prepends_and_dedupes() {
        use std::ffi::OsStr;

        let existing = Some(OsStr::new("A;B"));
        let fronted = path_with_dir_front(existing, std::path::Path::new("D"));
        assert_eq!(fronted.to_string_lossy(), "D;A;B");

        let already = Some(OsStr::new("A;D;B"));
        let unchanged = path_with_dir_front(already, std::path::Path::new("D"));
        assert_eq!(
            unchanged.to_string_lossy(),
            "A;D;B",
            "a dir already on PATH must not be duplicated, or a stale copy could win"
        );

        let bare = path_with_dir_front(None, std::path::Path::new("D"));
        assert_eq!(bare.to_string_lossy(), "D");
    }

    #[test]
    fn sidecar_candidates_prefer_triple_then_plain_name() {
        let dir = std::path::PathBuf::from("/opt/engine");
        let candidates = sidecar_candidates(&dir, "vips");

        assert_eq!(
            candidates.len(),
            2,
            "the exe-dir candidate list is exactly the triple-suffixed name then the plain name"
        );
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
    const SHARED_SENTINEL_MODULE: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../scripts/binaries/gs-sentinels.mjs");

    #[cfg(unix)]
    struct SharedSentinelContract {
        prefix: String,
        init_sentinel: String,
        search_dirs: Vec<String>,
        sentinel_names: Vec<String>,
    }

    #[cfg(unix)]
    fn shared_sentinel_contract() -> SharedSentinelContract {
        let source = std::fs::read_to_string(SHARED_SENTINEL_MODULE).unwrap_or_else(|error| {
            panic!(
                "cannot read {} ({error}): the Rust gs sentinel constants are pinned to it, so \
                 the audit, prep, verify and the shipped sidecar resolver can never disagree \
                 about which staged files are sentinels",
                SHARED_SENTINEL_MODULE
            )
        });
        let quoted = |key: &str| -> String {
            let line = source
                .lines()
                .find(|line| line.starts_with(&format!("export const {key} = \"")))
                .unwrap_or_else(|| panic!("{key} is missing from {SHARED_SENTINEL_MODULE}"));
            let value = line
                .split('"')
                .nth(1)
                .unwrap_or_else(|| panic!("{key} has no quoted value"));
            value.to_string()
        };
        let prefix = quoted("GS_SENTINEL_PREFIX");
        let init_sentinel = quoted("GS_INIT_SENTINEL");
        let dirs_line = source
            .lines()
            .find(|line| line.starts_with("export const GS_SEARCH_DIRS = ["))
            .unwrap_or_else(|| {
                panic!("GS_SEARCH_DIRS is missing from {SHARED_SENTINEL_MODULE}")
            });
        let search_dirs: Vec<String> = dirs_line
            .split('"')
            .skip(1)
            .step_by(2)
            .map(|dir| dir.to_string())
            .collect();
        assert!(
            !search_dirs.is_empty(),
            "GS_SEARCH_DIRS in {SHARED_SENTINEL_MODULE} parsed as empty, so this parser is stale"
        );
        let sentinel_names = search_dirs
            .iter()
            .map(|dir| {
                if dir == "Resource/Init" {
                    init_sentinel.clone()
                } else {
                    format!(
                        "{}{}-sentinel.ps",
                        prefix,
                        dir.replace('/', "-").to_lowercase()
                    )
                }
            })
            .collect();
        SharedSentinelContract {
            prefix,
            init_sentinel,
            search_dirs,
            sentinel_names,
        }
    }

    #[cfg(unix)]
    #[test]
    fn gs_sentinel_constants_match_the_shared_javascript_module() {
        let shared = shared_sentinel_contract();
        assert_eq!(
            GS_SENTINEL_PREFIX,
            shared.prefix,
            "Rust's GS_SENTINEL_PREFIX has drifted from scripts/binaries/gs-sentinels.mjs. \
             The runtime consequence is that the sentinels prep stages stop counting as \
             sentinels here, so a gs-resources tree whose font dirs hold ONLY those sentinels \
             resolves to Some(GsResources) instead of None, gs is then spawned with -I flags \
             into a hollow tree, and PDF compression silently falls back to a system \
             Ghostscript on clean machines — the exact incident these sentinels exist to catch."
        );
        assert_eq!(
            GS_RESOURCE_SEARCH_DIRS.to_vec(),
            shared.search_dirs,
            "Rust's GS_RESOURCE_SEARCH_DIRS has drifted from scripts/binaries/gs-sentinels.mjs, \
             so the -I flags the app passes differ from the dirs prep staged sentinels into."
        );
        let _ = &shared.init_sentinel;
    }

    #[cfg(unix)]
    #[test]
    fn sentinel_only_font_dirs_using_the_shared_module_names_do_not_resolve() {
        let shared = shared_sentinel_contract();
        let dir = tempfile::TempDir::new().unwrap();
        let exe_dir = dir.path().join("Contents/MacOS");
        std::fs::create_dir_all(&exe_dir).unwrap();
        let resources = gs_resource_root(dir.path(), "Contents/Resources/gs-resources");
        write_gs_resources(&resources, &["lib", "Resource/Font", "fonts"]);
        empty_dir(&resources, &["Resource/Font", "fonts"]);
        let font_sentinel_names: Vec<String> = shared
            .search_dirs
            .iter()
            .zip(shared.sentinel_names.iter())
            .filter(|(dir, _)| GS_FONT_DIRS.contains(&dir.as_str()))
            .map(|(_, name)| name.clone())
            .collect();
        assert_eq!(
            font_sentinel_names.len(),
            GS_FONT_DIRS.len(),
            "scripts/binaries/gs-sentinels.mjs must declare a sentinel dir for each of {:?}",
            GS_FONT_DIRS
        );
        for name in &font_sentinel_names {
            for font_dir in GS_FONT_DIRS {
                std::fs::write(resources.join(font_dir).join(name), b"%!\n").unwrap();
            }
        }

        assert!(
            resolve_gs_resources(&exe_dir).is_none(),
            "font dirs holding only the sentinels named by scripts/binaries/gs-sentinels.mjs \
             must not resolve: resolving them would spawn gs with -I flags into a hollow tree \
             and silently resolve fonts from a system Ghostscript"
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
    fn missing_search_dirs_are_reported_rather_than_silently_dropped() {
        let dir = tempfile::TempDir::new().unwrap();
        let base = dir.path().join("gs-resources");
        std::fs::create_dir_all(base.join("Resource/Init")).unwrap();
        std::fs::create_dir_all(base.join("Resource/Font")).unwrap();
        std::fs::create_dir_all(base.join("fonts")).unwrap();

        assert_eq!(
            missing_gs_search_dirs(&base),
            vec!["lib"],
            "a staged tree without lib/ must be named, not quietly filtered out of the -I list: \
             silently dropping it is how gs ends up resolving lib/ from a system Ghostscript"
        );

        std::fs::create_dir_all(base.join("lib")).unwrap();
        assert!(
            missing_gs_search_dirs(&base).is_empty(),
            "a complete tree must report nothing missing"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_dir_is_distinguished_from_an_empty_one() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::TempDir::new().unwrap();
        let empty = dir.path().join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(dir_contents(&empty), DirContents::Empty);

        let unreadable = dir.path().join("unreadable");
        std::fs::create_dir_all(&unreadable).unwrap();
        std::fs::write(unreadable.join("real-font"), b"font").unwrap();
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o000)).unwrap();

        assert_eq!(
            dir_contents(&unreadable),
            DirContents::Unreadable(std::io::ErrorKind::PermissionDenied),
            "a permissions problem must not be reported as an empty tree: the remedy is not to \
             restage the tree but to fix the permissions"
        );
        assert!(
            !dir_has_file(&unreadable),
            "an unreadable dir still fails closed"
        );

        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(dir_contents(&unreadable), DirContents::Populated);
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
    fn gs_artifacts_staged(bin_dir: &std::path::Path) -> bool {
        bin_dir.is_dir()
    }

    #[cfg(unix)]
    #[test]
    fn an_unstaged_binaries_dir_is_detected_so_the_gate_reports_not_staged() {
        let dir = tempfile::TempDir::new().unwrap();
        let bin_dir = dir.path().join("binaries");
        assert!(
            !gs_artifacts_staged(&bin_dir),
            "src-tauri/binaries is a generated, gitignored artifact, so its absence must be              reported as not-staged rather than failing as a code defect"
        );
        std::fs::create_dir_all(&bin_dir).unwrap();
        assert!(
            gs_artifacts_staged(&bin_dir),
            "once the artifacts are staged the audit's assertions must run for real"
        );
    }

    #[cfg(unix)]
    #[test]
    fn sidecars_are_self_contained() {
        let bin_dir = format!("{}/binaries", env!("CARGO_MANIFEST_DIR"));
        if !gs_artifacts_staged(std::path::Path::new(&bin_dir)) {
            eprintln!(
                "skipping sidecars_are_self_contained: {} does not exist. It is a generated, \
                 gitignored artifact — run 'yarn binaries:all --target <triple>' to stage it. \
                 The audit's own assertions run unchanged once it is present.",
                bin_dir
            );
            return;
        }
        let script = format!(
            "{}/../scripts/audit-sidecars.sh",
            env!("CARGO_MANIFEST_DIR")
        );
        let out = std::process::Command::new("bash")
            .arg(&script)
            .env("BINARIES_ALLOW_INACTIVE_BREW", "1")
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
