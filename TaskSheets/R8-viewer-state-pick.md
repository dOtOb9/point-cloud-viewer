# R8: Build `CopcViewerState` from the hooks' own types (`Pick`)

Owner discussion (2026-10-18). The owner tried to follow `viewer.openFiles(...)` from `OpenFileButton` to its code and could not:
F12 stops at `src/state/viewer-types.ts`, which declares every field a second time with its own doc comment.

## The problem (observed, concrete)

1. **F12 on `viewer.xxx` lands on `viewer-types.ts`, not near the code.** The implementation is in a state hook
   (`useFileOpen.ts`, `useLayers.ts`, ...), reached only through `useCopcViewer.ts`.
2. **Each field is declared twice, with two doc comments that drift.** Example: `openFiles` is documented in
   `FileOpen` (`useFileOpen.ts`) and again in `CopcViewerState`; the second one still names `src-tauri` functions.

## Decision

Keep `CopcViewerState` as the one thing the UI sees (it hides how `src/state` is split into hooks, and keeps the hooks' internal
fields such as `layersStateRef`, `commitLayers`, `openFileRef`, `addOpenedLayer` out of the UI). Only change **how it is typed**:

```ts
export type CopcViewerState =
  Pick<Layers, "layers" | "selectedLayerId" | ...> &
  Pick<DisplaySettings, "pointBudget" | "setPointBudget" | ...> &
  Pick<FileOpen, "openFiles"> &
  ... & {
    // Only what useCopcViewer makes itself is declared here.
    status: ViewerStatus;
    isBrowser: boolean;
    pickPoint: ...;
    getViewSnapshot: ...;
  };
```

Checked by the coordinator (TypeScript 6.0.3 language service, scratch project, not the real code): Go to Definition on a field
of a `Pick<...> & {...}` type goes to the field in the original interface, and the hover shows that interface's doc comment.

### Rejected alternatives

- **Group by hook (`viewer.fileOpen.openFiles`)**: the UI would have to know which hook owns what (`viewer.layers.resetView`,
  `viewer.layers.layers`), moving a function between hooks would change the UI, and internal fields would become visible to the UI.
- **Comments only ("implemented in useX.ts")**: leaves the double declaration and the drift.
- **No aggregate, AppShell calls each hook**: much larger (29 components' props) and not needed for this problem.
- **Spread (`...fileOpen`) in the assembly**: would leak internal fields. The explicit list in `useCopcViewer.ts` stays; it is the
  readable list of what the UI gets.

## Work

1. `src/state/viewer-types.ts`: replace the field-by-field `CopcViewerState` interface with `Pick<HookType, ...> & { ... }`.
   - Keep the field names exactly as today, so no UI file changes. If a hook's field has a different name from the
     `CopcViewerState` field, list it (do not rename in this task).
   - Move any doc comment that exists only in `viewer-types.ts` and still says something true to the hook's interface (English).
     Drop text that is out of date. Do not keep two copies.
   - `ToolProgressState`, `OpfsStorageInfo` and the re-exports stay where they are (they are used by `src/ui`; rule 3).
2. `viewer.openFile` is not used by `src/ui` or `e2e` (`grep -rn "viewer\.openFile\b" src/ui e2e` is empty today). Remove
   `openFile` from `CopcViewerState` and from the assembly in `useCopcViewer.ts`. `openFileRef` (conversion continuation) is not
   affected. If you find a user, keep it and say where.
3. Do the same check for every other field: if `src/ui` never reads it, list it in the Record. **Do not remove the others in this
   task** (one concern per commit; the owner decides).
4. `useCopcViewer.ts`: the assembly is unchanged except step 2. Update the header comment if it describes `viewer-types.ts`.
5. mdBook (Japanese): where `docs/book/` explains `CopcViewerState` / `viewer-types.ts`, say that the field types and their
   explanations live in each hook's interface, and how to reach the code from `viewer.xxx` (F12 → hook interface, implementation
   is in the same file).

## Acceptance criteria

1. `git diff origin/main --stat` touches only `src/state/viewer-types.ts`, `src/state/useCopcViewer.ts`, the hook files whose
   interface comments changed, `docs/book/`, and this sheet. No file under `src/ui/` changes.
2. `viewer-types.ts` declares no field that is also declared in a hook interface (each field is declared once).
3. `npx tsc --noEmit`, `npm run lint`, `npx vitest run` pass. The `invariants` CI job's checks pass (see `.github/workflows`).
4. CI green after push (give the run id).
5. Commits, one concern each, for example:
   `♻️ refactor: CopcViewerState をフックの型から Pick で組み立てる`,
   `♻️ refactor: UI が使っていない openFile を CopcViewerState から外す`,
   `📝 docs(book): viewer の型と実装の辿り方を書く`, `📝 docs: R8 のタスクシートに記録を書く`.

