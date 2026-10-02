# Sidecar Binaries & Release Design

**Date:** 2026-10-02
**Status:** Draft
**License:** GPLv3

---

## 1. Problem Statement

Two defects in the current sidecar setup, plus a structural gap:

1. **Wrong-architecture binary shipped (root cause of the ffmpeg incident).** `ffmpeg-aarch64-apple-darwin` and `ffprobe-aarch64-apple-darwin` are actually Intel x86_64 Mach-O binaries renamed to look like arm64. Cause: the slice-6 plan specified `evermeet.cx/ffmpeg`, which only distributes x86_64 builds. No gate caught it — `scripts/audit-sidecars.sh` checks linkage and signatures but never architecture. The built `.app` and `.dmg` carry Intel binaries that run under Rosetta 2 on Apple Silicon.

2. **Ghostscript resources are not bundled.** The `gs` sidecar resolves its resource/font/ICC files from a compiled-in Homebrew path (`/opt/homebrew/Cellar/ghostscript/...`). PDF compression currently works only on machines that happen to have Homebrew Ghostscript installed. A clean user machine would fail on real PDFs.

3. **No structural handling of platform × architecture.** Binaries are committed to git, built ad hoc on one machine, and there is no repeatable path to produce a correct release for any other OS/architecture.

This spec defines a data-driven, vendor-hosted binary pipeline (yarn-driven, CI-ready) that fixes both defects and covers macOS (arm64 + Intel) and Windows (x64 + arm64). Linux is explicitly deferred but enabled by the same schema.

## 2. Goals

- One command per target builds the app with correct, verified, self-contained binaries: `yarn app:build --target <triple>`.
- Architecture, version, and self-containment are **gated**, so a wrong-arch binary can never slip through again.
- The same yarn commands work locally (clone-on-target-OS manual testing) and in CI.
- Binaries are fetched from vendor release channels (no project-hosted mirrors), verified by checksum, and recorded in a committed lockfile.
- macOS and Windows, both architectures, are first-class release targets.

## 3. Non-Goals

- **Linux targets** (follow-on; manifest schema is target-keyed so they are added as entries, not redesign).
- **Project-hosted binary mirroring / redistribution.** Vendors host the artifacts; we fetch at build time. If a vendor prunes a pinned artifact, the fetch fails loudly and the refresh flow resolves it.
- **Runtime (first-launch) binary download** in the app. Breaks offline-first (spec §1) and signing; not pursued.
- **Auto-updating binaries post-release.** Binaries are pinned at build time; updates require a rebuild.
- **Git LFS or committing binaries to git.** Binaries/frameworks/resources directories become build artifacts, gitignored.

## 4. Target Matrix (First Scope)

| Target triple | OS | Arch | CI runner (phase 2) |
|---|---|---|---|
| `aarch64-apple-darwin` | macOS | Apple Silicon | `macos-latest` |
| `x86_64-apple-darwin` | macOS | Intel | `macos-15-intel` (retires Fall 2027) |
| `x86_64-pc-windows-msvc` | Windows | x64 | `windows-latest` |
| `aarch64-pc-windows-msvc` | Windows | arm64 | `windows-11-arm` |

Known shelf-life constraints (documented, not blockers):
- GitHub retires Intel macOS runners Fall 2027; Martin Riedl stops Intel macOS ffmpeg releases January 2027; Homebrew moved Intel macOS to Tier 3 (Sep 2026, no routine bottles). Intel Mac is supported for this release cycle; the documented migration path is MacPorts (prebuilt Intel packages) and, if necessary, a self-hosted Intel runner.
- `aarch64-pc-windows-msvc` Tauri support must be verified as an early task (Tauri docs confirm the target; VS ARM64 build tools are required).

## 5. Engine Source Inventory

One primary source per binary. Official release channels only; no mirrors or fallback lists.

