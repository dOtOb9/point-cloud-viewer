import { Mountain } from "lucide-react";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { isToolRunning, selectedPointCloudLayer } from "../toolbar-state";

interface Props {
  viewer: CopcViewerState;
  /** Opens the DTM dialog (`DtmDialog`, mounted by AppShell). */
  onOpen: () => void;
}

/**
 * G1-T15 / ADR-0018: "DTM". Classifies the ground of the selected point-cloud layer with CSF into a new layer ("地表 - name"),
 * and makes the DTM files (GeoTIFF and/or LandXML, chosen in the settings). The source layer is hidden when it worked,
 * never rewritten.
 *
 * Disabled unless a point-cloud layer is selected, or while a tool is computing. The tooltip tells which case applies.
 */
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
