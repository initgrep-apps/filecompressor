# Sidecar freeze bundles instead of staging engines on CI runner hosts

CI release builds cannot stage vips and gs from Homebrew deterministically: prep pins exact formula versions (`expectVersion`), and runner brew revisions drift, so every run risks a loud break and mac CI gets slow. We decided to freeze staged binaries once per manifest bump into per-target-triple archives published on a dedicated `sidecars-*` GitHub Release; CI release jobs download, verify, and unstage the frozen bundle instead of re-staging from brew.

## Considered Options

- **Freeze bundles (chosen)** — deterministic release builds, fast CI; only the manual freeze run can hit brew drift, and it fails loudly there.
- **Stage on every CI run** — no freeze step, but every consumer run is at the mercy of runner host state (brew index staleness, bottle availability), which cost eight red runs in October 2026: stale runner indexes resolved old formulas, fresh cores had no x86_64 bottles for new revisions and sent Intel closures into hours-long source builds (llvm included), one run hung six hours.

## Ruling (2026-10-16): one freeze captures all engines for all four triples

One `freeze.yml` run stages and bundles **all four triples** — `aarch64-apple-darwin` and `x86_64-apple-darwin` on mac runners, `x86_64-pc-windows-msvc` and `aarch64-pc-windows-msvc` on windows runners — and publishes 8 assets (4 tarballs + 4 digests) on the `sidecars-*` release. Every consumer (PR gate and release rows) restores its own triple by unfreezing; **no consumer ever fetches or stages engines itself** (the manifest pipeline `scripts/binaries/*` stays reserved for the freeze run), and **brew runs only inside freeze.yml, only on mac rows**.

The windows rows changed the original "windows engines are never frozen" assumption: their manifest entries are URL + sha256-pinned and deterministic, but staging them fresh on every consumer run duplicated the one cost that freezing exists to remove. The windows bundle therefore packages `binaries/engines/<vips,qpdf,gs>/`, the two tauri `externalBin` exes (`binaries/ffmpeg-<triple>.exe`, `binaries/ffprobe-<triple>.exe`), and `gs-resources/` — exactly what `tauri.windows.conf.json` consumes — with tarball paths still rooted for direct extraction into `src-tauri/`.

## The homebrew-core pin (mac rows only, per arch)

Mac freeze rows check out `homebrew-core` at the commit recorded for their triple in `scripts/ci/homebrew-core-pins.json` and install vips and ghostscript from that pinned tap (`HOMEBREW_NO_INSTALL_FROM_API=1`, `HOMEBREW_NO_AUTO_UPDATE=1`). There is no `brew update` step anywhere in CI — a runner image index or HEAD core is never consulted, so the formula set the drift gate sees is fixed by the pins. Each mac row passes its triple as an env var and resolves its own sha from the pins file; a missing or malformed entry fails the row loudly.

Each pin must satisfy, at its own homebrew-core commit:

1. the vips formula version equals that triple's manifest `expectVersion` for vips, and the ghostscript formula equals its `expectVersion`;
2. bottles exist at that commit for the tier the freeze runner resolves — brew's bottle fallback reaches downward only (an older-OS bottle serves newer macOS, never older), so `arm64_sequoia` digests cover the `macos-15` arm row and pre-cutoff `sonoma` digests cover the `macos-15-intel` row;
3. bumping a pin is a deliberate act: only when that arch's manifest `expectVersion` values change (operator bump procedure in `docs/ci-process.md`), never as a drift fix. The arm and x86 pins move independently.

**The two arches can never share a pin again:** homebrew-core stopped publishing x86_64 (last tier: sonoma) bottles between 2026-09-10 and 2026-09-11 — harfbuzz 14.4.0's bottle at `f2fac97b51f2` (2026-09-10) still carries `sonoma` digests, ghostscript 10.08.0's bottle uploads a day later (`725b67b8e9a9`, `b69b392d4e65`) do not, and neither does vips 8.18.7 at any commit. vips 8.18.7 first entered the tap (2026-09-26) sixteen days after the last x86_64 bottle was ever published, so **no homebrew-core commit can ever supply an x86_64 vips 8.18.7 bottle**.

The pins in force since 2026-10-16:

- `aarch64-apple-darwin` → `cb5b5e2230fd` ("vips: update 8.18.7 bottle", 2026-09-26): the newest commit carrying vips 8.18.7 with fresh `arm64_sequoia` bottles; ghostscript there is 10.08.0 (last touched 2026-09-21). Manifest expectVersions: vips 8.18.7, gs 10.08.0.
- `x86_64-apple-darwin` → `8f15b0f1b965` (parent of the "ghostscript 10.08.0" bump `f74f7261d92e`, 2026-09-08): the newest commit carrying ghostscript 10.07.1 — every later commit is either past the x86_64 bottle cutoff or off-version — with vips there at 8.18.6, both formulas verified to carry `sonoma` x86_64 digests at the pin. The manifest freezes Intel at exactly these last sonoma-bottled versions (vips 8.18.6, gs 10.07.1), so the freeze stages Intel engines from brew bottles while the whole pre-cutoff closure still pours from `sonoma` on the Sequoia runner. **The freeze never bumps Intel engine versions unless a human re-verifies that the new versions and their whole closure carry `sonoma` x86_64 bottles — which, for anything bottled after 2026-09-11, they never will.** A future Intel path (third-party x86_64 engine channel, Rosetta staging, cross-compile) replaces this pin wholesale rather than moving it forward.

## Consequences

- Version bumps require a manual `freeze.yml` run before the next tag builds correctly; release jobs fail loudly (not silently stale) if the `sidecars-*` release is missing.
- macOS x86_64 bundles are produced natively on `macos-15-intel` runners, a label GitHub supports until August 2027; after that the freeze path needs a revisit (Rosetta staging or cross-compile).
- Every freeze matrix job is bounded by `timeout-minutes: 40` so the brew nondeterminism class observed in October 2026 (hours-long source builds, 6-hour hangs, ~3600 billed minutes) dies as a loud bounded failure instead of a runaway job. `fail-fast: false` keeps the other rows' evidence independent; the finalize preflight still refuses to publish anything short of all 8 assets.
- Finalize treats same-day `sidecars-*` tag collisions as manual recovery, never a silent overwrite. A cheap `gate` job (ubuntu, no toolchains) runs the collision preflight before the expensive freeze matrix: if `gh release view` finds a same-day release, or the check cannot verify absence (auth, scopes, rate limit, network), it fails loudly; same-day dispatches queue (`concurrency`, `cancel-in-progress: false`) instead of cancelling a freeze mid-run. The operator then deletes any leftover draft release, then the published release together with its tag (`gh release delete <tag> --cleanup-tag --yes`), then re-runs the failed freeze jobs. A same-day second freeze replaces the first only after the operator deletes the prior release.
- Finalize publishes draft-first: it creates the release as a draft pinned to the exact frozen commit (`gh release create --draft --target "$GITHUB_SHA"`), uploads and verifies all 8 assets, and publishes (`--draft=false`) only after verification. A failed run leaves an invisible draft — the collision remediation's "delete any leftover draft release" step clears it, and the tag always re-targets the freshly frozen SHA on the recovery re-run.
- The windows freeze rows run the same shape without brew: `all.mjs` fetches the URL+sha256-pinned engines, preps the engines layout, and the freeze script bundles it — deterministic by construction, no pin needed.
