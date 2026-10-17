# R9: `DataSource.prepareToOpen` — make `openFile` / `openFiles` "call the source, then switch"

Owner discussion (2026-10-18). Reading `src/state/useFileOpen.ts`, the owner expected "it just calls a Rust command" and found
about 330 lines. Owner decision (2026-10-17, still valid): **the Web and desktop builds do the same things**, so "turn this file
into a COPC that can be opened" is one operation on both, not a difference to hide.

## The problem (observed, concrete)

1. **`openFile` branches on the platform with `instanceof WebSource` / `instanceof TauriSource`.** The Web branch (about 70 lines:
   COPC header check, format → conversion route, OPFS checks) is written inline in state; the desktop branch is a call to
   `startLasConversion` and a `switch`.
2. **Unreachable cases.** `ConversionOutcome` (`src/datasource/conversion-dto.ts`) is shared, so each `switch` also handles kinds the
   other platform returns (`insufficientSpace` on the Web, `alreadyCopc` in the merge route, ...), each with a "should not be
   reached" comment.
3. **The outcome handling is written twice.** `openFile` and `openFiles` each turn `opfsUnavailable` / `insufficientSpace` /
   `insufficientSpaceWeb` / `cached` / `converting` into status and messages.

## Decision

Add one method to the `DataSource` interface (`src/datasource/DataSource.ts`), implemented by `WebSource` and `TauriSource`:

```ts
/** Makes the chosen file(s) ready to open: one COPC opens as it is; anything else is converted (several LAS/LAZ are merged). */
prepareToOpen(items: string[] | File[], options: { tempDir: string | null; isMobile: boolean }): Promise<PrepareOutcome>;

export type PrepareOutcome =
  | { kind: "ready"; path: string }        // a COPC path/key that `open()` accepts (already COPC, or a cached conversion)
  | { kind: "converting" }                  // the "done" event continues (unchanged: useConversionSession → openFileRef)
  | { kind: "failed"; summary: string; details: string }; // summary → panel status, details → error log
```

- `WebSource.prepareToOpen`: one `File` → what `openFile`'s Web branch does today (`isCopcFile` → `registerFile`; otherwise the
  format route `startPointFileConversion` / `startConversion`). Several `File`s → `startMultiConversion`. One `string` → `ready`
  with that string (the conversion continuation passes an OPFS key). `isMobile` is used, `tempDir` is ignored.
- `TauriSource.prepareToOpen`: one path → `start_las_conversion`; several → `start_multi_las_conversion` (call the existing
  `startLasConversion` / `startMultiLasConversion`). `tempDir` is used, `isMobile` is ignored.
- Each source maps its own results to `PrepareOutcome`, so `PrepareOutcome` has only kinds that really happen.
  `ConversionOutcome` stays as the type of the existing `start*` functions (they are also used by the tools); do not reshape it here.
- **Message texts do not change.** Today: insufficient space → error log gets the long text
  (`describeInsufficientSpaceWeb` / `describeInsufficientSpaceDesktop`), the panel gets "空き容量が足りません";
  OPFS unavailable → both get the long text (the single-file and multi-file texts differ: keep both).
  `describeInsufficientSpaceDesktop` moves from `src/state/open-file-text.ts` to `src/datasource/` (state may import datasource,
  not the other way round), with its test. Pick the file; say which.
- State (`useFileOpen.ts`) keeps what is the same on every platform: the "several files must all be LAS/LAZ" check, the display
  name (`rememberConvertingSource`), status changes, `addOpenedLayer`, the log line. On `failed` it calls `failOpen`-like code with
  `summary` / `details` and then `refreshOpfsStorageInfo()` (it already does nothing on desktop: `useOpfsStorage.ts`).
- `openFile` and `openFiles` share one path: `openFile(item, isConversionContinuation)` becomes a thin call into the same code as
  `openFiles([item])`. The single/multi difference lives in the sources and in the LAS/LAZ check.

### Known small behaviour change (allowed; record it)

