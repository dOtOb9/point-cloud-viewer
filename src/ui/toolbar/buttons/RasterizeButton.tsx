import { Grid3x3 } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudLayer } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  onOpen: () => void;
}

export function RasterizeButton({ viewer, onOpen }: Props) {
  const layer = selectedPointCloudLayer(viewer);
  return (
    <ToolbarButton
      icon={Grid3x3}
      label="ラスタ化"
      title={
        layer
          ? "選んだ点群レイヤーを、セルごとの値（色・高さ・点数・強度）のラスタ画像（GeoTIFF）にする。ウィンドウでプレビューを見ながら設定できる"
          : "レイヤー欄で点群のレイヤーを選ぶと、ラスタ化できる"
      }
      disabled={!layer || isToolRunning(viewer)}
      onClick={onOpen}
    />
  );
}
