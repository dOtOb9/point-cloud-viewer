import { Filter } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudLayer } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  /** Opens the filter dialog (`FilterDialog`, mounted by AppShell). */
  onOpen: () => void;
}

/**
 * G3 / ADR-0018: "フィルタ". Makes a new layer without the outliers (ROR or SOR) from the selected point-cloud layer; the
 * source layer is hidden when it worked, never rewritten.
 *
 * Disabled unless a point-cloud layer is selected, or while a tool is computing. The tooltip tells which case applies.
 */
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
