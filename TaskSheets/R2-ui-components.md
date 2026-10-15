# R2: UI components split by role

Pure refactoring of `src/ui/`. No behavior or look change. Done so the owner can read the UI
before starting their own larger refactoring.

## What was done

`src/ui/shell/` held 37 files of every kind. It is now split into folders by role, and the big
files are split so that one file holds one visual part (small private helpers stay next to the
part that uses them).

| Folder | Files | Role |
|---|---|---|
| `shell/` | `AppShell.tsx`, `ViewerPanel.tsx`, `UnsupportedDeviceScreen.tsx` | Whole-screen assembly. `AppShell` calls the state hooks once and hands props down. Start reading here. |
| `ribbon/` | `Ribbon.tsx`, `RibbonButton.tsx`, `RibbonFileGroup.tsx`, `RibbonToolsGroup.tsx`, `RibbonSettingsGroup.tsx`, `ribbon-styles.ts`, `ribbon-drag.ts`, `useRibbonDragScroll.ts` | Top ribbon: the three groups, the button, the shared class strings, drag-to-scroll. |
| `layers/` | `LayerPanel.tsx`, `LayerList.tsx`, `LayerContextMenu.tsx`, `LayerActions.tsx`, `LayerInfoSection.tsx`, `ConversionBreakdownPanel.tsx`, `LayerStatsDetails.tsx`, `layer-delete-key.ts` | Left layer panel: list, right-click menu, action buttons, info, conversion breakdown, stats. |
| `dialogs/` | `Dialog.tsx`, `dialog-styles.ts`, `CloseButton.tsx`, `OptionRow.tsx`, `ColorModeDialog.tsx`, `AppearanceDialog.tsx`, `ConversionDialog.tsx`, `ErrorDialog.tsx` | The shared dialog frame, its footer button styles, two small shared parts, and the dialogs that are not about settings or tools. |
| `settings/` | `SettingsModal.tsx`, `SettingsPageDialog.tsx`, `settings-nav.ts`, `pages/*.tsx` | Settings list (modal with icon buttons), the shared page frame (title + "back" footer), and one file per page (`ThemeDialog`, `AnimationDialog`, `BackgroundDialog`, `PointBudgetDialog`, `RenderScaleDialog`, `UpdateDialog`, `TempDirDialog`, `StorageDialog`, `LoadPriorityDialog`, `EdlDialog`, `UnitDialog`). |
| `tools/` | `MeasureOverlay.tsx`, `MeasurementShape.tsx`, `measure-frame.ts`, `MeasureHud.tsx`, `LayerToolOverlay.tsx`, `SectionDialog.tsx`, `ToolProgressDialog.tsx` | Things drawn over the 3D view or opened by the measure / point-pick / cross-section tools. |
| `status/` | `StatusBar.tsx`, `UpdateNotice.tsx` | Bottom status bar and the "new version" notice. |
| `common/` | `glass.ts`, `crs-format.ts`, `useTransitionMount.ts` | Small parts used by more than one folder. |

Tests moved with their parts (`*.test.ts(x)` sit next to the file they test). `ViewDialogs.test.tsx`
became `dialogs/LayerViewDialogs.test.tsx` and `SettingsPages.test.tsx` became `settings/pages.test.tsx`,
because the files they were named after no longer exist.

Class-string files: `ribbon-styles.ts` is used by ribbon files and by `SettingsModal`, so it stays in
`ribbon/`. `dialog-styles.ts` stays in `dialogs/` and is imported by settings and tools. `glass.ts` is used
by almost every folder, so it is in `common/`.

## What changed besides moving

- `ViewDialogs.tsx` -> `ColorModeDialog.tsx` + `AppearanceDialog.tsx` + shared `CloseButton.tsx` + `OptionRow.tsx`.
- `SettingsPages.tsx` (468 lines) -> `SettingsPageDialog.tsx` (shared frame, `PageProps`) + `pages/*.tsx`.
  The settings page had its own copy of `OptionRow` ("same look as ViewDialogs"). Both now use `dialogs/OptionRow.tsx`;
  the class strings were identical (the old settings copy just had no `disabled` option).
- `MeasureOverlay.tsx` -> `MeasureOverlay.tsx` (the SVG layer and per-frame polling), `MeasurementShape.tsx`,
  `MeasureHud.tsx`, and `measure-frame.ts` (the `Frame` type and two helpers; a `.ts` file because the
  react-refresh lint rule warns when a component file also exports non-components).
- `ToolDialogs.tsx` -> `SectionDialog.tsx` + `ToolProgressDialog.tsx`.
- `LayerList.tsx` -> `LayerList.tsx` + `LayerContextMenu.tsx`; `LayerInfoSection.tsx` -> + `ConversionBreakdownPanel.tsx`.
- `ColorModeDialog` and `AppearanceDialog` each keep their own 4-line `DialogProps` interface instead of sharing one:
  a shared type file for four lines is more indirection than it saves.
- `viewer` is still passed whole as props. Passing only the needed values is left to the owner's refactoring
  (it would conflict with R1, which splits `useCopcViewer.ts`).

## Alternatives not taken

- Per-folder `README.md` files: not written. Each part file already starts with a comment saying what it is, and
  this document is the list. A README per folder would be a third copy to keep in sync.
- `index.ts` barrel files per folder: not added. They hide where a component lives and the owner wants to follow imports.
- Putting `ToolProgressDialog`/`SectionDialog` in `dialogs/`: not done. They are only meaningful with the tools, and
  `dialogs/` is for dialogs not tied to one feature.
- Putting `UpdateNotice` in `shell/`: it is a status-like notice, so it sits in `status/`.

## Files touched outside `src/ui/`

- `CLAUDE.md`: the "location" column of the `data-testid` table. `data-testid` values are unchanged.
  `conversion-breakdown` is now in `src/ui/layers/ConversionBreakdownPanel.tsx`; the others moved folders.
- `docs/book/src/frontend/ui-shell.md`, `docs/book/src/SUMMARY.md`: links and the title now point to the new paths.
- `TaskSheets/ARCHITECTURE.md`: the UI part of the directory tree (the `Dock` line was stale; no Dock file exists).
- `src/App.tsx`: comment paths.
- Not touched (outside this task's area): comments in `src/datasource`, `src/renderer`, `src/state` that still name old
  paths (`src/ui/shell/LayerPanel.tsx`, `src/ui/ViewerPanel.tsx`, `src/ui/shell/GpuErrorBanner.tsx`; the last one
  does not exist any more). They are only comments.

The moves were done with a small script that rewrote relative imports and then ran `git mv`
(so history follows the files), one folder per commit.

## How the owner can check

1. `npx tsc --noEmit`, `npm run lint`, `npx vitest run`.
2. `PCV_E2E_PORT=<free port> npx playwright test` (the four testids are covered by the web conversion tests).
3. Open the app, load a COPC file, and look at: the ribbon, the layer panel, the color dialog, the settings list,
   one settings page. They should look as before.
