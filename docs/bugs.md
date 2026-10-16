# Bugs and improvements

## Bugs
- when the a batch is compress, the new button shows up and when clicked -> the old list shows in the drag-drop with status. i think it is not required. that place is a staging zone and must be cleared when a new batch is click. either clear it before or later. does not matter but we shall get to the empty screen since it is a new batch


## Improvements:
- UI -

## Refinement Drift — 2026-10-07-ui-overhaul-bugs
**Date:** 2026-10-07 | **Plan:** docs/superpowers/plans/2026-10-07-ui-overhaul-bugs.md
1. Task 2: plan says "add clearList to destructure" — already destructured at src/providers/CompressionProvider.tsx:55; only endRun body changes
2. Task 2: 5 existing CompressView tests break on B1 — :285-295, :297-308 (consolidate), :321-351 + :418-441 (empty-staging nav plumbing), :389-416 pins the buggy behavior in its title ("returns with final statuses still listed") — delete/rewrite
3. Task 4: App.test.tsx:140-178 asserts data-slot="sidebar-menu-badge" — SidebarMenuBadge removed; rewrite against count-pill contract
4. Task 5: tint opacity normalizes /10 → /12; token text fields must preserve current classes (text-blue-600 etc.) or DropZone.test.tsx:156-175 breaks
5. Task 6: DropZone.test.tsx:247-291 pins the exact inverse of the new contract (mono string present + text-swap-on-drag) — rewrite in task
6. Task 8: chipFor best_effort tone (inline amber, RunRow.tsx:62) stays amber; done accent + lane-tinted bg are net-new; NAME_TONES/RESULT_STATUSES preserved
7. Task 9: FileList.tsx:132 Badge variant="secondary" base classes may mask tinted className — assert merged output; StatusBadge :47-84 scope extended (best_effort red→amber)
8. Task 10: plan line list omitted :360-364 (session file-table category badges) + :594 (category chip dots) — added
9. Task 12: ref target label stale — RunMonitor wrapper is CompressView.tsx:103 (no `relative`); cramped-detection must observe kanban-board content element (spec §8). RO global stub needed in test-setup.ts or App/History/Settings suites crash at gate
10. Spec conflict resolved: UI spec §4 best_effort=amber supersedes base spec §4 Status Colors (Best effort | destructive (red)) — base spec row not amended; FileList was split (status red, kanban chip amber), unified to amber in Task 9
11. Base spec §4:258 "Compressing | primary (green, pulsing)" — no pulse exists in code and neither UI spec nor plan adds one; treated as dropped requirement

## Live verification — Task 12 (2026-10-08, agent-browser at 900×588 Tauri-equivalent, mock `__TAURI_INTERNALS__` IPC)

