import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import { DEFAULT_PROJECTION_MODE, type ProjectionMode } from "../renderer/projection";
import { isMeasureLayer, type ViewerLayer } from "../state/layers";
import { createStore, type Store } from "./store";
import { isTypingTarget } from "./typing-target";
import { VIEW_PRESET_LABELS, type ViewPresetId } from "../renderer/view-presets";

export type { ProjectionMode, ViewPresetId };

export type ViewRenderer = Pick<PointCloudRenderer, "setViewPreset" | "fitAll" | "setProjectionMode">;

export interface ViewContext {
  projection: Store<ProjectionMode>;
  pointCloud: Store<boolean>;
  renderer: Store<ViewRenderer | null>;
}

export function createViewContext(): ViewContext {
  return {
    projection: createStore<ProjectionMode>(DEFAULT_PROJECTION_MODE),
    pointCloud: createStore(false),
    renderer: createStore<ViewRenderer | null>(null),
  };
}

export const viewContext: ViewContext = createViewContext();

export function hasPointCloudLayer(layers: readonly ViewerLayer[]): boolean {
  return layers.some((layer) => !isMeasureLayer(layer));
}

export function syncViewEnabled(ctx: ViewContext, layers: readonly ViewerLayer[]): void {
  ctx.pointCloud.set(hasPointCloudLayer(layers));
}

export function attachViewRenderer(ctx: ViewContext, renderer: ViewRenderer): void {
  ctx.renderer.set(renderer);
  renderer.setProjectionMode(ctx.projection.get());
}

export function detachViewRenderer(ctx: ViewContext): void {
  ctx.renderer.set(null);
}

export type ViewAction = { kind: "fit" } | { kind: "preset"; id: ViewPresetId } | { kind: "toggleProjection" };

export const PROJECTION_LABELS: Record<ProjectionMode, string> = {
  perspective: "透視投影",
  orthographic: "平行投影",
};

export const PROJECTION_SHORT_LABELS: Record<ProjectionMode, string> = {
  perspective: "透視",
  orthographic: "平行",
};

export const VIEW_SHORTCUTS: { key: string; action: ViewAction }[] = [
  { key: "F", action: { kind: "fit" } },
  { key: "1", action: { kind: "preset", id: "top" } },
  { key: "2", action: { kind: "preset", id: "front" } },
  { key: "3", action: { kind: "preset", id: "right" } },
  { key: "4", action: { kind: "preset", id: "isometric" } },
  { key: "5", action: { kind: "toggleProjection" } },
  { key: "6", action: { kind: "preset", id: "back" } },
  { key: "7", action: { kind: "preset", id: "left" } },
];

export function shortcutKeyOfPreset(id: ViewPresetId): string {
  const found = VIEW_SHORTCUTS.find((s) => s.action.kind === "preset" && s.action.id === id);
  return found ? found.key : "";
}

export function viewActionForKey(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  target: unknown;
}): ViewAction | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat) return null;
  if (isTypingTarget(event.target)) return null;
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return VIEW_SHORTCUTS.find((s) => s.key === key)?.action ?? null;
}

export function setProjection(ctx: ViewContext, mode: ProjectionMode): void {
  if (!ctx.pointCloud.get()) return;
  ctx.projection.set(mode);
  ctx.renderer.get()?.setProjectionMode(mode);
}

export function showViewPreset(ctx: ViewContext, id: ViewPresetId): boolean {
  if (!ctx.pointCloud.get()) return false;
  return ctx.renderer.get()?.setViewPreset(id) ?? false;
}

export function fitAllView(ctx: ViewContext): boolean {
  if (!ctx.pointCloud.get()) return false;
  return ctx.renderer.get()?.fitAll() ?? false;
}

export function runViewAction(ctx: ViewContext, action: ViewAction): void {
  switch (action.kind) {
    case "fit":
      fitAllView(ctx);
      return;
    case "preset":
      showViewPreset(ctx, action.id);
      return;
    case "toggleProjection":
      setProjection(ctx, ctx.projection.get() === "perspective" ? "orthographic" : "perspective");
      return;
  }
}

export function viewStatusText(preset: ViewPresetId | null, mode: ProjectionMode, narrow: boolean): string {
  const name = preset ? VIEW_PRESET_LABELS[preset] : "自由";
  return narrow ? `${name}・${PROJECTION_SHORT_LABELS[mode]}` : `視点: ${name}（${PROJECTION_LABELS[mode]}）`;
}
