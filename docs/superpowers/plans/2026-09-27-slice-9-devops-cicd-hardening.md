# Slice 2: DevOps / CI-CD + Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the six limitations discovered during Slice 1: real cross-platform build verification (GitHub Actions matrix), automated UI regression smoke tests, a React error boundary, single-source version string, window state persistence, and the temp-file stale-scan requirement from spec Section 6.

**Architecture:** GitHub Actions workflow with a 3-OS build matrix runs the existing GATE_COMMAND plus `yarn tauri build` per platform and uploads artifacts. UI smoke tests use WebDriver (tauri-driver) against the dev app. Hardening items are small, isolated changes: error boundary wraps `<App />`, footer version read from tauri config at build time via Vite `define`, tauri-plugin-window-state added to the Tauri builder, stale-scan runs in the Tauri setup hook on the Rust side.

**Tech Stack:** GitHub Actions, tauri-driver + WebDriver client (e.g. `tauri-driver` with `fantoccini` or playwright through WebDriver protocol), tauri-plugin-window-state 2.x, Rust std fs for stale-scan, Vite `define` for version injection.

## Global Constraints

- **Platforms:** macOS, Windows, Linux — CI must produce artifacts for all three
- **License:** GPLv3 — new source files carry the same GPLv3 header used in Slice 1 (see Slice 1 plan, Task 7 Step 2)
- **GATE_COMMAND stays:** `yarn build && cd src-tauri && cargo test` — CI runs this on every platform before attempting `tauri build`
- **No functionality creep** — this slice adds no compression features; hardening only
- **Tauri 2.x stable** (2.12) — no Tauri 3 alpha
- **Frontend boundary:** UI test harness + error boundary live in `src/`; stale-scan lives in `src-tauri/src/` (Rust core owns file operations)
- **No comments in code** unless explicitly requested (license headers are the one exception)
- **Version single source:** `src-tauri/tauri.conf.json` `version` field is canonical; package.json version must match it

## Skills & AI Docs to Use

- **Tauri 2** — Context7 `/tauri-apps/tauri-docs`: query "tauri-driver WebDriver testing" and "tauri-plugin-window-state setup"
- **GitHub Actions for Tauri** — Context7 `/tauri-apps/tauri-docs`: query "GitHub Actions CI workflow tauri build matrix" or fetch `https://v2.tauri.app/llms.txt`
- **shadcn/ui** — `shadcn` skill (only if a UI element is needed for error boundary fallback styling)
- **Vite** — Context7 resolve `Vite`: query "define environment variables compile-time replacement"

---

## File Structure

After this slice, the project will have:

```
file-compressor/
├── .github/
│   └── workflows/
│       └── ci.yml               # 3-OS matrix: gate + tauri build + artifact upload
├── e2e/
│   ├── main.spec.ts             # WebDriver smoke: launch, nav, headings
│   └── helpers.ts               # session setup against tauri-driver
├── scripts/
│   ├── verify-dev.sh            # existing (Slice 1) — unchanged
│   └── verify-theme-tokens.sh   # existing (Slice 1) — unchanged
├── src/
│   ├── main.tsx                 # Modify: wrap <App /> in ErrorBoundary
│   ├── components/
│   │   └── ErrorBoundary.tsx    # Create: class component, fallback UI
│   └── App.tsx                  # Modify: footer version from injected constant
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs               # Modify: register window-state plugin + stale-scan in setup hook
│   │   └── cleanup.rs           # Create: stale temp-file scan (>24h delete)
│   ├── Cargo.toml               # Modify: add tauri-plugin-window-state
│   ├── tauri.conf.json          # Modify: add window-state permission if required
│   └── capabilities/
│       └── default.json         # Modify: window-state permissions
├── package.json                 # Modify: e2e test script, version sync
├── vite.config.ts               # Modify: define APP_VERSION from tauri.conf.json
└── .github/workflows/ci.yml
```

**Responsibilities:**
- `.github/workflows/ci.yml` — gate + build + artifact upload on 3 platforms
- `e2e/` — UI regression smoke wired as `GATE_E2E_COMMAND`
- `src/components/ErrorBoundary.tsx` — catches render errors, readable fallback
- `src-tauri/src/cleanup.rs` — spec Section 6 stale temp scan
- `vite.config.ts` — injects `__APP_VERSION__` from tauri.conf.json

