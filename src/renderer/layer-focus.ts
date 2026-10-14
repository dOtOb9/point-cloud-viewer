// L2-B: 「レイヤーへカメラを移す」ときの行き先の計算。純粋関数だけを置く（テストしやすいように）。
//
// なぜ合併ではなく1レイヤーか: 別々の場所（何km も離れた、座標系も違う）ファイルを開くと、
// 全レイヤーの合併の対角線は何十万〜何百万 m になる。そこへカメラを置くと、
// どのファイルも画面上で1ピクセル未満になって見えなくなる。さらに対角線が FAR（1e7）を超えると、
// 点がすべてファープレーンの外に出て何も描かれない。1レイヤーずつ見に行く形にすれば、
// 距離は常にそのレイヤーの大きさで決まる。

import type { SceneBounds } from "./scene-bounds";

/**
 * レイヤーの注目範囲。octree のセル（立方体）の和集合があればそれを使う
 * （従来のカメラ・グリッドの決め方と同じ）。ノードが無いときだけ、ヘッダーの実データ範囲。
 */
export function layerFocusBounds(
  sceneBounds: SceneBounds | null,
  boundsMin: readonly [number, number, number],
  boundsMax: readonly [number, number, number],
): SceneBounds {
  if (sceneBounds) return sceneBounds;
  const min: [number, number, number] = [boundsMin[0], boundsMin[1], boundsMin[2]];
  const max: [number, number, number] = [boundsMax[0], boundsMax[1], boundsMax[2]];
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const diagonal = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 100;
  return { min, max, center, diagonal };
}

/** 視点移動の行き先（OrbitCamera.animateTo にそのまま渡せる形）。yaw/pitch を省くと今の向きのまま。 */
export interface FocusGoal {
  target: [number, number, number];
  distance: number;
  yaw?: number;
  pitch?: number;
}

/** 注目範囲の中心を見て、全体が収まる距離（対角線の長さ）へ。向きは `orientation` があればそれに揃える。 */
export function focusGoalFor(bounds: SceneBounds, orientation?: { yaw: number; pitch: number }): FocusGoal {
  return {
    target: [bounds.center[0], bounds.center[1], bounds.center[2]],
    distance: bounds.diagonal,
    ...(orientation ?? {}),
  };
}

/** 点の大きさ（直径px）の範囲。画面の大きさに対して現実的な値にとどめる。 */
export const MIN_POINT_SIZE_PX = 1;
export const MAX_POINT_SIZE_PX = 32;

/** 点の大きさ（直径px）の既定値。レイヤーごとに変えられる（L2-B）。変更前の固定値と同じ 4 なので、何も触らなければ見た目は変わらない。 */
export const DEFAULT_POINT_SIZE_PX = 4;

/** 点の大きさを範囲に収める。未指定・NaN は既定値。 */
export function sanitizePointSize(px: number | undefined, fallback = DEFAULT_POINT_SIZE_PX): number {
  if (px === undefined || !Number.isFinite(px)) return fallback;
  return Math.min(MAX_POINT_SIZE_PX, Math.max(MIN_POINT_SIZE_PX, px));
}
