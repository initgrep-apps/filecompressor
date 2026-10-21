# Distributed Build Integrity — macOS signing, Windows engine layout, and a package-content gate

**Date:** 2026-10-21
**Status:** Design agreed in conversation (macOS fix = entitlement route; gate lives in the release workflow only). Written spec awaiting review.
**Scope:** `.github/workflows/release.yml`, `src-tauri/tauri.conf.json`, `src-tauri/tauri.windows.conf.json`, `src-tauri/Entitlements.plist` (new), `src-tauri/src/engine/processor.rs` (tests only), `src-tauri/src/sidecar.rs` (tests + one candidate line), `scripts/ci/package-gate.mjs` (new), `scripts/binaries/verify.mjs` (export + env override), `docs/adr/0002-macos-distribution-signing.md` (new), `docs/distribution-acceptance.md` (new), plus doc corrections.
**Method:** downloaded the shipped `v0.1.0-alpha.1` artifacts (`file-compressor_0.1.0_aarch64.app.tar.gz`, `file-compressor_0.1.0_x64-setup.exe`), unpacked them, read their code signatures with `codesign`, ran the bundled engines directly, and read Tauri 2.12's bundler source (`tauri-utils` `ResourcePaths`, `tauri-bundler` NSIS/MSI templates, `tauri-utils` `resource_dir`) to establish the layout the bundler actually produces.

---

## 1. Summary

Four defects, all reproduced against the **shipped release**, not a local build:

| # | Platform | What breaks | Root cause | Fix |
|---|---|---|---|---|
| 1 | macOS | `vips`, `qpdf`, `gs` die on startup with `Library not loaded`; every compression category fails | ad-hoc signature + Tauri's default hardened runtime ⇒ macOS library validation rejects the ad-hoc dylibs | Part 1 — an entitlements file |
| 2 | Windows | `vips`, `qpdf`, `gs` are never found ⇒ image/PDF/document categories fail | the installer ships `engines/…`; the app looks in `resources/engines/…` | Part 2a — one config line |
| 3 | Windows | `ffmpeg`, `ffprobe` are never found ⇒ video fails too | the bundler strips the target-triple suffix (`ffmpeg.exe`), the resolver probes only the triple-suffixed and bare names | Part 2b — one candidate line |
| 4 | both | the release pipeline never checks package **contents**, only asset **names** | no package-content step exists | Part 3 — a new gate |

**Net effect: the distributed build is broken on both platforms.** On Windows every compression category fails, from two independent defects (engine-folder placement and externalBin naming) that hid each other; on macOS signing kills three of five engines. All three share the same blind spot — nothing in CI ever opened a built package and checked what was inside.

The user-visible symptom is the same on both platforms: *the app installs (Windows) or is blocked by Gatekeeper (macOS), and then compression fails because a helper program cannot be found or cannot start.*

---

## 2. Evidence

### 2.1 macOS — the shipped helper programs cannot start

`v0.1.0-alpha.1` ships `file-compressor_0.1.0_aarch64.app.tar.gz`. Unpacked, the signatures are:

```
$ codesign -dvvv file-compressor.app/Contents/MacOS/file-compressor
CodeDirectory v=20500 flags=0x10002(adhoc,runtime)      ← ad-hoc + HARDENED RUNTIME

$ codesign -dvvv file-compressor.app/Contents/Frameworks/libvips.42.dylib
CodeDirectory v=20400 flags=0x2(adhoc)                   ← ad-hoc, no runtime, no Team ID
```

`src-tauri/tauri.conf.json:43` sets `"signingIdentity": "-"` (ad-hoc), and `tauri-utils` defaults `MacConfig::hardened_runtime` to `true` (`tauri-utils-2.10.0/src/config.rs:685`). Tauri therefore signs the sidecars **as executables with `--options runtime`** while the 71 bundled dylibs are signed **without** it. Under the hardened runtime, macOS requires every loaded library to carry the same Team ID as the loading process; an ad-hoc signature has **no Team ID**, so the check fails.

