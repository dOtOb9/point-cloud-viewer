# R5: one discriminated union for the file-open status

Owner decision (2026-10-17). Follow-up to R1 (state split), R3/R4 (toolbar).

## Problem

`CopcViewerState` has four fields that only make sense together:

```ts
status: "idle" | "opening" | "converting" | "ready" | "error";
error: string | null;                       // meaningful only when status === "error"
convertingFileName: string | null;          // meaningful only while converting
conversionProgress: ConversionProgress | null; // meaningful only while converting
```

The types allow impossible combinations (status "ready" with an error message, progress while idle).
Every writer sets them in pairs (`setStatus("error"); setError(msg)` appears ~15 times in `useFileOpen.ts`
and `useConversionSession.ts`). Readers derive meanings by hand at each use site and in different ways:

- `OpenFileButton.tsx:29` `busy = status === "opening" || status === "converting"`
- `LayerList.tsx:30` `loading = ` the same check
- `AppShell.tsx:87` `status !== "error" && status !== "idle"` (listing what it is NOT)
- `StatusBar.tsx:33` `status === "converting" && viewer.conversionProgress?.phase === "reading"`

Adding a state would not make any of these fail to compile.

## Target

`src/state/viewer-status.ts` (new, pure, no React):

```ts
export type ViewerStatus =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "converting"; fileName: string; progress: ConversionProgress | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/** Opening or converting a file: the open button and the layer list wait. */
export function isFileOpenBusy(status: ViewerStatus): boolean {
  switch (status.kind) {
    case "opening":
    case "converting":
      return true;
    case "idle":
    case "ready":
    case "error":
      return false;
  }
}
```

- `CopcViewerState.status` becomes this union. `error`, `convertingFileName`, `conversionProgress` are removed
  from `CopcViewerState` **if** nothing needs them outside their variant (see criterion 3).
- Writers: `setStatus({ kind: "error", message })` replaces each `setStatus("error"); setError(...)` pair.
  Progress events update only while converting:
  `setStatus((prev) => (prev.kind === "converting" ? { ...prev, progress } : prev))`.
- Helpers (pure functions in `viewer-status.ts`, each with an exhaustive `switch`, no `default:`) only where a
  use site combines several kinds: `isFileOpenBusy`, the open-button label (開いています… / 変換中… / 開く), and
  whatever `AppShell.tsx:87` really means (name it after its meaning). A use site comparing one kind
  (`status.kind === "converting"`) stays inline; do not wrap it.
- Check `tsconfig` has `noImplicitReturns` / `strict` so that a missing case is a compile error. If not, add an
  `assertNever(x: never)` call after the switch instead of changing tsconfig, and say which in the Record.
- Do not use TypeScript `enum` and do not add an `as const` object of kinds. The string-literal `kind` is the tag
  (same as a Rust `enum` with data / a Haskell ADT). Write that reason in the header comment of `viewer-status.ts`.

## Acceptance criteria

1. Behaviour unchanged. Go through every `setStatus` / `setError` / `setConvertingFileName` / `setConversionProgress`
   in `src/state/` (useFileOpen.ts, useConversionSession.ts, useLayers.ts:184, usePointCloudTools.ts:99,
   useRendererLifecycle.ts:82) and every reader in `src/ui/` (grep `status`, `.error`, `convertingFileName`,
   `conversionProgress`). Make a before/after table in the Record.
2. `useRendererLifecycle.ts:82` sets `error` without touching `status` (renderer init failure). Decide whether it
   becomes `{ kind: "error" }` without changing what the UI shows (check `AppShell.tsx` conditions, `LayerInfoSection.tsx`,
   `ErrorDialog.tsx`); if it would change behaviour, keep it separate and explain.
3. Check whether `convertingFileName` / `conversionProgress` / `error` are read when the status is NOT that variant
   (e.g. `ConversionDialog.tsx` in the "finished" state after converting, `AppShell.tsx:87-88`). If they are, do not
   lose that information: carry it where it is needed (for example a field on `ready`), or keep the field outside the
   union — pick the simplest, and record why.
