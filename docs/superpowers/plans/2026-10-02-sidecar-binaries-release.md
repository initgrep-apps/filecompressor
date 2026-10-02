# Sidecar Binaries Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A yarn-driven, vendor-hosted, checksum-verified binary pipeline that builds correct self-contained engines for macOS (arm64 + Intel) and Windows (x64 + arm64), with an audit that can never again ship a wrong-architecture binary.

**Architecture:** `scripts/binaries.manifest.json` (intent: source + pin per binary/target) drives `fetch` (download → sha256 verify → stage → lock), per-OS `prep` (macOS dylib repackaging + gs resource staging; Windows engine folders + DLL layout), and `verify` (arch-vs-name, version-vs-lock, gs resources). `yarn binaries:all --target <triple>` runs all three; the existing `audit-sidecars.sh` gains the arch gate by delegating to `verify.mjs`. `yarn app:build --target <triple>` runs binaries:all then `tauri build --target`.

**Tech Stack:** Node ESM scripts (yarn orchestration), bash (existing macOS scripts, audit), Rust (Tauri sidecar resolution + gs flags), Vitest (node-environment unit tests), GitHub APIs/vendor URLs at fixed versions.

**Spec:** `docs/superpowers/specs/2026-10-02-sidecar-binaries-release-design.md`

## Global Constraints

- **Platforms (first scope):** `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`. Linux is out of scope.
- **Vendor-hosted only** — no project mirrors; one primary source per binary; a pruned artifact fails loudly (refresh flow).
- **Binaries leave git** — `src-tauri/binaries/`, `src-tauri/frameworks/`, `src-tauri/gs-resources/`, `src-tauri/.staging/` are gitignored build artifacts.
- **The audit is the gate** — `scripts/audit-sidecars.sh` must fail on: arch ≠ filename triple, version ≠ lock, missing gs resources, absolute non-system dylib deps, invalid signature. It runs in `cargo test` via `sidecars_are_self_contained`.
- **Same commands locally and in CI** — no CI-only logic. CI/CD workflow itself is out of scope (`docs/superpowers/specs/2026-10-02-cicd-devops-tbd.md`).
- **GPLv3 app; engine licenses:** FFmpeg GPLv2+, Ghostscript AGPLv3, vips LGPL-3.0, qpdf Apache-2.0. License texts + SBOM ship at release.
- **No comments in code** unless explicitly requested (license headers excepted). Conventional commits. Gate: `yarn build && yarn test && cd src-tauri && cargo test`.
- **Pinned values (do not re-resolve during implementation):**
  - Riedl arm64: ffmpeg `c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924`, ffprobe `fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6`
  - Riedl amd64: ffmpeg `7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4`, ffprobe `2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd`
  - qpdf mac arm64 `62e46987a30ea167cbc530ccb22690aec3d8c812ed09979a941bcee92e504b79`, mac x86_64 `dd3b01f4414d198529bb0f13bba59c2f016a328bb3506695087a96fb80fc1481`, msvc64 `db87077e683630c1217e0e8f9a20a9749d952ab676e881c3689187763a5de25d`, msvc-arm64 `2b5d7740a2513d8a841116692dc2cf7efe83f35262386ebab18bed35fbf15ab1`
  - BtbN win64-gpl `74827e097445a136b803febd4dcf80f7cba7f14a4c612fb80f7b5e5cedd3ffbe`, winarm64-gpl `7263744331532e1606bfbac25b5c1a7dcd23091b44614787efd742d6a8dfa1a6`
  - vips MXE x64-all `78e56ba30c267ba32ff965200534bd5721364cadbead8c4d595e44b58dfeff15`, arm64-all `8f2d3a94bbc485a8226cdea012d3a76ac660a373a154fabcd772226978e56f4a`
  - MSYS2 gs ucrt64 `f2cf05482407de57b0ab3de7b3daf7c7d442eeae73de6ffc4ced75894bc94367`, clangarm64 `ade0e912a306bca8add436d188b4006d86eae5e1635151b1b1d7df563fbe316e`

## Review Focus

Failure modes most likely to bite (each gets a test in the owning task):

1. **A renamed wrong-arch binary reaches the bundle** — audit must fail when `file`/`lipo` content ≠ filename triple (Task 1).
2. **Fresh clone without binaries** — commands fail with an actionable message naming `yarn binaries:all`, never a cryptic ENOENT mid-compression (Tasks 1–3).
3. **Ghostscript without bundled resources** — on a machine with no Homebrew Ghostscript, PDF compression must still work; audit asserts resource presence + search-path order (Task 2).
4. **Vendor prunes a pinned artifact** — fetch fails loudly naming the artifact + suggesting `yarn binaries:refresh` (Tasks 1, 6).
5. **Windows engine DLLs unresolved** — spawn of vips/gs/qpdf finds sibling DLLs; missing DLL surfaces as `SidecarFailed`, not a crash (Task 3).

