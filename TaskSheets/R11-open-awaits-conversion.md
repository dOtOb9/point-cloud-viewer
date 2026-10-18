# R11: Opening a file awaits its conversion — one `await`, no "done" event round trip

Owner discussion (2026-10-18). Reading `src/state/useFileOpen.ts`, the owner asked: "Does React need `prepare` at all? Isn't
it enough for open to do the work on the Rust side and for React to handle the error?" R9 kept the two-step open ("conversion
starts → later a done event calls `openFile(output, true)` again") out of scope. This task removes it.

## The problem (observed, concrete)

1. **Opening is split across two hooks and joined by refs.** `useFileOpen.openItems` returns early on `converting`. Later,
   `useConversionSession`'s effect receives the done event (Tauri event, or `WebSource.onConvertDone`), stores a "pending result"
   in a ref, and calls `openFileRef.current(path, true)`. To make this work there are `openFileRef`, `isConversionContinuation`,
   `pendingConversionRef` / `takePendingConversion`, and `convertingSourceNameRef`.
2. **`useConversionSession` branches on `instanceof WebSource`** for events and for cancel.
3. **Conversion warnings are dropped.** Both done events carry `warnings: string[]` (`tauri.ts` `onConversionDone`,
   `WebSource.onConvertDone`), but the handlers in `useConversionSession.ts` ignore the argument. CLAUDE.md: errors are not
   silently discarded.

The point-cloud tools already use the shape we want: one `await` with a progress callback
(`tauri.ts` `withToolProgress`, `WebSource.runTool`).

## Decision

`DataSource.prepareToOpen` resolves only when the item(s) can be opened (or definitely cannot). A conversion, if needed,
happens inside the call. Progress comes through callbacks passed in.

```ts
// src/datasource/DataSource.ts (shape; names may be adjusted if you say why in the Record)
export interface PrepareOptions {
  tempDir: string | null;
  isMobile: boolean;
  /** Called once when a conversion really starts (not for an already-COPC file or a cached result). */
  onConverting?: () => void;
  onProgress?: (progress: ConversionProgress) => void;
}

/** What a finished conversion reports. `null` in `ready` when nothing was converted (already COPC, or cached). */
export interface ConversionResult {
  /** Name for the layer list (the converted `.copc.laz`). */
  outputName: string;
  /** Inputs of `formatConversionBreakdown` that only the source knows. */
  platform: "web" | "desktop";
  sourceFormat: string;
  stageTimings: ConversionStageBreakdown;
  /** Backend warnings (e.g. a file without a CRS). Empty if none. */
  warnings: string[];
  /** Web only: the converted file for the download link. Desktop: null. */
  download: { url: string; fileName: string } | null;
}

export type PrepareOutcome =
  | { kind: "ready"; path: string; conversion: ConversionResult | null }
  | { kind: "failed"; summary: string; details: string }
  | { kind: "cancelled" };

interface DataSource {
  prepareToOpen(items: string[] | File[], options: PrepareOptions): Promise<PrepareOutcome>;
  /** Cancels the running conversion. Does nothing if none is running (no throw). */
  cancelConversion(): void;
  // open / readNode / close unchanged
}
```

### Sources

- **Tauri** (`src/datasource/tauri.ts`): subscribe to `conversion-progress` / `conversion-done` / `conversion-failed`
  **before** invoking `start_las_conversion` / `start_multi_las_conversion` (so a fast done event cannot be missed), wait for
  done/failed when the outcome is `converting`, and always unlisten (`finally`). `ready.path` is the `output_path` of the done
  event (no second `start_las_conversion` call any more; record this small behaviour change).
  `cancelConversion()` calls `cancel_las_conversion` and logs a failure with `console.error` as today (it may be too late).
  Check in `src-tauri/src/conversion.rs` what happens if a second conversion is started while one runs, and write it in the Record.
- **Web** (`src/datasource/web.ts`): wait for `convert-done` / `convert-failed` per request id (like `toolPending` / `runTool`),
  then `opfs.getConvertedFile(outputName)` → `registerFile` → `ready` with the key. The download object URL is created here
  (moved from `useConversionSession`). `sourceFormat`: same rule as today (`extensionOfFileName(name)` for one file,
  `"las/laz(複数ファイル)"` when `stageTimings.inputFileCount > 1`). If the OPFS read-back fails → `failed` with the current text
  "変換結果をOPFSから読み出せませんでした". Remove the `convert*Listeners` sets and `onConvert*` methods if nothing uses them any
  more (grep `src/` and `e2e/`). Remove the "one string item = OPFS key continuation" case if nothing uses it any more.
