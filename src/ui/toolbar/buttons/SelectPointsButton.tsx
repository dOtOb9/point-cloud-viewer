import { MousePointerClick } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import type { LayerToolState } from "../../../state/useLayerTool";
import { ToolbarButton } from "../ToolbarButton";
import { hasPointCloud, isToolRunning } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  layerTool: LayerToolState;
}

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
