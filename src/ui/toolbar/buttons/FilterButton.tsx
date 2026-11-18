import { Filter } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudLayer } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  onOpen: () => void;
}

export function FilterButton({ viewer, onOpen }: Props) {
  const layer = selectedPointCloudLayer(viewer);
  return (
    <ToolbarButton
      icon={Filter}
      label="フィルタ"
      title={
        layer
          ? "選んだ点群レイヤーから、まわりに点が少ない点（外れ値）を除いた新しいレイヤーを作る"
          : "レイヤー欄で点群のレイヤーを選ぶと、フィルタできる"
      }
      disabled={!layer || isToolRunning(viewer)}
      onClick={onOpen}
      testId="filter-button"
    />
  );
}
