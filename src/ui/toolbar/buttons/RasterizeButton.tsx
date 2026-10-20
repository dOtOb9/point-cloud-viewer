import { Grid3x3 } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudLayer } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  /** Opens the rasterize dialog (`RasterDialog`, mounted by AppShell). */
  onOpen: () => void;
}

/**
 * G1 / ADR-0018: "ラスタ化". Opens a dialog (cell size, value, classes); the chosen point-cloud layer becomes a GeoTIFF
 * and a new layer with one point per cell (the source layer is not rewritten, only hidden).
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
          ? "選んだ点群レイヤーを、セルごとの値（高さ・点数・強度・色）のラスタにする。GeoTIFF と、確認用の新しいレイヤーができる"
          : "レイヤー欄で点群のレイヤーを選ぶと、ラスタ化できる"
      }
      disabled={!layer || isToolRunning(viewer)}
      onClick={onOpen}
    />
  );
}
