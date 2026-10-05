# File Size Optimizer — Resource Usage & System Requirements

**Date:** 2026-10-05
**Scope:** How much CPU, RAM, disk, and temp space this app can use at worst, on one user's machine — and the minimum hardware it needs. This is an offline desktop app, so there is no server to size.
**Companion:** `docs/ARCHITECTURE.md` (implementation reference). Code references point at the working tree as of 2026-10-05.

---

## 1. How these numbers were built

A bottom-up model, in five steps:

1. **Read hard facts from the code** (concurrency limits, attempt counts, buffering behavior) — §2. These are certain.
2. **Model what each processor type uses** (CPU, RAM, disk, time) — §3. Sidecar memory and speed numbers are engineering estimates based on how these tools normally behave. Each number is tagged.
3. **Work out the maximum simultaneous load** the scheduler allows — §4.
4. **Define load scenarios** (typical / power / extreme) and run the model on them — §5–6.
5. **Derive hardware tiers** from the worst case, plus a **measurement plan** to replace estimates with real numbers — §7–8.

Tags: **[C]** = read directly from code (certain). **[E]** = engineering estimate; measure before trusting it fully.

---

## 2. Hard facts from the code

| Fact | Value | Source |
|---|---|---|
| Max jobs at once (auto) | `clamp(CPU cores / 2, 1, 4)` | `settings.rs:240-263` **[C]** |
| Max jobs at once (manual) | 3 | Settings UI, `MaxConcurrent` enum **[C]** |
| Video slot cost | 2 (two videos never run at the same time) | `queue.rs:866-868` **[C]** |
| Same-category parallelism | 1 (one lane per category, one job at a time per lane) | `scheduler.rs:52-53` **[C]** |
| Image attempts per job | ≤ 8 quality steps + ≤ 5 resize steps = **≤ 13 vips runs** | `image.rs:31-32` **[C]** |
| Video runs per job | 1 ffprobe + ≤ 3 resolution steps × 2 passes + ≤ 3 CRF runs = **≤ 10 runs**. Each two-pass attempt **reads the input file twice** | `video.rs:44-48,210-269` **[C]** |
| PDF runs per job | ≤ 2 qpdf + ≤ 17 gs | `pdf.rs:220-235` **[C]** |
| Document buffering | **The whole decompressed archive is held in RAM**, plus a copy of the recompressed media, plus a full rewrite per pass (≤ 8 passes) | `document.rs:112-157,274-306` **[C]** |
| Temp files | All attempt outputs stay on disk until the job ends (even on error or cancel). Cleanup always runs at job end | `queue.rs:611-612` **[C]** |
| Progress events | Video: one event **per ffmpeg output line** (can exceed 10 per second); image: per iteration; pdf: per pass; document: per media file | `video.rs:577-580`, `image.rs:154` **[C]** |
| Frontend rendering | Every progress event re-renders the whole file list. No memoization, no virtualization, no throttling | `FileList.tsx:125-229` **[C]** |
| History growth | 3 JSONL lines per file + 2 per batch. Every `get_history` call re-reads the whole file. Retention default 90 days | `history.rs`, `commands.rs:273-279` **[C]** |
| Old temp cleanup | Files/folders older than 24 h are deleted at startup | `temp.rs:36-114` **[C]** |
| Batches | Batches run one after another (single worker). Parallel work happens inside one batch | `queue.rs:131-152` **[C]** |

---

## 3. Resource model per processor type

The formulas give peak values for **one job**. `S` = input file size. `U` = uncompressed size (only for OOXML documents).

### 3.1 Image (vips)

| Resource | Model | Tag |
|---|---|---|
| RAM | vips streams data, so RAM ≈ 2–3 × the pixel buffer of the largest image = 2–3 × width × height × 3 bytes. A 12 MP photo ≈ 40 MB → under 150 MB RAM. A 50 MP photo ≈ 150 MB → 300–500 MB RAM. | **[E]** |
| CPU | 1 core, near 100% while a vips run is active | **[E]** |
| Temp disk | ≤ 13 attempt outputs; each is a recompressed image, usually ≤ original size. Worst case (best-effort PNG): about 13 × S | **[C]** (count) / **[E]** (sizes) |
| Time | 0.1–0.5 s per attempt for 12–50 MP images → **1–6 s per image** total | **[E]** |