Running the shipped helpers directly:

```
$ file-compressor.app/Contents/MacOS/vips --version
dyld[4195]: Library not loaded: @rpath/libvips.42.dylib
  Reason: tried: '.../Contents/Frameworks/libvips.42.dylib' (code signature in <DF46FA57-…>
  '.../Contents/Frameworks/libvips.42.dylib' not valid for use in process: mapping process and
  mapped file (non-platform) have different Team IDs)
```

Same for `qpdf` (`@rpath/libqpdf.30.dylib`) and `gs` (`@rpath/libjbig2dec.0.dylib`). `ffmpeg` and `ffprobe` are statically linked and start fine — which is why the failure looks per-category rather than total.

**Verified fix.** Re-signing the same shipped bundle without the hardened-runtime flag makes every helper start:

| helper | shipped artifact | after re-signing without hardened runtime |
|---|---|---|
| `vips` | `Library not loaded` | `vips-8.18.7` |
| `qpdf` | `Library not loaded` | `qpdf version 12.4.2` |
| `gs` | `Library not loaded` | `gs 10.08.0` |
| `ffmpeg` | works | works |

The same result is reachable by keeping the hardened runtime and granting `com.apple.security.cs.disable-library-validation` — verified on the real artifact:

```
$ codesign --force --options runtime --entitlements ent.plist --sign - Contents/MacOS/vips
$ Contents/MacOS/vips --version
vips-8.18.7
```

**Why the local build hid this.** The `.app` in `src-tauri/target/release/bundle/macos/` is dated 2026-10-08. The ad-hoc signing config landed 2026-10-17 (commit `64e19df`). The local artifact was never code-signed (`flags=0x20002(adhoc,linker-signed)` — signed by the linker, not by `codesign`), so it never entered hardened runtime and never hit the check. `README.md:18` ("macOS (Apple Silicon) — verified end-to-end") is therefore true of the **local** build and false of the **released** one.

### 2.2 Windows — the shipped helper programs are in a folder the app never looks in

Unpacking the shipped NSIS installer (`7z x file-compressor_0.1.0_x64-setup.exe`) gives exactly this payload:

```
$PLUGINSDIR/
engines/gs/gs.exe          (+28 DLLs)
engines/qpdf/qpdf.exe      (+9 DLLs)
engines/vips/vips.exe      (+61 DLLs)
ffmpeg.exe
ffprobe.exe
file-compressor.exe
```

**There is no `resources/` directory.** But the app's resolver (`src-tauri/src/sidecar.rs:68-77`) probes only:

```rust
exe_dir.join("resources").join("engines").join(name).join(&file)   // ← never produced
exe_dir.join("../../binaries/engines").join(name).join(&file)       // ← dev checkout only
```

So `vips`, `qpdf` and `gs` resolve to `None`, and those processors fail with `Engine error: vips not available` / `gs not available` / `qpdf not available`.

**`ffmpeg`/`ffprobe` do not resolve either.** The bundler strips the target-triple suffix when it copies an `externalBin` sidecar (`tauri-bundler` `copy_binaries`: the destination name is the source name with `-{target_triple}` removed), so the installer carries plain `ffmpeg.exe`/`ffprobe.exe`. The resolver's flat candidates (`sidecar.rs:137-144`) are the triple-suffixed name and the bare name:

```rust
candidates.push(exe_dir.join(&filename));   // ffmpeg-x86_64-pc-windows-msvc.exe — never produced
candidates.push(exe_dir.join(name));        // ffmpeg — no .exe suffix, never matches on Windows
```

Neither candidate names `ffmpeg.exe`, and Windows file APIs do no extension guessing, so `ffmpeg`/`ffprobe` resolve to `None` and video fails with `Engine error: ffmpeg not available`. **Every compression category fails on the shipped Windows build** — the "video works" conclusion would only hold if the resolver probed the stripped name, which it does not.

