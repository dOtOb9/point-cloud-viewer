import type { HierarchyNodeInfo } from "../datasource/DataSource";
import type { ValueRange } from "./colormap";

export interface SceneBounds {
  min: [number, number, number];
  max: [number, number, number];
  center: [number, number, number];
  diagonal: number;
}

export function computeSceneBounds(nodes: readonly HierarchyNodeInfo[]): SceneBounds | null {
  if (nodes.length === 0) return null;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const node of nodes) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], node.boundsMin[axis]);
      max[axis] = Math.max(max[axis], node.boundsMax[axis]);
    }
  }
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 100;

  return { min, max, center, diagonal };
}

export function mergeSceneBounds(list: readonly SceneBounds[]): SceneBounds | null {
  if (list.length === 0) return null;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const b of list) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], b.min[axis]);
      max[axis] = Math.max(max[axis], b.max[axis]);
    }
  }
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 100;
  return { min, max, center, diagonal };
}

export function elevationRangeFromCloudBounds(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): ValueRange {
  return { min: min[2], max: max[2] };
}
