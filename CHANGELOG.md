# Changelog

All notable changes to the File Size Optimizer. Entries for `0.1.0-alpha.1` onward are maintained
by [`release-please`](.github/workflows/release-please.yml) from Conventional Commit PRs (squash-merged,
one PR = one entry); the first entry below is the hand-written seed for the bootstrapped release so no
history predating it leaks into the file.

## [0.2.0-alpha.1](https://github.com/initgrep-apps/filecompressor/compare/v0.1.0-alpha.1...v0.2.0-alpha.1) (2026-10-22)


### Features

* **ci:** gate the release on the built package working ([#147](https://github.com/initgrep-apps/filecompressor/issues/147)) ([03e1f7d](https://github.com/initgrep-apps/filecompressor/commit/03e1f7d43320dc8b60edb67419e29b6eb0d7edd1))


### Bug Fixes

* **macos:** let the ad-hoc-signed helpers load their dylibs ([#143](https://github.com/initgrep-apps/filecompressor/issues/143)) ([a092050](https://github.com/initgrep-apps/filecompressor/commit/a092050b6cafc19bb97e7d725f1b4fb2752e1710))
* **windows:** let the app find ffmpeg/ffprobe beside the exe ([#145](https://github.com/initgrep-apps/filecompressor/issues/145)) ([0756bd9](https://github.com/initgrep-apps/filecompressor/commit/0756bd9ef04b693ebb66e315528fcfa6cdb6a59c))
* **windows:** ship the engines into resources/engines/ ([#144](https://github.com/initgrep-apps/filecompressor/issues/144)) ([ec65943](https://github.com/initgrep-apps/filecompressor/commit/ec659431d0f2dff47e12a77b062cb29afb143bda))

## 0.1.0-alpha.1 (2026-10-17)

First development release, built and verified by the new CI/CD pipelines.

### Features

- 2x2 native installer matrix: macOS (arm + intel) and Windows (x64 + arm), each row unfreezing its
  sidecar engines from the `sidecars-20261017` snapshot release and gating on the full build + test suite
  before tauri-action uploads to the draft ([release run 39065895512]: 4/4 green, 10 draft assets).
- Snapshot-once engine pipeline: `freeze.yml` pins homebrew-core per arch, stages and audits all four
  triples on GitHub-hosted runners, and publishes the exact-8-asset `sidecars-*` release that CI and
  the release rows consume; the local machine stays development-only.

### Fixes

- Release version check accepts semver prerelease tags beyond `-rcN` (alpha/beta).
- Intel mac runner test portability: mac fixtures are arch-explicit, bundle scripts are triple-safe,
  and the rustc-derived triple in `bundle-pdf` staging-gate tests is stubbed to the fixture triple.
