# Distributed Build Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the released app actually compress files on macOS and Windows, and add a CI gate that proves the built package works.

**Architecture:** Two independent defects, one per platform, plus the missing check that let both through. macOS: an entitlements file lets the ad-hoc-signed helper programs load the ad-hoc-signed dylibs they ship with. Windows: one line in the platform bundle config moves the engines into `resources/engines/`, the folder the app's resolver already probes. The new CI gate opens each built package and runs every helper on a real file.

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
2. **A helper is at the right path but the app cannot find it** (producer/consumer drift). Expected: the app's own resolver fails even though the package looks complete. → Task 2 (contract test) and Task 3 (resolver test).
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
| `scripts/ci/package-gate.test.mjs` | vitest coverage for the gate's pure logic (path derivation, operation plan, argument parsing, failure reporting). |
| `docs/adr/0002-macos-distribution-signing.md` | Why we ship macOS un-notarized, what the entitlement does, and exactly what changes when an Apple Developer Program membership is added. |
| `docs/distribution-acceptance.md` | The manual checklist: install commands per platform, the 4 platforms × 4 file types matrix, and what to record on failure. |

**Modified:**

| File | Change |
|---|---|
| `src-tauri/tauri.conf.json` | `bundle.macOS.entitlements` → `"Entitlements.plist"`. |
| `src-tauri/tauri.windows.conf.json` | `bundle.resources["binaries/engines/"]` → `"resources/engines/"`. |
| `src-tauri/src/sidecar.rs` | Two new tests in the existing `#[cfg(test)] mod tests`: the entitlements config test (Task 1) and the Windows producer/consumer contract test (Task 2). |
| `src-tauri/src/engine/processor.rs` | One new test: `resolve_for_finds_every_engine_in_a_bundled_package` (Task 3). |
| `scripts/binaries/verify.mjs` | `export` the existing `checkVersion` so the gate reuses it instead of duplicating it. |
| `.github/workflows/release.yml` | One new step per release row, after the existing `fail-closed app-asset check for this triple` step. |
| `docs/ci-process.md`, `docs/ARCHITECTURE.md`, `README.md`, `docs/bugs.md` | Documentation corrections (Task 5). |

**Untouched:** `src-tauri/src/**` production code, `scripts/binaries/**` (except the one `export`), `scripts/ci/unfreeze.sh`, `scripts/ci/freeze.sh`, `.github/workflows/ci.yml`, `.github/workflows/freeze.yml`.

---

## Task 1: macOS — let the helper programs load their libraries

