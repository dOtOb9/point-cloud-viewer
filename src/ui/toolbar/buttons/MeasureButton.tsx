import { Hexagon, MoveVertical, Ruler, type LucideIcon } from "lucide-react";
import type { MeasureKind } from "../../../state/measure";
import type { MeasureToolState } from "../../../state/useMeasureTool";
import type { CopcViewerState } from "../../../state/useCopcViewer";
import { ToolbarButton } from "../ToolbarButton";
import { hasPointCloud } from "../toolbar-state";

/** Per-kind label, icon and tooltip. Measurement is split into three buttons (owner decision). */
const MEASURE_BUTTONS: Record<MeasureKind, { icon: LucideIcon; label: string; title: string }> = {
  distance: { icon: Ruler, label: "距離", title: "2点をクリックして距離を測る（結果は計測レイヤーになる）" },
  height: { icon: MoveVertical, label: "高さ", title: "2点をクリックして高さの差を測る（結果は計測レイヤーになる）" },
  area: { icon: Hexagon, label: "面積", title: "頂点をクリックして面積を測る。ダブルクリックか Enter で閉じる（結果は計測レイヤーになる）" },
};

interface Props {
  kind: MeasureKind;
  viewer: CopcViewerState;
  measure: MeasureToolState;
}

/**
 * L2-D: one measurement tool button (distance, height or area; the toolbar renders it three times).
 *
 * - Active while this kind of measurement is running (the button gets the underline).
 * - Disabled when there is no point cloud to measure on, unless this tool is already running
 *   (so it can still be stopped).
 * - Pressing it starts the tool; pressing again (or Esc) stops it.
 */
export function MeasureButton({ kind, viewer, measure }: Props) {
  const { icon, label, title } = MEASURE_BUTTONS[kind];
  const active = measure.mode === kind;
  return (
    <ToolbarButton
      icon={icon}
      label={label}
      title={title}
      active={active}
      disabled={!hasPointCloud(viewer) && !active}
      onClick={() => measure.toggle(kind)}
    />
  );
}