| Binary | Platform | Source of record | Pin style | Version now |
|---|---|---|---|---|
| ffmpeg, ffprobe | macOS arm64 + Intel | Martin Riedl (`ffmpeg.martin-riedl.de`) | Versioned URL, permanent; vendor `.sha256` | 9.0.2 |
| ffmpeg, ffprobe | Windows x64 + arm64 | BtbN FFmpeg-Builds (GitHub releases) | Pinned release tag + asset; verify by `ffmpeg -version` | 9.0.x release branch |
| qpdf | all four | qpdf official GitHub releases | Exact asset, vendor sha256 | 12.4.2 |
| vips | macOS arm64 + Intel | Homebrew (`brew install vips`, on build host) | Host-built; version recorded in lock, audit fails on drift | 8.18.7 |
| vips | Windows x64 + arm64 | libvips `build-win64-mxe` GitHub releases | Exact zip (`x64-all` / `arm64-all`), GitHub digest | 8.18.7 |
| gs (Ghostscript) | macOS arm64 + Intel | Homebrew (`brew install ghostscript`, on build host) | Host-built; version recorded in lock, audit fails on drift | 10.08.0 |
| gs (Ghostscript) | Windows x64 | MSYS2 package `mingw-w64-ucrt-x86_64-ghostscript` | Exact package file + sha256 | 10.08.0-2 |
| gs (Ghostscript) | Windows arm64 | MSYS2 package `mingw-w64-clang-aarch64-ghostscript` | Exact package file + sha256 | 10.08.0-2 |

Notes:
- BtbN daily assets are pruned (~30 days of releases retained). Pin a tagged release; if the tag is pruned, `binaries:refresh` re-resolves. gyan.dev is not used (single-source principle).
- MSYS2 package URLs are version-addressed; mirrors eventually prune old files. Same refresh behavior.
- macOS `vips`/`gs` are the only engines with no downloadable artifact. The build host is the ingredient store; brew is not a runtime dependency of the app (libraries are repackaged into the bundle by prep scripts, resources are staged).

## 6. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ yarn scripts (package.json)                                       │
│   binaries:fetch ─ binaries:prep ─ binaries:audit ─ binaries:all  │
│   binaries:refresh      app:build --target <triple>               │
└──────────────┬───────────────────────────────────────────────────┘
               │ reads/writes
┌──────────────▼───────────────┐   ┌──────────────────────────────┐
│ scripts/binaries.manifest.json│   │ scripts/binaries.lock.json    │
│  intent: source + pin per    │   │ truth: resolved version, url, │
│  (binary, target)            │   │ sha256, date per (binary,     │
│  hand-edited                 │   │ target). Committed.           │
└──────────────┬───────────────┘   └──────────────▲───────────────┘
               │                                  │ written by fetch
┌──────────────▼──────────────────────────────────┴───────────────┐
│ Per-OS prep                                                       │
│  macOS: dylib collect + rpath rewrite + ad-hoc sign (extend       │
│         bundle-vips-macos.sh / bundle-pdf-macos.sh)               │
│         + stage gs resources (Resource/Init, lib, iccprofiles,    │
│           fonts) → src-tauri/gs-resources/                        │
│  Windows: engine folders with DLLs + gs resources staged          │
│           (src-tauri/binaries/engines/{vips,gs}/)                 │
└──────────────┬───────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────┐
│ audit-sidecars.sh (upgraded)                                      │
│  + arch-vs-name assertion (the missing gate)                      │
│  + version-vs-lock assertion (ffmpeg -version, vips --version,    │
│    qpdf --version, gs --version)                                  │
│  + gs resources presence + clean-room smoke                       │
│  + existing linkage/signature/rpath checks                        │
└──────────────┬───────────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────────┐
│ yarn app:build --target <triple>                                  │
│  binaries:all + tauri build --target                              │
└──────────────────────────────────────────────────────────────────┘
```

### 6.1 Directory layout (after change)

```
scripts/
  binaries.manifest.json      # committed — intent
  binaries.lock.json          # committed — resolved truth
  binaries/                   # NEW: fetch/prep/audit implementation
    fetch.mjs
    prep.mjs
    audit-helpers.mjs
  bundle-vips-macos.sh        # extended (existing)
  bundle-pdf-macos.sh         # extended (existing)
  prep-windows.mjs            # NEW: Windows DLL layout + gs resources
  audit-sidecars.sh           # extended (existing)
src-tauri/
  binaries/                   # gitignored — fetched per target
  binaries/engines/{vips,gs}/ # gitignored — Windows engine folders
  frameworks/                 # gitignored — generated (macOS dylibs)
  gs-resources/               # gitignored — staged Ghostscript resources
  tauri.conf.json             # externalBin + resources wiring