### 3.2 Video (ffmpeg, two passes)

| Resource | Model | Tag |
|---|---|---|
| RAM | 1080p encode: 300–600 MB. 4K: 1.5–3 GB. | **[E]** |
| CPU | **x264 uses all CPU cores by default → one single video job can use the whole machine** while it runs. | **[E]** (high confidence; worth verifying) |
| Temp disk | Attempt outputs are limited by the bitrate target (small). Passlog files ~1–50 MB per attempt. The input is read 2× per two-pass attempt → total reads = 2 × number of steps × S | **[C]** (structure) / **[E]** (sizes) |
| Time | Per two-pass attempt ≈ 2 × clip duration ÷ encode speed. x264 at 1080p on an 8-core machine runs at about 2–4× the clip's length per minute → a 10-minute clip ≈ 5–10 min per resolution step. Worst case (3 steps + CRF fallback) ≈ **4–8 × clip duration**. Typical case (first step works) ≈ **1–2 × clip duration** | **[E]** |

### 3.3 PDF (qpdf + gs)

| Resource | Model | Tag |
|---|---|---|
| RAM | qpdf ≈ 2–3 × S. gs ≈ 200–500 MB normally, up to ~1 GB for PDFs full of images | **[E]** |
| CPU | 1 core per run | **[E]** |
| Temp disk | ≤ 19 attempt outputs, each about the size of the output (≤ target, or ≤ ~S for best-effort) → worst case about 19 × S | **[C]** (count) / **[E]** (sizes) |
| Time | qpdf ~1–3 s; gs 1–10 s per pass for a 50 MB PDF → a typical job takes 5–60 s. If the full grid runs (19 passes): 2–4 min | **[E]** |

### 3.4 Document (zip + vips) — the biggest RAM consumer

| Resource | Model | Tag |
|---|---|---|
| RAM | **≈ 2.5 × U** held at the same time (snapshot + recompressed media + writer buffers). OOXML files usually compress 3–5×, so U ≈ 3–5 × S → **RAM ≈ 8–12 × the compressed file size**. A 500 MB PPTX → 4–6 GB RAM. A 2 GB PPTX → 16–24 GB RAM → out of memory on most machines. | **[C]** (structure) / **[E]** (multiplier) |
| CPU | 1 core per vips run + zip compress/decompress | **[E]** |
| Temp disk | Per pass: 2 files per media entry + 1 full archive rewrite; ≤ 8 passes, all kept → worst case ≈ 8 × U ≈ **8 × (3–5 × S)** | **[C]** (structure) / **[E]** (sizes) |
| Time | Seconds per pass for normal documents; large decks with much media: 10–60 s | **[E]** |

### 3.5 Frontend (webview)

| Resource | Model | Tag |
|---|---|---|
| Base RAM | Tauri main process 30–80 MB + webview 150–250 MB | **[E]** |
| File list rendering | 1000 rows × ~10–15 DOM nodes ≈ 10–15 k nodes. Every progress event rebuilds the full array and re-renders the whole table. With 3 jobs sending events at once (video sends per output line): **hundreds of full-table re-renders per second**, estimated 5–15% of one CPU core continuously, plus 50–150 MB extra webview RAM. This is correct but wasteful — the biggest UI-side cost with very large batches. | **[E]** |
| History view | 50 sessions per page + expanded tables. Day grouping is memoized. Search waits 300 ms. Small cost. | **[C]** (structure) |

### 3.6 When the app is idle

App open, no batch running: **about 0.25–0.5 GB RAM total, about 0% CPU**, almost no disk activity except the startup temp cleanup and history trim. **[E]**

---

## 4. Maximum load at the same time

The scheduler limits what can run at once. Peak demand = base usage + the worst **allowed** 4-slot combination:

