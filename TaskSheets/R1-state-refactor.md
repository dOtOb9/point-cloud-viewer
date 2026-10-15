# R1: split `src/state/useCopcViewer.ts` by concern

Refactoring only. No behavior change. `useCopcViewer()` still returns `[canvasRef, CopcViewerState]`, and every
field of `CopcViewerState` keeps its name and meaning. R2 (UI componentization) worked in parallel on `src/ui` and
needed nothing from this change.

## What was done

`useCopcViewer.ts` was 1513 lines (one hook, ~40 `useState`/`useRef`, one 250-line mount effect, two 200-line
open functions). It is now 195 lines and only assembles. Each concern is one file.

| File | Role | Entry |
|---|---|---|
| `useCopcViewer.ts` | Assembles the hooks below into `CopcViewerState`. Owns `status` / `error` (almost every hook writes them), `rendererRef`, `sourceRef`, `toolRunningRef`, `pickPoint`, `getViewSnapshot`. Re-exports the types the UI uses. | `useCopcViewer()` |
| `viewer-types.ts` | `CopcViewerState` and its small types (`ViewerStatus`, `ToolProgressState`, `OpfsStorageInfo`). Types only. | (types) |
| `useRendererLifecycle.ts` | Creates the `PointCloudRenderer` and the `TauriSource`/`WebSource`, wires stats / GPU error / node-read error callbacks, resize, dispose. | `useRendererLifecycle(refs, callbacks)` |
| `useErrorLog.ts` | `gpuErrors`, `errorHistory`, `reportError`, `dismissGpuError` (wraps `GpuErrorLog`). | `useErrorLog()` |
| `useDisplaySettings.ts` | Point budget, auto budget, background, grid, EDL, animation, render scale, point shape, center priority, `stats`, device defaults. | `useDisplaySettings(rendererRef)` |
| `useLayers.ts` | Layer list + selection (uses `layers.ts`, `layer-selection.ts`), per-layer actions, focus, reset view, remove, measurement layers. | `useLayers(deps)` |
| `useFileOpen.ts` | `openFile`, `openFiles`, `addOpenedLayer`. | `useFileOpen(deps)` |
| `useConversionSession.ts` | Conversion progress, source name, done/failed events (Tauri events / `WebSource` listeners), pending result, cancel, breakdown copy. | `useConversionSession(deps)` |
| `usePointCloudTools.ts` | Extract / cross section / merge as new layers (ADR-0018), tool progress, cancel. | `usePointCloudTools(deps)` |
| `useOpfsStorage.ts` | Web storage usage and cleanup for the settings page. | `useOpfsStorage()` |
| `useTempDir.ts` | Desktop temp folder setting (localStorage) and `supportsCustomTempDir`. | `useTempDir()` |
| `error-history.ts` (+test) | Pure: merge the current error list into the history. | `mergeErrorHistory` |
| `open-file-text.ts` (+test) | Pure: `basenameOfPath`, `extensionOfFileName`, desktop "not enough space" text. | (functions) |
| `stats-summary.ts` (+test) | Pure: the one-line stats text sent to the backend console. | `formatStatsSummary` |

Relation to the existing hooks: `useLayerTool.ts`, `useMeasureTool.ts` and `useDisplayUnit.ts` are not part of
`CopcViewerState`. They take `CopcViewerState` as input (mouse tools on the 3D view call `extractFromLayer` /
`addMeasurement`; the unit setting is independent). They were not changed. `usePointCloudTools.ts` is the
"run a tool" side; `useLayerTool.ts` is the "draw on the screen" side; the header comment of each says so.

Commits: `3a319a0` (pure functions and tests), `8f51b25` (the hook split).

## Why this way

- **One file per concern, no framework.** The owner wants to follow the code. Each hook takes plain arguments
  (refs, setters, a few values) and returns plain values. No context, no reducer, no hook-factory.
- **Hooks take their dependencies as arguments instead of importing each other.** `useFileOpen` gets
  `conversion`, `display`, the layer refs; you can read its header and see exactly what it needs.
- **`rendererRef` / `sourceRef` are created in `useCopcViewer`, not in the lifecycle hook.** `useDisplaySettings`
  needs `rendererRef` and the lifecycle hook needs `display.onStats`; creating the refs in the assembler breaks
  that cycle without any trick.
