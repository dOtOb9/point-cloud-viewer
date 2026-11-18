import { Layers } from "lucide-react";
import { mergeSelectedLayers } from "../../../app/point-cloud-tools";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudCount } from "../toolbar-state";

export function MergeLayersButton({ viewer }: { viewer: CopcViewerState }) {
  const count = selectedPointCloudCount(viewer);
  return (
    <ToolbarButton
      icon={Layers}
      label="合成"
      title={
        count >= 2
          ? `選んだ${count}つの点群レイヤーを1つに合成した新しいレイヤーを作る`
          : "レイヤー欄で Ctrl か Shift を押しながら2つ以上の点群レイヤーを選ぶと、合成できる"
      }
      disabled={count < 2 || isToolRunning(viewer)}
      onClick={() => void mergeSelectedLayers(viewer.toolContext)}
    />
  );
}
