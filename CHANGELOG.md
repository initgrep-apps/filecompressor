# Changelog

All notable changes to the Yard. Entries for `0.1.0-alpha.1` onward are maintained
by [`release-please`](.github/workflows/release-please.yml) from Conventional Commit PRs (squash-merged,
one PR = one entry); the first entry below is the hand-written seed for the bootstrapped release so no
history predating it leaks into the file.

## [0.2.0-alpha.4](https://github.com/initgrep-apps/yard/compare/v0.1.0-alpha.4...v0.2.0-alpha.4) (2026-10-30)


### Features

* **history:** redesign batch dashboard and file table ([#188](https://github.com/initgrep-apps/yard/issues/188)) ([3071316](https://github.com/initgrep-apps/yard/commit/307131647c46d6fe985389dd20249a434e511e49))
* **run:** run board on stock kanban-03 ([#194](https://github.com/initgrep-apps/yard/issues/194)) ([10bd955](https://github.com/initgrep-apps/yard/commit/10bd955de205bee60092caab720d11e1d5feb4cc))


### Bug Fixes

* **build:** rebuild when app icons change ([#192](https://github.com/initgrep-apps/yard/issues/192)) ([cee1e7a](https://github.com/initgrep-apps/yard/commit/cee1e7a8198a2334b6bccf85fd3327542877c865))
* cleaup labels and about ([#186](https://github.com/initgrep-apps/yard/issues/186)) ([d597961](https://github.com/initgrep-apps/yard/commit/d597961b2018e8551166d1640fbbe8315518db8d))
* **history:** keep table columns from overlapping at narrow widths ([#187](https://github.com/initgrep-apps/yard/issues/187)) ([425dd23](https://github.com/initgrep-apps/yard/commit/425dd23e3c21bc80fe424b43b23251797129623a))
* **history:** polish toolbar and retire working docs ([#190](https://github.com/initgrep-apps/yard/issues/190)) ([266f1c1](https://github.com/initgrep-apps/yard/commit/266f1c1be95802b06f9c0aeea7c3a19bca467bb8))
* **run:** axis-locked drag ghosts, in-container insets, lane-sized ghost ([#200](https://github.com/initgrep-apps/yard/issues/200)) ([4a8ea21](https://github.com/initgrep-apps/yard/commit/4a8ea21ca88c15995923c78479a447092fe839e8))
* **run:** bound board height chain and size column drag ghost to lane height ([#197](https://github.com/initgrep-apps/yard/issues/197)) ([5ba4bd4](https://github.com/initgrep-apps/yard/commit/5ba4bd43a4b17a07cd43ce7e17ad977ab7d51298))
* **run:** ordered keyboard targets and in-container lane insets ([#199](https://github.com/initgrep-apps/yard/issues/199)) ([5c7adb7](https://github.com/initgrep-apps/yard/commit/5c7adb7d99e92248bfa07c1c27274b6d3bce8b23))
* **run:** scoped keyboard drag coordinates and stock lane paddings ([#198](https://github.com/initgrep-apps/yard/issues/198)) ([3c3b987](https://github.com/initgrep-apps/yard/commit/3c3b98725c6b3d1b40637d846ee88007a18fdb8b))
* **shell:** remove windows brand chip and align alpha versioning ([#184](https://github.com/initgrep-apps/yard/issues/184)) ([abcae86](https://github.com/initgrep-apps/yard/commit/abcae863b7b5841c89e709e6fad5d821a54df2d2))

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
