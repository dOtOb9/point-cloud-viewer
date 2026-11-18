import { FolderOpen } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { openFiles } from "../../../app/open-files";
import { pickFilesToOpen } from "../../../datasource/file-picker";
import { isFileOpenBusy, openButtonLabel } from "../../../state/viewer-status";
import { ToolbarButton } from "../ToolbarButton";

interface Props {
  viewer: CopcViewerState;
}

export function OpenFileButton({ viewer }: Props) {
  const busy = isFileOpenBusy(viewer.status);

  async function pickAndOpen() {
    try {
      const picked = await pickFilesToOpen();
      if (picked && picked.length > 0) await openFiles(viewer.fileOpenContext, picked);
    } catch (e) {
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