---

## Task 1: GitHub Actions CI Matrix (Cross-Platform Builds)

> **Superseded** by `docs/superpowers/plans/2026-10-14-cicd-release-workflows.md` (Tasks 1–4) — see that plan's ADR 0001 freeze flow and the ruled 2-row PR gate.

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: GATE_COMMAND (`yarn build && cd src-tauri && cargo test`), existing yarn.lock + Cargo.lock
- Produces: CI workflow running gate + `yarn tauri build` on macOS/Windows/Linux, uploading bundle artifacts (`.app`/`.dmg`, `.msi`/`.exe` NSIS, `.deb`/`.AppImage`) per platform

**Acceptance Criteria:**
- Workflow triggers on push to main + pull_request
- Matrix covers `macos-latest`, `windows-latest`, `ubuntu-latest`
- Each job: checkout → Rust toolchain (stable) → Node 20 → yarn install (`--frozen-lockfile`) → GATE_COMMAND → `yarn tauri build` → upload bundle artifacts
- Ubuntu job installs Tauri Linux system deps (libwebkit2gtk, libgtk-3, etc. per Tauri prerequisites)
- Gate failure on any platform fails the workflow (tauri build skipped for that platform)
- Windows job uses PowerShell-compatible shell steps
- Artifact names carry platform triple (e.g. `file-compressor-macos-aarch64`)

**Required Tests:**
- `verify_workflow_yaml` — workflow parses (e.g. `yamllint` or `node -e` with a yaml parser) and contains all 3 matrix entries
- `verify_ci_run` — push to a branch, confirm the workflow triggers and all 3 jobs reach at least the gate step green (first run may take 10-20 min per Linux/Windows job)
- `verify_artifacts` — each completed job uploads ≥1 bundle artifact

