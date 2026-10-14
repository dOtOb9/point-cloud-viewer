// L2-D: 画面の点から3次元の点を取る（ピック）ための純粋な数式。
//
// 方針: 点のデータは CPU に持っていないので、「描いた深度を GPU から読み戻して逆投影する」。
// ところがこのプロジェクトの射影は NEAR=0.01・FAR=1e7 で、24bit の深度では遠くの分解能が粗い
// （目安: 距離 z での 1 刻みは z^2/NEAR * 2^-24。z=100 なら約0.06、z=3000 なら約54）。
// そのため2段階にする:
//   1. 描画済みの深度を読んで、おおよその距離 z を得る（粗い）
//   2. z の前後だけを near/far にした狭い射影で、クリック位置の周りの数ピクセルだけ描き直し、
//      その深度を読む（細かい）。near/far が狭いので 24bit でも十分な分解能になる
// 逆投影は必ず JS の数値（f64）で行う。座標が60万台でも精度が落ちない（raycast.ts の規約と同じ）。
// このファイルは WebGPU も React も知らない。

import { invert, transformPoint, type Mat4 } from "./mat4";

/** 1段階目に読む窓の半径（窓は 2*半径+1 ピクセル四方）。点は数ピクセルの大きさなので、少しの隙間は許す。 */
export const COARSE_HALF = 4;
/** 2段階目に描き直す窓の半径。 */
export const REFINE_HALF = 2;

/** 深度バッファのビット数（depth24plus）。 */
const DEPTH_BITS = 24;

/**
 * 射影後の深度 d（0..1、WebGPU 規約）から、カメラの前方向への距離 z（= クリップ座標の w）を求める。
 * mat4.ts の perspective の逆: d = far*(z-near) / (z*(far-near))  →  z = near*far / (far - d*(far-near))
 */
export function depthToEyeDistance(depth: number, near: number, far: number): number {
  return (near * far) / (far - depth * (far - near));
}

/** 距離 z のあたりで、深度 1 刻みが距離のどれだけに当たるか（近似ではなく式どおり）。 */
export function depthQuantumAt(z: number, near: number, far: number): number {
  return ((z * z * (far - near)) / (near * far)) * 2 ** -DEPTH_BITS;
}

/**
 * 2段階目の near/far。粗い距離 z の前後に「粗い刻みの数個分」の余裕を取る。
 * 余裕の 4 刻みは、1段階目の量子化誤差（±0.5刻み）と、読んだ画素と中心画素の距離の差を
 * 余裕をもって含める経験的な値（未検証。足りなければ2段階目で何も当たらず、1段階目の値に戻る）。
 */
export function refineDepthRange(z: number, near: number, far: number): { near: number; far: number } {
  const margin = 4 * depthQuantumAt(z, near, far);
  return { near: Math.max(near, z - margin), far: Math.min(far, z + margin) };
}

/**
 * 読み戻した窓（size×size、行優先）から、中心にいちばん近い「点がある」画素を選ぶ。
 * 点がある = 深度が 0 より大きく 1（クリア値）より小さい。同じ距離なら深度の小さい（手前の）ほう。
 * 無ければ null（背景をクリックしたということ）。
 */
export function nearestHit(depths: Float32Array, size: number): { ix: number; iy: number; depth: number } | null {
  const center = (size - 1) / 2;
  let best: { ix: number; iy: number; depth: number } | null = null;
  let bestDist = Infinity;
  for (let iy = 0; iy < size; iy++) {
    for (let ix = 0; ix < size; ix++) {
      const d = depths[iy * size + ix];
      if (!(d > 0 && d < 1)) continue;
      const dist = (ix - center) ** 2 + (iy - center) ** 2;
      if (dist < bestDist || (dist === bestDist && best !== null && d < best.depth)) {
        best = { ix, iy, depth: d };
        bestDist = dist;
      }
    }
  }
  return best;
}

/**
 * 画面（幅 width × 高さ height ピクセル）の中の、(cx, cy) を中心とする size×size ピクセルの窓だけを
 * テクスチャいっぱいに映す viewProj を作る。窓の1ピクセルは元の画面の1ピクセルと同じ大きさ
 * （点の大きさ・形が元の描画と同じになる）。
 *
 * クリップ座標の x, y を「窓の中心が0・窓の端が±1」になるよう、行列の左から掛ける
 * （w は変えないので、深度は元と同じ式のまま）。
 */
export function windowViewProj(viewProj: Mat4, cx: number, cy: number, size: number, width: number, height: number): Mat4 {
  const half = (size - 1) / 2;
  // 窓の左右・上下の端を NDC にする（ピクセル中心の座標 cx は整数。ピクセル cx の左端が cx）。
  const x0 = ((cx - half) / width) * 2 - 1;
  const x1 = ((cx + half + 1) / width) * 2 - 1;
  const y0 = 1 - ((cy - half) / height) * 2; // 窓の上端
  const y1 = 1 - ((cy + half + 1) / height) * 2; // 窓の下端
  const centerX = (x0 + x1) / 2;
  const scaleX = (x1 - x0) / 2;
  const centerY = (y0 + y1) / 2;
  const scaleY = (y0 - y1) / 2;
  const out = viewProj.slice();
  for (let col = 0; col < 4; col++) {
    const w = viewProj[col * 4 + 3];
    out[col * 4 + 0] = (viewProj[col * 4 + 0] - centerX * w) / scaleX;
    out[col * 4 + 1] = (viewProj[col * 4 + 1] - centerY * w) / scaleY;
  }
  return out;
}

/**
 * 窓の中の画素 (ix, iy)（窓の左上が (0,0)）の中心と、その深度から、ワールド座標へ戻す。
 * `windowVP` は `windowViewProj` の結果。行列が特異なら null。
 */
export function unprojectWindowSample(
  windowVP: Mat4,
  ix: number,
  iy: number,
  size: number,
  depth: number,
): [number, number, number] | null {
  const inv = invert(windowVP);
  if (!inv) return null;
  const ndcX = ((ix + 0.5) / size) * 2 - 1;
  const ndcY = 1 - ((iy + 0.5) / size) * 2;
  const [x, y, z, w] = transformPoint(inv, [ndcX, ndcY, depth]);
  if (Math.abs(w) < 1e-12) return null;
  return [x / w, y / w, z / w];
}