| Combination (slots) | CPU | RAM (with large files) | Temp disk |
|---|---|---|---|
| 2 videos (2+2) | ~100% of all cores (two x264 encodes competing) | 0.6–1.2 GB (1080p) / 3–6 GB (4K) | low (outputs are target-sized) |
| 4 documents (1+1+1+1) | ~4 cores | **4 × 2.5 × U** — four 300 MB compressed decks (U ≈ 1.2 GB) → **~12 GB** | 4 × 8 × U — the same example → **~38 GB** |
| 4 images | ~4 cores | under 1 GB unless images are ≥ 50 MP | ≤ 13 outputs × 4 jobs |
| Mixed: 1 video + 2 others | the video uses all cores; the others compete for leftovers | video RAM + 2 × job RAM | moderate |

**What limits each resource:**

- **CPU** is limited by a *single* video job, not by `maxConcurrent`. Parallelism helps images/PDFs/documents, and it helps video *batch speed*, but one encode already uses the whole CPU. More cores make each encode faster; they do not add headroom.
- **RAM and temp disk** are limited by two code behaviors working together: the **document processor holds the whole archive in RAM**, and **all attempt outputs stay on disk until the job ends**. Multiplied: `temp_peak ≈ maxConcurrent × 8 × U_doc`.
- The 24 h startup cleanup limits damage after a crash. But during one long batch, nothing removes temp files early.

---

## 5. Load scenarios

| Scenario | Batch shape | Total input |
|---|---|---|
| **Typical** | 20 files: 12 images (5 MB), 5 PDFs (10 MB), 2 docs (10 MB), 1 video (200 MB, 2 min) | ~0.2 GB |
| **Power** | 300 files: 150 images (10 MB), 60 PDFs (25 MB), 60 docs (20 MB), 30 videos (300 MB, 5–10 min) | ~15 GB |
| **Extreme** (sizing target) | 1000 files: 400 images (15 MB), 150 PDFs (30 MB), 400 docs (25 MB), 50 videos (800 MB, 10 min, 1080p) | **~60 GB** |

---

## 6. Results for the extreme scenario

### 6.1 Peak RAM

Worst realistic mix while the batch runs (documents use the most RAM):

```
RAM_peak ≈ base (0.4 GB)
         + 4 documents at once × 2.5 × U
         (25 MB compressed × 4 = ~100 MB uncompressed → 0.25 GB each)
         ≈ 0.4 + 1.0 = ~1.4 GB
```

But the real limit is the **largest single document** in the batch:

| Largest compressed OOXML in the batch | Uncompressed U (×4) | RAM for that one job (2.5 × U) | Machine needed |
|---|---|---|---|
| 100 MB | 400 MB | ~1 GB | 4 GB is fine |
| 500 MB | 2 GB | ~5 GB | 8 GB tight, 16 GB comfortable |
| 1 GB | 4 GB | ~10 GB | 16 GB tight, 32 GB safe |
| 2 GB | 8 GB | ~20 GB | 32 GB minimum, may still run out |

Videos running at the same time add 0.3–3 GB. **RAM conclusion: 16 GB handles everything except single OOXML files ≥ ~1 GB compressed. 32 GB also covers those.**

### 6.2 Peak temp disk

```
Temp_peak ≈ sum over active jobs (kept attempts × size)
Realistic worst: 4 documents at once, each 25 MB compressed → U ≈ 100 MB
           4 × 8 passes × 100 MB ≈ 3.2 GB
Worst case: 4 documents at once, each 500 MB compressed → 4 × 8 × 2 GB ≈ 64 GB
Videos: ~3 attempt outputs × target size + passlogs ≈ under 1 GB per job
Images: 13 × ≤ original ≈ under 0.2 GB per job
```

Plus the output folder (≈ compressed total ≈ 10–20 GB for the extreme batch). Input files are never copied or changed. **Temp disk conclusion: 30 GB free covers the realistic extreme batch. 64 GB free covers the worst case. After a crash, the startup cleanup removes leftovers older than 24 h; normally cleanup happens per job.**

### 6.3 CPU and total time

