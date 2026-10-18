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
