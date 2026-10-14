// L2-D: ワールド座標の点・線分を画面（CSSピクセル）へ投影する。計測の線とラベルを
// DOM（SVG）に重ねるために使う。純粋関数。計算は f64（mat4.ts の規約）。

import { transformPoint, type Mat4 } from "./mat4";

export interface ScreenPoint {
  x: number;
  y: number;
}

type Clip = [number, number, number, number];

function toScreen(c: Clip, width: number, height: number): ScreenPoint {
  return { x: ((c[0] / c[3] + 1) / 2) * width, y: ((1 - c[1] / c[3]) / 2) * height };
}

/** 点を画面へ。カメラの後ろ（ニアプレーンより手前側）にあれば null。 */
export function projectPoint(
  viewProj: Mat4,
  p: readonly [number, number, number],
  width: number,
  height: number,
): ScreenPoint | null {
  const c = transformPoint(viewProj, p);
  // WebGPU のクリップ空間は 0 <= z <= w が視錐台の中。z < 0 はニアプレーンより手前。
  if (!(c[3] > 0) || c[2] < 0) return null;
  return toScreen(c, width, height);
}

/**
 * 線分を画面へ。カメラの後ろにはみ出す部分はニアプレーンで切る（切らないと、後ろの点が
 * 画面の反対側に投影されて、変な線が引かれる）。全部が後ろなら null。
 */
export function projectSegment(
  viewProj: Mat4,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  width: number,
  height: number,
): [ScreenPoint, ScreenPoint] | null {
  const ca = transformPoint(viewProj, a);
  const cb = transformPoint(viewProj, b);
  const inA = ca[3] > 0 && ca[2] >= 0;
  const inB = cb[3] > 0 && cb[2] >= 0;
  if (!inA && !inB) return null;
  let start: Clip = ca;
  let end: Clip = cb;
  if (!inA || !inB) {
    // z = 0（ニアプレーン）と交わる位置 t で切る。クリップ空間は線形なので、成分ごとに補間してよい。
    const t = ca[2] / (ca[2] - cb[2]);
    const cut: Clip = [
      ca[0] + (cb[0] - ca[0]) * t,
      ca[1] + (cb[1] - ca[1]) * t,
      0,
      ca[3] + (cb[3] - ca[3]) * t,
    ];
    if (!(cut[3] > 0)) return null;
    if (!inA) start = cut;
    else end = cut;
  }
  return [toScreen(start, width, height), toScreen(end, width, height)];
}
