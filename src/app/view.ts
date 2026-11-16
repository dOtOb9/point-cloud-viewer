// TP-1: the steps behind the view button, the dialog and the keyboard shortcuts, as plain functions (ADR-0021).
// React only shows the state and calls these. Everything they read or change is in the context.
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { ProjectionMode } from "../renderer/projection";
import { VIEW_PRESET_LABELS, type ViewPresetId } from "../renderer/view-presets";

export type { ProjectionMode, ViewPresetId };

/** What the view functions work with. Built by the viewer state on every render. */
export interface ViewContext {
  /** The renderer, or null before it exists. Only the two camera moves are used. */
  getRenderer: () => Pick<PointCloudRenderer, "setViewPreset" | "fitAll"> | null;
  /** The projection shown now (React state, so the screen updates the moment it changes). */
  projectionMode: ProjectionMode;
  /** Changes the React state and tells the renderer (the same setter as the other display settings). */
  setProjectionMode: (mode: ProjectionMode) => void;
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

/** True for an element the user types into (input, textarea, select, contenteditable). */
function isTypingTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const el = target as { tagName?: string; isContentEditable?: boolean };
  const tag = (el.tagName ?? "").toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/** Switch the projection. The screen size at the target stays the same (renderer/projection.ts). */
export function setProjection(ctx: ViewContext, mode: ProjectionMode): void {
  ctx.setProjectionMode(mode);
}

/** Move to a fixed viewpoint (animated; immediate when animation is off). Does nothing when no layer is visible. */
export function showViewPreset(ctx: ViewContext, id: ViewPresetId): boolean {
  return ctx.getRenderer()?.setViewPreset(id) ?? false;
}

/** "Fit all": the visible layers fill the screen, the direction stays. Does nothing when no layer is visible. */
export function fitAllView(ctx: ViewContext): boolean {
  return ctx.getRenderer()?.fitAll() ?? false;
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
      setProjection(ctx, ctx.projectionMode === "perspective" ? "orthographic" : "perspective");
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
