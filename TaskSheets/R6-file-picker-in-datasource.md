# R6: openable formats in one place, file picking and dropping behind the data source

Owner decision (2026-10-17). Follow-up to R4 (`OpenFileButton` on `ToolbarButton`).

## Owner change (2026-10-17, after the sheet was written)

The owner will make the Web and desktop builds support the same formats, so the per-platform
`Record<Platform, ...>` table described under Target 1 was NOT built. `source-format.ts` has instead:
`OPENABLE_FORMATS` (one list for every platform), `NOT_YET_CONVERTIBLE_ON_WEB` (`["ply", "e57"]`, a temporary gap
with a delete-me comment), `openableFormatsOn(platform)` (the list minus the gap on "web") and `fileExtensionsOf`.
Where the sheet says `OPENABLE_FORMATS.web/.desktop` or `canOpen`, read `openableFormatsOn("web"/"desktop")` and
`NOT_YET_CONVERTIBLE_ON_WEB.includes(format)`. Everything else stands.

## Problem

"Which formats can this platform open" is written in three places that must agree by hand:

| Place | Says |
|---|---|
| `src/datasource/tauri.ts` (`pickLocalFiles`, and the filter near line 100) | desktop dialog filter: las, laz, e57, ply, pcd |
| `src/ui/toolbar/buttons/OpenFileButton.tsx` | Web `accept=".las,.laz,.pcd"` |
| `src/state/useFileOpen.ts:145` | Web: PLY / E57 get "Web版ではまだ変換できません" |

The difference is intentional (the Web build has no PLY/E57 conversion yet), but when it changes, one of the three
will be forgotten. Also, "how files arrive on this platform" is a data-source concern, yet the UI branches on
`viewer.isBrowser` for it (`OpenFileButton.tsx`, and `useFileDrop.ts` for drag and drop).

## Target

1. `src/datasource/source-format.ts`: one table of openable formats per platform, e.g.

   ```ts
   export type Platform = "web" | "desktop";
   /** Formats each platform can open (convert to COPC). The Web build has no PLY/E57 conversion yet (M4-9). */
   export const OPENABLE_FORMATS: Record<Platform, readonly SourceFormat[]> = {
     web: ["lasLaz", "pcd"],
     desktop: ["lasLaz", "pcd", "ply", "e57"],
   };
   export function fileExtensionsOf(formats): string[]   // "lasLaz" -> ["las", "laz"], ... (exhaustive switch)
   export function canOpen(platform, format): boolean
   ```

   Keep `detectSourceFormatByName` as it is. Tests in `source-format.test.ts`.
   - The desktop dialog filter in `tauri.ts` and its display name are built from `OPENABLE_FORMATS.desktop`
     (check both filter sites near lines 100 and 145; keep ".copc.laz" in the display name — COPC is a .laz).
   - The Web picker's `accept` is built from `OPENABLE_FORMATS.web`.
   - `useFileOpen.ts:145` uses `canOpen("web", format)` instead of naming PLY/E57. Keep the error text identical
     for PLY/E57 (it names the format and points to the desktop build).

2. `src/datasource/file-picker.ts` (new): the one entry the UI/state use.

   ```ts
   /** Shows the platform's file chooser. Resolves null when cancelled. */
   export function pickFilesToOpen(): Promise<string[] | File[] | null>
   /** Subscribes to files dropped on the window. Returns an unsubscribe function. */
   export function onFilesDroppedToOpen(onFiles: (items: string[] | File[]) => void, onDragging: (d: boolean) => void): Promise<() => void>
   ```

   - Picks the implementation with `isTauriEnvironment()` (`environment.ts`).
   - Desktop: calls `pickLocalFiles` / `onFilesDropped` from `tauri.ts` (rule 2: only `tauri.ts` imports the Tauri packages;
     do not write their package name anywhere else in `src/`, comments included).
   - Web picker: create an `<input type="file" multiple accept=...>` (not attached to the React tree), resolve with its
     files on `change`, resolve null on `cancel`. **`input.click()` must run synchronously inside the caller's click
     handler, before any `await`**, or the browser blocks it as not user-initiated. Write this in a comment. If the
     browser never fires `cancel`, the promise stays pending; that is acceptable, say so in a comment.
     Whether the input must be attached to `document.body` for the picker / for Playwright's `filechooser` event:
     try detached first; if E2E does not see the chooser, attach it hidden and remove it after.
   - Web drop: move the window `dragover` / `dragleave` / `drop` code from `useFileDrop.ts` here unchanged.
   - Plain functions, no class, no registry. A Web implementation may live in `src/datasource/web-file-picker.ts` if
     `file-picker.ts` would get long; either is fine — say which in the Record.

3. Callers:
   - `OpenFileButton.tsx`: no `isBrowser`, no `<input>`, no `useRef`. `pickAndOpen` = `pickFilesToOpen()` →
     `viewer.openFiles(picked)`, inside the existing try/catch that calls `viewer.reportError(..., "file-dialog")`.
     The call to `pickFilesToOpen()` must be the first thing in the click path (see the gesture rule above).
     Add `data-testid="open-button"` to the button (`ToolbarButton` may need a `testId` prop; keep it minimal).
   - `useFileDrop.ts`: no `isBrowser` parameter; it calls `onFilesDroppedToOpen`. Keep the cancelled/unlisten handling
     and the error log on failure (better: `reportError` if it is easy to pass; otherwise keep `console.error` and note it).
   - `AppShell.tsx`: update the `useFileDrop` call.
   - `viewer.isBrowser` stays (settings pages and the download link use it). Only the open/drop paths stop using it.

