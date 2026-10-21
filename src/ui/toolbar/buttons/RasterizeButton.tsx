import { Grid3x3 } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudLayer } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  /** Opens the rasterize window (`RasterWindow`, mounted by AppShell). */
  onOpen: () => void;
}

/**
 * G1 / ADR-0018: "ラスタ化". Opens a window with a live preview (value, classes, cell size, kind of TIFF); "書き出す" makes a GeoTIFF of the chosen point-cloud layer.
 * The result is not a layer, and the source layer is not changed or hidden.
 *
 * Disabled unless a point-cloud layer is selected, or while a tool is computing. The tooltip tells which case applies.
 */
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
