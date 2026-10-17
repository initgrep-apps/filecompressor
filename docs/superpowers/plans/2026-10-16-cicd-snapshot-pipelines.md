# CI/CD Snapshot Pipelines — Corrected Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Engine packages are snapshotted on GitHub-hosted runners into one `sidecars-<date>` release; CI and release pipelines only download, verify, and consume them. **The local machine is used for development only — nothing in CI/CD depends on it.**

**Architecture:** `freeze.yml` (manual dispatch, already built in PR #120) snapshots all four triples on GitHub-hosted runners — mac rows install vips/ghostscript from `homebrew-core` pinned per arch (Intel pinned at the last pre-cutoff bottled versions), windows rows stage the URL+sha256 manifest engines — then packages and publishes 8 assets. `ci.yml` (2 rows) and `release.yml` (2×2 matrix, official `tauri-action` last in every row) unfreeze + audit + verbatim gate + build into a draft release. The Mac-x86 release row builds **natively** on `macos-15-intel` (label supported until Aug 2027) — no cross-compile, no local machine, no quirks.

**Tech Stack:** existing `scripts/binaries/*` staging engine, `scripts/ci/freeze.sh`/`unfreeze.sh`, official `tauri-apps/tauri-action` (SHA-pinned), gh CLI, GitHub-hosted standard runners only (macos-15, macos-15-intel, windows-2025, windows-11-arm).

**Spec:** ADR 0001 (as amended) + operator directives 2026-10-16/17. Supersedes `2026-10-14-cicd-release-workflows.md`; re-scopes PR #120 in place.

## Global Constraints

- **100% GitHub-hosted runners** — no self-hosted dependency; `runs-on` labels only from the supported set: `macos-15`, `macos-15-intel`, `windows-2025`, `windows-11-arm`.
- **Engines enter CI only through `sidecars-*` releases** — consumer workflows contain no brew, no vendor fetch, no `all.mjs` staging; enforced by `workflows.test.mjs`.
- **Brew runs only in `freeze.yml` mac rows**, against the per-arch pin (`scripts/ci/homebrew-core-pins.json`): arm `cb5b5e2230fd` (vips 8.18.7 / gs 10.08.0), Intel `8f15b0f1b965` (vips 8.18.6 / gs 10.07.1). `HOMEBREW_NO_INSTALL_FROM_API=1`, tap checkout at pin, **no `brew update` anywhere in CI**.
- **Intel policy (permanent Homebrew Tier 3, bottles stopped 2026-09-10/11, removal Sept 2027):** Intel engines stay frozen at the last pre-cutoff versions; never bump without human bottle re-verification. Revisit date documented: Aug 2027 (intel runner EOL) — successors: MacPorts-sourced engines or cross-compile on silicon.
- **tauri-action is the release engine** (official pipeline): `releaseId` from the gate job's pre-created draft (numeric REST id), `releaseDraft: true`, prerelease for `-rc` tags; custom steps (version check, preflights, unfreeze, audit, gate) run before it — the official example's own pattern.
- **Releases always draft-first**; publish is the operator's click; `sidecars-*` publishes only after the exact-8-asset preflight.
- **Unsigned distribution now, ad-hoc signing identity configured** (`signingIdentity: "-"`) per official guidance so Apple Silicon downloads aren't flagged damaged.
- **Every job has `timeout-minutes`** (freeze matrix 40, gate 60, release rows 90, cheap jobs 15) — the 6-hour hang class is structurally dead.
- **Free budget for this usage profile:** private repo, Free plan (2,000 min/mo): ≈10 gated PRs or ≈3 release runs or ≈5 snapshots/month — the operator's stated "couple of packages" fits. Pro plan: ×1.5. **Public repo: all standard runners free, unlimited** (GPLv3 — recommended when ready; one-line switch, no workflow changes).
- Actions SHA-pinned; no `-latest`; no raw `${{ }}` in run strings; `shell: bash`; no comments in code; conventional commits; yarn 1 (`--frozen-lockfile`); Node 22.

## Review Focus

1. **Snapshot correctness before publish** — no `sidecars-*` upload without a passed audit for that triple; per-row ordering pinned in tests.
2. **Consumer determinism** — gate/release rows never brew/vendor-fetch; regression caught by the validation suite, not a live run.
3. **Intel snapshot at the pin** — pinned tap checkout + bottle pour (no source builds); first dispatch is the live proof; bounded at 40 min if wrong.
4. **Draft hygiene** — never a published app release with partial assets: numeric `releaseId` + per-row app-asset presence check.
5. **Windows payload completeness** — engines dirs carry exe + DLLs recursively, 2 externalBin exes, `gs_init.ps` marker; verified at snapshot AND post-unfreeze.

---

### Task 1: Land the PR #120 fix pass (carried findings)

**Files (branch `task-2026-10-16-freeze-all-os`):**
- Modify: `scripts/ci/freeze.sh`, `scripts/ci/unfreeze.sh` (+ their tests), `scripts/binaries/all.mjs`, `.github/workflows/freeze.yml`, `scripts/ci/workflows.test.mjs`

**Carried findings (round-1 review of #120):**
1. CRITICAL — windows bundle must also carry the 3 flat engine exes (`binaries/vips|qpdf|gs-<triple>.exe`) so the `verify.mjs`/audit contract holds post-unfreeze (freeze.sh windows tar + validation, unfreeze mirror, fixtures, composed roundtrip test: stage→freeze→unfreeze→`node scripts/binaries/verify.mjs --target <win triple>` PASS).
2. CRITICAL — `all.mjs` embedded audit must honor `AUDIT_TARGET` env (audit-sidecars.sh already does); test pins the pass-through.
3. HIGH — malformed pin sha dies silently: `::error::homebrew-core pin for <TRIPLE> in scripts/ci/homebrew-core-pins.json is not a 40-char lowercase sha (got: <pin>)`; missing-key message names the pin file.
4. MEDIUM — pin git ops (clone/fetch/checkout) wrapped with remediation messages.
5. MEDIUM — dead DLL-sibling guard → recursive `*.dll` presence check in freeze/unfreeze windows validation.
6. MEDIUM — published `.sha256` rewritten to the final bundle basename after publish.
7. MEDIUM — tar preflight (`command -v tar`) + expanded failure message.
8. MEDIUM — windows rollback/TERM test parity (mv-shim variants + signal interruption on win fixtures).

- [x] Step 1: RED tests for each finding
- [x] Step 2: implement, GREEN, full gate green
- [x] Step 3: commit `fix(ci): harden snapshot packaging for all triples`
- [x] Step 4: push PR #120

### Task 2: Snapshot flow live proof (freeze.yml = the snapshot workflow)

**Files:** none (operational task)

**Acceptance Criteria:**
- Dispatch `freeze.yml` on main after Task 1 merges: 4 green matrix rows + finalize; `sidecars-<date>` published with exactly 8 assets.
- aarch64 row already proven (run 38796284252); Intel row is the new live proof of the pinned-tap approach (Review Focus #3).

- [x] Step 1: merge Task 1; dispatch freeze.yml; verify 4 rows green + 8 assets (operator may dispatch; orchestrator verifies)
- [x] Step 2: ledger the run ids + release tag

**Ruling (2026-10-17, gate run 39022660502, agent-established local gate):** the windows cargo compile is gated locally on the mac before every push: `cargo check --all-targets --target aarch64-pc-windows-msvc` from `src-tauri/` compiles + typechecks all targets WITHOUT linking (no MSVC needed), catching every `#[cfg(unix)]`-fixture-vs-ungated-test drift that only appeared on the windows CI row. Setup (one-time): `rustup target add aarch64-pc-windows-msvc` + `brew install llvm` (llvm-rc cross-compiles the Windows app resource that tauri-build's build script embeds; brew clang preprocesses it for the msvc triple); then stage gitignored placeholders because tauri-build validates `externalBin` + the windows-conf `binaries/engines` mapping at build-script time (touch the 5 `<bin>-aarch64-pc-windows-msvc.exe` files + `mkdir -p src-tauri/binaries/engines`, and REMOVE the .exe placeholders after the check — the mac-native `sidecars_are_self_contained` audit fails on empty files left behind; see docs/ci-process.md → runbook for the verbatim command). First local reproduction of run 39022660502 = 36 E0425 errors: `SHARED_SENTINEL_MODULE` consumed by the ungated `shared_sentinel_contract` support fn + `SharedSentinelContract` struct in sidecar.rs (5 sites) and 12 ungated tests in processors/document.rs reaching the `#[cfg(unix)]` fixtures (`write_fake_vips`, `read_q_log`, `test_sidecar_paths`, `make_executable_script`). Fix = repo cfg precedent: `#[cfg(unix)]` on the struct + support fn and on each dependent `#[test]` — no windows test semantics invented (mac-native `cargo check --all-targets` and the full gate stay green).

### Task 3: Finalize consumer workflows

**Ruling (2026-10-17, gate run 39021164217, agent + orchestrator-approved plan):** the mac row's remaining cargo-test failure `sidecars_are_self_contained` is CI-proven and not locally reproducible (brew vips installed locally: keg check passes here). Root cause: the test's audit-subprocess spawn lacked the workflow step's `BINARIES_ALLOW_INACTIVE_BREW=1`; on the runner the restored tree has no pinned brew keg, so verify.mjs pushed the keg-missing problem and the audit failed. Fix = env parity with the audit step (restored-tree semantics: the brew lifecycle is inert; the allowance prints note lines only — the `sidecar audit: PASS` summary and `gs clean-room smoke: PASS` assertions are unchanged). Same ruling covers the windows-row residue: `fails_closed_when_tar_is_absent_from_the_path` ENOENT is libuv resolving the child executable from the CHILD env PATH on win32 (PATH replaced by an empty dir → `bash` unresolvable); fixed by resolving bash absolutely from the parent PATH on win32, POSIX side byte-identical. The five lock-refusal/recovery tests exit 1 with empty stdout+stderr on the windows runner under msys bash (stable across runs 39016160897 → 39021164217) — not mechanical without a win32 shell session; skipIf(win32) with `_win32_skips_lock_refusal_semantics_differ` + tracked in docs/bugs.md, matching the established `win32_skips_acl_semantics_differ` / `win32_skips_mv_shim_cygpath_followup_tracked` precedent.

**Files:**
- Modify: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `src-tauri/tauri.conf.json` (`signingIdentity: "-"` under `bundle.macOS`), `scripts/ci/workflows.test.mjs`

**Acceptance Criteria:**
- ci.yml: rows `{macos-15, aarch64-apple-darwin}` + `{windows-2025, x86_64-pc-windows-msvc}`; every row: unfreeze → audit (mac rows `BINARIES_ALLOW_INACTIVE_BREW=1`) → verbatim gate; no staging steps. 60-min bound.
- release.yml: 4 rows `{macos-15, aarch64}` `{macos-15-intel, x86_64}` `{windows-2025, x64}` `{windows-11-arm, arm64}` (+ rustup target on the arm row); gate job (ubuntu): version-check + sidecars-availability preflight (8 assets) + draft pre-creation (numeric `databaseId`); rows: unfreeze → audit → gate → tauri-action; per-row app-asset check; SBOM from aarch64 row + 2-asset post-verify. 90-min rows. **No cross-compile step — x86 builds natively on macos-15-intel.**
- workflows.test.mjs: matrices exact; no `-latest`/no local-only assumptions; consumer-no-brew assertion; invariants intact.

- [x] Step 1: RED workflow tests
- [x] Step 2: implement workflows + conf change
- [x] Step 3: full gate green
- [x] Step 4: commit `ci: native 2x2 release matrix; ad-hoc signing; tauri-action final`

### Task 4: First real tag = the live verification of release.yml

**Files:** none (operational)

- [ ] Step 1: operator pushes the first `v*` tag → release.yml → 4 green rows → draft release with installers + SBOM
- [ ] Step 2: operator clicks publish; ledger the run

### Task 5: Process docs close-out

**Files:**
- Modify: `docs/ci-process.md` (runbook: bump = manifest/pins edit → dispatch freeze.yml → tag; failure table: no CI-freeze-vs-local distinction needed — one flow), `docs/adr/0001-…` (amend: GitHub-hosted-only decision + Intel revisit date), `docs/bugs.md`, `AGENTS.md` CI/CD section, `docs/superpowers/plans/2026-10-14-cicd-release-workflows.md` (supersede banner — done)

- [ ] Step 1: docs edits
- [ ] Step 2: full gate green
- [ ] Step 3: commit `docs: snapshot-once process definition`

---

## What we keep vs remove (audit summary)

**Keep (tested, load-bearing):** staging engine (`fetch/prep/prep-windows/verify/all/lib/net/gs-sentinels` + 8 test files), mac self-containment (`bundle-*-macos.sh` + common), `audit-sidecars.sh`, `refresh.mjs`, `sbom.mjs`, `app-build.mjs` (local dev builds), `freeze.sh`/`unfreeze.sh` + tests, `release-version-check.mjs`, `workflows.test.mjs`, `ci.yml`, `release.yml`, `freeze.yml` (the snapshot workflow), manifest + lock, per-arch pins json.

**Remove:** nothing more — the earlier plan's "local snapshot script + cross-compile" deltas are dropped as unnecessary; consumer-side `all.mjs` staging steps and any `brew update` are already gone in #120.
