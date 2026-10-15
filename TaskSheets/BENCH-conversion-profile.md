# BENCH: conversion profile (L2-E) — which stage grows faster than the point count

- Date: 2026-10-14/15
- Goal: earlier, 1.055 billion points (3275 s) took 5.8x as long as 348 million points (565 s) for a 3.03x point ratio.
  Collect per-stage numbers to find the stage that grows super-linearly. **No optimization was done here**; diagnosis is the coordinator's job.
- Tool: `merge_las_to_copc` (see `TOOL-merge-las-to-copc.md`). The only code change is an opt-in `--timings` flag on the example
  (prints the writer's existing `IngestStageTimings` / `PostProcessStageTimings`; off by default).

## Machine

| Item | Value (from the command output) |
|---|---|
| RAM | 31.8 GiB (`Win32_ComputerSystem.TotalPhysicalMemory`) |
| Disk | KIOXIA-EXCERIA PLUS G3 SSD, MediaType SSD, BusType NVMe, 1 TB (`Get-PhysicalDisk`) |
| Spill dir / output | scratchpad on drive C (same drive as the input data) |

## How it was measured

`run.ps1` (in the session scratchpad, not committed) starts the exe, then every ~2 s records: PrivateMemorySize64,
`ReadTransferCount` / `WriteTransferCount` (from `Win32_Process`), free space of C:, the size of the spill-dir files, and the output size.
It kills the process if C: free space drops below 25 GB (never fired; lowest seen was 28.0 GB in run (b)).
Command per run: `merge_las_to_copc <input> <out> 100000 <spill_dir> --assume-missing-crs-is-first --timings`.
Input for (a) is `data\tokyo-shibuya` (55 files), for (b) `data\tokyo-23ku-1b-all` (165), for (c) hard links to the first 110 files (by name) of (b).
No other `merge_las_to_copc` / `pcv-convert` process was running at the start of any run (`Get-Process` checked before each; (c) and (b) were run back to back by one script).
Other agents' CPU/disk load during the runs was **not** monitored, so interference is possible.

Stage boundaries were derived by combining the tool's `TIMINGS` line with the sampled counters (the process read counter stops growing when ingest ends;
compress start = total - compress time). They are approximate to the sampling interval.

## Results

Points: (a) 347,797,138; (c) 726,293,742; (b) 1,055,184,468. Point ratio (c)/(a) = 2.09, (b)/(a) = 3.03.

### Time per stage (seconds, from the tool's own `TIMINGS` output)

| Stage | (a) 55 files | (c) 110 files | (b) 165 files | (c)/(a) | (b)/(a) |
|---|---|---|---|---|---|
| Read + decode input | 54.39 | 123.92 | 123.66 | 2.28 | 2.27 |
| Spill write | 33.04 | 63.87 | 64.60 | 1.93 | 1.96 |
| LOD index (octree split) | 207.76 | 630.51 | 914.87 | 3.03 | 4.40 |
| Node compression + write | 63.43 | 1655.18 | 3481.43 | **26.1** | **54.9** |
| Header / hierarchy | 0.03 | 0.07 | 0.01 | - | - |
| Not inside any timer (ingest end to LOD start, estimated) | ~26 | ~57 | ~55 | - | - |
| **Total (tool)** | **386.20** | **2533.41** | **4641.22** | **6.56** | **12.0** |

Compression throughput (points / compress second): (a) 5.48 M/s, (c) 0.44 M/s, (b) 0.30 M/s.

### I/O and memory (process counters; see caveat below)