Why the config produces `engines/` and not `resources/engines/`: `src-tauri/tauri.windows.conf.json:8` maps `"binaries/engines/"` → `"engines/"`. Tauri v2's map-notation semantics (`tauri-utils-2.10.0/src/resources.rs`, `ResourcePaths::resource_from_path`) resolve a directory source to `dest.join(path.strip_prefix(pattern))` ⇒ target `engines/vips/vips.exe`. The NSIS template then writes `File /a "/oname=<target>"` under `$INSTDIR`, and the MSI template writes a `<ComponentRef>` under `DirectoryRef Id="INSTALLDIR"`. Tauri's own `resource_dir` on Windows is "the directory that contains the main executable", so the relative target is preserved verbatim on both installers.

`GLOSSARY.md:36` already states the intended contract — *"shipped as `resources/engines/` on Windows"* — and `docs/superpowers/plans/2026-10-02-sidecar-binaries-release.md:398` specifies the same. **The config drifted from the documented contract; the code and the docs were right.** That is why the fix is to restore the config rather than to add a third candidate path.

### 2.3 The pipeline checks names, never contents

`release.yml` verifies that the draft release carries assets whose *names* match a pattern (`:206-236`) and that the eight sidecar bundles exist (`:49-82`). Nothing opens a built package. All three defects above sailed through a fully green pipeline.

### 2.4 What is verified **not** broken — do not chase these

- **Ghostscript on Windows.** The repo's own audit renders a real font-using PDF with `gs.exe` on the Windows CI row (`scripts/audit-sidecars.sh`, ROM-mode smoke, no `-I` flags) and that row is green. `libgs-10.dll` carries the compiled-in resource tree (`%rom%Resource/Init/` is present in the binary). The "ROM model" claim in `docs/ci-process.md:44` and ADR 0001 holds. **Windows PDF will work once Part 2a lands.**
- **The Windows DLL closures.** qpdf ships its own VC runtime (`msvcp140.dll`, `vcruntime140.dll`, …); vips ships 61 DLLs; gs ships 28. The DLLs sit beside their exe, and Windows searches the exe's own directory first — plus `prepend_engine_dir_to_path` (`sidecar.rs:122-135`) puts that directory at the front of the child's `PATH`.
- **The freeze/unfreeze pipeline.** Unchanged by this spec.
- **macOS engine path resolution.** The shipped `.app` holds `Contents/MacOS/{vips,gs,qpdf,ffmpeg,ffprobe}` under their plain names, which `sidecar_candidates` (`sidecar.rs:137-144`) finds on its second candidate. macOS is broken by *signing*, not by *placement*.
- **The updater.** There is no `plugins.updater` configuration and no `createUpdaterArtifacts`, so no updater signing keys are involved.

---

## 3. Design

### Part 1 — macOS: let the helper programs load their libraries

**Decision: the entitlement route.** Add `src-tauri/Entitlements.plist` containing `com.apple.security.cs.disable-library-validation` and reference it from `src-tauri/tauri.conf.json`:

```json
"macOS": {
  "signingIdentity": "-",
  "entitlements": "Entitlements.plist"
}
```

Tauri applies the entitlements to every signed target (main executable, sidecars, frameworks) and keeps the hardened-runtime flag, so the notarization path stays open with no second code change (§6).

**Why not `hardenedRuntime: false`.** Tauri documents that flag as "useful when using an ad-hoc signature, making it less strict" (`tauri-bundler` `MacConfig::hardened_runtime`), so it is the simpler alternative and would work today. It was not chosen because it must be flipped back on before notarization — Apple requires the hardened runtime for notarization — and a forgotten flag is a silent, expensive failure later. The entitlement route has no such cliff. The alternative is recorded in ADR 0002.

**Verified:** signing a dylib with an entitlements plist is accepted (`codesign` succeeds, signature stays `flags=0x2(adhoc)`), and a hardened-runtime executable carrying the entitlement loads an ad-hoc dylib successfully.

**Acceptance:** after this change, `vips --version`, `qpdf --version` and `gs --version` run from inside the built `.app` and print the manifest's `expectVersion`.