4. E2E (`e2e/web-conversion.spec.ts`, `e2e/web-multi-conversion.spec.ts`): replace `getByTestId("file-input").setInputFiles(...)`
   with Playwright's file chooser:

   ```ts
   const chooserPromise = page.waitForEvent("filechooser");
   await page.getByTestId("open-button").click();
   const chooser = await chooserPromise;
   expect(chooser.isMultiple()).toBe(true);   // the multi spec checked the `multiple` attribute before; keep that check
   await chooser.setFiles(lasPath);
   ```

   Keep every other step and assertion. This now also covers "button → picker".

5. CLAUDE.md, the `data-testid` table: replace the `file-input` row with `open-button`
   (`src/ui/toolbar/buttons/OpenFileButton.tsx`, "開くボタン。E2E はこれを押して `filechooser` でファイルを渡す").
   Also update ADR-0016 if it names `file-input` / `setInputFiles` (append a short dated note in English; do not rewrite history).

## Acceptance criteria

1. `grep -rn "accept=\|\"e57\"\|\"ply\"" src` shows format lists only in `source-format.ts` (and tests). The extension list
   in `tauri.ts` is built, not written.
2. `grep -rn "isBrowser" src/ui/toolbar src/state/useFileDrop.ts` is empty.
3. Behaviour unchanged: same formats per platform, same error texts, multi-select still on, cancel does nothing and shows
   no error, drop still opens files and shows the dragging overlay.
4. `npx tsc --noEmit`, `npm run lint`, `npx vitest run`, and the Playwright E2E pass (`PCV_E2E_PORT` on a free port,
   run_in_background, stop only your processes; ADR-0016).
5. English comments; translate the comments of the functions you touch (useFileDrop.ts is Japanese now).
6. mdBook: update `docs/book/src/flows/open-file.md` and `frontend/ui-shell.md` (and any page naming `file-input`,
   `pickLocalFiles`, `useFileDrop`). Japanese.
7. Commits, one concern each, e.g.: `♻️ refactor: 開ける形式をプラットフォームごとに1か所にまとめる`,
   `♻️ refactor: ファイルの選択とドロップをデータソースの関数にまとめる`, `✅ test: E2E を開くボタンとファイル選択で駆動する`,
   `📝 docs(book): ...`, `📝 docs: ...` (CLAUDE.md table, ADR-0016 note, this sheet). Each ends with the Co-Authored-By line.

## Owner checks (agent cannot see the screen or run the desktop app)

- Web: 開く → the picker shows only .las/.laz/.pcd; choose two LAS → they merge as before; cancel → nothing happens.
  Drag a PLY onto the window → the same "Web版ではまだ変換できません" error.
- Desktop: 開く → the dialog filter lists las/laz/e57/ply/pcd with the same name as before; cancel → nothing.
  Drag and drop a file → it opens.

## Record (filled in by the implementer)

- Files touched: `src/datasource/source-format.ts` (+test), `src/datasource/file-picker.ts` (new), `src/datasource/tauri.ts`
  (dialog filter built by `openDialogFilters()`), `src/state/useFileOpen.ts`, `src/state/useFileDrop.ts`,
  `src/ui/shell/AppShell.tsx`, `src/ui/toolbar/ToolbarButton.tsx` (`testId` prop), `src/ui/toolbar/buttons/OpenFileButton.tsx`,
  `src/state/viewer-types.ts` (comment), `e2e/web-conversion.spec.ts`, `e2e/web-multi-conversion.spec.ts`, `CLAUDE.md`,
  `TaskSheets/ADR-0016-e2e-web-conversion.md` (note), `docs/book/src/{flows/open-file,frontend/datasource,frontend/ui-shell,frontend/state}.md`.
- Where the Web picker lives and whether the input had to be attached: in `src/datasource/file-picker.ts` itself
  (`pickFilesOnWeb`; the file is short, so no separate `web-file-picker.ts`). The input did NOT have to be attached
  to the document: the detached input produced Playwright's `filechooser` event in headless Chromium (E2E below).
  Real-browser behaviour of a detached input (e.g. Safari/Firefox, Android WebView) is not verified.
- Commands run and output (in the worktree):
  - `npx tsc --noEmit`: no output (pass). `npm run lint` (`eslint .`): no output (pass).
  - `npx vitest run`: `Test Files 63 passed (63)`, `Tests 560 passed (560)`.
  - `PCV_E2E_PORT=4391 npx playwright test`: `2 passed (8.6s)`, EXIT 0
    (`web-conversion.spec.ts` 2.9s, `web-multi-conversion.spec.ts` 3.5s, both via `open-button` + `filechooser`;
    the multi spec asserts `chooser.isMultiple()`).
  - `grep -rn "isBrowser" src/ui/toolbar src/state/useFileDrop.ts`: empty.
  - `grep -rn "accept=\|\"e57\"\|\"ply\"" src`: format lists only in `source-format.ts` and tests, plus a doc comment in
    `conversion-breakdown.ts` and `point-count-estimate.test.ts` (unrelated).
- Alternatives not taken and why:
  - A `Record<Platform, ...>` table: replaced by the owner's change above.
  - `OPENABLE_FORMATS` is ordered `lasLaz, e57, ply, pcd` (not the sheet's `lasLaz, pcd, ply, e57`) so the desktop dialog's
    extension order and display name stay byte-identical to before.
  - The Web check uses `NOT_YET_CONVERTIBLE_ON_WEB.includes(format)`, so `unknown` still goes to the LAS/LAZ route as before.
  - `useFileDrop` keeps `console.error` on subscription failure (the hook has no `reportError`); noted in a comment.
  - Not verified: desktop dialog and drop on a real Tauri app, Android, the cancel path in a real browser, drag overlay on screen.
