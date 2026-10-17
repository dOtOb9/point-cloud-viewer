# R7: PLY and E57 conversion on the Web, and trimming R5/R6

Owner decisions (2026-10-17):
- The Web build and the desktop build open the same formats. Do the Web PLY/E57 conversion now.
- R6 over-built the format list (`Platform`, `openableFormatsOn`, `NOT_YET_CONVERTIBLE_ON_WEB`). Once the Web
  converts PLY/E57 the list is the same everywhere, so cut it back to one constant.
- R5: keep only the helpers that earn their place.
- A point-cloud tool that succeeds after a failed open sets the status to "ready" and clears the old error text
  (the earlier error stays in the banner/log history).

## Part A: Web PLY / E57 conversion

### Approach (decided): copy, like PCD

`crates/pcv-wasm` cannot depend on `crates/pcv-convert` (see the long comment in `crates/pcv-wasm/Cargo.toml`:
workspace clash, and rayon would leak into wasm32). PCD was therefore written again in `pcv-wasm/src/pcd_import.rs`
as an intentional, commented duplicate. Do the same for PLY and E57:

- `crates/pcv-wasm/src/ply_import.rs` from `crates/pcv-convert/src/import/ply.rs` (own parser, depends on `byteorder` only).
- `crates/pcv-wasm/src/e57_import.rs` from `crates/pcv-convert/src/import/e57.rs`. Add `e57 = "=0.11.13"` (same version as
  pcv-convert) to `pcv-wasm/Cargo.toml` with a comment. The coordinator checked that `e57` 0.11.13 compiles for
  `wasm32-unknown-unknown` (a scratch crate calling `E57Reader::new` / `pointcloud_simple`; deps: roxmltree, memchr).
  It was not run in a browser.
- Header comment in each new file: what it is a copy of, why it is copied (point to the Cargo.toml comment), and that a
  fix in one must be made in the other.
- Do not create a shared crate and do not restructure workspaces (owner: avoid over-engineering).

### Shape: follow `WasmPcdConverter`

Read `pcd_import.rs` (`WasmPcdConverter`: `new` / `totalPoints` / `feed(batch)` / `finish`) and its caller in
`src/datasource/copc.worker.ts` (`handlePcdConvertStart` / `runPcdConversion`), `src/datasource/web.ts`
(`startPcdConversion`), `web-protocol.ts` (`buildPcdConvertStartRequest`) and `point-count-estimate.ts`.
Make PLY and E57 work the same way end to end: progress, cancel, the "not enough space" check, the conversion breakdown,
OPFS output, errors to the banner.

- **Prefer one generic path over three copies on the TS side.** If the worker/web.ts code for PCD can take the format as a
  parameter (e.g. `startPointFileConversion(file, format, isMobile)` and one `WasmPointFileConverter` or one worker handler
  that picks the Rust converter by format), do that and route PCD through it too — but only if it makes the code shorter
  and no harder to read. If it does not, add PLY/E57 next to PCD in the same style. Record which and why.
- **E57 and `feed(batch)`:** `e57::E57Reader::pointcloud_simple` returns an iterator that borrows the reader (see the comment
  on `PointSource` in `pcv-convert/src/import/point.rs`), so holding it across `feed` calls is a self-referential struct.
  Pick the simplest design that keeps progress and cancel working and memory bounded, for example: keep the `E57Reader` and
  the scan index plus "points already consumed in this scan" in the struct, and on each `feed` create the iterator again and
  skip what was consumed (check the cost: if skipping re-decodes from the start each time, that is O(n²) — not acceptable for
  large files); or run the whole E57 conversion in one wasm call that calls a JS progress callback and checks a cancel flag.
  Do not add a self-referential-struct crate. Record the choice and its cost.
- **Memory must not grow with the point count** (CLAUDE.md). Stream points; no `Vec` of all points. Add a test that the held
  state stays bounded where the PCD side has such a test (look for one; follow its pattern).
