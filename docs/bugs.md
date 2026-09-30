Mannual testing bugs: DO NOT REMOVE OR UPDATE this section

1) if i click the input boxes on settings screen to change. simple clicks on corners either increments the number or decrease. it should clearly be like a number box properly designed. something like [+]10[-] so that either side increment or decrement. the example is for showing u. u must use proper compoennt from shadecn or design if it is not present. the same applies to all. 
2) if i have added the items in compress page, then i go to settings. i can update the settings. then two things happen: a) the added items in compress page are lost. b) I can not longer add items or drop items. when trying, it then doesnt show anything. i have to close the app and do it again
3) if multiple items are added, they are compressed in sequence when it is clearly possible to do them in parallel or batch similar files in parallel though that seems weird. there is a chance to also consider whether the cpu and memory would allow that since i noticed when compressing videos it throttles the cpu usage quite a bit so it has to be a very concious adaptive decision to go from series to parallel or otherway araound depending on the machine. the required compute needs to think that if we run each file type in paralle (assume we batch the similar files meaning similar files compressed in sequence while different batch of different files compress in parallel) then at one point we can have max N supported file compressions running. we can discuss this more and it could be an improvement
4) the UI imo does not look professional and is still in the middle of reaching there.
 a)history page: the save and cancel footer is scrolled to bottom for smaller size we need to scroll. it should instead show always. also it must looks something how the native os looks (this can be deferred later)
b) compress page: the section for drag and drop should look similar to added attachedment (google translate design but better) . 
c) the compress ppage: when scrolled everything scrolls as a page including the section for drag and drop. imo the drag and drop must stay and rest of the table that shows added items must scroll only. the table footer that shows count and buttons for clearing must also show always in someway. the design needs a better thought.[Image 1]

---

## Triage — 2026-09-30 (root-cause investigation; section above is preserved verbatim)

| # | Type | Severity | Fix scope |
|---|------|----------|-----------|
| 1 | UI defect (component) | P1 — usable but hostile | `SettingsView.tsx` inputs |
| 2 | Functional bug | P0 — blocks core workflow | State architecture |
| 3 | Enhancement (not a bug) | P2 — v2 design discussion | Batch scheduler |
| 4a | Layout bug | P1 | `App.tsx` layout wrapper |
| 4b/4c | Design feedback | P2 — UI polish batch | CompressView design |

### Bug 1 — Settings number inputs: corner-click spinners

- **Root cause:** all 9 numeric controls are native `<Input type="number">` (`src/views/SettingsView.tsx:180, 217, 233, 259, 273, 290`). WKWebView (macOS) renders no visible stepper — the spin arrows are a tiny invisible hover region at the input corner, and on WebKit a plain click can trigger an up/down step. Confirms user report; not a state bug.
- **Fix direction:** replace with a proper stepper — shadcn `InputGroup`/`InputGroupAddon` + `Button` (`[-]` value `[+]`) or a committed shadcn stepper pattern, clamped to each field's min/max (i.e. `[+10−]` style). Applies to all 9 inputs (4 category targets + 5 quality floors). Keep `aria-label`s.

### Bug 2 — Compress list lost + drops stop working after visiting Settings (P0)

One root cause, two visible symptoms:

- **2a (list lost):** `src/App.tsx:126` — `activeView === "compress" && <CompressView />` unmounts CompressView on navigation. `useFileList` holds the list in component state (`src/hooks/useFileList.ts:26`), so returning to Compress remounts with `files = []` while the backend `FileListState` (`src-tauri/src/commands.rs:22`) still holds the old entries. UI and Rust state diverge.
- **2b (drops no longer show anything):** user re-drops the same files → `add_files_core` silently dedups against the still-populated backend list (`src-tauri/src/commands.rs:41-43`, strips non-files first), returns `[]`, and the empty result renders nothing. Correct dedup behavior + destroyed UI state = looks like drop inputs are dead.
- **Fix direction:** make UI state survive navigation — (a) keep all three views mounted and toggle visibility (`hidden` attr), or (b) lift file-list state to `App.tsx`/context, or (c) treat backend as source of truth with a `get_files` command used on remount. Preferred: (a) — smallest change, also preserves `useCompression` listeners and drag-drop webview subscription. Add regression test: add file → switch view → switch back → row present; re-drop same file → still one row (dedup, no visual change), re-drop new file → appears.

### Bug 3 — Sequential compression: spec decision, not a defect

- **Classification:** deliberate v1 design — spec §7 "One file at a time (simpler, avoids sidecar resource contention, predictable progress)". User's own framing ("improvement", needs CPU/memory-adaptive decision) confirms it is an enhancement, not a regression.
- **Disposition:** backlog for v2 as adaptive parallelism (per-category worker lanes, batch similar formats sequentially, run different categories concurrently, concurrency cap N chosen from machine resources). Requires design discussion (brainstorm) before any plan — overlapping sidecar CPU spikes when two ffmpeg encodes run simultaneously is the key risk the caller already flagged.

