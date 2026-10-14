import { Hexagon, Layers, MousePointerClick, MoveVertical, Ruler, Slice, type LucideIcon } from "lucide-react";
import type { MeasureKind } from "../../state/measure";
import type { MeasureToolState } from "../../state/useMeasureTool";
import { RibbonButton } from "./RibbonButton";
import { RIBBON_GROUP_CLASS, RIBBON_GROUP_LABEL_CLASS } from "./ribbon-styles";

/** Tools not implemented yet (as specified in the task sheet). */
const UNIMPLEMENTED_TOOLS: { icon: LucideIcon; label: string; title: string }[] = [
  { icon: Slice, label: "断面", title: "選択中のレイヤーから断面レイヤーを作る（未実装）" },
  { icon: MousePointerClick, label: "点の選択", title: "選択中のレイヤーから選んだ点のレイヤーを作る（未実装）" },
  { icon: Layers, label: "複数レイヤー", title: "選択中の複数のレイヤーから結合レイヤーを作る（未実装）" },
];

/** Measurement is split into three buttons: distance, height, area (owner decision: split the buttons once implemented). */
const MEASURE_TOOLS: { kind: MeasureKind; icon: LucideIcon; label: string; title: string }[] = [
  { kind: "distance", icon: Ruler, label: "距離", title: "2点をクリックして距離を測る（結果は計測レイヤーになる）" },
  { kind: "height", icon: MoveVertical, label: "高さ", title: "2点をクリックして高さの差を測る（結果は計測レイヤーになる）" },
  { kind: "area", icon: Hexagon, label: "面積", title: "頂点をクリックして面積を測る。ダブルクリックか Enter で閉じる（結果は計測レイヤーになる）" },
];

/**
 * ADR-0017 (UI shell rebuild): the "Tools" group of the top ribbon.
 *
 * ADR-0018: tools here are "operations on the selected layer whose result is a new layer"
 * (the source layer is never rewritten); the tooltips say it that way.
 *
 * Owner decision: tools that are not implemented yet must not look clickable. They keep the
 * icon and label but are `disabled` (disabled style), which guarantees at the HTML level that
 * clicking does nothing, and `title` says "(未実装)" (not implemented). Touch devices may not
 * show `title`, so the grayed-out look itself is also part of the signal.
 *
 * L2-D: measurement (distance, height, area) is implemented. Pressing a button starts
 * measuring and the active button gets an underline. Press again or Esc to stop. The buttons
 * are disabled when there is no point cloud (nothing to measure).
 */
export function RibbonToolsGroup({ measure, hasPointCloud }: { measure: MeasureToolState; hasPointCloud: boolean }) {
  return (
    <div className={RIBBON_GROUP_CLASS}>
      <span className={RIBBON_GROUP_LABEL_CLASS}>ツール</span>
      <div className="flex flex-nowrap items-center gap-1">
        {MEASURE_TOOLS.map((tool) => (
          <RibbonButton
            key={tool.kind}
            icon={tool.icon}
            label={tool.label}
            title={tool.title}
            active={measure.mode === tool.kind}
            disabled={!hasPointCloud && measure.mode !== tool.kind}
            onClick={() => measure.toggle(tool.kind)}
          />
        ))}
        {UNIMPLEMENTED_TOOLS.map((tool) => (
          <RibbonButton key={tool.label} icon={tool.icon} label={tool.label} disabled title={tool.title} />
        ))}
      </div>
    </div>
  );
}
