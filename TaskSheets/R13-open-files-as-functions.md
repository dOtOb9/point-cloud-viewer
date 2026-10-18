# R13: Opening files as plain functions (not a class); F12 reaches the code; no second open while one runs

Owner decisions (2026-10-18), after R12:

1. **No class for this.** The owner (from Unreal Engine practice: do not create classes casually, to keep side effects
   visible) asked why `FileOpener` is a class. It holds hidden mutable state (`private snapshot`, listeners) and needed a
   `createLatest` box in the bridge hook. Rule 5 / ADR-0021 is being revised by the coordinator in parallel: **steps are plain
   functions in `src/app/`; state stays in React and is passed in; classes only for objects that own long-lived resources
   (`PointCloudRenderer`, `WebSource`).**
2. **F12 must reach the code.** Today `viewer.openFiles` jumps to a type declaration in `src/state/viewer-types.ts` and stops.
   The UI will call the function in `src/app/` directly, so "go to definition" lands on the implementation.
3. **No second open while one runs.** On desktop, dropping a file while a conversion runs starts a second conversion; it
   overwrites the backend's cancel flag, so the first one can no longer be cancelled. The open button is already disabled while
   busy; drag and drop is not. Refuse in the open function itself, so the button and the drop are both covered.

## Decision

### `src/app/open-files.ts` (replaces `src/app/file-opener.ts`)

```ts
/** Everything opening a file reads or changes. Built by the bridge hook on each render; see that hook for why each value is current. */
export interface OpenFilesContext {
  getSource: () => DataSource | null;
  getRenderer: () => PointCloudRenderer | null;
  setStatus: (status: ViewerStatus) => void;
  reportError: (message: string, source?: GpuErrorSource) => void;
  setConversionProgress: (progress: ConversionProgress | null) => void;
  setConvertingFileName: (name: string) => void;
  addLayerToList: (layer: ViewerLayer) => void;
  nextLayerId: () => string;
  tempDir: string | null;
  isMobile: boolean;
  pointShape: PointShape;
  isToolRunning: () => boolean;
  refreshOpfsStorageInfo: () => Promise<void>;
  /** Shared "an open is running" flag (one object for the app's lifetime). See `openFiles`. */
  openLock: { busy: boolean };
}

export async function openFiles(ctx: OpenFilesContext, items: string[] | File[]): Promise<void>;
export async function addOpenedLayer(ctx: OpenFilesContext, path: string, name: string, attachment: ConversionAttachment | null): Promise<...>;
export function cancelConversion(ctx: OpenFilesContext): void;   // ctx.getSource()?.cancelConversion()
```

- The bodies are `FileOpener`'s, as functions: same steps, same texts, same behaviour (except the lock below).
- No class, no `this`, no `subscribe` / `getSnapshot`, no hidden state. The only mutable thing is `ctx.openLock`, which is
  passed in on purpose and named so the reader sees it.
- **Lock**: at the start of `openFiles`, if `ctx.openLock.busy` → `ctx.reportError("ファイルを開いている途中・変換中は、新しいファイルを開けません。終わってからもう一度開いてください", "conversion")` and return
  without touching the status (the running open keeps its status). Otherwise set `busy = true` and clear it in a `finally`.
  It is a plain object (not the status) because two drops can arrive before React re-renders with the new status.
- `tempDir`, `isMobile`, `pointShape` are plain values: the context is rebuilt on every render, and an open uses the values
  of the moment it started. `getSource` / `getRenderer` / `isToolRunning` stay getters because they read refs that are filled
  after the first render.

### The bridge hook (`src/state/useFileOpen.ts`)

- Holds `conversionProgress` and `convertingFileName` with `useState`, and `openLock` with `useState(() => ({ busy: false }))`.
- Builds and returns `fileOpenContext: OpenFilesContext` (a plain object literal, rebuilt each render) plus the two state values.
- No `createLatest`, no `useSyncExternalStore`, no effect. Short comment on why each value is current.

### Callers

- `CopcViewerState`: remove `openFiles` and `cancelConversion`; add `fileOpenContext: OpenFilesContext`. Keep
  `conversionProgress`, `convertingFileName` (display state). Remove anything else that only relayed `FileOpener`.
