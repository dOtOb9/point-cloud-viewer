import { aabbClippedByNearPlane, clipToScreenPixels } from "./screen-space-error";
import { transformPoint, type Mat4 } from "./mat4";

export const DEFAULT_MIN_CENTER_PRIORITY_WEIGHT = 0.2;

export const DEFAULT_CENTER_PRIORITY_STRENGTH = 4;

export function centerPriorityWeight(
  viewProj: Mat4,
  boundsMin: readonly [number, number, number],
  boundsMax: readonly [number, number, number],
  canvasWidth: number,
  canvasHeight: number,
  strength: number,
  minWeight: number = DEFAULT_MIN_CENTER_PRIORITY_WEIGHT,
): number {
  if (strength <= 0) return 1;
  if (aabbClippedByNearPlane(viewProj, boundsMin, boundsMax)) return 1;

  const centerWorld: [number, number, number] = [
    (boundsMin[0] + boundsMax[0]) / 2,
    (boundsMin[1] + boundsMax[1]) / 2,
    (boundsMin[2] + boundsMax[2]) / 2,
  ];
  const [cx, cy, , cw] = transformPoint(viewProj, centerWorld);
  const [px, py] = clipToScreenPixels(cx, cy, cw, canvasWidth, canvasHeight);

  const screenCenterX = canvasWidth / 2;
  const screenCenterY = canvasHeight / 2;
  const halfDiagonal = Math.max(Math.hypot(canvasWidth, canvasHeight) / 2, 1e-6);
  const normalizedDistance = Math.hypot(px - screenCenterX, py - screenCenterY) / halfDiagonal;

  const gaussian = Math.exp(-strength * normalizedDistance * normalizedDistance);
  return minWeight + (1 - minWeight) * gaussian;
}
