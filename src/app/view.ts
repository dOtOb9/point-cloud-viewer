// TP-1: the steps behind the view button, the dialog and the keyboard shortcuts, as plain functions (ADR-0021).
// React only shows the state and calls these. Everything they read or change is in the context.
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import { DEFAULT_PROJECTION_MODE, type ProjectionMode } from "../renderer/projection";
import { isMeasureLayer, type ViewerLayer } from "../state/layers";
import { createStore, type Store } from "./store";
import { isTypingTarget } from "./typing-target";
import { VIEW_PRESET_LABELS, type ViewPresetId } from "../renderer/view-presets";

export type { ProjectionMode, ViewPresetId };

/** The part of the renderer the view functions call. */
export type ViewRenderer = Pick<PointCloudRenderer, "setViewPreset" | "fitAll" | "setProjectionMode">;

/**
 * What the view functions work with: two stores (src/app/store.ts).
 * The projection mode is owned by the store: the status bar and the dialog read it from there, and
 * `setProjection` tells the renderer (one direction; the renderer never reports the mode back).
 */
export interface ViewContext {
  projection: Store<ProjectionMode>;
  /**
   * True while a point-cloud layer is open (measurement layers do not count). The view functions do nothing when it is
   * false, so the keys cannot change the view or the projection while the view button is grayed out (TP-1 F-10).
   * The app sets it with `syncViewEnabled` (useViewShortcuts); a test sets it directly.
   */
  pointCloud: Store<boolean>;
  /** The renderer, or null before it exists / after it is disposed (set by `attachViewRenderer`). */
  renderer: Store<ViewRenderer | null>;
}

export function createViewContext(): ViewContext {
  return {
    projection: createStore<ProjectionMode>(DEFAULT_PROJECTION_MODE),
    pointCloud: createStore(false),
    renderer: createStore<ViewRenderer | null>(null),
  };
}

/** The one context of the app. Tests make their own with `createViewContext`. */
export const viewContext: ViewContext = createViewContext();

/** True when the list has a point-cloud layer (measurement layers do not count). The one definition: the view button and the keys both use it. */
export function hasPointCloudLayer(layers: readonly ViewerLayer[]): boolean {
  return layers.some((layer) => !isMeasureLayer(layer));
}

/** Tell the view functions whether a point cloud is open. Called whenever the layer list changes. */
export function syncViewEnabled(ctx: ViewContext, layers: readonly ViewerLayer[]): void {
  ctx.pointCloud.set(hasPointCloudLayer(layers));
}

/** Hand the new renderer to the view functions and give it the projection chosen so far. */
export function attachViewRenderer(ctx: ViewContext, renderer: ViewRenderer): void {
  ctx.renderer.set(renderer);
  renderer.setProjectionMode(ctx.projection.get());
}

/** The renderer is gone (disposed). */
export function detachViewRenderer(ctx: ViewContext): void {
  ctx.renderer.set(null);
}

/** One thing the user can ask for: "fit all", a fixed viewpoint, or flipping the projection. */
export type ViewAction = { kind: "fit" } | { kind: "preset"; id: ViewPresetId } | { kind: "toggleProjection" };

/** Plain names of the two projections (UX-8: the words survey software uses). */
export const PROJECTION_LABELS: Record<ProjectionMode, string> = {
  perspective: "透視投影",
  orthographic: "平行投影",
};

/** Shortest form for the narrow status bar. */
export const PROJECTION_SHORT_LABELS: Record<ProjectionMode, string> = {
  perspective: "透視",
  orthographic: "平行",
};

/**
 * Keyboard shortcuts of the view (UX-4). Keys are easy to remember: F = fit, 1 = top, 2 = front, 3 = right,
 * 4 = isometric, 5 = switch the projection, and 6 / 7 = back / left. Shown in the tooltips and in the dialog.
 */
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

/** The key written next to a preset in the tooltips (every preset has one). */
export function shortcutKeyOfPreset(id: ViewPresetId): string {
  const found = VIEW_SHORTCUTS.find((s) => s.action.kind === "preset" && s.action.id === id);
  return found ? found.key : "";
}

/**
 * The action of a pressed key, or null. Only a plain key counts: with Ctrl / Meta / Alt it belongs to the browser or
 * the OS, and while the user types in a field (or an IME is composing) the key belongs to that field.
 */
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

/** Switch the projection. The screen size at the target stays the same (renderer/projection.ts). */
export function setProjection(ctx: ViewContext, mode: ProjectionMode): void {
  if (!ctx.pointCloud.get()) return;
  ctx.projection.set(mode);
  ctx.renderer.get()?.setProjectionMode(mode);
}

/** Move to a fixed viewpoint (animated; immediate when animation is off). Does nothing when no layer is visible. */
export function showViewPreset(ctx: ViewContext, id: ViewPresetId): boolean {
  if (!ctx.pointCloud.get()) return false;
  return ctx.renderer.get()?.setViewPreset(id) ?? false;
}

/** "Fit all": the visible layers fill the screen, the direction stays. Does nothing when no layer is visible. */
export function fitAllView(ctx: ViewContext): boolean {
  if (!ctx.pointCloud.get()) return false;
  return ctx.renderer.get()?.fitAll() ?? false;
}

/** Run one action. The buttons, the dialog and the shortcuts all come here, so they cannot behave differently. */
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

/**
 * The status bar text (UX-1): the name of the fixed viewpoint (or "自由" when the camera is somewhere else) and the
 * projection. `narrow` drops the heading and uses the short projection name.
 */
export function viewStatusText(preset: ViewPresetId | null, mode: ProjectionMode, narrow: boolean): string {
  const name = preset ? VIEW_PRESET_LABELS[preset] : "自由";
  return narrow ? `${name}・${PROJECTION_SHORT_LABELS[mode]}` : `視点: ${name}（${PROJECTION_LABELS[mode]}）`;
}
