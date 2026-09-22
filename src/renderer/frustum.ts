// 視錐台カリング（M1-4）。viewProj行列から6平面を取り出し、AABBと交差判定する。
// 定番のやり方（Gribb & Hartmann）をそのまま使う。

import type { Mat4 } from "./mat4";

/** 平面 ax+by+cz+d=0 を [a,b,c,d] で表す。法線は視錐台の内側を向く。 */
export type Plane = [number, number, number, number];

/** viewProj行列（列優先）から6平面（left,right,bottom,top,near,far）を取り出す。 */
export function frustumPlanes(viewProj: Mat4): Plane[] {
  const m = viewProj;
  // 行を取り出す（列優先格納なので、行rowの要素は m[row], m[4+row], m[8+row], m[12+row]）。
  const row = (r: number): [number, number, number, number] => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);

  const add = (a: number[], b: number[]): Plane => [a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3]];
  const sub = (a: number[], b: number[]): Plane => [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];

  const planes: Plane[] = [
    add(r3, r0), // left
    sub(r3, r0), // right
    add(r3, r1), // bottom
    sub(r3, r1), // top
    add(r3, r2), // near (WebGPUのNDC z: 0..1 でもこの式で近似的に十分)
    sub(r3, r2), // far
  ];

  return planes.map(normalizePlane);
}

function normalizePlane(p: Plane): Plane {
  const len = Math.hypot(p[0], p[1], p[2]) || 1;
  return [p[0] / len, p[1] / len, p[2] / len, p[3] / len];
}

/**
 * AABB（ワールド座標）が視錐台と交差するか。
 * 各平面について「AABBの最も外側にある頂点」が平面の外側にあれば、完全に外側と判定する
 * （標準的なAABB-frustum判定。厳密な交差判定ではなく、外にあるものを確実に弾く近似）。
 */
export function aabbIntersectsFrustum(
  planes: Plane[],
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): boolean {
  for (const [a, b, c, d] of planes) {
    // 平面の法線方向に最も遠い頂点（positive vertex）を選ぶ。
    const px = a >= 0 ? max[0] : min[0];
    const py = b >= 0 ? max[1] : min[1];
    const pz = c >= 0 ? max[2] : min[2];
    if (a * px + b * py + c * pz + d < 0) {
      return false; // この平面の外側に完全に出ている
    }
  }
  return true;
}
