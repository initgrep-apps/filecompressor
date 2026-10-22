# Yard — Language

Offline desktop app: users batch-compress files to size targets; all compression engines ship inside the app. This glossary fixes the vocabulary used across code, scripts, docs, and CI.

## Language

**Engine**:
One of the five offline compression tools shipped inside the app: vips, ffmpeg, ffprobe, qpdf, gs.
_Avoid_: binary (ambiguous), tool, dependency

**Sidecar**:
An engine invoked by the Rust core as a separate OS process, not linked into the app binary.
_Avoid_: subprocess, CLI tool

**Target triple**:
A Rust-style platform identifier (e.g. `aarch64-apple-darwin`, `x86_64-pc-windows-msvc`) naming one build target. Four are supported; Linux has none.
_Avoid_: arch, platform (ambiguous)

**Manifest**:
`scripts/binaries.manifest.json` — the version-pinned download recipe stating, per target triple, where each engine comes from, its expected version, and its checksums.
_Avoid_: binary config

**Lock**:
`scripts/binaries.lock.json` — the provenance record of what was actually staged (versions, sha256 of downloaded artifacts and staged files).
_Avoid_: changelog

**Staged binaries**:
Engine files placed under `src-tauri/` (binaries, engines, frameworks, gs-resources) by the fetch/prep pipeline — the inputs `tauri build` consumes. Gitignored; re-staged per machine.
_Avoid_: built binaries

**Offline**:
The app property that compression works with no network and no package manager on the user's machine, because engines and their runtime files (frameworks, gs-resources) ship inside the package.
_Avoid_: embedded, self-contained

**Engines folder**:
The Windows staging layout `src-tauri/binaries/engines/<engine>/` holding each engine's exe with its DLLs; shipped as `resources/engines/` on Windows. macOS engines ship as externalBin instead.
_Avoid_: DLL dump

**Frameworks folder**:
The macOS dylib tree `src-tauri/frameworks/` collected from Homebrew by the bundle scripts and shipped in the .app's Frameworks; rewritten to `@rpath`.

**gs-resources**:
The staged Ghostscript resource tree shipped with the app so gs resolves fonts and ICC profiles locally instead of a Homebrew prefix.

**Bundle scripts**:
`scripts/bundle-vips-macos.sh` and `scripts/bundle-pdf-macos.sh` — make macOS engines self-contained: dylib collection, `@rpath` rewrite, rpath injection, ad-hoc signing.
_Avoid_: packaging script

**Freeze bundle**:
A version-pinned archive of one target triple's staged binaries, produced once and consumed by CI release builds instead of re-staging from Homebrew.
_Avoid_: cache, artifact (generic)

**Sidecars release**:
A dedicated GitHub Release (tag prefix `sidecars-`) holding freeze bundles for all target triples.

**Gate**:
The required pre-build test command (`yarn build && yarn test && cd src-tauri && cargo test`) that must pass on every platform.
_Avoid_: tests, checks