**Files:**
- Create: `src-tauri/Entitlements.plist`
- Modify: `src-tauri/tauri.conf.json` (`bundle.macOS`, currently line 42-43)
- Test: `src-tauri/src/sidecar.rs` (existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `src-tauri/Entitlements.plist`, referenced by `bundle.macOS.entitlements` as the relative path `"Entitlements.plist"` (resolved against `src-tauri/`). Task 3 and Task 4 rely on the shipped `.app` actually running its helpers.

- [ ] **Step 1: Write the failing config test**

Append to the `#[cfg(test)] mod tests` block in `src-tauri/src/sidecar.rs`:

```rust
#[test]
fn tauri_conf_json_references_a_readable_macos_entitlements_file() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let conf = std::fs::read_to_string(format!("{manifest}/tauri.conf.json"))
        .expect("tauri.conf.json readable from src-tauri");
    let value: serde_json::Value = serde_json::from_str(&conf).expect("valid JSON");
    let entitlements = value["bundle"]["macOS"]["entitlements"]
        .as_str()
        .expect("bundle.macOS.entitlements must name an entitlements file");
    let path = format!("{manifest}/{entitlements}");
    let body = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("the entitlements file must exist and be readable: {path} ({error})"));
    assert!(
        body.contains("com.apple.security.cs.disable-library-validation"),
        "{path} must grant com.apple.security.cs.disable-library-validation — without it the hardened \
         runtime rejects the ad-hoc-signed dylibs the helpers ship with"
    );
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib tauri_conf_json_references_a_readable_macos_entitlements_file`
Expected: FAIL — `bundle.macOS.entitlements` is absent, so `.as_str()` returns `None` and the `expect` panics.

- [ ] **Step 3: Create the entitlements file**

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

- [ ] **Step 4: Reference it from the bundle config**

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

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib tauri_conf_json_references_a_readable_macos_entitlements_file`
Expected: PASS.

- [ ] **Step 6: Run the full Rust gate**

Run: `cd src-tauri && cargo test`
Expected: PASS — no existing test regressed.

- [ ] **Step 7: Verify the real artifact (the actual acceptance check)**

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

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Entitlements.plist src-tauri/tauri.conf.json src-tauri/src/sidecar.rs
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

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: the bundle resource target `resources/engines/` on Windows, which is the path `engine_candidates` (`src-tauri/src/sidecar.rs:68-77`) probes. Task 3's resolver test and Task 4's gate depend on this path being the real one.

- [ ] **Step 1: Write the failing producer/consumer contract test**

This test binds the two halves that drifted apart: the folder the bundler produces and the folder the app looks in.

Append to the `#[cfg(test)] mod tests` block in `src-tauri/src/sidecar.rs`:

```rust
#[test]
fn windows_engine_candidates_match_the_bundle_resource_target() {
    let manifest = env!("CARGO_MANIFEST_DIR");
    let conf = std::fs::read_to_string(format!("{manifest}/tauri.windows.conf.json"))
        .expect("tauri.windows.conf.json readable from src-tauri");
    let value: serde_json::Value = serde_json::from_str(&conf).expect("valid JSON");
    let target = value["bundle"]["resources"]["binaries/engines/"]
        .as_str()
        .expect("the windows bundle must map binaries/engines/ to a target directory");
    let exe_dir = std::path::PathBuf::from("/opt/app");
    for name in ["vips", "qpdf", "gs"] {
        let expected = exe_dir.join(target).join(name).join(format!("{name}.exe"));
        assert!(
            engine_candidates(&exe_dir, name).contains(&expected),
            "the windows bundle puts {name} at {expected:?}, so the resolver must probe that exact \
             path — the two drifted apart once and every compression category failed"
        );
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test --lib windows_engine_candidates_match_the_bundle_resource_target`
Expected: FAIL — the config maps to `engines/`, the resolver probes `resources/engines/`, so `contains(&expected)` is false for all three engines.

- [ ] **Step 3: Fix the bundle config**

In `src-tauri/tauri.windows.conf.json`, change:

```diff
     "resources": {
-      "binaries/engines/": "engines/",
+      "binaries/engines/": "resources/engines/",
       "gs-resources/": null
     }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test --lib windows_engine_candidates_match_the_bundle_resource_target`
Expected: PASS.

- [ ] **Step 5: Run the full Rust gate**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 6: Run the Windows-target compile gate**

The repo's documented pre-push gate for `src-tauri/src/` changes (`docs/ci-process.md` §3):

```bash
for b in vips qpdf gs ffmpeg ffprobe; do : > src-tauri/binaries/${b}-aarch64-pc-windows-msvc.exe; done && mkdir -p src-tauri/binaries/engines
cd src-tauri && env RC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/llvm-rc CC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/clang cargo check --all-targets --target aarch64-pc-windows-msvc; cd ..
rm -f src-tauri/binaries/*-aarch64-pc-windows-msvc.exe
```

Expected: the check succeeds. If `llvm` is not installed at that path, install it (`brew install llvm`) — the gate needs it to cross-compile the embedded Windows resource.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/tauri.windows.conf.json src-tauri/src/sidecar.rs
git commit -m "fix(windows): ship the engines into resources/engines/

The installer put the engines in <install root>/engines/ while the app
probes <install root>/resources/engines/, so vips/qpdf/gs never resolved
and every compression category failed with 'Engine error: <name> not
available'. The map target now matches the documented contract in
docs/GLOSSARY.md; no Rust change."
```

---

## Task 3: A test that the app's own resolver finds every engine in a real package

**Files:**
- Modify: `src-tauri/src/engine/processor.rs` (existing `#[cfg(test)] mod tests`, next to `resolve_for_reads_engines_from_the_engine_folder_layout` at line 377)

**Interfaces:**
- Consumes: the Windows layout `resources/engines/<name>/<name>.exe` fixed in Task 2; the macOS flat `externalBin` layout `Contents/MacOS/<name>`.
- Produces: an environment variable contract that Task 4's gate script drives — **`FSO_BUNDLE_EXE_DIR`**, the absolute path of the directory that contains the app executable. Inside a macOS `.app` that is `<app>/Contents/MacOS`; for the unpacked Windows installer it is the extraction root. When the variable is unset the test prints an explicit skip message and returns.

- [ ] **Step 1: Write the failing test**

Append to the `#[cfg(test)] mod tests` block in `src-tauri/src/engine/processor.rs`:

```rust
#[test]
fn resolve_for_finds_every_engine_in_a_bundled_package() {
    let Ok(exe_dir) = std::env::var("FSO_BUNDLE_EXE_DIR") else {
        eprintln!(
            "skipping resolve_for_finds_every_engine_in_a_bundled_package: FSO_BUNDLE_EXE_DIR is \
             not set — the package gate sets it to the built package's executable directory"
        );
        return;
    };
    let exe_dir = std::path::PathBuf::from(exe_dir);
    let paths = SidecarPaths::resolve_for(&exe_dir);
    for (name, resolved) in [
        ("vips", &paths.vips),
        ("ffmpeg", &paths.ffmpeg),
        ("ffprobe", &paths.ffprobe),
        ("gs", &paths.gs),
        ("qpdf", &paths.qpdf),
    ] {
        assert!(
            resolved.is_some(),
            "{name} did not resolve from the built package at {exe_dir:?} — the app would report \
             'Engine error: {name} not available' at compression time"
        );
    }
}
```

- [ ] **Step 2: Run the test with the variable unset**

Run: `cd src-tauri && cargo test --lib resolve_for_finds_every_engine_in_a_bundled_package -- --nocapture`
Expected: PASS with the printed skip message on stdout.

- [ ] **Step 3: Run the test against a synthetic Windows package to see it fail**

Create the layout the installer now produces, then point the test at it:

```bash
TMP="$(mktemp -d)"
mkdir -p "$TMP/resources/engines/vips" "$TMP/resources/engines/gs" "$TMP/resources/engines/qpdf"
: > "$TMP/resources/engines/vips/vips.exe"
: > "$TMP/resources/engines/gs/gs.exe"
: > "$TMP/resources/engines/qpdf/qpdf.exe"
: > "$TMP/ffmpeg.exe"
: > "$TMP/ffprobe.exe"
cd src-tauri && FSO_BUNDLE_EXE_DIR="$TMP" cargo test --lib resolve_for_finds_every_engine_in_a_bundled_package -- --nocapture
```

Expected: PASS — all five resolve.

- [ ] **Step 4: Prove the test can fail (the negative case)**

Remove one engine and re-run:

```bash
rm "$TMP/resources/engines/vips/vips.exe"
cd src-tauri && FSO_BUNDLE_EXE_DIR="$TMP" cargo test --lib resolve_for_finds_every_engine_in_a_bundled_package -- --nocapture
```

Expected: FAIL with `vips did not resolve from the built package`. A test that cannot fail is not a test — confirm the failure before continuing.

- [ ] **Step 5: Run the full Rust gate**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 6: Commit**

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
- Modify: `scripts/binaries/verify.mjs` (export `checkVersion`, line 32)
- Modify: `.github/workflows/release.yml` (new step after the `fail-closed app-asset check for this triple` step, which ends at line 236)

**Interfaces:**
- Consumes: `FSO_BUNDLE_EXE_DIR` (Task 3), `scripts/binaries.manifest.json` → `targets[triple][name].expectVersion`, `scripts/binaries/verify.mjs` → `checkVersion`, `scripts/binaries/lib.mjs` → `isMain`, `readJson`, `exists`, `parseArgs`, `run`, `isWindowsTriple`, `manifestPath`.
- Produces: `node scripts/ci/package-gate.mjs --triple <triple>` — exit 0 when every check passes, exit 1 with a per-check report otherwise.

**Exports of `scripts/ci/package-gate.mjs` (the surface the vitest file pins):**

```js
export function parseGateArgs(argv)                    // → { triple, bundleDir }; throws on a missing/unsupported --triple
export function expectedEnginePaths({ triple, exeDir, manifest, baseConf, windowsConf })  // → Map<engineName, absolutePath>
export function expectedVersions({ triple, manifest }) // → Map<engineName, expectVersion>, read from the manifest
export function enginePlan()                          // → Map<engineName, { versionArgs, fixtures, steps }>
export function locateBundle({ root, triple })        // → { kind: "app" | "nsis", path } | null
export async function extractNsisInstaller({ setupExe, destDir })  // → destDir; throws a named error when 7z is missing
export function checkStepOutput({ step, workDir, stdout })  // → { ok, detail }; rejects an empty output file
export function reportCheck(name, ok, detail)          // → { name, ok, detail }
export async function main(argv, deps)                // → exit code (0 pass, 1 fail)
```

**Path construction.** Every path is built with `node:path`'s `join`, never by string concatenation, so the same expectations hold on the macOS and Windows release rows. The vitest file below compares against `join(...)` for the same reason.

**The operation plan (`enginePlan()`), one entry per engine.** A step passes when the command exits 0 **and** (it produces no file **or** the produced file exists and is non-empty) **and** (it declares no stdout expectation **or** stdout contains it).

| engine | `versionArgs` | `fixtures` (written into the work dir first) | `steps` |
|---|---|---|---|
| vips | `["--version"]` | — | `["black","in.v","64","64"]` (no output); `["thumbnail","in.v","out.jpg","32"]` → produces `out.jpg` |
| qpdf | `["--version"]` | — | `["--empty","--pages",".","1","--","out.pdf"]` → produces `out.pdf`; `["--linearize","out.pdf","out-lin.pdf"]` → produces `out-lin.pdf` |
| gs | `["--version"]` | `in.ps` (four lines: `%!PS`, `/Helvetica findfont 16 scalefont setfont`, `72 700 moveto (gate) show`, `showpage`) | `["-q","-dNOPAUSE","-dBATCH","-sDEVICE=pdfwrite","-sOutputFile=out.pdf","in.ps"]` → produces `out.pdf` |
| ffmpeg | `["--version"]` | — | `["-y","-f","lavfi","-i","color=c=red:s=64x64:d=1","-frames:v","1","out.png"]` → produces `out.png` |
| ffprobe | `["--version"]` | — | `["-v","error","-show_entries","stream=width,height","-of","csv","out.png"]` → expects stdout containing `64,64` |

The ffprobe step depends on the PNG the ffmpeg step produced, so the gate runs ffmpeg before ffprobe. Every other engine is self-sufficient: none of them needs a fixture another engine produced, so one broken engine cannot hide another's result.

**Expected engine paths (`expectedEnginePaths`):**

| engine | macOS (relative to `Contents/MacOS`) | Windows (relative to the install root) |
|---|---|---|
| vips | `vips` | `resources/engines/vips/vips.exe` |
| qpdf | `qpdf` | `resources/engines/qpdf/qpdf.exe` |
| gs | `gs` | `resources/engines/gs/gs.exe` |
| ffmpeg | `ffmpeg` | `ffmpeg.exe` |
| ffprobe | `ffprobe` | `ffprobe.exe` |

The macOS column comes from `bundle.externalBin` in `tauri.conf.json` (Tauri writes those under their plain names). The Windows column comes from `bundle.externalBin` in `tauri.windows.conf.json` plus the `bundle.resources["binaries/engines/"]` target and the manifest's `dest` names.

- [ ] **Step 1: Export `checkVersion` from verify.mjs**

In `scripts/binaries/verify.mjs`, change line 32 from:

```js
async function checkVersion(binPath, expectVersion, triple, root) {
```

to:

```js
export async function checkVersion(binPath, expectVersion, triple, root) {
```

- [ ] **Step 2: Write the failing vitest file**

Create `scripts/ci/package-gate.test.mjs` with these cases (vitest globals are enabled — `globals: true` in `vitest.config.ts`):

```js
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseGateArgs,
  expectedEnginePaths,
  expectedVersions,
  enginePlan,
  locateBundle,
  checkStepOutput,
  reportCheck,
} from "./package-gate.mjs";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/binaries/manifest.json"), "utf8"));
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
  it("reads the versions from the manifest, per triple", () => {
    const arm = expectedVersions({ triple: "aarch64-apple-darwin", manifest });
    const intel = expectedVersions({ triple: "x86_64-apple-darwin", manifest });
    expect(arm.get("vips")).toBe("8.18.7");
    expect(intel.get("vips")).toBe("8.18.6");
    expect(arm.get("qpdf")).toBe("12.4.2");
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

describe("reportCheck", () => {
  it("keeps the failing detail", () => {
    expect(reportCheck("vips", false, "Library not loaded")).toEqual({ name: "vips", ok: false, detail: "Library not loaded" });
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
- `checkStepOutput({ step, workDir, stdout })` returns `{ ok: false, detail: "..." }` when the step's `produces` file is missing **or is empty** (detail must contain the word "empty"), and when the step's `expectStdout` is not present in `stdout`.
- In `main`:
  1. `parseGateArgs(argv)`.
  2. `locateBundle({ root, triple })` — return `null` when nothing matches; `main` then fails with: `cannot find the built package for <triple> under src-tauri/target — this gate must run after tauri-action builds`.
  3. macOS: `exeDir = <app>/Contents/MacOS`. Windows: `extractNsisInstaller({ setupExe, destDir })` using `7z x -y <setupExe> -o<destDir>` (`7z` is in the GitHub Windows image at `C:\Program Files\7-Zip\7z.exe`); `exeDir = destDir`. When `7z` is missing, throw an error naming the expected path.
  4. Compute `expectedEnginePaths` and, for each engine: assert the file exists → run `checkVersion(binPath, expectVersion, triple, root)` → run each step from `enginePlan()` in a per-engine work dir → evaluate the step with `checkStepOutput`.
  5. Spawn `cargo test --lib resolve_for_finds_every_engine_in_a_bundled_package` with `cwd = src-tauri` and `FSO_BUNDLE_EXE_DIR` set to `exeDir`; the check passes only when the command exits 0.
  6. Print one line per check (`PASS`/`FAIL` + detail) and exit 1 if any check failed.

- [ ] **Step 5: Run the vitest file to verify it passes**

Run: `yarn vitest run scripts/ci/package-gate.test.mjs`
Expected: PASS — all cases green.

- [ ] **Step 6: Run the full test suite**

Run: `yarn test`
Expected: PASS — the existing 43 files / ~991 tests stay green.

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

- [ ] **Step 10: Commit**

```bash
git add scripts/ci/package-gate.mjs scripts/ci/package-gate.test.mjs scripts/binaries/verify.mjs .github/workflows/release.yml
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
- In §2 ("Engine bundle shapes"), state that the Windows package puts the engines under `resources/engines/` (matching `docs/GLOSSARY.md`), and that the macOS package puts them flat in `Contents/MacOS/`.
- In §3 ("Operating runbook"), add a bullet after the release step: the release rows now run the package gate; a row that fails it leaves the draft unpublished — investigate the failing engine, never publish around it.
- In §4 ("Failure classification"), add three rows:

  | Symptom | Meaning | Remedy |
  |---|---|---|
  | package gate: `FAIL <engine> — file not found` | the built package does not carry that engine where the app looks | check the bundle resource map for that platform and the engine's `dest` name in the manifest |
  | package gate: `FAIL <engine> — Library not loaded` (macOS) | the helper cannot load its dylibs | check the ad-hoc signature and the entitlements file; `codesign -dvvv` on the helper and on a bundled dylib |
  | package gate: `FAIL <engine> — expected version X, got Y` | the package carries a stale engine | re-run the freeze, then the release |

- [ ] **Step 4: Correct `docs/ARCHITECTURE.md`**

Line 268 currently describes the candidate list. Rewrite it to state that on Windows the engines live under `resources/engines/<engine>/` (one folder per engine, each carrying its own DLLs), that the resolver probes `resources/engines/` first and the dev checkout `../../binaries/engines/` second, and that on macOS the engines are flat in `Contents/MacOS/` because they are `externalBin`.

- [ ] **Step 5: Correct `README.md`**

Replace the Status block (lines 18-21). It currently claims "Windows — builds are not ready yet; PDF compression has a known Ghostscript packaging blocker (see `docs/bugs.md`)" — there is no such entry in `docs/bugs.md`, and the blocker was never Ghostscript (Windows Ghostscript is proven working by the CI audit). New text must state:

- macOS and Windows builds are produced by CI for arm64, Intel and Windows x64/arm64.
- macOS builds are ad-hoc signed and not notarized, so the install needs one command — point at `docs/distribution-acceptance.md`.
- Windows builds are unsigned, so SmartScreen shows a warning and the user clicks "More info" → "Run anyway".

Then add a short "Installing a release" section with the two install paths from `docs/distribution-acceptance.md`, and a "Verifying a release" line pointing at `node scripts/ci/package-gate.mjs --triple <triple>` and the manual matrix.

- [ ] **Step 6: Add the two defects to `docs/bugs.md`**

Add a new section after the existing dated sections, headed with the date and naming both defects, each with: the symptom, the exact error text, the root cause, and the fix commit reference. State explicitly that both were found by inspecting the **shipped `v0.1.0-alpha.1` artifacts** rather than a local build, and that neither was caught by CI because the release gate checked asset names and never package contents.

- [ ] **Step 7: Verify the docs are consistent**

Run:

```bash
grep -rn "resources/engines\|resources\\\\engines" docs/ src-tauri/src/ | grep -v "2026-10-21-distributed-build-integrity"
grep -rn "shipped as" docs/GLOSSARY.md
```

Expected: every mention of the Windows engine location says `resources/engines/`; no document still claims `engines/` is the installed path.

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
