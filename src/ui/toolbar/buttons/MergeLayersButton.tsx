import { Layers } from "lucide-react";
import { mergeSelectedLayers } from "../../../app/point-cloud-tools";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudCount } from "../toolbar-state";

/**
 * L2-F / ADR-0018: "合成". Merges the point-cloud layers selected with Ctrl/Shift click
 * in the layer list into one new layer (the source layers are not rewritten).
 *
 * Disabled unless two or more point-cloud layers are selected, or while a tool is computing.
 * The tooltip tells which of the two cases applies.
 */
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
