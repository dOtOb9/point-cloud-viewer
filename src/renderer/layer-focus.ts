import type { SceneBounds } from "./scene-bounds";

export function layerFocusBounds(
  sceneBounds: SceneBounds | null,
  boundsMin: readonly [number, number, number],
  boundsMax: readonly [number, number, number],
): SceneBounds {
  if (sceneBounds) return sceneBounds;
  const min: [number, number, number] = [boundsMin[0], boundsMin[1], boundsMin[2]];
  const max: [number, number, number] = [boundsMax[0], boundsMax[1], boundsMax[2]];
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 100;
  return { min, max, center, diagonal };
}

export interface FocusGoal {
  target: [number, number, number];
  distance: number;
  yaw?: number;
  pitch?: number;
}

export function focusGoalFor(bounds: SceneBounds, orientation?: { yaw: number; pitch: number }): FocusGoal {
  return {
    target: [bounds.center[0], bounds.center[1], bounds.center[2]],
    distance: bounds.diagonal,
    ...(orientation ?? {}),
  };
}

export const MIN_POINT_SIZE_PX = 1;
export const MAX_POINT_SIZE_PX = 32;

export const DEFAULT_POINT_SIZE_PX = 4;

export function sanitizePointSize(px: number | undefined, fallback = DEFAULT_POINT_SIZE_PX): number {
  if (px === undefined || !Number.isFinite(px)) return fallback;
  return Math.min(MAX_POINT_SIZE_PX, Math.max(MIN_POINT_SIZE_PX, px));
}