- Point-count estimate for the space check: add PLY/E57 estimates in `point-count-estimate.ts` only if the PCD one needs a
  counterpart; if the header gives the count cheaply, use it. Do not guess wildly; say what the estimate is based on.
- panic: no `unwrap`/`expect`/`panic!` in the new Rust code paths; no `std::time::Instant` (use `web_time`, as the crate does).
  Errors go back to JS as `JsValue` text and appear in the banner as is.

### Tests

- Rust: unit tests for `ply_import.rs` / `e57_import.rs` on the native target (`cargo test --manifest-path crates/pcv-wasm/Cargo.toml`),
  ported from pcv-convert's tests where they exist (pcv-convert writes small synthetic E57/PLY files in tests — reuse that approach).
- `cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown --release` passes, and
  `cargo tree` for that target shows no `rayon` (state the command you used).
- E2E: add one Playwright spec that converts a small **synthetic PLY** (written by the test, like the LAS specs do) on the Web
  and waits for `conversion-breakdown` and no `viewer-error`. If a synthetic E57 is practical (e.g. generated once by a small
  Rust test helper and written to a temp dir at test time), add E57 too; if not, say so. Do not commit point-cloud data files.

## Part B: cut the format list back

After Part A, in `src/datasource/source-format.ts`:

```ts
/** File name extensions every build can open (lower case, no dot). Web and desktop open the same formats. */
export const OPENABLE_EXTENSIONS = ["las", "laz", "e57", "ply", "pcd"] as const;
```

- Delete `OPENABLE_FORMATS`, `NOT_YET_CONVERTIBLE_ON_WEB`, `Platform`, `openableFormatsOn`, `fileExtensionsOf` and their tests.
  `detectSourceFormatByName` stays.
- The desktop dialog filter (`tauri.ts`), the Web `accept` (`file-picker.ts`) use `OPENABLE_EXTENSIONS`. Keep the desktop
  dialog's display name and extension order as they are today (las, laz, e57, ply, pcd).
- `useFileOpen.ts`: remove the "Web版ではまだ変換できません" branch; PLY/E57 go to the new conversion route.
- `file-picker.ts` stays as it is otherwise (owner: do not revert the picker).

## Part C: trim the R5 helpers

In `src/state/viewer-status.ts` keep `isFileOpenBusy` (used in two places) and `openButtonLabel`. Inline
`statusErrorMessage` and `isOpenRunningOrDone` at their single call sites (`status.kind === "error" ? status.message : null`,
and the AppShell condition written plainly with `status.kind`), and delete them and their tests. Keep the file header's
"why a string tag, not enum" comment.

## Part D: tool success clears the error

`src/state/usePointCloudTools.ts` (around line 102): `setStatus((prev) => (prev.kind === "error" ? prev : { kind: "ready" }))`
→ `setStatus({ kind: "ready" })`. Update the comment: the old open error stays in the banner and the error log history
(`useErrorLog`), so nothing is lost. Check that the open error was actually reported to the error log (if the panel text was the
only place, report it there too, or say so).

## Acceptance criteria