### Part 2a — Windows: ship the engines where the app already looks

One line in `src-tauri/tauri.windows.conf.json`:

```diff
     "resources": {
-      "binaries/engines/": "engines/",
+      "binaries/engines/": "resources/engines/",
       "gs-resources/": null
     }
```

**No Rust change.** `sidecar.rs:74` already probes `exe_dir/resources/engines/<name>/<name>.exe`, which becomes the real installed path. `GLOSSARY.md:36` becomes correct as written. The dev-checkout candidate (`../../binaries/engines/…`) is untouched and still serves `yarn tauri dev` and `cargo test`.

**No dead code, no fallback.** The third candidate path that was considered during design (keeping `resources/engines/` *and* adding `engines/`) is rejected: it would leave a second, never-produced path in the resolver and let a future layout change slip through unnoticed. One producer, one consumer, one documented contract.

**Both architectures.** The engine folder names (`vips`, `gs`, `qpdf`) come from the manifest `dest` field and are identical for `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`; the same bundler config produces both. Each release row builds natively on its own runner, so each is verified on its own architecture.

### Part 2b — Windows: let the app find ffmpeg/ffprobe beside the exe

The bundler names the shipped sidecars `ffmpeg.exe`/`ffprobe.exe` (§2.2), so `sidecar_candidates` (`sidecar.rs:137-144`) gains the stripped name as a third candidate:

```rust
candidates.push(exe_dir.join(&filename));             // dev checkout: binaries/<name>-<triple>.exe
candidates.push(exe_dir.join(name));                  // macOS/Linux bundles: plain name
candidates.push(exe_dir.join(format!("{name}.exe")));  // Windows bundles: triple suffix stripped, .exe kept
```

The new candidate is produced only by the Windows bundler, but the function stays a pure, host-independent list — exactly the shape `engine_candidates` already has (`resources/engines/…` is probed on every host even though only Windows bundles produce it), so the Windows shape stays unit-testable on any machine. Resolution order for the paths that already hit is unchanged (triple-suffixed first, bare name second), and on macOS/Linux the `.exe` probe is one extra metadata call that never matches.

**Acceptance (Parts 2a+2b):** the Windows package contains `resources/engines/<name>/<name>.exe` with its DLLs plus `ffmpeg.exe`/`ffprobe.exe` beside the app, and `SidecarPaths::resolve_for` resolves **all five** engines against the real package.

### Part 3 — a package-content gate in the release workflow

**Placement: `release.yml` only.** The PR gate stays fast; the defect class only exists in built packages. The gate runs **inside each release row, immediately after the existing `fail-closed app-asset check` step** — the same shape as that step (a check that fails the row after `tauri-action` has populated the draft). The release stays a draft, the operator does not publish, and the workflow goes red.

**New script `scripts/ci/package-gate.mjs`** (node, matching the existing `scripts/ci/*.mjs` convention; `setup-node` is already in every release row). It takes `--triple <triple>` and:

1. **Locates the built package** under `src-tauri/target/**/bundle/` (glob, not a hardcoded path, so a tauri-action change to the target directory is a loud failure rather than a silent skip).
   - macOS → `file-compressor.app`; the *executable directory* is `Contents/MacOS`.
   - Windows → `nsis/*-setup.exe`, extracted with the 7-Zip that ships on the GitHub Windows runner image; the executable directory is the extraction root.
2. **Asserts the five engines exist** at the paths the app resolves:

   | engine | macOS (relative to `Contents/MacOS`) | Windows (relative to the install root) |
   |---|---|---|
   | vips | `vips` | `resources/engines/vips/vips.exe` |
   | qpdf | `qpdf` | `resources/engines/qpdf/qpdf.exe` |
   | gs | `gs` | `resources/engines/gs/gs.exe` |
   | ffmpeg | `ffmpeg` | `ffmpeg.exe` |
   | ffprobe | `ffprobe` | `ffprobe.exe` |

   The macOS column is the flat `externalBin` layout (`sidecar_candidates`, `sidecar.rs:137-144`); the Windows `resources/engines/…` column is the `engine_candidates` layout after Part 2a (`sidecar.rs:68-77`) and the Windows `ffmpeg.exe`/`ffprobe.exe` column is the `sidecar_candidates` stripped-name candidate added in Part 2b. These are the lists the Rust resolver test in step 5 exercises, so the table and the code cannot drift apart silently.