```

`.gitignore` gains: `src-tauri/binaries/`, `src-tauri/frameworks/`, `src-tauri/gs-resources/`.

### 6.2 Manifest schema (per (binary, target) entry)

```json
{
  "targets": {
    "aarch64-apple-darwin": {
      "ffmpeg": {
        "source": "martin-riedl",
        "url": "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
        "sha256": "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
        "member": "ffmpeg",
        "dest": "ffmpeg",
        "expectVersion": "9.0.2"
      },
      "gs": {
        "source": "brew",
        "formula": "ghostscript",
        "expectVersion": "10.08.0",
        "resources": ["Resource", "lib", "iccprofiles", "fonts", "fonts/default"]
      }
    }
  }
}
```

Entry styles: `url` (exact artifact), `release_tag` + `asset` (pinned GitHub release), `source: brew` + `formula` (host build). All entries carry `expectVersion` and, where available, `sha256`.

### 6.3 Lockfile semantics

- `binaries.lock.json` records, per (binary, target): resolved version, source URL, sha256, fetch date.
- `binaries:fetch` verifies every download against the lock when the lock has an entry; mismatches abort.
- `binaries:refresh` re-resolves the latest matching version, updates the manifest pin + lock, and re-runs audit. This is the only path that changes versions. Refresh is a deliberate act; the resulting diff is reviewable.
- If a vendor pruned a pinned artifact: fetch fails loudly → run refresh → re-test → commit.

## 7. Commands

| Command | Behavior |
|---|---|
| `yarn binaries:fetch --target <triple>` | Download vendor artifacts, verify checksum + version, stage into `src-tauri/binaries/` (+ engine dirs, `gs-resources/` staged by prep), write lock entry. macOS `vips`/`gs` (brew) are owned by prep, not fetch. |
| `yarn binaries:prep --target <triple>` | Make self-contained: macOS dylib collect + rpath + sign + gs resource staging; Windows engine folders + DLLs + gs resources |
| `yarn binaries:audit --target <triple>` | Architecture-vs-name, version-vs-lock, linkage/signature, gs resource presence, clean-room gs smoke. Target resolution: host triple by default; explicit `--target` supported. |
| `yarn binaries:all --target <triple>` | fetch → prep → audit |
| `yarn binaries:refresh --target <triple>` | Re-resolve latest, update manifest + lock, then `binaries:all` |
| `yarn app:build --target <triple>` | `binaries:all` + `tauri build --target <triple>` (Tauri runs the frontend build via `beforeBuildCommand`) |
| `yarn sbom` | Generate `sbom.json` + `THIRD_PARTY_LICENSES.md` from the lock (section 10) |

Default target = host triple (fresh clone on a machine: `yarn app:build` just works). The same commands run in CI (phase 3) — no CI-only logic.

## 8. Per-Platform Prep Detail

### 8.1 macOS (both arches)

- ffmpeg/ffprobe/qpdf: downloaded artifacts, copied to `binaries/{name}-{triple}`. Vendor artifacts verified by sha256.
- vips/gs: installed via brew on the build host; `bundle-vips-macos.sh` / `bundle-pdf-macos.sh` extended to also collect and stage Ghostscript resources into `gs-resources/` (from the brew Cellar `share/ghostscript/<ver>/{Resource,lib,iccprofiles,fonts}`).
- All Mach-O: dylib collect → `install_name_tool` @rpath rewrite → ad-hoc sign (existing scripts, unchanged mechanics).
- Audit asserts exact brew versions against the lock (drift forces a deliberate refresh).

### 8.2 Windows (both arches)

- ffmpeg/ffprobe: static BtbN executables; copied to `binaries/{name}-{triple}.exe` (externalBin).
- qpdf: official msvc build **is not fully static** (ships VC runtime DLLs) → staged into `binaries/engines/qpdf/` with its DLLs and shipped via `bundle.resources`, like vips/gs.
- vips: MXE zip (`vips-dev-<arch>-all-<ver>.zip`) → `binaries/engines/vips/` containing `vips.exe` + all DLLs; shipped via `bundle.resources`.
- gs: MSYS2 package extracted → `binaries/engines/gs/` containing `gswin64c.exe` (renamed to the expected name), `libgs-*.dll` + dependent DLLs, and `gs-resources/` (Resource/Init, lib, ICC, fonts); shipped via `bundle.resources`.
- DLL resolution: the Rust spawner prepends the engine folder to the child process `PATH` (no global state).
- `tauri.conf.json` `bundle.resources` maps `binaries/engines/` and `gs-resources/` into `$RESOURCE`.

### 8.3 Rust changes

- `src-tauri/src/sidecar.rs`: add `("windows", "aarch64") => "aarch64-pc-windows-msvc"` (currently missing).
- Resolution candidates gain the Windows engine-folder layout and the `gs-resources` directory (candidate lists, existing pattern).
- gs spawn: pass resource flags resolved from `gs-resources` (search paths for Init/lib/fonts, ICC profiles dir). Exact flag set pinned by the clean-room test — the app must work with **no** brew/system Ghostscript present.
- All new logic unit-tested (triple mapping, resource path resolution, arg construction).

## 9. Audit (the gate that was missing)

`audit-sidecars.sh` gains:

1. **Arch-vs-name assertion** — parse the expected arch from the filename triple; verify with `lipo -archs` (Mach-O) / `file` (PE/ELF). A file named `*-aarch64-*` whose content is x86_64 **fails**. This directly encodes the regression test for the ffmpeg incident.
2. **Version-vs-lock assertion** — run each engine's version command; compare to lock. Drift fails.
3. **gs resource presence** — `gs-resources/Resource/Init/gs_init.ps` and font/ICC directories non-empty.
4. **Clean-room gs smoke** — spawn gs with only bundled resources and env stripped of Homebrew paths; render/compress a fixture; assert exit 0 and output bytes.
5. Existing checks retained: no absolute non-system dylib paths, @rpath deps present in `frameworks/`, valid signatures, tauri.conf ↔ frameworks consistency.

## 10. CI Contract (consumed by the CI/CD spec)

The full CI/CD flow is defined in `docs/superpowers/specs/2026-10-02-cicd-devops-tbd.md` (placeholder — to be designed). This spec only commits to the interface CI consumes:

- The binary steps are exactly the local yarn commands: `yarn binaries:fetch|prep|audit|all --target <triple>` then `yarn tauri build --target <triple>`. No CI-only binary logic.
- CI must run on: `macos-latest`, `macos-15-intel`, `windows-latest`, `windows-11-arm` (one job per target triple).
- Runners need: Node, Rust with the target installed, Homebrew (macOS jobs, for vips/gs ingredients), network access to vendor URLs.
- `yarn sbom` (section 7) ships in this spec's scope; attaching artifacts to a release is the CI/CD spec's scope.
- Drift detection (`binaries:refresh --dry-run`) is a scheduled CI concern owned by the CI/CD spec.

## 11. Testing Strategy

| Layer | Test |
|---|---|
| Manifest/lock | schema validation; fetch aborts on sha mismatch (fixture) |
| Audit unit | fixtures: correct binaries pass; **Intel binary named arm64 fails**; version drift fails; missing gs resources fail |
| Rust | triple mapping incl. win-arm64; resource path resolution; gs arg construction; Windows engine-folder candidates |
| Per-target smoke (CI) | real engines compress fixtures (1 image, 1 video, 1 PDF) through the processor layer with fetched binaries |
| Manual acceptance | per combo, documented in an acceptance table: image + video + PDF round trip, output plays/opens |

## 12. Risks & Constraints

| Risk | Mitigation |
|---|---|
| Intel mac runner retires Fall 2027; Riedl stops Intel ffmpeg Jan 2027; brew Intel Tier 3 | Documented migration: MacPorts prebuilt archives for vips/gs, self-hosted Intel runner if needed; Intel remains supported this cycle |
| Windows arm64 Tauri support unverified | Early verification task before other work depends on it |
| brew version drift (no versioned installs) | Lock + audit version gate; refresh is the only version-changing path |
| Vendor prunes pinned artifact (BtbN dailies, MSYS2 mirrors) | Fetch fails loudly → refresh flow; single-source principle accepted |
| gs resources subtlety (fonts/ICC) across platforms | Clean-room smoke test in audit + CI per target |
| App size grows (~150 MB+ engines per target) | Accepted; binaries are per-target build artifacts, never committed |

## 13. Execution Order (for the implementation plan)

1. Manifest + lock + fetch/audit scaffolding; arch assertion (fixes the ffmpeg incident immediately for mac arm64).
2. macOS arm64 complete pipeline + gs resources + Rust changes + tests (local manual verification).
3. Windows x64 + Windows arm64 prep scripts (verified by cloning repo on those OSes).
4. macOS Intel target.
5. SBOM generation (`yarn sbom`).

Each step is independently verifiable; phases 2–4 may be reordered after step 1 lands. The implementation plan (separate document) will break these into tasks with required tests per the repo's plan conventions. CI/CD workflows are out of scope for this plan and live in `docs/superpowers/specs/2026-10-02-cicd-devops-tbd.md`.
