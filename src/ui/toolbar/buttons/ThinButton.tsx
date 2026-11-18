import { Rows3 } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudLayer } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  onOpen: () => void;
}

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
