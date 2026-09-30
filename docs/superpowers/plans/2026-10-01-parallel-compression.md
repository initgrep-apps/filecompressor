# Parallel Batch Compression Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sequential batch worker with a weighted-lane scheduler — same-category files sequential, cross-category parallel, bounded by a slot budget N (Auto/1/2/3 in Settings).

**Architecture:** Generic scheduler core (`scheduler.rs`) is unit-tested with instrumented futures; `queue.rs` wires real jobs into it. Settings gains `performance.maxConcurrent`. Output collision resolution becomes a reserved-name registry so parallel finishes can't race. Frontend compress UI unchanged — only a Settings Performance card.

**Tech Stack:** Rust (tokio via Tauri, tokio-util CancellationToken), `std::thread::available_parallelism` (zero new deps), React 19 + TS + shadcn Select, Vitest + Testing Library, yarn.

**Spec:** `docs/superpowers/specs/2026-10-01-parallel-compression-design.md`

**Prerequisite:** `2026-09-30-manual-testing-1-bugs.md` plan completed (SettingsView Card/Select composition + app-level provider must exist — Task 5 builds on them).

## Global Constraints

- Gate command (every task): `yarn build && yarn test && cd src-tauri && cargo test`
- Package manager: yarn. **No new Rust or npm dependencies** (scheduler uses tokio + std only).
- No comments in code (AGENTS.md) — except the GPL license header block on new files, copied exactly from `src-tauri/src/queue.rs:1-15`.
- IPC structs: `#[serde(rename_all = "camelCase")]`; settings key `performance.maxConcurrent` camelCase over IPC, snake_case in Rust.
- Existing behavior must not change when `maxConcurrent = "1"` — the legacy sequential loop stays byte-compatible (spec §5 parity rule).
- No new IPC commands or events.
- Sidecar binaries untouched — no `externalBin`/audit changes.

---

### Task 1: Settings backend — `performance.maxConcurrent`

**Files:**
- Modify: `src-tauri/src/settings.rs`
- Test: existing `src-tauri/src/settings.rs` test module

**Interfaces:**
- Consumes: existing `Settings` struct (`settings.rs:111-120`) + `parse_settings_value` fallback pattern (`settings.rs:187-192`).
- Produces: `Settings.performance: Performance { max_concurrent: String }` and `Settings::resolve_max_concurrent(&self) -> u32` — `"auto"` → `clamp(cores / 2, 1, 4)` via `std::thread::available_parallelism()` (error → 1 core → 1); `"1" | "2" | "3"` → verbatim; anything else → 1. Task 4's scheduler wiring consumes `resolve_max_concurrent()`.

**Acceptance Criteria:**
- New `Performance` struct serializes camelCase (`maxConcurrent`) — roundtrip pinned
- Missing/corrupt `performance` key falls back to `"auto"` via serde default (existing partial-settings tests extend)
- `resolve_max_concurrent` truth table pinned with injectable core count (no env dependence in tests)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `performance_defaults_to_auto` — `Settings::default().performance.max_concurrent == "auto"`
- `performance_serde_roundtrip_camel_case` — `maxConcurrent` key present in serialized JSON, roundtrips equal
- `parse_settings_value_missing_performance_fills_default` — partial JSON without `performance` → `"auto"` (extends `test_parse_settings_value_partial_fills_missing_with_defaults` pattern, settings.rs:292-300)
- `resolve_max_concurrent_auto_clamps_cores` — injectable cores: (1→1, 2→1, 4→2, 8→4, 16→4, error→1) — function takes `cores: Option<u32>` override or splits into `resolve_from_cores(cores)` pure fn + thin caller
- `resolve_max_concurrent_manual_verbatim` — `"1"→1`, `"2"→2`, `"3"→3`, `"5"→1` (invalid → 1), `""→1`

- [x] **Step 1: Write the failing tests**

In `src-tauri/src/settings.rs` test module add:

```rust
    #[test]
    fn performance_defaults_to_auto() {
        let s = Settings::default();
        assert_eq!(s.performance.max_concurrent, "auto");
        assert_eq!(s.resolve_max_concurrent_from(3), 1);
        assert_eq!(s.resolve_max_concurrent_from(4), 2);
        assert_eq!(s.resolve_max_concurrent_from(8), 4);
        assert_eq!(s.resolve_max_concurrent_from(16), 4);
        assert_eq!(s.resolve_max_concurrent_from(0), 1);
    }

    #[test]
    fn resolve_max_concurrent_manual_verbatim() {
        let mut s = Settings::default();
        for (raw, want) in [("1", 1), ("2", 2), ("3", 3), ("5", 1), ("", 1), ("auto", 4)] {
            s.performance.max_concurrent = raw.to_string();
            assert_eq!(s.resolve_max_concurrent_from(16), want, "raw={raw}");
        }
    }

    #[test]
    fn performance_serde_roundtrip_camel_case() {
        let value = serde_json::to_value(Settings::default()).unwrap();
        let perf = value.get("performance").unwrap();
        assert!(perf.get("maxConcurrent").is_some());
        let roundtripped: Settings = serde_json::from_value(value).unwrap();
        assert_eq!(Settings::default(), roundtripped);
    }

    #[test]
    fn parse_settings_value_missing_performance_fills_default() {
        let partial = serde_json::json!({ "outputFolder": "/tmp/out" });
        let parsed = parse_settings_value(Some(partial));
        assert_eq!(parsed.performance.max_concurrent, "auto");
    }
```

- [x] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test settings`
Expected: FAIL — `no field 'performance' on Settings` / no method `resolve_max_concurrent_from`.

- [x] **Step 3: Implement**

In `src-tauri/src/settings.rs`, add after `DocumentQualityFloor` (line ~85):

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Performance {
    pub max_concurrent: String,
}

impl Default for Performance {
    fn default() -> Self {
        Performance {
            max_concurrent: "auto".to_string(),
        }
    }
}
```

Extend `Settings` (line ~111):

```rust
    #[serde(default)]
    pub quality_floors: QualityFloors,
    #[serde(default)]
    pub performance: Performance,
```

and `Settings::default()` (line ~155) gains `performance: Performance::default(),`.

Add the resolver (after `target_bytes_for`, line ~185):

```rust
impl Settings {
    pub fn resolve_max_concurrent(&self) -> u32 {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get() as u32)
            .unwrap_or(1);
        self.resolve_max_concurrent_from(cores)
    }

    pub fn resolve_max_concurrent_from(&self, cores: u32) -> u32 {
        let auto = cores.max(1) / 2.max(1);
        let auto = auto.clamp(1, 4);
        match self.performance.max_concurrent.as_str() {
            "1" => 1,
            "2" => 2,
            "3" => 3,
            _ => auto,
        }
    }
}
```