1. Web: PLY and E57 convert to COPC and open, with progress, cancel and the breakdown, same as PCD (E2E for PLY at least).
2. `grep -rn "NOT_YET_CONVERTIBLE_ON_WEB\|openableFormatsOn\|Platform\b" src` is empty (except unrelated `Platform` names, if any; list them).
3. `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, `cargo test --manifest-path crates/pcv-wasm/Cargo.toml`,
   the wasm32 release build, `cargo clippy` as CI runs it for pcv-wasm (check `.github/workflows`), and all Playwright E2E specs
   pass. Long commands with run_in_background; E2E with a free `PCV_E2E_PORT`, stop only your processes (ADR-0016).
   If the Web build needs the wasm package rebuilt for E2E (`npm run build:wasm` or similar), find and use the project's script.
4. English comments in touched code; Japanese mdBook updates (`flows/open-file.md`, the conversion pages, anything saying the
   Web cannot convert PLY/E57); update `TaskSheets/M4-import-and-conversion.md` with a short English note that the Web now
   converts PLY/E57 (R7).
5. Commits, one concern each, e.g. `✨ feat: Web 版で PLY を COPC に変換できるようにする`, `✨ feat: Web 版で E57 を ...`,
   `♻️ refactor: 開ける形式を1つの定数にする`, `♻️ refactor: 使う場所が1か所の status の判定関数をやめる`,
   `🐛 fix: ツールが成功したら前の開くエラーを消す`, `✅ test: ...`, `📝 docs(book): ...`, `📝 docs: ...`.
   Each ends with the Co-Authored-By line.

## Owner checks (agent cannot see the screen)

- Web: open a real PLY and a real E57 (none are in `data/` today) → progress, finish, the cloud looks right, colours if the file has them.
- Web: cancel during a PLY/E57 conversion → nothing left behind, no error.
- Open fails (e.g. LAS+PCD together) → run 点の選択 on an open layer → the error text in the panel disappears; the banner/log still has it.

## Record (filled in by the implementer)

- Files touched:
  - Rust (`crates/pcv-wasm`): new `src/ply_import.rs`, `src/e57_import.rs`, `src/point_file_import.rs`; `src/lib.rs` (mods and export),
    `src/pcd_import.rs` (`choose_scale_offset` made `pub(crate)` so it is not copied a third time), `Cargo.toml` (`e57 = "=0.11.13"`), `Cargo.lock`.
  - Generated wasm package `src/wasm/pcv-wasm/*` (rebuilt with `npm run build:wasm`; it is committed in this repo).
  - TS: `src/datasource/{web-protocol,web,copc.worker,point-count-estimate,source-format,tauri,file-picker}.ts` and their tests,
    `src/state/{useFileOpen,usePointCloudTools,viewer-status}.ts` (+ test), `src/ui/shell/AppShell.tsx`, `src/ui/layers/LayerInfoSection.tsx`.
  - E2E: new `e2e/web-point-file-conversion.spec.ts`. Docs: mdBook `flows/open-file.md`, `flows/conversion.md`, `rust/pcv-convert.md`, `rust/pcv-wasm.md`;
    `TaskSheets/M4-import-and-conversion.md` (short R7 note).
- TS side: generic path or side by side, and why:
  One generic path. `pcdConvertStart` became `pointFileConvertStart { format: "pcd" | "ply" | "e57" }`, `startPcdConversion` became
  `startPointFileConversion(file, format, isMobile)`, and the Worker has one `runPointFileConversion(id, file, format, maxPointsPerNode)`.
  The only format-specific line in the Worker is the constructor choice (`format === "pcd" ? new WasmPcdConverter(...) : new WasmPointFileConverter(format, ...)`);
  both classes have `totalPoints / feed / finish`. The space check picks the point-count estimator from a 3-entry table (`POINT_COUNT_ESTIMATORS` in `web.ts`).
  This is shorter than three copies and nothing got harder to read. On the Rust side PCD keeps `WasmPcdConverter` untouched (not refactored on purpose);
  PLY and E57 share one `WasmPointFileConverter` whose format-specific part is only `next_point()` (a two-arm enum), so the spill/finish code exists
  twice (PCD, PLY/E57), not three times.
- E57 feed design and its cost:
  `E57Stream` keeps the `E57Reader` as a raw pointer (`Box::into_raw`) and the `PointCloudReaderSimple` that borrows it (`'static` by pointer deref) in the same struct,
  across `feed` calls; `Drop` clears the iterator first and then frees the reader. Two `unsafe` blocks (`open_scan`, `Drop`), with SAFETY comments.
  Cost: every point is decoded once, so O(n) in total; memory is the reader, the XML metadata and the e57 crate's per-packet queue for the current scan, not a function of the point count.
  Rejected: (1) re-create the iterator per `feed` and skip consumed points. The iterator has no seek, and skipping decodes from the start of the scan again, so O(n^2).
  (2) one wasm call for the whole conversion: the Worker handles the cancel message only between calls, so cancel would not work.
  (3) `Box::leak` (safe, but leaks the 4 MB buffer and the `File` handle per conversion in a long-lived Worker). A self-referential-struct crate was not used, as asked.
  Tests: `long_lived_iterator_keeps_position_and_drops_cleanly` (20,000 points read in batches of 777, each exactly once in order; a stream dropped half way),
  plus the two-scan pose test ported from pcv-convert. PLY: `streaming_does_not_buffer_the_body` (50,000 points from a generated reader through a 64 byte `BufReader`).
  The unsafe code is exercised natively and in the browser E2E, but not under Miri (not run).
- Point-count estimate basis:
  PLY: `element vertex N` in the header (the function already existed as `estimatePointCountForPlyFile`; it was unused). PCD: unchanged (`POINTS`).
  E57: new `estimatePointCountForE57File`: reads the 48-byte header (XML offset/length, page size), reads the XML pages, removes the 4-byte CRC of each page, and sums
  `recordCount` of `<points>`. If anything does not parse it returns `null` and the check falls back to the file-size estimate (as for the other formats).
  Checked by unit tests on a hand-made paged buffer (XML crossing page boundaries). Not checked against a file written by the `e57` crate (see Not verified).
- Commands run and output (all in the worktree):
  - `cargo test --manifest-path crates/pcv-wasm/Cargo.toml`: lib `49 passed; 0 failed; 1 ignored` (the ignored one writes the E2E E57 fixture); the 5 integration test files pass (1+1+1+1+2).
  - `cargo clippy --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown --all-targets -- -D warnings`: clean for pcv-wasm
    (it first failed with `clippy::large_enum_variant` on `PointStream`; fixed by boxing the E57 variant).
  - `cargo fmt --manifest-path crates/pcv-wasm/Cargo.toml -- --check`: OK.
  - `cargo build --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown --release`: OK; `npm run build:wasm`: OK.
  - `cargo tree --manifest-path crates/pcv-wasm/Cargo.toml --target wasm32-unknown-unknown | grep -c rayon`: `0`.
  - `npx tsc --noEmit`: no output. `npm run lint`: no warnings. `npx vitest run`: 63 files, 561 tests passed.
  - `PCV_E2E_PORT=4391 npx playwright test`: 4 passed (LAS, LAS multi, PLY, E57), about 10 s.
  - `grep -rn "NOT_YET_CONVERTIBLE_ON_WEB\|openableFormatsOn\|Platform\b" src`: empty.
- Part D check: before R7, only the space-check texts and conversion failures went to the error log. A failure caught in `openFile` / `openFiles`
  (and the OPFS-unavailable and "LAS/LAZ only" messages) was only in the panel text. R7 adds `failOpen` in `useFileOpen.ts` (log + panel) for those, so
  clearing the panel text on tool success loses nothing.
- Not verified:
  - Real PLY / E57 files from real scanners (none in `data/`): colours, big files, memory at hundreds of millions of points, E57 with grid (structured) scans.
  - Cancel during a PLY/E57 conversion and the "not enough space" path in a real browser (same code as PCD, but the E2E does not exercise them for PLY/E57).
  - The E57 point-count estimate against a real `e57`-crate file (the E2E passes but does not show the estimate).
  - E57 speed in the browser: `BufReader` drops its buffer on a seek; if the `e57` crate seeks often the 4 MB buffer helps less than for PLY. Not measured.
  - The E57 E2E needs `cargo`; in CI's frontend job (no Rust) it is skipped by `test.skip`.
  - The `failOpen` path and the Part D behaviour have no UI test (code reading only).
