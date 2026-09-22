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
 * レイとAABB（軸並行境界箱）の交差判定（スラブ法）。
 *
 * 交差する場合、レイ原点からの距離tのうち手前側の交点を返す（AABBの内側から
 * レイが出発する場合は0を返す）。交差しなければnull。
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

  if (tMax < 0) return null; // AABB全体がレイの後ろ側にある
  return Math.max(tMin, 0);
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