- [ ] **Step 1: Fetch Tauri GitHub Actions docs** via Context7 (`/tauri-apps/tauri-docs`, query "GitHub Actions CI tauri build matrix") and confirm current recommended action versions (`dtolnay/rust-toolchain`, `taiki-e/install-action`, Tauri's own `tauri-apps/tauri-action` if suitable)

- [ ] **Step 2: Write .github/workflows/ci.yml** with the matrix described above. Linux system deps block:

```yaml
- name: Install Linux dependencies (ubuntu only)
  if: matrix.os == 'ubuntu-latest'
  run: |
    sudo apt-get update
    sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
```

- [ ] **Step 3: Validate workflow locally** — YAML parse check + confirm matrix entries

- [ ] **Step 4: Push branch, observe CI run** — all 3 jobs green (gate at minimum; tauri build on all 3)

- [ ] **Step 5: Commit** — `ci: add 3-platform build matrix workflow`

---

## Task 2: UI Regression Smoke Tests (GATE_E2E_COMMAND)

**Files:**
- Create: `e2e/main.spec.ts`, `e2e/helpers.ts`
- Modify: `package.json` (add `test:e2e` script + devDeps: `webdriver` client)
- Modify: `AGENTS.md` (set `GATE_E2E_COMMAND` to the new command — no longer `none`)

**Interfaces:**
- Consumes: app shell from Slice 1 (sidebar nav, view headings, window title)
- Produces: `GATE_E2E_COMMAND` = `tauri-driver && yarn test:e2e` — repeatable UI smoke: launch dev app, assert window title, click each nav item, assert heading text per view, assert sidebar footer text

**Acceptance Criteria:**
- `yarn test:e2e` (with `tauri-driver` running) launches the app in WebDriver mode, asserts:
  - window title "File Size Optimizer"
  - default view shows "Compress Files"
  - clicking History shows "History" heading
  - clicking Settings shows "Settings" heading
  - footer contains "v1.0.0"
- Tests fail loudly on any regression (wrong heading, missing nav item)
- `AGENTS.md` GATE_E2E_COMMAND updated from `none`
- Tests are deterministic (no sleeps longer than necessary; use WebDriver implicit waits)

**Required Tests:**
- `e2e_window_title` — title equals "File Size Optimizer"
- `e2e_default_view` — "Compress Files" visible on launch
- `e2e_nav_history` — click History → "History" heading
- `e2e_nav_settings` — click Settings → "Settings" heading
- `e2e_nav_back` — click Compress → "Compress Files" again
- `e2e_footer` — "v1.0.0" present in sidebar footer

- [ ] **Step 1: Fetch tauri-driver docs** via Context7 (`/tauri-apps/tauri-docs`, query "tauri-driver WebDriver testing setup capabilities") — confirm current invocation + WebDriver capabilities format for Tauri 2

- [ ] **Step 2: Add WebDriver client devDependency** + `test:e2e` script to package.json

- [ ] **Step 3: Write e2e/helpers.ts + e2e/main.spec.ts** implementing the 6 assertions above

- [ ] **Step 4: Run the suite locally on macOS** — all 6 green

- [ ] **Step 5: Update AGENTS.md** — `GATE_E2E_COMMAND` — `yarn test:e2e` (document that it requires `tauri-driver` binary on PATH)

- [ ] **Step 6: Commit** — `test(e2e): add UI smoke suite + wire GATE_E2E_COMMAND`

---

## Task 3: React Error Boundary

**Files:**
- Create: `src/components/ErrorBoundary.tsx`
- Modify: `src/main.tsx` (wrap `<App />`)

**Interfaces:**
- Consumes: shadcn Button (exists in `src/components/ui/button.tsx`) for the fallback "Reload" action
- Produces: `ErrorBoundary` class component — `componentDidCatch` logs error to console; fallback shows "Something went wrong" + error message + Reload button (`window.location.reload()`)

**Acceptance Criteria:**
- Render error in any view shows readable fallback instead of blank window
- Fallback displays the error message (diagnosability — PR #2 review finding)
- Reload button re-mounts the app
- GPLv3 header present in new file
- Gate stays green

**Required Tests:**
- `verify_boundary_compiles` — `yarn build` passes
- `verify_boundary_present` — `src/main.tsx` wraps `<App />` inside `<ErrorBoundary>` (grep)
- `verify_boundary_behavior` — manual: temporarily throw in a view, confirm fallback renders with message + Reload works, revert the throw (document with screenshot in PR)

- [ ] **Step 1: Write ErrorBoundary.tsx** (class component, `componentDidCatch` + `render()` fallback, no comments)

- [ ] **Step 2: Wrap App in main.tsx** — `<ErrorBoundary><App /></ErrorBoundary>` inside StrictMode

- [ ] **Step 3: Prove it works** — temporary throw → screenshot fallback → revert

- [ ] **Step 4: Commit** — `fix(ui): add React error boundary with readable fallback`

---

## Task 4: Version String Single Source

**Files:**
- Modify: `vite.config.ts` (inject `__APP_VERSION__` from `src-tauri/tauri.conf.json` via `define`)
- Modify: `src/App.tsx` (footer uses `__APP_VERSION__` instead of hardcoded "v1.0.0")
- Create: `src/vite-env.d.ts` addition or global.d.ts entry for `__APP_VERSION__` typing

**Interfaces:**
- Consumes: `src-tauri/tauri.conf.json` `version` field (canonical)
- Produces: `__APP_VERSION__: string` global constant available in frontend; footer renders `v${__APP_VERSION__} · GPLv3`

**Acceptance Criteria:**
- Bumping `version` in tauri.conf.json changes the footer text with no other edit
- `package.json` version matches tauri.conf.json version (add a check script)
- TypeScript knows `__APP_VERSION__` (declaration, no `any`)
- Gate stays green

**Required Tests:**
- `verify_define_injected` — `grep '__APP_VERSION__' vite.config.ts` matches; built bundle contains the version string (`grep -r "1.0.0" dist/assets/*.js` after build)
- `verify_footer_uses_constant` — `src/App.tsx` footer references `__APP_VERSION__`, no hardcoded "1.0.0"
- `verify_version_sync` — new `scripts/verify-version-sync.sh` (or node one-liner in package.json) asserts package.json version === tauri.conf.json version; wire into `verify:theme`-style script slot

- [ ] **Step 1: Add define to vite.config.ts** — read tauri.conf.json with `fs`, `define: { __APP_VERSION__: JSON.stringify(cfg.version) }`

- [ ] **Step 2: Declare type + use in App.tsx footer**

- [ ] **Step 3: Add version-sync check script** and run it

- [ ] **Step 4: Commit** — `refactor(ui): inject app version from tauri.conf.json single source`

---

## Task 5: Window State Persistence

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `tauri-plugin-window-state = "2"`)
- Modify: `src-tauri/src/lib.rs` (register plugin)
- Modify: `src-tauri/capabilities/default.json` (window-state permissions if schema requires)

**Interfaces:**
- Consumes: Tauri builder in `lib.rs`
- Produces: window size/position restored from previous session; first launch falls back to tauri.conf.json defaults (900×640 centered)

**Acceptance Criteria:**
- Moving/resizing the window, quitting, relaunching → geometry restored
- First launch (no saved state) → 900×640 centered per tauri.conf.json
- `cargo test` + `yarn build` green
- Plugin version 2.x (Tauri 2 compatible)

**Required Tests:**
- `verify_plugin_registered` — `grep 'tauri_plugin_window_state' src-tauri/src/lib.rs` matches
- `verify_restore_manual` — move window, relaunch, verify restored bounds via cua-driver `list_windows` (macOS) — document in PR
- `verify_gate` — GATE_COMMAND green

- [ ] **Step 1: Fetch tauri-plugin-window-state docs** via Context7 (query "window-state plugin setup Tauri 2") — confirm crate name/permission requirements

- [ ] **Step 2: Add dependency + register in builder** with `.plugin(tauri_plugin_window_state::Builder::default().build())`

- [ ] **Step 3: Manual verify restore** (cua-driver bounds before/after relaunch)

- [ ] **Step 4: Commit** — `feat(shell): persist window state across launches`

---

## Task 6: Temp-File Stale-Scan on Launch (Spec Section 6)

**Files:**
- Create: `src-tauri/src/cleanup.rs`
- Modify: `src-tauri/src/lib.rs` (call scan in `setup` hook)
- Modify: `src-tauri/src/lib.rs` or new test file (unit tests for cleanup)

**Interfaces:**
- Consumes: OS temp dir + app subfolder (`std::env::temp_dir().join("file-compressor")`)
- Produces: `pub fn remove_stale_temp_files(dir: &Path, max_age: Duration) -> io::Result<usize>` — deletes files older than 24h in the app temp subfolder, returns count removed; called once in Tauri `setup` hook; unit-tested with `tempfile`-style dirs

**Acceptance Criteria:**
- Files older than 24h in `<tmp>/file-compressor/` are deleted on launch; newer files untouched
- Missing temp dir → no error (returns Ok(0))
- Deletion failure on one file does not abort the scan (skips, continues)
- Unit tests cover: old file deleted, new file kept, missing dir, unreadable file skipped
- Runs in setup hook — non-blocking failures must not crash the app (log + continue)

**Required Tests:**
- `test_stale_file_deleted` — create file with old mtime → scan → gone
- `test_fresh_file_kept` — new file → scan → still present
- `test_missing_dir_ok` — nonexistent dir → Ok(0), no error
- `test_unreadable_skipped` — chmod 000 file → scan continues, others removed (run as non-root)
- `verify_setup_hook_wired` — `grep 'cleanup::remove_stale_temp_files' src-tauri/src/lib.rs` matches
- `verify_gate` — GATE_COMMAND green (tests now non-zero count in `cargo test`)

- [ ] **Step 1: Write cleanup.rs** with `remove_stale_temp_files` + unit tests (use `std::fs` mtime via `metadata().modified()`; set old mtime via `filetime` crate or OS touch in tests)

- [ ] **Step 2: Wire into setup hook** in lib.rs (log failures, never panic)

- [ ] **Step 3: Run cargo test** — all cleanup tests green

- [ ] **Step 4: Commit** — `feat(core): stale temp-file cleanup on launch (spec §6)`

---

## Execution Notes

1. **Task order matters:** Task 1 (CI) first — everything after gets CI-verified on 3 platforms. Task 2 (e2e) second — later tasks get regression protection. Tasks 3-6 are independent; any order after 1-2.
2. **CI first run is slow** (Linux/Windows Rust cold compile ~15-25 min). Expected; subsequent runs use cache.
3. **tauri-driver on CI** — Task 2's e2e suite runs locally on macOS only for now; running WebDriver tests for Tauri on Linux CI is possible but out of scope here (document in AGENTS.md).
4. **Slice 1 manual verification** (cua-driver) remains the fallback when e2e can't run.