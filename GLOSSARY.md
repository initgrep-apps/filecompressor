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

**Shell**:
The persistent window frame around the views: sidebar, top bar, dialogs, and the providers that own their state. It never unmounts; only the active view changes.
_Avoid_: layout, chrome (window chrome is the OS frame — ADR 0007)

**Top bar**:
The 48px row across the content area: breadcrumb, theme toggle, ⋯ menu, and — on Windows/Linux — the window controls. While the sidebar is hidden it also carries the expand trigger and ☰. It doubles as the drag surface.
_Avoid_: header, title bar (the title bar belongs to the OS or the macOS overlay)

**Sidebar header**:
The 48px row atop the sidebar: the brand on non-macOS and mobile, and the collapse trigger at the right edge. Hidden with the sidebar when it collapses; the top bar takes over its actions.
_Avoid_: sidebar bar, sidebar toolbar

**Batch list**:
The scrollable list of history sessions inside the sidebar. Selecting a row focuses that batch's detail and adds its label to the breadcrumb.
_Avoid_: history list, sidebar list

**Batch**:
One Compress action: the files staged when the user presses Compress, processed as one unit. Batches never overlap.
_Avoid_: run, job, queue (a job is one file inside a batch)

**Session**:
A batch as recorded in history: a start record, one record per file, an end record. A session with no end record is `interrupted`.
_Avoid_: batch (in history context), log

**Staging list**:
The pre-batch file list the user builds by dropping or browsing files. Cleared by "New batch".
_Avoid_: queue, pending list

**Lane**:
The per-category queue inside a batch (image, video, pdf, document, other). One job runs per lane at a time.
_Avoid_: queue, pool

**Slot**:
A unit of the parallelism budget (`maxConcurrent`). Most jobs cost 1 slot; a video costs 2 so two encodes never overlap.
_Avoid_: thread, worker

**Target**:
The per-category size cap a batch aims for (image 200 KB, video 10 MB, PDF 2 MB, document 1 MB by default).
_Avoid_: limit, max size

**Quality floors**:
The user's minimum acceptable quality per category (image Q30, video CRF 28 at 480p, PDF 72 dpi / JPEGQ 15, document media Q40). The compressor stops here and delivers best effort rather than degrading further.
_Avoid_: limits, thresholds
