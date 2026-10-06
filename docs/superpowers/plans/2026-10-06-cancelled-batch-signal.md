# Cancelled-Batch Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cancelled-batch state authoritative end-to-end: backend emits `cancelled` on `batch:complete`, frontend consumes it (no ref inference, no green "Complete" pill on a cancelled batch), and a watchdog recovers the run screen when the terminal listener is lost.

**Architecture:** Backend change is one payload field: `queue.rs::finish_batch` already computes `cancelled` (line ~711) and writes it to history — it just doesn't emit it. Frontend: `useCompression` keeps `cancelledRef` only as a fallback for payloads without the field; provider gains `batchCancelled` state cleared on `startRun`; `RunHeader` gains an optional `cancelled` prop with a muted `Cancelled` pill (running-first precedence unchanged from Task 6/7 of the compress-run-view plan). Watchdog lives in `useCompression` as an armed timer cleared by any terminal.

**Tech Stack:** Rust (queue.rs + one Rust test), React 19 + Vitest. No new deps.

**Spec:** `docs/superpowers/specs/2026-10-05-compress-run-view-design.md` (§3 pill states gain `Cancelled`; §7 unaffected)
Base spec: `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md`

## Global Constraints

- Package manager: `yarn`. Gate after frontend tasks: `yarn build && yarn test`. Rust task gate: `cd src-tauri && cargo test`. Final gate: all three.
- GPLv3 header on new files only; no comments in code.
- Conventional commits: `feat(queue):`, `feat(compression):`, `fix(compression):`.
- IPC struct rule: frontend-facing payload fields camelCase via serde `rename_all`.
- Frontend types: `src/types.ts` for IPC-shaped types; hook-internal payload interfaces stay in `useCompression.ts` (existing pattern).

## Review Focus

1. **Cancelled batch must never render the green `Complete` pill** — provider `batchCancelled` → `RunHeader cancelled` prop → muted `Cancelled` pill. Test: `RunHeader.test.tsx › cancelled batch shows muted Cancelled pill, not Complete` (Task 2).
2. **Frontend must not double-toast on cancelled batch** — payload-authoritative path replaces ref inference for `batch:complete`; ref path survives only for `batch:error` payloads (which never carry `cancelled`). Test: `useCompression.test.ts › batch:complete with cancelled payload shows exactly one Batch cancelled toast` (Task 2).
3. **Watchdog must not fire on healthy long batches** — arm only after invoke resolution, generous fixed timeout, cleared on every terminal and on new invoke. Test: `useCompression.test.ts › watchdog does not fire while batch terminal arrives in time` (Task 3).
4. **Stale-guard interaction** — a stale batch:complete with `cancelled: true` must be swallowed by the existing `activeBatchRef` guard before any toast. Test: `useCompression.test.ts › stale cancelled batch:complete is ignored` (Task 2).

---

### Task 1: Backend — emit `cancelled` on `batch:complete`

**Files:**
- Modify: `src-tauri/src/queue.rs:117-120` (`BatchCompletePayload` — add `cancelled: bool`), `:709-755` (`finish_batch` — thread `cancelled` into the emit)
- Test: `src-tauri/src/queue.rs` (Rust tests module — add payload serialization pin)

**Interfaces:**
- Produces: `batch:complete` payload gains `cancelled: boolean` (serde camelCase — already snake in struct, single word). Consumed by Task 2.
- `batch:error` payloads are unchanged (backend only emits preflight/worker errors; cancelled batches always end via `batch:complete` — queue.rs cancel paths all route to `finish_batch`).

**Acceptance Criteria:**
- `BatchCompletePayload` serializes `{ batchId, totalSavedBytes, cancelled }`
- Normal completion → `cancelled: false`; cancel-all mid-batch → `cancelled: true` (value straight from `queue.batch_cancelled(batch_id)` computed in `finish_batch`)
- Existing Rust tests stay green (`cancel_all_records_cancelled_files` etc. already assert `s.cancelled`)
- New Rust test pins the serialization: `batch_complete_payload_carries_cancelled_flag`
- Gate: `cd src-tauri && cargo test` all green

**Required Tests:**
- `batch_complete_payload_carries_cancelled_flag` — JSON of the payload contains `"cancelled": false` for a finished batch; a cancelled-batch test asserts the emitted event carries `true`

- [x] **Step 1: Write failing Rust test** — in queue.rs tests, assert the `batch:complete` event JSON carries `cancelled` (false on natural end; reuse the `cancel_all_records_cancelled_files` harness to assert `true` mid-cancel).
- [x] **Step 2: Run `cargo test`. Expected: FAIL (field missing).**
- [x] **Step 3: Implement** — add `cancelled: bool` to `BatchCompletePayload`; in `finish_batch`, reuse the `cancelled` binding at :711 in the emit.
- [x] **Step 4: Run `cargo test`. Expected: PASS (all).**
- [x] **Step 5: Commit** `feat(queue): emit cancelled flag on batch complete`

### Task 2: Frontend — consume `cancelled`, drop Complete-pill-on-cancelled

