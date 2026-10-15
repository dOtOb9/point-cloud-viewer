# BENCH: multi-billion point conversion and display (L3-A)

- Date: 2026-10-15
- Owner request: "make and measure data of several billion up to 10 billion points"
- Machine: 31.8 GiB RAM, one NVMe SSD (KIOXIA EXCERIA PLUS G3, 1 TB), drive C only, no external disk.
- Unit note: "GiB" is 2^30 bytes, "GB" is 10^9 bytes. `BENCH-conversion-profile.md` prints "GB" for values that are
  really GiB (its 56.0 "GB" spill is 56.0 GiB = 57 B x 1,055,184,468 points). This file says which unit it uses.

## 1. What was changed

### 1.1 Point indices are no longer limited to u32 (`vendor/copc-writer/src/lod.rs`, `writer.rs`)

The 4.29 billion point limit (2^32) came from the temporary LOD index files, which stored every point index as a `u32`
(`INDEX_RECORD_BYTES = 4`) and from `checked_total_points`, which rejected `len() > u32::MAX`.

- New `IndexWidth { U32, U64 }` in `lod.rs`. It is chosen once from the total point count
  (`<= 2^32` points: 4 bytes per index as before; above: 8 bytes) and travels with every run
  (`IndexRun.width`) and with the result (`LodIndex.index_width`). `encode_node_points` in `writer.rs` reads the order file with it.
- Why two widths and not always `u64`: always writing 8 bytes would double every LOD temporary file for the common case
  (a 1.05 billion point run has about 4 GiB per live copy of such a file). Above 2^32 points there is no choice.
- `checked_total_points` now only converts `usize` to `u64`; there is no upper limit left in the writer.
- Not changed because they were already 64-bit: `SpillWriter.count` (u64), spill offsets, `MultiFileLasPoints.points_read` and
  `declared_points_total` (u64), LAS header `total_point_count` (u64; `legacy_point_count` is already written as 0, correct for PDRF 6+),
  chunk-table offsets (u64). Hierarchy entries carry a per-node count as `i32`, which is fine (a node holds 100,000 points).
- wasm32: `usize` is 32 bits there, so the web build is still limited by its address space (the known 4 GB limit). It compiles
  (`cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown --all-targets -- -D warnings` passes).
- Tests (`cargo test --manifest-path vendor/copc-writer/Cargo.toml`, also with `--features parallel`): 24 passed.
  `index_width_switches_above_u32_range` checks the boundary (2^32 points -> U32, 2^32+1 -> U64) and a 64-bit round trip;
  `wide_index_files_give_the_same_order` forces the 8-byte files on 600 points and checks the nodes and the order are identical
  to the 4-byte files. **The U64 path has not been run on a real file above 2^32 points** (that needs about 340 GB of
  temporary disk with the current layout; see section 3).

### 1.2 `synthetic_copies_to_copc` example (`crates/pcv-convert/examples/`)

Reads the real Tokyo 23-ku tiles (165 files, 1,055,184,468 points, CC BY 4.0) N times and shifts copy `k` by
`(k % cols) * 5000 m` in X and `(k / cols) * 5000 m` in Y (`cols = ceil(sqrt(N))`; the source area is about 4.4 km x 4.5 km, so copies do not overlap).
It feeds the same `write_streaming_with_cancel_and_timings` as `merge_las_to_copc`. No input file is created: the extra disk is
only the spill and the output. Only one file and one batch are in memory at a time. Points of copies 2.. are copies, not data.

```powershell
synthetic_copies_to_copc.exe <dir with the 165 las> <out.copc.laz> <copies> <spill_dir> --timings
```

## 2. Disk estimates

Reference run (L2-E, run (b), 1,055,184,468 points, current method):

| Item | Value | Per point |
|---|---|---|
| Spill file | 56.0 GiB | 57 B (see 4.1) |
| Output COPC | 13,114,389,440 B = 12.21 GiB | 12.43 B |
| Peak disk use (free before - lowest free) | 84.5 GiB | 86 B |
| Rest (LOD index files and so on) = peak - spill - output | 16.3 GiB | 16.6 B (about 4 files of 4 B/point) |

Extrapolation assumes everything is proportional to the point count (true for the spill and the output by construction;
the LOD-file share is an estimate). Free space on C when nothing else runs: 233.7 GB = 217.7 GiB; the abort threshold of the watchdog is 25 GiB.

| Points | Method | Spill | LOD index files | Output | Peak total (est.) | Fits in 217.7 GiB - 25 GiB? |
|---|---|---|---|---|---|---|
| 2.11 B (2 copies) | current, U32 | 112 GiB | 33 GiB | 24.4 GiB | 169 GiB | yes (leaves about 48 GiB) |
| 3.17 B (3 copies) | current, U32 | 168 GiB | 49 GiB | 36.7 GiB | 254 GiB | **no** |
| 4.22 B (4 copies, the largest U32 case) | current, U32 | 224 GiB | 65 GiB | 48.9 GiB | 338 GiB | **no** |
| 10.55 B (10 copies) | current, U64 (LOD files x2) | 560 GiB | 330 GiB | 122 GiB | about 1,010 GiB | **no** (about 5x the free space) |