Executor: if the cores math reads awkward, make it exact — `let half = (cores.max(1) / 2).max(1); auto = half.clamp(1, 4)` — truth table above is canonical (3→1: floor(3/2)=1; 4→2; 8→4; 16→4).

- [x] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test settings`
Expected: PASS (new + all existing settings tests).

- [x] **Step 5: Run gate + commit**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: pass.

```bash
git add src-tauri/src/settings.rs
git commit -m "feat(settings): performance.maxConcurrent with auto core-based resolution"
```

---

### Task 2: Reserved-name registry in output.rs (parallel collision safety)

**Files:**
- Modify: `src-tauri/src/output.rs`
- Test: existing `src-tauri/src/output.rs` test module

**Interfaces:**
- Consumes: existing `resolve_output_path` (`output.rs:9-90`) — its suffix loop stays, refactored behind a shared core.
- Produces: `pub(crate) struct ReservedNames(Mutex<std::collections::HashSet<String>>)` with `ReservedNames::new()`, and `pub(crate) fn resolve_output_path_reserved(output_folder: &str, filename: &str, reserved: &ReservedNames) -> PathBuf` — claims the chosen name into the set atomically; later claims on the same name get `-1`, `-2` suffixes exactly as today. Existing `resolve_output_path` keeps its signature and behavior (delegates with a throwaway registry) so all existing callers/tests stay green. Task 4's per-job path consumes `resolve_output_path_reserved`.

**Acceptance Criteria:**
- Two sequential claims of the same fresh name from ONE registry → first gets `name.ext`, second gets `name-1.ext` — even though NEITHER file exists on disk yet (impossible with check-then-write alone)
- On-disk files still collide exactly as today (existing tests untouched and green)
- Existing `resolve_output_path` signature/behavior unchanged
- Registry claim happens under one mutex lock (no TOCTOU between membership check and insert)
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `reserved_registry_two_claims_same_name_get_suffix` — first claim `photo.jpg`, second claim (disk untouched) → `photo-1.jpg`, third → `photo-2.jpg`
- `reserved_registry_cross_batch_isolated` — two separate registries both resolve `photo.jpg` cleanly (registry is per-batch)
- `reserved_registry_disk_collision_still_suffixes` — on-disk `photo.jpg` + fresh registry → `photo-1.jpg` (fs check still applies)
- existing 7 output.rs tests stay green untouched

- [ ] **Step 1: Write the failing tests**

In `src-tauri/src/output.rs` test module add:

```rust
    #[test]
    fn reserved_registry_two_claims_same_name_get_suffix() {
        let dir = tempdir().unwrap();
        let reserved = ReservedNames::new();
        let first = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &reserved);
        assert_eq!(first.file_name().unwrap(), "photo.jpg");
        let second = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &reserved);
        assert_eq!(second.file_name().unwrap(), "photo-1.jpg");
        let third = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &reserved);
        assert_eq!(third.file_name().unwrap(), "photo-2.jpg");
    }

    #[test]
    fn reserved_registry_cross_batch_isolated() {
        let dir = tempdir().unwrap();
        let batch_a = ReservedNames::new();
        let batch_b = ReservedNames::new();
        resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &batch_a);
        let b = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &batch_b);
        assert_eq!(b.file_name().unwrap(), "photo.jpg");
    }

    #[test]
    fn reserved_registry_disk_collision_still_suffixes() {
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("photo.jpg"), b"x").unwrap();
        let reserved = ReservedNames::new();
        let path = resolve_output_path_reserved(dir.path().to_str().unwrap(), "photo.jpg", &reserved);
        assert_eq!(path.file_name().unwrap(), "photo-1.jpg");
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test reserved_registry`
Expected: FAIL — `ReservedNames` not found.

- [ ] **Step 3: Implement**

In `src-tauri/src/output.rs`, add above `resolve_output_path`:

```rust
use std::sync::Mutex;

#[derive(Default)]
pub(crate) struct ReservedNames(Mutex<std::collections::HashSet<String>>);

impl ReservedNames {
    pub(crate) fn new() -> Self {
        ReservedNames(Mutex::new(std::collections::HashSet::new()))
    }

    fn claim(&self, name: String) -> bool {
        let mut set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        set.insert(name)
    }
}

