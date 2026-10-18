# M4-17: merge several files of any format (LAS/LAZ/PLY/PCD/E57) into one COPC

Status: planned 2026-10-18 (coordinator, Opus). Implementation: two tracks, Desktop (D) and Web (W).

## Problem

Opening one PLY / PCD / E57 file works on both builds. Choosing several files works only when all of them
are LAS/LAZ: `runOpen` in `src/app/open-files.ts` refuses anything else with
"複数ファイルの選択はLAS/LAZのみ対応しています". The owner wants every openable format to be mergeable,
including mixes of LAS/LAZ with the other formats.

## Owner decisions (2026-10-18)

1. **Mixing LAS/LAZ with PLY/PCD/E57 is allowed.**
2. **Color:** if at least one input has color, the output has color; points from inputs without color get
   mid gray `[32768, 32768, 32768]` (16-bit). If no input has color, the output has no color.

## Design

Two routes, chosen by the set of input formats:

| Inputs | Route | What is kept |
|---|---|---|
| all LAS/LAZ | **unchanged** existing merge (desktop `pcv_convert::merge`, Web `WasmConverter::openNextFile`) | everything, as today |
| at least one PLY/PCD/E57 | **new "point merge"**: every file becomes a stream of `RawPoint` (x, y, z, color, intensity), and the streams are read one after another into one spill | x, y, z, color, intensity only |

Why not send all-LAS through the new route too: it would silently drop classification, GPS time and
return numbers that the existing merge keeps. The existing route stays the default for LAS-only sets.

The point merge reuses what single-file import already does:

- Desktop: `crates/pcv-convert/src/import/` — `PointSource` (`point.rs`) and `run_import` (`convert.rs`).
- Web: `crates/pcv-wasm/src/point_file_import.rs` — `PointStream` and `WasmPointFileConverter`.

Both already stream one point at a time into `SpillWriter`, and choose scale/offset after the spill is
finalized (`choose_scale_offset`). Merging = "when one file ends, continue with the next file's stream
into the same spill". Memory must stay independent of the point count (CLAUDE.md "メモリ").

### Shared rules (both tracks must behave the same)

- **Routing:** all inputs LAS/LAZ → existing route; otherwise → point merge. Decide by extension
  (`detect_format` on desktop, `detectSourceFormatByName` on Web), as today.
- **Header pass first:** before the first point, open every input once to read `has_color` and the declared
  point count (progress denominator = sum). Then stream the files in sorted path/name order (same order rule
  as the LAS merge, so the output does not depend on the selection order).
- **Color:** output `has_color = any(input.has_color)`. When the output has color, a point from an input
  without color gets `[32768, 32768, 32768]`. Do this in the merge code (per file), not inside each reader.
- **LAS/LAZ inside a point merge:** read as a point stream (x, y, z scaled to real coordinates, RGB if the
  point format has it, intensity). Add one warning to the conversion result's `warnings` (shown in the error
  log by `openFiles`), exactly this text:
  `LAS/LAZ と他の形式を結合したため、LAS/LAZ の分類・GPS時刻・リターン番号などの属性は出力に含まれません`
- **CRS in a point merge:** PLY/PCD/E57 carry no CRS. If the LAS/LAZ inputs have CRSs, they must all agree
  (same check as the LAS merge: inputs whose CRS is unknown count as agreeing); disagreement is an error
  before any point is written, naming the file (reuse the LAS merge's message style). The agreed CRS (or
  none) goes to the output. If there is a CRS and at least one non-LAS input, add this warning:
  `PLY/PCD/E57 の点は LAS/LAZ と同じ座標系として結合しました`
- **Cancel / progress / timings:** same as single-file import (cancel check every 4096 points, progress
  events of the existing shape, stage timings filled as today).
- **Cache:** the multi-file cache (desktop `cache::multi_fingerprint_of_paths` / sidecar, Web
  `opfs.findCachedMultiOutput`) must work for mixed sets. If it is format-agnostic already, leave it.
- **Output name:** same rule as the LAS merge (`multiDisplayNameFor` / `resolve_multi_output_path`).
- **Errors:** no new `unwrap` / `expect` / `panic!` outside tests (ADR-0015). No `std::time::Instant` in
  wasm crates (use `web_time`, as `point_file_import.rs` does).

## Track D: Desktop / Android (`crates/pcv-convert`, `src-tauri`)