4. `src/state/viewer-status.test.ts`: tests for each helper over every kind.
5. `useLayers.ts:184` `setStatus((prev) => (prev === "ready" ? "idle" : prev))` keeps its meaning with `prev.kind`.
6. English comments in touched code; translate comments of the functions you touch (CLAUDE.md, ADR-0015 approach).
   Replace `unwrap`-like patterns only in touched functions (n/a for TS mostly).
7. `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, and the Playwright E2E (`PCV_E2E_PORT` free port,
   run_in_background, stop only your processes; ADR-0016) pass. The E2E covers conversion, which uses this state.
8. Update the mdBook pages that describe `status` / `error` / conversion progress (grep `docs/book` for
   `status`, `convertingFileName`, `conversionProgress`, `ViewerStatus`). Japanese.
9. Commits: `♻️ refactor: ...` (code, may be 2 commits: add the union + helpers with tests, then switch writers/readers),
   `📝 docs(book): ...`, `📝 docs: ...` (this sheet). Each ends with the Co-Authored-By line.

## Owner checks (agent cannot see the screen)

- Web: open a LAS → conversion dialog shows file name and progress → finishes and shows the breakdown; the open button
  shows 変換中… while converting. Cancel a conversion → no error shown.
- Open an unsupported mix of files (LAS + PCD at once) → the error text appears as before.

## Record (filled in by the implementer)

### Files touched

- New: `src/state/viewer-status.ts` (type + `isFileOpenBusy`, `openButtonLabel`, `statusErrorMessage`, `isOpenRunningOrDone`), `src/state/viewer-status.test.ts`.
- State: `viewer-types.ts` (old `ViewerStatus` string type and `error` field removed), `useCopcViewer.ts`, `useFileOpen.ts`, `useConversionSession.ts`, `useLayers.ts`, `usePointCloudTools.ts`.
- UI: `AppShell.tsx`, `LayerInfoSection.tsx`, `LayerList.tsx`, `LayerList.test.tsx` (the fake viewer used the old string), `ConversionDialog.tsx`, `StatusBar.tsx`, `toolbar/buttons/OpenFileButton.tsx`.
- Book: `docs/book/src/frontend/state.md`, `docs/book/src/flows/errors.md`.
- `useRendererLifecycle.ts` is unchanged: it still takes a `setError(message)` callback; `useCopcViewer.ts` passes `setInitError`.

### Final type and helpers

```ts
type ViewerStatus =
  | { kind: "idle" } | { kind: "opening" } | { kind: "converting" } | { kind: "ready" }
  | { kind: "error"; message: string };
