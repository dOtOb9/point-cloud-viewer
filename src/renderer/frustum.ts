import type { Mat4 } from "./mat4";

export type Plane = [number, number, number, number];

export function frustumPlanes(viewProj: Mat4): Plane[] {
  const m = viewProj;
  const row = (r: number): [number, number, number, number] => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);

  const add = (a: number[], b: number[]): Plane => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
  const sub = (a: number[], b: number[]): Plane => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];

  const left = add(r3, r0);
  const right = sub(r3, r0);
  const bottom = add(r3, r1);
  const top = sub(r3, r1);
  const near = add(r3, r2);
  const far = sub(r3, r2);
  const planes: Plane[] = [left, right, bottom, top, near, far];

  return planes.map(normalizePlane);
}

function normalizePlane(p: Plane): Plane {
  const len = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / len, p[1] / len, p[2] / len, p[3] / len];
}

export function aabbIntersectsFrustum(
  planes: Plane[],
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): boolean {
  for (const [a, b, c, d] of planes) {
    const px = a >= 0 ? max[0] : min[0];
    const py = b >= 0 ? max[1] : min[1];
    const pz = c >= 0 ? max[2] : min[2];
    if (a * px + b * py + c * pz + d < 0) {
      return false;
    }
  }
  return true;
}
