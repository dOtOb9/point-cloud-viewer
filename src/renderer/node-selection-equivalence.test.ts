import { describe, expect, it } from "vitest";
import type { HierarchyNodeInfo } from "../datasource/DataSource";
import { centerPriorityWeight } from "./center-priority";
import { aabbIntersectsFrustum, frustumPlanes, type Plane } from "./frustum";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import type { CachedNode } from "./node-cache";
import {
  parentKey,
  selectNodesForFrame,
  type NodeSelectionCache,
  type NodeSelectionResult,
} from "./node-selection";
import { screenSpaceError, surfaceSpacingPixels } from "./screen-space-error";

function referenceSelect(
  hierarchy: readonly HierarchyNodeInfo[],
  planes: Plane[],
  viewProj: Mat4,
  canvasWidth: number,
  canvasHeight: number,
  pointBudget: number,
  cache: NodeSelectionCache,
  centerPriorityStrength: number,
  minCenterPriorityWeight: number,
  minSpacingPixels: number,
): NodeSelectionResult {
  const nodeMap = new Map(hierarchy.map((n) => [n.key, n]));
  const refinementStopped = new Map<string, boolean>();
  const stoppedAbove = (key: string): boolean => {
    const pk = parentKey(key);
    if (pk === null) return false;
    const memo = refinementStopped.get(key);
    if (memo !== undefined) return memo;
    const parent = nodeMap.get(pk);
    let stopped: boolean;
    if (!parent) {
      stopped = stoppedAbove(pk);
    } else {
      const parentSpacing = surfaceSpacingPixels(
        viewProj,
        parent.boundsMin,
        parent.boundsMax,
        parent.pointCount,
        canvasWidth,
        canvasHeight,
      );
      stopped = parentSpacing < minSpacingPixels || stoppedAbove(pk);
    }
    refinementStopped.set(key, stopped);
    return stopped;
  };

  const candidates: { key: string; priority: number; pointCount: number }[] = [];
  for (const node of hierarchy) {
    if (!aabbIntersectsFrustum(planes, node.boundsMin, node.boundsMax)) continue;
    if (stoppedAbove(node.key)) continue;
    const error = screenSpaceError(viewProj, node.boundsMin, node.boundsMax, node.pointCount, canvasWidth, canvasHeight);
    const weight = centerPriorityWeight(
      viewProj,
      node.boundsMin,
      node.boundsMax,
      canvasWidth,
      canvasHeight,
      centerPriorityStrength,
      minCenterPriorityWeight,
    );
    candidates.push({ key: node.key, priority: error * weight, pointCount: node.pointCount });
  }
  candidates.sort((a, b) => b.priority - a.priority);

  const toDraw: CachedNode[] = [];
  const wanted: { key: string; priority: number }[] = [];
  let budgetUsed = 0;
  for (const candidate of candidates) {
    if (budgetUsed + candidate.pointCount > pointBudget) continue;
    budgetUsed += candidate.pointCount;
    const cached = cache.get(candidate.key);
    if (cached) toDraw.push(cached);
    else wanted.push({ key: candidate.key, priority: candidate.priority });
  }
  return { toDraw, wanted };
}

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomHierarchy(rng: () => number): HierarchyNodeInfo[] {
  const maxDepth = Math.floor(rng() * 11);
  const size = 10 + rng() * 5000;
  const origin: [number, number, number] = [(rng() - 0.5) * 1000, (rng() - 0.5) * 1000, (rng() - 0.5) * 100];
  const keepProb = 0.15 + rng() * 0.5;
  const missingProb = rng() < 0.5 ? 0 : rng() * 0.4;
  const tieCounts = rng() < 0.3;
  const nodes: HierarchyNodeInfo[] = [];

  const pointCountOf = (): number => {
    if (tieCounts) return 5000;
    const r = rng();
    if (r < 0.1) return 0;
    if (r < 0.2) return 1;
    return Math.floor(1 + rng() * 200_000);
  };

  const build = (d: number, x: number, y: number, z: number, min: [number, number, number], s: number): void => {
    if (nodes.length > 3000) return;
    if (d === 0 || rng() >= missingProb) {
      nodes.push({
        key: `${d}-${x}-${y}-${z}`,
        pointCount: pointCountOf(),
        boundsMin: [min[0], min[1], min[2]],
        boundsMax: [min[0] + s, min[1] + s, min[2] + s],
      });
    }
    if (d >= maxDepth) return;
    const h = s / 2;
    for (let dx = 0; dx < 2; dx++)
      for (let dy = 0; dy < 2; dy++)
        for (let dz = 0; dz < 2; dz++) {
          if (rng() >= keepProb) continue;
          build(d + 1, x * 2 + dx, y * 2 + dy, z * 2 + dz, [min[0] + dx * h, min[1] + dy * h, min[2] + dz * h], h);
        }
  };
  build(0, 0, 0, 0, origin, size);
  if (rng() < 0.4) {
    for (let i = nodes.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [nodes[i], nodes[j]] = [nodes[j], nodes[i]];
    }
  }
  return nodes;
}