On the Web, `rememberConvertingSource` is called today only for non-COPC files; on desktop it is always called. After this task it
is called before `prepareToOpen` on both (the desktop behaviour). If this changes what the conversion dialog shows after opening a
COPC on the Web, describe what you saw (or that you could not see it) in the Record.

### Out of scope (same pattern, separate tasks if the owner wants them)

- `useConversionSession.ts`: `instanceof WebSource` for progress/done/failed events and cancel.
- `usePointCloudTools.ts`: `instanceof WebSource` for extract/merge/cancel.
- The two-step open (conversion ends → the done event calls `openFile(output, true)` again). Keep it as it is.
- The duplicated Rust readers (`pcv-convert` / `pcv-wasm`).

### Rejected alternatives

- **A free function with `if (isTauriEnvironment())` (like `pickFilesToOpen`)**: `DataSource` already exists for exactly this
  ("one operation, a Web and a desktop implementation"); `openFile` bypasses it today with `instanceof`. Using it removes the casts.
- **Keep `ConversionOutcome` in state and only merge the two `switch`es into a helper**: removes problem 3 but keeps 1 and 2.

## Acceptance criteria

1. `grep -n "instanceof" src/state/useFileOpen.ts` is empty. `useFileOpen.ts` imports nothing from `src/datasource/tauri.ts`
   except what is unrelated to opening (list it if any).
2. No `case` in `useFileOpen.ts` carries a "never returned / not reached / exhaustiveness only" comment.
3. Same texts as before for: insufficient space (Web and desktop), OPFS unavailable (single and multi), non-LAS in a multiple
   selection. Unit tests for `WebSource.prepareToOpen` cover: COPC → `ready`; cached → `ready`; OPFS unavailable → `failed` with
   today's text; insufficient space → `failed`; several files → the multi route; one string → `ready`
   (follow `src/datasource/web.test.ts`). `TauriSource.prepareToOpen` mapping is tested if `tauri.ts` can be tested without the
   Tauri runtime; if not, say so and test the mapping function on its own.
