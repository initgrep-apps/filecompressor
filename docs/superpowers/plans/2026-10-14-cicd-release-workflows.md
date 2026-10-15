# CI/CD Release Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHub Actions CI/CD: PR gate (no sidecar staging), manual freeze of macOS engines into `sidecars-*` release bundles, and a 4-triple release build (mac arm/x86, win x64/arm) publishing a draft GitHub Release on `v*` tags.

**Architecture:** Three workflows (`freeze.yml`, `release.yml`, `ci.yml`) + two bash scripts (`scripts/ci/freeze.sh`, `scripts/ci/unfreeze.sh`). macOS engines are nondeterministic to stage (Homebrew `vips`/`gs` with exact `expectVersion` pins), so they are frozen once per manifest bump into per-triple tarballs on a `sidecars-*` release (ADR 0001); release jobs unfreeze instead of running brew. Windows engines are URL+sha256-pinned in the manifest and staged fresh via `yarn binaries:all --target <triple>`. **Ruling (2026-10-15):** the gate (`yarn build && yarn test && cd src-tauri && cargo test`) must stage binaries first — tauri-build validates `externalBin` at build-script time (proven empirically) — so PR CI runs the same staging + verbatim gate (`ci.yml`: mac freeze row + windows manifest row, no ubuntu, win-arm tag-only).

**Tech Stack:** GitHub Actions, official `tauri-apps/tauri-action@v1` (release builds: app build + draft release + asset upload), actions/setup-node@v4 (Node 22), dtolnay/rust-toolchain@stable, Swatinem/rust-cache@v2, `yaml` devDep for workflow validation tests, vitest for script tests (existing pattern: `scripts/binaries/*.test.mjs`).

**Spec:** `docs/adr/0001-sidecar-freeze-bundles.md` + decisions from the 2026-10-14 grilling session. Supersedes Task 1 of `docs/superpowers/plans/2026-09-27-slice-9-devops-cicd-hardening.md` (its Tasks 2–6 are untouched and not part of this plan).

## Global Constraints

- **Targets — exactly 4 triples:** `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-pc-windows-msvc`, `aarch64-pc-windows-msvc`. Linux excluded (no manifest targets).
- **Runner labels pinned explicitly, never `-latest`:** release builds `macos-15` (arm64), `macos-15-intel` (x86_64), `windows-2025` (win x64), `windows-11-arm` (win arm); PR gate `ubuntu-24.04` + `windows-2025` (private repo bills mac at 10× — gate stays off mac).
- **Binaries only on tags:** pushes and PRs never build engine binaries or app bundles; only the test gate runs.
- **Triggers:** `ci.yml` on pull_request + push to main = gate only. `release.yml` on tag `v*` + workflow_dispatch = full builds. `freeze.yml` workflow_dispatch only.
- **Unsigned distribution:** mac engines stay ad-hoc signed (bundle scripts already do this); Windows binaries unsigned. No Apple/Windows cert secrets in this plan.
- **Releases:** app releases are always **draft** (tauri-action `releaseDraft: true`); tags containing `-rc` are additionally marked `prerelease: true`; final publish is manual (one click). The `sidecars-*` release is published directly (engines, not the app).
- **Supply chain:** every third-party action pinned to a full commit SHA at implementation time.
- **Yarn 1.x:** `yarn install --frozen-lockfile`. Node 22 via `actions/setup-node@v4` with `cache: yarn`.
- **GATE_COMMAND** (runs in release jobs after staging, in PR jobs bare): `yarn build && yarn test && cd src-tauri && cargo test`
- **No comments in code.** New scripts follow repo style (no license headers — existing scripts have none).
- Conventional commits: `ci(scope):`, `fix(scope):`, `test(scope):`, `docs:`.
- Windows jobs run bash steps via `bash scripts/...` (git-bash on runner images); `node scripts/...` steps are shell-agnostic.

## Review Focus

Failure modes the workflows imply but no happy-path test exercises:

1. **Frozen bundle missing or stale at release time** (no `sidecars-*` release, or sha mismatch) → the release job must fail loudly at unfreeze, never continue with partially staged engines. Pinned by unfreeze fail-closed tests (Task 1).
2. **Incomplete freeze** (an engine unstaged, empty `frameworks/`, missing `gs_init.ps`) → freeze.sh must refuse to package. Pinned by freeze refuse tests (Task 1).
3. **Tag ≠ `tauri.conf.json` version** → draft release under a wrong version string. Pinned by the version-sync step + workflows validation test (Task 3).
4. **Windows PE audit blind spot** (`audit-sidecars.sh` skips PE32 binaries; `file`/bash quirks on git-bash) → windows jobs still run the full `binaries:all` (prep payload checks + audit) and fail loudly, not silently skip. Pinned by workflows validation test asserting the step exists (Task 3); first CI run is the live test.
5. **Runner label drift** (`-latest` silently changes OS under the workflow) → workflows validation test rejects any `-latest` label anywhere (Task 2).

---

### Task 1: Freeze + Unfreeze Scripts

**Files:**
- Create: `scripts/ci/freeze.sh`
- Create: `scripts/ci/unfreeze.sh`
- Test: `scripts/ci/freeze.test.mjs`
- Test: `scripts/ci/unfreeze.test.mjs`

**Interfaces:**
- Consumes: staged trees `src-tauri/binaries/` (5 engines `-<triple>`), `src-tauri/frameworks/`, `src-tauri/gs-resources/` produced by `yarn binaries:all --target <triple>` (existing).
- Produces (Task 2, Task 3 rely on these):
  - `bash scripts/ci/freeze.sh --triple <mac-triple> [--root <repo-root>]` → writes `<root>/src-tauri/.freeze/sidecar-bundle-<triple>.tar.gz` + sibling `.sha256` file; exit 1 on incomplete tree or non-mac triple.
  - `bash scripts/ci/unfreeze.sh --triple <triple> [--archive <tarball>] [--root <repo-root>]` → with `--archive`: verify sibling `.sha256`, extract into `src-tauri/` (restoring `binaries/`, `frameworks/`, `gs-resources/`); without: download via `gh release list`/`gh release download` from the latest `sidecars-*` release (requires `GH_TOKEN`); exit 1 on missing archive, sha mismatch, or missing `gs-resources/Resource/Init/gs_init.ps` after extract.

