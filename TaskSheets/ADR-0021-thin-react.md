# ADR-0021: React only displays; workflows are plain functions under `src/app/`

Status: accepted (owner, 2026-10-18). Revised the same day after R12: functions, not classes (see "Revision" at the end).

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
   measuring, display settings) **is written as plain functions under `src/app/`.** Code there reads top to bottom: no
   `useCallback`, no dependency arrays, no refs, no `this`. A function gets everything it reads or changes through its
   arguments (a context object), so its side effects are visible at the call.
3. **State stays in React** (`useState` in a small hook in `src/state/`). The functions change it only through setters passed in
   the context. They hold no hidden state of their own.
4. **Classes only for objects that own long-lived resources** (WebGPU: `PointCloudRenderer`; a Worker: `WebSource`). Workflows
   and UI state are not classes.
5. **`src/app/` never imports React**, any `src/state/use*` hook, or anything that imports React. It may import `src/datasource/`,
   `src/renderer/` and React-free modules. **`src/ui/` may call `src/app/` functions directly**, passing the context it gets from
   the viewer state, so "go to definition" on the call lands on the code.
6. **Migration is incremental**, one concern per task, starting with opening files (R12, then R13: `src/app/open-files.ts`). The
   pure modules in `src/state/` move into `src/app/` when the step that owns them moves.
7. **Checked by CI** (`invariants` job, rule 5, together with the previously unchecked rule 3): no React import in `src/renderer/`
   or `src/app/`, and no `src/state/use*` import in `src/app/`.

## Alternatives rejected

- **Keep hooks and tidy them** (shorter hooks, fewer refs). R11 did this for opening files; the owner still found it hard to read.
- **A state library (Redux, Zustand, ...).** It would add a dependency and its own concepts for the owner to learn, and it still
  puts the logic in a React-flavoured shape.
- **One big `Viewer` class in one step.** Too large to review and to verify on screen; the step-by-step order keeps each change
  small and lets the owner check each one.
- **Classes with their own state, bridged with `subscribe` / `getSnapshot` / `useSyncExternalStore`.** This was the first
  version of this ADR and R12 built it (`FileOpener`). Rejected in the revision below.

## Consequences

- The logic becomes unit-testable without React (the repo has no React testing library; R11 could not test the hook's
  `reportError` call for that reason). A test passes a fake context.
- The state still lives in React hooks, but those hooks only hold `useState` values and build the context object; the steps
  are in `src/app/`.
- `useCopcViewer.ts` shrinks to holding state and building contexts.

## Revision (owner, 2026-10-18, after R12)

R12 moved opening files into a class, `FileOpener`, with its own snapshot, listeners and a `useSyncExternalStore` bridge. The
owner asked whether OOP was needed at all: in Unreal Engine they avoided creating classes casually, to keep side effects visible
(and for performance there; in JavaScript a class is an ordinary object, so performance is not the reason here). The class did
hide mutable state (`private snapshot`, listeners), and the bridge needed a "latest value" box refreshed by an effect so the
long-lived object could see current React values: the same kind of plumbing this ADR set out to remove.

With plain functions and the state left in React, all of that goes away: the hook builds a context on each render, the UI calls
`openFiles(viewer.fileOpenContext, items)`, and an open uses the values of the moment it started. Nothing is registered once
and called much later any more (R11 removed the event round trip), so there is no stale-value problem to solve.

The same revision also settles navigation: the UI calls the `src/app/` function directly, because "go to definition" on
`viewer.openFiles` stopped at a type declaration in `viewer-types.ts` (owner report, 2026-10-18).