- During any video attempt: about 100% of all cores (x264 uses them all). Other jobs compete for what is left. The scheduler's video weight-2 rule stops two encodes at once, but not core competition.
- Total time for the extreme batch (the 50 videos dominate):

```
Per video (first resolution step works): 2 passes × 10 min ÷ 2.5× speed ≈ 8 min
50 videos ÷ 2 at a time (weight 2+2 at 4 slots) × 8 min ≈ 3.3 h
400 images ÷ (image lane = 1 at a time) × 3 s ≈ 20 min (runs in parallel with the video lane)
400 docs × 5 s ÷ 1 lane ≈ 33 min (parallel)
150 PDFs × 15 s ÷ 1 lane ≈ 38 min (parallel)
Total ≈ 4–5 h normally; 8–12 h if many videos need the full ladder + CRF fallback
```

- The UI stays responsive as long as the webview is not starved; see §6.4.

### 6.4 Frontend rendering cost

A 1000-row list + 3 jobs sending progress events: about 5–15% of one CPU core in the webview process, continuously, with a full-table re-render per event. **Not a correctness problem — a performance debt.** Fixes, in priority order: memoize rows, throttle progress updates (for example to ~10 per second), virtualize the list. Until then, extreme batches cost measurable but tolerable UI overhead on any tier above minimum.

### 6.5 History at extreme scale

A 1000-file batch writes ~3002 lines ≈ 1–2 MB. Heavy use over 90 days (say 100 extreme batches) → ~150 MB JSONL file. `get_history` parses the whole file on every page load: ~50–150 ms at 150 MB — acceptable. If it ever becomes slow, page-level caching is the planned next step (spec §8). The retention trim rewrites the file atomically after each batch — a disk write proportional to file size, but rare.

### 6.6 Summary — extreme scenario peaks

| Resource | Realistic extreme | Worst case |
|---|---|---|
| RAM | 1.5–6 GB | 20+ GB (single OOXML ≥ 1 GB) |
| CPU | 100% of all cores during video; 4 cores otherwise | same |
| Temp disk | 3–5 GB spike | ~64 GB spike (4 × 500 MB decks) |
| Output disk | 10–20 GB | grows with batch |
| Total time | 4–5 h | 8–12 h |
| Webview CPU | 5–15% of one core | same |

---

## 7. System requirements (3 tiers)

| | **Minimum** — app works, small/medium batches | **Recommended** — smooth full parallelism | **Power** — extreme batches (1000+ files, multi-GB) |
|---|---|---|---|
| CPU | 2 cores / 4 threads (auto `maxConcurrent` becomes 1 → jobs run one after another) | 6–8 logical cores (auto becomes 3–4 slots) | 10+ cores (faster encodes; one video still uses all cores) |
| RAM | 4 GB (base 0.5 GB + 1 job + OS; OOXML files over ~300 MB compressed will swap) | 16 GB (handles a 500 MB compressed OOXML + a 1080p video at the same time) | 32 GB (multi-GB OOXML, 4K video, full 4-slot load) |
| Disk | SSD, free space ≥ 2 × largest single file + 2 GB | SSD, ≥ 30 GB free | NVMe, ≥ 64 GB free (temp spikes + outputs) |
| Disk speed | SATA SSD is enough | SATA SSD is enough; NVMe roughly halves video time | NVMe (video two-pass reads the input twice per attempt) |
| GPU | None needed (CPU-only pipeline) | None needed | None needed |
| OS | macOS 11+ / Windows 10+ (WebView2 runtime) | same | same |
| Experience at this tier | Videos run one at a time and slowly; large documents may cause swapping; UI is fine for lists up to ~100 rows | Full lane parallelism; 1080p videos finish in minutes; extreme batches finish overnight | Extreme batches finish in hours; 4K input is safe; headroom for large PDFs |

**Simple summary:** the app *runs* on 2 cores / 4 GB, but the most important hardware part is **RAM** (document buffering grows with the uncompressed archive size), then **CPU cores** (video encode speed), then **disk** (temp spikes are limited but large).

---

## 8. Measurement plan (replace estimates with real numbers)

