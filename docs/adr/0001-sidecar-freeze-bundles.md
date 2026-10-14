# Sidecar freeze bundles instead of staging engines from Homebrew on every CI run

CI release builds for macOS cannot stage vips and gs from Homebrew deterministically: prep pins exact formula versions (`expectVersion`), and runner brew revisions drift, so every run risks a loud break and mac CI gets slow. We decided to freeze staged binaries once per manifest bump into per-target-triple archives published on a dedicated `sidecars-*` GitHub Release; CI release jobs download, verify, and unstage the frozen bundle instead of re-staging from brew. Windows engines are not frozen — their manifest entries are URL + sha256-pinned already, so CI stages them fresh every build.

## Considered Options

- **Freeze bundles (chosen)** — deterministic release builds, fast CI; only the manual freeze run can hit brew drift, and it fails loudly there.
- **Stage from brew on every CI run** — no freeze step, but every mac CI run is at brew's mercy and slow.

## Consequences

- Version bumps require a manual `freeze.yml` run before the next tag builds correctly; release jobs fail loudly (not silently stale) if the `sidecars-*` release is missing.
- macOS x86_64 bundles are produced natively on `macos-15-intel` runners, a label GitHub supports until August 2027; after that the freeze path needs a revisit (Rosetta staging or cross-compile).
