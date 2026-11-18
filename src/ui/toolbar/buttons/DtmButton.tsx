import { Mountain } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudLayer } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  onOpen: () => void;
}

export function DtmButton({ viewer, onOpen }: Props) {
  const layer = selectedPointCloudLayer(viewer);
  return (
    <ToolbarButton
      icon={Mountain}
      label="DTM"
      title={
        layer
          ? "選んだ点群レイヤーの地表を判定した新しいレイヤーと、地表の標高モデル（DTM）のファイルを作る"
          : "レイヤー欄で点群のレイヤーを選ぶと、DTM を作れる"
      }
      disabled={!layer || isToolRunning(viewer)}
      onClick={onOpen}
      testId="dtm-button"
    />
  );
}
