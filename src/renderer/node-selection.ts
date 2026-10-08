// M1-4: 「このフレームでどのノードを描くか」の判定。画面空間誤差でノードに
// 優先度を付け、視錐台の外を除外し、点予算を超えたら優先度の低いノードから諦める。
//
// 元は point-cloud-renderer.ts の private メソッド（selectNodesForThisFrame）だった。
// クラスのフィールドに一切触らない純粋関数として切り出してあり、キャッシュへの
// アクセスだけ `NodeSelectionCache` インターフェース越しに受け取る。これにより
// WebGPU（デバイス・パイプライン等）を一切起動せず、vitestだけでこの判定の
// 正しさ（視錐台カリング・優先度順の選別・キャッシュ有無での toDraw/wanted の
// 振り分け）を検証できる。

import type { HierarchyNodeInfo } from "../datasource/DataSource";
import type { Mat4 } from "./mat4";
import { aabbIntersectsFrustum, type Plane } from "./frustum";
import { screenSpaceError } from "./screen-space-error";
import { centerPriorityWeight } from "./center-priority";
import type { CachedNode } from "./node-cache";

/**
 * `NodeCache` のうち、この判定が必要とする最小限の操作（`get`のみ）。
 * 本物の `NodeCache`（GPUバッファを保持する）は構造的にこれを満たすので
 * そのまま渡せるが、テストではWebGPUを使わない軽量なダブルに差し替えられる。
 */
export interface NodeSelectionCache {
  get(key: string): CachedNode | undefined;
}

/** ロードキュー（`NodeLoader.setWanted`）にそのまま渡せる形。 */
export interface WantedNode {
  key: string;
  priority: number;
}

export interface NodeSelectionResult {
  toDraw: CachedNode[];
  wanted: WantedNode[];
}

/**
 * M1-4: 画面空間誤差でノードに優先度を付け、視錐台の外を除外し、
 * 点予算を超えたら優先度の低いノードから諦める。
 *
 * ADR-0010追記: `centerPriorityStrength`（既定0=今までどおり）が0より大きいとき、
 * 画面中央からの距離に応じた重み（`centerPriorityWeight`、`center-priority.ts`）を
 * 画面空間誤差に掛けてから優先度にする。式・理由はそちらのdocコメント参照。
 */
export function selectNodesForFrame(
  hierarchy: readonly HierarchyNodeInfo[],
  planes: Plane[],
  viewProj: Mat4,
  canvasWidth: number,
  canvasHeight: number,
  pointBudget: number,
  cache: NodeSelectionCache,
  centerPriorityStrength: number = 0,
): NodeSelectionResult {
  const candidates: {
    key: string;
    priority: number;
    pointCount: number;
  }[] = [];

  for (const node of hierarchy) {
    if (!aabbIntersectsFrustum(planes, node.boundsMin, node.boundsMax)) continue;
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
    );
    candidates.push({
      key: node.key,
      priority: error * weight,
      pointCount: node.pointCount,
    });
  }

  candidates.sort((a, b) => b.priority - a.priority);

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