## Owner checks

- In VS Code, open `src/ui/toolbar/buttons/OpenFileButton.tsx`, put the cursor on `openFiles` in `viewer.openFiles(picked)`, press
  F12 → it should open `src/state/useFileOpen.ts` at `openFiles` in `interface FileOpen`; the implementation is lower in the same file.
- Hover `viewer.openFiles` → the explanation from `useFileOpen.ts` is shown.
- The app still opens a file (no behaviour change is intended).

## Record (filled in by the implementer)

- Files touched: `src/state/viewer-types.ts` (rewritten as `Pick<...> & {...}`), `src/state/useCopcViewer.ts` (removed
  `openFile` from the assembly, header comment), the doc comments of the interfaces in `useLayers.ts`, `useDisplaySettings.ts`,
  `useErrorLog.ts`, `useConversionSession.ts`, `useFileOpen.ts`, `usePointCloudTools.ts`, `useOpfsStorage.ts`, `useTempDir.ts`,
  `docs/book/src/frontend/state.md`, `docs/book/src/flows/settings.md`, this sheet. No file under `src/ui/` or `e2e/`.
- Field names that differ between a hook and `CopcViewerState`: none. Every field was a `Pick` of an identically named field
  (type-checked by `tsc`). Fields declared in `viewer-types.ts` itself (not in any hook interface): `status`, `isBrowser`,
  `pickPoint`, `getViewSnapshot` (made by `useCopcViewer`).
- Fields in `CopcViewerState` that `src/ui` never reads (checked with `grep -rnE "\b<field>\b" src/ui e2e` for every field):
  `openFile` (removed), `resetView` (not read anywhere in `src`; the book already says so in `flows/layers.md`), and three that
  only `src/state` reads, through `viewerRef.current` in `useLayerTool.ts` / `useMeasureTool.ts`: `pickPoint`,
  `addMeasurement`, `extractFromLayer`. Not removed (the owner decides). The grep is a word search, so a field used under another
  name (a destructure rename) would be missed; `tsc` did not complain after the removal of `openFile`.
- Doc comments moved / dropped: moved (shortened, English) into the hook interfaces: `layers`, `selectedLayerId`, `selectedLayer`,
  `selectedLayerIds`, the selection and per-layer actions, `resetView`, `removeLayer`, `addMeasurement` (Layers); `autoPointBudgetEnabled`,
  `edlEnabled`, `animationEnabled`, `centerPriorityStrength`, `minCenterPriorityWeight` (DisplaySettings); `gpuErrors` (ErrorLog);
  `conversionProgress`, `convertingFileName`, `cancelConversion`, `copyConversionBreakdownText` (ConversionSession);
  `openFile`, `openFiles` (FileOpen); `toolProgress`, `extractFromLayer`, `mergeSelectedLayers` (PointCloudTools); all OPFS fields;
  `tempDir`, `supportsCustomTempDir`. Dropped as out of date or duplicated: `errorHistory` (the ErrorLog one already said it),
  "UI toggle for animation not implemented" (stale), "the toggle after the UI rebuild" wording, the `pickAndSetTempDir` /
  `clearTempDir` / `reportError` / `dismissGpuError` / `isBrowser` copies (the hook already had a comment, or `isBrowser` was kept
  in `viewer-types.ts`). The `canvasRef` comment stays in `viewer-types.ts`, translated into English.
  Where `viewer-types.ts` still has comments in Japanese (re-export notes, `OpfsStorageInfo`), they were not touched.
- Commands run and their results (all in the worktree):
  - `npx tsc --noEmit` -> exit 0
  - `npm run lint` -> exit 0, no output from eslint
  - `npx vitest run` -> 63 files passed, 561 tests passed
  - `git diff origin/main --stat` before push -> only the files listed above
  - CI run id and result: run 39050793165 on 2648a19, `success` (checked by the coordinator with `gh run view`).
- Owner check (2026-10-18): F12 on `viewer.openFiles` in VS Code now goes to `useFileOpen.ts` (reported by the owner).
- Not checked: the hover text in VS Code, the `invariants` CI job locally (only the diff was inspected: no new import of the Tauri packages, no React in
  `src/renderer`), that the app still opens a file on screen (no behavior change is intended; only types and one unused field
  changed), the mdBook build (`mdbook` not run).