1. **Batch generator:** a script that creates N files per category with controlled sizes (for example 400 × 15 MB JPG, 50 × 800 MB MP4, 400 × 25 MB DOCX with a known number of media files, 150 × 30 MB PDF).
2. **Tools:** macOS `Activity Monitor` / `Instruments` (Counters, File Activity); Windows `Task Manager` / ETW. Track per-process RAM (`file-compressor`, webview process, `vips`, `ffmpeg`, `gs`, `qpdf`), temp folder size over time, disk read/write bytes, CPU per process.
3. **Runs:** each scenario from §5, at `maxConcurrent` = auto, 1, and 3. Record peaks and total time.
4. **Acceptance thresholds (first draft; adjust after the first run):**

| Metric | Threshold |
|---|---|
| App + webview RAM when idle | ≤ 0.5 GB |
| Peak total RAM, power scenario | ≤ 8 GB |
| Peak total RAM, extreme scenario (no OOXML > 500 MB) | ≤ 10 GB |
| Peak temp footprint, extreme scenario | ≤ 10 GB, back to 0 after the batch |
| Webview CPU during 3 video progress streams, 1000-row list | ≤ 20% of one core (if higher → prioritize memoization) |
| History page load with a 100 MB JSONL file | ≤ 250 ms |

5. **Re-run after fixes** (§9 items) and add the measured numbers to this document with dates.

---

## 9. Structural risks and suggested fixes (related to resource usage)

| # | Risk | Impact | Suggested fix |
|---|---|---|---|
| 1 | The document processor holds the whole uncompressed archive + a recompressed copy in RAM (`document.rs:112-157`) | RAM grows to ~8–12× the compressed size; one large OOXML file can exhaust memory on any tier | Stream entries to per-pass temp files instead of RAM; or add a size cap with a warning |
| 2 | All attempt outputs stay on disk until the job ends (all processors) | Temp spikes = attempts × size; worst case with 4 large documents ≈ 64 GB | Delete an attempt as soon as a strictly smaller one replaces it (`BestAttempt` already tracks the winner) |
| 3 | No progress-event throttling + no row memoization/virtualization | Hundreds of full-table re-renders per second with large batches | Send progress at most ~10 times per second; `React.memo` rows; virtualize lists over ~200 rows |
| 4 | x264 uses all cores per encode | One video job starves everything else (including the UI) on machines with few cores | Consider `-threads` cap ≈ cores/2 when other lanes are active (this is the "adaptive parallelism" idea from `docs/bugs.md` Bug 3) |
| 5 | The generic `run_sidecar` collects stderr into an unbounded `Vec` (`processor.rs:237-245`) | A tool that prints a lot of output grows memory until it exits | Apply the video processor's 2048-byte tail limit everywhere |
| 6 | `get_history` re-parses the whole file per call | Wait time grows with history size | Fine up to ~100 MB; add page-level caching if it gets slower |
| 7 | Jobs run blocking 30 ms poll loops inside tokio workers | N jobs at once = N pinned worker threads | Safe at ≤ 4; revisit only if the auto formula changes |
| 8 | Windows Ghostscript resource folder is missing (open blocker, `docs/bugs.md`) | PDF compression does not work on Windows | Not a resource issue, but it blocks the Windows tier completely |

---

## 10. Open assumptions (check or correct these)

1. OOXML compression ratio assumed **3–5×**. Decks full of JPEG/MP4 media compress much less (≈1–1.5×), which *lowers* RAM use but not the snapshot-and-copy structure cost.
2. x264 encode speed assumed **2–4× the clip length at 1080p on an 8-core** (preset `medium`, ffmpeg default). On slower laptops, halve the speed estimates.
3. vips RAM assumed **2–3× the pixel buffer**. Animated or multi-page inputs could need more.
4. Webview base RAM assumed from typical WKWebView/WebView2 behavior. Measure on the target OS versions.
5. The extreme scenario assumes 1080p videos. A batch of 4K videos moves the RAM load from the document model to the video model (§3.2) and roughly doubles encode time.

*When any of these is measured, update the matching §3 row and re-derive §6–7.*
