import { Hexagon, Layers, MousePointerClick, MoveVertical, Ruler, Slice, type LucideIcon } from "lucide-react";
import type { MeasureKind } from "../../../state/measure";
import type { MeasureToolState } from "../../../state/useMeasureTool";
import type { LayerToolState } from "../../../state/useLayerTool";
import { ToolbarButton } from "../ToolbarButton";
import { TOOLBAR_GROUP_CLASS, TOOLBAR_GROUP_LABEL_CLASS } from "../toolbar-styles";

/** Measurement is split into three buttons: distance, height, area (owner decision: split the buttons once implemented). */
const MEASURE_TOOLS: { kind: MeasureKind; icon: LucideIcon; label: string; title: string }[] = [
  { kind: "distance", icon: Ruler, label: "距離", title: "2点をクリックして距離を測る（結果は計測レイヤーになる）" },
  { kind: "height", icon: MoveVertical, label: "高さ", title: "2点をクリックして高さの差を測る（結果は計測レイヤーになる）" },
  { kind: "area", icon: Hexagon, label: "面積", title: "頂点をクリックして面積を測る。ダブルクリックか Enter で閉じる（結果は計測レイヤーになる）" },
];

interface Props {
  measure: MeasureToolState;
  /** L2-F: "点の選択" and "断面" (they draw on the 3D view, like the measurement tools). */
  layerTool: LayerToolState;
  hasPointCloud: boolean;
  /** L2-F: how many point-cloud layers are selected together (Ctrl/Shift click in the layer list). */
  selectedPointCloudCount: number;
  onMerge: () => void;
  /** A point-cloud tool is running (the buttons wait for it to finish). */
  toolRunning: boolean;
}

/**
 * ADR-0017 (UI shell rebuild): the "Tools" group of the top toolbar.
 *
 * ADR-0018: every tool here is "an operation on the chosen layer whose result is a new layer"
 * (the source layer is never rewritten); the tooltips say it that way.
 *
 * L2-D: measurement (distance, height, area). L2-F: "点の選択" (polygon on the screen), "断面" (a line
 * between two points, then thickness and height range) and "複数レイヤー" (merge the layers selected
 * with Ctrl/Shift click; disabled unless two or more point-cloud layers are selected).
 * Pressing a tool button starts the tool and the active button gets an underline. Press again or Esc to stop.
 * The buttons are disabled when there is no point cloud (nothing to work on).
 */
export function ToolbarToolsGroup({ measure, layerTool, hasPointCloud, selectedPointCloudCount, onMerge, toolRunning }: Props) {
  return (
    <div className={TOOLBAR_GROUP_CLASS}>
      <span className={TOOLBAR_GROUP_LABEL_CLASS}>ツール</span>
      <div className="flex flex-nowrap items-center gap-1">
        {MEASURE_TOOLS.map((tool) => (
          <ToolbarButton
            key={tool.kind}
            icon={tool.icon}
            label={tool.label}
            title={tool.title}
            active={measure.mode === tool.kind}
            disabled={!hasPointCloud && measure.mode !== tool.kind}
            onClick={() => measure.toggle(tool.kind)}
          />
        ))}
        <ToolbarButton
          icon={MousePointerClick}
          label="点の選択"
          title="画面に多角形を描き、選んだレイヤーの中で多角形に映る点を新しいレイヤーにする（クリックで頂点、ダブルクリックか Enter で閉じる、Esc でやめる）"
          active={layerTool.mode === "select"}
          disabled={(!hasPointCloud && layerTool.mode !== "select") || toolRunning}
          onClick={() => layerTool.toggle("select")}
        />
        <ToolbarButton
          icon={Slice}
          label="断面"
          title="点群の上の2点をクリックして線を引き、その線に沿った板の中の点を新しいレイヤーにする"
          active={layerTool.mode === "section"}
          disabled={(!hasPointCloud && layerTool.mode !== "section") || toolRunning}
          onClick={() => layerTool.toggle("section")}
        />
        <ToolbarButton
          icon={Layers}
          label="複数レイヤー"
          title={
            selectedPointCloudCount >= 2
              ? `選んだ${selectedPointCloudCount}つの点群レイヤーを1つに結合した新しいレイヤーを作る`
              : "レイヤー欄で Ctrl か Shift を押しながら2つ以上の点群レイヤーを選ぶと、結合できる"
          }
          disabled={selectedPointCloudCount < 2 || toolRunning}
          onClick={onMerge}
        />
      </div>
    </div>
  );
}