3. **Runs each engine and checks its version** against `scripts/binaries.manifest.json` → `targets[triple][name].expectVersion` — the same single source of truth `scripts/binaries/verify.mjs` already uses (`checkVersion`, `verify.mjs:32-65`). Expected values: vips `8.18.7` (arm) / `8.18.6` (Intel), qpdf `12.4.2`, gs `10.08.0` (arm) / `10.07.1` (Intel), ffmpeg/ffprobe `9.0.2`. The gate calls `checkVersion` with an explicit `{ env: process.env }` override: the shared helper injects `DYLD_LIBRARY_PATH=src-tauri/frameworks` for staging-tree runs (`verify.mjs:33-36`), and the gate must never inherit it — its whole point is to prove the package loads its **own** dylibs.
4. **Runs one real operation per engine** and asserts a non-empty output file. vips, qpdf and gs each run in their own work dir; ffmpeg and ffprobe share one (ffprobe reads the PNG ffmpeg produced), so one broken engine cannot hide another's result:

   | engine | fixture | operation | expected |
   |---|---|---|---|
   | vips | `vips black in.v 64 64` | `vips thumbnail in.v out.jpg 32` | `out.jpg` non-empty |
   | qpdf | `qpdf --empty out.pdf` | `qpdf out.pdf out-rewritten.pdf` | `out-rewritten.pdf` non-empty |
   | gs | a 4-line inline PostScript fixture | `gs` with the package's own `-I` flags on macOS (below), `-q -dNOPAUSE -dBATCH -sDEVICE=pdfwrite -sOutputFile=out.pdf in.ps` | `out.pdf` non-empty |
   | ffmpeg | `ffmpeg -f lavfi -i color=c=red:s=64x64:d=1 -frames:v 1 out.png` | — | `out.png` non-empty |
   | ffprobe | the same PNG | `ffprobe -v error -show_entries stream=width,height -of csv out.png` | prints `64,64` |

   This is the **compression step itself**, at the engine level — not "does the app open". It is exactly what failed on macOS (`vips --version` dies with `Library not loaded`) and exactly what fails on Windows (`vips.exe` is not where the app looks).

   **gs resources on macOS.** The brew-built gs resolves init files and fonts from a compiled-in prefix that does not exist on the release runner. The gate therefore mirrors the app: on macOS rows the gs step prepends `-I` flags pointing into the package's own tree — `Contents/Resources/gs-resources/{Resource/Init,lib,Resource/Font,fonts}` (`GS_RESOURCE_SEARCH_DIRS`, `sidecar.rs:190`; the `../Resources/gs-resources` bundle candidate, `sidecar.rs:214`) — plus `-uICCProfilesDir` when the tree carries `iccprofiles/`. This is the same shape `scripts/audit-sidecars.sh:589-599` uses for the staged-tree smoke. Windows rows pass no `-I` flags (ROM model, `docs/ci-process.md:44`).
5. **Runs the app's own resolver against the real package.** A new Rust test in `src-tauri/src/engine/processor.rs` (next to the existing `resolve_for_reads_engines_from_the_engine_folder_layout` test) reads `FSO_BUNDLE_EXE_DIR` (the directory containing the app executable) and asserts that `SidecarPaths::resolve_for` resolves **all five** engines from it. The script sets that variable and runs `cargo test --lib <that test>`. The test skips with an explicit printed message when the variable is unset, so the ordinary `cargo test` run is unaffected.
6. **Reports per check** and exits non-zero listing exactly which checks failed.