- Rust code does not change.

### State

- `useFileOpen.openItems`: one `try { await source.prepareToOpen(...) }`. `onConverting` → `setStatus({kind: "converting"})`.
  `onProgress` → the conversion progress state. On `ready` with a `conversion`: build the breakdown text with
  `formatConversionBreakdown` (same inputs as today, including `currentDeviceMeta()` and the display name remembered by
  `rememberConvertingSource`), send each warning to `reportError(warning, "conversion")`, then `addOpenedLayer`.
- `addOpenedLayer(path, name, conversion)` — the third argument becomes the data to attach (`{ breakdownText, download } | null`)
  instead of the `isConversionContinuation` flag. `usePointCloudTools` passes `null`.
- **Same user-visible texts as today**: conversion failure → status `{kind: "error", message}` and
  `reportError("変換に失敗しました: " + message, "conversion")`; cancel → status `idle` and
  `reportError("変換をキャンセルしました", "conversion")`; progress cleared in both cases. Map these from the source's failure /
  cancel to `PrepareOutcome` so `useFileOpen` has one place that shows failures.
- If opening fails after a Web conversion produced a download URL, `URL.revokeObjectURL` it (today `setPendingConversion` does
  this for a result that was never opened).
- `useConversionSession` keeps only: `conversionProgress` (+ setter/clear), `convertingFileName` / `rememberConvertingSource`,
  `cancelConversion` (now `sourceRef.current?.cancelConversion()`, no `instanceof`), `copyConversionBreakdownText`.
  No event subscription, no `openFileRef`, no pending result. If what is left is so small that merging it into `useFileOpen`
  reads better, you may do that — say which and why in the Record.
- Keep the desktop guard that tool progress (same `conversion-progress` event) does not show in the conversion UI
  (`toolRunningRef`) unless the per-call subscription makes it impossible to reach; explain which in the Record.
- `useCopcViewer.ts` / `viewer-types.ts`: remove what disappeared; `CopcViewerState` fields seen by the UI stay the same.

### Out of scope

- Rust, the Worker (`copc.worker.ts`), the UI components (except removing dead props, if any).
- `usePointCloudTools`'s own `instanceof WebSource` (separate task).

## Acceptance criteria (each must be checked and the command output written in the Record)

1. `grep -rn "openFileRef\|isConversionContinuation\|takePendingConversion\|pendingConversionRef" src/` → no hits.
2. `grep -n "instanceof" src/state/useConversionSession.ts src/state/useFileOpen.ts` → no hits.
3. Warnings from the done result reach `reportError(..., "conversion")` on both builds; a unit test covers at least the Web path
   (fake worker, like `web.test.ts` / `web-prepare.test.ts`).
4. Breakdown text is the same as before for the same inputs (unit test of the function that builds it, or an existing test still passing).
5. `npm run typecheck`, `npm run lint`, `npm test` pass. Paste the summary lines.
6. `npm run e2e` (web conversion in a real headless browser, ADR-0016) passes. Start the preview server with a free
   `PCV_E2E_PORT` and stop only the process you started (check its command line). If it cannot run, say exactly why — do not
   claim it passed.
7. CLAUDE.md invariant 2: no `@tauri-apps/` string anywhere in `src/` outside `src/datasource/tauri.ts` (comments included).
8. Report: line counts of `src/state/useFileOpen.ts` + `src/state/useConversionSession.ts` before (497 total at 2474477) and after.

## Docs

- `docs/book/src/flows/open-file.md`, `flows/conversion.md`, `flows/errors.md`, `frontend/datasource.md`, `frontend/state.md`:
  describe the new flow (Japanese). Entry points as file + function.
- Comments in touched code: English. Japanese comments in functions you touch: translate them while there.

## Record (append to this file, English)

What you did, why, alternatives you rejected, files touched, behaviour changes (second `start_las_conversion` gone on desktop,
OPFS read-back failure now also logged, concurrency behaviour), what you could NOT verify (desktop Tauri build on a real
machine, Android), and the owner's manual check steps (desktop: open a raw LAS → progress → layer with breakdown; cancel;
a file that fails; Web: same, plus the download link).


---

# Record (2026-10-18)

## What was done

Commits (oldest first): task sheet; `prepareToOpen` awaits the conversion (refactor); conversion warnings reach the error log
(fix); `currentDeviceMeta` moved to `src/state/device-meta.ts` (refactor); book pages (docs). This record is the last commit.