**Acceptance Criteria:**
- Tarball contains paths rooted as `binaries/…`, `frameworks/…`, `gs-resources/…` so extraction lands directly in `src-tauri/`.
- Freeze accepts only the two mac triples; refuses partial trees (missing any of the 5 engines, empty `frameworks/`, missing `gs_init.ps`).
- Unfreeze fails closed: missing archive, sha mismatch, missing marker → nonzero exit, no partial extraction visible to subsequent steps (extract to temp, then swap).
- Tests build fixture trees (plain files suffice — freeze checks presence, not arch; arch is audit's job) and exercise: happy path + sha round-trip, missing engine refuse, empty frameworks refuse, unfreeze sha mismatch refuse, missing archive refuse.

- [x] **Step 1: Write failing tests** — `scripts/ci/freeze.test.mjs` + `scripts/ci/unfreeze.test.mjs` covering the cases above (spawn `bash`, fixture trees under a temp root; follow the spawn-and-assert style of `scripts/binaries/refresh.test.mjs`).

- [x] **Step 2: Run** `yarn test -- scripts/ci/freeze.test.mjs scripts/ci/unfreeze.test.mjs` — expect FAIL (scripts don't exist).

- [x] **Step 3: Implement freeze.sh + unfreeze.sh** to the interfaces above (tar.gz via `tar -czf`; sha256 via `shasum -a 256`; mac triple check with the same two literals as `scripts/binaries/lib.mjs` arch helpers).

- [x] **Step 4: Run** the two test files — expect PASS. Then run the full gate: `yarn build && yarn test && cd src-tauri && cargo test` — expect green.

- [x] **Step 5: Local smoke (real staged tree)** — `bash scripts/ci/freeze.sh --triple aarch64-apple-darwin` on this machine (staged aarch64 tree exists) → tarball + sha written; `bash scripts/ci/unfreeze.sh --triple aarch64-apple-darwin --archive <that tarball>` → PASS against the live tree.

- [x] **Step 6: Commit** — `ci: add sidecar freeze/unfreeze scripts`

---

### Task 2: Freeze Workflow + Workflow Validation Tests

**Files:**
- Create: `.github/workflows/freeze.yml`
- Create: `scripts/ci/workflows.test.mjs`
- Modify: `package.json` (devDependency `yaml` ^2)
- Modify: `.gitignore` (add `src-tauri/.freeze/`)

**Interfaces:**
- Consumes: `scripts/ci/freeze.sh` (Task 1); `node scripts/binaries/all.mjs --target <triple>` (existing).
- Produces: GitHub Release with tag `sidecars-YYYYMMDD` (UTC date of the run) containing `sidecar-bundle-<triple>.tar.gz` + `.sha256` for both mac triples; Task 3's `unfreeze.sh` downloads from it.

**Acceptance Criteria:**
- `freeze.yml`: `workflow_dispatch` trigger only; matrix include exactly `{triple: aarch64-apple-darwin, os: macos-15}` and `{triple: x86_64-apple-darwin, os: macos-15-intel}`; permissions `contents: write`.
- Job steps in order: checkout → setup-node (22, cache yarn) → `yarn install --frozen-lockfile` → `dtolnay/rust-toolchain@stable` (rustc is used by bundle scripts for triple detection) → `node scripts/binaries/all.mjs --target <triple>` → `bash scripts/ci/freeze.sh --triple <triple>` → `actions/upload-artifact@v4` (bundle + sha files).
- Finalize job (`needs: [freeze]`): `actions/download-artifact@v4` → create the published release via `gh release create "sidecars-$(date -u +%Y%m%d)"` with the bundle assets.
- `workflows.test.mjs`: parses every `.github/workflows/*.yml` with the `yaml` package and asserts: freeze.yml has workflow_dispatch + the exact 2-row matrix + a `scripts/ci/freeze.sh` step; **no workflow file anywhere contains a `-latest` runner label** (Review Focus #5); every `on:` section parses to valid triggers.

- [x] **Step 1: Add `yaml` devDep** — `yarn add -D yaml` (lockfile v1 updates `yarn.lock`).

- [x] **Step 2: Write failing `workflows.test.mjs`** with the assertions above (and a `README`-style array of the three expected workflow files so Task 3/4 extend it).

- [x] **Step 3: Run** `yarn test -- scripts/ci/workflows.test.mjs` — expect FAIL (freeze.yml missing).

- [x] **Step 4: Write `.github/workflows/freeze.yml`** per acceptance criteria. Add `src-tauri/.freeze/` to `.gitignore`.

- [x] **Step 5: Run** the validation test + full gate — expect green.

- [x] **Step 6: Commit** — `ci: add freeze workflow for mac sidecar bundles`

- [ ] **Step 7: Manual first freeze** — push branch, merge to main, run `freeze.yml` from the Actions UI once; confirm a published `sidecars-<date>` release with 4 assets (2 tarballs + 2 sha files). This unblocks Task 3.

---

### Task 3: Release Workflow (4-Triple Builds → Draft Release)

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `scripts/ci/unfreeze.sh` (Task 1) for mac jobs; `scripts/binaries/all.mjs` fresh staging for windows jobs; the `sidecars-*` release (Task 2).
- Produces: draft GitHub Release per `v*` tag with, per triple, the bundle artifacts + `sbom.json` / `THIRD_PARTY_LICENSES.md` (written to repo root by `yarn sbom`).

**Acceptance Criteria:**
- Triggers: `push` on tags `v*`; `workflow_dispatch` with `tag` input. Permissions `contents: write`.
- Matrix include, exactly:
  - `{triple: aarch64-apple-darwin, os: macos-15, stage: freeze}`
  - `{triple: x86_64-apple-darwin, os: macos-15-intel, stage: freeze}`
  - `{triple: x86_64-pc-windows-msvc, os: windows-2025, stage: manifest}`
  - `{triple: aarch64-pc-windows-msvc, os: windows-11-arm, stage: manifest}`
- Version-sync step (first step after checkout, every job): tag name minus `v` must equal `src-tauri/tauri.conf.json` `version` (node one-liner; Review Focus #3). workflow_dispatch uses the `tag` input instead of `GITHUB_REF_NAME`.
- Mac jobs: unfreeze (downloads latest `sidecars-*` bundle, verifies sha) → `yarn binaries:audit` (clean-room check of the frozen tree on this runner) → gate → `tauri-action`.
- Windows jobs: `node scripts/binaries/all.mjs --target <triple>` (fetch+prep+audit; Review Focus #4) → gate → `tauri-action`. Arm job adds `rustup target add aarch64-pc-windows-msvc` after toolchain setup.
- tauri-action step (all jobs; `tauri-apps/tauri-action` pinned to a full commit SHA referenced in the workflow): env `GITHUB_TOKEN: ${{ github.token }}`; inputs `tagName: 'v__VERSION__'` (action substitutes tauri.conf version — version-sync has already proven they match), `releaseName: 'File Size Optimizer v__VERSION__'`, `releaseDraft: true`, `prerelease` from an env boolean derived in the version-sync step (`resolved tag name contains '-rc'` — one shared expression for tag-push and dispatch paths), `args: '--target ${{ matrix.triple }}'`. Creates/updates the same draft release from every matrix job — **no finalize job**.
- SBOM deduped to one job: in the `aarch64-apple-darwin` job only, `yarn sbom` then `gh release upload <resolved tag> sbom.json THIRD_PARTY_LICENSES.md --clobber`.
- Rust caching: `Swatinem/rust-cache@v2` keyed per triple, `workspaces: src-tauri`.
- `workflows.test.mjs` (Task 2) extended: release.yml has the exact 4-row matrix, a version-sync step, an audit invocation (`binaries:audit` or `all.mjs`) per job, the gate, a `tauri-apps/tauri-action` step with `releaseDraft: true`, no finalize job, and no `-latest` labels.
- Contingency (decide on first CI run, document in commit message if applied): if MSI/WiX bundling fails on `windows-11-arm`, constrain that job's build to NSIS via workflow-specific `tauri.conf` arg `--bundles nsis`; if the `windows-11-arm` runner itself misbehaves (toolchain/billing/availability), drop win-arm → x64-only matrix and revisit.

- [x] **Step 1: Extend failing `workflows.test.mjs`** with the release.yml assertions.

- [x] **Step 2: Run** `yarn test -- scripts/ci/workflows.test.mjs` — expect FAIL (release.yml missing).

- [x] **Step 3: Write `.github/workflows/release.yml`** per acceptance criteria.

- [x] **Step 4: Run** validation test + full gate — expect green.

- [x] **Step 5: Commit** — `ci: add release workflow for 4-triple draft releases`

- [ ] **Step 6: Manual verify** — push, then `workflow_dispatch` release.yml (input `v0.1.0`); confirm all 4 jobs green and a draft release with ≥6 assets (4 bundles + sbom + notices); delete the test draft release.

---

### Task 4: PR Gate Workflow + Docs

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `AGENTS.md` (add a short `## CI/CD` section)
- Modify: `docs/superpowers/plans/2026-09-27-slice-9-devops-cicd-hardening.md` (supersede banner under `## Task 1`)

**Interfaces:**
- Consumes: staged engines per row (Ruling, user-approved 2026-10-15: `cargo test` fails on a clean checkout because tauri-build validates `externalBin` at build-script time — two implementers confirmed empirically — so the gate stages binaries; the old "gate runs bare / `#[ignore]`d test" claim is dead).
- Produces: PR/push gate feedback; docs pointing future contributors at the freeze flow.

**Acceptance Criteria:**
- **Ruling (user-approved after the cargo-build fact, supersedes the draft bullet below):** gate matrix = `{os: macos-15, stage: freeze}` + `{os: windows-2025, stage: manifest}` **with staging** — ubuntu cannot run the full gate (no Linux engines exist to stage); win-arm stays tag-only. Mac row: unfreeze (newest `sidecars-*` release, GH_TOKEN/GH_REPO) → `BINARIES_ALLOW_INACTIVE_BREW=1 yarn binaries:audit` → gate; windows row: `node scripts/binaries/all.mjs --target x86_64-pc-windows-msvc` → gate. Gate command verbatim, kept as ONE run string: `yarn build && yarn test && cd src-tauri && cargo test`.
  - <s>Superseded draft bullet:</s> matrix `{os: ubuntu-24.04}` + `{os: windows-2025}` + ubuntu system-deps step + bare gate — dead because the gate compiles the Rust core, which now validates `externalBin` at build-script time.
- Triggers `pull_request` (all branches) + `push` to main; concurrency group per ref, `cancel-in-progress: true`; permissions `contents: read` only; every `uses:` SHA-pinned (mirror freeze.yml/release.yml pins); no `tauri build`/tauri-action, no upload-artifact; `Swatinem/rust-cache@v2` keyed per os over `src-tauri`.
- `workflows.test.mjs` extended: ci.yml present and flipped to `current`; 2-row matrix exactly (macos-15 freeze + windows-2025 manifest — no ubuntu, no windows-11-arm, proof via `toEqual` + conjunction); staging steps present (unfreeze on the mac row, all.mjs on the windows row); gate command verbatim as one run string; no app-bundle build; no upload steps; cancel-in-progress true; contents:read only; SHA pins; no `-latest`; no raw `${{ }}` in run strings.
- AGENTS.md `## CI/CD` section (≤10 lines): the three workflows, what triggers them, and the freeze-before-tag rule from ADR 0001, plus the note that PR gate stages binaries because tauri-build validates `externalBin` at build time.
- Slice-9 plan Task 1 gets a one-line banner: superseded by this plan.

- [x] **Step 1: Extend failing `workflows.test.mjs`** with the ci.yml assertions.

- [x] **Step 2: Run** `yarn test -- scripts/ci/workflows.test.mjs` — expect FAIL.

- [x] **Step 3: Write `.github/workflows/ci.yml`** per acceptance criteria.

- [x] **Step 4: Update docs** — AGENTS.md CI/CD section + slice-9 Task 1 supersede banner.

- [x] **Step 5: Run** validation test + full gate — expect green.

- [x] **Step 6: Commit** — `ci: add PR gate workflow and document CI/CD`

---

## Execution Notes

1. Task order matters: Task 2's **manual freeze run** (Step 7) is a hard prerequisite for Task 3's full verification; the release.yml file itself can be written before the freeze release exists, but the manual dispatch verify needs it.
2. First CI runs are slow (~15–25 min windows/linux-like cold Rust). Expected; `rust-cache` pays off from run 2.
3. `workflows.test.mjs` needs the `yaml` devDep (Task 2 Step 1) before any of the three workflow-validation test groups can run.
4. Known live-run risks, fail loudly by design: git-bash `file` availability for windows arch verification, windows-11-arm linker/toolchain shape, MSI on arm64, ubuntu gate missing system deps on first run (contingencies in Tasks 3–4). Each first CI run is the test; adjust the workflow, not the audit's strictness.
5. `workflow_dispatch` version of release.yml creates tag `v<version>` via tauri-action if it doesn't exist yet (from the workflow's SHA). Testing with the input `v0.1.0` before a real tag push is safe: the draft gets deleted, the tag stays and gets reused by the real push.