function randomViewProj(rng: () => number, nodes: HierarchyNodeInfo[], aspect: number): Mat4 {
  const root = nodes[0];
  const c: [number, number, number] = [
    (root.boundsMin[0] + root.boundsMax[0]) / 2,
    (root.boundsMin[1] + root.boundsMax[1]) / 2,
    (root.boundsMin[2] + root.boundsMax[2]) / 2,
  ];
  const extent = root.boundsMax[0] - root.boundsMin[0];
  const mode = Math.floor(rng() * 5);
  let eye: [number, number, number];
  let target: [number, number, number] = c;
  let up: [number, number, number] = [0, 0, 1];
  if (mode === 0) {
    eye = [c[0], c[1], c[2] + extent * (1 + rng() * 3)];
    up = [0, 1, 0];
  } else if (mode === 1) {
    eye = [c[0] + extent * (rng() - 0.5) * 0.2, c[1] - extent * (0.01 + rng() * 0.3), c[2] + extent * rng() * 0.2];
  } else if (mode === 2) {
    eye = [c[0] + (rng() - 0.5) * extent * 0.8, c[1] + (rng() - 0.5) * extent * 0.8, c[2] + (rng() - 0.5) * extent * 0.8];
    target = [eye[0] + rng() - 0.5, eye[1] + rng() - 0.5, eye[2] + rng() - 0.5];
  } else if (mode === 3) {
    eye = [c[0], c[1] - extent * 2, c[2] + extent];
    target = [eye[0], eye[1] - 10, eye[2]];
  } else {
    eye = [c[0] + (rng() - 0.5) * extent * 4, c[1] + (rng() - 0.5) * extent * 4, c[2] + rng() * extent * 2];
    target = [c[0] + (rng() - 0.5) * extent, c[1] + (rng() - 0.5) * extent, c[2]];
  }
  const near = mode === 2 ? 0.01 : Math.max(0.01, extent * 0.001);
  const far = Math.max(1000, extent * 20);
  const proj = perspective(Math.PI / (2.2 + rng() * 3), aspect, near, far);
  return multiply(proj, lookAt(eye, target, up));
}

const CASES = 600;

describe("selectNodesForFrame: 旧実装（全ノード走査）との等価性", () => {
  it("ランダムな階層・カメラ・設定で、toDraw と wanted（順序・priority）が旧実装と一致する", () => {
    const rng = makeRng(20261014);
    let compared = 0;
    let nonEmpty = 0;
    let withBothDroppedAndKept = 0;
    for (let n = 0; n < CASES; n++) {
      const nodes = randomHierarchy(rng);
      const width = 400 + Math.floor(rng() * 1500);
      const height = 300 + Math.floor(rng() * 900);
      const vp = randomViewProj(rng, nodes, width / height);
      const planes = frustumPlanes(vp);

      const thresholds = [0, 0.5, 1, 3];
      const minSpacing = thresholds[Math.floor(rng() * thresholds.length)];
      const strength = rng() < 0.5 ? 0 : rng() * 6;
      const minWeight = rng() < 0.5 ? 0.2 : rng();
      const total = nodes.reduce((a, b) => a + b.pointCount, 0);
      const budget = rng() < 0.3 ? 1e12 : Math.floor(total * rng());

      const cachedKeys = new Set(nodes.filter(() => rng() < 0.3).map((x) => x.key));
      const cache: NodeSelectionCache = {
        get: (key) => (cachedKeys.has(key) ? ({ key } as unknown as CachedNode) : undefined),
      };

      const expected = referenceSelect(nodes, planes, vp, width, height, budget, cache, strength, minWeight, minSpacing);
      const actual = selectNodesForFrame(nodes, planes, vp, width, height, budget, cache, strength, minWeight, minSpacing);

      expect(actual.toDraw.map((c) => c.key)).toEqual(expected.toDraw.map((c) => c.key));
      expect(actual.wanted).toEqual(expected.wanted);
      compared++;
      if (expected.toDraw.length + expected.wanted.length > 0) nonEmpty++;
      if (expected.toDraw.length + expected.wanted.length < nodes.length) withBothDroppedAndKept++;
    }
    expect(compared).toBe(CASES);
    expect(nonEmpty).toBeGreaterThan(CASES * 0.5);
    expect(withBothDroppedAndKept).toBeGreaterThan(CASES * 0.25);
  }, 60_000);
});
