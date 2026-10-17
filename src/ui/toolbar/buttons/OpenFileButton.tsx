import { useRef } from "react";
import { FolderOpen } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
// Rule 2: do not import the Tauri dialog package directly. Go through the DataSource function
// (`pickLocalFiles`, multi-select since M4-14); see `src/datasource/tauri.ts`.
import { pickLocalFiles } from "../../../datasource/tauri";
import { isFileOpenBusy, openButtonLabel } from "../../../state/viewer-status";
import { ToolbarButton } from "../ToolbarButton";

interface Props {
  viewer: CopcViewerState;
}

/**
 * ADR-0017: the "開く" button.
 *
 * **Files are opened only through the OS file dialog** (owner requirement: never make people
 * type a path). Both platforms render the same `ToolbarButton`; only how files are picked differs:
 * the Web build clicks a hidden `<input type="file">`, desktop and Android use the Tauri dialog
 * (`pickLocalFiles`). Drag and drop is in `useFileDrop.ts`.
 * Owner decision (2026-10-14): the only load button is "開く"; the former "open from URL" and
 * "sample" buttons and `UrlDialog` were removed (L1-multi-layer.md).
 *
 * Every path is a thin call to `viewer.openFiles()`; do not add logic here.
 * `data-testid="file-input"` is required: `e2e/web-conversion.spec.ts` drives it with
 * `setInputFiles` (see CLAUDE.md).
 */
export function OpenFileButton({ viewer }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = isFileOpenBusy(viewer.status);

  async function pickAndOpen() {
    if (viewer.isBrowser) {
      // The browser's own picker; the input's onChange opens the chosen files.
      inputRef.current?.click();
      return;
    }
    try {
      // M4-14: a multi-select dialog. Several LAS/LAZ files are merged into one COPC
      // (`viewer.openFiles`); one file behaves as before. Cancelling returns null/empty: do nothing.
      const picked = await pickLocalFiles();
      if (picked && picked.length > 0) await viewer.openFiles(picked);
    } catch (e) {
      // Never drop the error (ADR-0015): show it in the existing banner and log (ADR-0011).
      const message = e instanceof Error ? e.message : String(e);
      viewer.reportError(`ファイルを選ぶダイアログを開けませんでした: ${message}`, "file-dialog");
    }
  }

  return (
    <>
      <ToolbarButton
        icon={FolderOpen}
        label={openButtonLabel(viewer.status)}
        title="ファイルを開く"
        primary
        disabled={busy}
        onClick={() => void pickAndOpen()}
      />
      {viewer.isBrowser && (
        <input
          type="file"
          // M4-3/M4-6b/M4-9: raw LAS/LAZ and PCD can be chosen too (the Web build converts them
          // to COPC directly on OPFS; see `openFile` in `useCopcViewer.ts`).
          accept=".las,.laz,.pcd"
          // E2E (`e2e/web-conversion.spec.ts`) drives the file choice through this data-testid
          // with `setInputFiles`.
          data-testid="file-input"
          // M4-14: multiple files can be chosen (`viewer.openFiles`; one file behaves as before).
          multiple
          onChange={(e) => {
            const files = e.target.files;
            if (files && files.length > 0) void viewer.openFiles(Array.from(files));
            e.target.value = "";
          }}
          disabled={busy}
          // The button is the control; keep the input out of the Tab order and the accessibility tree.
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
        />
      )}
    </>
  );
}
