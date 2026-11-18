import { Slice } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import type { LayerToolState } from "../../../state/useLayerTool";
import { ToolbarButton } from "../ToolbarButton";
import { hasPointCloud, isToolRunning } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  layerTool: LayerToolState;
}

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
