# CI/CD & DevOps — TBD

**Date:** 2026-10-02
**Status:** Placeholder — to be designed (revisit later)
**License:** GPLv3

---

## Purpose

Full industry-standard CI/CD flow for the app: build → test → publish (release), covering PR verification, merge protection, automated releases, signing, and binary drift. This spec was split out of `docs/superpowers/specs/2026-10-02-sidecar-binaries-release-design.md` so the sidecar pipeline and the release machinery can be designed independently.

## Carried-over details from the sidecar spec (verbatim, to revisit)

### Release workflow

`release.yml`: matrix of the 4 native runners; each job: checkout → Node + Rust (target added) → `yarn binaries:all --target` → gate (`yarn build && yarn test && cargo test`) → `yarn tauri build --target` → upload installer artifacts (`.dmg`, `.exe`/`.msi`) named by version + arch. Exact action versions and runner labels pinned in the implementation plan.

### Drift check

`binaries-drift.yml` (scheduled): runs refresh in dry-run mode and opens an issue when upstream versions move. Notification only — never auto-adopts.

### SBOM + licenses

`yarn sbom` generates `sbom.json` (engines + versions + licenses + hashes from the lock) and `THIRD_PARTY_LICENSES.md` (GPLv3 app must ship FFmpeg GPLv2+ notice, Ghostscript AGPLv3 notice + source pointer, vips LGPL, qpdf Apache). Artifacts attach to the release.

### Runners

`macos-latest`, `macos-15-intel`, `windows-latest`, `windows-11-arm`.

---

## Open design questions (for the design session)

1. **Code signing & notarization** — deferred. Options: Apple Developer Program + Windows signing (e.g. Azure Trusted Signing) from day one, Apple-only for v1, or unsigned with documented workarounds. Pipeline must be structured so signing slots in without restructuring.
2. **Full flow shape** — PR verification (gate must pass before merge), main-branch build, tag-based release, or manual release dispatch? Industry standard is: PR → required checks; merge to main → artifacts for testing; tag `v*` → signed release + SBOM + changelog.
3. **Versioning** — single source (`src-tauri/tauri.conf.json` version, per existing convention; `package.json` must match). Release notes/changelog generation (e.g. conventional commits).
4. **Caching & cost** — Rust build cache, Homebrew cache, binary fetch cache (vendor downloads repeat per job without it), yarn cache. Affects CI runtime significantly.
5. **Branch protection** — required status checks mapped to the matrix jobs.
6. **Existing overlap** — `docs/superpowers/plans/2026-09-27-slice-9-devops-cicd-hardening.md` (unbuilt plan) covers a 3-OS CI matrix, tauri-driver e2e, error boundary, version single-source, window state, temp cleanup. Its CI intent is superseded by this spec; its hardening tasks may need re-scoping when this design lands.
7. **Consumed interface** — this spec owns invoking `yarn binaries:*` + `yarn tauri build --target` per target (see sidecar spec §10 CI contract), not their implementation.

## References

- Sidecar binaries & release design: `docs/superpowers/specs/2026-10-02-sidecar-binaries-release-design.md`