- **The mount effect was split in two.** The old effect created the renderer and also subscribed to conversion
  events. Now `useRendererLifecycle` creates the source, and the effect in `useConversionSession` reads
  `sourceRef.current`. This relies on effects running in call order within one component; the call order in
  `useCopcViewer` has a comment for it.
- **`openFileRef` lives in `useConversionSession`** and `useFileOpen` assigns it after each render. The events are
  subscribed once but must call the latest `openFile` (it closes over `tempDir`). Same pattern as before, but the
  two sides are now in two files; the headers explain the handshake.
- **`reportError(message, source)` replaces the three-line "report, copy the list, record the history" that was
  repeated about ten times.** This is the one place where a small abstraction was added; the reason is that the repeated
  lines had to stay in sync (forgetting the history line would silently lose an error from the log dialog).
- **`status` / `error` stay in the assembler** and are passed as setters. Moving them into a hook would only
  move the same parameters around.

Not taken:
- A `useReducer` / one big store for the viewer: bigger change in behavior and harder to read than the current
  `useState` per field.
- Moving `pickPoint` / `getViewSnapshot` into their own file: two small renderer pass-throughs, 15 lines.
- Splitting `openFile` further by platform (Web branch / Tauri branch): the two branches share the early returns
  and the error handling; splitting them now would change control flow, which this task must not do. Left for
  the owner's own refactoring.
- Touching `src/renderer` / `src/datasource`: not needed.

## Files touched

New: `src/state/viewer-types.ts`, `useRendererLifecycle.ts`, `useErrorLog.ts`, `useDisplaySettings.ts`,
`useLayers.ts`, `useFileOpen.ts`, `useConversionSession.ts`, `usePointCloudTools.ts`, `useOpfsStorage.ts`,
`useTempDir.ts`, `error-history.ts`, `open-file-text.ts`, `stats-summary.ts` and the three `*.test.ts`.
Rewritten: `src/state/useCopcViewer.ts`. Comments in moved code were translated to English as they were moved.

## Verified (actually run, in this worktree)

- `npx tsc --noEmit`: no output. `npm run lint`: no output (no errors). `npx vitest run`: 62 files, 554 tests passed
  (before this change the same command passed; the new tests are 3 files).
- `PCV_E2E_PORT=4391 npx playwright test`: 2 passed (web-conversion, web-multi-conversion).
- Real browser: headed Edge (Playwright `channel: "msedge"`, `--enable-unsafe-webgpu`), vite dev server of this
  worktree on port 4392, `adapter.info` = vendor nvidia / architecture lovelace, `isFallbackAdapter` null (not
  SwiftShader). `autzen-classified.copc.laz` opened twice through `file-input`: 2 rows. Coloring dialog opened
  and "強度" chosen (the second layer changed color); the first layer's visibility checkbox turned it off; one
  distance measurement gave a 3rd row "距離 1" and one `measure-label`; the Delete key removed the measurement
  row, the delete button removed one more (3 -> 2 -> 1 rows). `viewer-error` count 0, no page errors. Screenshots
  `r1-1-two-layers.png`, `r1-2-color-dialog.png`, `r1-3-after-color.png`, `r1-4-first-hidden.png`,
  `r1-5-measure.png`, `r1-6-after-delete.png` in the session scratchpad; I opened `r1-1`, `r1-2`, `r1-5`, `r1-6`
  and looked at them (layers drawn, dialog, measurement line and label, one layer left).

## Not verified

- Desktop (Tauri) and Android: not run. The Tauri-only paths (`startLasConversion`, conversion events, tool
  progress sharing the `conversion-progress` event, temp folder) were moved without change but not executed.
- The conversion done/failed handlers on a real conversion: covered only by the two Playwright E2E specs (Web).
- React StrictMode double-mount of the new effect split (dev only) was not checked separately.
- I did not compare before/after pictures pixel by pixel; the check is "the same operations still work".

## How the owner can check

1. `npx tsc --noEmit && npm run lint && npx vitest run`.
2. `npm run dev`, open any `.copc.laz` twice, change the coloring, hide a layer, measure once, delete with the
   Delete key. Open a raw `.las` and watch the conversion dialog and the breakdown in the layer info.
3. Read `src/state/useCopcViewer.ts` first (195 lines); each header comment names the file to read next.
