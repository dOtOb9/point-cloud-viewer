import { orthographicMatrix, perspective, type Mat4 } from "./mat4";
import {
  depthToEyeDistance,
  depthToEyeDistanceOrtho,
  refineDepthRange,
  refineDepthRangeOrtho,
} from "./pick-math";

export const FOV_Y_RADIANS = Math.PI / 3;
export const NEAR = 0.01;
export const FAR = 1e7;

export type ProjectionMode = "perspective" | "orthographic";

export const DEFAULT_PROJECTION_MODE: ProjectionMode = "perspective";

export interface Projection {
  mode: ProjectionMode;
  matrix: Mat4;
  near: number;
  far: number;
  halfHeight: number;
}

export function orthoHalfHeight(distance: number, fovYRadians: number = FOV_Y_RADIANS): number {
  return distance * Math.tan(fovYRadians / 2);
}

export function orthoDepthRange(
  distance: number,
  sceneDiagonal: number,
  targetToSceneCenter = 0,
): { near: number; far: number } {
  const r = 2 * Math.max(sceneDiagonal + targetToSceneCenter, distance, 1);
  return { near: distance - r, far: distance + r };
}

export function orthoCursorZoomDirection(
  right: readonly [number, number, number],
  up: readonly [number, number, number],
  ndcX: number,
  ndcY: number,
  aspect: number,
  halfHeight: number,
  distance: number,
): [number, number, number] {
  const sideX = (ndcX * aspect * halfHeight) / distance;
  const sideY = (ndcY * halfHeight) / distance;
  return [
    right[0] * sideX + up[0] * sideY,
    right[1] * sideX + up[1] * sideY,
    right[2] * sideX + up[2] * sideY,
  ];
}

export function buildProjection(
  mode: ProjectionMode,
  aspect: number,
  distance: number,
  sceneDiagonal: number,
  targetToSceneCenter = 0,
): Projection {
  if (mode === "orthographic") {
    const halfHeight = orthoHalfHeight(distance);
    const { near, far } = orthoDepthRange(distance, sceneDiagonal, targetToSceneCenter);
    return { mode, matrix: orthographicMatrix(halfHeight, aspect, near, far), near, far, halfHeight };
  }
  return { mode, matrix: perspective(FOV_Y_RADIANS, aspect, NEAR, FAR), near: NEAR, far: FAR, halfHeight: 0 };
}

export function eyeDistanceFromDepth(projection: Projection, depth: number): number {
  return projection.mode === "orthographic"
    ? depthToEyeDistanceOrtho(depth, projection.near, projection.far)
    : depthToEyeDistance(depth, projection.near, projection.far);
}

export function refinedProjection(projection: Projection, aspect: number, z: number): Projection {
  if (projection.mode === "orthographic") {
    const range = refineDepthRangeOrtho(z, projection.near, projection.far);
    return {
      ...projection,
      matrix: orthographicMatrix(projection.halfHeight, aspect, range.near, range.far),
      near: range.near,
      far: range.far,
    };
  }
  const range = refineDepthRange(z, projection.near, projection.far);
  return {
    ...projection,
    matrix: perspective(FOV_Y_RADIANS, aspect, range.near, range.far),
    near: range.near,
    far: range.far,
  };
}

export function fitDistance(mode: ProjectionMode, diagonal: number, aspect: number): number {
  const radius = diagonal / 2;
  const tanHalf = Math.tan(FOV_Y_RADIANS / 2);
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  if (mode === "orthographic") {
    return radius / (tanHalf * Math.min(1, safeAspect));
  }
  const halfAngle = Math.min(FOV_Y_RADIANS / 2, Math.atan(tanHalf * safeAspect));
  return radius / Math.sin(halfAngle);
}

export function orthoReferenceDistance(projection: Projection): number {
  return projection.mode === "orthographic" ? projection.halfHeight / Math.tan(FOV_Y_RADIANS / 2) : 0;
}
