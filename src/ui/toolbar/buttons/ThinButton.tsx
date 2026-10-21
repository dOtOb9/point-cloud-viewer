import { Rows3 } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudLayer } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  /** Opens the thinning dialog (`ThinDialog`, mounted by AppShell). */
  onOpen: () => void;
}

/**
 * G3 / ADR-0018: "間引き". Makes a new layer with fewer points (one original point per grid cell or voxel) from the selected
 * point-cloud layer; the source layer is hidden when it worked, never rewritten.
 *
 * Disabled unless a point-cloud layer is selected, or while a tool is computing. The tooltip tells which case applies.
 */
export function ThinButton({ viewer, onOpen }: Props) {
  const layer = selectedPointCloudLayer(viewer);
  return (
    <ToolbarButton
      icon={Rows3}
      label="間引き"
      title={
        layer
          ? "選んだ点群レイヤーの点を、グリッドまたはボクセルごとに1点へ減らした新しいレイヤーを作る"
          : "レイヤー欄で点群のレイヤーを選ぶと、間引きできる"
      }
      disabled={!layer || isToolRunning(viewer)}
      onClick={onOpen}
      testId="thin-button"
    />
  );
}
