# File Size Optimizer

An offline desktop app that compresses files to a target size. Drag files in, pick nothing, press Compress — each file gets a size limit based on its type, and the app compresses it as close to that limit as quality allows.

Built with Tauri 2 (Rust) + React 19 + TypeScript. GPLv3.

## What it does

- **Category-based targets** — images ≤ 200 KB, videos ≤ 10 MB, PDF ≤ 2 MB, documents ≤ 1 MB by default. Editable in Settings.
- **Real engines, bundled** — libvips (images), FFmpeg (video), qpdf + Ghostscript (PDF). No internet needed, ever. Your files never leave your machine.
- **Originals are safe** — the app never modifies source files. Results go to a separate output folder (`~/Documents/Compressed` by default).
- **Batch workflow** — parallel compression with per-file progress, per-file cancel, and a history log (90-day retention by default).

Supported inputs: JPEG, PNG, WebP, HEIC/HEIF (→ JPEG) · MP4, MOV (→ MP4) · PDF · DOCX, XLSX, PPTX (embedded media recompressed).

## Status

- **macOS (Apple Silicon)** — verified end-to-end, including bundled engines.
- **Windows** — builds are not ready yet; PDF compression has a known Ghostscript packaging blocker (see `docs/bugs.md`).
- **Linux** — not packaged yet.
- No pre-built releases yet (CI/CD is still being set up). Build from source below.

## For users

Until installers are published, build from source (see next section). Then:

1. Open the app and drag files onto the drop zone (or click it to browse).
2. Press **Compress**. Progress shows per file; you can cancel any file or the whole batch.
3. Find the results in the output folder — use the reveal button on each row, or check the History view.

Targets, quality floors, output folder, and parallelism are configurable in **Settings**.

## For developers

### Prerequisites

- Node.js 20+ and [yarn](https://yarnpkg.com/)
- Rust stable
- Tauri 2 system dependencies for your platform: https://v2.tauri.app/start/prerequisites/

### Setup

```bash
yarn install
yarn binaries:all     # one-time: download + verify + stage the compression engines (~150 MB)
yarn tauri dev
```

> `cargo test` fails on a fresh clone until `yarn binaries:all` has run — the Tauri build config requires the engine binaries to exist.

### Checks before pushing

```bash
yarn build && yarn test && (cd src-tauri && cargo test)
```

### Scripts

| Command | What it does |
|---|---|
| `yarn binaries:all` | fetch → prep → verify → audit the sidecar engines (full pipeline) |
| `yarn binaries:fetch` | download engines, verify sha256 against the manifest, write the lock file |
| `yarn binaries:prep` | stage per-platform layouts (macOS dylibs, Windows engine folders) |
| `yarn binaries:verify` | check CPU architecture vs file name, versions vs lock |
| `yarn binaries:audit` | clean-room Ghostscript smoke test + supply-chain checks |
| `yarn binaries:refresh` | bump engine versions in the manifest + lock |
| `yarn sbom` | regenerate `sbom.json` + `THIRD_PARTY_LICENSES.md` from the lock |
| `yarn tauri dev` / `yarn tauri build` | run / build the desktop app |

### Project layout

```
src/                  Frontend — UI only, no compression logic
src-tauri/src/        Rust core — commands, queue, scheduler, processors, history
scripts/binaries/     Sidecar supply chain (manifest → lock → fetch → prep → audit)
docs/                 Architecture, capacity, bug log, specs and plans
```

Rule: `src/` renders and calls IPC; everything else lives in Rust.

### Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — how the app works, as implemented (diagrams, IPC surface, algorithms)
- [`docs/CAPACITY.md`](docs/CAPACITY.md) — resource usage at peak load + hardware requirements
- [`docs/superpowers/specs/`](docs/superpowers/specs/) — design specs · [`docs/superpowers/plans/`](docs/superpowers/plans/) — implementation plans
- [`docs/bugs.md`](docs/bugs.md) — bug triage log

## License

GPLv3 — see [`LICENSE`](LICENSE). Bundled engines keep their own licenses (FFmpeg GPLv2+, Ghostscript AGPLv3, libvips LGPLv3, qpdf Apache-2.0) — see [`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).