**Files:**
- Modify: `src/hooks/useCompression.ts` (`BatchCompletePayload` + terminal handler)
- Modify: `src/providers/CompressionProvider.tsx` (context gains `batchCancelled: boolean`; `startRun` resets it; set from `onBatchComplete` new arg)
- Modify: `src/components/run/RunHeader.tsx` (optional `cancelled?: boolean` prop → muted `Cancelled` pill)
- Modify: `src/hooks/useCompression.test.ts`, `src/providers/CompressionProvider.test.tsx`, `src/components/run/RunHeader.test.tsx`
- Modify: `docs/superpowers/specs/2026-10-05-compress-run-view-design.md` (§3: pill states gain `Cancelled` — muted, shown when the completed batch was cancelled; takes precedence over `Complete`, never over `Failed`)

**Interfaces:**
- `CompressionCallbacks.onBatchComplete` gains a 4th arg: `(totalSavedBytes, processedCount, errorCount, cancelled: boolean)`
- `RunHeaderProps` gains `cancelled?: boolean`
- Provider context gains `batchCancelled: boolean` (Task 8-style consumption only if sidebar needs it — it doesn't)

**Acceptance Criteria:**
- `batch:complete` with `payload.cancelled === true` → exactly one `toast.info('Batch cancelled')`; `cancelledRef` reset as before (kept as fallback for `batch:error`, which never carries the flag)
- `batch:complete` without the field (older payload) → falls back to `cancelledRef.current` (backward compatible)
- Stale-guard interaction: `activeBatchRef` mismatch swallows the event BEFORE any toast/cancelled handling (Review Focus #4)
- Provider: `batchCancelled` true after a cancelled terminal; cleared on `startRun`; NOT set on normal terminal
- RunHeader: `cancelled` prop → muted `Cancelled` pill (not green `Complete`); `running` still wins first; `batchError` Failed still wins when present; Cancel All when running; New batch otherwise
- All existing tests stay green (update fixtures whose semantics legitimately change)
- Gate: `yarn build && yarn test`

**Required Tests:**
- `batch:complete with cancelled payload shows exactly one Batch cancelled toast` (Review Focus #2)
- `batch:complete without cancelled field falls back to the cancelled ref` — ref set via cancelAll, payload omits field → toast fires
- `stale cancelled batch:complete is ignored` (Review Focus #4)
- `provider sets batchCancelled on cancelled terminal and clears it on startRun`
- `cancelled batch shows muted Cancelled pill, not Complete` (Review Focus #1)
- `running still shows Compressing pill even with cancelled prop; error still shows Failed` (precedence pins)

- [ ] **Step 1: Write failing tests** (hook: payload-authoritative toast + fallback + stale-swallow; provider: batchCancelled lifecycle; RunHeader: Cancelled pill + precedence).
- [ ] **Step 2: Run per-suite. Expected: FAIL.**
- [ ] **Step 3: Implement** hook → provider → RunHeader (order: hook first so provider arg exists).
- [ ] **Step 4: Run suites. Expected: PASS.**
- [ ] **Step 5: Amend spec §3** (Cancelled pill row) — same commit or separate `docs:` commit.
- [ ] **Step 6: Gate `yarn build && yarn test`. Commit** `feat(compression): backend-driven cancelled batch state`

### Task 3: Frontend — terminal watchdog

**Files:**
- Modify: `src/hooks/useCompression.ts` (arm/clear watchdog around invoke resolution + terminal events)
- Test: `src/hooks/useCompression.test.ts`

**Interfaces:**
- Internal only. Constant `TERMINAL_WATCHDOG_MS = 10 * 60 * 1000` (10 min — batches of 100+ files stay well under; configurable const at top of file).
- On watchdog fire while still compressing: `setIsCompressing(false)`, `setProgressByFile({})`, `toast.error('Compression status lost — check History for results')`, `onBatchError?.('Compression status lost')` (drives provider batchError → Failed pill + New batch on run screen), `activeBatchRef.current = null`.

**Acceptance Criteria:**
- Watchdog armed only after `compress_all` invoke resolves with a batchId; disarmed on every terminal (`batch:complete`, `batch:error`) and on invoke failure (never armed)
- Healthy batch: terminal arrives → timer cleared, no watchdog toast (Review Focus #3)
- Lost terminal: after timeout, run state resets + user-visible error (recovers the stuck Compressing pill window)
- Second `compressAll` while armed → previous timer cleared before arming (no double-fire)
- Gate: `yarn build && yarn test`

**Required Tests:**
- `watchdog does not fire while batch terminal arrives in time` (fake timers; emit terminal before advancing past TERMINAL_WATCHDOG_MS)
- `watchdog recovers run state when the terminal event never arrives` (advance timers; assert isCompressing false, toast.error, onBatchError called, progress cleared)
- `second compressAll clears a pending watchdog` (arm, re-run, advance — no watchdog fire from first arm)
- `invoke rejection never arms the watchdog`

- [ ] **Step 1: Write failing tests** (use fake timers; follow existing listener-mock patterns; sonner mock already has `error`).
- [ ] **Step 2: Run `yarn test -- useCompression`. Expected: FAIL.**
- [ ] **Step 3: Implement** — `watchdogRef`; arm in `compressAll` post-invoke; clear helper called from both terminal listeners + invoke catch + re-arm path.
- [ ] **Step 4: Run suite. Expected: PASS. Full gate** `yarn build && yarn test && cd src-tauri && cargo test`.
- [ ] **Step 5: Commit** `fix(compression): terminal watchdog for lost batch events`
