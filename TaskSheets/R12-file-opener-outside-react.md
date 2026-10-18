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
