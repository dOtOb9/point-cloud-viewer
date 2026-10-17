import { FolderOpen } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
// Rule 2: do not import the Tauri dialog package directly. Go through the DataSource function
// (`pickLocalFiles`, multi-select since M4-14); see `src/datasource/tauri.ts`.
import { pickLocalFiles } from "../../../datasource/tauri";
import { ToolbarButton } from "../ToolbarButton";
import { TOOLBAR_BUTTON_CLASS, TOOLBAR_BUTTON_PRIMARY_CLASS } from "../toolbar-styles";

interface Props {
  viewer: CopcViewerState;
}

/**
 * ADR-0017: the "開く" button.
 *
 * **Files are opened only through the OS file dialog** (owner requirement: never make people
 * type a path). The Web build uses a hidden `<input type="file">`; desktop and Android use the
 * Tauri dialog (`pickLocalFiles`). Drag and drop is in `useFileDrop.ts`.
 * Owner decision (2026-10-14): the only load button is "開く"; the former "open from URL" and
 * "sample" buttons and `UrlDialog` were removed (L1-multi-layer.md).
 *
 * Every path is a thin call to `viewer.openFiles()`; do not add logic here.
 * `data-testid="file-input"` is required: `e2e/web-conversion.spec.ts` drives it with
 * `setInputFiles` (see CLAUDE.md).
 */
export function OpenFileButton({ viewer }: Props) {
  const busy = viewer.status === "opening" || viewer.status === "converting";

  if (viewer.isBrowser) {
    // The hidden <input> is wrapped in a label that looks like a toolbar button (icon + label).
    return (
      <label
        className={`${TOOLBAR_BUTTON_CLASS} ${TOOLBAR_BUTTON_PRIMARY_CLASS} cursor-pointer ${busy ? "pointer-events-none opacity-40" : ""}`}
        title="ファイルを開く"
      >
        <FolderOpen size={20} aria-hidden="true" />
        <span>開く</span>
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
          className="sr-only"
        />
      </label>
    );
  }

  return (
    <ToolbarButton
      icon={FolderOpen}
      label={viewer.status === "opening" ? "開いています…" : viewer.status === "converting" ? "変換中…" : "開く"}
      primary
      disabled={busy}
      onClick={() => {
        void (async () => {
          // M4-14: a multi-select dialog. Several LAS/LAZ files are merged into one COPC
          // (`viewer.openFiles`); one file behaves as before.
          const picked = await pickLocalFiles();
          if (picked && picked.length > 0) void viewer.openFiles(picked);
        })();
      }}
    />
  );
}