---

## File Structure

```
scripts/
├── binaries.manifest.json         # Create — intent: source + pin per (binary,target)
├── binaries.lock.json             # Create — resolved truth (written by fetch/prep)
├── binaries/
│   ├── lib.mjs                    # Create — shared: arch map, sha256, download, extract, lock IO
│   ├── fetch.mjs                  # Create — download → verify → stage → lock
│   ├── prep.mjs                   # Create — per-OS prep orchestrator
│   ├── prep-windows.mjs           # Create — Windows engine folders + DLLs + gs resources
│   ├── verify.mjs                 # Create — arch-vs-name, version-vs-lock, gs resources
│   ├── sbom.mjs                   # Create — sbom.json + THIRD_PARTY_LICENSES.md
│   ├── refresh.mjs                # Create — re-resolve latest, update manifest + lock
│   ├── app-build.mjs              # Create — binaries:all → tauri build --target
│   ├── all.mjs                    # Create — fetch → prep → verify sequentially
│   └── *.test.mjs                 # Create — Vitest (node env) unit tests
├── audit-sidecars.sh              # Modify — arch/version/gs-resources gates via verify.mjs
├── bundle-vips-macos.sh           # Modify — staging-dir dep resolution
└── bundle-pdf-macos.sh            # Modify — official qpdf staging + gs resource staging
src-tauri/
├── tauri.conf.json                # Modify — externalBin (+ mac frameworks)
├── tauri.windows.conf.json        # Create — windows-only externalBin + resources
├── src/sidecar.rs                 # Modify — win arm64 triple, gs-resources resolution
├── src/engine/processor.rs        # Modify — GsResources in SidecarPaths
└── src/processors/pdf.rs          # Modify — gs_args carries -I/-sICCProfilesDir
package.json                       # Modify — binaries:*/app:build/sbom scripts
.gitignore                         # Modify — binaries, frameworks, gs-resources, .staging
docs/bugs.md                       # Modify — record ffmpeg mislabel + gs resources incidents
```

---

### Task 1: Manifest, Lock, Fetch, Arch Gate (macOS arm64) — fixes the ffmpeg incident

**Files:**
- Create: `scripts/binaries.manifest.json` (mac arm64 entries: ffmpeg, ffprobe only in this task)
- Create: `scripts/binaries/lib.mjs`, `scripts/binaries/fetch.mjs`
- Create: `scripts/binaries/lib.test.mjs`, `scripts/binaries/fetch.test.mjs`
- Modify: `scripts/audit-sidecars.sh` (arch + presence gate delegating to `verify.mjs`)
- Create: `scripts/binaries/verify.mjs` (arch + presence checks only in this task)
- Modify: `package.json` (scripts), `.gitignore`
- Modify: `docs/bugs.md`

**Interfaces:**
- Produces (later tasks rely on these exact shapes):
  - Manifest JSON: `{ "targets": { "<triple>": { "<binary>": { "source": "url"|"brew", "url"?: string, "sha256"?: string, "member"?: string, "lib"?: string, "formula"?: string, "expectVersion": string, "dest": string } } } }`
  - Lock JSON: `{ "generated": ISO8601, "targets": { "<triple>": { "<binary>": { "source": string, "version": string, "url"?: string, "sha256"?: string, "date": ISO8601 } } } }`
  - `lib.mjs` exports: `archForTriple(triple) -> "arm64"|"x86_64"` (throws on unknown), `expectedDest(name, triple) -> "<name>-<triple>[.exe]"`, `sha256File(path) -> Promise<string>`, `readJson(path)`, `writeJson(path, obj)`, `download(url, destPath)`, `extract(archivePath, destDir)` (zip via `unzip`, tar.zst via `tar --zstd`)
  - `verify.mjs` CLI: `node scripts/binaries/verify.mjs --target <triple> [--root <dir>]` → exit 0 pass / 1 fail; reads manifest + lock; checks presence, arch (content vs filename triple), version (execute with `--version`; mac runs prefixed with `DYLD_LIBRARY_PATH=<root>/src-tauri/frameworks`)
- Consumes: nothing (first task).

- [ ] **Step 1: Write failing tests for `lib.mjs` pure functions**