- `DataSource.prepareToOpen(items, options)` now resolves only when the item(s) can be opened or definitely cannot. `options`
  is `PrepareOptions` (`tempDir`, `isMobile`, `onConverting`, `onProgress`). `PrepareOutcome` is
  `ready { path, conversion: ConversionResult | null } | failed { summary, details } | cancelled`. `DataSource.cancelConversion()`
  is new. Names and shapes are exactly the ones in the sheet.
- Tauri (`src/datasource/tauri.ts`): `watchConversionEnd` subscribes to `conversion-progress` / `-done` / `-failed` before the
  command is invoked and returns a promise of the first end event; `prepareToOpen` unlistens in `finally`. `ready.path` is the
  `output_path` of the done event.
- Web (`src/datasource/web.ts`): `beginConversion(id, request, onProgress)` registers a waiter in `convertPending` (by request id)
  BEFORE posting; `handleResponse` routes `convert-progress` / `-done` / `-failed` to it. After done, `prepareToOpen` reads the
  output back (`opfs.getConvertedFile`), registers it, and makes the download object URL. The `start*` methods now take an
  `onProgress` and return `WebStart` (an outcome, or `{kind: "converting", end}`). The `convert*Listeners` sets and the
  `onConvertProgress/Done/Failed` methods are removed (nothing in `src/` or `e2e/` used them any more). The "one string item = OPFS
  key" case is removed (only the old continuation used it); a string item now throws.
- `src/datasource/prepare-outcome.ts`: `toPrepareOutcome` no longer handles `converting` (its type excludes it);
  `toConversionFailureOutcome(message, cancelled)` is new and is the one place that maps a failed/cancelled conversion to a
  `PrepareOutcome` (both builds use it). Failure: `summary` = bare message (status line), `details` = "変換に失敗しました: " + message
  (error log). That keeps today's two texts while `useFileOpen` has one place (`failOpen`) that shows failures.
- `src/state/useFileOpen.ts`: one `await source.prepareToOpen(...)`. `onConverting` sets status `converting`; `onProgress` is
  `conversion.reportConversionProgress`. `ready` with a `conversion` builds the breakdown text with `formatConversionBreakdown`
  (same inputs as before: `platform`, `sourceFormat`, the remembered display name as `fileName`, `currentDeviceMeta()`), then
  `addOpenedLayer(path, name, { breakdownText, download } | null)`. `openFile` and the `isConversionContinuation` flag are gone
  (nothing else called `openFile`). If `addOpenedLayer` throws after a Web conversion made a download URL, the URL is revoked.
- `src/state/useConversionSession.ts` (263 -> 92 lines) keeps: `conversionProgress`, `reportConversionProgress`,
  `clearConversionProgress`, `convertingFileName` / `rememberConvertingSource`, `cancelConversion`
  (`sourceRef.current?.cancelConversion()`), `copyConversionBreakdownText`. It did NOT get merged into `useFileOpen`: it still owns
  state that the UI reads independently of the open call (progress, file name shown after the status left `converting`, the copy
  button for the selected layer), and `useFileOpen` is already the biggest hook.
- `toolRunningRef` guard: kept. It could not be dropped: the desktop tools emit the same `conversion-progress` event, and the
  per-call subscription in `TauriSource.prepareToOpen` cannot know a tool is running. The check moved into
  `reportConversionProgress` (`if (!toolRunningRef.current) setConversionProgress(progress)`).
- `basenameOfPath` / `extensionOfFileName` moved from `src/state/open-file-text.ts` to `src/datasource/file-name.ts` (with the test),
  because the sources (in `datasource/`) now need them and `datasource/` must not import `state/`. `open-file-text.ts` is deleted.
- `currentDeviceMeta` moved to `src/state/device-meta.ts` (hooks do not import each other; deps come in as arguments).
- `usePointCloudTools` passes `null` as the third argument of `addOpenedLayer` (its `instanceof WebSource` is untouched, as
  scoped). `useCopcViewer.ts` no longer passes `setStatus` / `reportError` to `useConversionSession`; the call-order comment (an effect
  that read `sourceRef`) was removed because that effect no longer exists. `CopcViewerState` fields seen by the UI are unchanged.
