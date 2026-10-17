use std::{env, path::PathBuf};

fn is_windows_msvc() -> bool {
    env::var_os("CARGO_CFG_TARGET_OS").as_deref() == Some(std::ffi::OsStr::new("windows"))
        && env::var_os("CARGO_CFG_TARGET_ENV").as_deref() == Some(std::ffi::OsStr::new("msvc"))
}

fn main() {
    if is_windows_msvc() {
        let manifest =
            PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"))
                .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo::rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo::rustc-link-arg=/MANIFESTUAC:NO");
        println!(
            "cargo::rustc-link-arg=/MANIFESTINPUT:{}",
            manifest.display()
        );
        tauri_build::try_build(
            tauri_build::Attributes::new().windows_attributes(
                tauri_build::WindowsAttributes::new_without_app_manifest(),
            ),
        )
        .expect("failed to run tauri-build");
    } else {
        tauri_build::build();
    }
}
