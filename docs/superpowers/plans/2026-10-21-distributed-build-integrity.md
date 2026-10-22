# Distributed Build Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the released app actually compress files on macOS and Windows, and add a CI gate that proves the built package works.

**Architecture:** Three independent defects — one macOS, two Windows — plus the missing check that let them through. macOS: an entitlements file lets the ad-hoc-signed helper programs load the ad-hoc-signed dylibs they ship with. Windows: one line in the platform bundle config moves the engines into `resources/engines/`, the folder the app's resolver already probes, and one candidate line lets the resolver find `ffmpeg.exe`/`ffprobe.exe` under the stripped names the bundler produces. The new CI gate opens each built package and runs every helper on a real file.

**Tech Stack:** Tauri 2.12, Rust (serde_json), Node 22 ESM scripts, vitest, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-21-distributed-build-integrity-design.md`

## Global Constraints

- Conventional commits: `feat(scope):`, `fix(scope):`, `chore:`, `refactor(scope):`.
- No comments in code unless explicitly requested.
- Package manager is **yarn**; `yarn test` runs `vitest run` and picks up `scripts/**/*.test.mjs` (no custom `include` in `vitest.config.ts`).
- No raw `${{ }}` inside `run:` strings — untrusted context enters via step `env`; `shell: bash` everywhere; actions stay SHA-pinned.
- `scripts/binaries.manifest.json` → `targets[triple][name].expectVersion` is the **single source of truth** for engine versions. Never hardcode a version in a script or test.
- Before any push touching `src-tauri/src/`: `cargo check --all-targets --target aarch64-pc-windows-msvc` (repo gate, `docs/ci-process.md` §3).
- Every release row keeps its `timeout-minutes`; the new gate step inherits the row's budget.
- `scripts/ci/*.mjs` files carry no license header and use `node:` built-in imports; `REPO_ROOT` is derived from `import.meta.url` (`scripts/ci/release-version-check.mjs` is the style reference).
- Rust test files in this repo: `src-tauri/src/sidecar.rs` has no license header; `src-tauri/src/engine/processor.rs` does. **No new Rust source file is created by this plan** — both Rust changes are test-module additions to existing files.
- **Never trust a stale bundle.** The local checkout can hold `src-tauri/target/release/bundle/macos/*.app` from an older build alongside the triple-specific `src-tauri/target/<triple>/release/bundle/...`. The gate must prefer the triple's own output. The stale 2026-10-08 local app is *not* code-signed and its helpers load fine — gating against it would pass while proving nothing.

## Review Focus

Five failure modes the spec implies that no step's assertions obviously cover. Each is pinned to a task below.

1. **A helper is present but cannot start** (missing dylib/DLL, or the macOS signature defect). Expected: the gate fails with the loader's own error text, not with "file not found". → Task 4, `checkEngine` runs the binary.
2. **A helper is at the right path but the app cannot find it** (producer/consumer drift). Expected: the app's own resolver fails even though the package looks complete. → Task 2 (engine-folder contract test), Task 2b (externalBin stripped-name contract test) and Task 3 (resolver test).
3. **A helper starts but produces nothing** (gs writing a 0-byte PDF). Expected: the gate fails on "output file is empty", not on a non-zero exit. → Task 4, every operation asserts a non-empty output file.
4. **A stale engine version** is packaged (bundle from an older freeze). Expected: the gate fails on the version mismatch against the manifest. → Task 4, version check via `checkVersion`.
5. **The user installs the MSI, not the NSIS installer.** CI only gates the NSIS payload. Expected: the manual checklist covers an MSI install explicitly, and the doc records that the MSI is not CI-gated. → Task 5.

---

## File Structure

**New:**

| File | Responsibility |
|---|---|
| `src-tauri/Entitlements.plist` | The one Apple entitlement that lets the ad-hoc-signed sidecars load the ad-hoc-signed dylibs. Referenced by `bundle.macOS.entitlements`. |
| `scripts/ci/package-gate.mjs` | Opens the built package for a triple, asserts every engine is where the app looks, runs every engine on a real file, and runs the app's own resolver against the package. One command, runnable locally and in CI. |
| `scripts/ci/package-gate.test.mjs` | vitest coverage for the gate's pure logic (path derivation, operation plan, argument parsing, step-output checks) plus the `checkVersion` env-override contract (mocked `execFile`, the `all.test.mjs` pattern). |
| `docs/adr/0002-macos-distribution-signing.md` | Why we ship macOS un-notarized, what the entitlement does, and exactly what changes when an Apple Developer Program membership is added. |
| `docs/distribution-acceptance.md` | The manual checklist: install commands per platform, the 4 platforms × 4 file types matrix, and what to record on failure. |

**Modified:**

| File | Change |
|---|---|
| `src-tauri/tauri.conf.json` | `bundle.macOS.entitlements` → `"Entitlements.plist"`. |
| `src-tauri/Cargo.toml` | `plist = "1"` in `[dev-dependencies]` for the entitlements config test (already in `Cargo.lock` via `tauri`). |
| `src-tauri/tauri.windows.conf.json` | `bundle.resources["binaries/engines/"]` → `"resources/engines/"`. |
| `src-tauri/src/sidecar.rs` | One new candidate line in `sidecar_candidates` (Task 2b) and three new tests in the existing `#[cfg(test)] mod tests`: the entitlements config test (Task 1), the Windows engine-folder contract test (Task 2), and the externalBin stripped-name contract test (Task 2b). |
| `src-tauri/src/engine/processor.rs` | One new test: `resolve_for_finds_every_engine_in_a_bundled_package` (Task 3). |
| `scripts/binaries/verify.mjs` | `export` the existing `checkVersion` and add an optional `{ env }` override so the gate can reuse it without inheriting the staging-tree `DYLD_LIBRARY_PATH` (`verify.mjs:33-36`). |
| `.github/workflows/release.yml` | One new step per release row, after the existing `fail-closed app-asset check for this triple` step. |
| `scripts/binaries/verify.test.mjs` | The merged-windows-resources pin (`merges_the_windows_conf_into_a_resources_map_without_gs_resources`, line 1011) follows the Task 2 config change to `resources/engines/`. |
| `scripts/ci/workflows.test.mjs` | One new case pinning the package-gate step: exists on every row, runs after the app-asset check, no `if`, `TRIPLE` via step env, `shell: bash` (Task 4). |
| `docs/ci-process.md`, `docs/ARCHITECTURE.md`, `README.md`, `docs/bugs.md` | Documentation corrections (Task 5). |

**Untouched:** `src-tauri/src/**` production code beyond the one `sidecar_candidates` line, `scripts/binaries/**` beyond the `checkVersion` export + env override and the one pinned merged-map value in `verify.test.mjs`, `scripts/ci/unfreeze.sh`, `scripts/ci/freeze.sh`, `.github/workflows/ci.yml`, `.github/workflows/freeze.yml`.

---

## Task 1: macOS — let the helper programs load their libraries

**Files:**
- Create: `src-tauri/Entitlements.plist`
- Modify: `src-tauri/tauri.conf.json` (`bundle.macOS`, currently line 42-43)
- Modify: `src-tauri/Cargo.toml` — add `plist = "1"` to `[dev-dependencies]` (already in `Cargo.lock` as a `tauri` transitive dependency at 1.10.1; no new crate is fetched)
- Test: `src-tauri/src/sidecar.rs` (existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `src-tauri/Entitlements.plist`, referenced by `bundle.macOS.entitlements` as the relative path `"Entitlements.plist"` (resolved against `src-tauri/`). Task 3 and Task 4 rely on the shipped `.app` actually running its helpers.

- [x] **Step 1: Write the failing config test**

Append to the `#[cfg(test)] mod tests` block in `src-tauri/src/sidecar.rs`:

```rust
#[test]
fn tauri_conf_json_references_a_readable_macos_entitlements_file() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let conf = std::fs::read_to_string(format!("{manifest}/tauri.conf.json"))
        .expect("tauri.conf.json readable from src-tauri");
    let value: serde_json::Value =
        serde_json::from_str(&conf).expect("tauri.conf.json parses as JSON");
    let entitlements = value["bundle"]["macOS"]["entitlements"]
        .as_str()
        .unwrap_or_else(|| {
            panic!(
                "bundle.macOS.entitlements must be a string, got {:?}",
                value["bundle"]["macOS"]["entitlements"]
            )
        });
    assert_ne!(
        value["bundle"]["macOS"]["hardenedRuntime"],
        serde_json::Value::Bool(false),
        "the hardened runtime must stay on: the entitlement route exists precisely to keep the \
         notarization path open"
    );
    let path = format!("{manifest}/{entitlements}");
    let plist = plist::Value::from_file(&path)
        .unwrap_or_else(|error| panic!("{path} must be a well-formed plist: {error}"));
    let dict = plist
        .as_dictionary()
        .unwrap_or_else(|| panic!("{path} must contain a top-level dictionary"));
    assert_eq!(
        dict.len(),
        1,
        "{path} must carry exactly the one narrow exemption this app allows, got {:?}",
        dict.keys().collect::<Vec<_>>()
    );
    assert_eq!(
        dict.get("com.apple.security.cs.disable-library-validation"),
        Some(&plist::Value::Boolean(true)),
        "{path} must grant com.apple.security.cs.disable-library-validation = true — without \
         it the hardened runtime rejects the ad-hoc-signed dylibs the helpers ship with"
    );
}
```

Parse the plist rather than matching text: CF's last-wins duplicate handling, XML comments, and keys nested in an inner `<dict>` all pass a substring check while leaving the entitlement off, and the single-key assertion keeps the exemption as narrow as the app allows (one entitlement).

- [x] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib tauri_conf_json_references_a_readable_macos_entitlements_file`
Expected: FAIL — `bundle.macOS.entitlements` is absent, so `.as_str()` returns `None` and the `unwrap_or_else` panics.

- [x] **Step 3: Create the entitlements file**

Create `src-tauri/Entitlements.plist` with exactly this content:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
```

- [x] **Step 4: Reference it from the bundle config**

In `src-tauri/tauri.conf.json`, change the `bundle.macOS` block from:

```json
    "macOS": {
      "signingIdentity": "-",
```

to:

```json
    "macOS": {
      "signingIdentity": "-",
      "entitlements": "Entitlements.plist",
```

- [x] **Step 5: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib tauri_conf_json_references_a_readable_macos_entitlements_file`
Expected: PASS.

- [x] **Step 6: Run the full Rust gate**

Run: `cd src-tauri && cargo test`
Expected: PASS — no existing test regressed.

- [x] **Step 7: Run the Windows-target compile gate**

The repo's documented pre-push gate for `src-tauri/src/` changes (`docs/ci-process.md` §3):

```bash
for b in vips qpdf gs ffmpeg ffprobe; do : > src-tauri/binaries/${b}-aarch64-pc-windows-msvc.exe; done && mkdir -p src-tauri/binaries/engines
cd src-tauri && env RC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/llvm-rc CC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/clang cargo check --all-targets --target aarch64-pc-windows-msvc; cd ..
rm -f src-tauri/binaries/*-aarch64-pc-windows-msvc.exe
```

Expected: the check succeeds. If `llvm` is not installed at that path, install it (`brew install llvm`) — the gate needs it to cross-compile the embedded Windows resource.

- [x] **Step 8: Verify the real artifact (the actual acceptance check)**

Run the framework-list sync first, then the build (the build takes several minutes):

```bash
node scripts/binaries/sync-macos-frameworks.mjs --target aarch64-apple-darwin
yarn tauri build --target aarch64-apple-darwin
```

Then:

```bash
APP="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/file-compressor.app"
codesign -d --entitlements - "$APP/Contents/MacOS/vips" 2>&1 | grep -q disable-library-validation && echo "entitlement present"
"$APP/Contents/MacOS/vips" --version
"$APP/Contents/MacOS/qpdf" --version
"$APP/Contents/MacOS/gs" --version
```

Expected: `entitlement present`, then `vips-8.18.7`, `qpdf version 12.4.2`, `gs 10.08.0`. **If any helper still prints `Library not loaded`, the fix is incomplete — stop and re-read the spec §2.1 before continuing.**

If `yarn tauri build` fails for a reason unrelated to signing (missing staged engine, framework-list drift), run `yarn binaries:all --target aarch64-apple-darwin` first and retry.

- [x] **Step 9: Commit**

```bash
git add src-tauri/Entitlements.plist src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/sidecar.rs
git commit -m "fix(macos): let the ad-hoc-signed helpers load their dylibs

The released app signs the sidecars with the hardened runtime while the 71
bundled dylibs are ad-hoc signed without it, so macOS library validation
rejects them ('mapping process and mapped file have different Team IDs') and
vips/qpdf/gs die with 'Library not loaded'. Granting
com.apple.security.cs.disable-library-validation keeps the hardened runtime
on and leaves the notarization path open."
```

---

## Task 2: Windows — ship the engines where the app already looks

**Files:**
- Modify: `src-tauri/tauri.windows.conf.json` (line 8)
- Test: `src-tauri/src/sidecar.rs` (existing `#[cfg(test)] mod tests`)
- Modify: `scripts/binaries/verify.test.mjs` (the merged-windows-resources pin, line 1011)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the bundle resource target `resources/engines/` on Windows, which is the path `engine_candidates` (`src-tauri/src/sidecar.rs:68-77`) probes. Task 3's resolver test and Task 4's gate depend on this path being the real one.

- [x] **Step 1: Write the failing producer/consumer contract test**

This test binds the two halves that drifted apart: the folder the bundler produces and the folder the app looks in. It also pins the manifest `dest` names for both shipped Windows triples, and rejects a flip to a flat static row, so a rename on one side cannot move the installed folder away from what the resolver probes.

Append to the `#[cfg(test)] mod tests` block in `src-tauri/src/sidecar.rs`:

```rust
#[test]
fn windows_engine_candidates_match_the_bundle_resource_target() {
    let manifest_dir = env!("CARGO_MANIFEST_DIR");
    let conf_path = format!("{manifest_dir}/tauri.windows.conf.json");
    let conf = std::fs::read_to_string(&conf_path)
        .unwrap_or_else(|error| panic!("{conf_path} must be readable: {error}"));
    let value: serde_json::Value = serde_json::from_str(&conf)
        .unwrap_or_else(|error| panic!("{conf_path} must parse as JSON: {error}"));
    let target = value["bundle"]["resources"]["binaries/engines/"]
        .as_str()
        .expect("the windows bundle must map binaries/engines/ to a target directory");
    let manifest_path = format!("{manifest_dir}/../scripts/binaries.manifest.json");
    let manifest: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&manifest_path)
            .unwrap_or_else(|error| panic!("{manifest_path} must be readable: {error}")),
    )
    .unwrap_or_else(|error| panic!("{manifest_path} must be valid JSON: {error}"));
    let exe_dir = std::path::PathBuf::from("/opt/app");
    for triple in ["x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc"] {
        for name in ["vips", "qpdf", "gs"] {
            let row = &manifest["targets"][triple][name];
            let dest = row["dest"].as_str().unwrap_or_else(|| {
                panic!("{manifest_path} must give {name} a dest for {triple}")
            });
            assert_eq!(
                dest, name,
                "{manifest_path} renames {triple}/{name} to {dest:?}, but the resolver probes \
                 {name:?} — the installed folder would never resolve, so the manifest and the \
                 resolver drifted apart"
            );
            assert_ne!(
                row["static"],
                serde_json::Value::Bool(true),
                "{manifest_path} ships {triple}/{name} as a flat static binary, but the \
                 resolver only probes {name}/ and the engine needs its sibling DLLs — \
                 {triple}/{name} must stay a folder engine"
            );
            let expected = exe_dir.join(target).join(name).join(format!("{name}.exe"));
            let candidates = engine_candidates(&exe_dir, name);
            assert_eq!(
                candidates.first(),
                Some(&expected),
                "the bundled layout must be the first probe for {triple}/{name}: the \
                 installer places it at {expected:?}, got {candidates:?}"
            );
        }
    }
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib windows_engine_candidates_match_the_bundle_resource_target`
Expected: FAIL — the bundled layout is not the resolver's first probe for all three engines (and the test also rejects a target that only matches the dev-checkout fallback).

- [x] **Step 3: Fix the bundle config**

In `src-tauri/tauri.windows.conf.json`, change:

```diff
     "resources": {
-      "binaries/engines/": "engines/",
+      "binaries/engines/": "resources/engines/",
       "gs-resources/": null
     }
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib windows_engine_candidates_match_the_bundle_resource_target`
Expected: PASS.

- [x] **Step 5: Update the pinned merged-resources expectation in the JS suite**

The config change breaks a pinned vitest case: `scripts/binaries/verify.test.mjs` — `merges_the_windows_conf_into_a_resources_map_without_gs_resources` — asserts the merged Windows resources map equals `{ "binaries/engines/": "engines/" }` exactly (line 1011). Update the expected value to `{ "binaries/engines/": "resources/engines/" }`.

Run: `yarn vitest run scripts/binaries/verify.test.mjs`
Expected: PASS — the merged-map pin now names `resources/engines/`.

Run: `yarn test`
Expected: PASS — no other JS pin broke.

- [x] **Step 6: Run the full Rust gate**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [x] **Step 7: Run the Windows-target compile gate**

The repo's documented pre-push gate for `src-tauri/src/` changes (`docs/ci-process.md` §3):

```bash
for b in vips qpdf gs ffmpeg ffprobe; do : > src-tauri/binaries/${b}-aarch64-pc-windows-msvc.exe; done && mkdir -p src-tauri/binaries/engines
cd src-tauri && env RC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/llvm-rc CC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/clang cargo check --all-targets --target aarch64-pc-windows-msvc; cd ..
rm -f src-tauri/binaries/*-aarch64-pc-windows-msvc.exe
```

Expected: the check succeeds. If `llvm` is not installed at that path, install it (`brew install llvm`) — the gate needs it to cross-compile the embedded Windows resource.

- [x] **Step 8: Commit**

```bash
git add src-tauri/tauri.windows.conf.json src-tauri/src/sidecar.rs scripts/binaries/verify.test.mjs
git commit -m "fix(windows): ship the engines into resources/engines/

The installer put the engines in <install root>/engines/ while the app
probes <install root>/resources/engines/, so vips/qpdf/gs never resolved
and the image/PDF/document categories failed with 'Engine error: <name>
not available'. The map target now matches the documented contract in
GLOSSARY.md; no Rust change. ffmpeg/ffprobe are fixed separately in
Task 2b — the bundle names them ffmpeg.exe/ffprobe.exe and the resolver
probes the triple-suffixed and bare names."
```

---

## Task 2b: Windows — let the app find ffmpeg/ffprobe beside the exe

**Files:**
- Modify: `src-tauri/src/sidecar.rs` (`sidecar_candidates`, lines 137-144; existing `#[cfg(test)] mod tests`)
- Test: `src-tauri/src/sidecar.rs` (existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing from other tasks. Tasks 1 and 2 do not touch `sidecar_candidates`.
- Produces: a third candidate in `sidecar_candidates` — `<exe_dir>/<name>.exe` — the name the Windows bundler produces when it strips the target-triple suffix from an `externalBin` sidecar (`tauri-bundler` `copy_binaries`). Task 3's resolver test and Task 4's gate depend on it: without it, `resolve_for` returns `None` for ffmpeg/ffprobe against every Windows package, and the gate fails on `ffmpeg did not resolve`.

**Why this is a defect.** The shipped `v0.1.0-alpha.1` NSIS payload carries plain `ffmpeg.exe`/`ffprobe.exe` beside `file-compressor.exe` (spec §2.2). `sidecar_candidates` probes the triple-suffixed name (`ffmpeg-x86_64-pc-windows-msvc.exe` — the triple-suffixed staged/defensive probe, not a name the shipped package contains) and the bare name (`ffmpeg` — the macOS/Linux bundle layout). Neither names `ffmpeg.exe`, and Windows file APIs do no extension guessing, so video compression fails with `Engine error: ffmpeg not available` in every shipped Windows build.

- [x] **Step 1: Write the failing contract test**

Append to the `#[cfg(test)] mod tests` block in `src-tauri/src/sidecar.rs`:

```rust
#[test]
fn sidecar_candidates_probe_the_stripped_external_bin_name() {
    let exe_dir = std::path::PathBuf::from("/opt/app");
    let candidates = sidecar_candidates(&exe_dir, "ffmpeg");
    assert!(
        candidates.contains(&exe_dir.join("ffmpeg.exe")),
        "the windows bundler strips the -{{target_triple}} suffix and keeps the .exe, so the \
         shipped ffmpeg.exe is only found through the stripped-name candidate — \
         v0.1.0-alpha.1 shipped ffmpeg.exe beside the app and video compression failed with \
         'Engine error: ffmpeg not available'"
    );
}
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib sidecar_candidates_probe_the_stripped_external_bin_name`
Expected: FAIL — the candidate list has only the triple-suffixed and bare names, so `contains` is false.

- [x] **Step 3: Add the stripped-name candidate**

In `src-tauri/src/sidecar.rs`, in `sidecar_candidates`, after the bare-name push (current line 142):

```rust
    candidates.push(exe_dir.join(name));
    candidates.push(exe_dir.join(format!("{name}.exe")));
```

The candidate is unconditional: `sidecar_candidates` stays a pure, host-independent list — the same shape `engine_candidates` already has (`resources/engines/…` is probed on every host though only Windows bundles produce it), so the Windows shape stays unit-testable on the dev machine. On macOS/Linux the `.exe` probe is one extra metadata call that never matches; resolution order for the paths that already hit is unchanged.

- [x] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib sidecar_candidates_probe_the_stripped_external_bin_name`
Expected: PASS.

- [x] **Step 5: Update the existing candidate-list test**

`sidecar_candidates_prefer_triple_then_plain_name` (`sidecar.rs:541-553`) asserts `candidates.len() == 2` — now false. Update it and rename it to match the three-candidate contract:

```rust
#[test]
fn sidecar_candidates_prefer_triple_then_bare_then_exe_name() {
    let dir = std::path::PathBuf::from("/opt/engine");
    let candidates = sidecar_candidates(&dir, "vips");

    let triple_name = sidecar_filename("vips").expect("host platform must map to a triple");
    assert_eq!(
        candidates.len(),
        3,
        "the exe-dir candidate list is exactly the triple-suffixed name, then the bare name, \
         then the stripped .exe name the windows bundler produces"
    );
    assert_eq!(candidates[0], dir.join(triple_name));
    assert_eq!(candidates[1], dir.join("vips"));
    assert_eq!(candidates[2], dir.join("vips.exe"));
}
```

Run: `cd src-tauri && cargo test --lib sidecar_candidates_prefer_triple_then_bare_then_exe_name`
Expected: PASS.

- [x] **Step 6: Run the full Rust gate**

Run: `cd src-tauri && cargo test`
Expected: PASS — no existing test regressed. (`resolve_for_windows_still_resolves_exe_dir_binaries` in `processor.rs` keeps passing: the triple-suffixed candidates still resolve first.)

- [x] **Step 7: Run the Windows-target compile gate**

The repo's documented pre-push gate for `src-tauri/src/` changes (`docs/ci-process.md` §3):

```bash
for b in vips qpdf gs ffmpeg ffprobe; do : > src-tauri/binaries/${b}-aarch64-pc-windows-msvc.exe; done && mkdir -p src-tauri/binaries/engines
cd src-tauri && env RC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/llvm-rc CC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/clang cargo check --all-targets --target aarch64-pc-windows-msvc; cd ..
rm -f src-tauri/binaries/*-aarch64-pc-windows-msvc.exe
```

Expected: the check succeeds. If `llvm` is not installed at that path, install it (`brew install llvm`) — the gate needs it to cross-compile the embedded Windows resource.

- [x] **Step 8: Commit**

```bash
git add src-tauri/src/sidecar.rs
git commit -m "fix(windows): let the app find ffmpeg/ffprobe beside the exe

The bundler strips the target-triple suffix when it copies an externalBin
sidecar (tauri-bundler copy_binaries), so the installer ships ffmpeg.exe
and ffprobe.exe while the resolver probed only the triple-suffixed and
bare names. Video compression failed with 'Engine error: ffmpeg not
available' in every shipped Windows build. sidecar_candidates now probes
the stripped name as its third candidate."
```

## Task 3: A test that the app's own resolver finds every engine in a real package

**Files:**
- Modify: `src-tauri/src/engine/processor.rs` (existing `#[cfg(test)] mod tests`, next to `resolve_for_reads_engines_from_the_engine_folder_layout` at line 377)

**Interfaces:**
- Consumes: the Windows layout `resources/engines/<name>/<name>.exe` fixed in Task 2; the stripped-name candidate `<exe_dir>/<name>.exe` added in Task 2b — Step 3's `ffmpeg.exe`/`ffprobe.exe` fixtures resolve through it on every host; the macOS flat `externalBin` layout `Contents/MacOS/<name>`.
- Produces: an environment variable contract that Task 4's gate script drives — **`FSO_BUNDLE_EXE_DIR`**, the absolute path of the directory that contains the app executable. Inside a macOS `.app` that is `<app>/Contents/MacOS`; for the unpacked Windows installer it is the extraction root. With `FSO_BUNDLE_EXE_DIR` unset and no sentinel, the test prints an explicit skip message and returns. Task 4 also sets **`FSO_BUNDLE_GATE=1`**; with that sentinel set and `FSO_BUNDLE_EXE_DIR` missing the test fails closed, because `cargo test --lib <filter>` also exits 0 when the filter matches nothing. The test also rejects a value that is not an absolute directory, an engine that resolves through a `..` component or outside `FSO_BUNDLE_EXE_DIR` (the `../../binaries/engines` dev fallback), and a resolved file whose name is not exactly the engine's plain name after stripping `.exe` — a triple-suffixed `vips-aarch64-apple-darwin` from `target/<triple>/debug` is not a packaged engine. On success the test prints **`fso-bundle-resolver-ok: <exe_dir>`**; Task 4 requires that marker in the output, because a skipped test also exits 0.

- [x] **Step 1: Write the failing test**

Append to the `#[cfg(test)] mod tests` block in `src-tauri/src/engine/processor.rs`:

```rust
#[test]
fn resolve_for_finds_every_engine_in_a_bundled_package() {
    let exe_dir = match std::env::var("FSO_BUNDLE_EXE_DIR") {
        Ok(dir) => dir,
        Err(_) => {
            assert!(
                std::env::var_os("FSO_BUNDLE_GATE").is_none(),
                "FSO_BUNDLE_GATE is set but FSO_BUNDLE_EXE_DIR is missing — the package gate must \
                 pass the built package's executable directory"
            );
            eprintln!(
                "skipping resolve_for_finds_every_engine_in_a_bundled_package: FSO_BUNDLE_EXE_DIR is \
                 not set — the package gate sets it to the built package's executable directory"
            );
            return;
        }
    };
    let exe_dir = std::path::PathBuf::from(exe_dir);
    assert!(
        exe_dir.is_absolute(),
        "FSO_BUNDLE_EXE_DIR must be absolute, got {exe_dir:?} — the package gate passes the built \
         package's executable directory"
    );
    assert!(
        exe_dir.is_dir(),
        "FSO_BUNDLE_EXE_DIR must be a directory, got {exe_dir:?} — the package gate passes the built \
         package's executable directory"
    );
    let paths = SidecarPaths::resolve_for(&exe_dir);
    for (name, resolved) in [
        ("vips", &paths.vips),
        ("ffmpeg", &paths.ffmpeg),
        ("ffprobe", &paths.ffprobe),
        ("gs", &paths.gs),
        ("qpdf", &paths.qpdf),
    ] {
        let resolved = resolved.as_deref().unwrap_or_else(|| {
            panic!(
                "{name} did not resolve from the built package at {exe_dir:?} — the app would \
                 report 'Engine error: {name} not available' at compression time"
            )
        });
        assert!(
            !std::path::Path::new(resolved)
                .components()
                .any(|c| c == std::path::Component::ParentDir),
            "{name} resolved to {resolved:?}, which climbs out of {exe_dir:?} — the dev-tree \
             fallback satisfied this, so the package itself may not ship {name}"
        );
        assert!(
            std::path::Path::new(resolved).starts_with(&exe_dir),
            "{name} resolved to {resolved:?}, outside {exe_dir:?}"
        );
        let file_name = std::path::Path::new(resolved)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_else(|| panic!("{name} resolved to {resolved:?}, which has no file name"));
        let stem = file_name.strip_suffix(".exe").unwrap_or(file_name);
        assert!(
            stem == name,
            "{name} resolved to {resolved:?} — packaged engines use their plain name"
        );
    }
    println!("fso-bundle-resolver-ok: {exe_dir:?}");
}
```

- [x] **Step 2: Run the test with the variable unset**

Run: `cd src-tauri && env -u FSO_BUNDLE_EXE_DIR -u FSO_BUNDLE_GATE cargo test --lib resolve_for_finds_every_engine_in_a_bundled_package -- --nocapture`
Expected: PASS with the printed skip message. With the `FSO_BUNDLE_GATE` sentinel also unset, skipping is legitimate; an ordinary `cargo test` never sets either variable.

- [x] **Step 3: Run the test against a synthetic Windows package to see it pass**

Create the layout the installer now produces, then point the test at it the way the gate does (`FSO_BUNDLE_EXE_DIR` plus the `FSO_BUNDLE_GATE=1` sentinel). Use the fixed path `/tmp/fso-bundle-fixture` — the next step re-uses it, and a plan step cannot see another step's shell variables:

```bash
rm -rf /tmp/fso-bundle-fixture
mkdir -p /tmp/fso-bundle-fixture/resources/engines/vips /tmp/fso-bundle-fixture/resources/engines/gs /tmp/fso-bundle-fixture/resources/engines/qpdf
: > /tmp/fso-bundle-fixture/resources/engines/vips/vips.exe
: > /tmp/fso-bundle-fixture/resources/engines/gs/gs.exe
: > /tmp/fso-bundle-fixture/resources/engines/qpdf/qpdf.exe
: > /tmp/fso-bundle-fixture/ffmpeg.exe
: > /tmp/fso-bundle-fixture/ffprobe.exe
cd src-tauri && FSO_BUNDLE_EXE_DIR=/tmp/fso-bundle-fixture FSO_BUNDLE_GATE=1 cargo test --lib resolve_for_finds_every_engine_in_a_bundled_package -- --nocapture
```

Expected: PASS — all five resolve (vips/gs/qpdf through the `resources/engines/` candidates, ffmpeg/ffprobe through the host-independent stripped-name candidate from Task 2b).

- [x] **Step 4: Prove the test can fail (the negative case)**

Remove one engine from the same fixture and re-run:

```bash
rm /tmp/fso-bundle-fixture/resources/engines/vips/vips.exe
cd src-tauri && FSO_BUNDLE_EXE_DIR=/tmp/fso-bundle-fixture FSO_BUNDLE_GATE=1 cargo test --lib resolve_for_finds_every_engine_in_a_bundled_package -- --nocapture
```

Expected: FAIL with `vips did not resolve from the built package`. A test that cannot fail is not a test — confirm the failure before continuing.

- [x] **Step 5: Run the full Rust gate**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [x] **Step 6: Run the Windows-target compile gate**

The repo's documented pre-push gate for `src-tauri/src/` changes (`docs/ci-process.md` §3):

```bash
for b in vips qpdf gs ffmpeg ffprobe; do : > src-tauri/binaries/${b}-aarch64-pc-windows-msvc.exe; done && mkdir -p src-tauri/binaries/engines
cd src-tauri && env RC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/llvm-rc CC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/clang cargo check --all-targets --target aarch64-pc-windows-msvc; cd ..
rm -f src-tauri/binaries/*-aarch64-pc-windows-msvc.exe
```

Expected: the check succeeds. If `llvm` is not installed at that path, install it (`brew install llvm`) — the gate needs it to cross-compile the embedded Windows resource.

- [x] **Step 7: Commit**

```bash
git add src-tauri/src/engine/processor.rs
git commit -m "test(core): assert the resolver finds every engine in a built package

The app resolved engines from the exe directory; the release gate never
checked that the built package put them there. This test drives the real
resolver against a real package layout via FSO_BUNDLE_EXE_DIR."
```

---

## Task 4: A CI gate that opens the built package and runs every engine

**Files:**
- Create: `scripts/ci/package-gate.mjs`
- Create: `scripts/ci/package-gate.test.mjs`
- Modify: `scripts/binaries/verify.mjs` (export `checkVersion` with an optional `env` override, line 32)
- Modify: `.github/workflows/release.yml` (new step after the `fail-closed app-asset check for this triple` step, which ends at line 236)
- Modify: `scripts/ci/workflows.test.mjs` (one new case pinning the package-gate step — Step 10)

**Interfaces:**
- Consumes: `FSO_BUNDLE_EXE_DIR` plus the `FSO_BUNDLE_GATE=1` sentinel (Task 3) — the gate sets both when it spawns the resolver test, and passes only when that command exits 0 **and** its output contains the `fso-bundle-resolver-ok` marker; a skipped or filtered-out test also exits 0, and a skipped test never prints the marker. Also consumes `scripts/binaries.manifest.json` → `targets[triple][name].expectVersion`, `scripts/binaries/verify.mjs` → `checkVersion` (called with `{ env: process.env }` so the staging-tree `DYLD_LIBRARY_PATH` at `verify.mjs:33-36` never shadows the package's own dylibs), `scripts/binaries/lib.mjs` → `isMain`, `readJson`, `exists`, `parseArgs`, `run`, `isWindowsTriple`, `manifestPath`.
- Produces: `node scripts/ci/package-gate.mjs --triple <triple>` — exit 0 when every check passes, exit 1 with a per-check report otherwise.

**Exports of `scripts/ci/package-gate.mjs` (the surface the vitest file pins):**

```js
export function parseGateArgs(argv)                    // → { triple, bundleDir }; throws on a missing/unsupported --triple
export function expectedEnginePaths({ triple, exeDir, manifest, baseConf, windowsConf })  // → Map<engineName, absolutePath>
export function expectedVersions({ triple, manifest }) // → Map<engineName, expectVersion>, read from the manifest
export function enginePlan()                          // → Map<engineName, { versionArgs, fixtures, steps }>
export function gsRunArgs({ exeDir, triple })          // → string[]; macOS: package -I flags + gs step args; Windows: bare gs step args
export function locateBundle({ root, triple })        // → { kind: "app" | "nsis", path } | null
export async function extractNsisInstaller({ setupExe, destDir })  // → destDir; throws a named error when 7z is missing
export function checkStepOutput({ step, workDir, stdout })  // → { ok, detail }; rejects an empty output file
export async function main(argv)                       // → exit code (0 pass, 1 fail)
```

**Path construction.** Every path is built with `node:path`'s `join`, never by string concatenation, so the same expectations hold on the macOS and Windows release rows. The vitest file below compares against `join(...)` for the same reason.

**The operation plan (`enginePlan()`), one entry per engine.** A step passes when the command exits 0 **and** (it produces no file **or** the produced file exists and is non-empty) **and** (it declares no stdout expectation **or** stdout contains it).

| engine | `versionArgs` | `fixtures` (written into the work dir first) | `steps` |
|---|---|---|---|
| vips | `["--version"]` | — | `["black","in.v","64","64"]` (no output); `["thumbnail","in.v","out.jpg","32"]` → produces `out.jpg` |
| qpdf | `["--version"]` | — | `["--empty","out.pdf"]` → produces `out.pdf`; `["out.pdf","out-rewritten.pdf"]` → produces `out-rewritten.pdf` |
| gs | `["--version"]` | `in.ps` (four lines: `%!PS`, `/Helvetica findfont 16 scalefont setfont`, `72 700 moveto (gate) show`, `showpage`) | `["-q","-dNOPAUSE","-dBATCH","-sDEVICE=pdfwrite","-sOutputFile=out.pdf","in.ps"]` → produces `out.pdf` |
| ffmpeg | `["--version"]` | — | `["-y","-f","lavfi","-i","color=c=red:s=64x64:d=1","-frames:v","1","out.png"]` → produces `out.png` |
| ffprobe | `["--version"]` | — | `["-v","error","-show_entries","stream=width,height","-of","csv","out.png"]` → expects stdout containing `64,64` |

The qpdf recipe uses `--empty` alone: the page-selection form `--empty --pages . 1 -- out.pdf` segfaults (exit 139, no output file) on the pinned qpdf 12.4.2, and `--linearize` on a zero-page PDF exits 2 with `part 6 has other than exactly one object (first page dictionary)`, leaving a 0-byte output. Both replacements were run against the staged `qpdf-aarch64-apple-darwin` 12.4.2: `--empty` writes a 315-byte PDF (exit 0) and the parse+rewrite writes a 315-byte PDF (exit 0).

The ffprobe step depends on the PNG the ffmpeg step produced, so ffmpeg and ffprobe **share one work dir** and the gate runs ffmpeg first. Every other engine is self-sufficient and gets its own work dir: one broken engine cannot hide another's result.

**Expected engine paths (`expectedEnginePaths`):**

| engine | macOS (relative to `Contents/MacOS`) | Windows (relative to the install root) |
|---|---|---|
| vips | `vips` | `resources/engines/vips/vips.exe` |
| qpdf | `qpdf` | `resources/engines/qpdf/qpdf.exe` |
| gs | `gs` | `resources/engines/gs/gs.exe` |
| ffmpeg | `ffmpeg` | `ffmpeg.exe` |
| ffprobe | `ffprobe` | `ffprobe.exe` |

The macOS column comes from `bundle.externalBin` in `tauri.conf.json` (Tauri writes those under their plain names). The Windows column comes from `bundle.externalBin` in `tauri.windows.conf.json` plus the `bundle.resources["binaries/engines/"]` target and the manifest's `dest` names.

- [ ] **Step 1: Export `checkVersion` from verify.mjs with an env override**

In `scripts/binaries/verify.mjs`, change line 32 from:

```js
async function checkVersion(binPath, expectVersion, triple, root) {
  const env = { ...process.env };
  if (!isWindowsTriple(triple)) {
    env.DYLD_LIBRARY_PATH = join(root, "src-tauri", "frameworks");
  }
```

to:

```js
export async function checkVersion(binPath, expectVersion, triple, root, { env } = {}) {
  const runEnv = env ?? { ...process.env };
  if (env === undefined && !isWindowsTriple(triple)) {
    runEnv.DYLD_LIBRARY_PATH = join(root, "src-tauri", "frameworks");
  }
```

and rename the `env` in the `execFile` options to `runEnv` (`{ encoding: "utf8", timeout: 20000, env: runEnv }`). The existing caller (`verify.mjs:372`) passes four arguments, so its behavior is unchanged: default env plus the staging `DYLD_LIBRARY_PATH`. The gate passes five, with `{ env: process.env }` — inherits the ambient env, **no** `DYLD_LIBRARY_PATH` injection, so the bundled engines must load their own dylibs from the package.

- [ ] **Step 2: Write the failing vitest file**

Create `scripts/ci/package-gate.test.mjs` with these cases. Line 1 is `// @vitest-environment node`, like all 19 existing script test files — the repo default is jsdom plus the React setup files, which a pure-node script must not drag in. The `vi.mock` of `node:child_process` follows the `scripts/binaries/all.test.mjs` pattern: mock-based tests live in their own file, never inside `verify.test.mjs`, which compiles real fixtures with `clang` through the real `execFile`. The mock also lets the file pin the `checkVersion` env-override contract from Step 1:

```js
// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVersion } from "../binaries/verify.mjs";
import {
  parseGateArgs,
  expectedEnginePaths,
  expectedVersions,
  enginePlan,
  gsRunArgs,
  locateBundle,
  checkStepOutput,
} from "./package-gate.mjs";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/binaries.manifest.json"), "utf8"));
const baseConf = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const windowsConf = JSON.parse(readFileSync(join(REPO_ROOT, "src-tauri/tauri.windows.conf.json"), "utf8"));

describe("parseGateArgs", () => {
  it("rejects a missing --triple", () => {
    expect(() => parseGateArgs([])).toThrow(/--triple/);
  });
  it("rejects an unsupported triple", () => {
    expect(() => parseGateArgs(["--triple", "x86_64-unknown-linux-gnu"])).toThrow(/unsupported/i);
  });
  it("accepts a supported triple", () => {
    expect(parseGateArgs(["--triple", "aarch64-apple-darwin"]).triple).toBe("aarch64-apple-darwin");
  });
});

describe("expectedEnginePaths", () => {
  it("puts the macOS engines next to the app binary", () => {
    const exeDir = join("/app", "Contents", "MacOS");
    const paths = expectedEnginePaths({ triple: "aarch64-apple-darwin", exeDir, manifest, baseConf, windowsConf });
    expect(paths.get("vips")).toBe(join(exeDir, "vips"));
    expect(paths.get("ffmpeg")).toBe(join(exeDir, "ffmpeg"));
  });
  it("puts the Windows engines under resources/engines", () => {
    const exeDir = join("C:", "app");
    const paths = expectedEnginePaths({ triple: "x86_64-pc-windows-msvc", exeDir, manifest, baseConf, windowsConf });
    expect(paths.get("vips")).toBe(join(exeDir, "resources", "engines", "vips", "vips.exe"));
    expect(paths.get("ffmpeg")).toBe(join(exeDir, "ffmpeg.exe"));
  });
});

describe("expectedVersions", () => {
  it("reads every engine's version from the manifest for the triple", () => {
    const arm = expectedVersions({ triple: "aarch64-apple-darwin", manifest });
    const armTarget = manifest.targets["aarch64-apple-darwin"];
    for (const name of ["vips", "gs", "qpdf", "ffmpeg", "ffprobe"]) {
      expect(arm.get(name), name).toBe(armTarget[name].expectVersion);
    }
    const intel = expectedVersions({ triple: "x86_64-apple-darwin", manifest });
    const intelTarget = manifest.targets["x86_64-apple-darwin"];
    expect(intel.get("vips")).toBe(intelTarget.vips.expectVersion);
    expect(intel.get("vips")).not.toBe(arm.get("vips"));
  });
  it("throws when a triple or an engine is missing", () => {
    const missingEngine = JSON.parse(JSON.stringify(manifest));
    delete missingEngine.targets["aarch64-apple-darwin"].vips;
    expect(() =>
      expectedVersions({ triple: "aarch64-apple-darwin", manifest: missingEngine }),
    ).toThrow(/vips/);
    expect(() =>
      expectedVersions({ triple: "x86_64-unknown-linux-gnu", manifest }),
    ).toThrow(/unsupported|unknown|missing/i);
  });
});

describe("enginePlan", () => {
  it("covers all five engines", () => {
    expect([...enginePlan().keys()].sort()).toEqual(["ffmpeg", "ffprobe", "gs", "qpdf", "vips"]);
  });
  it("gives every engine a version check and at least one operation", () => {
    for (const [name, plan] of enginePlan()) {
      expect(plan.versionArgs.length, name).toBeGreaterThan(0);
      expect(plan.steps.length, name).toBeGreaterThan(0);
    }
  });
});

describe("gsRunArgs", () => {
  it("prepends the package's own gs-resources -I flags on macOS", () => {
    const exeDir = join("/app", "Contents", "MacOS");
    const tree = join(exeDir, "..", "Resources", "gs-resources");
    const args = gsRunArgs({ exeDir, triple: "aarch64-apple-darwin" });
    expect(args[0]).toBe("-I");
    expect(args[1]).toBe(join(tree, "Resource", "Init"));
    expect(args[2]).toBe("-I");
    expect(args[3]).toBe(join(tree, "lib"));
    expect(args[4]).toBe("-I");
    expect(args[5]).toBe(join(tree, "Resource", "Font"));
    expect(args[6]).toBe("-I");
    expect(args[7]).toBe(join(tree, "fonts"));
    expect(args).toContain("-sOutputFile=out.pdf");
  });
  it("passes no -I flags on Windows (ROM model)", () => {
    const args = gsRunArgs({ exeDir: join("C:", "app"), triple: "x86_64-pc-windows-msvc" });
    expect(args.some((arg) => arg.startsWith("-I"))).toBe(false);
    expect(args).toContain("-sOutputFile=out.pdf");
    expect(args).toContain("in.ps");
  });
});

describe("checkStepOutput", () => {
  it("accepts a produced file that is not empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "out.jpg"), "x");
    const result = checkStepOutput({ step: { produces: "out.jpg" }, workDir: dir, stdout: "" });
    expect(result.ok).toBe(true);
  });
  it("rejects a produced file that is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(dir, "out.pdf"), "");
    const result = checkStepOutput({ step: { produces: "out.pdf" }, workDir: dir, stdout: "" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/empty/i);
  });
  it("rejects a missing stdout expectation", () => {
    const result = checkStepOutput({ step: { expectStdout: "64,64" }, workDir: "/tmp", stdout: "1,1" });
    expect(result.ok).toBe(false);
  });
});

describe("locateBundle", () => {
  it("prefers the triple-specific bundle over a stale one", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    const stale = join(root, "src-tauri", "target", "release", "bundle", "macos");
    const fresh = join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos");
    mkdirSync(stale, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(stale, "stale.app"), "");
    writeFileSync(join(fresh, "fresh.app"), "");
    const found = locateBundle({ root, triple: "aarch64-apple-darwin" });
    expect(found.path).toBe(join(fresh, "fresh.app"));
  });
  it("returns null when the package was never built", () => {
    const root = mkdtempSync(join(tmpdir(), "gate-root-"));
    expect(locateBundle({ root, triple: "aarch64-apple-darwin" })).toBe(null);
  });
});

describe("checkVersion env override (the gate's no-staging-DYLD contract)", () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_bin, _args, _options, callback) =>
      callback(null, "vips-8.18.7\n", ""),
    );
  });

  it("passes the given env through without injecting DYLD_LIBRARY_PATH", async () => {
    const env = { PATH: "/usr/bin:/bin" };
    await checkVersion("/pkg/vips", "8.18.7", "aarch64-apple-darwin", "/repo", { env });
    const options = execFile.mock.calls[0][2];
    expect(options.env).toEqual(env);
    expect(
      options.env.DYLD_LIBRARY_PATH,
      "the gate passes { env: process.env } so the package must load its own dylibs — the staging-tree injection must never reach it",
    ).toBeUndefined();
  });

  it("injects the staging DYLD_LIBRARY_PATH when no { env } is passed", async () => {
    await checkVersion("/staging/vips", "8.18.7", "aarch64-apple-darwin", "/repo");
    const options = execFile.mock.calls[0][2];
    expect(options.env.DYLD_LIBRARY_PATH).toBe(join("/repo", "src-tauri", "frameworks"));
  });
});
```


- [ ] **Step 3: Run the vitest file to verify it fails**

Run: `yarn vitest run scripts/ci/package-gate.test.mjs`
Expected: FAIL — `Cannot find module './package-gate.mjs'`.

- [ ] **Step 4: Implement `scripts/ci/package-gate.mjs`**

The script must:

- Derive `REPO_ROOT` from `import.meta.url` (style reference: `scripts/ci/release-version-check.mjs`).
- Guard its entry point with `isMain(import.meta.url)` so the vitest file can import it without side effects.
- Implement the eight exports listed in the Interfaces block with the exact behaviours above, building every path with `join` from `node:path`.
- `locateBundle({ root, triple })` must **prefer the triple-specific build**: look first for `src-tauri/target/<triple>/release/bundle/macos/*.app` (macOS) or `src-tauri/target/<triple>/release/bundle/nsis/*.exe` (Windows). Only if that exact directory holds nothing may it fall back to a broader `src-tauri/target/**/bundle/...` search, and when it does it must print which path it chose. A stale `src-tauri/target/release/bundle/macos/*.app` from an older build must never be silently preferred over the triple's own output — the local checkout can hold both.
- `expectedVersions({ triple, manifest })` reads `manifest.targets[triple][name].expectVersion` for the five engines and throws when a triple or an engine is missing — never fall back to a hardcoded version.
- `gsRunArgs({ exeDir, triple })` returns the full gs argument list for the operation step. On macOS it prepends the package's own resource tree: `-I` pairs for `Resource/Init`, `lib`, `Resource/Font`, `fonts` (the `GS_RESOURCE_SEARCH_DIRS` order, `sidecar.rs:190`) rooted at `join(exeDir, "..", "Resources", "gs-resources")` (the `../Resources/gs-resources` bundle candidate, `sidecar.rs:214`), plus `-uICCProfilesDir=<that tree>/iccprofiles` when that directory exists — then the gs step args from `enginePlan()`. On Windows it returns `enginePlan()`'s gs step args unchanged (ROM model — `docs/ci-process.md:44`). Without the `-I` flags the brew-built gs falls back to a compiled-in prefix that does not exist on the macOS release runners, and the gs operation would red every macOS row. Same shape as `scripts/audit-sidecars.sh:589-599`.
- `checkStepOutput({ step, workDir, stdout })` returns `{ ok: false, detail: "..." }` when the step's `produces` file is missing **or is empty** (detail must contain the word "empty"), and when the step's `expectStdout` is not present in `stdout`.
- In `main`:
  1. `parseGateArgs(argv)`.
  2. `locateBundle({ root, triple })` — return `null` when nothing matches; `main` then fails with: `cannot find the built package for <triple> under src-tauri/target — this gate must run after tauri-action builds`.
  3. macOS: `exeDir = <app>/Contents/MacOS`. Windows: `extractNsisInstaller({ setupExe, destDir })` using `7z x -y <setupExe> -o<destDir>` (`7z` is in the GitHub Windows image at `C:\Program Files\7-Zip\7z.exe`); `exeDir = destDir`. When `7z` is missing, throw an error naming the expected path. On the first `windows-11-arm` release, confirm the same 7-Zip path exists on that runner image — the error names the path, so a changed image fails loudly instead of skipping.
  4. Compute `expectedEnginePaths` and, for each engine: assert the file exists → run `checkVersion(binPath, expectVersion, triple, root, { env: process.env })` (the env override keeps verify.mjs's staging `DYLD_LIBRARY_PATH` out — the package must load its own dylibs) → run each step from `enginePlan()` in a work dir per engine group — vips, qpdf and gs each get their own; ffmpeg and ffprobe share one, because ffprobe reads the PNG ffmpeg produced in that same dir (for gs, use the argument list from `gsRunArgs({ exeDir, triple })` instead of the static step args) → evaluate the step with `checkStepOutput`.
  5. Spawn `cargo test --lib resolve_for_finds_every_engine_in_a_bundled_package -- --nocapture` with `cwd = src-tauri`, `FSO_BUNDLE_EXE_DIR` set to `exeDir`, **and** `FSO_BUNDLE_GATE=1`. The check passes only when the command exits 0 **and** its output contains the `fso-bundle-resolver-ok` marker: `cargo test --lib <filter>` exits 0 when the filter matches nothing, and a skipped test also exits 0 with `1 passed`, so exit 0 alone (or a `1 passed` count) proves nothing — only the marker says the test really ran the resolver. `--nocapture` is required because libtest swallows stdout otherwise. The sentinel turns a gate that forgets `FSO_BUNDLE_EXE_DIR` into a hard failure rather than a silent skip.
  6. Print one line per check (`PASS`/`FAIL` + detail) and exit 1 if any check failed.

- [ ] **Step 5: Run the vitest file to verify it passes**

Run: `yarn vitest run scripts/ci/package-gate.test.mjs`
Expected: PASS — all cases green.

- [ ] **Step 6: Run the full test suite**

Run: `yarn test`
Expected: PASS — the existing suite stays green, plus the new `package-gate.test.mjs` cases.

- [ ] **Step 7: Run the gate end-to-end against a locally built macOS package**

Task 1 produced the package. Run:

```bash
node scripts/ci/package-gate.mjs --triple aarch64-apple-darwin
```

Expected: every check PASS — five engines found, five version matches, five real operations producing non-empty output, and the resolver test passing. The output must name each engine and its detail line.

If the gate cannot find the package, pass the path explicitly: `--bundle-dir src-tauri/target/aarch64-apple-darwin/release/bundle/macos/file-compressor.app`.

- [ ] **Step 8: Prove the gate can fail (the negative case)**

Copy the built package, delete one engine from the copy, and run the gate against it:

```bash
cp -R src-tauri/target/aarch64-apple-darwin/release/bundle/macos/file-compressor.app /tmp/gate-broken.app
rm /tmp/gate-broken.app/Contents/MacOS/vips
node scripts/ci/package-gate.mjs --triple aarch64-apple-darwin --bundle-dir /tmp/gate-broken.app
```

Expected: exit 1 with a `FAIL` line naming vips. Also break a *library* rather than a binary — re-sign `Contents/MacOS/vips` with `codesign --force --options runtime --sign -` after removing the entitlement — and confirm the gate reports the loader's own error text (`Library not loaded`) rather than "file not found". This is Review Focus item 1.

- [ ] **Step 9: Wire the gate into the release workflow**

In `.github/workflows/release.yml`, insert this step **immediately after** the `fail-closed app-asset check for this triple` step (the one ending at line 236) and before the `upload sbom + third-party notices + verify upload` step:

```yaml
      - name: package gate (engines present, startable, and usable from the built package)
        env:
          TRIPLE: ${{ matrix.triple }}
        run: node scripts/ci/package-gate.mjs --triple "$TRIPLE"
        shell: bash
```

- [ ] **Step 10: Pin the new step in `scripts/ci/workflows.test.mjs`**

That file exists to pin the release workflow's shape — the app-asset check is pinned with existence, ordering after tauri-action, no `if`, and env-passed values (`workflows.test.mjs:1105-1113`). Add one case to the same `FILENAME = "release.yml"` describe, right after the `fail-closes each row ...` case:

```js
it("runs the package gate on every row after the app-asset check", async () => {
  const { doc } = await loadWorkflow(FILENAME);
  const steps = stepsOf(jobsOf(doc).release);
  const checkIdx = steps.findIndex((s) => stepRuns(s).includes('grep -Eic -- "$pattern"'));
  const gate = steps.find((s) => stepRuns(s).startsWith("node scripts/ci/package-gate.mjs"));
  expect(gate, "the package-gate step must exist").toBeDefined();
  const gateIdx = steps.findIndex((s) => s === gate);
  expect(gateIdx, "the package gate must run after the app-asset check").toBeGreaterThan(checkIdx);
  expect(gate["if"], "the package gate must run on every matrix row").toBeUndefined();
  expect(gate.env?.TRIPLE, "the triple must reach the step via env, not raw ${{ }} in run").toBe("${{ matrix.triple }}");
  expect(gate.shell).toBe("bash");
});
```

Run: `yarn vitest run scripts/ci/workflows.test.mjs`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add scripts/ci/package-gate.mjs scripts/ci/package-gate.test.mjs scripts/binaries/verify.mjs .github/workflows/release.yml scripts/ci/workflows.test.mjs
git commit -m "feat(ci): gate the release on the built package working

The release gate checked that the draft carried assets with the right
names; nothing ever opened a package. Both the macOS signing defect and
the Windows engine-layout defect shipped through a green pipeline. The
gate now opens the built package for the row's triple, asserts every
engine sits where the app looks for it, runs every engine on a real
file, and runs the app's own resolver against the package."
```

---

## Task 5: Documentation

**Files:**
- Create: `docs/adr/0002-macos-distribution-signing.md`
- Create: `docs/distribution-acceptance.md`
- Modify: `docs/ci-process.md`, `docs/ARCHITECTURE.md` (line 268), `README.md` (lines 18-21), `docs/bugs.md`

**Interfaces:**
- Consumes: the finished behaviour of Tasks 1-4.
- Produces: no code. This task is the record that keeps the next person from re-introducing the defects.

- [ ] **Step 1: Write `docs/adr/0002-macos-distribution-signing.md`**

Follow the shape of `docs/adr/0001-sidecar-freeze-bundles.md`: title line, prose, `## Considered Options`, `## Ruling`, `## Consequences`.

Content it must carry:

- **Ruling.** We ship macOS builds ad-hoc signed (`bundle.macOS.signingIdentity = "-"`) with `com.apple.security.cs.disable-library-validation` granted through `src-tauri/Entitlements.plist`, and we do **not** notarize. There is no Apple Developer Program membership, and notarization requires one (Apple Developer Program, $99/year). Apple's notary service issues tickets only for software signed with a Developer ID certificate, which only the paid program provides.
- **Why the entitlement instead of `hardenedRuntime: false`.** Both work today. Tauri documents `hardenedRuntime: false` as "useful when using an ad-hoc signature", but Apple requires the hardened runtime for notarization, so that flag would have to be flipped back on later — a silent, expensive failure. The entitlement route keeps the hardened runtime on, so the notarization path stays open with no second code change.
- **What the defect was.** Ad-hoc signing plus the hardened runtime made macOS library validation reject the ad-hoc-signed dylibs the helpers ship with ("mapping process and mapped file have different Team IDs"), so `vips`, `qpdf` and `gs` died with `Library not loaded` in every released build.
- **The notarization path.** When a membership is added: export the Developer ID certificate as a `.p12`, base64 it into a GitHub secret, and set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` on both macOS rows of `release.yml` (or the App Store Connect API key form). Tauri then signs and notarizes automatically; no code change. The entitlement becomes unnecessary and may be deleted.
- **Consequences.** macOS installs require one command until then (see `docs/distribution-acceptance.md`); the app is not trusted by Gatekeeper; the Windows SmartScreen banner is unaffected by this ADR.

- [ ] **Step 2: Write `docs/distribution-acceptance.md`**

Content it must carry:

- **Install on macOS** (the quarantine mark is added by the browser at download time and must be removed recursively, because the helper programs inside the bundle are marked too):

  ```bash
  hdiutil attach ~/Downloads/file-compressor_<version>_aarch64.dmg
  xattr -dr com.apple.quarantine /Volumes/<volume-name>/
  cp -R /Volumes/<volume-name>/*.app /Applications/
  hdiutil detach /Volumes/<volume-name>
  ```

  Note that "Open Anyway" in System Settings → Privacy & Security is the alternative, and that on macOS 15+ it is the only route when the command is not used.

- **Install on Windows**: run the installer; when SmartScreen warns, choose "More info" → "Run anyway".

- **The matrix.** One row per platform × file type:

  | platform | PNG | MP4 | PDF | DOCX |
  |---|---|---|---|---|
  | macOS arm64 | | | | |
  | macOS x64 | | | | |
  | Windows x64 (NSIS) | | | | |
  | Windows x64 (MSI) | | | | |
  | Windows arm64 | | | | |

  Mark the MSI row and the arm64/Intel rows explicitly: the CI gate only covers the **NSIS** installer, so the MSI row and any unavailable hardware are recorded as gaps rather than assumed green.

- **What to record on failure**: the platform, the file type, the **exact error text** the app showed, and whether the helper produced any output. A screenshot of the app's error is enough if it contains the text.

- **Where the automated half lives**: `node scripts/ci/package-gate.mjs --triple <triple>` proves the engines are present, startable and usable inside the built package. The matrix above proves the UI layer, which CI cannot.

- [ ] **Step 3: Update `docs/ci-process.md`**

- In the artifact-flow diagram (§1), add a line under the release rows showing `→ package gate (open the built package, run every engine)`.
- In §2 ("Engine bundle shapes"), state that the Windows package puts the engines under `resources/engines/` (matching `GLOSSARY.md`), and that the macOS package puts them flat in `Contents/MacOS/`.
- In §3 ("Operating runbook"), add a bullet after the release step: the release rows now run the package gate; a row that fails it leaves the draft unpublished — investigate the failing engine, never publish around it.
- In §4 ("Failure classification"), add four rows:

  | Symptom | Meaning | Remedy |
  |---|---|---|
  | package gate: `FAIL <engine> — file not found` | the built package does not carry that engine where the app looks | check the bundle resource map for that platform and the engine's `dest` name in the manifest |
  | package gate: `FAIL <engine> — Library not loaded` (macOS) | the helper cannot load its dylibs | check the ad-hoc signature and the entitlements file; `codesign -dvvv` on the helper and on a bundled dylib |
  | package gate: `FAIL <engine> — expected version X, got Y` | the package carries a stale engine | re-run the freeze, then the release |
  | package gate: `7z not found` (Windows rows) | the runner image no longer ships 7-Zip at the expected path | install 7-Zip in the row or pin the path; the gate names the expected path in its error |

- [ ] **Step 4: Correct `docs/ARCHITECTURE.md`**

Line 268 currently describes the candidate list. Rewrite it to state that on Windows the engines live under `resources/engines/<engine>/` (one folder per engine, each carrying its own DLLs), that the resolver probes `resources/engines/` first and the dev checkout `../../binaries/engines/` second, that the flat `externalBin` candidates are — in order — the triple-suffixed name (dev checkout), the bare name (macOS/Linux bundles), and the stripped `<name>.exe` (Windows bundles: the bundler strips the triple suffix and keeps the `.exe`), and that on macOS the engines are flat in `Contents/MacOS/` because they are `externalBin`.

- [ ] **Step 5: Correct `README.md`**

Replace the Status block (lines 18-21). It currently claims "Windows — builds are not ready yet; PDF compression has a known Ghostscript packaging blocker (see `docs/bugs.md`)" — there is no such entry in `docs/bugs.md`, and the blocker was never Ghostscript (Windows Ghostscript is proven working by the CI audit). New text must state:

- macOS and Windows builds are produced by CI for arm64, Intel and Windows x64/arm64.
- macOS builds are ad-hoc signed and not notarized, so the install needs one command — point at `docs/distribution-acceptance.md`.
- Windows builds are unsigned, so SmartScreen shows a warning and the user clicks "More info" → "Run anyway".

Then add a short "Installing a release" section with the two install paths from `docs/distribution-acceptance.md`, and a "Verifying a release" line pointing at `node scripts/ci/package-gate.mjs --triple <triple>` and the manual matrix.

- [ ] **Step 6: Add the three defects to `docs/bugs.md`**

Add a new section after the existing dated sections, headed with the date and naming all three defects, each with: the symptom, the exact error text, the root cause, and the fix commit reference. The three: the macOS signing defect (`Library not loaded` — mapping process and mapped file have different Team IDs), the Windows engine-folder drift (`Engine error: vips not available` etc. — `engines/` shipped, `resources/engines/` probed), and the Windows externalBin-name drift (`Engine error: ffmpeg not available` — `ffmpeg.exe` shipped, triple-suffixed and bare names probed). State explicitly that all three were found by inspecting the **shipped `v0.1.0-alpha.1` artifacts** rather than a local build, and that none was caught by CI because the release gate checked asset names and never package contents.

- [ ] **Step 7: Verify the docs are consistent**

Run:

```bash
grep -rn "engines" docs/ src-tauri/src/ | grep -v "2026-10-21-distributed-build-integrity"
grep -n "shipped as" GLOSSARY.md
```

Expected: every mention of the Windows engine location says `resources/engines/` (the only `engines/` mentions without the `resources/` prefix are the dev checkout `binaries/engines/` and the staging folder); no document still claims `engines/` is the installed path, and `GLOSSARY.md` (repo root, not `docs/`) still carries the `shipped as` contract line.

- [ ] **Step 8: Commit**

```bash
git add docs/adr/0002-macos-distribution-signing.md docs/distribution-acceptance.md docs/ci-process.md docs/ARCHITECTURE.md README.md docs/bugs.md
git commit -m "docs: record the distribution-signing decision and the acceptance checklist

ADR 0002 records that macOS ships ad-hoc signed and un-notarized because
there is no Apple Developer Program membership, and exactly which secrets
turn notarization on later. The acceptance checklist gives the free
install path on both platforms and the 4-platform x 4-file-type matrix
that CI cannot cover."
```
