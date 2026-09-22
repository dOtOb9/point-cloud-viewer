// カーソル位置からワールド空間のレイを作り、octreeノードのAABBとの交差を調べる（M1-5）。
//
// 正確なピッキング（深度バッファの読み出し）はM5まで待つ。ここではhierarchyのノードAABBへの
// 粗いレイキャストで十分（M1-point-rendering.md M1-5参照）。ズームをカーソル位置に向かって
// 寄せるために、「カーソルの下に何があるか」をおおまかに知りたいだけなので、ピクセル単位の
// 精度は要らない。
//
// このファイルはReactを知らない（規約3）。行列とAABBの配列だけを受け取る。

import { invert, transformPoint, type Mat4 } from "./mat4";

export interface Ray {
  origin: [number, number, number];
  /** 正規化済み。 */
  direction: [number, number, number];
}

/**
 * キャンバス上のピクセル座標（左上原点、Y下向き）から、ワールド空間のレイを作る。
 * viewProjの逆行列で、ニアプレーン上の点とファープレーン上の点をワールド座標に戻し、
 * その2点を結ぶ直線をレイとする。
 *
 * viewProjが特異（逆行列が求まらない）な場合はnullを返す。
 */
export function screenPointToWorldRay(
  viewProj: Mat4,
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
): Ray | null {
  const inv = invert(viewProj);
  if (!inv) return null;

  const ndcX = (screenX / canvasWidth) * 2 - 1;
  const ndcY = 1 - (screenY / canvasHeight) * 2;

  // このプロジェクトのperspective()（mat4.ts）はWebGPU規約のNDC z: 0(near)..1(far)を使う。
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

/**
 * レイ原点からの距離がこれ未満の交点は候補にしない。screenPointToWorldRayが作る
 * レイの原点はニアプレーン上の点、つまりほぼカメラ位置なので、ここでの「わずか」は
 * ニアプレーン距離（NEAR、point-cloud-renderer.tsで0.01）程度で十分。
 *
 * 過去にここを`Math.max(tMin, 0)`にしていたことがあり、その場合レイ原点がAABBの
 * 内側にあると（＝カメラがoctreeノードの中にいると）0を返していた。カメラは
 * 点群にわずかでも寄るとルートノードのAABBの内側に入るため、ズームするたびに
 * 「交点＝カメラ位置そのもの」が返り、targetがカメラへ吸い寄せられて逆に
 * 寄れなくなる不具合を生んだ（M1-point-rendering.md M1-5「実機確認で見つかった
 * 不具合」参照）。この定数はその再発防止のためにある。
 */
const MIN_HIT_DISTANCE = 0.01;

/**
 * レイとAABB（軸並行境界箱）の交差判定（スラブ法）。
 *
 * 交差する場合、レイ原点からの距離t（MIN_HIT_DISTANCEより大きい、手前側の交点）を
 * 返す。レイ原点がAABBの内側にある（＝カメラがそのノードの中にいる）場合や、
 * 交点がMIN_HIT_DISTANCE以下しかない場合はnullを返す。「カメラを含む箱に向かって
 * 寄る」ことに意味は無いため。
 */
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
      // レイがこの軸と平行。原点がスラブの外にあれば、この軸方向には絶対に交わらない。
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

  if (tMax < MIN_HIT_DISTANCE) return null; // AABB全体がレイの後ろ側にある
  if (tMin < MIN_HIT_DISTANCE) return null; // レイ原点がAABBの内側（またはすぐ後ろ）にある
  return tMin;
}

export interface NodeAabb {
  boundsMin: readonly [number, number, number];
  boundsMax: readonly [number, number, number];
}

/**
 * hierarchyのノード群のうち、レイと交差する中で最も近い交点（ワールド座標）を返す。
 * どのノードとも交差しなければnull（呼び出し側は、空を指しているときと同様に
 * 従来どおりtargetへ向かって寄るフォールバックを使う）。
 */
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

/**
 * カーソル位置（キャンバスのピクセル座標）の下にある点をおおまかに求める（M1-5）。
 * screenPointToWorldRayでレイを作り、candidateAabbsの中で最も近い交点を返す。
 *
 * `candidateAabbs`は**その時点で実際に描画されているノード**のAABBに限定すること。
 * hierarchy全体（全LODレベルの全ノード）を渡すと、内部ノードのAABBは子を入れ子に
 * 包んでいるため、最近傍の交点を取ると常に最も粗い外側の箱が勝ってしまい、
 * カーソル下の実際の表面まで届かない（M1-point-rendering.md M1-5
 * 「実機確認で見つかった不具合」参照）。
 *
 * viewProjがまだ無い、レイが作れない、candidateAabbsが空、どの候補とも交差しない、
 * のいずれかの場合はnull（呼び出し側はtargetへ向かって寄るフォールバックを使う）。
 */
export function pickWorldPointUnderCursor(
  viewProj: Mat4,
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
  candidateAabbs: readonly NodeAabb[],
): [number, number, number] | null {
  if (candidateAabbs.length === 0) return null;
  const ray = screenPointToWorldRay(viewProj, screenX, screenY, canvasWidth, canvasHeight);
  if (!ray) return null;
  return closestHierarchyHit(ray, candidateAabbs);
}
