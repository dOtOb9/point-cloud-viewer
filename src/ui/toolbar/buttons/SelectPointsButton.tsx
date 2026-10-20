import { MousePointerClick } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import type { LayerToolState } from "../../../state/useLayerTool";
import { ToolbarButton } from "../ToolbarButton";
import { hasPointCloud, isToolRunning } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  layerTool: LayerToolState;
}

/**
 * L2-F / ADR-0018: "カット". Draw a polygon on the screen; the points of the chosen layer that
 * fall inside it become a new layer (the source layer is not rewritten).
 *
 * - Active while the select tool is running.
 * - Disabled when there is no point cloud (unless the tool is already running, so it can be
 *   stopped) or while another point-cloud tool is computing.
 */
export function SelectPointsButton({ viewer, layerTool }: Props) {
  const active = layerTool.mode === "select";
  return (
    <ToolbarButton
      icon={MousePointerClick}
      label="カット"
      title="画面に多角形を描き、選んだレイヤーの中で多角形に映る点を新しいレイヤーにする（クリックで頂点、ダブルクリックか Enter で閉じる、Esc でやめる）"
      active={active}
      disabled={(!hasPointCloud(viewer) && !active) || isToolRunning(viewer)}
      onClick={() => layerTool.toggle("select")}
    />
  );
}