| Item | (a) | (c) | (b) |
|---|---|---|---|
| Process read counter at end of ingest | 11.0 GiB (= input size) | 23.0 GiB | 33.4 GiB |
| Process write counter, end of ingest | 19.7 GiB | 38.6 GiB | 56.1 GiB |
| Process write counter, end of LOD stage | 37.6 GiB | 81.1 GiB | 118.9 GiB |
| Process write counter, total | 41.5 GiB | 89.3 GiB | 131.1 GiB |
| Output size | 4221.55 MB | 8870.64 MB | 13114.39 MB |
| Spill file size (max, sampled) | 18.5 GB* | 38.6 GB | 56.0 GB |
| Peak private memory (sampled) | 309 MiB | 332 MiB | 381 MiB |
| Peak working set | not recorded | ~20 GB (coordinator saw "about 21 GB" on the live process; not logged) | 22.4 GB (sampled every 10 s from ~7 min in) |
| Max disk use (free before - lowest free) | 37.6 GB | 59.7 GB | 84.5 GB (lowest free 28.0 GB at t=1017 s) |
| Seconds spent in compress stage | 63 | 1655 | 3481 |
| Read counter growth during LOD + compress | 0 | 0 | 0 |

\* (a)'s spill column was recorded by an earlier version of the monitor script; the value is plausible next to the free-space drop but is less trustworthy than (b)/(c).

Caveats:

- `ReadTransferCount` / `WriteTransferCount` count explicit read/write calls. The writer memory-maps its temp files, so **page-ins / page-outs through mmap are not in these counters**.
  The read counter being flat after ingest therefore does **not** mean nothing is read from the spill file during LOD / compress.
- Private memory excludes mapped file pages; the working set (22.4 GB in (b), about 70% of RAM) includes them.
- The CSV time column is formatted with a thousands separator ("1,146.7"), which was repaired when parsing rows after t = 1000 s.
- One run per size; no repeats. Run-to-run variation is unknown, but the earlier recorded run of (b) took 3275 s and this one 4641 s (1.42x), so it is large or the machine state differed.
- (a)'s output is 4221.55 MB here but 4621.35 MB in `TOOL-merge-las-to-copc.md`; the code changed between those runs (not investigated).

## What the numbers say

Observed:

1. Read/decode and spill write grow about linearly (2.27x and 1.96x for 3.03x points).
2. The LOD-index stage grows somewhat faster than linear (3.03x for 2.09x; 4.40x for 3.03x points).
3. **Node compression is the stage that blows up**: 63 s, 1655 s, 3481 s, i.e. 26x and 55x for 2.09x and 3.03x points. It is 75% of the total in (b) (3481 of 4641 s) but 16% in (a).
   Throughput drops 18x from (a) to (b). Per-sample rows show it is slow throughout the stage, not a single stall.
4. During compress the process wrote only about 12 GiB (131.1 - 118.9), about the output size, so the explicit write volume is not the problem.
5. Memory (private) stays at 0.3-0.4 GiB, matching the "not proportional to points" rule.

Consistent with, but **not proven** by, the data (estimate):

- The spill file size relative to RAM: (a) 18.5 GB < 31.8 GiB RAM, (c) 38.6 GB and (b) 56.0 GB > RAM. The compress slowdown appears exactly when the spill no longer fits in the page cache.
  A likely explanation is random or scattered access to the memory-mapped spill/LOD data by the compress stage causing page-cache thrashing. This was **not verified**
  (no mmap page-fault counters, no CPU-vs-disk split, no experiment with a smaller spill or more RAM was run).
- The LOD stage may be partly affected by the same effect (its excess is smaller).

Not established:

- CPU usage per stage (not sampled), so CPU-bound vs disk-bound is unknown.
- Disk-level read throughput (the system-wide disk counters were not sampled).
- Whether a different order of node compression (by spill offset) would help; nothing was tried.
- Whether the 1.42x difference with the earlier (b) run comes from system load or from code changes.

## Suggested next measurement (not done)

Sample `Get-Counter '\PhysicalDisk(*)\Disk Read Bytes/sec'` and `'\Process(merge_las_to_copc)\Page Faults/sec'` plus per-process CPU during the compress stage of (b) or (c),
or run (c) with RAM-limited vs larger page cache, to confirm or reject the page-cache explanation.

## Files touched

- `crates/pcv-convert/examples/merge_las_to_copc.rs`: `--timings` flag (prints `TIMINGS ...`; default behavior unchanged).
- `TaskSheets/BENCH-conversion-profile.md` (this file).

