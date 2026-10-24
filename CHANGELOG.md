# Changelog

All notable changes to the Yard. Entries for `0.1.0-alpha.1` onward are maintained
by [`release-please`](.github/workflows/release-please.yml) from Conventional Commit PRs (squash-merged,
one PR = one entry); the first entry below is the hand-written seed for the bootstrapped release so no
history predating it leaks into the file.

## [0.2.0-alpha.2](https://github.com/initgrep-apps/filecompressor/compare/v0.1.0-alpha.2...v0.2.0-alpha.2) (2026-10-24)


### Features

* **history:** add filter dialog with chips and date presets ([#166](https://github.com/initgrep-apps/filecompressor/issues/166)) ([7e8b4c4](https://github.com/initgrep-apps/filecompressor/commit/7e8b4c4154d112ef41db9efc59ff0b384b7cf6b6))
* **history:** add newest/oldest sort to the history query ([#159](https://github.com/initgrep-apps/filecompressor/issues/159)) ([aefdfa9](https://github.com/initgrep-apps/filecompressor/commit/aefdfa9f0a94fd26d71392a716230625d2e36e56))
* **history:** add scrollable sidebar batch list and filter trigger ([#167](https://github.com/initgrep-apps/filecompressor/issues/167)) ([5d07b26](https://github.com/initgrep-apps/filecompressor/commit/5d07b2691c8a95a97b5ed929efaec278e8c5b842))
* **history:** focus the history view on the selected batch ([#168](https://github.com/initgrep-apps/filecompressor/issues/168)) ([8963b7a](https://github.com/initgrep-apps/filecompressor/commit/8963b7a622b8d0be694fc296b218bdf13d811e4d))
* **history:** history data layer ([#160](https://github.com/initgrep-apps/filecompressor/issues/160)) ([42fb0fb](https://github.com/initgrep-apps/filecompressor/commit/42fb0fbc15617590692b22fba09ac3ea4d8c9229))
* **settings:** move settings into an auto-saving dialog ([#164](https://github.com/initgrep-apps/filecompressor/issues/164)) ([8940a8e](https://github.com/initgrep-apps/filecompressor/commit/8940a8e58f8af472c948c963a4a967c19c212e80))
* **shell:** add menus, about dialog, and a native macOS menu without About ([#161](https://github.com/initgrep-apps/filecompressor/issues/161)) ([64d1a84](https://github.com/initgrep-apps/filecompressor/commit/64d1a848f8d030d6e48027e8a68a8e613ba79ff4))
* **shell:** add plugin-os platform detection and window chrome config ([#154](https://github.com/initgrep-apps/filecompressor/issues/154)) ([1f7194a](https://github.com/initgrep-apps/filecompressor/commit/1f7194a798f9214cf81c2100829e5c72d2b2a515))
* **shell:** drag surface, window controls, and quit guard ([#158](https://github.com/initgrep-apps/filecompressor/issues/158)) ([059604c](https://github.com/initgrep-apps/filecompressor/commit/059604cda3d14133cc86def2b29911068fdcf895))
* **shell:** replace the app shell with native-style chrome ([#165](https://github.com/initgrep-apps/filecompressor/issues/165)) ([6351e3e](https://github.com/initgrep-apps/filecompressor/commit/6351e3ecad086fc8d65939c561a6a78d385d0c66))
* **shell:** theme system and toggle ([#157](https://github.com/initgrep-apps/filecompressor/issues/157)) ([2f31d61](https://github.com/initgrep-apps/filecompressor/commit/2f31d614beaca5477b0a6187844512617824908d))
* **ui:** shadcn primitives and shared CategoryIcon ([#155](https://github.com/initgrep-apps/filecompressor/issues/155)) ([763c363](https://github.com/initgrep-apps/filecompressor/commit/763c363a75052c10643404fa62f3d86711edff3f))


### Bug Fixes

* **about:** constrain third-party notices width ([#171](https://github.com/initgrep-apps/filecompressor/issues/171)) ([81dfa23](https://github.com/initgrep-apps/filecompressor/commit/81dfa23596f2cf72e006bb76078f1ade22cf7670))
* **shell:** hide empty history chrome and use the app icon ([#172](https://github.com/initgrep-apps/filecompressor/issues/172)) ([e2ef777](https://github.com/initgrep-apps/filecompressor/commit/e2ef777f941f0037dd6461ea5ea88a7035828a15))

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