Files you own: `crates/pcv-convert/**`, `src-tauri/src/**`. Do not touch `src/` or `crates/pcv-wasm`.

1. A LAS/LAZ `PointSource` in `crates/pcv-convert/src/import/` (read with the LAS reader the crate already
   uses; do not hold all points).
2. A multi-file point source (or a loop around the existing per-file sources) that does the header pass,
   the gray fill, and chains the files into `run_import`. Public entry point next to
   `convert_path_to_copc_and_timings`, e.g. `convert_paths_to_copc_and_timings(paths, ...)` returning the
   summary plus the warnings.
3. `src-tauri/src/conversion.rs` `start_multi_las_conversion`: route by format (all LAS → existing; else →
   new entry point). Keep the command name (the frontend calls it). Pass warnings back the same way the
   LAS merge passes its warnings.
4. Tests (Rust, synthetic data written by the test, no files from `/data`):
   - PLY + PCD merge: point count = sum, bounds cover both, output has no color when neither has color.
   - colored PLY + uncolored PCD: output has color; the PCD points are `[32768,32768,32768]`.
   - LAS + PLY: merges, the attribute warning is present.
   - two LAS with different CRS + one PLY: error before writing.
   - memory: the merge source holds no per-point buffer (a test like the existing bounded-memory tests in
     the crate, e.g. count allocations or assert no `Vec` grows with points — follow the existing pattern).
   - all-LAS input still takes the existing route (classification survives).
5. `cargo test -p pcv-convert`, `cargo clippy --workspace -- -D warnings` (or whatever CI runs; read
   `.github/workflows/`), `cargo build -p` for the tauri crate.

## Track W: Web (`crates/pcv-wasm`, `src/`)

Files you own: `crates/pcv-wasm/**`, `src/datasource/**`, `src/app/open-files.ts`, `e2e/` (only if needed).
Do not touch `crates/pcv-convert` or `src-tauri`.

1. Fold PCD into `PointStream` in `point_file_import.rs` (`PointStream::Pcd`), so one converter class reads
   all three formats. Keep `WasmPcdConverter` only if removing it makes this change larger; if it becomes
   unused, remove it and its Worker branch (R10: no dead code).
2. Add `PointStream::Las` (a LAS/LAZ point stream reading through `FileRangeReader`, like `convert.rs` does).
3. Multi-file support in `WasmPointFileConverter`: header pass over all files, gray fill, switch to the next
   file's stream when one ends (same idea as `WasmConverter::openNextFile`). Shape of the JS API is yours to
   choose; keep the Worker loop (`feed` / `finish`) the same for all routes.
4. `copc.worker.ts` and `web.ts`: route the multi request (all LAS → existing `convert-multi`; else → point
   merge). `checkInsufficientSpaceMulti` and the cache must work for mixed sets (today they may read LAS
   headers only — check).
5. `src/app/open-files.ts`: remove the LAS/LAZ-only refusal for several files. Rewrite the nearby comment.
   Desktop and Web both accept any mix after both tracks land; Track D does not touch this file, so do it here.
6. Tests: Rust tests in `crates/pcv-wasm/tests` or unit tests (same cases as Track D where they apply to the
   wasm code, using in-memory data), TS unit tests for the routing and for `open-files.test.ts`.
7. Run: `npm test` (vitest), `npm run typecheck`/lint as CI does, `cargo test -p pcv-wasm` (host tests),
   and the wasm build used by CI (read `.github/workflows/` and `package.json`).

## Docs (each track, in Japanese, `docs/book/`)

- Track D: `docs/book/src/rust/pcv-convert.md` and `docs/book/src/rust/tauri-backend.md` — the point merge.
- Track W: `docs/book/src/rust/pcv-wasm.md`, `docs/book/src/flows/open-file.md` ("複数ファイル" section),
  `docs/book/src/flows/conversion.md` if it describes the multi route.

## Acceptance

- [ ] Both tracks: rules above, tests listed, CI commands green locally.
- [ ] Both tracks: a "Result" section appended to this file (English): what was done, files touched, commands
      run with their output summary, what was not verified.
- [ ] Not verifiable by agents (owner): open 2+ real PLY/E57/PCD files, and LAS + PLY, on Web and desktop;
      check the merged layer looks right and the warnings appear in the error log.
