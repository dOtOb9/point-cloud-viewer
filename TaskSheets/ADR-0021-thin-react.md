# ADR-0021: React only displays; workflows live in plain classes under `src/app/`

Status: accepted (owner, 2026-10-18).

## Context

After R11 the owner read `src/state/useFileOpen.ts` (open → await conversion → add a layer) and found it hard to follow even
with the conversion round trip gone. The difficulty was React itself, not the steps:

- a hook body runs again on every render, so the reader has to track which render a value comes from;
- functions kept with `useCallback` remember the values of the render that made them, so every dependency must be listed, and
  values that must stay current are passed through refs (`openFileRef` in R11 was exactly this);
- effects run after render in call order, so the order of hook calls in `useCopcViewer.ts` carries meaning;
- "go to definition" on `viewer.openFiles` lands on a type, not on the code.

`src/state/` held about 2,000 lines of hooks at ecb725f (`useLayerTool` 276, `useFileOpen` 255, `useLayers` 238,
`useMeasureTool` 201, `useDisplaySettings` 195, `useCopcViewer` 186, `usePointCloudTools` 176, ...). The owner's words:
"React should focus on display and must not be thick. That is not a thin client." The owner comes from Unreal Engine, where
UMG (view) and C++ (logic) are separate, and wants the same split.

`PointCloudRenderer` already works this way: a plain class that React only holds and calls (rule 3). Several React-free modules
also exist already (`layers.ts`, `measure.ts`, `units.ts`, `viewer-status.ts`).

R11's benchmark showed that an AI reader traced the hook-based code correctly, so this decision is for the human reader.

## Decision

1. **`src/ui/` (React components) only displays** state and calls methods when the user acts.
2. **Work that goes through steps or holds state over time** (opening and converting files, the layer list, point-cloud tools,
   measuring, display settings) **lives in plain TypeScript classes and functions under `src/app/`.** Code there reads top to
   bottom: no `useCallback`, no dependency arrays, no refs. Values that change are read through getters or held as fields.
3. **`src/app/` never imports React**, any `src/state/use*` hook, or anything that imports React. It may import `src/datasource/`,
   `src/renderer/` and React-free modules.
4. **The bridge is thin.** A class that the UI must watch exposes `subscribe(listener)` and `getSnapshot()` (a new object on
   every change, the same object otherwise), and one small hook in `src/state/` reads it with `useSyncExternalStore`.
5. **Migration is incremental**, one concern per task, starting with opening files (R12: `src/app/file-opener.ts`). The pure
   modules in `src/state/` move into `src/app/` when the step that owns them moves. `CopcViewerState` (what the UI sees) keeps its
   fields during the migration, so `src/ui/` does not change along the way.
6. **Checked by CI** (`invariants` job, rule 5, together with the previously unchecked rule 3): no React import in `src/renderer/`
   or `src/app/`, and no `src/state/use*` import in `src/app/`.

## Alternatives rejected

- **Keep hooks and tidy them** (shorter hooks, fewer refs). R11 did this for opening files; the owner still found it hard to read.
  The plumbing is a property of hooks, not of how these hooks were written.
- **A state library (Redux, Zustand, ...).** It would add a dependency and its own concepts for the owner to learn, and it still
  puts the logic in a React-flavoured shape. `useSyncExternalStore` is in React itself and needs no library.
- **One big `Viewer` class in one step.** Too large to review and to verify on screen; the step-by-step order keeps each change
  small and lets the owner check each one.

## Consequences

- The logic becomes unit-testable without React (the repo has no React testing library; R11 could not test the hook's
  `reportError` call for that reason).
- During the migration some state is still React state (the layer list, the status) and `src/app/` reaches it through callbacks
  passed in. Those callbacks disappear as the later steps move that state into `src/app/`.
- `useCopcViewer.ts` shrinks to creating the classes and reading their snapshots.
