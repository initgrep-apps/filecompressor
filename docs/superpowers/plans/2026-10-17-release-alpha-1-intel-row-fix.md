# Release v0.1.0-alpha.1 — intel-row fix + re-tag plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the one remaining live failure of `release.yml` (macos-15-intel row, `bundle-pdf.test.mjs` host-rustc coupling — already fixed and locally proven in this session), then drive the real tag through a clean 4-row release and publish `v0.1.0-alpha.1`.

**Architecture:** Reuse the snapshot pipeline exactly as built in `2026-10-16-cicd-snapshot-pipelines.md` — no workflow changes. The failing row's last failing step is a test-portability defect (fixtures pinned to `aarch64-apple-darwin` + script triple derived from the host `rustc -Vv`); the fix follows the file's own stub-rustc convention (`bundle-vips.test.mjs` `makeRoot`, `bundle-pdf.test.mjs` `makeGsFixture`). The re-release re-tags at the fix commit; the gate re-creates the draft; all four matrix rows rebuild. `sidecars-20261017` (8 assets, live-proven) is consumed unchanged.

**Tech Stack:** vitest (test-only diff), bash 3.2 git-bash-safe test helpers, official `tauri-apps/tauri-action` (SHA-pinned `a6e90dd`), gh CLI.

**Spec:** ADR 0001 (as amended) + `2026-10-16-cicd-snapshot-pipelines.md` (supersedes nothing; completes its Task 4) + RCA ledger `docs/bugs.md` → "Release v0.1.0-alpha.1 live-proof residue — RCA 2026-10-17".

## Global Constraints

- **100% GitHub-hosted runners; local machine is development only** (ADR 0001) — the fix must never introduce a local-build dependency, and the release must produce all four triples from runner builds.
- **Runners never make choices** — the gate keeps its fail-closed "release already exists" semantics this round (recovery documented); the draft idempotency candidate is deferred in `docs/ci-followups.md` item 8.
- **Freeze-before-tag rule intact** — no engine/manifest/pin change in this plan, so the existing `sidecars-20261017` snapshot stays governing; no freeze dispatch needed.
- **Tests that exec fixtures stay arch-explicit** — mac dylib fixtures pin `-arch arm64`; every fixture the verify/audit executes compiles universal (arm64 + x86_64) and is ad-hoc signed; any invocation that lets a bash script derive the triple from the ambient toolchain must stub `rustc` (pattern: `bundle-vips.test.mjs` `makeRoot` / `bundle-pdf.test.mjs` `makeGsFixture`).
- **Conventional commits; yarn 1 (`--frozen-lockfile`); Node 22 locally via nvm 22.22.2; no comments in code.**
- **Release draft hygiene** — draft-first, per-row app-asset check stays in the workflow; expected final asset set on the app draft = **10** (per row: `…_aarch64.dmg` + `…_aarch64.app.tar.gz`, `…_x64.dmg` + `…_x64.app.tar.gz`, `…_x64-setup.exe` + `…_x64_en-US.msi`, `…_arm64-setup.exe` + `…_arm64_en-US.msi`, plus `sbom.json` + `THIRD_PARTY_LICENSES.md`).

## Review Focus

1. **Host-triple coupling is the class, not the file** — every vitest invocation that execs a bash script deriving `TRIPLE` from `rustc -Vv` must be triple-stubbed; the intel runner (x86_64) is the only place the coupling turns into a failure today, but the fixture sidecar names (`qpdf-$TRIPLE`) make any host/fixture mismatch fatal. Pinned by the existing 25 stubbed tests + the two newly stubbed ones in `bundle-pdf.test.mjs`.
2. **The intel row's never-reached steps** — vitest was the only thing ever to fail there; `cargo test` never executed on that runner. De-risked locally (see RCA): `cargo check --all-targets --target x86_64-apple-darwin` clean, Rosetta-executed cargo test 421/422 (the 1 failure = local brew-glib GIO stall, runner audits green twice), frozen x86_64 bundle inspected (sha256 OK, 5 x86_64 sidecars, 71 dylibs). Residual: the row's real `tauri-action` dmg build; low (bundler arch-generic, inputs verified).
3. **No production-code drift** — the fix touches only test files + docs; `src-tauri/src/` untouched → the windows-target compile gate (`cargo check --all-targets --target aarch64-pc-windows-msvc`) is not required for this push.
4. **Draft asset completeness before publish** — the workflow's own per-row checks enforce it; the operator re-verifies the 10-asset set by hand before clicking publish.
5. **Local gate determinism** — on this arm64 dev machine with a restored sidecar tree, local gates need `PATH=$HOME/.nvm/versions/node/v22.22.2/bin:$PATH` and `GIO_MODULE_DIR=$(mktemp -d)` for any command that spawns the audit (brew glib keg stall — artifact, not a bug; CI runners unaffected, proven twice).

---

