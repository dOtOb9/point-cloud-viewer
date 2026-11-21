import type { ProjectionMode, ViewPresetId } from "../../plugin-api";
import type { ViewMsg } from "./model";

export const VIEW_PRESET_LABELS: Record<ViewPresetId, string> = {
  top: "上",
  front: "正面",
  back: "背面",
  left: "左",
  right: "右",
  isometric: "等角",
};

export const PROJECTION_LABELS: Record<ProjectionMode, string> = {
  perspective: "透視投影",
  orthographic: "平行投影",
};

export const PROJECTION_SHORT_LABELS: Record<ProjectionMode, string> = {
  perspective: "透視",
  orthographic: "平行",
};

export const PROJECTION_HINTS: Record<ProjectionMode, string> = {
  perspective: "（遠くが小さく見える）",
  orthographic: "（どこも同じ大きさ。図面向き）",
};

export const VIEW_BUTTON_TITLE = "視点を変える（F: 全体 / 1: 上 / 2: 正面 / 3: 右 / 4: 等角 / 5: 透視・平行の切り替え / 6: 背面 / 7: 左）";

export const VIEW_BUTTON_DISABLED_TITLE = "点群を開くと、視点を変えられる";

export interface ViewShortcut {
  key: string;
  label: string;
  msg: ViewMsg;
}

export const VIEW_SHORTCUTS: readonly ViewShortcut[] = [
  { key: "F", label: "全体", msg: { type: "fitRequested" } },
  { key: "1", label: "上", msg: { type: "presetRequested", id: "top" } },
  { key: "2", label: "正面", msg: { type: "presetRequested", id: "front" } },
  { key: "3", label: "右", msg: { type: "presetRequested", id: "right" } },
  { key: "4", label: "等角", msg: { type: "presetRequested", id: "isometric" } },
  { key: "5", label: "透視・平行の切り替え", msg: { type: "projectionToggled" } },
  { key: "6", label: "背面", msg: { type: "presetRequested", id: "back" } },
  { key: "7", label: "左", msg: { type: "presetRequested", id: "left" } },
];

export function shortcutKeyOfPreset(id: ViewPresetId): string {
  const found = VIEW_SHORTCUTS.find((s) => s.msg.type === "presetRequested" && s.msg.id === id);
  return found ? found.key : "";
}

export function viewStatusText(preset: ViewPresetId | null, mode: ProjectionMode, narrow: boolean): string {
  const name = preset ? VIEW_PRESET_LABELS[preset] : "自由";
  return narrow ? `${name}・${PROJECTION_SHORT_LABELS[mode]}` : `視点: ${name}（${PROJECTION_LABELS[mode]}）`;
}
