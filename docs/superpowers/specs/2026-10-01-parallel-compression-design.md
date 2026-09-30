# Parallel Batch Compression — Design Spec

**Date:** 2026-10-01
**Status:** Draft → Approved
**Source:** `docs/bugs.md` manual testing section, item 3 (backlog feature) + triage section
**Supersedes:** spec §7 "One file at a time" job-queue rule (v1 sequential decision)

---

## 1. Overview

v1 compresses files strictly sequentially (spec §7: "One file at a time — simpler, avoids
sidecar resource contention, predictable progress"). With the engine and all four
processors stable, batches of mixed files underuse the machine: an image compresses in
milliseconds while a video encodes for minutes behind it.

This spec replaces the single sequential worker with a **lane-based scheduler bounded by
a weighted slot budget** — compressing files of different categories in parallel while
keeping same-category files sequential, protecting the machine from CPU/RAM spikes, and
keeping every existing user-visible behavior (statuses, events, cancellation, cleanup)
identical.

## 2. Decisions (locked with user 2026-10-01)

| Decision | Choice |
|---|---|
| Scheduling model | Category lanes: same-category sequential, cross-category parallel |
| Concurrency bound | Global weighted slot budget N |
| How N is decided | **Auto + manual override** — Settings `Auto / 1 / 2 / 3`, default `Auto` |
| Auto computation | `clamp(logical_cores / 2, 1, 4)` via `std::thread::available_parallelism()` — **cores only, zero new dependencies** |
| CPU-heavy files | **Weighted slots: video = 2 slots, all other categories = 1** |
| Cleanup on cancel | Per-job, unchanged — a job's slots are freed only AFTER its temp cleanup completes |
| Frontend compress UI | Zero changes (events already per-file keyed) |

## 3. Architecture

### 3.1 Process model (sidecar clarity)

One binary **file** per engine on disk (unchanged: `binaries/{vips,ffmpeg,ffprobe,gs,qpdf}`).
Each compression job **spawns a process** from that file. N parallel video jobs = N live
ffmpeg processes from the same single file — the slot budget caps live process count,
which caps CPU/RAM pressure. Nothing on disk is duplicated per job.

### 3.2 Lane scheduler (Rust, `queue.rs`)

```
Batch start
  ├── Group Pending files into one FIFO lane per category (drop order preserved)
  ├── Resolve slot budget N (settings; auto → available_parallelism-based)
  └── Scheduler loop (tokio):
        while any lane non-empty and budget free ≥ weight(head of some lane):
            pick the lane whose waiting file has been queued longest
            among lanes whose head's weight fits the free budget
            spawn that job's task (existing process_job path unchanged)
        on each job completion (any outcome):
            run per-job temp cleanup
            release the job's slots back to the budget
        when all lanes drain → emit batch:complete once
```

- **Within a lane: strictly sequential.** A lane dispatches its next file only after the
  previous one fully completes (including cleanup). Never two files of one category at once.
- **Across lanes: parallel**, bounded by N weighted slots.
- **Slot weights:** video = 2, image/pdf/document = 1. Two videos can only overlap when
  N ≥ 4; concretely video(2) + image(1) + image(1) = 4 slots fills an N = 4 budget.
- **N = 1 degenerates to exactly today's behavior**: one slot, one job at a time in
  original batch order (lane-grouping must NOT reorder single-slot execution — see §5).

### 3.3 Settings

New key (camelCase over IPC, snake_case in Rust per project conventions):

```json
{ "performance": { "maxConcurrent": "auto" } }
```

- Values: `"auto" | "1" | "2" | "3"` — default `"auto"`.
- Auto resolution happens **at batch start** in Rust: `clamp(cores / 2, 1, 4)` where
  cores = `std::thread::available_parallelism()` (falls back to 1 on error). Manual
  values are used verbatim.
- Settings UI: new **Performance** Card in `SettingsView` with a Select
  (`Simultaneous files: Auto · 1 · 2 · 3`), wired through the existing
  `useSettings` draft/save flow. Types: `Settings.performance.maxConcurrent`.

### 3.4 Cancellation & cleanup invariants (per job, never per batch)

1. Per-file cancel / Cancel All → job's token fires → sidecar killed → processor returns.
2. The scheduler runs that job's `temp::cleanup_temp_dir` **before releasing the job's
   slots back to the budget** — a cancelled video frees its 2 slots only after its
   passlog/temp files are gone. No orphan files, no slot leak.
3. Cancelling one job never cleans or stops other lanes.
4. Launch-time stale cleanup (>24h) stays as the last-resort net (unchanged).

### 3.5 Error isolation

One job failing (engine error, corrupt file, best effort) affects only its own row.
Other lanes and the remaining lane queue continue. `batch:complete` still fires exactly
once when all lanes drain; `total_saved_bytes` sums all successful results.

### 3.6 Output-name collision safety under parallelism

Today's check-then-write collision resolution (`output.rs resolve_output_path`) can race
when two jobs finish near-simultaneously with the same output name (e.g. `report.pdf`
from two different source folders). Replace with a **reserved-name registry**:

- Per-batch `Mutex<HashSet<String>>` of claimed output names.
- Each job claims its target name through the registry BEFORE its first write; a claim
  on an existing name (or on-disk file) gets the `-1`, `-2` suffix exactly as today.
- Claims live for the batch lifetime (never released mid-batch) — simplest and
  collision-free.

## 4. Component & Data Flow

```
compress_all (command)
  └── QueueState::start_batch
        ├── group by category → lanes (FIFO per Category)
        ├── resolve N (settings.maxConcurrent)
        └── scheduler task
              ├── dispatch loop (budget-aware, oldest-lane-first)
              ├── per-job: existing process_job → complete/error/cancel events
              │            → temp cleanup → slot release
              └── drain → batch:complete (once)

Frontend: UNCHANGED — file:progress/file:complete/file:error/file:cancelled are
per-file keyed; multiple compressing rows already render (per-row bars + plural
summary counts exist); useCompression listeners are app-level (Workstream A provider).
```

IPC surface: **no new commands, no new events.** Only the settings payload gains a key.

## 5. Backward-compatibility parity rule

With `maxConcurrent = "1"` the system must behave indistinguishably from today:
same completion order (original batch order, not lane-grouped), same events, same
statuses. When N = 1 the lane abstraction is bypassed — plain sequential loop over the
original batch list.

## 6. Touch Surface

| Layer | Change |
|---|---|
| `src-tauri/src/queue.rs` | Lane scheduler, weighted budget, drain logic (largest change) |
| `src-tauri/src/output.rs` | Reserved-name registry (parallel-safe collision resolution) |
| `src-tauri/src/settings.rs` | `performance.maxConcurrent` + `resolve_max_concurrent()` |
| `src/types.ts` | `performance.maxConcurrent` (camelCase) |
| `src/views/SettingsView.tsx` | Performance Card + Select (Auto/1/2/3) |
| `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md` | §7 job-queue wording update |
| Frontend compress UI / hooks | **None** |

## 7. Testing Strategy

Rust (existing fake-sidecar test patterns):

| Test | Proves |
|---|---|
| `lanes_dispatch_oldest_first_within_budget` | FIFO fairness across lanes |
| `same_category_never_runs_two_at_once` | lane sequencing guarantee |
| `video_occupies_two_slots_video_plus_two_images_fill_n4` | weighted-slot math |
| `two_videos_do_not_overlap_at_n3` | weight guard |
| `auto_n_derivation_table` | clamp(cores/2,1,4) truth table (injectable cores) |
| `manual_n_used_verbatim` | "1"/"2"/"3" override |
| `n1_matches_legacy_sequential_order` | §5 parity (event order = batch order) |
| `cancel_all_across_lanes_cleans_each_jobs_temp_and_frees_slots` | §3.4 invariant |
| `single_lane_failure_does_not_stop_others` | §3.5 isolation |
| `parallel_same_name_outputs_get_suffixes` | §3.6 reserved-name registry |
| `batch_complete_fires_once_after_all_lanes_drain` | drain semantics |

Frontend: Performance select saves/loads (existing settings test patterns).

Manual smoke: 10 mixed files at Auto — observe 2+ rows compressing simultaneously,
summary counts correct, cancel-all mid-flight leaves no temp files.

## 8. Risks

- **Scheduler complexity in queue.rs** is the main risk — mitigated by the N=1 parity
  test pinning legacy behavior before lanes are trusted.
- **ffmpeg×2 CPU saturation** is mitigated by video weight 2 (two videos can only
  overlap at N ≥ 4, i.e. only on strong machines).
- **Disk I/O contention** when several sidecars write simultaneously — accepted; the
  cap keeps it bounded, and OS page cache absorbs it.
- **Settings migration**: missing `performance` key in existing stores → default
  `"auto"` via the standard `parse_settings_value` fallback (existing corrupt/missing
  handling covers this).
