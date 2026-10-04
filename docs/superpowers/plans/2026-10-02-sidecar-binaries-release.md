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
└── src/processors/pdf.rs          # Modify — gs_args carries -I/-uICCProfilesDir (corrected to `-uICCProfilesDir`: `-sICCProfilesDir` is not a pdfwrite parameter and aborts device init — see Execution Notes)
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

**Required Tests:**
- `archForTriple_maps_apple_triples` / `archForTriple_maps_windows_triples` / `archForTriple_throws_on_unknown_triple` — pure map + error path
- `expectedDest_appends_triple_and_exe_only_on_windows`
- `fetch_stages_binary_and_writes_lock_entry` — happy path: staged `<name>-<triple>`, lock has version/url/sha256
- `fetch_aborts_when_staged_file_disagrees_with_lock` — lock sha X, new download sha Y → abort `sha256 mismatch` + artifact name (spec §6.3)
- `fetch_aborts_on_sha_mismatch_between_manifest_and_download` — corrupt/interrupted download → non-zero exit
- `fetch_fails_loudly_when_vendor_artifact_unavailable` — 404 fixture → non-zero, message contains `artifact unavailable (vendor may have pruned it)` + `yarn binaries:refresh` (Review Focus #4)
- `fetch_fails_with_actionable_error_when_archive_member_missing` — extracted archive lacks `member` → clear error, staging cleaned
- `fetch_skips_brew_entries_without_side_effects` — machine without brew → fetch exits 0 touching nothing (prep owns brew)
- `fetch_is_idempotent_when_lock_and_staged_file_match`
- `extract_handles_zip_and_tar_zst_fixtures`
- `download_follows_redirects`
- `lock_write_is_atomic` — tmp+rename; interrupted write leaves no torn lock
- `manifest_schema_rejects_missing_expectVersion_and_unknown_source` (spec §11 schema row)
- `verify_missing_binary_reports_run_binaries_all` — empty binaries dir → exit 1, message contains `run 'yarn binaries:all'` (Review Focus #2)
- `verify_fails_on_arch_flip_fixture` — x86 Mach-O under arm64 name → `arch x86_64 does not match arm64` (repeatable §11 fixture; the live incident run in Step 11 is one-shot, this is the regression pin)
- `verify_fails_when_version_output_lacks_expect_version` — stub prints garbage → fail (version-vs-lock §9.2)
- `verify_presents_usage_error_when_target_missing_or_unknown` — clean error naming `--target` (§7 default-target contract)
- `sidecars_are_self_contained` (existing Rust) — **summary line `sidecar audit: PASS (N binaries, N framework dylibs)` is load-bearing** (parsed at `sidecar.rs:406-428`); verify delegate must not alter it

**Acceptance Criteria:**
- `yarn binaries:audit` fails BEFORE fetch naming `ffmpeg-aarch64-apple-darwin` (`arch x86_64 does not match arm64`) and succeeds after `yarn binaries:fetch --target aarch64-apple-darwin` (incident TDD, spec §9.1)
- `binaries:fetch` is idempotent against lock (re-run = no-op), aborts on sha mismatch with manifest, and aborts on lock disagreement (spec §6.3)
- Fetch failure on vendor-pruned artifact exits non-zero naming the URL and `yarn binaries:refresh` (Review Focus #4)
- `archForTriple`/`expectedDest` match Rust `sidecar_filename_for` convention (`sidecar.rs:20-24`) — Node/Rust naming stays in lockstep
- All `scripts/binaries/*.test.mjs` run under `// @vitest-environment node` (vitest.config.ts is jsdom-global)
- `.gitignore` covers the four artifact dirs; `git ls-files src-tauri/binaries src-tauri/frameworks` returns empty
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test` (note: after `git rm --cached`, a fresh clone's `cargo test` fails until `yarn binaries:all` — the failing message must say so, never ENOENT)
- Boundary rules enforced (per AGENTS.md: binary logic lives in `scripts/` + Rust core; frontend unchanged)

- [x] **Step 1: Write failing tests for `lib.mjs` pure functions**

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

- [x] **Step 2: Run tests to verify they fail**

Run: `yarn vitest run scripts/binaries/lib.test.mjs`
Expected: FAIL — cannot resolve `./lib.mjs`.

- [x] **Step 3: Implement `lib.mjs`**

Implement the exported functions listed in Interfaces. `download` uses `node:https` following redirects to a file; `extract` shells `unzip -o -q` for `.zip` and `tar --zstd -xf` for `.tar.zst`; `sha256File` streams with `node:crypto`. No third-party deps.

- [x] **Step 4: Run tests to verify they pass**

Run: `yarn vitest run scripts/binaries/lib.test.mjs`
Expected: PASS.

- [x] **Step 5: Create the mac arm64 manifest (ffmpeg + ffprobe only)**

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

- [x] **Step 6: Write failing tests for `fetch.mjs` with a local HTTP fixture**

`scripts/binaries/fetch.test.mjs` (`// @vitest-environment node`): spin up `node:http` serving a fixture zip (create it in the test with `zip` CLI or a committed 1-file fixture under `scripts/binaries/fixtures/`); assert:
- successful fetch stages `<dest>-<triple>` (or `.exe`) under a temp `--root` and writes a lock entry with version/url/sha256
- sha256 mismatch exits non-zero with a message containing `sha256 mismatch` and the artifact name
- `extract` handles the fixture and the `member` is copied to dest
Tests must pass `--root <tmpdir>` (add `--root` option to fetch/verify for testability; default repo root).

- [x] **Step 7: Run tests to verify they fail**

Run: `yarn vitest run scripts/binaries/fetch.test.mjs`
Expected: FAIL — `fetch.mjs` missing.

- [x] **Step 8: Implement `fetch.mjs`**

CLI: `node scripts/binaries/fetch.mjs --target <triple> [--root <dir>]`. Per binary in manifest for target with `source: "url"`: skip if lock entry exists and staged file sha256 matches (idempotent); else download to `<root>/src-tauri/.staging/<name>-<triple>/<file>`, verify sha256 against manifest, extract into staging, copy `member` to `<root>/src-tauri/binaries/<expectedDest>`, chmod +x, write lock entry. `source: "brew"` entries are skipped by fetch (prep owns them; Task 2). Error text for missing artifact: `artifact unavailable (vendor may have pruned it): <url> — run 'yarn binaries:refresh'`.

- [x] **Step 9: Run tests to verify they pass**

Run: `yarn vitest run scripts/binaries/fetch.test.mjs`
Expected: PASS.

- [x] **Step 10: Implement `verify.mjs` (presence + arch + version) and wire the audit**

- `verify.mjs --target <triple>`:
- for each manifest binary of the target: staged file exists (else fail: `missing <dest> — run 'yarn binaries:all'`); arch check: mac via `lipo -archs`, windows via `file` output parsing; compare with `archForTriple(triple)`; filename triple itself already encodes the expectation, so check = content arch vs `archForTriple` of the target; version check: run `<bin> --version` (mac: prepend `DYLD_LIBRARY_PATH=<root>/src-tauri/frameworks`), assert `expectVersion` is a substring of stdout+stderr; brew entries: `brew list --versions <formula>` version must equal `expectVersion`.
- In `scripts/audit-sidecars.sh`, after the existing `require_tool file` block, add: `node "$ROOT/scripts/binaries/verify.mjs" --target "$(rustc -Vv | grep '^host:' | sed 's/host: //')" || failures+=("<verify>")`. Keep all existing linkage/signature checks unchanged.

- [x] **Step 11: TDD the incident itself — audit must FAIL on today's repo, then pass after fetch**

Run: `yarn binaries:audit`
Expected: FAIL naming `ffmpeg-aarch64-apple-darwin` with `arch x86_64 does not match arm64` (and ffprobe).
Then run: `yarn binaries:fetch --target aarch64-apple-darwin`
Then run: `yarn binaries:audit`
Expected: PASS (`sidecar audit: PASS`).
Also `file src-tauri/binaries/ffmpeg-aarch64-apple-darwin` → `Mach-O 64-bit executable arm64` and `./ffmpeg... -version` prints `9.0.2`.

- [x] **Step 12: Update package.json, .gitignore, bugs.md**

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

- [x] **Step 13: Full gate + commit**

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
- Update (spec sync during refine): §8.2 qpdf row corrected to "official msvc build is not fully static → engines/qpdf/ with VC runtime DLLs" (Task 3's plan is operative); spec §7 fetch/audit rows updated.

**Required Tests:**
- `fetch_stages_qpdf_full_bin_and_lib_dir` — qpdf fixture with `member`+`lib` → binary to `binaries/`, lib dir to `.staging/qpdf-<triple>/lib/`
- `resolve_gs_resources_prefers_bundle_layout` — Resources/gs-resources first; `search_paths` ordered Init, lib, Resource/Font, fonts; `icc_profiles_dir` Some iff `iccprofiles/` exists
- `resolve_gs_resources_returns_none_when_absent`
- `resolve_for_attaches_gs_resources`
- `resolve_gs_resources_dev_layout_candidate_resolves_alone` — when only `exe_dir/gs-resources` (the dev layout) exists, that candidate resolves on its own (renamed from `resolve_gs_resources_pending_candidate_tiebreak`, which did not test a tiebreak)
- `gs_args_prepend_resource_flags_in_order` — resources set → args begin `[ -I<init>, -I<lib>, -I<font>, -I<fonts>, -uICCProfilesDir=<icc>, -sDEVICE=pdfwrite, … ]` (corrected to `-uICCProfilesDir`: `-sICCProfilesDir` is not a pdfwrite parameter and aborts device init — see Execution Notes)
- `gs_args_without_resources_match_today` — None → byte-identical to current vector (genuine, not redundant: current pdf.rs tests `pdf.rs:697-706,758-797` assert flag membership, not order)
- `audit_fails_when_gs_resources_missing_entirely` — spec §9.3 gate must not silently skip when dir absent (analyzer critical gap: regression = PDF breaks on clean machines, invisible)
- `audit_fails_when_iccprofiles_or_fonts_dir_has_no_files_at_all` — staged dirs present but hold no files anywhere under them → fail (§9.3 "non-empty"; renamed from `audit_fails_when_iccprofiles_or_fonts_empty`, which only checked a flat `readdir`)
- `audit_fails_on_brew_version_drift` — stub `brew list --versions` returning `ghostscript 10.08.1` vs lock `10.08.0` → fail (§8.1/§11 drift gate)
- gs clean-room smoke: `env -i HOME=/nonexistent PATH=/usr/bin:/bin` + `-I` staged dirs + `/Helvetica findfont … show` fixture → exit 0, output > 1 KB (script-level, §9.4)

**Acceptance Criteria:**
- `yarn binaries:prep --target aarch64-apple-darwin` populates `src-tauri/gs-resources/Resource/Init/gs_init.ps` (spec §8.1)
- Rust `SidecarPaths.gs_resources` resolves in all three layouts (bundle, dev, resources cwd); missing → None, never aborts (existing invariant `sidecar.rs:313-335` preserved)
- gs args carry `-I` flags BEFORE `-sDEVICE=pdfwrite` when resources resolved; byte-identical to today when absent (spec §8.3)
- Audit fails on: missing gs-resources, empty icc/fonts, brew version drift (spec §9.3/§9.2); clean-room smoke passes with brew-free env (§9.4)
- Manual acceptance (spec §11): JPEG + MP4 + PDF compress on this machine with Homebrew Ghostscript temporarily renamed → results recorded in Execution Notes
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`
- Boundary rules enforced (per AGENTS.md)
- Produces:
  - `GsResources` Rust struct `{ search_paths: Vec<String>, icc_profiles_dir: Option<String> }` resolved into `SidecarPaths.gs_resources: Option<GsResources>`.
  - `pub fn resolve_gs_resources(exe_dir: &Path) -> Option<GsResources>` in `sidecar.rs`; candidate dirs (first existing wins): `exe_dir/../Resources/gs-resources`, `exe_dir/../../gs-resources`, `exe_dir/resources/gs-resources`, `exe_dir/gs-resources`.
  - `gs_args(dpi, jpegq, input, output, resources: Option<&GsResources>) -> Vec<String>` — when resources present, args are `-I<search_paths joined>` (one `-I` per path, each as its own arg, in order: Resource/Init, lib, Resource/Font, fonts) followed by `-uICCProfilesDir=<icc>` when present (corrected to `-uICCProfilesDir`: `-sICCProfilesDir` is not a pdfwrite parameter and aborts device init — see Execution Notes), prepended BEFORE existing `-sDEVICE=pdfwrite`; when absent, output must be byte-identical to today's args (existing tests pin order).

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

In `pdf.rs` tests: `gs_args_prepend_resource_flags_in_order` — with resources (4 paths + icc), assert args begin `["-I<init>", "-I<lib>", "-I<font>", "-I<fonts>", "-uICCProfilesDir=<icc>", "-sDEVICE=pdfwrite", ...]` (corrected to `-uICCProfilesDir`: `-sICCProfilesDir` is not a pdfwrite parameter and aborts device init — see Execution Notes); `gs_args_without_resources_match_today` — None/resources-absent yields exactly the current argument vector (existing tests unchanged). Thread `sidecar_paths.gs_resources.as_ref()` through `pass_spec`/`gs_args` call sites.
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
**Required Tests:**
- `target_triple_returns_triple_per_platform` (extended — `("windows","aarch64") -> "aarch64-pc-windows-msvc"`; note today's generic-Err arm `sidecar.rs:8`)
- `sidecar_filename_for_returns_exact_name_per_platform` (extended — win-arm64 `.exe` naming)
- `engine_folder_candidates_windows_layout` — dev (`../../binaries/engines/vips/vips.exe`) + resources layout resolve; **update `sidecar_candidates_prefer_triple_then_plain_name` which pins `len()==2`** (`sidecar.rs:233-246`) — new candidate count must be pinned in the updated test
- `path_with_dir_front_prepends_and_dedupes` — existing `A;B` + dir `D` → `D;A;B`; dir already present → unchanged
- `run_sidecar_prepends_engine_dir_on_windows` — wiring test: fake sidecar script asserts its PATH had dir front (wiring regression otherwise silently reverts — analyzer 8/10 gap); missing DLL spawn → `SidecarFailed`, never process crash (Review Focus #5)
- `resolve_for_windows_still_resolves_exe_dir_binaries` — ffmpeg/qpdf exe-dir candidates unchanged
- `prep_stages_vips_exe_with_sibling_dlls_and_modules_subdir`
- `prep_stages_gs_renamed_exe_dlls_and_resources_tree` — `gswin64c.exe` → `engines/gs/gs.exe`; missing `share/ghostscript/...` in pkg → clear error (analyzer gap)
- `prep_stages_qpdf_exe_with_vc_runtime_dlls`
- `extract_handles_tar_zst_fixture` (pkg.tar.zst via `tar --zstd`)

**Acceptance Criteria:**
- `target_triple("windows","aarch64")` returns `aarch64-pc-windows-msvc`; `sidecar_filename` emits `.exe` naming per existing convention
- Engine-folder candidates exist; `run_sidecar` prepends the engine dir to child PATH on Windows (no global env mutation); missing DLL → `SidecarFailed` with label (Review Focus #5)
- `prep-windows.mjs` produces `engines/{vips,gs,qpdf}/` layouts per fixtures + `gs-resources/` tree from MSYS2 pkg layout (spec §8.2)
- `src-tauri/tauri.windows.conf.json` valid JSON; externalBin = ffmpeg/ffprobe only; resources map engines/ + gs-resources/. Platform-merge semantics verified via Context7 (`/tauri-apps/tauri-docs`: "platform specific configuration tauri.windows.conf.json") BEFORE finalizing — if merge *appends* rather than *replaces* externalBin, base-conf 5-entry list would demand non-existent win arm64 binaries → documented resolution in Execution Notes one way or the other
- All unit tests + Rust tests green on macOS; Windows end-to-end (fetch→prep→audit→build→manual compress) deferred to on-host/CI — Execution Notes state this, never faked
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`
- Boundary rules enforced (per AGENTS.md)
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

**Required Tests:**
- `manifest_contains_intel_rows_with_pinned_shas` — schema-validated manifest fixture asserting `x86_64-apple-darwin` target exists with 4 binaries carrying the pinned shas (analyzer gap: data-only task currently has zero automated validation)
- `verify_no_hardcoded_aarch64_in_script_logic` — turns the manual `grep -rn "aarch64"` sweep into a test asserting no non-manifest, non-filename arch hardcode exists in `scripts/*.sh` + `scripts/binaries/*.mjs`

**Acceptance Criteria:**
- Manifest gains `x86_64-apple-darwin` rows: Riedl amd64 ffmpeg/ffprobe (pinned sha `7c6b4125…cacd4` / `2322438e…fdfd`), qpdf x86_64 (`dd3b01f4…1481`), vips/gs brew rows — JSON valid (spec §5)
- Zero hardcoded arm64 in script logic (`rustc -Vv host` pattern is the only triple source) — spec §4/§12
- Intel end-to-end verification documented as deferred (Intel host or `macos-15-intel` CI) with shelf-life notes (Riedl Intel EOL Jan 2027, brew Tier 3, runner EOL Fall 2027) in Execution Notes — spec §12
- Gate passes clean (manifest-only change, but gate still runs)
- Boundary rules enforced (per AGENTS.md)
- Produces: manifest rows only — no new code paths expected. If prep scripts turn out to hardcode arm64 paths, fix them to use the host triple (same pattern they already use via `TRIPLE`).

- [ ] **Step 1: Add Intel manifest entries**

`x86_64-apple-darwin`: ffmpeg `…/macos/amd64/1789931006_9.0.2/ffmpeg.zip` sha `7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4`; ffprobe sha `2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd`; qpdf `…-bin-macos-x86_64.zip` sha `dd3b01f4414d198529bb0f13bba59c2f016a328bb3506695087a96fb80fc1481`; vips/gs brew entries.
Validate JSON: `python3 -c "import json; json.load(open('scripts/binaries.manifest.json'))"`.

- [ ] **Step 2: Verify no arm64 assumptions exist + audit gains `--target` passthrough**

Run: `grep -rn "aarch64" scripts/*.sh scripts/binaries/*.mjs | grep -v test | grep -v manifest`
Expected: only `TRIPLE="$(rustc -Vv | grep '^host:'…)"`-style host resolution and manifest content — no hardcoded arm64 in logic. Fix any found.
Then wire `audit-sidecars.sh` to accept an optional `--target <triple>` passthrough to `verify.mjs` (host triple default preserved): `yarn binaries:audit --target x86_64-apple-darwin` cross-audits fetched Intel artifacts from an arm64 host (`lipo` reads both arches; spec §7 audit row). Test (vitest, node env): `audit_target_passthrough_cross_audits_fetched_intel_binaries` — fetch Intel ffprobe into a `--root` fixture, audit with `--target x86_64-apple-darwin` passes; flip its filename to aarch64 → fails.

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

**Required Tests:**
- `components_dedupe_by_name_version_with_merged_targets`
- `license_for_maps_all_four_engines_and_rejects_unknown` — unknown engine name → error (never silent `UNKNOWN`; a future engine must never ship unlicensed — analyzer gap)
- `markdown_contains_one_heading_per_component_and_all_four_license_ids`
- `sbom_fails_clearly_when_lock_missing_or_empty` (analyzer gap)
- `sbom_handles_brew_rows_without_sha256` — brew components carry `sha256: null` (shape gap)

**Acceptance Criteria:**
- `yarn sbom` generates `sbom.json` (components deduped by name+version, merged `targets`, license map: ffmpeg/ffprobe GPL-2.0-or-later, gs AGPL-3.0, vips LGPL-3.0, qpdf Apache-2.0) + `THIRD_PARTY_LICENSES.md` (one section per engine: version, license, source URL, license pointer) — spec §7/§10 + Global Constraints
- Missing lock → clear error, no empty SBOM written
- Output reflects the real post-Task-2 lock (mac arm64)
- Gate passes clean
- Boundary rules enforced (per AGENTS.md)
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

**Required Tests:**
- `github_resolver_picks_asset_matching_pattern_and_parses_sha` — fixture API JSON; multiple matching assets → deterministic pick or error (ambiguity pinned)
- `btbn_sha_parsed_from_checksums_asset`
- `riedl_resolver_follows_redirect_to_versioned_url_and_reads_sha`
- `brew_resolver_reports_drift_when_versions_differ` — brew `10.08.1` vs lock `10.08.0` → drift reported (§6.3; analyzer 7/10 gap)
- `dry_run_makes_zero_writes` — manifest + lock byte-identical after dry-run (§6.3 deliberate-act contract — analyzer critical gap)
- `default_mode_updates_manifest_and_lock_then_runs_fetch`
- `missing_asset_yields_clear_error`
- `manual_pin_entries_report_check_vendor_instruction`

**Acceptance Criteria:**
- `--dry-run` never writes (byte-compare manifest+lock before/after — §6.3)
- Default mode: re-resolves latest per source, updates pins + lock, re-runs fetch (§7)
- brew drift detected and reported, never silently passes (§9.2 counterpart)
- `yarn binaries:refresh --dry-run` on this repo reports no change for still-present pinned artifacts, exit 0
- Gate passes clean
- Boundary rules enforced (per AGENTS.md)
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

- Task 1 (manifest, lock, fetch, arch gate) — **done, PR #75 merged**. The ffmpeg incident is fixed: `ffmpeg`/`ffprobe` shipped as Intel x86_64 under `aarch64` names; they are now fetched from manifest-pinned Martin Riedl arm64 artifacts and gated by `verify.mjs`, which fails on content-vs-filename arch mismatch. Incident TDD ran live (audit failed on the inherited binaries → fetch → audit passed). Gate green: 297 vitest, 386 cargo. Note for later tasks: `src-tauri/frameworks/` and `src-tauri/binaries/` are now gitignored and regenerated only from Task 2 prep, so a fresh clone must run `yarn binaries:all` before `cargo test` (the audit and prep both print the remedy).
- Task 2 Step 7 manual acceptance (brew gs renamed) result: **passed** — see the detail below.
- Task 3 Windows end-to-end verification: _pending — Windows host or CI_
- Task 4 Intel end-to-end verification: _pending — Intel host or CI_

### Task 2 (macOS arm64 complete pipeline) — execution notes

**Delivered.** `yarn binaries:all --target aarch64-apple-darwin` now runs fetch → prep → audit green end to end on this machine: manifest gains qpdf (official vendor archive), vips and gs (brew); prep stages the brew engines, runs `bundle-vips-macos.sh` then `bundle-pdf-macos.sh`, stages `gs-resources/` and records resolved brew versions in the lock; verify gates arch/version/lock/gs-resources/brew drift; audit adds the clean-room gs smoke. Re-running `binaries:all` is idempotent (verified twice).

**Manifest pins kept as pinned.** qpdf sha256 `62e46987…4b79` downloaded and verified unchanged. Two corrections to the plan's Task 2 manifest snippet, both recorded here rather than silently absorbed:
1. The plan's `member`/`lib` (`qpdf-12.4.2-bin-macos-arm64/bin/qpdf`, `…/lib`) do not match the archive: the real zip has no top-level directory (`bin/qpdf`, `lib/libqpdf.30.dylib` symlink → `lib/libqpdf.30.4.2.dylib`). The manifest uses `member: "bin/qpdf"`, `lib: "lib"`.
2. `ghostscript`'s binary is `gs`, not `ghostscript`, so the brew schema gained an optional `binary` key (`"binary": "gs"`) — same data-driven shape as `dest`, and validated by `validateManifest`.

**Deviation from the plan — `-sICCProfilesDir` is not a pdfwrite parameter (blocker found and fixed).** The plan pins `-sICCProfilesDir=<icc>` in `gs_args`. Measured on this machine with the staged gs 10.08.0: passing it aborts device init — `**** Unable to open the initial device, quitting.`, exit 1 — from the brew icc dir, from a nonexistent dir, and in every argument position; `-uICCProfilesDir=<dir>` works (exit 0, 2915-byte PDF). `gs-resources/Resource/Init/gs_lev2.ps` confirms the mechanism (`//systemdict /ICCProfilesDir .knownget { % Set the directory specified by the command line option`), i.e. `ICCProfilesDir` is a *user parameter*, and `-u` is gs's user-parameter switch. Implemented as `-uICCProfilesDir=`, with `gs_args_prepend_resource_flags_in_order` updated and an extra assertion that `-sICCProfilesDir` is never emitted.

**Framework set shrank by one dylib.** `frameworks/libcrypto.3.dylib` was only a dependency of the *brew* qpdf build; the official qpdf needs libz/libc++/libSystem only. It was removed from `tauri.conf.json` (the audit's conf↔frameworks consistency gate requires the lists to match exactly). 71 framework dylibs now.

**Latent rpath defect found in self-review and fixed.** The bundle scripts only added `@executable_path/../Frameworks` (the bundled capitalisation). A sidecar run straight out of `src-tauri/binaries/` therefore resolved `src-tauri/frameworks` only because APFS is case-insensitive — on a case-sensitive volume every `@rpath` dylib would fail to load, which the audit's explicit `DYLD_LIBRARY_PATH` was masking. Both scripts now also add `@executable_path/../frameworks`, so the repo layout resolves on its own.

**Framework/staged-sha ordering.** prep re-signs `vips`/`qpdf`/`gs`, which invalidates the `stagedSha256` fetch recorded for qpdf. prep therefore refreshes `stagedSha256` for exactly those three engines after bundling, and refuses to run when any *other* fetched binary no longer matches the lock (`assertFetchedEntriesUntouched`) — a swapped ffmpeg can never be laundered by prep.

**Step 7 verification — `tauri build`.** `yarn tauri build --no-bundle` produces no `.app` (it skips bundling), so the bundle check was run as `yarn tauri build --bundles app`: `file-compressor.app/Contents/Resources/gs-resources/Resource/Init/gs_init.ps` is present and `diff -rq` against `src-tauri/gs-resources` reports **identical** (Resource 293 / lib 157 / iccprofiles 14 / fonts 95 files). All 5 sidecars land in `Contents/MacOS`, 71 dylibs in `Contents/Frameworks`.

**Step 7 manual acceptance — JPEG + MP4 + PDF with Homebrew Ghostscript renamed.** The interactive `yarn tauri dev` path was not automated; the equivalent was run through the real Rust processor layer against the **built `.app` bundle** (a temporary in-crate `#[ignore]` test driving `ImageProcessor`, `VideoProcessor` and `PdfProcessor` with `SidecarPaths::resolve_for(<app>/Contents/MacOS)`, then deleted — not committed). Exactly what was run:

```
mv /opt/homebrew/opt/ghostscript /opt/homebrew/opt/ghostscript.bak
ACCEPTANCE_DIR=<tmp> ACCEPTANCE_MACOS_DIR=<app>/Contents/MacOS \
  cargo test --lib manual_acceptance -- --ignored --nocapture
mv /opt/homebrew/opt/ghostscript.bak /opt/homebrew/opt/ghostscript
```

Observed (with `HOME`-brew Ghostscript renamed; restored afterwards — verified `brew list --versions ghostscript` → `ghostscript 10.08.0`, `/opt/homebrew/opt/ghostscript` symlink present, no `.bak` left):

| Fixture | In | Out | Strategy that won |
|---|---|---|---|
| `sample.jpg` (ffmpeg testsrc frame) | 11 255 B | 5 076 B | `quality=30,best-effort` (vips) |
| `sample.mp4` (2 s 640×480 testsrc) | 16 155 B | 6 590 B | `two-pass h264 b=15k scale=1920,best-effort` (ffmpeg) |
| `sample.pdf` (cupsfilter, font-bearing) | 12 666 B | 10 713 B | **`gs dpi=72,jpegq=60,best-effort`** |

`best-effort` is expected: the 4 000-byte target sits below the default PDF/image/video quality floors, so no pass may go that low and the smallest legal output is delivered. The PDF row is the load-bearing one — a Ghostscript ladder rung won, i.e. the staged gs actually ran. The resolved search paths were printed from the run: `Contents/Resources/gs-resources/{Resource/Init,lib,Resource/Font,fonts}` + `iccprofiles`, i.e. the bundle candidate.

**Stronger control (also run).** Renaming only the brew *opt* prefix is weaker than it looks, because gs's compiled-in path points at the *Cellar* keg. With both `/opt/homebrew/opt/ghostscript` and `/opt/homebrew/Cellar/ghostscript/10.08.0` renamed (restored afterwards, state verified):
- with the app's flags → `exit=0`, 3 102-byte PDF;
- without the `-I` flags (what the pre-fix build sent) → `GPL Ghostscript 10.08.0: Can't find initialization file gs_init.ps`, `exit=1`.

So the staged resources are load-bearing, not decorative.

**Gate.** `yarn build && yarn test && cd src-tauri && cargo test` → green: 338 vitest (was 297; +41), 404 cargo (was 386; +18).

### Task 2 — PR review round 1 fixes

Four gates in the first review turned out to be structurally incapable of firing. Each was reproduced with a live command before fixing:

1. **The gs clean-room smoke proved nothing on a brew-equipped host.** `env -i` does not neutralize gs's compiled-in `GS_LIBDEFAULT` (`/opt/homebrew/Cellar/ghostscript/10.08.0/share/ghostscript/...`), and prep sources resources from brew — so the prefix always exists on the build host. Repro: emptying `gs-resources/Resource/Font/*` still printed `gs clean-room smoke: PASS` and `sidecar audit: PASS`, and the same gs with **no** `-I` flags at all exited 0 writing a valid 2845-byte PDF. `findfont` on an unknown name silently substitutes, so a font-name sentinel cannot work either. What does work: `runlibfile` **hard-fails** with `/undefinedfilename` on a missing file. prep now stages a uniquely-named sentinel resource (`fso-sidecar-acceptance-sentinel.ps`) into `Resource/Init/`, and the smoke `runlibfile`s it — measured exit 0 with the staged `-I` set, exit 1 without. The smoke additionally requires all five staged dirs to exist and to hold files recursively. Verified: empty `Resource/Font`, empty `fonts/`, and a removed sentinel each fail the audit.
2. **The brew version-drift gate compared the installed version against the lock entry prep had just written from that same version** — it could never fire. verify now compares against the manifest `expectVersion`; prep **fails** instead of warning and never writes a drifted version. Live repro after the fix: pinning `10.08.99` makes `verify` report `brew version drift — formula ghostscript is 10.08.0 but scripts/binaries.manifest.json pins 10.08.99`, and prep aborts with the same finding plus a REMEDY line. An absent brew is now reported as an INACTIVE gate, not a warning.
3. **`bundle-pdf-macos.sh` silently substituted Homebrew's libqpdf.** With the fetch staging dir absent, `collect_deps_of` fell through to `find_in_brew` and staged brew's `libqpdf.30.dylib` under the official name — same basename, same soname, same version string, so the version and rpath gates both passed while shipping different code. It now refuses to bundle without the staged lib, and every collected `libqpdf*` must fingerprint-match the staged one. Two of my first attempts at this were wrong and the fixture tests caught them: a post-collection sha comparison can never match (prep legitimately rewrites the install id and re-signs), and a plain string-prefix "is it inside staging?" check misfires because macOS `/var` is a symlink to `/private/var` — the guard now compares physicalized paths and matches on load-command identity rather than filename.
4. **`resolve_gs_resources` could return `Some` with an empty `search_paths`** (present-but-hollow tree), degrading to the compiled-in prefix with no warning. It now requires the `Resource/Init/gs_init.ps` marker plus a non-empty font source, logs a warning naming the reason, and skips an unusable candidate for a usable later one.

Also fixed: prep validates **every** entry declaring `resources` (Task 3 makes gs a `url` row on both Windows targets, which the old brew-only loop would have silently skipped); prep asserts every manifest row is staged and executable before printing PASS; `cpio` now runs against physicalized paths so a worktree under a symlinked root cannot abort the copy (this was a real latent bug — the bundle fixture initially failed on exactly that); `lipo` failures name the binary and the likely cause; errors carry a structured `remedy` instead of being classified by message prefix; `sidecars_are_self_contained` asserts the smoke line actually appeared; and a Rust test now asserts the `tauri.conf.json` `bundle.resources["gs-resources/"]` mapping, which previously nothing covered — deleting that one line left both suites green while every PDF broke.

**Test count delta.** 297 → 338 vitest (+41: 3 new `bundle-pdf.test.mjs` cases, 6 new audit cases, 4 new prep cases, 2 new verify cases, plus the rewritten stub fixture); 386 → 404 cargo (+18: sentinel/unusable-tree/candidate-2/candidate-3/conf-mapping/smoke-line coverage).

**Manual acceptance re-run after the round-1 fixes** (temporary in-crate `#[ignore]` harness against the freshly built `.app`, deleted afterwards; `mv` guarded by a `trap` that restores on exit). With `/opt/homebrew/opt/ghostscript` **and** `/opt/homebrew/Cellar/ghostscript/10.08.0` both renamed, the resolved search paths printed from the run were the bundle's `Contents/Resources/gs-resources/{Resource/Init,lib,Resource/Font,fonts}` + `iccprofiles`, and:

| Fixture | In | Out | Winning strategy |
|---|---|---|---|
| `sample.jpg` | 11 255 B | 5 076 B | `quality=30` (vips) |
| `sample.mp4` | 16 155 B | 6 590 B | `two-pass h264` (ffmpeg) |
| `sample.pdf` | 12 666 B | 10 714 B | **`gs dpi=72,jpegq=60`** |

Unchanged from round 0 (the PDF differs by 1 byte, within gs's own output nondeterminism). Homebrew verified restored afterwards: opt symlink present, keg present, no `.bak` left, `gs --version` → `10.08.0`.

**Round-1 note for Task 3:** `bundle-pdf-macos.sh` now **requires** the fetch-staged qpdf lib, so a Windows-side `prep-windows.mjs` must stage qpdf's own `lib/` dir before bundling (the msvc build ships VC-runtime DLLs, so the equivalent guard belongs there too). `prep.mjs` also now rejects Windows targets explicitly, so `all.mjs` cannot silently succeed.

**Notes for later tasks.**
- `prep.mjs` dispatches only macOS targets and fails with an explicit "Task 3" message for `-pc-windows-msvc` targets.
- Homebrew's ghostscript puts its resource dirs directly in `share/ghostscript/` (no version subdirectory); the stager handles both that layout and a version-subdir layout.
- `prep` needs `cpio` for the deterministic sorted resource copy.
- Task 3 needs the same `stagedSha256` treatment for its engine folders, and `sidecar_candidates_prefer_triple_then_plain_name` (`sidecar.rs`) still pins `len()==2`.

### Task 2 — PR review round 2 fixes

Round 2 confirmed the round-1 guards are genuinely dead (each revert reproduced a red test) but found several of them only half-fixed, one that could never fire at all, and a batch of untested new guards. Every fix below is pinned by a test **verified to go red when the guard is reverted**; the revert experiments are recorded in the PR.

1. **`assertAllEnginesStaged`'s executable check could never fire** (`!info.mode & 0o111` parses as `(!info.mode) & 0o111`). Fixed to `(info.mode & 0o111) === 0`; a staged `chmod 644` engine now aborts prep, and `0o744/0o711/0o111` are still accepted.
2. **A gutted font tree passed the whole audit.** The smoke's single `Resource/Init` sentinel said nothing about the font dirs — the live repro (real `gs_init.ps` + sentinel + five junk files, zero fonts) rendered a valid 2838-byte PDF with Homebrew's Helvetica, because `findfont` substitutes silently. Two more sentinels now live in `fonts/` and `Resource/Font` and the fixture `runlibfile`s all three (distinct names, so gutting *either* dir fails). `loadfont` was rejected on purpose: it is `/undefined` in gs 10.08 and would fail for the wrong reason.
3. **The qpdf guards were untested.** Four fixture-driven shell cases now cover them: a stale `frameworks/libqpdf.30.dylib` is replaced by the staged official lib (revert → FAIL), a `libqpdf*` collected from outside the staged dir is refused (revert → PASSES, i.e. the guard is gone), the staged lib wins over a resolvable `@loader_path` decoy (revert → FAIL), and an `@rpath` dep the staged dir cannot account for is refused (revert → PASSES).
4. **Sentinel staging was untested.** The happy path now asserts all three staged sentinel files and their marker text; dropping the `stage_gs_acceptance_sentinel` call turns three tests red.
5. **`prepTarget`'s wiring was untested.** A `prepTarget`-level test proves a url-sourced entry declaring `resources` aborts prep (the old loop was brew-only, which Task 3 would have hit) and that a non-executable staged engine aborts prep.

The remaining fixes: `fetchOne`'s unchanged fast path now requires the staged lib dir to exist and to match the lock, so the audit's own `require_staged_qpdf_lib` remedy is no longer a dead end (verified live: delete `src-tauri/.staging/` → fetch re-downloads and re-materialises; the next fetch reports `unchanged` again, so there is no loop). `fetch` records `libStagedSha256` per staged lib member — symlinks pinned by their target, because the official qpdf `lib/libqpdf.30.dylib` is one — and `bundle-pdf-macos.sh` verifies every digest **before** any rewriting (verified live: one flipped byte at `0x4000` → `FAIL … sha256 mismatch`, exit 1). The audit asserts the sentinels before running gs and names `yarn binaries:prep`, so a pre-sentinel tree no longer gets misdiagnosed as a Homebrew fallback; prep and verify assert them too. The cheap brew drift check moved **ahead** of `runBundleScripts`. `BINARIES_ALLOW_INACTIVE_BREW=1` is now a real allowance that states in the audit output that the gate is INACTIVE, so a brew-less CI runner can still cross-audit. The audit prints `note: gs clean-room smoke SKIPPED — …` and **fails** when `--target` was passed explicitly and that target's `gs` is not staged. Rust: `dir_has_file` is now recursive (parity with the JS gates), and a gs pass that fails while `gs_resources` is `None` now surfaces `SidecarFailed` naming the missing tree — preserving the original cause and suppressed when the tree *is* staged.

`brew list --versions` prints every installed keg with the active one **last**; prep and verify both took `fields[1]`, so on a host with two ghostscript kegs the drift gate compared against a stale version. Both now take the last field and the test that used to ratify the old behaviour was inverted. `verify.test.mjs` uses an explicit `PATH=/usr/bin:/bin` allowlist instead of `dirname(which lipo)`; `prep.test.mjs` no longer assigns `process.env.PATH` twice and every assignment is scoped through a `withPath` helper that restores it. The smoke's dir list is derived from the manifest's `resources` array (with `Resource` expanded to `Resource/Init` + `Resource/Font`) instead of five hardcoded names, and `prep` passes the same list to the bundle scripts via `FSO_GS_RESOURCE_DIRS`, so the audit can no longer demand a dir prep no longer stages. The bundle-pdf `cpio:` assertion could not fail (`mkdtempSync` returns a physical path, and Node's `spawnSync` resolves `cwd` physically, so the fixture symlinked neither side the code path needs); it is replaced by a falsifiable tree-identity assertion plus a test that runs the script with a genuinely logical symlinked root — reverting `copy_tree_sorted`'s physicalization then reproduces the original 10 `cpio: Cannot extract through symlink` errors and the FAIL exit. `audit_fails_when_iccprofiles_or_fonts_empty` is renamed to `audit_fails_when_iccprofiles_or_fonts_dir_has_no_files_at_all`.

**Gate.** `yarn build && yarn test && cd src-tauri && cargo test` → green: 377 vitest (was 338; +39), 406 cargo (was 404; +2). The live pipeline is still idempotent: `binaries:fetch` reports all three url engines unchanged, `prep` re-stages, and `binaries:audit` prints `gs clean-room smoke: PASS (3514 bytes, 5 staged resource flags, sentinel resolved)` followed by the byte-identical `sidecar audit: PASS (5 binaries, 71 framework dylibs)`.

**One more ordering consequence, found while verifying the digest gate live.** `bundle-vips-macos.sh` does `rm -rf "$FRAMEWORKS"` and re-collects, so any `bundle-pdf-macos.sh` failure leaves `frameworks/` holding only the vips closure (65 of 71 dylibs) and the next `cargo test` cannot even build (`Library not found: frameworks/libgif.dylib`). The digest gate therefore also runs as a **pre-flight in `prep.mjs`** (`assertStagedLibsPinned`, before `runBundleScripts`), with the shell check kept for direct `bash scripts/bundle-pdf-macos.sh` runs. Same principle as moving the brew drift check earlier: every cheap check runs before the first side effect.

**Round-3/4/5 corrections to the gates (all revert-verified).** Four structural holes survived the earlier rounds and are now closed:

1. **237 files under `Resource/` had no content gate anywhere.** `gs_smoke_required_dirs` expanded the declared `Resource` into only `Resource/Init` + `Resource/Font`, so gutting `Resource/CMap` (181 files), `Resource/Encoding`, `Resource/ColorSpace`, `Resource/Decoding`, `Resource/SubstCID`, `Resource/CIDFont`, `Resource/IdiomSet` or `Resource/CIDFSubst` in the brew prefix staged clean and audited PASS (reproduced live before the fix). gs derives `GS_LIBRESOURCE` from where it found `Resource/Init/gs_init.ps`, so the whole sibling tree is reached through that one path. Every layer now requires a real (non-sentinel) file per `Resource/*/` subdir: `assert_source_resource_subdirs_populated` in `bundle-pdf-macos.sh` (source side), `resourceSubdirsWithoutFiles` in `prep.mjs` and `verify.mjs` (staged side), and `gs_smoke_resource_subdirs` in the audit. `gs_smoke_required_dirs` emits the full declared list rather than special-casing `iccprofiles`. The audit's "every dir here is load-bearing" message was overstating coverage before this; it is now backed per-subdir.
2. **The sentinel list had two different definitions.** `prep.mjs` and `verify.mjs` hardcoded 3 sentinels while the shell staged and required 4, so deleting `lib/fso-sidecar-acceptance-lib-sentinel.ps` passed both JS gates and only the audit noticed. All four consumers now derive from `scripts/binaries/gs-sentinels.mjs`, and a test asserts the shell's staged sentinel dirs equal `gsSentinelPairs()`'s dirs, so a manifest `resources` change cannot desync prep/verify from the shell.
3. **The staging trees leaked and were untracked.** An aborted bundle left a 22–49 MB `src-tauri/.frameworks-staging.<pid>` / `gs-resources.staging.<pid>` tree that `git check-ignore` did not cover, so `git add -A` would have committed it. Both patterns are now ignored and both scripts `trap … EXIT`.
4. **The sentinel gate could pass vacuously on a transient `node` failure.** `gs_smoke_sentinels` re-shelled to `node -e` twice more after `gs_smoke_search_dirs` had already succeeded; on failure it emitted nothing, so `assert_gs_sentinels` iterated zero pairs and the fixture contained zero `runlibfile` lines — the audit exited 0 printing `sentinel resolved` while resolving nothing (reproduced with a stub `node` that fails on `node -e`). The pairs are now resolved once from the already-computed search dirs, and an empty list fails closed with a message naming the vacuity and `yarn binaries:prep`. A stub `node` that succeeds with empty output still trips it, so the guard is reachable, not decorative. The audit also went from 5 `node -e` calls to 3.

**`gs_clean_room_smoke` no longer runs with `errexit` suspended.** It was called as `if ! gs_clean_room_smoke …`, and bash suspends `errexit` for a function's entire dynamic extent in a condition — including the `set -e` it set as its first statement, and including `trap … ERR` (all four call forms verified empirically on this host). The function now records its own failure via `gs_smoke_failed` and returns 0, so it is called at top level with `errexit` live, and the two commands that could silently yield a bogus value (`size="$(wc -c …)"`, the fixture write) are explicitly guarded. Induced via a stub `wc`, the audit now aborts with `FAIL gs clean-room smoke: rendered <unreadable> bytes` instead of continuing.

**`sidecar.rs` was a fourth hand-copy of the sentinel contract, and its test was tautological.** The only Rust test built sentinel names from the Rust constant itself, so renaming `GS_SENTINEL_PREFIX` alone left `cargo test --lib` fully green: the staged sentinels stopped counting as sentinels, a `fonts/` + `Resource/Font` tree holding only sentinels resolved to `Some(GsResources)`, and gs would have been spawned with `-I` flags into a hollow tree — the "PDF silently breaks on clean machines" incident, live in shipped code. `gs_sentinel_constants_match_the_shared_javascript_module` now reads `scripts/binaries/gs-sentinels.mjs` through `CARGO_MANIFEST_DIR` and pins both the prefix and `GS_RESOURCE_SEARCH_DIRS` to it, and `sentinel_only_font_dirs_using_the_shared_module_names_do_not_resolve` reproduces the runtime consequence using the module's names instead of the Rust constant.

**Round-5 documentation corrections.** `docs/bugs.md` described the fixture as `runlibfile`ing *three* sentinels "one in `Resource/Init` and one in each font dir"; it has been four since `lib/` joined, and both passages now say so. The four `-sICCProfilesDir` occurrences in this plan's Task 2 body now read `-uICCProfilesDir` with a pointer to the deviation record below, so the plan no longer contradicts the tree or `pdf.rs`'s assertion that `-sICCProfilesDir` is never emitted.

**Gate (rounds 3–5 final).** `yarn build && yarn test && cd src-tauri && cargo test` → green: **418 vitest** (was 377; +41), **410 cargo** (was 406; +4). `yarn binaries:all --target aarch64-apple-darwin` stays green and idempotent, printing `gs clean-room smoke: PASS (…, 5 staged resource flags, sentinel resolved)` followed by the byte-identical `sidecar audit: PASS (5 binaries, 71 framework dylibs)`. `vitest.config.ts` is back to the 5 s default: the global 30 s bump added in round 4 was unjustified (slowest test 2.7 s) and the two shell-spawning tests that genuinely need headroom carry per-test timeouts instead.

**Round-2 note for Task 3:** the Windows prep must also stage the three acceptance sentinels (`assertGsResourcesStaged` and `verify.mjs` now require them for any entry declaring `resources`), and must pin its own engine-folder contents the way `libStagedSha256` pins the qpdf lib.
