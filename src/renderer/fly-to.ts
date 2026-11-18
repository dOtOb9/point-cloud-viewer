import { FLY_TO_DISTANCE_RATIO } from "./animation";
import { intersectRayAabb, type NodeAabb, type Ray } from "./raycast";

export function pickFlyToPoint(
  ray: Ray,
  nodes: readonly NodeAabb[],
  clip?: NodeAabb,
): [number, number, number] | null {
  let bestSize = Infinity;
  let bestT: number | null = null;
  for (const node of nodes) {
    let lo = node.boundsMin;
    let hi = node.boundsMax;
    if (clip) {
      lo = [Math.max(lo[0], clip.boundsMin[0]), Math.max(lo[1], clip.boundsMin[1]), Math.max(lo[2], clip.boundsMin[2])];
      hi = [Math.min(hi[0], clip.boundsMax[0]), Math.min(hi[1], clip.boundsMax[1]), Math.min(hi[2], clip.boundsMax[2])];
      if (lo[0] > hi[0] || lo[1] > hi[1] || lo[2] > hi[2]) continue;
    }
    const t = intersectRayAabb(ray, lo, hi);
    if (t === null) continue;
    const size = Math.max(
      node.boundsMax[0] - node.boundsMin[0],
      node.boundsMax[1] - node.boundsMin[1],
      node.boundsMax[2] - node.boundsMin[2],
    );
    if (size < bestSize || (size === bestSize && bestT !== null && t < bestT)) {
      bestSize = size;
      bestT = t;
    }
  }
  if (bestT === null) return null;
  return [
    ray.origin[0] + ray.direction[0] * bestT,
    ray.origin[1] + ray.direction[1] * bestT,
    ray.origin[2] + ray.direction[2] * bestT,
  ];
}

export function flyToGoal(
  hit: readonly [number, number, number],
  currentDistance: number,
): { target: [number, number, number]; distance: number } {
  return {
    target: [hit[0], hit[1], hit[2]],
    distance: currentDistance * FLY_TO_DISTANCE_RATIO,
  };
}
