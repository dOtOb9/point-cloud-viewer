import { Slice } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import type { LayerToolState } from "../../../state/useLayerTool";
import { ToolbarButton } from "../ToolbarButton";
import { hasPointCloud, isToolRunning } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  layerTool: LayerToolState;
}

/**
 * L2-F / ADR-0018: "断面". Click two points to draw a line, then set the thickness and height
 * range; the points inside that slab become a new layer (the source layer is not rewritten).
 *
 * - Active while the section tool is running.
 * - Disabled when there is no point cloud (unless the tool is already running, so it can be
 *   stopped) or while another point-cloud tool is computing.
 */
export function SectionButton({ viewer, layerTool }: Props) {
  const active = layerTool.mode === "section";
  return (
    <ToolbarButton
      icon={Slice}
      label="断面"
      title="点群の上の2点をクリックして線を引き、その線に沿った板の中の点を新しいレイヤーにする"
      active={active}
      disabled={(!hasPointCloud(viewer) && !active) || isToolRunning(viewer)}
      onClick={() => layerTool.toggle("section")}
    />
  );
}
