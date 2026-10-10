// AN-2: ダブルクリック/ダブルタップで「その点へ寄る」ときの、行き先の計算（純粋関数）。
// GPU・DOM・OrbitCameraに依存しないので、vitestで直接検証できる。

import { FLY_TO_DISTANCE_RATIO } from "./animation";
import { intersectRayAabb, type NodeAabb, type Ray } from "./raycast";

/**
 * レイと、**実際に描画中のノード**のAABBとの交点のうち、最も細かい（小さい）ノードの
 * 手前側の交点を返す。どれとも交差しなければnull。
 *
 * `raycast.ts`の`closestHierarchyHit`は「最も近い交点」を返すが、描画中のノードには
 * 粗い親と細かい子が重なって含まれる（COPCは子が親に点を足す形）ため、最も近い交点は
 * 常に最も粗い外側の箱になり、実際の点群の表面まで届かない（同ファイルのコメント参照）。
 * ここでは交差する箱のうち一番小さい（=一番細かい）ものを選び、その手前の面の交点を使う。
 * 箱の面は点の代理でしかないので、ズームのように繰り返し寄る用途ではなく、
 * 視点を一度移すだけのこの用途に限って使う。
 */
export function pickFlyToPoint(ray: Ray, nodes: readonly NodeAabb[]): [number, number, number] | null {
  let bestSize = Infinity;
  let bestT: number | null = null;
  for (const node of nodes) {
    const t = intersectRayAabb(ray, node.boundsMin, node.boundsMax);
    if (t === null) continue;
    const size = Math.max(
      node.boundsMax[0] - node.boundsMin[0],
      node.boundsMax[1] - node.boundsMin[1],
      node.boundsMax[2] - node.boundsMin[2],
    );
    // 同じ大きさなら、手前のほうを選ぶ
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

/** 行き先: 注視点は交点そのもの、距離は現在の`FLY_TO_DISTANCE_RATIO`倍。 */
export function flyToGoal(
  hit: readonly [number, number, number],
  currentDistance: number,
): { target: [number, number, number]; distance: number } {
  return {
    target: [hit[0], hit[1], hit[2]],
    distance: currentDistance * FLY_TO_DISTANCE_RATIO,
  };
}