### Task 1: Land the intel-row test fix (fix is already in the working tree, locally verified)

**Files:**
- Modify: `scripts/binaries/bundle-pdf.test.mjs` (DONE — `stubRustcBin()` helper + PATH-prepended stub `rustc` in the two `sh()` staging-gate tests; verified below)
- Modify: `docs/bugs.md` (DONE — RCA section), `docs/ci-followups.md` (DONE — item 8)

**Evidence already gathered (do not redo):** with an ambient stub `rustc` printing `host: x86_64-apple-darwin`, the pre-fix file reproduces the CI failure byte-for-byte (2 failed | 25 passed, `FAIL sidecar missing: …/qpdf-x86_64-apple-darwin`); post-fix both the simulated-intel and native runs give 27/27 in that file; full `yarn test` = 43 files / 991 tests green on Node 22.22.2 after `yarn install --frozen-lockfile`.

- [ ] **Step 1: re-verify the fix under both conditions on the dev machine** (skip if the working tree already shows both green runs in this session)

```bash
PATH="/tmp/fso-intel-sim/bin:$PATH" yarn vitest run scripts/binaries/bundle-pdf.test.mjs   # stub dir from the RCA session; recreate if absent:
# mkdir -p /tmp/fso-intel-sim/bin && printf '#!/bin/sh\nprintf "rustc 1.88.0\\nhost: x86_64-apple-darwin\\n"\n' > /tmp/fso-intel-sim/bin/rustc && chmod +x /tmp/fso-intel-sim/bin/rustc
export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"
yarn build && yarn test && (GIO_MODULE_DIR=$(mktemp -d) cargo test --manifest-path src-tauri/Cargo.toml)
```
Expected: build ✓; 43 files / 991 tests ✓; cargo tests all pass locally (the audit-spawning test runs green with the GIO override; the two queue 5s-timeout tests are load flakes — rerun in isolation if they trip).

- [ ] **Step 2: commit on a task branch and open the PR** (repo convention: branch `task-2026-10-17-release-alpha-1-fix`)

```bash
git checkout -b task-2026-10-17-release-alpha-1-fix
git add scripts/binaries/bundle-pdf.test.mjs docs/bugs.md docs/ci-followups.md docs/superpowers/plans/2026-10-17-release-alpha-1-intel-row-fix.md
git commit -m "fix(tests): stub the fixture rustc host triple in bundle-pdf staging-gate tests"
git push -u origin task-2026-10-17-release-alpha-1-fix
gh pr create --title "fix(tests): stub the fixture rustc host triple in bundle-pdf staging-gate tests" --body "RCA: release run 39058511726 — macos-15-intel gate failed at bundle-pdf.test.mjs:239/253 (script derives TRIPLE from host rustc; the 2 direct sh() tests skipped the file's own stub convention). Local A/B proof attached in docs/bugs.md; PR gate must be green."
```
Expected: PR gate (ci.yml 2 rows) green.

- [ ] **Step 3: merge the PR** (squash or merge per repo convention; main must carry the fix commit before the tag moves)

### Task 2: Re-run the release for v0.1.0-alpha.1 (operator-driven, orchestrator-verifies)

**Files:** none (operational)

- [ ] **Step 1: delete the leftover draft + tag, re-tag at the fixed main**

```bash
gh release delete v0.1.0-alpha.1 --cleanup-tag --yes
git fetch origin && git tag v0.1.0-alpha.1 origin/main && git push origin v0.1.0-alpha.1
```
Expected: `release.yml` starts automatically (push of `v*`); gate creates the draft with `--prerelease`.

- [ ] **Step 2: verify the 4 rows green**

`gh run watch` (or the Actions UI). Expected: `aarch64-apple-darwin` ✓, `x86_64-apple-darwin` ✓ (first ever — gate now passes; tauri dmg build runs), `x86_64-pc-windows-msvc` ✓, `aarch64-pc-windows-msvc` ✓ — rows bounded 90 min each.
If a row fails: read `gh run view <id> --log-failed`; do NOT re-tag until the failure is diagnosed — the draft+tag recovery of Step 1 is the loop to repeat only after a fix lands.

- [ ] **Step 3: verify the draft asset set**

```bash
gh release view v0.1.0-alpha.1 --json assets --jq '[.assets[].name] | sort'
```
Expected: exactly 10 names — the 8 app artifacts listed in Global Constraints + `sbom.json` + `THIRD_PARTY_LICENSES.md`.

- [ ] **Step 4: publish + ledger**

Operator reviews and clicks publish. Record run id + tag + final asset list in `docs/ci-process.md` provenance line (pattern of the freeze ledger) and tick Task 4 of `2026-10-16-cicd-snapshot-pipelines.md`.

**Budget note:** each full release run bills ≈135+ runner-minutes (mac rows ×10 multiplier on the private Free plan; ≈10 gated PRs or ≈3 release runs per month) — run Step 1 only with Tasks 1-2 reviewed.