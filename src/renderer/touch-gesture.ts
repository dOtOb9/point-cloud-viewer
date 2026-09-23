// 2本指ジェスチャ（ピンチズーム・2本指パン）の計算だけを切り出した純粋関数。
// DOM（PointerEvent等）にもOrbitCameraにも依存しないので、vitestで直接検証できる
// （M3-6の必須要件: 「2本の指の座標列→ズーム倍率・パン量」の単体テスト）。
//
// 呼び出し側（orbit-camera.tsのattachOrbitControls）は、直前フレームと現フレームの
// 2点をそれぞれ渡すだけでよい。ズームとパンは同時に起こりうる（現実の2本指操作は
// 「広げながらずらす」ことが普通にあるため）ので、両方を1回でまとめて返す。

export interface TouchPoint {
  x: number;
  y: number;
}

export interface TwoPointerGestureDelta {
  /** 中点の移動量。OrbitCamera.pan(dx, dy)にそのまま渡せる。 */
  panDeltaX: number;
  panDeltaY: number;
  /**
   * ズーム倍率。OrbitCamera.zoom(factor)にそのまま渡せる（1未満で拡大、1より大きいと縮小。
   * orbit-camera.tsのonWheelと同じ符号の向き）。
   */
  zoomFactor: number;
  /** 現フレームの2本指の中点。ズーム先（getCursorDirectionへ渡す画面座標）に使う。 */
  midpoint: TouchPoint;
}

function midpoint(a: TouchPoint, b: TouchPoint): TouchPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: TouchPoint, b: TouchPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// 指が重なる・重なりかけている瞬間に距離が0へ近づき、比率(zoomFactor)が発散したり
// NaNになったりしないための下限。
const MIN_DISTANCE = 1e-3;

/**
 * 直前フレーム(prev)と現フレーム(curr)の2本指の座標から、パン量とズーム倍率を求める。
 *
 * - パン: 中点の移動量をそのまま使う（中ドラッグパンと同じ考え方）。
 * - ズーム: 2点間の距離の変化から倍率を出す。指を広げる（距離が増える）と
 *   `zoomFactor < 1`（拡大）になる。orbit-camera.tsのonWheelでは
 *   `deltaY > 0`（下スクロール、遠ざける操作）で`factor = ZOOM_STEP(>1)`にしているのと
 *   同じ向き（factorが小さいほど寄る）に揃えている。
 *
 * prev/currの2点はインデックスで対応している前提（呼び出し側が同じ指同士を
 * 同じ位置に並べて渡す）。この関数自体はどちらがどの指かを区別しない。
 */
export function computeTwoPointerGesture(
  prev: readonly [TouchPoint, TouchPoint],
  curr: readonly [TouchPoint, TouchPoint],
): TwoPointerGestureDelta {
  const prevMid = midpoint(prev[0], prev[1]);
  const currMid = midpoint(curr[0], curr[1]);

  const prevDist = Math.max(distance(prev[0], prev[1]), MIN_DISTANCE);
  const currDist = Math.max(distance(curr[0], curr[1]), MIN_DISTANCE);

  return {
    panDeltaX: currMid.x - prevMid.x,
    panDeltaY: currMid.y - prevMid.y,
    zoomFactor: prevDist / currDist,
    midpoint: currMid,
  };
}
