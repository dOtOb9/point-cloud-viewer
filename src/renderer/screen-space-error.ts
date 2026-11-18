import { transformPoint, type Mat4 } from "./mat4";

const NEAR_W_EPSILON = 1e-6;

function aabbCorner(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  index: number,
): [number, number, number] {
  return [
    index & 1 ? max[0] : min[0],
    index & 2 ? max[1] : min[1],
    index & 4 ? max[2] : min[2],
  ];
}

export function clipToScreenPixels(
  cx: number,
  cy: number,
  cw: number,
  canvasWidth: number,
  canvasHeight: number,
): [number, number] {
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  return [((ndcX + 1) / 2) * canvasWidth, ((1 - ndcY) / 2) * canvasHeight];
}

export function projectedBoundsDiagonalPixels(
  viewProj: Mat4,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  canvasWidth: number,
  canvasHeight: number,
): number {
  const corners: [number, number, number][] = [];
  const clip: [number, number, number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const corner = aabbCorner(min, max, i);
    corners.push(corner);
    clip.push(transformPoint(viewProj, corner));
  }

  const screenPoints: [number, number][] = [];

  for (let i = 0; i < 8; i++) {
    const [cx, cy, , cw] = clip[i];
    if (cw > NEAR_W_EPSILON) {
      screenPoints.push(clipToScreenPixels(cx, cy, cw, canvasWidth, canvasHeight));
    }
  }

  for (let i = 0; i < 8; i++) {
    for (const bit of [1, 2, 4]) {
      if (i & bit) continue;
      const j = i | bit;
      const wi = clip[i][3];
      const wj = clip[j][3];
      const iIsFront = wi > NEAR_W_EPSILON;
      const jIsFront = wj > NEAR_W_EPSILON;
      if (iIsFront === jIsFront) continue;

      const t = (NEAR_W_EPSILON - wi) / (wj - wi);
      const a = corners[i];
      const b = corners[j];
      const crossingPoint: [number, number, number] = [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      ];
      const [cx, cy, , cw] = transformPoint(viewProj, crossingPoint);
      screenPoints.push(clipToScreenPixels(cx, cy, cw, canvasWidth, canvasHeight));
    }
  }

  if (screenPoints.length === 0) {
    return canvasWidth + canvasHeight;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of screenPoints) {
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }

  return Math.hypot(maxX - minX, maxY - minY);
}

export function aabbClippedByNearPlane(
  viewProj: Mat4,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): boolean {
  for (let i = 0; i < 8; i++) {
    const corner = aabbCorner(min, max, i);
    const cw = transformPoint(viewProj, corner)[3];
    if (cw <= NEAR_W_EPSILON) return true;
  }
  return false;
}

export function screenSpaceError(
  viewProj: Mat4,
  boundsMin: readonly [number, number, number],
  boundsMax: readonly [number, number, number],
  pointCount: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const sizePixels = projectedBoundsDiagonalPixels(viewProj, boundsMin, boundsMax, canvasWidth, canvasHeight);

  const dx = Math.max(boundsMax[0] - boundsMin[0], 1e-6);
  const dy = Math.max(boundsMax[1] - boundsMin[1], 1e-6);
  const dz = Math.max(boundsMax[2] - boundsMin[2], 1e-6);
  const volume = dx * dy * dz;
  const pointSpacing = Math.cbrt(volume / Math.max(pointCount, 1));

  const worldDiagonal = Math.max(Math.hypot(dx, dy, dz), 1e-6);
  const pixelsPerWorldUnit = sizePixels / worldDiagonal;

  return pointSpacing * pixelsPerWorldUnit;
}

export function surfaceSpacingPixels(
  viewProj: Mat4,
  boundsMin: readonly [number, number, number],
  boundsMax: readonly [number, number, number],
  pointCount: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const sizePixels = projectedBoundsDiagonalPixels(viewProj, boundsMin, boundsMax, canvasWidth, canvasHeight);
  const dx = Math.max(boundsMax[0] - boundsMin[0], 1e-6);
  const dy = Math.max(boundsMax[1] - boundsMin[1], 1e-6);
  const dz = Math.max(boundsMax[2] - boundsMin[2], 1e-6);
  const faceArea = Math.max(dx * dy, dy * dz, dx * dz);
  const spacing = Math.sqrt(faceArea / Math.max(pointCount, 1));
  const worldDiagonal = Math.max(Math.hypot(dx, dy, dz), 1e-6);
  return spacing * (sizePixels / worldDiagonal);
}