`scripts/binaries/lib.test.mjs` (start with `// @vitest-environment node`):
```js
import { describe, it, expect } from "vitest";
import { archForTriple, expectedDest } from "./lib.mjs";

describe("archForTriple", () => {
  it("maps apple triples", () => {
    expect(archForTriple("aarch64-apple-darwin")).toBe("arm64");
    expect(archForTriple("x86_64-apple-darwin")).toBe("x86_64");
  });
  it("maps windows triples", () => {
    expect(archForTriple("x86_64-pc-windows-msvc")).toBe("x86_64");
    expect(archForTriple("aarch64-pc-windows-msvc")).toBe("arm64");
  });
  it("throws on unknown triple", () => {
    expect(() => archForTriple("mips-unknown-linux-gnu")).toThrow("unknown triple");
  });
});

describe("expectedDest", () => {
  it("appends triple and .exe only on windows", () => {
    expect(expectedDest("ffmpeg", "aarch64-apple-darwin")).toBe("ffmpeg-aarch64-apple-darwin");
    expect(expectedDest("ffmpeg", "aarch64-pc-windows-msvc")).toBe("ffmpeg-aarch64-pc-windows-msvc.exe");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run scripts/binaries/lib.test.mjs`
Expected: FAIL — cannot resolve `./lib.mjs`.

- [ ] **Step 3: Implement `lib.mjs`**

Implement the exported functions listed in Interfaces. `download` uses `node:https` following redirects to a file; `extract` shells `unzip -o -q` for `.zip` and `tar --zstd -xf` for `.tar.zst`; `sha256File` streams with `node:crypto`. No third-party deps.

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run scripts/binaries/lib.test.mjs`
Expected: PASS.

- [ ] **Step 5: Create the mac arm64 manifest (ffmpeg + ffprobe only)**

`scripts/binaries.manifest.json`:
```json
{
  "targets": {
    "aarch64-apple-darwin": {
      "ffmpeg": {
        "source": "url",
        "url": "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
        "sha256": "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
        "member": "ffmpeg",
        "dest": "ffmpeg",
        "expectVersion": "9.0.2"
      },
      "ffprobe": {
        "source": "url",
        "url": "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip",
        "sha256": "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6",
        "member": "ffprobe",
        "dest": "ffprobe",
        "expectVersion": "9.0.2"
      }
    }
  }
}
```

- [ ] **Step 6: Write failing tests for `fetch.mjs` with a local HTTP fixture**

`scripts/binaries/fetch.test.mjs` (`// @vitest-environment node`): spin up `node:http` serving a fixture zip (create it in the test with `zip` CLI or a committed 1-file fixture under `scripts/binaries/fixtures/`); assert:
- successful fetch stages `<dest>-<triple>` (or `.exe`) under a temp `--root` and writes a lock entry with version/url/sha256
- sha256 mismatch exits non-zero with a message containing `sha256 mismatch` and the artifact name
- `extract` handles the fixture and the `member` is copied to dest
Tests must pass `--root <tmpdir>` (add `--root` option to fetch/verify for testability; default repo root).

- [ ] **Step 7: Run tests to verify they fail**

Run: `yarn vitest run scripts/binaries/fetch.test.mjs`
Expected: FAIL — `fetch.mjs` missing.

- [ ] **Step 8: Implement `fetch.mjs`**

CLI: `node scripts/binaries/fetch.mjs --target <triple> [--root <dir>]`. Per binary in manifest for target with `source: "url"`: skip if lock entry exists and staged file sha256 matches (idempotent); else download to `<root>/src-tauri/.staging/<name>-<triple>/<file>`, verify sha256 against manifest, extract into staging, copy `member` to `<root>/src-tauri/binaries/<expectedDest>`, chmod +x, write lock entry. `source: "brew"` entries are skipped by fetch (prep owns them; Task 2). Error text for missing artifact: `artifact unavailable (vendor may have pruned it): <url> — run 'yarn binaries:refresh'`.

- [ ] **Step 9: Run tests to verify they pass**

Run: `yarn vitest run scripts/binaries/fetch.test.mjs`
Expected: PASS.

- [ ] **Step 10: Implement `verify.mjs` (presence + arch + version) and wire the audit**

- `verify.mjs --target <triple>`:
- for each manifest binary of the target: staged file exists (else fail: `missing <dest> — run 'yarn binaries:all'`); arch check: mac via `lipo -archs`, windows via `file` output parsing; compare with `archForTriple(triple)`; filename triple itself already encodes the expectation, so check = content arch vs `archForTriple` of the target; version check: run `<bin> --version` (mac: prepend `DYLD_LIBRARY_PATH=<root>/src-tauri/frameworks`), assert `expectVersion` is a substring of stdout+stderr; brew entries: `brew list --versions <formula>` version must equal `expectVersion`.
- In `scripts/audit-sidecars.sh`, after the existing `require_tool file` block, add: `node "$ROOT/scripts/binaries/verify.mjs" --target "$(rustc -Vv | grep '^host:' | sed 's/host: //')" || failures+=("<verify>")`. Keep all existing linkage/signature checks unchanged.

- [ ] **Step 11: TDD the incident itself — audit must FAIL on today's repo, then pass after fetch**