- Warnings (separate commit): `ConversionResult.warnings` goes to `reportError(warning, "conversion")` before the layer is added.
  Both builds fill `warnings` from the done event (Tauri: `onConversionDone`'s 4th argument; Web: `convert-done.warnings`).
  The commit is separate from the refactor because it is one added line plus its text; the `warnings` field itself had to exist in
  the new `ConversionResult` type, so it is in the refactor commit.

## Alternatives rejected

- Keep two steps but put the pending result in the DataSource: still a done event that re-enters open; the same problem moved.
- Have `ConversionOutcome` (the DTO of the Rust command) carry the end promise: it is shared with the Tauri DTO tests and with
  `toPrepareOutcome`; a separate `WebStart` type local to `web.ts` and an `Exclude<..., converting>` on `toPrepareOutcome` is smaller.
- A unit test for `TauriSource.prepareToOpen` by mocking the Tauri packages: the mock would need the package name in a string
  under `src/`, and CLAUDE.md invariant 2 (and the CI grep for `@tauri-apps/api`) forbids that outside `tauri.ts`. So the desktop
  path has no unit test (see "not verified").
- Passing `onProgress` straight to the Tauri event: kept the `toolRunningRef` check in `reportConversionProgress` instead (above).

## Files touched

`src/datasource/`: `DataSource.ts`, `tauri.ts`, `web.ts`, `prepare-outcome.ts` (+test), `file-name.ts` (+test, moved),
`web-prepare.test.ts`. `src/state/`: `useFileOpen.ts`, `useConversionSession.ts`, `useCopcViewer.ts`, `usePointCloudTools.ts`,
`viewer-types.ts` (comment), `useFileDrop.ts` (comment), `device-meta.ts` (new). `src/ui/dialogs/ConversionDialog.tsx` (comment only).
`docs/book/src/flows/{open-file,conversion,errors}.md`, `docs/book/src/frontend/{datasource,state}.md`.
Rust, the Worker, UI components: untouched.

## Behaviour changes

- Desktop: no second `start_las_conversion` call after a conversion (the done event's `output_path` is opened directly). Before, the
  output went through `start_las_conversion` again and was judged "already COPC" after a header read.
- Conversion warnings are now in the error log on both builds (they were dropped).
- Web: "変換結果をOPFSから読み出せませんでした" is now also written to the error log (before: status line only).
- Web: the download object URL is revoked if the layer cannot be opened (before: only a result that was never opened was revoked).
- Concurrency. `src-tauri/src/conversion.rs`: a second `start_las_conversion` while one runs is NOT rejected; it replaces the cancel flag in
  `ConversionState` (`*state.0.lock() = Some(cancel_flag)`), so the first conversion can no longer be cancelled. The events carry no
  conversion id, so with two running desktop conversions the first done/failed event settles every waiting `prepareToOpen`. Before this
  change it was equally unguarded (the global listeners opened whatever "done" came first). The open button is disabled while
  `isFileOpenBusy` (status `opening` / `converting`), so the UI does not normally start two; drag and drop is not guarded (unchanged, not
  verified by me). Web: waiters are by request id, so results do not mix, but `cancelConversion` only reaches the latest job
  (`activeConvertId`, unchanged).
- Status: the progress is cleared when `prepareToOpen` returns (any outcome) and in the `catch`. Texts for failure and cancel are
  unchanged (`変換に失敗しました: ...`, `変換をキャンセルしました`).

## Acceptance criteria (commands run in the worktree, 2026-10-18)

1. `grep -rn "openFileRef\|isConversionContinuation\|takePendingConversion\|pendingConversionRef" src/` -> no output (exit 1). PASS.
2. `grep -n "instanceof" src/state/useConversionSession.ts src/state/useFileOpen.ts` -> no output. PASS.
3. Warnings: `reportError(warning, "conversion")` in `useFileOpen.ts` for both builds; unit test on the Web path:
   `web-prepare.test.ts` "the warnings of the done message come back in the conversion result" (fake worker, `convert-done` with
   `warnings`). The `reportError` call itself in the hook has no unit test (no React testing library in the repo); the desktop
   source has no test (see above). PARTIAL as asked ("at least the Web path"): the source-to-result step is tested, the hook line is not.
4. Breakdown text: `formatConversionBreakdown` is unchanged and `src/datasource/conversion-breakdown.test.ts` still passes; the call
   site inputs are the same as before (see "What was done"). PASS (by unchanged function + existing tests; I did not add a test for the
   call site in the hook).
5. `npx tsc --noEmit` (= `npm run typecheck`): no output. `npx eslint .` (= `npm run lint`): no output. `npx vitest run` (= `npm test`):
   `Test Files  65 passed (65)`, `Tests  582 passed (582)`. PASS.
6. `PCV_E2E_PORT=4593 npm run e2e`: `4 passed (9.9s)` (web-conversion, web-multi-conversion, web-point-file-conversion PLY and E57).
   Playwright started and stopped its own preview server; afterwards nothing listens on port 4593. An earlier run on the commit before
   `device-meta.ts` also passed (`4 passed (28.0s)`). PASS.
7. `grep -rl "@tauri-apps/api" src/` (the CI invariant) -> `src/datasource/tauri.ts` only. No added line in `git diff origin/main -- src`
   contains `@tauri-apps`. (Other files already mention `@tauri-apps/plugin-opener`: `update-check.ts`, `useUpdateCheck.ts`; not touched
   and not matched by the CI grep.) PASS.
8. `wc -l src/state/useFileOpen.ts src/state/useConversionSession.ts`: before 497 total (at 2474477: 234 + 263); after 347 total
   (255 + 92). `useFileOpen.ts` grew by 21 lines (it now builds the breakdown, reports warnings, revokes the URL); the event
   code, the pending result and the refs are gone from `useConversionSession.ts`.

## Not verified

- The desktop Tauri build on a real machine (events before invoke, done event path, cancel, a failing file), and Android. Only
  typecheck, lint and the unit tests ran for `tauri.ts`; there is no unit test for `TauriSource.prepareToOpen`.
- Cancel in a real browser (the unit test uses a fake Worker; the E2E does not cancel).
- Drag and drop starting a second conversion while one runs.
- CI / Pages run ids: nothing was pushed.

## Owner's manual check

Desktop (`npm run tauri dev`):
1. Open a raw `.las`/`.laz`: the conversion dialog shows progress; when done, a layer appears with a "変換の内訳" panel.
2. Open a COPC: it opens at once, no dialog.
3. Start a conversion and press cancel: status goes idle, the banner shows "変換をキャンセルしました", no layer.
4. Open a file that fails (a broken LAS): status shows the message, the banner shows "変換に失敗しました: ...".
5. Open LAS files without a CRS together with one that has a CRS (merge): the error log shows the warning text.
6. Open the same raw file again: the cached result opens at once (no breakdown, as before).

Web (GitHub Pages build or `npm run dev`): the same 1-4, plus: after a conversion the "download" link in the layer info downloads the
`.copc.laz`; open a second file and check the first layer keeps its own breakdown and link (nothing leaks to the new layer).

## AI legibility benchmark (coordinator, 2026-10-18)

The owner asked how much this refactor is worth to an AI working on the code. Method: a fresh Sonnet subagent with no
context answers the same three questions (scratchpad `bench-prompt.md`, read-only): Q1 trace the desktop open of one raw LAS
to the new layer, Q2 locate where the Web breakdown text / download link are built and attached and what a failure shows,
Q3 plan "show the done-time warnings in the error log". Two runs on `2474477` (before) and two on `0be457d` (after), each in
a detached worktree frozen at that commit. Tokens / tool uses / time are the harness's numbers for each subagent.

| run | tokens | tool uses | time | Q1 | Q2 | Q3 |
|---|---|---|---|---|---|---|
| before 1 | 99,453 | 14 | 78 s | correct | correct | correct |
| before 2 | 104,422 | 17 | 92 s | correct | correct | correct |
| after 1 | 104,356 | 14 | 95 s | correct | correct | found it already done |
| after 2 | 110,584 | 17 | 100 s | correct | correct | found it already done |

Reading of the numbers:

- **Cost did not go down.** Tokens and tool uses are the same within run-to-run noise (2 runs each; not enough to see a small
  difference). Q3 is not comparable: after the fix the answer is "already done", and both after-runs spent the effort
  explaining why single-file conversions send no warnings (Rust/wasm), which inflates the after numbers somewhat.
- **Correctness was already full before.** Sonnet traced the old event round trip correctly both times. Both before-runs cited
  `useConversionSession.ts` line numbers off by +234 (they printed two files with one `cat -n`); the after-runs' line
  numbers were right. This is a reading-method artefact, not counted.
- **What changed is where the difficulty sits.** Before, both runs named the cross-hook hand-off as the hardest part
  (`openFileRef` re-entry, the pending-result ref, desktop and Web interleaved in one effect). After, both named the
  datasource internals (Tauri events subscribed before the command; the Web request-id waiter map), i.e. platform plumbing
  behind one `await`, which is where it belongs.
- Side finding by all four runs: single-file conversions never produce warnings (desktop `run_conversion_thread` sends
  `Vec::new()`, wasm gates on `input_file_count > 1`, by design). The warnings fix therefore only shows for merges.

Conclusion: for an AI reader, the measurable value is small: no saving in tokens, no gain in correctness at this size.
The value of this refactor is for the human reader (one `await` instead of an event round trip across two hooks;
-150 lines in the two hooks, 55 → 23 occurrences of the hook-wiring names) and in the two behaviour fixes found while doing it
(dropped warnings; the second `start_las_conversion` call).
