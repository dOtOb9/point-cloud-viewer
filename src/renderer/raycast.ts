// カーソル位置からワールド空間のレイを作る（M1-5）。
//
// `screenPointToWorldRay()`はカーソル位置に向かってズームする機能（OrbitCamera.zoom()、
// M1-5）が使う。レイの「方向」だけを使い、AABBとの交差判定はしない
// （方向だけを使う理由はorbit-camera.tsのzoom()のコメント、および
// TaskSheets/M1-point-rendering.md M1-5節を参照。「AABBの面をカーソル下の点の代理に
// 使う」方式は構造的に成立しないため、その用途では使わなくなった）。
//
// `intersectRayAabb`/`closestHierarchyHit`はズームからはもう使われていないが、
// ROADMAP.mdの「ピッキング」（マーカー配置・計測・選択が土台にする、octreeへの
// CPUレイキャスト）に向けた汎用のレイ×AABBプリミティブとして残している。
// 使う予定が無いまま残しているわけではない: ROADMAPが名指しで挙げている機能が
// この2関数をそのまま使える形になっている。
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
 *
 * 内部の計算は`ndcPointToWorldRay`に委ねている。ここではピクセル座標をNDCに
 * 変換するだけ。
 */
export function screenPointToWorldRay(
  viewProj: Mat4,
  screenX: number,
  screenY: number,
  canvasWidth: number,
  canvasHeight: number,
): Ray | null {
  const ndcX = (screenX / canvasWidth) * 2 - 1;
  const ndcY = 1 - (screenY / canvasHeight) * 2;
  return ndcPointToWorldRay(viewProj, ndcX, ndcY);
}

/**
 * NDC座標（画面中央が(0,0)、右上が(1,1)）から、ワールド空間のレイを作る。
 * `screenPointToWorldRay`の核になる処理で、こちらは`ndcX`/`ndcY`に`[-1, 1]`の
 * 範囲外の値を渡すこともできる（全画面三角形の頂点など、画面の外側に対応する
 * NDC座標を扱いたい場合。sky.ts/ground-grid.tsが使う）。
 *
 * viewProjが特異（逆行列が求まらない）な場合はnullを返す。
 *
 * **すべてJSの数値(f64)で計算すること。** このプロジェクトのNEAR(0.01)/FAR(1e7)は
 * ダイナミックレンジが10^9あり、そこにCOPCのような大きなワールド座標
 * （例: autzenはX約637,000）が重なると、逆行列の成分は桁が大きく開く
 * （`scripts/diag-sky-ray.ts`参照）。この関数の戻り値（方向ベクトル、大きさ~1）を
 * GPUに渡す直前でf32にキャストする分にはなにも問題ない
 * （unormalizeした値ではなく正規化済みの小さい値だから）が、**逆行列や
 * この関数の内部の計算そのものをf32にしてはいけない**（`mat4.ts`冒頭の規約）。
 */
export function ndcPointToWorldRay(viewProj: Mat4, ndcX: number, ndcY: number): Ray | null {
  const inv = invert(viewProj);
  if (!inv) return null;

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
 * 点群にわずかでも寄るとルートノードのAABBの内側に入るため、（当時これを使って
 * いた）ズーム機能では、ズームするたびに「交点＝カメラ位置そのもの」が返り、
 * targetがカメラへ吸い寄せられて逆に寄れなくなる不具合を生んだ
 * （M1-point-rendering.md M1-5「実機確認で見つかった不具合」参照）。
 * ズームは今この関数を使っていない（zoom()はAABBではなく方向だけを使う方式に
 * 変更した）が、「カメラを含む箱を交点として選んでしまう」のは将来のピッキング
 * 用途でも同様に無意味なので、この定数とガードは残している。
 */
const MIN_HIT_DISTANCE = 0.01;

/**
 * レイとAABB（軸並行境界箱）の交差判定（スラブ法）。
 *
 * 交差する場合、レイ原点からの距離t（MIN_HIT_DISTANCEより大きい、手前側の交点）を
 * 返す。レイ原点がAABBの内側にある（＝カメラがそのノードの中にいる）場合や、
 * 交点がMIN_HIT_DISTANCE以下しかない場合はnullを返す。「カメラを含む箱に向かって
 * 寄る」ことに意味は無いため。
 *
 * ズームからは使われなくなったが、ROADMAP.mdの「ピッキング」が挙げる将来機能
 * （マーカー配置・計測・選択）向けの汎用プリミティブとして残している（ファイル
 * 冒頭のコメント参照）。
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
 * どのノードとも交差しなければnull。
 *
 * ズームからは使われなくなった（AABBの面をカーソル下の点の代理に使う方式が
 * 構造的に成立しないため。orbit-camera.tsのzoom()のコメント参照）。
 * ROADMAP.mdの「ピッキング」が挙げる将来機能（マーカー配置・計測・選択）向けの
 * 汎用プリミティブとして残している。使うときの注意点は変わらない: 呼び出し側は
 * `nodes`を**実際に描画中のノード**に限ること。hierarchy全体（内部ノード込み）を
 * 渡すと、内部ノードのAABBは子を入れ子に包んでいるため、最近傍の交点は常に
 * 最も粗い外側の箱が勝ってしまい、実際の表面まで届かない
 * （M1-point-rendering.md M1-5「実機確認で見つかった不具合」参照）。
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