Run: `yarn binaries:audit`
Expected: FAIL naming `ffmpeg-aarch64-apple-darwin` with `arch x86_64 does not match arm64` (and ffprobe).
Then run: `yarn binaries:fetch --target aarch64-apple-darwin`
Then run: `yarn binaries:audit`
Expected: PASS (`sidecar audit: PASS`).
Also `file src-tauri/binaries/ffmpeg-aarch64-apple-darwin` → `Mach-O 64-bit executable arm64` and `./ffmpeg... -version` prints `9.0.2`.

- [ ] **Step 12: Update package.json, .gitignore, bugs.md**

package.json scripts:
```json
"binaries:fetch": "node scripts/binaries/fetch.mjs",
"binaries:prep": "node scripts/binaries/prep.mjs",
"binaries:verify": "node scripts/binaries/verify.mjs",
"binaries:audit": "bash scripts/audit-sidecars.sh",
"binaries:all": "node scripts/binaries/all.mjs",
"binaries:refresh": "node scripts/binaries/refresh.mjs",
"app:build": "node scripts/binaries/app-build.mjs"
```
`.gitignore` add: `src-tauri/binaries/`, `src-tauri/frameworks/`, `src-tauri/gs-resources/`, `src-tauri/.staging/`.
`git rm -r --cached src-tauri/binaries src-tauri/frameworks` (keep working-tree files).
`docs/bugs.md` append under a new `## Sidecar binaries` section: incident record — ffmpeg/ffprobe shipped as x86_64 renamed aarch64 (evermeet.cx x86_64-only, no arch gate existed); fixed by manifest fetch + arch gate; gs resources gap noted as Task 2.
Create minimal `prep.mjs` (passthrough stub until Task 2), `all.mjs` (fetch → prep → audit) and `app-build.mjs` (`all.mjs` + `yarn tauri build --target <triple>`) now, so the script names exist and `yarn binaries:all` / `yarn app:build` are runnable after Task 1.

- [ ] **Step 13: Full gate + commit**

Run: `yarn build && yarn test && cd src-tauri && cargo test` (from repo root)
Expected: all green (audit test passes with fetched arm64 ffmpeg).
```bash
git add -A
git commit -m "feat(binaries): manifest-driven fetch with arch gate; fix Intel ffmpeg mislabel"
```

---

### Task 2: macOS arm64 Complete Pipeline — qpdf, brew vips/gs, resources, Rust

**Files:**
- Modify: `scripts/binaries.manifest.json` (add qpdf, vips, gs for mac arm64)
- Modify: `scripts/binaries/fetch.mjs` (qpdf `lib` staging), `scripts/binaries/verify.mjs` (gs resources + version checks)
- Modify: `scripts/binaries/prep.mjs`, `scripts/bundle-pdf-macos.sh`, `scripts/bundle-vips-macos.sh`
- Modify: `scripts/audit-sidecars.sh` (gs resources presence + clean-room smoke)
- Modify: `src-tauri/src/sidecar.rs`, `src-tauri/src/engine/processor.rs`, `src-tauri/src/processors/pdf.rs`
- Modify: `src-tauri/tauri.conf.json` (resources)
- Test: unit tests in the three Rust files + `scripts/binaries/fetch.test.mjs`, `verify.test.mjs`

**Interfaces:**
- Consumes: Task 1's manifest/lock/lib/fetch/verify and `--root` option; existing `collect_deps_of`/`rewrite`/`ensure_rpath` in `sidecar-bundle.common.sh`.
- Produces:
  - `GsResources` Rust struct `{ search_paths: Vec<String>, icc_profiles_dir: Option<String> }` resolved into `SidecarPaths.gs_resources: Option<GsResources>`.
  - `pub fn resolve_gs_resources(exe_dir: &Path) -> Option<GsResources>` in `sidecar.rs`; candidate dirs (first existing wins): `exe_dir/../Resources/gs-resources`, `exe_dir/../../gs-resources`, `exe_dir/resources/gs-resources`, `exe_dir/gs-resources`.
  - `gs_args(dpi, jpegq, input, output, resources: Option<&GsResources>) -> Vec<String>` — when resources present, args are `-I<search_paths joined>` (one `-I` per path, each as its own arg, in order: Resource/Init, lib, Resource/Font, fonts) followed by `-sICCProfilesDir=<icc>` when present, prepended BEFORE existing `-sDEVICE=pdfwrite`; when absent, output must be byte-identical to today's args (existing tests pin order).

- [ ] **Step 1: Extend manifest with qpdf/vips/gs (mac arm64)**