**Why the resolver test matters.** Steps 2-4 assert what the package contains and whether the engines work. Step 5 asserts the app can *find* them. Without it, a package that contains the engines in the wrong place or under the wrong names would pass steps 2-4 and still ship a broken app — which is precisely defects #2 and #3.

**What the gate does not cover** — the UI layer: drag & drop, progress, the output folder, history, error messaging. That layer needs the real app and stays a manual checklist (Part 4).

### Part 4 — documentation

| File | Change |
|---|---|
| `docs/adr/0002-macos-distribution-signing.md` (new) | Records: we ship macOS without Apple's notarization because there is no Apple Developer Program membership; the entitlement route and why; the exact steps to switch to notarization (§6); the alternative considered. |
| `docs/distribution-acceptance.md` (new) | The manual checklist: install commands per platform (macOS quarantine removal, Windows), the 4 platforms × 4 file types matrix, and what to record when something fails (the **exact error text**). |
| `docs/ci-process.md` | Artifact-flow diagram gains the package gate; §3 runbook gains the gate step and the notarization bullet; §4 failure-classification table gains rows for "helper missing / misplaced / unloadable". |
| `docs/ARCHITECTURE.md:268` | Corrects the described candidate list to the post-fix reality. |
| `docs/GLOSSARY.md:36` | Verified already correct — no change needed. |
| `README.md:18-21` | The Status block is wrong today ("Windows — builds are not ready yet; PDF compression has a known Ghostscript packaging blocker (see `docs/bugs.md`)") — there is no such entry in `docs/bugs.md`. Rewrite the status, and add the install section (macOS quarantine removal, Windows). |
| `docs/bugs.md` | Add the two defects with their evidence, so the history records that they were found by inspecting a shipped release. |

---

## 4. Acceptance criteria

**Automated (CI, all four release rows):**

1. `yarn build && yarn test && cd src-tauri && cargo test` passes.
2. The package gate passes on every row: all five engines present at the resolved paths, all five report the manifest `expectVersion`, all five complete a real operation, and `SidecarPaths::resolve_for` resolves all five against the built package.
3. The gate **fails** when it should — proven by a negative test: temporarily point the gate at a package with one engine removed (or a helper whose dylib is missing) and confirm it goes red. A gate that cannot fail is not a gate.

**Manual (real machines, `docs/distribution-acceptance.md`):**