```

Helpers (exhaustive `switch`, no `default:`): `isFileOpenBusy`, `openButtonLabel`, `statusErrorMessage`,
`isOpenRunningOrDone` (the meaning of the old `status !== "error" && status !== "idle"` in `AppShell.tsx`: an open is
running or finished well). Single-kind comparisons (`status.kind === "converting"`) stay inline.

`tsconfig.json` has `strict` but not `noImplicitReturns`. `strict` alone is enough: I added a dummy `{ kind: "zzz" }`
variant and `npx tsc --noEmit` reported TS2366 four times (grep count 4, one per helper); then removed it.
No `assertNever` was needed.

### Before/after table (writers)

| Place | Before | After |
|---|---|---|
| `useFileOpen.ts` openFile / openFiles start | `setStatus("opening"); setError(null)` | `setStatus({kind:"opening"})` (the error goes away with the old status) |
| `useFileOpen.ts` 11 failure sites | `setStatus("error"); setError(msg)` | `setStatus({kind:"error", message: msg})` |
| `useFileOpen.ts` converting / ready | `setStatus("converting")` / `("ready")` | `{kind:"converting"}` / `{kind:"ready"}` |
| `useConversionSession.ts` `reportConversionFailure` | `setStatus(cancelled?"idle":"error"); setError(cancelled?null:message)` | `setStatus(cancelled ? {kind:"idle"} : {kind:"error", message})` |
| `useConversionSession.ts` OPFS read-back failure | `setStatus("error"); setError(...)` | `setStatus({kind:"error", message})` |
| `useLayers.ts:184` | `prev === "ready" ? "idle" : prev` | `prev.kind === "ready" ? {kind:"idle"} : prev` |
| `usePointCloudTools.ts:99` | `setStatus("ready")` | `prev.kind === "error" ? prev : {kind:"ready"}` (see decisions) |
| `useRendererLifecycle.ts:82` | `setError(String(e))`, status untouched | `setStatus({kind:"error", message})` via `setInitError` (see criterion 2) |
| progress / file name | `setConversionProgress`, `setConvertingFileName` | unchanged (outside the union, see criterion 3) |

### Before/after table (readers)

| Place | Before | After |
|---|---|---|
| `OpenFileButton.tsx` busy / label | two inline comparisons | `isFileOpenBusy`, `openButtonLabel` |
| `LayerList.tsx` loading | `opening \|\| converting` | `isFileOpenBusy` |
| `AppShell.tsx` dialog auto-open | `status` string compare, `viewer.error` | `status.kind` compare, `statusErrorMessage(status)` (same triggers: kind change, message change, count change) |
| `AppShell.tsx:87` | `status !== "error" && !== "idle"` | `isOpenRunningOrDone` |
| `AppShell.tsx` `viewerError` prop, `LayerInfoSection.tsx` error `<p>` | `viewer.error` | `statusErrorMessage(viewer.status)` |
| `ConversionDialog.tsx`, `StatusBar.tsx` | `status === "converting"` | `status.kind === "converting"` (inline) |

### Decisions for criteria 2 and 3

- Criterion 2 (renderer init failure): it becomes `{kind:"error"}`. At init time there is no layer, so
  `conversionFinished` (needs `selectedLayer`) is false; the open button and layer list are not busy for "idle" or
  "error"; the error `<p>` and the error dialog open on the message, as before. The next open sets "opening", which cleared
  the error before too. One difference, judged negligible and not verified: before, an init rejection that arrived while
  an open was already running left that status alone and only set the text; now it replaces the status. Init finishes
  before a user can pick a file in practice.
- Criterion 3: `convertingFileName` and `conversionProgress` are read outside their "variant":
  `ConversionDialog` shows the file name in the finished state (status "ready"), and `rememberConvertingSource` sets the
  name while the status is still "opening". Progress events (the Web worker sends "preparing" steps while the
  start call is still pending; I did not measure the order) may arrive before `setStatus({kind:"converting"})`; putting
  progress inside the variant would drop them. So both stay as they were in `useConversionSession` and `CopcViewerState`;
  `converting` carries no data. Only `error` moved into the union. Follow-up if wanted: a ref that replays early progress.
- `usePointCloudTools.ts`: before, a successful tool after a failed open set status "ready" but the old error text stayed in
  the panel. To keep that, a tool keeps `{kind:"error"}` as it is. The only side effect: the status stays "error" instead of
  "ready", which matters only for the conversion dialog visibility (`isOpenRunningOrDone`) in that rare case.

### Commands run and output

- `npx vitest run src/state/viewer-status.test.ts`: 4 passed.
- `npx tsc --noEmit`: no output (pass). `npm run lint`: no errors.
- First full `npx vitest run` after the switch: 1 failed / 556 passed (`LayerList.test.tsx` passed the old string
  "opening" as the status; `tsc` did not catch it because the fake viewer is cast). Fixed the test.
- `npx vitest run`: Test Files 63 passed (63), Tests 557 passed (557).
- `PCV_E2E_PORT=4391 npx playwright test` (background): 2 passed (8.5s): web-conversion, web-multi-conversion. No listener
  left on 4391 afterwards (only TIME_WAIT sockets).
- Not run: desktop (Tauri) and Android builds; screen checks.

### Alternatives not taken and why

- `fileName` and `progress` inside `converting` (the sheet's first sketch): see criterion 3.
- A getter `error` kept on `CopcViewerState`: two ways to read the same fact; readers use `statusErrorMessage`.
- `enum` or an `as const` kinds object: the string-literal `kind` is the tag (reason in the header of `viewer-status.ts`).
- A tool success always setting "ready": would hide an earlier open error text (a behaviour change).

### Owner checks (agent cannot see the screen)

As listed above: Web LAS conversion dialog and 変換中… label; cancel shows no error text in the panel; LAS + PCD at once
shows the error text. Extra: with a failed open still showing, run a tool (extract) and check the error text stays.
