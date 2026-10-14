// L2-D: project world-space points and segments to the screen (CSS pixels). Used to overlay
// measurement lines and labels on the DOM (SVG). Pure functions. Computed in f64 (rule of mat4.ts).

import { transformPoint, type Mat4 } from "./mat4";

export interface ScreenPoint {
  x: number;
  y: number;
}

type Clip = [number, number, number, number];

function toScreen(c: Clip, width: number, height: number): ScreenPoint {
  return { x: ((c[0] / c[3] + 1) / 2) * width, y: ((1 - c[1] / c[3]) / 2) * height };
}

/** Project a point to the screen. Returns null if it is behind the camera (nearer than the near plane). */
export function projectPoint(
  viewProj: Mat4,
  p: readonly [number, number, number],
  width: number,
  height: number,
): ScreenPoint | null {
  const c = transformPoint(viewProj, p);
  // In WebGPU clip space the frustum is 0 <= z <= w. z < 0 is in front of the near plane.
  if (!(c[3] > 0) || c[2] < 0) return null;
  return toScreen(c, width, height);
}

/**
 * Project a segment to the screen. The part behind the camera is cut at the near plane
 * (without cutting, a point behind would project to the opposite side of the screen and a
 * strange line would be drawn). Returns null if the whole segment is behind.
 */
export function projectSegment(
  viewProj: Mat4,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  width: number,
  height: number,
): [ScreenPoint, ScreenPoint] | null {
  const ca = transformPoint(viewProj, a);
  const cb = transformPoint(viewProj, b);
  const inA = ca[3] > 0 && ca[2] >= 0;
  const inB = cb[3] > 0 && cb[2] >= 0;
  if (!inA && !inB) return null;
  let start: Clip = ca;
  let end: Clip = cb;
  if (!inA || !inB) {
    // Cut where the segment meets z = 0 (the near plane) at parameter t. Clip space is
    // linear, so each component can be interpolated.
    const t = ca[2] / (ca[2] - cb[2]);
    const cut: Clip = [
      ca[0] + (cb[0] - ca[0]) * t,
      ca[1] + (cb[1] - ca[1]) * t,
      0,
      ca[3] + (cb[3] - ca[3]) * t,
    ];
    if (!(cut[3] > 0)) return null;
    if (!inA) start = cut;
    else end = cut;
  }
  return [toScreen(start, width, height), toScreen(end, width, height)];
}
