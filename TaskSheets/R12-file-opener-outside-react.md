# R12: Move opening files out of React — `src/app/file-opener.ts`

Owner decision (2026-10-18), recorded in `TaskSheets/ADR-0021-thin-react.md` (written in parallel by the coordinator): **React
only displays.** Work that goes through steps or holds state over time (open, convert, layers, tools) lives in plain TypeScript
classes under `src/app/`, which never import React. React reaches them through one thin hook.

This is the first step: opening files (`src/state/useFileOpen.ts`, 255 lines, and `src/state/useConversionSession.ts`, 92 lines).
The owner read `useFileOpen.ts` after R11 and found it still hard to follow because of the React plumbing: `useCallback`, long
dependency arrays, `rendererRef.current` / `sourceRef.current` reads, refs passed between hooks.

## Decision

New file `src/app/file-opener.ts` with a class `FileOpener`. Shape (names may change if you say why in the Record):

```ts
export interface FileOpenerDeps {
  getSource: () => DataSource | null;
  getRenderer: () => PointCloudRenderer | null;
  setStatus: (status: ViewerStatus) => void;
  reportError: (message: string, source?: GpuErrorSource) => void;
  /** Adds the finished layer record to the layer list (React state for now; moves into src/app/ in a later step). */
  addLayerToList: (layer: NewLayer) => void;   // the hook implements it as commitLayers(addLayerToState(layersStateRef.current, layer))
  nextLayerId: () => string;
  getTempDir: () => string | null;
  isMobile: boolean;
  pointShape: PointShape;
  /** True while a point-cloud tool runs: its desktop progress must not show as conversion progress. */
  isToolRunning: () => boolean;
  refreshOpfsStorageInfo: () => Promise<void>;
}

export interface FileOpenerSnapshot {
  conversionProgress: ConversionProgress | null;
  convertingFileName: string | null;
}

export class FileOpener {
  constructor(deps: FileOpenerDeps);
  openFiles(items: string[] | File[]): Promise<void>;
  addOpenedLayer(path: string, name: string, attachment: ConversionAttachment | null): Promise<{ layerId: string; pointCount: number; nodeCount: number }>;
  cancelConversion(): void;
  /** For useSyncExternalStore. The snapshot object is replaced (never mutated) when something changes. */
  getSnapshot(): FileOpenerSnapshot;
  subscribe(listener: () => void): () => void;
}
```

- The method bodies are what `useFileOpen.openFiles` / `addOpenedLayer` do today, read top to bottom: no `useCallback`, no
  dependency arrays, no `.current`. Behaviour and every user-visible text stay the same.
- Values that change while the app runs (the temp dir, the source/renderer once created) are read through the getters at the
  moment they are needed, so there is no stale value and no ref.
- **The bridge hook** (`src/state/useFileOpen.ts` or a renamed file; say which): creates the `FileOpener` once, reads its
  snapshot with `useSyncExternalStore`, and passes the getters. Keep it short (target ≤ 50 lines) and explain in a comment how
  the getters see the latest values.