### Bug 4a — Settings Save/Cancel footer scrolls away (P1)

- **Hypothesis (verify in app before fixing):** `SettingsView` already pins the footer (`shrink-0` + `flex-1 … overflow-y-auto` content, `src/views/SettingsView.tsx:117-326`) — same pattern CompressView uses. The unconstrained link is `src/App.tsx:125`: `<div className="flex flex-1 flex-col">` lacks `min-h-0`, so the view child grows to content height instead of scrolling internally; the page (header + drop zone + content) scrolls as one body and the footer leaves the viewport. Classic flexbox `min-height:auto` trap.
- **Fix direction:** add `min-h-0`/`overflow-hidden` to the `App.tsx:125` wrapper (and prove with a small-window screenshot). Note user said "history page" — Save/Cancel footer only exists on Settings; History is a placeholder, so triaging this as Settings.
- Native-OS look refinement: deferred per caller.

### Bug 4b/4c — Compress page design feedback (P2, UI polish batch)

- **4b (drop-zone look):** design preference — replace with a richer drop-zone design per attached reference. Design task, not a code defect.
- **4c (scroll containment):** real layout complaint — drag zone + summary footer should be pinned; only the file table scrolls. Likely shares the Bug 4a `min-h-0` root cause; needs a small design pass before implementation (which element scrolls, sticky footer styling).
- **Disposition:** bundle 4a + 4b + 4c into one "Compress/Settings layout & polish" design task — brainstorm first, per project conventions.

### Recommended order

1. **Bug 2** (P0) — one fix resolves loss + dead-drop + divergent state.
2. **Bug 4a + 4c** (P1/P2 layout) — single `min-h-0` chain fix, verified visually.
3. **Bug 1** (P1) — stepper component for all 9 inputs.
4. **Bug 4b** (P2) — drop-zone redesign with reference image.
5. **Bug 3** (P2) — v2 design discussion only.

---

## Refinement Drift — 2026-09-30-manual-testing-1-bugs
**Date:** 2026-10-01 | **Plan:** `docs/superpowers/plans/2026-09-30-manual-testing-1-bugs.md`

Second refine pass (post-`51b644a`): drift found between plan step snippets and repo facts. All items fixed in-plan; none require code change (implementation not started).

1. Task 2: test-snippet `Row` double-fired `invoke('add_files')` and then called `addFiles` (which invokes again) — one click consumed two `mockResolvedValueOnce` values, so the dedup test (`re-drop of same path keeps one row…`) could not pass as written — plan:159-181, 212-244. Fixed: `onClick={() => addFiles(paths)}`.
2. Task 2: snippet imported `toast` but never used it → `tsc` TS6133 under `noUnusedLocals` (`tsconfig.json:19`, build `tsc && vite build`). Fixed by adding the two toast tests that were owed by the AC (batch complete/error + listener-registration failure).
3. Task 3: snippet used `beforeAll` without importing it → TS2304, breaks `yarn build`. Fixed: `beforeAll` added to the vitest import.
4. Task 5: `Separator` imported in the SettingsView rewrite snippet but unused by the JSX → TS6133. Fixed: import removed, interfaces note updated.
5. Task 4: spec §6's "Enter/Space unaffected" behavior had no test; bound tests only covered above-max clamp; null-guard test was vacuous with a static `value` (zero spy calls passes `.every`). Fixed: Enter/Space test, below-min clamp, stateful harness for the null contract (7 tests total).
6. Task 5 Step 2 selector migration: line 87 (`Videos minimum resolution`) is a Select but was folded into the numeric `toHaveValue`→`toHaveDisplayValue` range; item 4's `listbox` reference was undefined; the two new structural tests rendered synchronously (SettingsView's first paint is the loading branch) — would throw. Fixed: line 87 moved to the select list, concrete `pickOption` helper, `await loadView()` in both tests; two new control tests added.
7. Task 6: Required Tests claimed `renders empty state when no files` but no snippet defined it; structural snippet lacked non-null handling (`closest`/`querySelector` under strict TS); `drop zone is pinned outside the file-list card` was missing from the Required Tests list. Fixed: empty-state test added, non-null form applied, Required Tests list completed.
8. Task 7: onKeyDown `stopPropagation` guards Enter but not Space (browser fires a Space click on buttons after keyup) → added the Space single-fire test.
9. Docs-only: Task 1 Step 2 `data-slot` "recorded names" note; Task 2 Step 4 line range 17–45 also swallowed still-needed imports — narrowed to 17–18/25–28/31–45; heading-removal test moved from Task 3 to Task 8 Step 1c (headings only disappear after Tasks 5/6).
10. Task 8 acceptance table updated to map every row to an existing named test (added App-level Bug 2a + heading-removal + provider toast rows).
