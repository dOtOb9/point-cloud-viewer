import { invert, transformPoint, type Mat4 } from "./mat4";

export const COARSE_HALF = 4;
export const REFINE_HALF = 2;

const DEPTH_BITS = 24;

export function depthToEyeDistance(depth: number, near: number, far: number): number {
  return (near * far) / (far - depth * (far - near));
}

export function depthToEyeDistanceOrtho(depth: number, near: number, far: number): number {
  return near + depth * (far - near);
}

export function depthQuantumAt(z: number, near: number, far: number): number {
  return ((z * z * (far - near)) / (near * far)) * 2 ** -DEPTH_BITS;
}

export function refineDepthRange(z: number, near: number, far: number): { near: number; far: number } {
  const margin = Math.max(z / 2, 4 * depthQuantumAt(z, near, far));
  return { near: Math.max(near, z - margin), far: Math.min(far, z + Math.max(z, margin)) };
}

export function refineDepthRangeOrtho(z: number, near: number, far: number): { near: number; far: number } {
  const range = far - near;
  const margin = Math.max(32 * range * 2 ** -DEPTH_BITS, 0.002 * range);
  return { near: Math.max(near, z - margin), far: Math.min(far, z + margin) };
}

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

export function windowViewProj(viewProj: Mat4, cx: number, cy: number, size: number, width: number, height: number): Mat4 {
  const half = (size - 1) / 2;
  const x0 = ((cx - half) / width) * 2 - 1;
  const x1 = ((cx + half + 1) / width) * 2 - 1;
  const y0 = 1 - ((cy - half) / height) * 2;
  const y1 = 1 - ((cy + half + 1) / height) * 2;
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