So on this disk the current method reaches about 2.4 billion points at most (192.7 GiB / 86 B), i.e. 2 copies is the largest whole number.

## 3. Spill record: bytes per point and how to shrink it

Layout from `copc-core::streaming` (`StreamingLayout::record_width`). For the Tokyo data (point format 3: GPS time + RGB):

| Field | Bytes |
|---|---|
| x, y, z as f64 | 24 |
| intensity | 2 |
| return number, number of returns, classification, scan direction, edge of flight line | 5 |
| scan angle f32 | 4 |
| user data | 1 |
| point source id | 2 |
| synthetic, key point, withheld, overlap flags (one byte each) | 4 |
| scan channel | 1 |
| GPS time f64 | 8 |
| RGB u16 x 3 | 6 |
| **Total** | **57** |

The final COPC uses 12.43 B/point for the same information (LAZ compression), so the spill is 4.6x larger than the output.
Options to shrink it (estimates; **nothing was implemented**). "Spill at 10 B points" is the record data alone, decimal GB:

| Option | Bytes/point | Spill at 10 B points | Cost / risk |
|---|---|---|---|
| A. Current | 57 | 570 GB | - |
| B. x, y, z as i32 (the output scale/offset, known from the first header; the writer quantizes to i32 anyway) | 45 | 450 GB | Needs the scale before the first record; with merged files of different scales the quantization step moves to the input side. Lossless w.r.t. the output |
| C. B plus the 6 one-byte flags in one byte, the 4 return/scan fields packed, scan angle as i16 | about 36 | 360 GB | Packing code on both sides; lossless w.r.t. the output |
| D. Keep only what the viewer shows (xyz i32, RGB, intensity, classification) | about 21 | 210 GB | **Drops GPS time, return numbers, scan angle, source id from the COPC.** Product decision, not a pure optimization |
| E. Records stored LAZ-compressed in chunks (as the output is) | about 12.4 (measured for the output) | 124 GB | Possible only if runs are read sequentially (ADR-0019). Costs CPU: the full-data LAZ write took about 63 s per 0.35 B points on the best run (BENCH-conversion-profile), so on the order of 30 min per pass over 10 B points. Estimate |

With ADR-0019 (runs carry records; a run is deleted after it is partitioned) the top level holds the parent run and its 8 children
at the same time, so the peak is about **2 copies of the record data** (+ the output only at the end). Per option at 10 B points:
A 1,140 GB, B 900 GB, C 720 GB, D 420 GB, E 248 GB. Available: 233.7 GB - 25 GiB guard = about 207 GB.
**None fits.** The output alone is 124 GB, leaving about 83 GB = 8.3 B/point for everything temporary.

What would fit (design question for the coordinator, not done): E **and** storing each run as many segment files (for example 1 GiB each) that are deleted
as soon as they are consumed. Then the peak is about 1 copy (124 GB) plus one segment plus the output written so far, which stays under the free space
(the sum of "unconsumed run data" and "output so far" stays near 124-150 GB). Without segment deletion even E needs 248 GB.

## 4. Things that grow with the point count (for 10 B points)

Current method (index files, U64 above 2^32 points):

| Item | Where | At 10 B points |
|---|---|---|
| Root run (all indices) | disk | 80 GB (74.5 GiB) |
| `order` file (final per-node index lists) | disk | 80 GB |
| Partition / remainder files | disk | about 80 GB live at the top level |
| `nodes` (`LodNodeRange`, 32 B) and the hierarchy | **memory** | 1.055 B points have 23,833 nodes (44k points per node), so 10 B points have about 226,000 nodes: about 7 MB for `nodes` plus the hierarchy entries and chunk table, a few tens of MB in total (estimate from the node count) |
| Everything else | memory | bounded (I/O buffers); the private memory peak was 381 MiB at 1.05 B points (L2-E) |

`order` is **not** held in memory; it is a disk-backed `ScratchReader`. Memory is not proportional to the points. Point-proportional
**disk** is the problem. One cheap fix visible in the code: `LodIndexBuilder::assign` keeps its input `run` alive until all children are done, so the root run
(4 B/point, 8 B above 2^32) lives for the whole stage; dropping it right after the first partition saves one file's worth.
ADR-0019 removes these index files altogether (records are carried instead).

## 5. Other space on drive C (sizes only, nothing was deleted)

Measured with `Get-ChildItem -Recurse` while no big conversion ran (sizes in GiB):