- `OpenFileButton.tsx`: `await openFiles(viewer.fileOpenContext, picked)` with `openFiles` imported from `src/app/open-files`.
  Update its doc comment ("thin call to `openFiles` in src/app/open-files.ts").
- `AppShell.tsx`: `useFileDrop((items) => openFiles(viewer.fileOpenContext, items))`. `useFileDrop` keeps its ref to the latest
  function (it subscribes once), so the latest context is used.
- `ConversionDialog.tsx`: cancel button calls `cancelConversion(viewer.fileOpenContext)`.
- `usePointCloudTools`: `addOpenedLayer(ctx, ...)` through whatever it is given today; keep its change minimal. Its tool runs do
  not take the lock (unchanged behaviour; say so in the Record).
- `src/ui/` importing from `src/app/` is allowed (the revised ADR-0021 says so). `src/ui/` still does not import `src/renderer/`.
- Delete `src/app/file-opener.ts` and move its tests to `src/app/open-files.test.ts`.

## Out of scope

Rust. Layers, display settings, tools, measuring. The CI E2E crash seen on R12 (the coordinator is investigating; do not
try to fix the renderer). Do NOT edit `CLAUDE.md`, `TaskSheets/ARCHITECTURE.md`, `TaskSheets/ADR-*`, `.github/workflows/*`,
`docs/book/src/conventions.md`, `docs/book/src/overview.md`.

## Acceptance criteria (paste the command output in the Record)

1. `grep -rn "class \|this\." src/app/` → no hits. `grep -rn "from \"react\"\|useState\|useEffect\|useRef\|useCallback\|useSyncExternalStore" src/app/` → no hits.
2. `grep -rn "FileOpener\|file-opener\|createLatest\|viewer\.openFiles\|viewer\.cancelConversion" src/ e2e/` → no hits.
3. Unit tests in `src/app/open-files.test.ts`: every case R12 tested, plus: a second `openFiles` while the first is still
   awaiting `prepareToOpen` reports the "開けません" text, does not call `prepareToOpen` again, and does not change the status;
   after the first finishes (success, failure, or a thrown error) a new `openFiles` works (the lock is released in `finally`).