pub(crate) fn resolve_output_path_reserved(
    output_folder: &str,
    filename: &str,
    reserved: &ReservedNames,
) -> PathBuf {
    let folder = Path::new(output_folder);
    let stem = match Path::new(filename).file_stem() {
        Some(raw) => raw.to_str().unwrap_or_else(|| {
            eprintln!(
                "output filename stem not valid UTF-8, using fallback: {}",
                filename
            );
            "output"
        }),
        None => {
            eprintln!(
                "output filename has no usable stem, using fallback: {}",
                filename
            );
            "output"
        }
    };
    let ext = match Path::new(filename).extension() {
        None => "",
        Some(raw) => raw.to_str().unwrap_or_else(|| {
            eprintln!(
                "output filename extension not valid UTF-8, dropped: {}",
                filename
            );
            ""
        }),
    };

    let mut fs_broken = false;
    let mut claimed: Option<String> = None;

    let candidates = std::iter::once(filename.to_string()).chain((1..1000).map(|i| {
        if ext.is_empty() {
            format!("{}-{}", stem, i)
        } else {
            format!("{}-{}.{}", stem, i, ext)
        }
    }));

    for candidate in candidates {
        if !reserved.claim(candidate.clone()) {
            continue;
        }
        match path_is_free(&folder.join(&candidate)) {
            Ok(true) => {
                claimed = Some(candidate);
                break;
            }
            Ok(false) => {}
            Err(e) => {
                eprintln!("output path check failed, skipping collision loop: {e}");
                fs_broken = true;
                break;
            }
        }
    }

    if claimed.is_none() && !fs_broken {
        let overflow = if ext.is_empty() {
            format!("{}-overflow", stem)
        } else {
            format!("{}-overflow.{}", stem, ext)
        };
        if reserved.claim(overflow.clone()) {
            match path_is_free(&folder.join(&overflow)) {
                Ok(true) => claimed = Some(overflow),
                Ok(false) => {}
                Err(e) => {
                    eprintln!("output path check failed for overflow path: {e}");
                    fs_broken = true;
                }
            }
        }
    }

    if let Some(name) = claimed {
        return folder.join(name);
    }

    let unique = uuid::Uuid::new_v4().simple().to_string();
    if ext.is_empty() {
        folder.join(format!("{}-overflow-{}", stem, unique))
    } else {
        folder.join(format!("{}-overflow-{}.{}", stem, unique, ext))
    }
}
```

`resolve_output_path` (existing, line 9) becomes a thin delegate:

```rust
pub(crate) fn resolve_output_path(output_folder: &str, filename: &str) -> PathBuf {
    resolve_output_path_reserved(output_folder, filename, &ReservedNames::new())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test output`
Expected: PASS (3 new + existing 7).

- [ ] **Step 5: Run gate + commit**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: pass.

```bash
git add src-tauri/src/output.rs
git commit -m "feat(output): reserved-name registry for parallel-safe collision resolution"
```

---

### Task 3: Scheduler core (`scheduler.rs`) — generic weighted lanes

**Files:**
- Create: `src-tauri/src/scheduler.rs`
- Modify: `src-tauri/src/main.rs` or `lib.rs` module list (`mod scheduler;` — same place `mod queue;` is declared)

**Interfaces:**
- Consumes: tokio (spawn, task JoinHandle).
- Produces (Task 4 consumes):
  - `pub struct LaneSpec<J> { pub key: String, pub weight: u32, pub jobs: VecDeque<J> }` — `key` identifies the lane (Task 4 sets it to the category string; the core itself never reads it)
  - `pub async fn run_weighted_lanes<J, F, Fut, S, C>(lanes: Vec<LaneSpec<J>>, max_slots: u32, should_stop: S, run_job: F, on_skipped: C) -> u64` where `F: FnMut(J) -> Fut`, `Fut: Future<Output = u64> + Send + 'static`, `J: Send + 'static`, `S: Fn() -> bool + Send + Sync`, `C: FnMut(&J) + Send` — returns summed job outputs; when `should_stop()` is true, every not-yet-started job goes to `on_skipped` instead of running.
  - Dispatch rule: oldest lane first (input order), only lanes with no in-flight job, only when `used + weight ≤ max_slots`; when nothing dispatchable but jobs in flight → await a completion, release its weight, accumulate its output.

**Acceptance Criteria:**
- Never more than `max_slots` weight in flight (pinned by concurrency probes)
- Same-lane jobs never overlap (pinned per-category probe)
- Oldest-lane-first dispatch order (pinned by dispatch-order log)
- `should_stop` flips → remaining jobs skipped via `on_skipped`, in-flight jobs run to completion, sum reflects only completed jobs
- All Required Tests pass
- Gate passes clean: `cd src-tauri && cargo test`

**Required Tests:**
- `same_category_never_runs_two_at_once` — 3 jobs in one lane with in-future probes; max same-lane concurrency observed == 1
- `lanes_dispatch_oldest_first_within_budget` — lanes [image(a,b), pdf(p)], N=3 → dispatch order `[a, p, b]`
- `video_occupies_two_slots_video_plus_two_images_fill_n4` — lanes [video(v1), image(i1,i2)], N=4 → observed max in-flight weight == 4 and all three overlap window exists
- `two_videos_do_not_overlap_at_n3` — lanes [video(v1,v2)], N=3 → v2 starts only after v1 completes
- `stop_hook_skips_remaining_and_sums_completed` — stop flips after first completion → remaining skipped via on_skipped, return == first job's output only
- `drains_to_empty_and_returns_sum` — 4 jobs, N=2 → returns sum of all outputs, all lanes empty

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/scheduler.rs` (tests first, at the bottom):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use tokio::sync::Notify;

    #[derive(Clone)]
    struct Probe {
        active: Arc<Mutex<HashMap<String, usize>>>,
        max_seen: Arc<Mutex<HashMap<String, usize>>>,
        order: Arc<Mutex<Vec<String>>>,
    }

    impl Probe {
        fn new() -> Self {
            Probe {
                active: Arc::new(Mutex::new(HashMap::new())),
                max_seen: Arc::new(Mutex::new(HashMap::new())),
                order: Arc::new(Mutex::new(Vec::new())),
            }
        }

        fn enter(&self, lane: &str, job: &str) {
            *self.order.lock().unwrap().push(format!("{lane}:{job}"));
            let mut active = self.active.lock().unwrap();
            let n = active.entry(lane.to_string()).or_insert(0) + 1;
            active.insert(lane.to_string(), n);
            let mut max = self.max_seen.lock().unwrap();
            max.insert(lane.to_string(), (*max.get(lane).unwrap_or(&0)).max(n));
        }

        fn exit(&self, lane: &str) {
            let mut active = self.active.lock().unwrap();
            let n = active.get(lane).copied().unwrap_or(1);
            if n <= 1 {
                active.remove(lane);
            } else {
                active.insert(lane.to_string(), n - 1);
            }
        }
    }

    fn make_lanes(spec: &[(&str, u32, Vec<&str>)]) -> Vec<LaneSpec<String>> {
        spec.iter()
            .map(|(key, weight, jobs)| LaneSpec {
                key: key.to_string(),
                weight: *weight,
                jobs: jobs.iter().map(|j| format!("{key}:{j}")).collect(),
            })
            .collect()
    }

    fn job_future(probe: &Probe, job: String, weight: u32, gate: Arc<Notify>) -> impl Future<Output = u64> {
        let probe = probe.clone();
        let (lane, _) = job.split_once(':').unwrap();
        let lane = lane.to_string();
        async move {
            probe.enter(&lane, &job);
            for _ in 0..3 {
                tokio::task::yield_now().await;
            }
            probe.exit(&lane);
            gate.notified().await;
            u64::from(weight)
        }
    }

    #[tokio::test]
    async fn same_category_never_runs_two_at_once() {
        let probe = Probe::new();
        let gate = Arc::new(Notify::new());
        let gate2 = gate.clone();
        let lanes = make_lanes(&[("image", 1, vec!["a", "b", "c"])]);
        let probe2 = probe.clone();
        let total = run_weighted_lanes(lanes, 4, || false, move |j| {
            let g = gate2.clone();
            async move {
                let f = job_future(&probe2, j, 1, g).await;
                f
            }
        }, |_| {}).await;
        assert_eq!(total, 3);
        assert_eq!(*probe.max_seen.lock().unwrap().get("image").unwrap(), 1);
    }

    #[tokio::test]
    async fn lanes_dispatch_oldest_first_within_budget() {
        let probe = Probe::new();
        let gate = Arc::new(Notify::new());
        let gate2 = gate.clone();
        let lanes = make_lanes(&[("image", 1, vec!["a", "b"]), ("pdf", 1, vec!["p"])]);
        let probe2 = probe.clone();
        run_weighted_lanes(lanes, 3, || false, move |j| {
            let g = gate2.clone();
            job_future(&probe2, j, 1, g)
        }, |_| {}).await;
        let order = probe.order.lock().unwrap().clone();
        assert_eq!(order, vec!["image:a", "pdf:p", "image:b"]);
    }

    #[tokio::test]
    async fn video_occupies_two_slots_video_plus_two_images_fill_n4() {
        let probe = Probe::new();
        let gate = Arc::new(Notify::new());
        let gate2 = gate.clone();
        let lanes = make_lanes(&[("video", 2, vec!["v"]), ("image", 1, vec!["i1", "i2"])]);
        let probe2 = probe.clone();
        run_weighted_lanes(lanes, 4, || false, move |j| {
            let g = gate2.clone();
            job_future(&probe2, j, weight_of_lane(&j), g)
        }, |_| {}).await;
        assert_eq!(*probe.max_seen.lock().unwrap().get("video").unwrap(), 1);
        assert_eq!(*probe.max_seen.lock().unwrap().get("image").unwrap(), 2);
    }

    #[tokio::test]
    async fn two_videos_do_not_overlap_at_n3() {
        let probe = Probe::new();
        let gate = Arc::new(Notify::new());
        let gate2 = gate.clone();
        let lanes = make_lanes(&[("video", 2, vec!["v1", "v2"])]);
        let probe2 = probe.clone();
        run_weighted_lanes(lanes, 3, || false, move |j| {
            let g = gate2.clone();
            job_future(&probe2, j, 2, g)
        }, |_| {}).await;
        assert_eq!(*probe.max_seen.lock().unwrap().get("video").unwrap(), 1);
    }

    #[tokio::test]
    async fn stop_hook_skips_remaining_and_sums_completed() {
        let stop = Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let skipped = Arc::new(Mutex::new(Vec::new()));
        let skipped2 = skipped.clone();
        let lanes = make_lanes(&[("image", 1, vec!["a", "b", "c"])]);
        let total = run_weighted_lanes(
            lanes,
            2,
            move || stop2.load(Ordering::SeqCst),
            |j| async move {
                stop.store(true, Ordering::SeqCst);
                tokio::task::yield_now().await;
                if j.ends_with("a") { 1 } else { 0 }
            },
            move |j| skipped2.lock().unwrap().push(j.clone()),
        )
        .await;
        assert_eq!(total, 1);
        assert_eq!(skipped.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn drains_to_empty_and_returns_sum() {
        let lanes = make_lanes(&[("image", 1, vec!["a", "b"]), ("pdf", 1, vec!["p", "q"])]);
        let total = run_weighted_lanes(lanes, 2, || false, |j| async move {
            tokio::task::yield_now().await;
            if j.ends_with("a") || j.ends_with("p") { 3 } else { 4 }
        }, |_| {}).await;
        assert_eq!(total, 14);
    }
}
```

Executor notes on the test harness:
- `#[tokio::test]` defaults to the current-thread runtime — probes interleave deterministically via `yield_now`.
- `weight_of_lane(job: &str) -> u32` is a tiny test helper: `"video:*" → 2, else 1`.
- If `job_future`'s gate await makes tests hang, replace the gate with a fixed number of `yield_now().await` calls (deterministic interleave is what the probes measure; the gate exists only to hold jobs open across dispatch windows).
- Adapt the closure plumbing (`gate2`/`probe2` clones) freely — the ASSERTIONS are canonical, not the harness shape.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src-tauri && cargo test scheduler`
Expected: FAIL — `run_weighted_lanes` not found.

- [ ] **Step 3: Implement the core**

```rust
// File Size Optimizer — offline batch file compression
// Copyright (C) 2026 File Size Optimizer Contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

use std::collections::VecDeque;
use std::future::Future;

pub struct LaneSpec<J> {
    pub key: String,
    pub weight: u32,
    pub jobs: VecDeque<J>,
}

pub async fn run_weighted_lanes<J, F, Fut, S, C>(
    mut lanes: Vec<LaneSpec<J>>,
    max_slots: u32,
    should_stop: S,
    mut run_job: F,
    mut on_skipped: C,
) -> u64
where
    J: Send + 'static,
    F: FnMut(J) -> Fut + Send,
    Fut: Future<Output = u64> + Send + 'static,
    S: Fn() -> bool + Send + Sync,
    C: FnMut(&J) + Send,
{
    let mut used: u32 = 0;
    let mut total: u64 = 0;
    let mut inflight: Vec<(usize, u32, tokio::task::JoinHandle<u64>)> = Vec::new();

    loop {
        let mut dispatched = false;
        for idx in 0..lanes.len() {
            if lanes[idx].jobs.is_empty() {
                continue;
            }
            if inflight.iter().any(|(i, _, _)| *i == idx) {
                continue;
            }
            if used + lanes[idx].weight > max_slots {
                continue;
            }
            if should_stop() {
                for lane in lanes.iter_mut() {
                    while let Some(job) = lane.jobs.pop_front() {
                        on_skipped(&job);
                    }
                }
                break;
            }
            let job = lanes[idx].jobs.pop_front().expect("checked non-empty");
            used += lanes[idx].weight;
            let handle = tokio::spawn(run_job(job));
            inflight.push((idx, lanes[idx].weight, handle));
            dispatched = true;
            break;
        }

        if !dispatched {
            if inflight.is_empty() {
                break;
            }
            let (_idx, weight, handle) = inflight.remove(0);
            let output = handle.await.unwrap_or_else(|e| {
                eprintln!("warn: lane job panicked, counting as 0: {e}");
                0
            });
            used = used.saturating_sub(weight);
            total += output;
        }
    }

    total
}
```

Also declare `mod scheduler;` in the crate root module list (wherever `mod queue;` lives — `src-tauri/src/lib.rs`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test scheduler`
Expected: PASS (all 6).

- [ ] **Step 5: Run gate + commit**

Run: `cd src-tauri && cargo test`
Expected: pass.

```bash
git add src-tauri/src/scheduler.rs src-tauri/src/lib.rs
git commit -m "feat(scheduler): generic weighted-lane dispatch core"
```

---

### Task 4: Wire queue.rs to the scheduler (N ≥ 2 lanes, N = 1 legacy parity)

**Files:**
- Modify: `src-tauri/src/queue.rs`

**Interfaces:**
- Consumes: `run_weighted_lanes` + `LaneSpec` (Task 3), `resolve_max_concurrent()` (Task 1), `resolve_output_path_reserved` + `ReservedNames` (Task 2), the existing `process_batch` body (`queue.rs:191-401`).
- Produces: `process_batch` with two paths — `max_concurrent <= 1` → existing sequential loop VERBATIM (parity); else lane path. Extracted helper: `async fn process_single_job(app: AppHandle<R>, batch_id: String, file_id: String, output_folder: String, settings: crate::settings::Settings, reserved: &output::ReservedNames) -> u64` (returns saved bytes; contains the per-file block from `queue.rs:210-390` verbatim except `resolve_output_path` → `resolve_output_path_reserved` and the Unsupported early-exit returns 0).

**Acceptance Criteria:**
- N = 1 → identical completion order/events/statuses to today (parity rule, spec §5)
- Lane path groups Pending files into per-category FIFO lanes preserving batch order; same category never concurrent; budget honored with video weight 2
- Cancel-all mid-batch: in-flight jobs finish as Cancelled + cleaned; not-yet-started jobs marked Cancelled + `file:cancelled` emitted (via `on_skipped`) — semantics identical to today's queue-skip block (`queue.rs:211-221`)
- Temp cleanup still runs per job before its slots release (cleanup stays inside `process_single_job`, which completes before the scheduler releases weight)
- `batch:complete` fires exactly once after all lanes drain, with summed `total_saved_bytes`
- One failing job does not stop other lanes
- Unsupported entries (no processor) still skip with `file:complete` status `unsupported` and return 0 saved
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `n1_matches_legacy_sequential_order` — 3 mixed files, N=1 → `file:error` order equals batch order + `batch:complete` (MockRuntime, missing sidecars = deterministic failure events)
- `video_occupies_two_slots_image_waits_at_n2` — N=2, video lane [v1,v2] + image [i1] → event order v1→v2→i1 (weighted budget + lane sequencing, end-to-end)
- `cancel_all_mid_batch_marks_pending_cancelled_across_lanes` — start N=3 batch of 5, `cancel_all` after first completion → remaining rows Cancelled, `file:cancelled` per remaining, no Pending left
- `single_failure_does_not_stop_lane_or_batch` — 3 files, all still process despite failures; `batch:complete` once
- `batch_complete_fires_once_after_all_lanes_drain` — count `batch:complete` emissions == 1 on lane path
- `parallel_same_name_outputs_get_suffixes_end_to_end` — two zero-media `report.docx` (different source dirs), N=2 → outputs `{report.docx, report-1.docx}` as a set, both rows complete
- existing queue tests stay green (preflight, decide_result_status, output_file_name, empty-batch)

- [ ] **Step 1: Extract `process_single_job`**

Move the per-file block (`queue.rs:210-390` — everything inside the `for file_id in file_ids` loop) into:

```rust
    async fn process_single_job(
        app: AppHandle<R>,
        batch_id: String,
        file_id: String,
        output_folder: String,
        settings: crate::settings::Settings,
        reserved: &crate::output::ReservedNames,
    ) -> u64 {
        let queue = app.state::<QueueState<R>>();
        let registry = ProcessorRegistry::new();
        let state = app.state::<FileListState>();
        let mut total_saved: u64 = 0;

        // [existing per-file body verbatim from queue.rs:211-389, with:]
        //   - resolve_output_path(&output_folder, &output_filename)
        //     → resolve_output_path_reserved(&output_folder, &output_filename, reserved)
        //   - the `Ok(compression_result)` arm keeps `total_saved += saved;`
        //     and RETURNS total_saved at each exit instead of `continue`

        total_saved
    }
```

Every `continue` in the moved body becomes `return total_saved;`. The Unsupported early-exit (`queue.rs:255-279`) returns 0. Cancelled-error and error arms return the saved accumulated so far (0).

- [ ] **Step 2: Split `process_batch`**

`process_batch` keeps preflight (`queue.rs:196-206`) then:

Lane path body — first, grouping helper (in `queue.rs`, outside the impl — the scheduler
core stays models-agnostic):

```rust
fn category_key(category: &crate::models::Category) -> &'static str {
    use crate::models::Category;
    match category {
        Category::Image => "image",
        Category::Video => "video",
        Category::Pdf => "pdf",
        Category::Document => "document",
        Category::Other => "other",
    }
}

fn lane_weight(category: &crate::models::Category) -> u32 {
    if matches!(category, crate::models::Category::Video) { 2 } else { 1 }
}

fn group_lanes(
    state: &tauri::State<'_, FileListState>,
    file_ids: &[String],
) -> Vec<scheduler::LaneSpec<(String, FileEntry)>> {
    let list = poison_recover(state.0.lock());
    let mut lanes: Vec<scheduler::LaneSpec<(String, FileEntry)>> = Vec::new();
    for file_id in file_ids {
        let Some(entry) = list
            .iter()
            .find(|e| &e.id == file_id && e.status == FileStatus::Pending)
            .cloned()
        else {
            continue;
        };
        let key = category_key(&entry.category).to_string();
        if let Some(lane) = lanes.iter_mut().find(|l| l.key == key) {
            lane.jobs.push_back((file_id.clone(), entry));
        } else {
            lanes.push(scheduler::LaneSpec {
                key,
                weight: lane_weight(&entry.category),
                jobs: std::collections::VecDeque::from(vec![(file_id.clone(), entry)]),
            });
        }
    }
    lanes
}
```

Then in `process_batch` after preflight:

```rust
        let max_concurrent = settings.resolve_max_concurrent();

        if max_concurrent <= 1 {
            let mut total_saved: u64 = 0;
            let reserved = crate::output::ReservedNames::new();
            for file_id in file_ids {
                if queue.batch_cancelled(&batch_id) {
                    let mut list = poison_recover(state.0.lock());
                    if let Some(e) = list.iter_mut().find(|e| e.id == file_id) {
                        if e.status == FileStatus::Pending {
                            e.status = FileStatus::Cancelled;
                        }
                    }
                    emit_file_cancelled(app, &file_id);
                    continue;
                }
                total_saved += Self::process_single_job(
                    app.clone(), batch_id.clone(), file_id, output_folder.clone(), settings.clone(), &reserved,
                ).await;
            }
            Self::finish_batch(app, &batch_id, total_saved);
            return;
        }

        let reserved = std::sync::Arc::new(crate::output::ReservedNames::new());
        let lanes = group_lanes(&state, &file_ids);
```

Executor notes:
- `finish_batch(app, batch_id, total_saved)` helper extracts `queue.rs:392-400`
  (batch-token removal + `batch:complete` emit) — shared by both paths.
- `should_stop` must be `Fn() -> bool + Send + Sync + 'static` — capture an `AppHandle`
  clone + `batch_id` clone, call `app.state::<QueueState<R>>().batch_cancelled(&batch_id)`
  inside the closure.

Lane path body:

```rust
        let batch_app = app.clone();
        let stop_batch_id = batch_id.clone();
        let stop_flag = move || {
            let q = batch_app.state::<QueueState<R>>();
            q.batch_cancelled(&stop_batch_id)
        };
```

(`Adjust borrows/lifetimes — `should_stop` must be `Fn + Send + Sync + 'static`; capture
`batch_id` clone + `AppHandle` clone.)

```rust
        let run_app = app.clone();
        let run_batch_id = batch_id.clone();
        let run_folder = output_folder.clone();
        let run_settings = settings.clone();
        let run_reserved = reserved.clone();
        let skip_app = app.clone();
        let skip_state = app.state::<FileListState>();
        let total_saved = scheduler::run_weighted_lanes(
            lanes,
            max_concurrent,
            stop_flag,
            move |(file_id, _entry)| {
                let app = run_app.clone();
                let batch_id = run_batch_id.clone();
                let output_folder = run_folder.clone();
                let settings = run_settings.clone();
                let reserved = run_reserved.clone();
                async move {
                    Self::process_single_job(app, batch_id, file_id.clone(), output_folder, settings, &reserved).await
                }
            },
            move |(file_id, _entry)| {
                emit_file_cancelled(&skip_app, file_id);
                let mut list = poison_recover(skip_state.0.lock());
                if let Some(e) = list.iter_mut().find(|e| &e.id == file_id) {
                    if e.status == FileStatus::Pending {
                        e.status = FileStatus::Cancelled;
                    }
                }
            },
        )
        .await;
        Self::finish_batch(app, &batch_id, total_saved);
```

- [ ] **Step 3: Write the integration tests**

Harness = the existing MockRuntime pattern from `queue.rs:646-744` (mock_context with
`app_directories_override` Root, store plugin, `manage(FileListState)`,
`manage(QueueState::new(...))`, `app.listen` + mpsc event sink, `QueueState::start_batch`,
poll `batch_token_present` for worker idle). Settings arrive via a `settings.json` store
file whose inner `settings` object carries `"outputFolder"` and `"performance"`.

Deterministic-observable note: with sidecars absent in tests, every image/pdf/video job
fails fast with `Engine error` — that IS the observable per-job event. Concurrency
proofs therefore use event ORDER (strictly determined by the scheduler's dispatch rule),
never timing.

```rust
    fn make_app(root: &std::path::Path, settings_json: serde_json::Value) -> tauri::App<tauri::test::MockRuntime> {
        let settings_store = root.join("settings.json");
        std::fs::write(&settings_store, serde_json::json!({ "settings": settings_json }).to_string()).unwrap();

        let mut ctx = tauri::test::mock_context(tauri::test::noop_assets());
        ctx.config_mut().app.app_directories_override =
            Some(tauri::utils::config::AppDirectoriesOverride::Root(root.to_path_buf()));
        ctx.config_mut().identifier = "com.app.test".into();
        let app = tauri::test::mock_builder()
            .plugin(tauri_plugin_store::Builder::default().build())
            .manage(FileListState(std::sync::Mutex::new(Vec::new())))
            .build(ctx)
            .unwrap();
        app.manage(QueueState::new(app.handle().clone()));
        app
    }

    fn add_entries(app: &tauri::App<tauri::test::MockRuntime>, specs: &[(&str, crate::models::Category, &str)]) -> Vec<String> {
        use crate::models::FileEntry;
        let state = app.state::<FileListState>();
        let mut list = state.0.lock().unwrap();
        specs
            .iter()
            .map(|(name, category, path)| {
                let entry = FileEntry::new_with_category(path, name.to_string(), *category, 1 << 20);
                list.push(entry.clone());
                entry.id
            })
            .collect()
    }

    fn events_of(app: &tauri::App<tauri::test::MockRuntime>, topics: &[&str]) -> std::sync::mpsc::Receiver<(String, serde_json::Value)> {
        use tauri::Listener;
        let (tx, rx) = std::sync::mpsc::channel::<(String, serde_json::Value)>();
        for topic in topics {
            let tx = tx.clone();
            let topic = topic.to_string();
            let _ = app.listen(topic.clone(), move |event: tauri::Event| {
                let _ = tx.send((topic.clone(), serde_json::from_str(event.payload()).unwrap()));
            });
        }
        rx
    }

    fn wait_idle(queue: &QueueState<tauri::test::MockRuntime>, batch_id: &str) {
        for _ in 0..250 {
            if !queue.batch_token_present(batch_id) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        panic!("batch did not finish in time");
    }

    #[tokio::test]
    async fn n1_matches_legacy_sequential_order() {
        use tempfile::TempDir;

        let root = TempDir::new().unwrap();
        let out = root.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let app = make_app(root.path(), serde_json::json!({
            "outputFolder": out.to_str().unwrap(),
            "performance": { "maxConcurrent": "1" }
        }));
        let ids = add_entries(&app, &[
            ("a.jpg", crate::models::Category::Image, "/tmp/a.jpg"),
            ("b.pdf", crate::models::Category::Pdf, "/tmp/b.pdf"),
            ("c.mp4", crate::models::Category::Video, "/tmp/c.mp4"),
        ]);
        let rx = events_of(&app.handle(), &["file:error", "file:complete", "file:cancelled", "batch:complete"]);
        let queue = app.state::<QueueState<tauri::test::MockRuntime>>();
        QueueState::start_batch(queue.inner(), &app.handle(), "b1".into(), ids.clone());

        let mut order = Vec::new();
        for _ in 0..3 {
            let (topic, payload) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            assert_eq!(topic, "file:error", "missing sidecars fail every job; got {topic} {payload}");
            order.push(payload["fileId"].as_str().unwrap().to_string());
        }
        assert_eq!(order, ids, "N=1 completion order must equal batch order");
        let (topic, _) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(topic, "batch:complete");
    }

    #[tokio::test]
    async fn video_occupies_two_slots_image_waits_at_n2() {
        use tempfile::TempDir;

        let root = TempDir::new().unwrap();
        let out = root.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let app = make_app(root.path(), serde_json::json!({
            "outputFolder": out.to_str().unwrap(),
            "performance": { "maxConcurrent": "2" }
        }));
        let ids = add_entries(&app, &[
            ("v1.mp4", crate::models::Category::Video, "/tmp/v1.mp4"),
            ("v2.mp4", crate::models::Category::Video, "/tmp/v2.mp4"),
            ("i1.jpg", crate::models::Category::Image, "/tmp/i1.jpg"),
        ]);
        let rx = events_of(&app.handle(), &["file:error", "batch:complete"]);
        let queue = app.state::<QueueState<tauri::test::MockRuntime>>();
        QueueState::start_batch(queue.inner(), &app.handle(), "b2".into(), ids.clone());

        let mut order = Vec::new();
        for _ in 0..3 {
            let (_, payload) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            order.push(payload["fileId"].as_str().unwrap().to_string());
        }
        assert_eq!(order, ids, "video lane drains (2 slots each) before the image lane dispatches");
    }

    #[tokio::test]
    async fn cancel_all_mid_batch_marks_pending_cancelled_across_lanes() {
        use tempfile::TempDir;

        let root = TempDir::new().unwrap();
        let out = root.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let app = make_app(root.path(), serde_json::json!({
            "outputFolder": out.to_str().unwrap(),
            "performance": { "maxConcurrent": "3" }
        }));
        let ids = add_entries(&app, &[
            ("i1.jpg", crate::models::Category::Image, "/tmp/i1.jpg"),
            ("i2.jpg", crate::models::Category::Image, "/tmp/i2.jpg"),
            ("p1.pdf", crate::models::Category::Pdf, "/tmp/p1.pdf"),
            ("p2.pdf", crate::models::Category::Pdf, "/tmp/p2.pdf"),
            ("v1.mp4", crate::models::Category::Video, "/tmp/v1.mp4"),
        ]);
        let rx = events_of(&app.handle(), &["file:error", "file:cancelled", "file:complete", "batch:complete"]);
        let queue = app.state::<QueueState<tauri::test::MockRuntime>>();
        QueueState::start_batch(queue.inner(), &app.handle(), "b3".into(), ids.clone());

        // Wait for the first job to fail, then cancel everything.
        let (topic, _) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(topic, "file:error");
        queue.cancel_all();

        wait_idle(&queue, "b3");
        let mut cancelled_seen = 0;
        while let Ok((topic, payload)) = rx.recv_timeout(std::time::Duration::from_secs(5)) {
            match topic.as_str() {
                "file:cancelled" => cancelled_seen += 1,
                "batch:complete" => break,
                _ => {}
            }
        }
        assert!(cancelled_seen >= 1, "remaining jobs must be marked Cancelled");
        let state = app.state::<FileListState>();
        let list = state.0.lock().unwrap();
        assert!(
            list.iter().all(|e| e.status != crate::models::FileStatus::Pending),
            "no row may stay Pending after cancel-all, got: {:?}",
            list.iter().map(|e| (e.name.clone(), e.status.clone())).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn single_failure_does_not_stop_lane_or_batch() {
        use tempfile::TempDir;

        let root = TempDir::new().unwrap();
        let out = root.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let app = make_app(root.path(), serde_json::json!({
            "outputFolder": out.to_str().unwrap(),
            "performance": { "maxConcurrent": "3" }
        }));
        let ids = add_entries(&app, &[
            ("a.jpg", crate::models::Category::Image, "/tmp/a.jpg"),
            ("b.pdf", crate::models::Category::Pdf, "/tmp/b.pdf"),
            ("c.mp4", crate::models::Category::Video, "/tmp/c.mp4"),
        ]);
        let rx = events_of(&app.handle(), &["file:error", "batch:complete"]);
        let queue = app.state::<QueueState<tauri::test::MockRuntime>>();
        QueueState::start_batch(queue.inner(), &app.handle(), "b4".into(), ids.clone());

        for _ in 0..3 {
            let (topic, _) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            assert_eq!(topic, "file:error", "every file still processes despite the first failure");
        }
        let (topic, payload) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(topic, "batch:complete");
        assert!(payload["totalSavedBytes"].is_number());
    }

    #[tokio::test]
    async fn batch_complete_fires_once_after_all_lanes_drain() {
        use tempfile::TempDir;

        let root = TempDir::new().unwrap();
        let out = root.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let app = make_app(root.path(), serde_json::json!({
            "outputFolder": out.to_str().unwrap(),
            "performance": { "maxConcurrent": "3" }
        }));
        let ids = add_entries(&app, &[
            ("a.jpg", crate::models::Category::Image, "/tmp/a.jpg"),
            ("b.pdf", crate::models::Category::Pdf, "/tmp/b.pdf"),
            ("c.mp4", crate::models::Category::Video, "/tmp/c.mp4"),
            ("d.jpg", crate::models::Category::Image, "/tmp/d.jpg"),
        ]);
        let rx = events_of(&app.handle(), &["batch:complete"]);
        let queue = app.state::<QueueState<tauri::test::MockRuntime>>();
        QueueState::start_batch(queue.inner(), &app.handle(), "b5".into(), ids);
        wait_idle(&queue, "b5");

        let (topic, _) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(topic, "batch:complete");
        let extra = rx.recv_timeout(std::time::Duration::from_millis(300));
        assert!(extra.is_err(), "batch:complete must fire exactly once");
    }

    #[tokio::test]
    async fn parallel_same_name_outputs_get_suffixes_end_to_end() {
        use tempfile::TempDir;
        use std::io::Write;

        let root = TempDir::new().unwrap();
        let out = root.path().join("out");
        std::fs::create_dir_all(&out).unwrap();
        let app = make_app(root.path(), serde_json::json!({
            "outputFolder": out.to_str().unwrap(),
            "performance": { "maxConcurrent": "2" }
        }));

        // Two zero-media .docx files (pure re-zip, no sidecar needed) with the
        // SAME output name, from different source dirs.
        let mut docx_paths = Vec::new();
        for i in 0..2 {
            let src = root.path().join(format!("src{i}"));
            std::fs::create_dir_all(&src).unwrap();
            let path = src.join("report.docx");
            let file = std::fs::File::create(&path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("[Content_Types].xml", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all(b"<?xml version=\"1.0\"?><Types/>").unwrap();
            zip.finish().unwrap();
            docx_paths.push(path);
        }
        let state = app.state::<FileListState>();
        let mut list = state.0.lock().unwrap();
        let ids: Vec<String> = docx_paths
            .iter()
            .map(|p| {
                let entry = crate::models::FileEntry::new_with_category(
                    p.to_str().unwrap(), "report.docx".to_string(), crate::models::Category::Document, 1 << 20,
                );
                list.push(entry.clone());
                entry.id
            })
            .collect();
        drop(list);

        let rx = events_of(&app.handle(), &["file:complete", "file:error", "batch:complete"]);
        let queue = app.state::<QueueState<tauri::test::MockRuntime>>();
        QueueState::start_batch(queue.inner(), &app.handle(), "b6".into(), ids);

        let mut output_names = Vec::new();
        for _ in 0..2 {
            let (topic, payload) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
            assert_eq!(topic, "file:complete", "zero-media docx must not fail: {payload}");
            output_names.push(payload["outputPath"].as_str().unwrap().to_string());
        }
        output_names.sort();
        let name = |s: &str| std::path::Path::new(s).file_name().unwrap().to_str().unwrap().to_string();
        let names: Vec<String> = output_names.iter().map(|s| name(s)).collect();
        assert_eq!(names, vec!["report-1.docx", "report.docx"], "parallel same-name claims must suffix");
    }
```

Executor notes:
- `FileEntry::new_with_category(path, name, category, target_bytes)` — check the actual
  constructor in `models.rs` (`FileEntry::new` takes `(path, target_bytes)` and detects
  category internally); adapt the helper to construct entries with the intended category
  through whatever constructor exists (or set `category` post-construction).
- The docx test uses the `zip` crate already in `Cargo.toml` (Slice 7) — building a
  minimal `[Content_Types].xml`-only docx mirrors `document.rs` test fixtures.
- If `zip::write::SimpleFileOptions` is named differently in the pinned zip version
  (Slice 7 Task 1 pinned the real one), match `document.rs`'s existing fixture code.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test`
Expected: PASS (new 6 + all existing).

- [ ] **Step 5: Run gate + commit**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: pass.

```bash
git add src-tauri/src/queue.rs
git commit -m "feat(queue): weighted-lane parallel scheduler with N=1 legacy parity"
```

---

### Task 5: Settings frontend — Performance card

**Files:**
- Modify: `src/types.ts`
- Modify: `src/views/SettingsView.tsx`
- Modify: `src/views/SettingsView.test.tsx`

**Interfaces:**
- Consumes: Task 1's settings shape (IPC camelCase `performance.maxConcurrent`), Workstream A's SettingsView Card/Select composition, `useSettings` draft flow (unchanged hook).
- Produces: `Settings` type gains `performance: { maxConcurrent: 'auto' | '1' | '2' | '3' }`; SettingsView renders a Performance Card with `Simultaneous files` Select (Auto/1/2/3) wired via `updatePerformance('maxConcurrent', value)`.

**Acceptance Criteria:**
- Performance Card renders between Category Targets and Quality Floors with a Select of 4 options (Auto · 1 · 2 · 3), label `Simultaneous files`
- Selecting an option updates draft; Save persists; hasChanges flips (JSON compare unaffected — value is a string)
- Existing settings tests stay green
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- `performance select renders four options` — trigger `Simultaneous files` lists auto/1/2/3
- `changing performance updates draft and enables save` — pick "2" → Save enabled → click → invoke `save_settings` payload contains `performance.maxConcurrent === "2"`
- existing SettingsView scenarios stay green

- [ ] **Step 1: Write the failing tests**

Add to `src/views/SettingsView.test.tsx` (follow the migrated Select interaction pattern from the manual-testing-1 plan — click trigger, click option in listbox):

```tsx
  it('performance select renders four options', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)
    await screen.findByLabelText('Simultaneous files')
    await user.click(screen.getByLabelText('Simultaneous files'))
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Auto',
      '1',
      '2',
      '3',
    ])
  })

  it('changing performance updates draft and enables save', async () => {
    const user = userEvent.setup()
    render(<SettingsView />)
    await screen.findByLabelText('Simultaneous files')
    await user.click(screen.getByLabelText('Simultaneous files'))
    await user.click(await screen.findByRole('option', { name: '2' }))
    const save = screen.getByRole('button', { name: 'Save Changes' })
    expect(save).toBeEnabled()
    vi.mocked(invoke).mockClear()
    await user.click(save)
    await waitFor(() => {
      const payload = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === 'save_settings')
      expect(payload).toBeTruthy()
      const settings = payload![1] as { settings: { performance: { maxConcurrent: string } } }
      expect(settings.settings.performance.maxConcurrent).toBe('2')
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `yarn test src/views/SettingsView.test.tsx`
Expected: FAIL — no `Simultaneous files` control.

- [ ] **Step 3: Implement**

`src/types.ts` — extend the `Settings` interface:

```typescript
export type MaxConcurrent = 'auto' | '1' | '2' | '3'

export interface PerformanceSettings {
  maxConcurrent: MaxConcurrent
}
```

and inside `Settings`: `performance: PerformanceSettings`.

`src/views/SettingsView.tsx` — add an updater next to `updateFloor`:

```tsx
  const updatePerformance = (field: keyof PerformanceSettings, value: string) => {
    setDraft((prev) => {
      if (!prev) return prev
      return { ...prev, performance: { ...prev.performance, [field]: value } }
    })
  }
```

and a Card between Category Targets and Quality Floors:

```tsx
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Performance</CardTitle>
            <CardDescription>
              How many files compress at once. Auto adapts to your machine (CPU cores).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Field>
              <div className="flex items-center justify-between gap-3">
                <FieldLabel className="text-sm">Simultaneous files</FieldLabel>
                <Select
                  value={draft.performance.maxConcurrent}
                  onValueChange={(v) => updatePerformance('maxConcurrent', v)}
                >
                  <SelectTrigger aria-label="Simultaneous files" className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </Field>
          </CardContent>
        </Card>
```

`handleReset`/defaults flow through untouched (`Settings::default()` carries `"auto"`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `yarn test src/views/SettingsView.test.tsx`
Expected: PASS (new 2 + migrated existing).

- [ ] **Step 5: Run gate + commit**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: pass.

```bash
git add src/types.ts src/views/SettingsView.tsx src/views/SettingsView.test.tsx
git commit -m "feat(ui): performance settings card with simultaneous-files select"
```

---

### Task 6: Spec §7 update + acceptance check

**Files:**
- Modify: `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md` (§7 Job Queue bullet)
- Create: `docs/superpowers/plans/2026-10-01-parallel-compression-acceptance-table.md`

**Interfaces:**
- Consumes: all prior tasks.

**Acceptance Criteria:**
- Spec §7 job-queue bullet replaced: "One file at a time" → weighted-lane description (same-category sequential, cross-category parallel, budget N = Auto/1/2/3, video weight 2)
- Acceptance table maps every criterion in this plan's AC blocks to its named proving test — no hand-waved ✅
- Production gate green
- All Required Tests pass
- Gate passes clean: `yarn build && yarn test && cd src-tauri && cargo test`

**Required Tests:**
- Acceptance table cites: 5 scheduler-core tests, 5 settings tests, 3 reserved-registry tests, 6 queue integration tests, 2 SettingsView tests — every AC row names a real test from Tasks 1-5

- [ ] **Step 1: Update spec §7**

In `docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md`, replace the Job Queue section's first bullet:

```markdown
- `tokio::sync::mpsc` channel — frontend sends jobs, a worker task processes sequentially.
- One file at a time (simpler, avoids sidecar resource contention, predictable progress).
```

with:

```markdown
- `tokio::sync::mpsc` channel — frontend sends jobs, a lane scheduler processes them.
- Weighted-lane concurrency: same-category files run sequentially (one FIFO lane per
  category); different categories run in parallel, bounded by a slot budget
  (Settings `performance.maxConcurrent`: Auto = clamp(logical cores / 2, 1, 4), or
  manual 1/2/3). Video jobs cost 2 slots (CPU-heavy two-pass encode); all other
  categories cost 1. A job's temp cleanup completes before its slots are released.
```

- [ ] **Step 2: Run full gate**

Run: `yarn build && yarn test && cd src-tauri && cargo test`
Expected: all pass.

- [ ] **Step 3: Write the acceptance table**

Create `docs/superpowers/plans/2026-10-01-parallel-compression-acceptance-table.md` mapping each spec §2 decision + §3 invariant to its proving test (names from Tasks 1-5; structure follows `2026-09-27-slices-5-8-acceptance-table.md`).

- [ ] **Step 4: Manual smoke**

1. `yarn tauri dev`: add 10 mixed files (images + videos + pdf + docx) at default Auto → observe 2+ rows `compressing` simultaneously; summary counts shift live; `batch:complete` toast once.
2. Cancel All mid-flight → remaining rows Cancelled, no temp leftovers (`ls $(getconf DARWIN_USER_TEMP_DIR)/file-compressor/` shows no orphan dirs), slots freed (next batch runs).

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-27-file-size-optimizer-design.md docs/superpowers/plans/2026-10-01-parallel-compression-acceptance-table.md
git commit -m "docs: parallel compression spec wording + acceptance table"
```
