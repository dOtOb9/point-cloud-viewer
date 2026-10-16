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

## After L3-C (compact spill and run records), 2026-10-17

Change: the spill and LOD run records are the output's point record, with x, y, z as the output's i32 (options B and C of
`BENCH-multi-billion.md` section 3). Record size per point (from `record::tests::record_widths`):

| point format of the input | output format | before | after |
|---|---|---|---|
| 3 (GPS time + RGB), the Tokyo data | 7 | 57 B | **36 B** |
| 1 or 6 (GPS time, no RGB) | 6 | 51 B | **30 B** |
| E57/PLY/PCD import (offset known only after the last point, so x, y, z stay f64) | 6 or 7 | 49 B (RGB, no GPS) | 48 B (RGB), 42 B (no RGB) |

Extra bytes are added to each figure as before. Format 8/10 (NIR) and waveform formats are refused as before (now already in `SpillWriter::create`).
The 36 B is exactly the size of the PDRF 7 record in the output, so node compression no longer re-encodes quantized records.

### Is the output the same?

- Unit tests: the stored bytes of a spill record equal what `encode_point_record` makes for the output (`spill::tests`), the record builder gives the same nodes
  as the f64 index reference for grid points (`lod::tests::quantized_records_match_index_reference_for_grid_points`), and
  `tests/compact_records_match_wide.rs` writes the same 30,000 points through a quantized spill and a wide (f64, the old layout) spill and requires
  **byte-identical COPC files** (RGB / no RGB, with / without GPS, 3 extra bytes, disk levels and all-in-memory, one thread). `cargo test --workspace` passes
  including `streaming_conversion.rs`, which records a hash of a converted file.
- 4 tiles (09LD2626-2629, 30,043,046 points), release `merge_las_to_copc --sequential-compress` (one worker, so the chunk order is fixed), old build (commit b057ee9) and new build:
  both outputs are 378,755,269 bytes with **the same SHA-256** (5CDF4CB7AAFCAFF2EB046F71BB7CC5B9BC32C4C5688FDD975AAC452F8807C314). The default parallel run of the new
  build gives the same 593 nodes and 30,043,046 points per `compare_copc_nodes`.
- 55 tiles (347,797,138 points): `compare_copc_nodes` old output vs new output: SAME, 6,462 nodes, 347,797,138 points (compares the multiset of the viewer's
  point fields per node; the byte equality above is the check for all other fields). The first version of that tool kept both files in memory and
  needed 30 GiB for this size, so it now compares node by node.
- Where the result can differ (not seen in the data above): the octant of a point is decided from `scale * i + offset` of the stored integer. For points on the
  output grid that equals the f64 coordinate (LAS reads give exactly that expression). A point off the grid within half a step of an octant plane may go to the
  other child. Possible only with merged files whose scale/offset differ from the first file. The 55 tiles showed no difference.

### Measured: 55 files, 347,797,138 points, same session, same script

Release `merge_las_to_copc <data\tokyo-shibuya> <out> 100000 <spill_dir> --assume-missing-crs-is-first --timings`, TMP/TEMP and the spill dir under the scratchpad on C:,
monitor aborts below 25 GB free, no other conversion process running at the start. One run each, old build (b057ee9) measured right after the new one on the same machine state.

| Item | before (b057ee9, run today) | after L3-C |
|---|---|---|
| Read + decode | 34.04 s | 57.08 s |
| Spill write (`push`) | 16.96 s | 38.45 s |
| LOD index + node compression | 225.69 + 5.74 = 231.43 s | 109.54 + 5.62 = 115.16 s |
| Header / hierarchy | 0.06 s | 0.99 s |
| **Total (tool)** | **298.29 s** (wall 300 s) | **241.20 s** (wall 243 s) |
| Output size | 4,221,548,961 bytes | 4,221,548,959 bytes |
| Spill size (sampled) | 18.46 GiB (57 B x 347.8M, computed) | 11.66 GiB (sampled; 36 B x 347.8M) |
| Peak private memory (sampled) | 308 MiB | 308 MiB |
| Disk use (free before - lowest free) | 37.09 GB | 23.08 GB |

(The L3-B table above recorded 294.56 s and 21.0 GB for the old method; the 294.56 s agrees with 298.29 s today, the 21.0 GB does not agree with the 37.09 GB measured now. 37.09 is
2 x 18.46, the parent run plus the child runs of the first split, so the 21.0 figure probably missed the peak.)

Reading: total 298 -> 241 s (-19%), disk peak 37.1 -> 23.1 GB (-38%, 2 x the spill, as the bound test says). The LOD + compression part halves (231 -> 115 s). The ingest part got
longer: the spill write 17 -> 38 s is expected (each point is now quantized and encoded once at `push`, work that used to be done later in the node compression), but the read + decode
34 -> 57 s is code that this change did not touch, so it is probably run-to-run noise (cold input cache, other load); with one run each this is not separated. The ingest is a single thread, so
quantizing at `push` costs about 21 s here; moving it to the reader threads would be a next step (not done).

An earlier run of the new build for this table showed 670.81 s. It was **discarded**: the monitor wrote no sample between t = 293 s and t = 669 s and the process used only 16 CPU seconds in that gap,
so the machine itself was paused (most likely suspended); the output of that run was still valid and was used for the node comparison above. Its process counters at the end were 89.9 GiB read and
71.5 GiB written (L3-B run: 136.7 GiB read, ~112 GiB written), i.e. the explicit I/O fell by about a third, as the smaller records predict.

### (c) 110 files, 726M points: not run

Free space before: 69.3 GB (after deleting my outputs). Estimated peak from the (a) ratio: 23.08 GB x 726M / 347.8M = about 48 GB. Required: 48 + 25 (watchdog) = 73 GB > 69.3 GB, so it was not started.
Needed to run it: about 75 GB free on C:. Not measured, no numbers claimed. (The old method would need about 77 GB for the peak alone by the same ratio.)

### Not checked

- Opening the new output in the viewer on a real GPU, and the Android build. The Web build was compiled (`npm run build:wasm`) and the unit/integration tests that use the Web code path
  (`MemoryScratchFs`) pass; see the E2E result in the report.
- Memory use on the Web with a real file in OPFS (only `MemoryScratchFs`).
