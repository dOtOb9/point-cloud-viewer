# R4: OpenFileButton uses ToolbarButton on every platform

Owner decision (2026-10-17), follow-up to [R3](./R3-toolbar-buttons.md).

## Problem

`src/ui/toolbar/buttons/OpenFileButton.tsx` has two different widget trees:

- Web: a `<label>` that copies `TOOLBAR_BUTTON_CLASS` / `TOOLBAR_BUTTON_PRIMARY_CLASS` and wraps a hidden
  `<input type="file">`. Its disabled look (`opacity-40`, no grey background) differs from `ToolbarButton`'s
  `disabled:` style, and it never shows "開いています…" / "変換中…".
- Desktop/Android: `ToolbarButton` with `onClick={() => { void (async () => { ... void viewer.openFiles(...) })(); }}`.
  If `pickLocalFiles()` rejects, the error is dropped (an unhandled rejection), which breaks ADR-0015
  ("never drop an error silently; show it in the ADR-0011 banner and log").

The only real difference between the platforms is **how files are picked**, so only that should branch.

## Target

```tsx
export function OpenFileButton({ viewer }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = ...;

  async function pickAndOpen() {
    if (viewer.isBrowser) {
      inputRef.current?.click();          // the browser's picker; the input's onChange opens the files
      return;
    }
    try {
      const picked = await pickLocalFiles();
      if (picked && picked.length > 0) await viewer.openFiles(picked);
    } catch (e) {
      viewer.reportError(`ファイルを選ぶダイアログを開けませんでした: ${message of e}`);
    }
  }

  return (
    <>
      <ToolbarButton icon={FolderOpen} label={...same status label on both platforms...} primary
        disabled={busy} onClick={() => void pickAndOpen()} />
      {viewer.isBrowser && <input ref={inputRef} type="file" data-testid="file-input" className="sr-only" ... />}
    </>
  );
}
```

Plain function inside the component; no new hook or abstraction.

## Acceptance criteria

1. Both platforms render `ToolbarButton`; `OpenFileButton.tsx` no longer imports `TOOLBAR_BUTTON_CLASS` /
   `TOOLBAR_BUTTON_PRIMARY_CLASS`. If nothing else uses an import, remove the export only if unused everywhere.
2. The status label ("開いています…" / "変換中…" / "開く") is the same on Web and desktop.
3. The hidden `<input type="file">` keeps exactly: `accept=".las,.laz,.pcd"`, `multiple`, `data-testid="file-input"`,
   `disabled={busy}`, the `onChange` that calls `viewer.openFiles(Array.from(files))` and resets `e.target.value = ""`.
   It must stay in the DOM whenever `viewer.isBrowser` (E2E waits for it with `toBeAttached` and uses `setInputFiles`).
   It must not be reachable by Tab (`tabIndex={-1}`) and should be `aria-hidden`, since the button is the control.
   Do not change the `accept` lists (Web and desktop differ on purpose / unverified; out of scope).
4. Errors: `reportError` (from `useErrorLog`, ADR-0011) is not on `CopcViewerState` today. Expose it
   (`reportError: errorLog.reportError` in the object `useCopcViewer` returns, with its type). Check `GpuErrorSource`
   in `src/renderer/gpu-error-log.ts` and how the banner/log display a source; use the existing source that fits, or add
   one only if the banner needs it to label the entry correctly — write which and why in the Record.
   Also check whether `viewer.openFiles` already catches its own errors; if it does, do not report them twice.
5. Unit test: add a small vitest test for the desktop path's error handling if it can be done without a big harness
   (e.g. extract nothing; if testing needs heavy mocking of the Tauri module, skip and say so in the Record).
6. English comments in touched code; keep the "rule 2" comment (without writing the Tauri package name).
7. `npx tsc --noEmit`, `npm run lint`, `npx vitest run` pass. **Also run the Playwright E2E** for the Web file input
   (`e2e/web-conversion.spec.ts` and `e2e/web-multi-conversion.spec.ts`; read ADR-0016 and `playwright.config.ts`
   first, set `PCV_E2E_PORT` to a free port, run it with `run_in_background`, and stop only the processes you started).
   If E2E cannot run in this environment (e.g. no WebGPU), say so and paste the error.
8. Update the mdBook page(s) that describe the open button (`docs/book/src/flows/open-file.md`, `frontend/ui-shell.md`)
   if they describe the label/input structure. Japanese.
9. Commits: `♻️ refactor: ...` (code), `📝 docs(book): ...`, `📝 docs: ...` (this sheet), each ending with the Co-Authored-By line.

## Owner checks (not verifiable by the agent)

- Web (`npm run dev` in a browser): 開く opens the file picker; while converting the button shows 変換中… and looks disabled
  like the other disabled buttons.
- Desktop: 開く opens the OS dialog; cancelling the dialog does nothing and shows no error.

## Record (filled in by the implementer)

- Files touched: `src/ui/toolbar/buttons/OpenFileButton.tsx`, `src/state/useCopcViewer.ts` and `src/state/viewer-types.ts`
  (expose `reportError`), `src/renderer/gpu-error-log.ts` (new source `"file-dialog"`), `src/ui/dialogs/ErrorDialog.tsx`
  (label for it), `docs/book/src/flows/open-file.md`, `docs/book/src/frontend/ui-shell.md`.
- Commands run and output (all in the worktree):
  - `npx tsc --noEmit` -> no output, exit 0.
  - `npm run lint` -> `eslint .`, no output, exit 0.
  - `npx vitest run` -> `Test Files 62 passed (62)`, `Tests 553 passed (553)`.
  - `PCV_E2E_PORT=4527 npx playwright test` (background; port 4527 was free) -> `2 passed (8.6s)`:
    `web-conversion.spec.ts` and `web-multi-conversion.spec.ts`, run after the final edit of `OpenFileButton.tsx`.
    The E2E drives the hidden input with `setInputFiles`; it never clicks the button, so the button -> `input.click()`
    path is not covered by it.
- Error source chosen and why: added a new source `"file-dialog"` (label "ファイル選択ダイアログのエラー" in `ErrorDialog.tsx`).
  The existing ones (`gpu`, `node-read`, `conversion`, `crs`, `tool`) would mislabel a failure to open the OS dialog
  (`tool` shows as "点群ツール"). Only the `Record` label map in `ErrorDialog.tsx` needed the new key.
  `viewer.openFiles` (and `openFile`, which it delegates to) already wrap their work in `try/catch` in `useFileOpen.ts`
  and set status/`setError`, so errors from opening are not reported again by the button; the button's `catch` only
  covers `pickLocalFiles()` and anything that escapes `openFiles`.
- Unit test: skipped. The repo has no component-testing library (no testing-library); testing the desktop path would need
  mocking the datasource module and rendering React, which is not a small harness. The error path has no automated test.
- Alternatives not taken: reusing source `"tool"` or `"gpu"` (wrong label); keeping the Web `<label>` (different disabled
  look, no status label).
- Not verified: the real desktop dialog (cancel does nothing, a dialog failure appears in the banner), and the Web
  button's look while converting.
