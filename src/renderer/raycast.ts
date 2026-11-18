import { invert, transformPoint, type Mat4 } from "./mat4";

export interface Ray {
  origin: [number, number, number];
  direction: [number, number, number];
}

export function screenPointToWorldRay(
  viewProj: Mat4,
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
): Ray | null {
  const ndcX = (screenX / canvasWidth) * 2 - 1;
  const ndcY = 1 - (screenY / canvasHeight) * 2;
  return ndcPointToWorldRay(viewProj, ndcX, ndcY);
}

export function ndcPointToWorldRay(viewProj: Mat4, ndcX: number, ndcY: number): Ray | null {
  const inv = invert(viewProj);
  if (!inv) return null;

  const near = unprojectNdc(inv, ndcX, ndcY, 0);
  const far = unprojectNdc(inv, ndcX, ndcY, 1);
  if (!near || !far) return null;

  const dx = far[0] - near[0];
  const dy = far[1] - near[1];
  const dz = far[2] - near[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) return null;

  return { origin: near, direction: [dx / len, dy / len, dz / len] };
}

function unprojectNdc(inv: Mat4, ndcX: number, ndcY: number, ndcZ: number): [number, number, number] | null {
  const [x, y, z, w] = transformPoint(inv, [ndcX, ndcY, ndcZ]);
  if (Math.abs(w) < 1e-9) return null;
  return [x / w, y / w, z / w];
}

const MIN_HIT_DISTANCE = 0.01;

export function intersectRayAabb(
  ray: Ray,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;

  for (let axis = 0; axis < 3; axis++) {
    const origin = ray.origin[axis];
    const dir = ray.direction[axis];

    if (Math.abs(dir) < 1e-12) {
      if (origin < min[axis] || origin > max[axis]) return null;
      continue;
    }

    const invDir = 1 / dir;
    let t1 = (min[axis] - origin) * invDir;
    let t2 = (max[axis] - origin) * invDir;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }

  if (tMax < MIN_HIT_DISTANCE) return null;
  if (tMin < MIN_HIT_DISTANCE) return null;
  return tMin;
}

export interface NodeAabb {
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
}

export function closestHierarchyHit(ray: Ray, nodes: readonly NodeAabb[]): [number, number, number] | null {
  let closestT = Infinity;
  for (const node of nodes) {
    const t = intersectRayAabb(ray, node.boundsMin, node.boundsMax);
    if (t !== null && t < closestT) {
      closestT = t;
    }
  }
  if (!Number.isFinite(closestT)) return null;

  return [
    ray.origin[0] + ray.direction[0] * closestT,
    ray.origin[1] + ray.direction[1] * closestT,
    ray.origin[2] + ray.direction[2] * closestT,
  ];
}
