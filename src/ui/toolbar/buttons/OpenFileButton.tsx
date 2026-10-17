import { FolderOpen } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
// Rule 2: do not import the Tauri dialog package directly. Go through the data source
// (`pickFilesToOpen`, `src/datasource/file-picker.ts`), which picks the Web or desktop chooser.
import { pickFilesToOpen } from "../../../datasource/file-picker";
import { isFileOpenBusy, openButtonLabel } from "../../../state/viewer-status";
import { ToolbarButton } from "../ToolbarButton";

interface Props {
  viewer: CopcViewerState;
}

/**
 * ADR-0017: the "開く" button.
 *
 * **Files are opened only through the OS file dialog** (owner requirement: never make people
 * type a path). How the dialog is shown on each platform is the data source's concern
 * (`pickFilesToOpen`); this button is the same on every platform. Drag and drop is in `useFileDrop.ts`.
 * Owner decision (2026-10-14): the only load button is "開く"; the former "open from URL" and
 * "sample" buttons and `UrlDialog` were removed (L1-multi-layer.md).
 *
 * Every path is a thin call to `viewer.openFiles()`; do not add logic here.
 * `data-testid="open-button"` is required: the E2E specs press it and take the file chooser
 * (`filechooser` event) to hand over files (see CLAUDE.md).
 */
export function OpenFileButton({ viewer }: Props) {
  const busy = isFileOpenBusy(viewer.status);

  async function pickAndOpen() {
    try {
      // `pickFilesToOpen()` must stay the first call here: the Web chooser has to be opened
      // synchronously inside the click, before any `await`, or the browser blocks it.
      // M4-14: a multi-select dialog. Several LAS/LAZ files are merged into one COPC
      // (`viewer.openFiles`); one file behaves as before. Cancelling returns null/empty: do nothing.
      const picked = await pickFilesToOpen();
      if (picked && picked.length > 0) await viewer.openFiles(picked);
    } catch (e) {
      // Never drop the error (ADR-0015): show it in the existing banner and log (ADR-0011).
      const message = e instanceof Error ? e.message : String(e);
      viewer.reportError(`ファイルを選ぶダイアログを開けませんでした: ${message}`, "file-dialog");
    }
  }

  return (
    <ToolbarButton
      icon={FolderOpen}
      label={openButtonLabel(viewer.status)}
      title="ファイルを開く"
      primary
      disabled={busy}
      testId="open-button"
      onClick={() => void pickAndOpen()}
    />
  );
}