Outputs and spill files of all three runs were deleted afterwards; nothing under `data\` was modified (the 110-file set used hard links in the scratchpad, since removed).
Raw logs (`samples.csv`, `stdout.txt` per run) remain in the session scratchpad only.

## How to reproduce

```powershell
cargo build -p pcv-convert --release --example merge_las_to_copc
.\target\release\examples\merge_las_to_copc.exe C:\rust\point-cloud-viewer\data\tokyo-shibuya <out.copc.laz> 100000 <spill_dir> --assume-missing-crs-is-first --timings
```

## After ADR-0019 (L3-B): record-carrying LOD, small subtrees finished in memory

What is measured and what is not (read this first):

- **Measured**: a 4-file subset of `data\tokyo-shibuya` (09LD2626-2629, 30,043,046 points), old build (origin/main, built in a
  scratchpad copy) vs new build, same machine, one run each. Output compared node by node.
- **NOT measured**: the three target runs (a) 55 files / 348M, (c) 110 files / 726M, (b) 165 files / 1.06B points. When I tried, free space on C: was
  only 28 GB (112 GB at the first attempt), below the 25 GB abort limit given for the runs, so the run was aborted by the watchdog after 35 s.
  Another agent's `new2.exe` (the L2-H benchmark) was also running at the first attempt, and the one (a) run that finished then (753 s) is
  not usable: it was the first version of the code (two passes per level) and ran next to that process (spill write 127 s vs 33 s in the table above).
  So the table "before" above has no "after" column yet. The commands to fill it are at the end of this section.

### 4-file subset, old vs new (one run each, other load on the machine unknown)

| | old (origin/main) | new |
|---|---|---|
| Total (tool) | 61.8 s | 35.2 s (second to last run; 34.6-44 s over 5 runs of intermediate versions) |
| Read + decode | 7.03 s | 3.4 s |
| Spill write | 3.46 s | 2.2 s |
| LOD index | 38.52 s | 24.9 s (= wall time with at least one disk partition running) |
| Node compression | 9.18 s | 0.9 s (= rest of the node pass) |
| Output size | 378.75 MB | 378.76 MB |
| Node set / points | 593 nodes, 30,043,046 points | `compare_copc_nodes`: SAME (every node holds the same multiset of points as seen by the viewer) |

Notes: the spill write is faster partly because temp files are no longer fsynced (`sync_all`) in `finish_temp`. With the default
budget (1 GiB, 8 workers = 64 MiB per subtree) 30M points need two disk levels. In this machine the disk levels were disk-write-bound
(root partition of 1.6 GB took 8 s alone, about 200 MB/s; with 8 partitions running together each took 8-12 s), so the LOD line is
the part to look at in the large runs.

### Which old line is which new line

| old `--timings` field | new meaning |
|---|---|
| LOD index (octree split) | wall time during which at least one run is being partitioned on disk |
| Node compression + write | rest of the node pass: in-memory subtree building, compression, chunk writes (overlaps with the above in reality) |

Compare the sum of the two, not each line.

### Correctness checks that were run

- `lod::tests::record_builder_matches_index_reference`: old index-based builder (kept in `src/lod_reference.rs`) vs new builder, exact node-by-node,
  point-by-point and in the same order, for 5 inputs x 4 memory limits (all on disk, mixed, all in memory).
- `compare_copc_nodes` on the 4-file subset (above).
- `cargo test` in vendor/copc-writer with and without `--features parallel`, workspace tests, clippy, Web E2E (`PCV_E2E_PORT=4391`, 2 passed).
- `tests/heap_is_bounded.rs`: heap peak 11.6 MB at 50,000 and at 400,000 points with 1 worker; 11.6 MB vs 13.9 MB with 4 workers.
- `tests/lod_runs_bounded.rs`: live temp bytes never exceed 2.1x the spill size.

### To fill the table (needs about 120 GB free on C: for (b); abort below 25 GB)

```powershell
cargo build -p pcv-convert --release --example merge_las_to_copc
# per run: TMP/TEMP and the spill dir on C:, --timings, sample private memory, free space, process read/write counters
merge_las_to_copc <input> <out.copc.laz> 100000 <spill_dir> --assume-missing-crs-is-first --timings
cargo run -p pcv-convert --release --example verify_merge -- <out.copc.laz> <inputs...>
```
Not checked: opening the new output in the viewer on a real GPU (only the Web E2E on SwiftShader and the node comparison were done).

### Measured on the real data (B1, 2026-10-16): (a) 55 files, 347,797,138 points

Build: origin/main at the time (record-carrying LOD included), `cargo build -p pcv-convert --release --example merge_las_to_copc`.
Command: `merge_las_to_copc <data\tokyo-shibuya> <out> 100000 <spill_dir> --assume-missing-crs-is-first --timings`, TMP/TEMP and spill dir under the scratchpad on C:.
Sampled every ~2 s (113 samples; same monitor as above, abort below 25 GB free). One run, no repeats. No other `merge_las_to_copc` process was running at the start;
other agents' load was not monitored. The output passed `verify_merge` (347,797,138 points, bounds equal to the union of the inputs, colored nodes present).

| Item | before (table above) | after ADR-0019 (this run) |
|---|---|---|
| Read + decode | 54.39 s | 39.73 s |
| Spill write | 33.04 s | 18.43 s |
| LOD index + node compression (compare the sum) | 207.76 + 63.43 = 271.19 s | 214.46 + 4.34 = 218.80 s |
| Header / hierarchy | 0.03 s | 0.40 s |
| **Total (tool)** | **386.20 s** | **294.56 s** (wall, monitor: 295.3 s) |
| Output size | 4221.55 MB | 4221.55 MB (4,221,548,960 bytes; same size as before) |
| Peak private memory (sampled) | 309 MiB | 308 MiB |
| Peak working set (sampled) | not recorded | 299 MB |
| Process write counter, total | 41.5 GiB | ~112 GiB (last sample 103.7 GiB at 278 s; final value not sampled) |
| Process read counter, at last sample | 11.0 GiB (end of ingest; flat afterwards) | 136.7 GiB (not flat: runs are now re-read explicitly) |
| Max spill-dir size (sampled) | 18.5 GB | 20.8 GB (includes partition run files; the dir is where the writer keeps them) |
| Disk use (free before - lowest free) | 37.6 GB | 21.0 GB (68.8 -> 47.75). Includes the 4.2 GB output; free space also moves with other processes, so this is approximate |
| Node count | not recorded | not recorded (`verify_merge` does not print it) |

Reading: total is 24% shorter (386 -> 295 s); the ingest part is shorter too (spill write 33 -> 18 s, read 54 -> 40 s), but the machine state may differ between the two
measurements, so only the sum of LOD + compression is a fair stage comparison (271 -> 219 s, -19%). Private memory is unchanged at ~0.3 GiB.
Explicit I/O went up about 2.7x in writes (41.5 -> ~112 GiB) and the read counter now grows through LOD, which matches record-carrying runs being written and read back;
time still went down. Whether that stays true when the data does not fit the page cache is the (c)/(b) question below.

### (c) 110 files, 726M points: aborted by the watchdog, NOT measured

Free space before: 85.1 GB, which is above "estimated peak + 25 GB" using the (a) ratio (21 GB x 2.09 = ~44 GB). The estimate was wrong: the spill alone reached 38.5 GB
(end of ingest at ~150 s, write counter 38.6 GiB, same as the old (c)), and during the first ~80 s of the LOD stage free space fell from 46.5 GB to 28.2 GB (~0.07 GB/s... about 18 GB in 80 s).
At t = 239 s free space reached 24.7 GB and the monitor killed the process (exit -1, as designed). So the peak disk use of the new method for (c) is **more than 60 GB**
(not known; old method: 59.7 GB). Output and spill were deleted; C: free is back to ~84 GB. No time/memory figures for (c) are claimed.
Private memory stayed at 94-308 MiB for the 240 s that ran (sampled), so the memory property held in the part that ran.
To run (c) or (b), about 130-150 GB free would be needed (estimate: spill 38.5 GB + up to 2.1x-spill live run bytes, the bound tested in `tests/lod_runs_bounded.rs`, + 9 GB output);
or lower the watchdog limit, which was not done here because C: is shared with other work.
