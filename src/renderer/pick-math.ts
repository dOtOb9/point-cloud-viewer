// L2-D: pure math for picking a 3D point from a point on the screen.
//
// Approach: the node points are not kept on the CPU, so we read the drawn depth back
// from the GPU and unproject it. The projection uses NEAR=0.01 and FAR=1e7, so a 24-bit
// depth buffer is coarse far away (one step is z^2/NEAR * 2^-24: about 0.06 at z=100,
// about 54 at z=3000). Therefore picking is done in two stages:
//   1. read the already drawn depth to get a rough distance z (coarse)
//   2. redraw only a few pixels around the click with a narrow projection whose near/far
//      bracket z, and read that depth (fine). With a narrow near/far, 24 bits is enough.
// Unprojection is always done in JS numbers (f64), so precision holds even with large
// coordinates such as 600k (same rule as raycast.ts).
// This file knows nothing about WebGPU or React.

import { invert, transformPoint, type Mat4 } from "./mat4";

/** Radius of the window read in stage 1 (the window is 2*radius+1 pixels square). Points are a few pixels wide, so small gaps are tolerated. */
export const COARSE_HALF = 4;
/** Radius of the window redrawn in stage 2. */
export const REFINE_HALF = 2;

/** Bits of the depth buffer (depth24plus). */
const DEPTH_BITS = 24;

/**
 * Distance z along the camera's forward direction (= clip-space w) from the projected
 * depth d (0..1, WebGPU convention). Inverse of perspective() in mat4.ts:
 * d = far*(z-near) / (z*(far-near))  ->  z = near*far / (far - d*(far-near))
 */
export function depthToEyeDistance(depth: number, near: number, far: number): number {
  return (near * far) / (far - depth * (far - near));
}

/** How much distance one depth step is worth around distance z (exact formula, not an approximation). */
export function depthQuantumAt(z: number, near: number, far: number): number {
  return ((z * z * (far - near)) / (near * far)) * 2 ** -DEPTH_BITS;
}

/**
 * near/far for stage 2: a margin around the rough distance z.
 * On a real machine (NVIDIA, autzen, z about 8000) the stage-1 distance was off from the
 * true distance by about 3x the theoretical quantization error (about 14%). With a margin
 * of 4 coarse steps the point fell outside the range and was not hit. The cause is not
 * identified, so the margin is proportional to the distance and wide: z/2 to 2z.
 * Stage 2 resolution is still fine (near=z/2, far=2z gives a step of about 1e-7 * z,
 * about 1 mm at z=8000). Only very far away (z > about 1e5), where a coarse step itself
 * exceeds z/2, the margin widens to 4 steps.
 */
export function refineDepthRange(z: number, near: number, far: number): { near: number; far: number } {
  const margin = Math.max(z / 2, 4 * depthQuantumAt(z, near, far));
  return { near: Math.max(near, z - margin), far: Math.min(far, z + Math.max(z, margin)) };
}

/**
 * From a read-back window (size x size, row-major), pick the pixel with a point that is
 * closest to the center. "Has a point" means depth > 0 and < 1 (the clear value). For equal
 * distances the smaller (nearer) depth wins. Returns null when there is none (the user
 * clicked the background).
 */
export function nearestHit(depths: Float32Array, size: number): { ix: number; iy: number; depth: number } | null {
  const center = (size - 1) / 2;
  let best: { ix: number; iy: number; depth: number } | null = null;
  let bestDist = Infinity;
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const d = depths[iy * size + ix];
      if (!(d > 0 && d < 1)) continue;
      const dist = (ix - center) ** 2 + (iy - center) ** 2;
      if (dist < bestDist || (dist === bestDist && best !== null && d < best.depth)) {
        best = { ix, iy, depth: d };
        bestDist = dist;
      }
    }
  }
  return best;
}

/**
 * Build a viewProj that maps only the size x size pixel window centered at (cx, cy) of the
 * screen (width x height pixels) onto the whole texture. One window pixel is the same size
 * as one screen pixel (so point size and shape match the original drawing).
 *
 * The clip-space x and y are rescaled so the window center is 0 and the window edges are
 * +-1, by multiplying from the left. w is unchanged, so depth keeps the same formula.
 */
export function windowViewProj(viewProj: Mat4, cx: number, cy: number, size: number, width: number, height: number): Mat4 {
  const half = (size - 1) / 2;
  // Window edges in NDC (cx is an integer pixel index; the left edge of pixel cx is cx).
  const x0 = ((cx - half) / width) * 2 - 1;
  const x1 = ((cx + half + 1) / width) * 2 - 1;
  const y0 = 1 - ((cy - half) / height) * 2; // top edge of the window
  const y1 = 1 - ((cy + half + 1) / height) * 2; // bottom edge of the window
  const centerX = (x0 + x1) / 2;
  const scaleX = (x1 - x0) / 2;
  const centerY = (y0 + y1) / 2;
  const scaleY = (y0 - y1) / 2;
  const out = viewProj.slice();
  for (let col = 0; col < 4; col++) {
    const w = viewProj[col * 4 + 3];
    out[col * 4 + 0] = (viewProj[col * 4 + 0] - centerX * w) / scaleX;
    out[col * 4 + 1] = (viewProj[col * 4 + 1] - centerY * w) / scaleY;
  }
  return out;
}

/**
 * Back to world coordinates from the center of pixel (ix, iy) in the window (top-left is
 * (0,0)) and its depth. `windowVP` is the result of `windowViewProj`. Returns null if the
 * matrix is singular.
 */
export function unprojectWindowSample(
  windowVP: Mat4,
  ix: number,
  iy: number,
  size: number,
  depth: number,
): [number, number, number] | null {
  const inv = invert(windowVP);
  if (!inv) return null;
  const ndcX = ((ix + 0.5) / size) * 2 - 1;
  const ndcY = 1 - ((iy + 0.5) / size) * 2;
  const [x, y, z, w] = transformPoint(inv, [ndcX, ndcY, depth]);
  if (Math.abs(w) < 1e-12) return null;
  return [x / w, y / w, z / w];
}
