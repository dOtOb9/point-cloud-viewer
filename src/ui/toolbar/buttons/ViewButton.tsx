import { Eye } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { hasPointCloud } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  /** Opens the view dialog (`ViewDialog`, mounted by AppShell). */
  onOpen: () => void;
}

/**
 * TP-1: "視点". Opens the dialog to fit all, go to a fixed viewpoint (top, front, ...) and switch the projection.
 * Disabled while there is no point-cloud layer. The tooltip lists the keys (UX-4).
 */
export function ViewButton({ viewer, onOpen }: Props) {
  const enabled = hasPointCloud(viewer);
  return (
    <ToolbarButton
      icon={Eye}
      label="視点"
      title={
        enabled
          ? "視点を変える（F: 全体 / 1: 上 / 2: 正面 / 3: 右 / 4: 等角 / 5: 透視・平行の切り替え）"
          : "点群を開くと、視点を変えられる"
      }
      disabled={!enabled}
      onClick={onOpen}
      testId="view-button"
    />
  );
}