Add to `aarch64-apple-darwin`:
```json
"qpdf": {
  "source": "url",
  "url": "https://github.com/qpdf/qpdf/releases/download/v12.4.2/qpdf-12.4.2-bin-macos-arm64.zip",
  "sha256": "62e46987a30ea167cbc530ccb22690aec3d8c812ed09979a941bcee92e504b79",
  "member": "qpdf-12.4.2-bin-macos-arm64/bin/qpdf",
  "lib": "qpdf-12.4.2-bin-macos-arm64/lib",
  "dest": "qpdf",
  "expectVersion": "12.4.2"
},
"vips": { "source": "brew", "formula": "vips", "dest": "vips", "expectVersion": "8.18.7" },
"gs": {
  "source": "brew", "formula": "ghostscript", "dest": "gs", "expectVersion": "10.08.0",
  "resources": ["Resource", "lib", "iccprofiles", "fonts"]
}
```

- [ ] **Step 2: TDD fetch `lib` staging + gs resource staging**

Add to `fetch.test.mjs`: qpdf-style fixture with `member` + `lib` stages the binary to `binaries/` (rewritten load commands are prep's concern) and copies the lib dir to `.staging/<name>-<triple>/lib/`; verify test asserts the lib dir exists there.
Run: `yarn vitest run scripts/binaries/fetch.test.mjs` → expect new tests FAIL, implement, PASS.

- [ ] **Step 3: TDD prep: staging-aware dylib collection + gs resources staging**

Extend `bundle-pdf-macos.sh` `collect_deps_of`: before `find_in_brew`, when resolving `@rpath/<base>`, substitute `@loader_path` against `<root>/src-tauri/.staging/qpdf-<triple>/lib` — i.e. add candidate `${STAGING_QPDF_LIB}/<depbase>`. When staging lib exists, prefer it over frameworks and, before collection, `rm -f "$FRAMEWORKS/libqpdf.30.dylib"` so the official lib replaces the brew-era copy (fingerprint guard intentionally bypassed only for this replacement; log `note: replacing frameworks/libqpdf.* with official qpdf lib`).
Extend `bundle-pdf-macos.sh` after codesign: stage gs resources: `GSPREFIX="$(brew --prefix ghostscript)"`; copy `share/ghostscript/{Resource,lib,iccprofiles,fonts}` → `<root>/src-tauri/gs-resources/` (delete target first; fail if any source missing). Same content check must be deterministic (sorted copy).
`prep.mjs` for `--target *-apple-darwin`: run `bundle-vips-macos.sh` then `bundle-pdf-macos.sh`; then write lock entries for vips/gs from `brew list --versions`.
Local verification (this machine, brew gs present): `yarn binaries:prep --target aarch64-apple-darwin && ls src-tauri/gs-resources/Resource/Init/gs_init.ps` → exists.

- [ ] **Step 4: TDD Rust `GsResources` resolution**

In `sidecar.rs` tests: `resolve_gs_resources_prefers_bundle_layout` (temp dir with `Resources/gs-resources/Resource/Init/gs_init.ps` + `fonts/` → resolves, `search_paths` ordered Init, lib, Resource/Font, fonts, `icc_profiles_dir` = Some when `iccprofiles/` exists); `resolve_gs_resources_returns_none_when_absent`; `resolve_for_attaches_gs_resources` (SidecarPaths gains the field).
Run: `cd src-tauri && cargo test resolve_gs_resources` → FAIL → implement → PASS. `SidecarPaths::resolve_for` sets `gs_resources: resolve_gs_resources(exe_dir)`.

- [ ] **Step 5: TDD gs args with resources**

In `pdf.rs` tests: `gs_args_prepend_resource_flags_in_order` — with resources (4 paths + icc), assert args begin `["-I<init>", "-I<lib>", "-I<font>", "-I<fonts>", "-sICCProfilesDir=<icc>", "-sDEVICE=pdfwrite", ...]`; `gs_args_without_resources_match_today` — None/resources-absent yields exactly the current argument vector (existing tests unchanged). Thread `sidecar_paths.gs_resources.as_ref()` through `pass_spec`/`gs_args` call sites.
Run: `cd src-tauri && cargo test gs_args` → FAIL → implement → PASS.

- [ ] **Step 6: Clean-room gs smoke in audit (bundled resources only)**

Add to `audit-sidecars.sh` (mac): when `gs-resources` exists, run gs with `env -i HOME=/nonexistent PATH=/usr/bin:/bin` and `-I` flags for the four staged dirs, rendering a font-using fixture (`/Helvetica findfont … show showpage`) → assert exit 0 and output file > 1 KB. This is the regression guard for the "works only via brew" defect. (True no-brew clean room runs in CI later: install → stage → `brew uninstall ghostscript` → smoke; out of scope here.)
Verify: `bash scripts/audit-sidecars.sh` → PASS includes `gs clean-room smoke: PASS`.

- [ ] **Step 7: tauri.conf resources + full end-to-end acceptance**

`src-tauri/tauri.conf.json` bundle add: `"resources": { "gs-resources/": "gs-resources/" }` (map notation; verify with `yarn tauri build --no-bundle` that `Contents/Resources/gs-resources/Resource/Init/gs_init.ps` lands in the `.app`).
Manual acceptance (this machine): `yarn tauri dev`, compress one JPEG, one MP4, one PDF with Homebrew Ghostscript temporarily renamed (`mv /opt/homebrew/opt/ghostscript /opt/homebrew/opt/ghostscript.bak`, restore after) → PDF still compresses to target; `ps` shows gs running with `-I` flags.
Record results in `docs/superpowers/plans/2026-10-02-sidecar-binaries-release.md` Execution Notes when executing.

- [ ] **Step 8: Full gate + commit**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: all green.
```bash
git add -A
git commit -m "feat(binaries): macOS arm64 prep — official qpdf, brew vips/gs, staged gs resources"
```

---

### Task 3: Windows x64 + arm64 Pipeline

**Files:**
- Modify: `scripts/binaries.manifest.json` (all four Windows-binary entries ×2 targets)
- Modify: `scripts/binaries/fetch.mjs` (tar.zst support, `.exe` dest)
- Create: `scripts/binaries/prep-windows.mjs` + `prep-windows.test.mjs`
- Modify: `scripts/binaries/prep.mjs` (dispatch on target OS)
- Create: `src-tauri/tauri.windows.conf.json`
- Modify: `src-tauri/src/sidecar.rs` (win-arm64 triple, engine-folder candidates, PATH prepend helper)
- Modify: `src-tauri/src/engine/processor.rs` (windows candidate wiring if needed)
- Tests: `sidecar.rs`, `prep-windows.test.mjs`

**Interfaces:**
- Consumes: Task 1–2 pipeline; `expectedDest` `.exe` support; `archForTriple` windows entries.
- Produces:
  - `sidecar.rs`: `target_triple("windows","aarch64") -> "aarch64-pc-windows-msvc"`; engine-folder candidates from exe_dir: `resources/engines/<name>/<file>`, `../../binaries/engines/<name>/<file>`, `binaries/engines/<name>/<file>` (dev), where `<file>` = `vips.exe`, `gs.exe`, `qpdf.exe`.
  - `pub fn prepend_engine_dir_to_path(cmd: &mut Command, sidecar_path: &str) -> Option<OsString>` — on Windows only, returns the PATH used and sets it (parent dir of sidecar). Unit-testable pure core: `fn path_with_dir_front(existing: Option<&OsStr>, dir: &Path) -> OsString`.
  - `prep-windows.mjs` output layout: `src-tauri/binaries/engines/{vips,gs,qpdf}/` each containing the exe + all required DLLs; `src-tauri/gs-resources/{Resource,lib,iccprofiles,fonts}`.
  - `tauri.windows.conf.json`: `bundle.externalBin` = `["binaries/ffmpeg","binaries/ffprobe"]`; `bundle.resources` adds `{ "binaries/engines/": "engines/", "gs-resources/": "gs-resources/" }`.

- [ ] **Step 1: Add Windows manifest entries**

For both `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc`:
- ffmpeg/ffprobe: BtbN pinned tag `autobuild-2026-10-01-13-06`, assets `ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0.zip` (sha `74827e09…ffbe`) / `…-winarm64-gpl-9.0.zip` (sha `7263744…a1a6`), members `bin/ffmpeg.exe`, `bin/ffprobe.exe`, expectVersion `9.0.2`, source url.
- qpdf: `…-msvc64.zip` (sha `db87077e…e25d`) / `…-msvc-arm64.zip` (sha `2b5d7740…5ab1`), member `qpdf-12.4.2-msvc64/bin/qpdf.exe`, dest `qpdf`, expectVersion `12.4.2`.
- vips: MXE `vips-dev-x64-all-8.18.7.zip` (sha `78e56ba…eff15`) / `vips-dev-arm64-all-8.18.7.zip` (sha `8f2d3a9…f4a`), member `vips-dev-8.18/bin/vips.exe` (prep copies the whole `bin/` tree), expectVersion `8.18.7`.
- gs: MSYS2 `mingw-w64-ucrt-x86_64-ghostscript-10.08.0-2-any.pkg.tar.zst` (sha `f2cf054…4367`) / `mingw-w64-clang-aarch64-ghostscript-10.08.0-2-any.pkg.tar.zst` (sha `ade0e91…316e`), member paths under `ucrt64/bin/gswin64c.exe` / `clangarm64/bin/gswin64c.exe`, dest `gs`, expectVersion `10.08.0`, `resources: ["share/ghostscript/10.08.0/Resource", "share/ghostscript/10.08.0/lib", "share/ghostscript/10.08.0/iccprofiles", "share/ghostscript/10.08.0/fonts"]`.
Add tar.zst extraction to `lib.mjs` `extract` (already specced) + a fixture test.

- [ ] **Step 2: TDD `prep-windows.mjs`**

`prep-windows.test.mjs` (node env, temp root fixtures):
- `vips folder layout: exe + all sibling DLLs copied from staged bin/ into engines/vips/` (fixture: `bin/vips.exe`, `bin/foo.dll`, `bin/vips-modules-8.18/bar.dll` → asserts exe+dlls+modules present).
- `gs: gswin64c.exe renamed to gs.exe + DLLs + resources tree staged` (fixture pkg tree with `bin/gswin64c.exe`, `bin/libgs-10.dll`, `share/ghostscript/10.08.0/Resource/Init/gs_init.ps` → asserts `engines/gs/gs.exe`, DLLs, `gs-resources/Resource/Init/gs_init.ps`).
- `qpdf: qpdf.exe + VC runtime DLLs staged into engines/qpdf/` (fixture from msvc zip listing: msvcp140.dll etc).
Run → FAIL → implement → PASS.

- [ ] **Step 3: TDD Rust Windows triples + candidates + PATH prepend**

`sidecar.rs` tests:
- extend `target_triple_returns_triple_per_platform` with `("windows","aarch64") -> "aarch64-pc-windows-msvc"`.
- `engine_folder_candidates_windows_layout` — exe_dir with `resources/engines/vips/vips.exe` resolves `vips`; dev layout `../../binaries/engines/vips/vips.exe` resolves too (test via temp dirs + cfg(windows) gating where needed; pure candidate-list fn is unit-testable on any OS: `fn engine_candidates(exe_dir, name) -> Vec<PathBuf>`).
- `path_with_dir_front_prepends_and_dedupes` — existing PATH `A;B`, dir `D` → `D;A;B`; dir already present → unchanged.
- `resolve_for` on windows still resolves ffmpeg/qpdf from exe_dir direct candidates.
Run: `cd src-tauri && cargo test` (targeted) → FAIL → implement → PASS. Wire `prepend_engine_dir_to_path` into `run_sidecar`'s spawn only for non-static engines (call it for every sidecar; harmless for static ones).

- [ ] **Step 4: Create `tauri.windows.conf.json` + prep dispatch**

`prep.mjs`: target ends with `-pc-windows-msvc` → run `prep-windows.mjs` after fetch. Verify Tauri platform-config merge via Context7 (`/tauri-apps/tauri-docs`, query "platform specific configuration tauri.windows.conf.json merge") before finalizing the file.
Verify JSON validity of both configs: `python3 -c "import json; [json.load(open(p)) for p in ['src-tauri/tauri.conf.json','src-tauri/tauri.windows.conf.json']]"`.

- [ ] **Step 5: Cross-check what is verifiable on macOS**

Run: `yarn vitest run scripts/binaries/` (all unit tests green), `yarn build && yarn test && cd src-tauri && cargo test` (Rust green). Windows end-to-end (fetch → prep → audit → build → manual compress) is verified later by cloning the repo on Windows per the spec's manual acceptance flow — note this explicitly in Execution Notes; do not fake a Windows verification on macOS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(binaries): Windows x64 + arm64 pipeline (BtbN/qpdf/MXE/MSYS2, engine folders)"
```

---

### Task 4: macOS Intel Target

**Files:**
- Modify: `scripts/binaries.manifest.json` (add `x86_64-apple-darwin`: ffmpeg, ffprobe, qpdf × vendor Intel artifacts; vips, gs brew entries with Intel expectations)
- Modify: `scripts/binaries/prep.mjs` (no code change expected — host-driven; confirm)
- Modify: `docs/superpowers/plans/2026-10-02-sidecar-binaries-release.md` (Execution Notes: verification method)

**Interfaces:**
- Consumes: everything from Tasks 1–2; the prep scripts are already host-arch driven (`rustc -Vv host` selects the triple).
- Produces: manifest rows only — no new code paths expected. If prep scripts turn out to hardcode arm64 paths, fix them to use the host triple (same pattern they already use via `TRIPLE`).

- [ ] **Step 1: Add Intel manifest entries**

`x86_64-apple-darwin`: ffmpeg `…/macos/amd64/1789931006_9.0.2/ffmpeg.zip` sha `7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4`; ffprobe sha `2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd`; qpdf `…-bin-macos-x86_64.zip` sha `dd3b01f4414d198529bb0f13bba59c2f016a328bb3506695087a96fb80fc1481`; vips/gs brew entries.
Validate JSON: `python3 -c "import json; json.load(open('scripts/binaries.manifest.json'))"`.

- [ ] **Step 2: Verify no arm64 assumptions exist**

Run: `grep -rn "aarch64" scripts/*.sh scripts/binaries/*.mjs | grep -v test | grep -v manifest`
Expected: only `TRIPLE="$(rustc -Vv | grep '^host:'…)"`-style host resolution and manifest content — no hardcoded arm64 in logic. Fix any found.

- [ ] **Step 3: Document the verification path**

Execution Notes must state: Intel end-to-end verification requires an Intel Mac or the `macos-15-intel` CI runner (CI flow: `yarn binaries:all --target x86_64-apple-darwin && yarn app:build --target x86_64-apple-darwin`) — deferred to the CI/CD spec implementation; manual runbook: clone repo on Intel host, `yarn install && yarn binaries:all && yarn app:build`, compress image/video/PDF.
Also note the shelf life (Homebrew Intel Tier 3, Riedl Intel EOL Jan 2027, runner EOL Fall 2027) with the MacPorts migration pointer from the spec.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(binaries): macOS Intel target manifest (Riedl amd64, qpdf x86_64)"
```

---

### Task 5: SBOM + License Notices

**Files:**
- Create: `scripts/binaries/sbom.mjs`, `scripts/binaries/sbom.test.mjs`
- Create: `THIRD_PARTY_LICENSES.md` (generated; committed at release time — task writes a first copy)
- Modify: `package.json` (`"sbom": "node scripts/binaries/sbom.mjs"`)

**Interfaces:**
- Consumes: `binaries.lock.json` + manifest per-target entries.
- Produces: `sbom.json` (CycloneDX-lite shape: `{ "generated": ISO, "components": [ { "name", "version", "license", "source", "sha256", "targets": [triple] } ] }`) and `THIRD_PARTY_LICENSES.md` with one section per engine: name, version(s), license (FFmpeg GPLv2+, Ghostscript AGPLv3, vips LGPL-3.0, qpdf Apache-2.0), source URL, and the license text pointer.

- [ ] **Step 1: Write failing tests**

`sbom.test.mjs` (node env): fixture lock with two targets and three engines → `components` dedupe by (name, version) with merged `targets` arrays; every component has `license` from a pure `licenseFor(name)` map (`ffmpeg/ffprobe -> "GPL-2.0-or-later"`, `gs -> "AGPL-3.0"`, `vips -> "LGPL-3.0"`, `qpdf -> "Apache-2.0"`); markdown contains one heading per component and all four license identifiers.
Run: `yarn vitest run scripts/binaries/sbom.test.mjs` → FAIL.

- [ ] **Step 2: Implement, make pass, generate**

Implement `sbom.mjs` (no deps); run `yarn sbom`; inspect `sbom.json` + `THIRD_PARTY_LICENSES.md` for the real lock (mac arm64 rows after Tasks 1–2).
Run: `yarn vitest run scripts/binaries/sbom.test.mjs` → PASS.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(binaries): SBOM + third-party license notices from lock"
```

---

### Task 6: `binaries:refresh` (version bump flow)

**Files:**
- Create: `scripts/binaries/refresh.mjs`, `scripts/binaries/refresh.test.mjs`
- Modify: `scripts/binaries/lib.mjs` (vendor resolvers)

**Interfaces:**
- Consumes: manifest + lock; Task 1 fetch flow.
- Produces: `--dry-run` (report only, exit 0) and default (update manifest pins + re-run fetch) modes. Per-source resolvers:
  - `github-latest`: qpdf, vips-MXE, BtbN — GitHub Releases API latest; pick first asset matching a per-binary regex from the manifest (`assetPattern` field added: e.g. `win64-gpl-9\.0\.zip$`); update url+sha256 (BtbN: read `checksums.sha256` asset).
  - `riedl-latest`: ffmpeg mac — fetch `https://ffmpeg.martin-riedl.de/redirect/latest/macos/<arch>/release/ffmpeg.zip` following redirect → versioned URL; sha256 from sibling `.sha256`.
  - `brew`: vips/gs — compare `brew list --versions <formula>` to lock; report drift; update lock only (manifest expectVersion is bumped manually — print instruction).
  - others: report `manual pin — check vendor`.
- Tests: fixture GitHub API JSON → resolver picks correct asset + parses sha; Riedl redirect fixture (local http) → versioned URL extracted; missing asset → clear error.

- [ ] **Step 1: Write failing tests** (as above) → `yarn vitest run scripts/binaries/refresh.test.mjs` → FAIL.
- [ ] **Step 2: Implement → PASS.**
- [ ] **Step 3: Dry-run on this repo**

Run: `yarn binaries:refresh --dry-run`
Expected: reports "no change" for pinned artifacts still present (all four mac arm64 sources), `brew: vips 8.18.7 unchanged`, exit 0.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(binaries): refresh flow for vendor version bumps"
```

---

## Execution Notes (populated during execution)

- Task 2 Step 7 manual acceptance (brew gs renamed) result: _pending_
- Task 3 Windows end-to-end verification: _pending — Windows host or CI_
- Task 4 Intel end-to-end verification: _pending — Intel host or CI_