- ~~**Kanban last lane clipped ~3px at full scroll (900px viewport).**~~ **RESOLVED in PR #107 round 2** (`fix(ui): widen kanban scroll-end padding`): scroll-container padding `pr-3` → `pr-4` (16px covers the measured ~16px lane overhang; pill right edge previously 903 > 900). Re-verified live 2026-10-08 (agent-browser, mock `__TAURI_INTERNALS__` init-script, fixed transformCallback→callback registry so emitted events reach app listeners): at 900×640, max scroll 134px — last lane count-pill right edge 899 ≤ 900 (fully visible, ~1px slack), lane border-box right edge 912 (12px overhang inside scrollable range, border not clipped in practice; pill is the review criterion), no dimming overlay. Dpr=3 zoom screenshot confirms fully-painted pill rounding. At 760×640 (new minWidth): staging table fits with no horizontal overflow (`scrollWidth 760 ≤ viewport 760`), kanban end state at max scroll 274px — pill right edge 711 ≤ 760 fully visible; New batch → empty staging + full-surface dropzone confirmed.
- Staging table fit, sidebar auto-collapse cycle (cramped→collapsed→grow→expanded), and compact-bar chip wrapping all verified live and passing; history/session cards and compressed-state kanban cards still need an interactive Tauri dev-build pass (mock IPC can't drive real runs) — deferred to user manual verification.
- Harness note for future browser-mock sessions: unhandled `TypeError: …unregisterListener` rejections from `DropZone`/`CompressView`/`useCompression` teardown paths in a plain browser are mock artifacts, not app bugs — Tauri v2 `_unlisten` (`@tauri-apps/api/event.js:100`) reads `window.__TAURI_EVENT_PLUGIN_INTERNALS__`, which only the Tauri webview inject (or `@tauri-apps/api/mocks.js` `mockInternals()`) provides. Browser-mock init scripts should also set `window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }` to keep teardown clean.

### PR #107 architecture note (review round 2, document-only)

- **CompressView wires TWO `useAutoCollapse` instances** (`RunMonitor` + `StagingContentCard`), mutually exclusive by `runScreen` — only one is mounted at any moment. A single shared hook instance is infeasible: the hook's effect reads the ref-object identity at mount, and a current-swap under one ref object is invisible to a one-shot effect. Plan AC "Each view wires one useAutoCollapse call" holds under the active-instance reading: exactly one instance is active per view state.
- **KanbanBoard gained a `contentRef` prop** — plumbing for spec §8's pinned observe target (the `overflow-x-auto` board element, not the clipped `min-h-0 flex-1 overflow-hidden` wrapper).

## Kanban flicker root-cause fix + active-card motion — 2026-10-08

- **Flicker cause (kanban near default width; batch with one fewer lane than screenshot):** `useAutoCollapse` collapsed the sidebar on cramped lanes, then auto-restored it once lanes fit the wider collapsed layout — creating an open↔collapse loop across the ~190px window-width band where lanes fit collapsed but cramp expanded. Mid-transition ResizeObserver events flipped decisions inside the 200ms sidebar animation. Fix (PR-quality): restore only when lane content provably fits the expanded layout (`contentWidth ≤ collapsedClient − Δ + 1`, Δ measured from the collapse width delta), plus a settle guard deferring evaluation past the 200ms transition. Regression tests: `useAutoCollapse.test.ts` settles/defers, band-no-restore, restore-when-fits.
- **Compressing card `animate-pulse` (whole-card opacity breathing) removed per design review** — card is solid `bg-card`, activity moves to a `run-shimmer` sweep inside the progress fill (1.5s linear, `prefers-reduced-motion`-gated), chosen from 6 mocked options.
- **Flake:** gate run panicked in `queue::tests::n1_matches_legacy_sequential_order` (`Err(Timeout)`, queue.rs:1381); passed isolated rerun and full rerun (421 passed, 4 ignored) — frontend-only change, unrelated. Flag if it repeats.

## Deferred: sidebar auto-collapse semantics — reported 2026-10-08
User-reported (screenshots at identical window size, both 46-file batch, only filter differs — 2 lanes vs 3+ lanes):

1. **Sidebar visibility varies with content, not user choice** — fewer kanban items → sidebar expanded; more items → auto-collapsed. At default 900px window the app loads with the sidebar already collapsed (with ≥2 lanes, expanded board ~600px always cramps).
2. **Manual toggle gets reverted** — user opens the sidebar; the "re-collapse when cramped after manual open" rule (+3s suspend expiry) slams it shut again shortly after. Feels like the control fights the user.
3. Root: the content-driven auto-collapse feature itself (PR #107, spec §8). Fix direction agreed to be decided later — options were (a) manual-only sidebar + horizontal kanban scroll (recommended), (b) auto-collapse once per run start with sticky manual toggles, (c) keep feature but never re-collapse after manual open. Sidebar state persistence (tauri-plugin-store vs cookies in Tauri) also open.

## Runner brew nondeterminism class in CI freezes — resolved by homebrew-core pin (2026-10-16)

- **Stale runner index** — macos-15 images ship an old homebrew-core checkout; a freeze without `brew update` resolved old formula versions (vips 8.18.6 / gs 10.07.x era) against a manifest pinning 8.18.7 / 10.08.0, and the drift gate killed the run. The naive `brew update` fix pulled HEAD core instead, whose formula/bottle state nobody tied to the manifest. Resolved: CI never refreshes brew — freeze.yml checks out homebrew-core at the commit in `scripts/ci/homebrew-core.sha` and installs off that pinned tap.
- **Missing-bottles source builds** — homebrew-core stopped publishing x86_64 (sonoma-tier) macOS bottles between 2026-09-10 and 2026-09-11 (harfbuzz 14.4.0 bottle `f2fac97b51f2` still carries `sonoma` digests; ghostscript 10.08.0 a day later does not). Fresh-core x86_64 freezes therefore sent the vips/ghostscript closure into hours-long source builds (llvm included); one run hung 6h / ~3600 billed minutes. Resolved for arm64 by the pin (`cb5b5e2230fd` carries fresh arm64_sequoia bottles for both formulas and their closure); the x86_64 facts and options live in ADR 0001 (no commit can supply vips 8.18.7 x86_64 bottles — vips 8.18.7 postdates the tier death by 16 days). Freeze matrix rows are now bounded at 40 min so this class fails loudly and cheaply instead of hanging.
- **Bootstrap red period** — the first 8 workflow runs under the brew-staging model recorded here (oct 2026) ended 0-for-8: two freezes lost to the brew nondeterminism above, the rest failed downstream of the missing/garbled sidecars release. They are the reason the freeze design moved to the pinned-tap + all-triple model in ADR 0001's 2026-10-16 ruling.