4. Go-to-definition check (honest, scripted): use the TypeScript language service from `node_modules/typescript`
   (`ts.createLanguageService` over the repo's `tsconfig.json`) to ask `getDefinitionAtPosition` for `openFiles` at the call in
   `OpenFileButton.tsx`. Paste the result (file and line). It must be `src/app/open-files.ts`, the function itself.
5. `npm run typecheck`, `npm run lint`, `npm test` pass (summary lines).
6. `npm run e2e` passes locally (free `PCV_E2E_PORT`; stop only the process you started after checking its command line).
7. Line counts: `src/state/useFileOpen.ts` + `src/app/file-opener.ts` (54 + 260 at b9b91cf) vs. after.

## Docs

`docs/book/src/flows/open-file.md`, `flows/conversion.md`, `frontend/state.md` (and any other page naming `FileOpener`):
Japanese. Entry point: `openFiles` in `src/app/open-files.ts`, called directly by the open button and the drop.
Describe the lock ("開いている途中にもう1つ開こうとすると断る") and why it is not the status.

## Record (append, English)

What you did, why, rejected alternatives, files touched, results, behaviour change (second open refused), what you could not
verify (desktop drop during a conversion on a real machine), the owner's manual check steps.

---

# Record (2026-10-18)

## What was done

- `src/app/file-opener.ts` (class `FileOpener`) is now `src/app/open-files.ts`: `openFiles(ctx, items)`, `addOpenedLayer(ctx, ...)`,
  `cancelConversion(ctx)` and the interface `OpenFilesContext`. Bodies are the old methods; texts and steps are unchanged.
  Inside, `openFiles` is a thin wrapper (lock) around a private `runOpen` (the old body), so the `finally` that releases the lock is in one place.
- `src/state/useFileOpen.ts`: two `useState` (progress, file name), `useState(() => ({ busy: false }))` for the lock, and a context object
  literal rebuilt each render. No `createLatest`, no effect, no `useSyncExternalStore`.
- `CopcViewerState`: `openFiles` and `cancelConversion` removed, `fileOpenContext` added. `OpenFileButton`, `AppShell` (drop) and
  `ConversionDialog` import the functions from `src/app/open-files` and pass `viewer.fileOpenContext`.
- `usePointCloudTools` is untouched except comments; `useCopcViewer` passes `(path, name, a) => addOpenedLayer(fileOpen.fileOpenContext, ...)`.
  Tool runs do not take the lock (unchanged behaviour).
- Tests moved to `src/app/open-files.test.ts`. All R12 cases kept; the snapshot test became a check of what `setConversionProgress` /
  `setConvertingFileName` receive (there is no snapshot any more). New: second open while the first awaits `prepareToOpen` (reports the
  "開けません" text, no second `prepareToOpen`, status untouched); lock released after success, failure and a thrown error; `cancelConversion`.
- Book pages updated in Japanese (`flows/open-file.md`, `conversion.md`, `errors.md`, `node-loading.md`, `point-cloud-tools.md`,
  `settings.md`, `startup.md`, `frontend/datasource.md`, `frontend/state.md`). Not touched, as instructed: `conventions.md`, `overview.md`.

## Why / rejected alternatives

- Plain functions with the context as an argument: no hidden state, so side effects are visible at the call site.
- Lock as `{ busy: boolean }` and not the status: two drops can arrive before React re-renders with the new status.
- Rejected: keeping the class and only exposing the methods through `viewer` (F12 would still stop at the type). Rejected: putting the
  lock in `ViewerStatus` (same race). Rejected: `useRef` for the lock (the lint rule `react-hooks/refs` forbids reading it during render, and `useState` once is simpler).
- The lock check comes after the "no renderer / no source" guard, so before initialisation a call still returns silently as before.
- The fix (second open refused) is in the same commit as the refactor: it lives in the function that was rewritten, and the tests
  of both are in one file that had to be renamed in the same commit to keep typecheck green.

## Results

- `npm run typecheck`: no errors. `npm run lint`: no warnings. `npm test`: Test Files 66 passed, Tests 598 passed.
- `PCV_E2E_PORT=4391 npm run e2e`: 4 passed (24.4s). No process was left listening on 4391 afterwards.
- Criterion 1: `grep -rn "class \|this\." src/app/` and the React-hook grep over `src/app/`: no hits. Criterion 2: grep over `src/ e2e/`: no hits.
- Go-to-definition (TypeScript language service, `getDefinitionAtPosition` over the repo's tsconfig):
  - `OpenFileButton.tsx` `openFiles(viewer...` -> `src/app/open-files.ts` line 87, the function `openFiles`.
  - `AppShell.tsx` `openFiles(viewer...` -> `src/app/open-files.ts` line 87.
  - `ConversionDialog.tsx` `cancelConversion(viewer...` -> `src/app/open-files.ts` line 73.
- Lines: `useFileOpen.ts` + `file-opener.ts` = 54 + 260 = 314 at b9b91cf; now 51 + 252 = 303.

## Behaviour change

A second `openFiles` while one runs is refused with the error banner text (source `conversion`); the status is left alone.
Before, on desktop, a drop during a conversion started a second conversion and overwrote the backend cancel flag.

## Not verified

- A drop during a conversion on a real desktop machine (the unit test covers the function, not the Tauri drop event or the backend).
- No screen check of the banner text in a real window; the E2E specs do not drop a second file.
- A long open keeps the context of the render it started in. The values taken from it that can change (tempDir, pointShape, isMobile) are read once at the start
  (intended); the callbacks (`setStatus`, `reportError`, `addLayerToList`, `nextLayerId`) are stable `useCallback`s or setters, so they stay valid. Not tested in a real browser.

## Owner's manual check

1. Desktop: start converting a large LAS, then drop another file on the window. Expect the banner "ファイルを開いている途中・変換中は…", the conversion keeps its progress, and the cancel button still stops it.
2. After the conversion ends (or is cancelled), open a file again: it must work.
3. In the editor, F12 on `openFiles` in `OpenFileButton.tsx` and `AppShell.tsx` should land on `src/app/open-files.ts`.
