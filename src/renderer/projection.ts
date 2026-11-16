// TP-1: projection (perspective / orthographic) in one place. Pure functions; no WebGPU, no React.
//
// Why this file exists: before TP-1 every place that needed the projection called perspective() with
// FOV_Y_RADIANS, NEAR and FAR directly (the frame, the picking redraw, the EDL linearization, the sky and grid
// rays). To add an orthographic mode without scattering "if ortho" over all of them, the renderer builds one
// `Projection` per frame and the consumers read the matrix, the near/far and the mode from it.
//
// Orthographic design:
//  - The camera is still the orbit camera (target, distance, yaw, pitch). In orthographic mode `distance` is not
//    a position along the view axis only; it is also the zoom: the visible half height at the target plane is
//    `distance * tan(fovY / 2)`. That is exactly the half height a perspective camera sees at the target plane,
//    so switching the mode keeps the on-screen size of what is at the target (AC-4).
//  - Near/far are eye distances (the same meaning as in perspective) but symmetric around the target:
//    near = distance - R, far = distance + R, with R proportional to the scene size. near is usually negative,
//    which is legal for an orthographic projection and keeps points "behind the eye" visible. Depth is linear,
//    so a 24-bit depth buffer has the same resolution everywhere (R * 2 / 2^24).
//  - w stays 1. The point-size trick in the vertex shader (`clip.xy + corner * ndcHalf * clip.w`), the screen
//    space error (`screen-space-error.ts`) and the frustum planes (`frustum.ts`) already work with any matrix.

import { orthographicMatrix, perspective, type Mat4 } from "./mat4";
import {
  depthToEyeDistance,
  depthToEyeDistanceOrtho,
  refineDepthRange,
  refineDepthRangeOrtho,
} from "./pick-math";

/** Vertical field of view of the perspective camera. */
export const FOV_Y_RADIANS = Math.PI / 3;
export const NEAR = 0.01;
export const FAR = 1e7;

export type ProjectionMode = "perspective" | "orthographic";

export const DEFAULT_PROJECTION_MODE: ProjectionMode = "perspective";

/** One frame's projection: the matrix and what the consumers need to interpret depth. */
export interface Projection {
  mode: ProjectionMode;
  matrix: Mat4;
  /** Eye-distance near/far the matrix was built with (orthographic: near is usually negative). */
  near: number;
  far: number;
  /** Orthographic only: visible half height at any depth, in world units. 0 for perspective. */
  halfHeight: number;
}

/** Visible half height (world units) of an orthographic view whose orbit distance is `distance`. */
export function orthoHalfHeight(distance: number, fovYRadians: number = FOV_Y_RADIANS): number {
  return distance * Math.tan(fovYRadians / 2);
}

/**
 * Eye-distance range of the orthographic view: symmetric around the target (at `distance`), wide enough for the
 * whole scene. R = 2 * max(scene diagonal, distance, 1).
 */
export function orthoDepthRange(distance: number, sceneDiagonal: number): { near: number; far: number } {
  const r = 2 * Math.max(sceneDiagonal, distance, 1);
  return { near: distance - r, far: distance + r };
}

/** The projection of a frame. `sceneDiagonal` is only used by the orthographic depth range. */
export function buildProjection(
  mode: ProjectionMode,
  aspect: number,
  distance: number,
  sceneDiagonal: number,
): Projection {
  if (mode === "orthographic") {
    const halfHeight = orthoHalfHeight(distance);
    const { near, far } = orthoDepthRange(distance, sceneDiagonal);
    return { mode, matrix: orthographicMatrix(halfHeight, aspect, near, far), near, far, halfHeight };
  }
  return { mode, matrix: perspective(FOV_Y_RADIANS, aspect, NEAR, FAR), near: NEAR, far: FAR, halfHeight: 0 };
}

/** Eye distance (along the view direction) from a depth-buffer value (0..1), for the projection's mode. */
export function eyeDistanceFromDepth(projection: Projection, depth: number): number {
  return projection.mode === "orthographic"
    ? depthToEyeDistanceOrtho(depth, projection.near, projection.far)
    : depthToEyeDistance(depth, projection.near, projection.far);
}

/**
 * Picking stage 2: the same projection with near/far narrowed around the rough eye distance `z`, so that a
 * 24-bit depth buffer is precise enough (see pick-math.ts).
 */
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

/**
 * Orbit distance at which a scene with the given bounding-box diagonal fits the screen (the sphere that
 * contains the box, centered on the target). `aspect` is width / height; for a tall screen the horizontal
 * direction limits the fit. For a wide screen both modes give about `diagonal` with the 60 degree FOV.
 */
export function fitDistance(mode: ProjectionMode, diagonal: number, aspect: number): number {
  const radius = diagonal / 2;
  const tanHalf = Math.tan(FOV_Y_RADIANS / 2);
  const safeAspect = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
  if (mode === "orthographic") {
    // Visible half extent at any depth is distance * tanHalf (vertical) and that times aspect (horizontal).
    return radius / (tanHalf * Math.min(1, safeAspect));
  }
  const halfAngle = Math.min(FOV_Y_RADIANS / 2, Math.atan(tanHalf * safeAspect));
  return radius / Math.sin(halfAngle);
}

/** The orbit distance behind an orthographic projection (EDL uses it as the reference length); 0 for perspective. */
export function orthoReferenceDistance(projection: Projection): number {
  return projection.mode === "orthographic" ? projection.halfHeight / Math.tan(FOV_Y_RADIANS / 2) : 0;
}