4. `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, and all Playwright E2E specs pass (E2E: free `PCV_E2E_PORT`, stop only
   your own processes; ADR-0016). Long commands with `run_in_background`. The `invariants` checks pass (rule 2: the Tauri package
   name must not appear in any other `src/` file, even in a comment).
5. CI green after push (give the run id).
6. English comments in touched code; Japanese mdBook updates (`docs/book/` pages for the open flow, e.g. `flows/open-file.md`, and
   wherever `DataSource` is described). The comment that explains the Web branch's header-based COPC check (M4-6b, M4-9 bug note)
   moves with the code into `web.ts`.
7. Commits, one concern each, for example:
   `♻️ refactor: 容量不足の文言を datasource に移す`,
   `♻️ refactor: DataSource に prepareToOpen を足す（Web と Tauri）`,
   `♻️ refactor: openFile と openFiles を prepareToOpen の結果で分けるだけにする`,
   `📝 docs(book): ファイルを開く流れを prepareToOpen に合わせる`, `📝 docs: R9 のタスクシートに記録を書く`.

## Owner checks (agent cannot see the screen)

Desktop and Web, each:
- Open a COPC → it opens at once.
- Open a raw LAS/LAZ → conversion progress → opens; open it again → opens from the cache without converting.
- Open a PLY (or PCD/E57) → converts and opens.
- Choose several LAS/LAZ → merged into one layer. Choose LAS + PLY together → the error names the PLY file.
- Web only: in a browser without OPFS (if available) → the same message as before.

## Additions (2026-10-18)

From the coordinator, on top of the sheet above:

1. Owner check added (desktop and Web): **open by drag and drop** gives the same results as the open button.
   `useFileDrop.ts` calls `viewer.openFiles`, so it goes through the new path without changes; keep it that way.
2. `src/datasource/tauri.ts`: the comment on `onFilesDropped` said the Web drop event is handled by `useFileDrop.ts`; it is handled in
   `src/datasource/file-picker.ts`. Fix the comment (done, English).
3. `src/state/useFileOpen.ts`, `interface FileOpen`: the doc of `openFile` said "Web: a URL string", but opening from a URL was removed.
   On the Web the string is an OPFS key from the conversion continuation. Make the `openFile` and `openFiles` docs match the new flow (done).

## Record (filled in by the implementer)

- Files touched: `src/datasource/DataSource.ts` (`PrepareOutcome`, `prepareToOpen`), `src/datasource/prepare-outcome.ts` (new:
  `toPrepareOutcome`, `describeInsufficientSpaceDesktop`, the two OPFS-unavailable texts) and its test, `src/datasource/web.ts`
  (`WebSource.prepareToOpen`), `src/datasource/web-prepare.test.ts` (new), `src/datasource/tauri.ts` (`TauriSource.prepareToOpen`,
  drop comment), `src/state/useFileOpen.ts`, `src/state/open-file-text.ts` and its test (function removed), `docs/book/src/flows/open-file.md`,
  `flows/errors.md`, `flows/conversion.md`, `frontend/datasource.md`.
- Where `describeInsufficientSpaceDesktop` went and why: `src/datasource/prepare-outcome.ts`, next to `toPrepareOutcome`, which is the only
  caller besides tests. `opfs.ts` holds the Web text because it reads OPFS numbers; the desktop text has no such input, and `opfs.ts`
  is Web-specific, so it got its own small file. The test moved to `prepare-outcome.test.ts`.
- Design notes: one shared pure function `toPrepareOutcome(outcome, isMulti)` maps every `ConversionOutcome` kind (used by both sources,
  so it is testable without the Tauri runtime). Because it maps all kinds, there is no "never returned" case anywhere. `openFile` and
  `openFiles` both call one internal `openItems`. `failOpen(summary, details = summary)` replaced the three hand-written
  `reportError` + `setStatus` pairs.
- `useFileOpen.ts` line count before / after (`wc -l`): 381 / 234.
- The `rememberConvertingSource` change on the Web: it is now called before `prepareToOpen` on every open, so a COPC opened on the Web also
  sets the remembered name and `convertingFileName`. I could not see the screen. By reading the code: the only reader of `convertingFileName` is
  `ConversionDialog.tsx` (file name line, `"(不明)"` when null), so the visible effect is limited to that dialog showing the name of
  the last opened file (a COPC name) if it is opened after a COPC open instead of a stale or "(不明)" name. Whether the dialog can
  be opened in that state was not checked; unverified on screen.
  The continuation (`openFile(key, true)`) also calls it now, with the OPFS key; the breakdown text was already built before that, so
  it is not affected (the desktop build already behaved this way).
- Other small behaviour changes: a cached multi-file conversion now names the layer with the display name ("... ほかNファイル") instead of
  the OPFS key (`file:N`); it also opens directly instead of calling `openFile` a second time. `refreshOpfsStorageInfo()` is now also
  called after "OPFS unavailable" (before: only after insufficient space); it only re-reads the usage.
- Commands run and their results:
  - `npx tsc --noEmit`: no output (pass).
  - `npm run lint`: no output (pass).
  - `npx vitest run`: 575 tests passed.
  - `PCV_E2E_PORT=4391 npx playwright test`: 4 passed (LAS conversion, multi-LAS merge, PLY, E57), about 29 s. No process left listening on 4391.
  - `grep -n "instanceof\|not reached\|never returned" src/state/useFileOpen.ts`: empty.
  - CI run id: see the end of this section (filled in after the push).
- Not checked: everything on screen (desktop app, Web in a real browser by hand, Android); `TauriSource.prepareToOpen` itself (it needs the
  Tauri runtime; only the mapping `toPrepareOutcome` it uses is unit-tested); "OPFS unavailable" in a browser without OPFS (tested only
  with a mocked `isOpfsAvailable`); drag and drop (unchanged path, not run); opening a COPC on the Web (no E2E covers it).

- Files touched:
- Where `describeInsufficientSpaceDesktop` went and why:
- `useFileOpen.ts` line count before / after (`wc -l`):
- The `rememberConvertingSource` change on the Web: what you saw:
- Commands run and their results (tsc, lint, vitest, E2E, CI run id):
- Not checked:
