import type { HierarchyNodeInfo } from "../datasource/DataSource";
import type { Mat4 } from "./mat4";
import { aabbIntersectsFrustum, type Plane } from "./frustum";
import { screenSpaceError, surfaceSpacingPixels } from "./screen-space-error";
import { centerPriorityWeight, DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "./center-priority";
import type { CachedNode } from "./node-cache";

export const MIN_NODE_SPACING_PIXELS = 0.5;

export function parentKey(key: string): string | null {
  const parts = key.split("-");
  if (parts.length !== 4) return null;
  const [d, x, y, z] = parts.map(Number);
  if (![d, x, y, z].every(Number.isInteger) || d <= 0) return null;
  return `${d - 1}-${x >> 1}-${y >> 1}-${z >> 1}`;
}

interface HierarchyTree {
  roots: number[];
  children: number[][];
}

const treeCache = new WeakMap<readonly HierarchyNodeInfo[], HierarchyTree>();

function treeOf(hierarchy: readonly HierarchyNodeInfo[]): HierarchyTree {
  let tree = treeCache.get(hierarchy);
  if (tree) return tree;

  const indexByKey = new Map<string, number>();
  hierarchy.forEach((n, i) => indexByKey.set(n.key, i));

  const roots: number[] = [];
  const children: number[][] = hierarchy.map(() => []);
  hierarchy.forEach((n, i) => {
    let ancestor = parentKey(n.key);
    while (ancestor !== null) {
      const p = indexByKey.get(ancestor);
      if (p !== undefined) {
        children[p].push(i);
        return;
      }
      ancestor = parentKey(ancestor);
    }
    roots.push(i);
  });
  tree = { roots, children };
  treeCache.set(hierarchy, tree);
  return tree;
}

export interface NodeSelectionCache {
  get(key: string): CachedNode | undefined;
}

export interface WantedNode {
  key: string;
  priority: number;
}

export interface SelectionLayer {
  keyPrefix: string;
  hierarchy: readonly HierarchyNodeInfo[];
}

export interface NodeSelectionResult {
  toDraw: CachedNode[];
  wanted: WantedNode[];
}

export function selectNodesForFrame(
  hierarchy: readonly HierarchyNodeInfo[],
  planes: Plane[],
  viewProj: Mat4,
  canvasWidth: number,
  canvasHeight: number,
  pointBudget: number,
  cache: NodeSelectionCache,
  centerPriorityStrength: number = 0,
  minCenterPriorityWeight: number = DEFAULT_MIN_CENTER_PRIORITY_WEIGHT,
  minSpacingPixels: number = MIN_NODE_SPACING_PIXELS,
): NodeSelectionResult {
  return selectNodesForLayers(
    [{ keyPrefix: "", hierarchy }],
    planes,
    viewProj,
    canvasWidth,
    canvasHeight,
    pointBudget,
    cache,
    centerPriorityStrength,
    minCenterPriorityWeight,
    minSpacingPixels,
  );
}

export function selectNodesForLayers(
  layers: readonly SelectionLayer[],
  planes: Plane[],
  viewProj: Mat4,
  canvasWidth: number,
  canvasHeight: number,
  pointBudget: number,
  cache: NodeSelectionCache,
  centerPriorityStrength: number = 0,
  minCenterPriorityWeight: number = DEFAULT_MIN_CENTER_PRIORITY_WEIGHT,
  minSpacingPixels: number = MIN_NODE_SPACING_PIXELS,
): NodeSelectionResult {
  const candidates: {
    key: string;
    priority: number;
    pointCount: number;
    index: number;
  }[] = [];

  const visit = (
    hierarchy: readonly HierarchyNodeInfo[],
    tree: HierarchyTree,
    keyPrefix: string,
    offset: number,
    i: number,
  ): void => {
    const node = hierarchy[i];
    if (!aabbIntersectsFrustum(planes, node.boundsMin, node.boundsMax)) return;
    const error = screenSpaceError(
      viewProj,
      node.boundsMin,
      node.boundsMax,
      node.pointCount,
      canvasWidth,
      canvasHeight,
    );
    const weight = centerPriorityWeight(
      viewProj,
      node.boundsMin,
      node.boundsMax,
      canvasWidth,
      canvasHeight,
      centerPriorityStrength,
      minCenterPriorityWeight,
    );
    candidates.push({
      key: keyPrefix + node.key,
      priority: error * weight,
      pointCount: node.pointCount,
      index: offset + i,
    });

    const kids = tree.children[i];
    if (kids.length === 0) return;
    const spacing = surfaceSpacingPixels(
      viewProj,
      node.boundsMin,
      node.boundsMax,
      node.pointCount,
      canvasWidth,
      canvasHeight,
    );
    if (spacing < minSpacingPixels) return;
    for (const k of kids) visit(hierarchy, tree, keyPrefix, offset, k);
  };
  let offset = 0;
  for (const layer of layers) {
    const tree = treeOf(layer.hierarchy);
    for (const r of tree.roots) visit(layer.hierarchy, tree, layer.keyPrefix, offset, r);
    offset += layer.hierarchy.length;
  }

  candidates.sort((x, y) => y.priority - x.priority || x.index - y.index);

  const toDraw: CachedNode[] = [];
  const wanted: WantedNode[] = [];
  let budgetUsed = 0;

  for (const candidate of candidates) {
    if (budgetUsed + candidate.pointCount > pointBudget) continue;
    budgetUsed += candidate.pointCount;

    const cached = cache.get(candidate.key);
    if (cached) {
      toDraw.push(cached);
    } else {
      wanted.push({ key: candidate.key, priority: candidate.priority });
    }
  }

  return { toDraw, wanted };
}