| Location | GiB |
|---|---|
| `C:\rust\point-cloud-viewer\data` as listed (`tokyo-23ku-1b-all` is hard links of `tokyo-23ku-1b` + `tokyo-shibuya`, counted twice) | 104.0 listed, about 70.6 real |
| - inputs `tokyo-23ku-1b` (22.4) + `tokyo-shibuya` (11.0) | 33.4 (needed for the benchmark) |
| - `tokyo-23ku-1b.copc.laz` 12.2, `tokyo-shibuya-merged.copc.laz` 4.3, `-merged-v2` 3.9, `sofi.pcd` 8.8, `points-jack_he.copc.laz` 4.1, `sofi.copc.laz` 1.9, `beer*` 1.0, `m4-1-out` 0.5, others | about 37 |
| `C:\rust\point-cloud-viewer\target` | 18.7 |
| `C:\rust\point-cloud-viewer\.claude\worktrees` (mostly each worktree's `target`) | 15.7 |
| `C:\rust\point-cloud-viewer\src-tauri\target` | 0.9 |
| `%TEMP%` in total | 40.0, of which `...\Temp\claude\...` 29.7 (this session's scratchpad 23.5, an earlier session 4.2 incl. a 3.9 GiB copy of the Shibuya COPC) |
| `~\.cargo\registry` 1.4, `~\.rustup` 4.3, `node_modules` 0.2 | 5.9 |

Reclaimable without touching the benchmark inputs: about 85 GiB (the old merged COPC files, `sofi.pcd`, worktree `target` dirs, scratchpad leftovers).
That would raise the free space from 217.7 to about 300 GiB, enough for 3 copies (254 GiB) with the current method but still not 10 B points.

## 6. Measurements

**Not done.** The 2-copy run (estimated peak 169 GiB) was not started, so there are no timings, memory peak, disk peak or viewer numbers
(open time, fps) for 2 B points. Reason: the shared disk was never free enough while the run was due.

- From 2026-10-15 about 20:00 to 23:56, L2-H and L3-B ran conversions back to back (`merge_las_to_copc.exe`, `new2.exe`, `base.exe`, `l3b-merge.exe`,
  in `C:\pcv-bench-l2h` and the coordinator's scratchpad). Several times a check showed no conversion process, and a few minutes later another had started.
- Free space on C: was 104 GiB, then 87, 57, 41, 29 GiB while those ran, and 24-26 GiB at the last check (23:56) with no conversion process visible
  (a 16.5 GiB spill file of L2-H, `C:\pcv-bench-l2h\spill_new2_a2`, was still there; the rest of the used space was not traced). The 2-copy run needs about 169 GiB
  plus the 25 GiB guard, so it would have been aborted at once by the watchdog.
- Nothing of mine was left on disk (no output, no spill). `data\` was not changed.

Prepared and ready (in the session scratchpad, not committed): `l3a\runmon.ps1` starts `synthetic_copies_to_copc.exe`, samples every 5 s
(private memory, free space, sizes of spill / root / partition / remainder / order files, output size), stops the process when free space < 25 GiB,
and always deletes the spill (and the output unless `-KeepOutput`). The viewer measurement should reuse the earlier `bench1b\m3.mjs` method
(`BENCH-1b-points.md`, headed Edge/Chromium, `adapter.info` not SwiftShader).

To run it (owner or coordinator), once nothing else converts and at least 200 GiB are free:

```powershell
cargo build -p pcv-convert --release --example synthetic_copies_to_copc
.\runmon.ps1 -Exe <exe> -InDir C:\rust\point-cloud-viewer\data\tokyo-23ku-1b-all -Out <out.copc.laz> -Copies 2 -Spill <spill_dir> -Log <log> -KeepOutput
```

Because ADR-0019 replaces the LOD stage (L3-B), a 2 B run with the current method is only a baseline for comparison; the same command
works for the new method.

## 7. What 10 billion points on this machine would need

1. A temporary-disk design far smaller than today's: at most about 8 B/point of temporary data next to the 12.4 B/point output (section 3).
   Records stored compressed (about 12 B) **and** run files deleted segment by segment are the only combination found that fits about 207 GB.
   ADR-0019 alone (uncompressed records, 57 B, two copies at the top) needs about 1.1 TB; with the 36 B packed record about 720 GB.
2. Or more disk: about 1 TB free for the current method, about 250 GB for ADR-0019 with compressed records and no segment deletion.
   An external disk is not available, so (1) is the only path on this PC.
3. The index width is solved (section 1.1), but the 8-byte index files are only relevant to the current method; ADR-0019 removes them.
4. The input: 10 B real points would be about 340 GB of LAS, so only the synthetic input is possible here.
5. Time: the current method is super-linear once the spill exceeds RAM (compression 55x for 3x points, BENCH-conversion-profile). A 10 B run
   with it would not finish in a useful time; sequential passes (ADR-0019) are a precondition.
6. Viewing: the viewer opens a COPC through the root hierarchy page (open time did not grow from 0.35 B to 1.05 B points), so a 10 B file is expected to open
   as fast; **unverified**. The u32 limit on the reader side (point counts above 2^32 in the LAS header) was not checked.

## 8. Not verified

- Everything in section 6 (no run was made); every disk figure for more than 1.05 B points is an extrapolation.
- The U64 index files on a real file above 2^32 points (only the forced-width unit test).
- The share of the LOD index files in the 84.5 GiB peak (16.6 B/point is the remainder, not a measured per-file breakdown).
- The 10 B memory figures (node count extrapolated from 23,833 nodes at 1.05 B points).
- Whether the viewer reads a file with more than 2^32 points.
