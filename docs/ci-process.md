# CI process definition

States, owners, and commands for the freeze/unfreeze CI model (ADR 0001, 2026-10-16). The invariant: runners never make choices. Brew runs only inside `freeze.yml` mac rows against the pinned `homebrew-core` commit; every consumer restores its engines from the frozen release.

## 1. Artifact flow

```
operator                freeze.yml                       consumers
────────                ──────────                       ─────────
edit manifest ─┐                                         PR gate (ci.yml)
commit ────────┤   gate: tag-collision preflight          every row, per triple:
click freeze   │         ↓                                unfreeze --triple <t>
               │   freeze matrix (4 rows, 40 min)  →  sidecar-bundle-<t>.tar.gz + .sha256
               │     mac rows: pin checkout → brew     → clean-room audit → verbatim gate
               │       install (pinned tap) → all.mjs  
                    → freeze.sh --triple
               │     win rows: all.mjs (URL+sha256)  →  draft release (v*)
               │       → freeze.sh --triple        →    unfreeze → audit → gate
               │         ↓                              → tauri-action (releaseDraft)
               │   finalize (15 min): preflight 8        → app-asset check per triple
               │       → draft sidecars-<date>
               │       → upload 8 assets → verify → publish
               │         ↓
               └──→  sidecars-<date> release (published)
                        ↓
                      gates/releases unfreeze their triple
                        ↓
                   draft app release → operator clicks publish
```

Every artifact is sha256-verified twice: at freeze publish (bundle ↔ sibling digest) and at unfreeze (digest match before extraction).

## 2. Operating runbook

**Monthly / version bump**

1. Bump engine pins: for URL engines run `yarn binaries:refresh` (rewrites `scripts/binaries.manifest.json` + `scripts/binaries.lock.json`; `--dry-run` only reports); for brew engines install the new build locally (`brew install vips ghostscript`), then hand-edit `expectVersion`, or follow `binaries:refresh` drift output.
2. Update the per-arch pins in `scripts/ci/homebrew-core-pins.json` **only if a manifest `expectVersion` bumped** (ADR 0001 criterion; each mac triple resolves its own sha, and the two pins move independently):
   - `aarch64-apple-darwin`: pick the newest homebrew-core commit carrying the new formula versions with `arm64_sequoia` bottles for the full closure.
   - `x86_64-apple-darwin`: leave frozen at the last pre-cutoff pin (`8f15b0f1b965`, vips 8.18.6 / gs 10.07.1). **Never bump the Intel engines unless a human re-verifies that the new versions and their whole closure carry `sonoma` x86_64 bottles** — homebrew-core stopped publishing x86_64 bottles on 2026-09-10/11, so nothing bottled after that date can ever be staged from brew on Intel. A new Intel engine source replaces this pin wholesale; it does not move forward.
   Values are hex40 sha strings, plain JSON, no comments and no extra keys.
3. `yarn build && yarn test && cd src-tauri && cargo test` locally, commit, merge.
4. Click **Freeze sidecar engines** (workflow_dispatch). Expect 4 green rows + finalize publishing `sidecars-<date>` with 8 assets.
5. Tag `v<version>` (or dispatch release.yml). Expect 4 green rows building into the draft, preflight requiring all 8 bundle assets.
6. Operator verifies the draft and clicks publish. Never publish the `sidecars-*` release by hand.

**Windows-target compile gate (developer-time, runs on the mac)**

The CI windows row compiles the `src-tauri` tests as `cargo test` on `x86_64-pc-windows-msvc`; the mac can catch every one of those compile errors before push. `cargo check --all-targets --target aarch64-pc-windows-msvc` compiles + typechecks without linking (no MSVC needed). Making the tauri-build build script pass is all that is required:

1. One-time: `rustup target add aarch64-pc-windows-msvc` + `brew install llvm` (llvm-rc cross-compiles the Windows app resource that tauri-build embeds, brew clang preprocesses it for the msvc triple).
2. Stage gitignored placeholders then check, then remove them — tauri-build validates `externalBin` + the windows-conf `binaries/engines` mapping at build-script time, and the mac-native `sidecars_are_self_contained` test must not see leftover placeholder files (from the repo root):
   ```bash
   for b in vips qpdf gs ffmpeg ffprobe; do : > src-tauri/binaries/${b}-aarch64-pc-windows-msvc.exe; done && mkdir -p src-tauri/binaries/engines
   cd src-tauri && env RC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/llvm-rc CC_aarch64-pc-windows-msvc=/opt/homebrew/opt/llvm/bin/clang cargo check --all-targets --target aarch64-pc-windows-msvc; cd ..
   rm -f src-tauri/binaries/*-aarch64-pc-windows-msvc.exe
   ```

First local reproduction (2026-10-17): gate run 39022660502's full windows cargo failure = 36 E0425 in `sidecar.rs` + `processors/document.rs`, fixed by extending the repo `#[cfg(unix)]` precedent to the consuming fns/tests. Gate before every push touching `src-tauri/src/`.

**Recovery**

- Same-day `sidecars-<date>` collision: delete the leftover draft; `gh release delete <tag> --cleanup-tag --yes`; re-run the failed freeze rows.
- Finalize yellow-draft: `gh release delete <tag> --cleanup-tag --yes`, re-run finalize.
- Release draft leftovers: `gh release delete <tag> --cleanup-tag --yes`, re-run the release.

## 3. Failure classification

| Symptom | Meaning | Remedy |
| --- | --- | --- |
| freeze mac row: drift gate FAIL | pin's formulas no longer match manifest `expectVersion` | operator: refresh the pin (new commit) or fix the manifest — never hide the drift |
| freeze mac row: brew install slow/hanging | pin lacks bottles for this closure | bounded by 40-min timeout. arm rows: re-pin (newest commit with `arm64_sequoia` bottles). Intel rows: pin regressed past the 2026-09-10/11 x86_64 bottle cutoff — restore the pre-cutoff pin `8f15b0f1b965`; never push Intel engines forward without human bottle re-verification (ADR 0001) |
| freeze finalize: found N/8 | a matrix row failed quietly or artifacts dropped | re-run failed rows; no partial-sidecars publishes exist |
| consumer: unfreeze FAIL / no sidecars-* | freeze never ran, or wrong newest release | run freeze.yml first (release preflight catches this earlier) |
| consumer: sha256 mismatch | torn or tampered publish | delete + re-run freeze finalize |
| consumer: audit FAIL | frozen engines wrong arch/version/stripping vs manifest | freeze is stale vs manifest: re-run freeze after pin/manifest reconcile |
| gate rows red beyond staging | code broken | normal dev-fix flow |
| tauri-action row: no app assets | build/upload skipped | check tauri-action logs, re-run release |

## 4. Invariants

1. **CI never brews outside freeze.yml** — consumers only unfreeze; any `brew install`/`brew update`/`all.mjs` in ci.yml/release.yml is a regression.
2. **Every engine artifact is sha-verified** — manifest URL pins, freeze digests, unfreeze checks.
3. **Releases are always draft-first** — `sidecars-*` and app drafts publish only after verified assets.
4. **Every job carries `timeout-minutes`** — freeze 40, release rows 90, gate rows 60, cheap jobs 10–15.
5. **No raw `${{ }}` in run strings** — untrusted context enters via step `env`; actions stay SHA-pinned; `shell: bash` everywhere.
