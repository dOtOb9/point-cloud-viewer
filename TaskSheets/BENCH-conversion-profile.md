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
