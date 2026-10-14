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
import { screenSpaceError, surfaceSpacingPixels } from "./screen-space-error";
import { centerPriorityWeight, DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "./center-priority";
import type { CachedNode } from "./node-cache";

/**
 * LOD A: 「点間隔がこのピクセル数を下回った親」の子孫は、候補に入れない。
 * 点が画素より細かくなると、さらに細かいレベルを読んでも見た目は変わらず、
 * 点数と読み込み・描画のコストだけが増えるため（HQ-0 で、全体を見下ろすと
 * 1画素に約170点を描いていた）。
 *
 * 0.5 と 1.0 を比べて 0.5 を選んだ。0.5 は変更前とほぼ見分けがつかず、見下ろしの点数は
 * 約1/6に減る。1.0 は高層ビルの壁面が少しまばらになる軽い劣化があった
 * （測定結果は TaskSheets/HQ-high-quality-mode.md の LOD A）。
 * 設定画面には出していない。
 */
export const MIN_NODE_SPACING_PIXELS = 0.5;

/**
 * COPC のキー `d-x-y-z` から親のキーを返す。ルート（`0-0-0-0`）や、この形式で
 * ないキー（テスト用の任意の文字列など）には null を返す。
 */
export function parentKey(key: string): string | null {
  const parts = key.split("-");
  if (parts.length !== 4) return null;
  const [d, x, y, z] = parts.map(Number);
  if (![d, x, y, z].every(Number.isInteger) || d <= 0) return null;
  return `${d - 1}-${x >> 1}-${y >> 1}-${z >> 1}`;
}

/**
 * 階層の親子関係（配列ごとに1回だけ作る）。ノードは hierarchy 配列の添字で表す。
 * COPC の hierarchy は点の無いノードを含まないので、途中の階層が欠けることがある。
 * そのため各ノードは「階層に存在する、最も近い先祖」の子として繋ぐ。
 * 先祖が1つも無いノード（ルートや、`d-x-y-z` 形式でないキー）は roots に入れる。
 */
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
 *
 * 2026-10-08追記: 重みの下限`minCenterPriorityWeight`も引数として受け取り、
 * そのまま`centerPriorityWeight`に渡す。既定は`DEFAULT_MIN_CENTER_PRIORITY_WEIGHT`
 * （今までコード内に固定していた値と同じ）で、設定画面のスライダーから
 * 変更できるようにした。**0を渡すこともできるが、0にすると重みの下限による
 * 飢餓防止が効かなくなる**（`centerPriorityStrength`が大きいとき、画面端の
 * ノードの重みが実質0に近くなり、画面空間誤差がどれだけ大きくても点予算が
 * 厳しい間は選ばれ続けないことがある。`node-selection.test.ts`の
 * 「下限を0にすると」テスト参照）。
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
  minCenterPriorityWeight: number = DEFAULT_MIN_CENTER_PRIORITY_WEIGHT,
  minSpacingPixels: number = MIN_NODE_SPACING_PIXELS,
): NodeSelectionResult {
  // 根から子へたどる。次の部分木には降りない（降りても旧実装の結果は変わらないため）。
  //  (1) 視錐台の外のノードの部分木。
  //      子の AABB は親の AABB に含まれる（COPC は親の立方体を8等分する）。視錐台判定は
  //      「平面ごとに最も外側の頂点が平面の外か」なので、親がある平面の外なら、
  //      その平面に対する子の最外頂点は親のそれより内側にはならず、子も同じ平面の外になる
  //      （成分ごとに大小が保たれるので、浮動小数点でも逆転しない）。
  //      階層が欠けて孫が祖父の子になっていても、祖父の AABB は孫を含むので同じ。
  //  (2) LOD A で打ち切られた部分木。旧実装は「先祖のどれかの点間隔が閾値未満」なら
  //      そのノードを除外していた。降りる前に「このノードの点間隔が閾値未満か」を見れば、
  //      子孫は全員その先祖を持つので、判定は同じになる（点間隔は視錐台と無関係に計算）。
  // 優先度が同じノードの並びを旧実装（hierarchy 順の安定ソート）と同じにするため、
  // 候補には hierarchy の添字を持たせ、同順位は添字の小さい方を先にする。
  const tree = treeOf(hierarchy);
  const candidates: {
    key: string;
    priority: number;
    pointCount: number;
    index: number;
  }[] = [];

  const visit = (i: number): void => {
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
      key: node.key,
      priority: error * weight,
      pointCount: node.pointCount,
      index: i,
    });

    const kids = tree.children[i];
    if (kids.length === 0) return;
    // 自分の点間隔が閾値未満なら、子孫は候補にしない。純粋に画素サイズで決め、中央優先度の重みは掛けない。
    const spacing = surfaceSpacingPixels(
      viewProj,
      node.boundsMin,
      node.boundsMax,
      node.pointCount,
      canvasWidth,
      canvasHeight,
    );
    if (spacing < minSpacingPixels) return;
    for (const k of kids) visit(k);
  };
  for (const r of tree.roots) visit(r);

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