- `useConversionSession.ts` goes away: progress and the file name come from the snapshot, cancel is `opener.cancelConversion()`.
  `copyConversionBreakdownText` (selected layer's text → clipboard) has nothing to do with opening: put it where it reads best
  (a plain function in `src/app/` called by the UI or a few lines in `useCopcViewer.ts`) and say where.
- `usePointCloudTools` calls `opener.addOpenedLayer(...)` instead of the hook's function. Do not change anything else in it.
- `src/app/` may import from `src/datasource/`, `src/renderer/` (types and plain constants), and the **React-free** modules of
  `src/state/` (`layers.ts`, `viewer-status.ts`, ...). It must not import `react`, any `use*.ts` hook, or anything that imports
  React. (Moving those pure modules into `src/app/` is a later step; do not do it now.)
- `CopcViewerState` fields seen by the UI do not change (same names, same meaning). `src/ui/` needs no edits; if it does, say why.

## Out of scope

Layers, display settings, tools, measuring (later steps, one per task). Rust, the Worker, `src/datasource/`.
Do NOT edit `CLAUDE.md`, `TaskSheets/ARCHITECTURE.md`, `TaskSheets/ADR-*`, `.github/workflows/*`, `docs/book/src/conventions.md`,
`docs/book/src/overview.md`: the coordinator edits those in parallel.

## Acceptance criteria (paste the command output in the Record)

1. `grep -rn "from \"react\"" src/app/` → no hits. `grep -rn "useCallback\|useEffect\|useRef\|useState" src/app/` → no hits.
2. `src/state/useConversionSession.ts` no longer exists; `grep -rn "useConversionSession" src/` → no hits.
3. Unit tests for `FileOpener` with a fake `DataSource` and a fake renderer (no React needed), covering at least:
   a COPC opens with no conversion; a conversion result attaches the breakdown text and the download and reports each warning
   with `reportError(w, "conversion")`; `failed` → `setStatus({kind:"error", message: summary})` and `reportError(details, "conversion")`;
   `cancelled` → status `idle` and "変換をキャンセルしました"; several files with a non-LAS one are refused before `prepareToOpen`;
   the download URL is revoked when `addOpenedLayer` throws; progress is ignored while `isToolRunning()` is true;
   `getSnapshot()` returns a new object after a change and the same object otherwise.
4. `npm run typecheck`, `npm run lint`, `npm test` pass (paste the summary lines).
5. `npm run e2e` passes (free `PCV_E2E_PORT`; stop only the process you started, after checking its command line). If it cannot
   run, say exactly why; never claim it passed.
6. Line counts before/after of: `useFileOpen.ts` (255) + `useConversionSession.ts` (92) vs. the bridge hook + `file-opener.ts`.

## Docs

`docs/book/src/flows/open-file.md`, `flows/conversion.md`, `frontend/state.md` (Japanese): the entry point is now
`FileOpener.openFiles` in `src/app/file-opener.ts`. Add a short page or section for `src/app/` in `frontend/` if there is no
place for it (Japanese). Code comments English.

## Record (append here, English)

What you did, why, rejected alternatives, files touched, test results, what you could not verify (desktop Tauri build on a real
machine, Android), and the owner's manual check steps.

### What I did

- New `src/app/file-opener.ts`: `class FileOpener` (260 lines with comments). `openFiles`, `addOpenedLayer`, `cancelConversion`,
  `getSnapshot`, `subscribe` as in the task sheet. The bodies of `openFiles` / `addOpenedLayer` are the old `useFileOpen` bodies
  with `rendererRef.current` -> `deps.getRenderer()` etc.; user-visible texts and the order of `setStatus` / `reportError` calls are unchanged.
  The progress/file-name state of the old `useConversionSession` became the snapshot (`conversionProgress`, `convertingFileName`).
- `src/state/useFileOpen.ts` is now the bridge hook (kept the name; 54 lines, target was 50). It creates the opener once with
  `useState(() => new FileOpener(...))`, reads the snapshot with `useSyncExternalStore`, and returns `{ opener, ...snapshot }`.
- `src/state/useConversionSession.ts` is deleted. `cancelConversion` = `opener.cancelConversion()` (wrapped in `useCallback` in
  `useCopcViewer.ts`). `copyConversionBreakdownText` is now ~10 lines in `useCopcViewer.ts` (it reads the selected layer, which
  `useCopcViewer` already has; a separate `src/app/` function would only have been a clipboard call).
- `viewer-types.ts`: the fields that came from `FileOpen` / `ConversionSession` (`openFiles`, `conversionProgress`, `convertingFileName`,
  `cancelConversion`, `copyConversionBreakdownText`) are now declared directly in the object part of `CopcViewerState` with their doc
  comments (same names, same meaning). `src/ui/` needed no code change (one doc comment in `ConversionDialog.tsx` that named the old file).
- `usePointCloudTools` is untouched except two comment lines that named deleted/moved files; it still gets `addOpenedLayer` as a prop
  (`(path, name, attachment) => opener.addOpenedLayer(...)`).
- `src/app/file-opener.test.ts`: 12 tests with a fake `DataSource` and a fake renderer (no React). Docs: `flows/open-file.md`,
  `conversion.md`, `errors.md`, `node-loading.md`, `point-cloud-tools.md`, `settings.md`, `startup.md`, `frontend/datasource.md`,
  `frontend/state.md` (new section "src/app: React の外で動く処理").
- Comment-only edits in `datasource/`, `state/` that pointed at the old file names.

### Design choices to review

- `addLayerToList` takes a `ViewerLayer` (there is no separate `NewLayer` type; the old code built a `ViewerLayer` too).
- `isMobile` and `pointShape` are plain values (as in the sheet), read once when the opener is created. They come from
  `deviceProfileDefaults`, which is a `useState` initializer that never changes, so they cannot go stale. `tempDir`, `reportError`,
  `setStatus`, etc. are read through getters/closures at call time.
- How the getters see the latest values: the hook keeps a tiny "latest box" (`createLatest`, a closure with `get`/`set`) that an effect
  updates after every render. I first used `useRef`, but `react-hooks/refs` rejected it ("Passing a ref to a function may read its
  value during render" for the closures given to the constructor) and `useState({current})` + mutation was rejected by
  `react-hooks/immutability`. The box is the smallest thing that passes lint; the cost is one 9-line helper in the hook file.
- The bridge returns the snapshot fields spread next to `opener`, so `useCopcViewer` reads `fileOpen.conversionProgress` directly.
- `FileOpener` imports `reportToBackendConsole` from `datasource/tauri.ts` (as the old hook did); it is allowed (only the `@tauri-apps`
  import is restricted). Tests mock that module and `conversion-breakdown` (the formatter has its own tests).
- Rejected: injecting `reportToBackendConsole` and `currentDeviceMeta` as deps (more plumbing for no gain now); keeping
  `useConversionSession` as a thin wrapper (the task said to remove it); a separate `src/app/` function for the clipboard copy.

### Commands and output (this worktree, after the last code change)

```
$ npm run typecheck   -> tsc --noEmit, no errors
$ npm run lint        -> eslint ., no errors
$ npm test            -> Test Files 66 passed (66); Tests 594 passed (594)   (12 of them are new, src/app/file-opener.test.ts)
$ grep -rn "from \"react\"" src/app/                                   -> no hits
$ grep -rn "useCallback\|useEffect\|useRef\|useState" src/app/         -> no hits
$ grep -rn "useConversionSession" src/                                 -> no hits  (src/state/useConversionSession.ts is gone)
$ PCV_E2E_PORT=4391 npm run e2e -> 4 passed (25.4s)
    web-multi-conversion, web-point-file-conversion (PLY, E57), web-conversion (breakdown + download link)
```

The E2E server is started and stopped by Playwright itself (`webServer`); afterwards `netstat` showed only TIME_WAIT sockets on 4391,
so nothing of mine was left running and no process was killed by hand.
(The E2E ran on the code of the refactor and test commits; the later commits only changed docs and one comment block.)

### Line counts (acceptance 6)

| | before | after |
|---|---|---|
| `useFileOpen.ts` | 255 | 54 (bridge hook) |
| `useConversionSession.ts` | 92 | deleted |
| `src/app/file-opener.ts` | - | 260 |
| total | 347 | 314 |

The total barely changes: the logic is the same; what is gone is the React plumbing (`useCallback`, dependency arrays, `.current`).

### Not verified

- Desktop Tauri build on a real machine and Android: not run. The Tauri-only path (`reportToBackendConsole`, desktop progress events,
  `tempDir` from the settings page) is covered only by type checks and the unit tests with fakes.
- E2E covers the Web conversion flow only; the cancel button, the tool-running progress filter, and the "copy breakdown" button were
  not exercised in a browser (the filter and cancel logic are unit-tested/typed; the copy function was moved as is).
- `docs/book/src/overview.md` still mentions `useConversionSession` (line ~64); I did not touch it because the coordinator is editing it.
- The mdBook was not built; the anchor `#srcapp-react-の外で動く処理` in `open-file.md` is my guess of mdBook's anchor rule.

### Owner's manual check

1. Web (`npm run dev`): open a `.las`; the conversion dialog shows the file name and progress, the layer appears, the breakdown panel and
   the download link show, "copy" puts the text on the clipboard.
2. While converting, press cancel: status returns to idle and the banner says "変換をキャンセルしました".
3. Select a PLY plus two LAS together: refused with the file names, no conversion starts.
4. Desktop: open a COPC and a LAZ; run "extract" and see that the tool progress does not show in the conversion dialog.
5. Change the temp folder in settings, then convert: the new folder is used (the getter reads it at call time).
