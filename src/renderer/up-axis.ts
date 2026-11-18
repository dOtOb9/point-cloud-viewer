export type Vec3 = readonly [number, number, number];

export const DEFAULT_UP_AXIS: Vec3 = [0, 0, 1];

const UP_TOO_CLOSE_TO_Z_FOR_A_Z_SEED = 0.9;

function normalize(v: Vec3): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function horizontalBasis(up: Vec3): { right: [number, number, number]; forward: [number, number, number] } {
  const u = normalize(up);
  const seed: Vec3 = Math.abs(u[2]) > UP_TOO_CLOSE_TO_Z_FOR_A_Z_SEED ? [1, 0, 0] : [0, 0, 1];
  const right = normalize(cross(u, seed));
  const forward = normalize(cross(right, u));
  return { right, forward };
}
