# File Size Optimizer — Project Config

## Overview

Offline desktop app for batch-optimizing files to maximum size limits. Tauri 2 + React + TypeScript + Vite + shadcn/ui. Rust core with sidecar binaries. GPLv3.

## Orchestrator Config

- `PLAN_GLOB` — `docs/superpowers/plans/*.md`
- `TECH_SPEC_PATH` — `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md`
- `PRD_PATH` — `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md` (original `initial-spec.md` retired 2026-10-05; the approved design spec supersedes it)
- `GATE_COMMAND` — `yarn build && yarn test && cd src-tauri && cargo test`
- `GATE_E2E_COMMAND` — `none`
- `BOUNDARY_RULES_REF` — `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md → Section 2: Architecture`
- `BUGS_PATH` — `docs/bugs.md`
- `CODE_PATHS` — `src/`, `src-tauri/src/`

## Tech Stack

- **Desktop:** Tauri 2.12 (Rust backend)
- **Frontend:** React 19.3 + TypeScript + Vite 8.3
- **UI:** shadcn/ui 4.21 + Tailwind CSS 4.3 (green oklch theme, preset `bNRvlrmDx`)
- **Font:** Inter (`@fontsource-variable/inter` 5.3)
- **Settings:** tauri-plugin-store 2.5
- **Dialog:** tauri-plugin-dialog 2.8
- **Shell:** tauri-plugin-shell 2.4
- **Async:** Tokio 1.53 + tokio-util 0.7 (via Tauri)
- **Image processing:** libvips 8.18 (`vips` sidecar)
- **Video processing:** FFmpeg 9.0 + ffprobe (sidecars)
- **PDF processing:** Ghostscript 10.08 + qpdf 12.4 (sidecars)
- **Document processing:** Rust `zip` 8.6 crate + vips sidecar
- **Rust deps:** serde 1.0, uuid 1.26, dirs 7.0
- **Package manager:** yarn
- **License:** GPLv3

## Architecture

See tech spec (link above) for full architecture, tech stack, and module boundaries. Key rule: frontend (`src/`) = UI only; Rust core (`src-tauri/src/`) = all compression logic. Sidecar binaries in `src-tauri/binaries/`.

## Setup

Scaffolded via `yarn create tauri-app` (React + TS + Vite). shadcn/ui via `yarn dlx shadcn@latest init --preset bNRvlrmDx --template vite`. Package manager: yarn.

## Skills & AI Docs

When working with a library, use its official AI docs/skill if available. Fetch via Context7 MCP or llms.txt URLs below.

| Library | Version | Skill / AI Docs |
|---------|---------|----------------|
| Tauri 2 | 2.12 | Context7: `/tauri-apps/tauri-docs` · llms.txt: `https://v2.tauri.app/llms.txt` |
| shadcn/ui | 4.21 | Skill: `shadcn` (already installed). llms.txt: `https://ui.shadcn.com/llms.txt` · MCP server available |
| React | 19.3 | Context7: `/websites/react_dev` · llms.txt: `https://react.dev/llms.txt` |
| Vite | 8.3 | Context7: resolve `Vite` · llms.txt: `https://vite.dev/llms.txt` |
| Tailwind CSS | 4.3 | No llms.txt. Context7: resolve `Tailwind CSS` |
| tauri-plugin-store | 2.5 | Covered by Tauri llms.txt — `https://v2.tauri.app/plugin/store` |
| tauri-plugin-dialog | 2.8 | Covered by Tauri llms.txt — `https://v2.tauri.app/plugin/dialog` |
| tauri-plugin-shell | 2.4 | Covered by Tauri llms.txt — `https://v2.tauri.app/plugin/shell` |

**Rules:**
- shadcn/ui components → use `shadcn` skill before adding/building components. Ask which shadcn block to use.
- Tauri APIs/plugins → fetch from Context7 `/tauri-apps/tauri-docs` before writing Tauri code.
- React patterns → fetch from Context7 or react.dev/llms.txt.
- Rust crates (tokio, serde, uuid, zip, dirs) → Context7 or crates.io docs. No llms.txt.

## Compatibility Notes

- shadcn/ui 4.x requires **Tailwind CSS v4** (CSS-based config, `@tailwindcss/vite` plugin — no `tailwind.config.js`)
- Vite 8.x uses **Rolldown** (Rust-based bundler) as default
- Tauri 2.12 requires Rust stable + Node.js 20+
- Tauri 3 alpha exists — do NOT use, stay on 2.x stable

## Conventions

- Conventional commits: `feat(scope):`, `fix(scope):`, `chore:`, `refactor(scope):`
- Rust: `#[serde(rename_all = "camelCase")]` for IPC structs, `#[serde(rename_all = "lowercase")]` for frontend-facing enums
- TypeScript: types in `src/types.ts`, matching Rust models
- React: hooks in `src/hooks/`, views in `src/views/`, components in `src/components/`
- shadcn: use existing blocks — ask which block to use. Do not build custom when a block exists.
- Theme: green oklch tokens from preset. Do not approximate with hex.
- No comments in code unless explicitly requested.