4. macOS arm64 (the maintainer's machine): the released `.dmg` installs after the documented quarantine removal, the app opens, and a PNG, an MP4, a PDF and a DOCX each compress to an output file.
5. Windows x64: the released installer installs, and the same four file types compress.
6. At least one macOS Intel and one Windows arm64 machine, if available. **If not available, that gap is recorded in the checklist rather than silently assumed green.**

---

## 5. Risks and non-goals

**Non-goals (explicitly out of scope):**

- **Notarization.** Requires the $99/yr Apple Developer Program. Not purchased; §6 records the path.
- **Windows Authenticode.** The SmartScreen banner stays. Fixing it needs an OV certificate (~$200-500/yr) and reputation that builds over time. Users can still install via "More info → Run anyway", and the macOS fix is the higher-value one.
- **The macOS installer UX.** Until notarization exists, macOS installs require one documented command (§6). Shipping a `.dmg` with an `Install.command` helper was considered and rejected: the helper script itself lands in the quarantined download and hits the same Gatekeeper wall, so it buys nothing over the documented command.
- **Homebrew as a distribution channel.** Homebrew 5.0 deprecates casks that are not codesigned and notarized (removal by September 2026), so a cask is not a free bypass.
- **The updater.** No updater is configured; none is added.

**Risks:**

| Risk | Severity | Mitigation |
|---|---|---|
| `disable-library-validation` is a mild security relaxation on the main executable (it permits loading unsigned libraries into the app) | Low | the app loads no pluggable code and no libraries beyond the 71 it ships and Apple's system frameworks; recorded in ADR 0002 |
| The gate reads the local build output, so a change to tauri-action's target directory would break it | Low | the script globs for the bundle rather than hardcoding it, and fails loudly when it cannot find it |
| 7-Zip availability on the Windows runner image | Low | 7-Zip ships in the GitHub-hosted Windows images; the step fails loudly if it is missing rather than skipping |
| The MSI is not covered by the gate (only the NSIS installer is cheaply extractable) | Medium | the MSI is produced from the same `bundle.resources` map and lands the same relative layout; the manual checklist covers an MSI install explicitly |
| The gate adds ~2-5 minutes per release row | Low | the release rows already have a 90-minute budget with a 40-minute build |

---

## 6. The notarization path (for later — no code change)

When the Apple Developer Program membership is added:

1. Apple issues a **Developer ID Application** certificate and a Team ID.
2. Export the certificate as a `.p12`, base64 it, store it as a GitHub secret.
3. Add to both macOS rows of `release.yml`: `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, plus `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID` — or the App Store Connect API key form (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).
4. Tauri then signs with the real certificate and submits the app to Apple's notary automatically. **No code change.** The hardened-runtime flag stays on and the entitlement becomes unnecessary (every dylib would then carry the same Team ID) and may be deleted.

The macOS rows then also stop needing the `xattr` install step, and `README.md` can say "double-click to install".

---

## 7. Sequencing

Four independently verifiable changes. Each lands with its own commit and its own verification.

| # | Change | Verify by |
|---|---|---|
| 1 | Part 1 — `Entitlements.plist` + `tauri.conf.json` | a local `yarn tauri build --target aarch64-apple-darwin`, then `Contents/MacOS/vips --version` prints `vips-8.18.7`; `codesign -d --entitlements -` shows the entitlement on the sidecars |
| 2 | Part 2a — `tauri.windows.conf.json` | a local Windows package inspection (the NSIS payload must contain `resources/engines/<name>/<name>.exe`); the release row's package gate confirms it end-to-end once Part 3 lands |
| 3 | Part 2b — the `ffmpeg.exe`/`ffprobe.exe` candidate in `sidecar_candidates` | the unit test pins the candidate list; the release row's resolver test confirms it against the real package once Part 3 lands |
| 4 | Part 3 — `scripts/ci/package-gate.mjs` + the Rust resolver test + `release.yml` wiring | a local run against a locally built package; then a release run with all four rows green |
| 5 | Part 4 — ADR, acceptance doc, and the doc corrections | review |

Part 3 depends on Parts 1 and 2 being in place to go green — the gate is what proves them. Part 4 lands last so it describes the final state.

---

## 8. Files touched

**New:**
- `src-tauri/Entitlements.plist`
- `scripts/ci/package-gate.mjs`
- `docs/adr/0002-macos-distribution-signing.md`
- `docs/distribution-acceptance.md`

**Modified:**
- `src-tauri/tauri.conf.json` — add `bundle.macOS.entitlements`
- `src-tauri/tauri.windows.conf.json` — one line (§3.2a)
- `src-tauri/src/sidecar.rs` — one candidate line in `sidecar_candidates` plus tests (§3.2b)
- `src-tauri/src/engine/processor.rs` — one new test, no production change
- `scripts/binaries/verify.mjs` — `export` `checkVersion` + an optional `{ env }` override
- `.github/workflows/release.yml` — one new step per row
- `docs/ci-process.md`, `docs/ARCHITECTURE.md`, `README.md`, `docs/bugs.md`

**Not modified:** `src-tauri/src/**` production code beyond the one `sidecar_candidates` line, `scripts/binaries/**` beyond the `checkVersion` export + env override and the one pinned merged-map value in `verify.test.mjs`, `scripts/ci/unfreeze.sh`, `scripts/ci/freeze.sh`, `.github/workflows/ci.yml`, `.github/workflows/freeze.yml`. `scripts/ci/workflows.test.mjs` gains one case pinning the new release step. The freeze/unfreeze model and the PR gate stay exactly as they are.
