// M1-4: ノードのBBOXを投影して画面上の大きさを求め、点密度で割って「誤差」を出す。
// 誤差が大きいノードほど「粗く見えている」ので優先的にロードする
// （M1-point-rendering.md M1-4: 「ノードのBBOXを投影し、画面上の大きさ ÷ そのノードの
// 点密度から誤差を出す。大きいものほど優先」）。

import { transformPoint, type Mat4 } from "./mat4";

/**
 * AABBの8頂点をviewProjで投影し、画面上でのバウンディング矩形の対角線の長さ（ピクセル）を返す。
 * カメラの後ろ・ごく近くに頂点がある場合は「画面いっぱい」相当の大きな値を返す
 * （近すぎるノードは真っ先に精細化したいので、それで都合がよい）。
 */
export function projectedBoundsDiagonalPixels(
  viewProj: Mat4,
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  canvasWidth: number,
  canvasHeight: number,
): number {
  const corners: [number, number, number][] = [
    [min[0], min[1], min[2]],
    [max[0], min[1], min[2]],
    [min[0], max[1], min[2]],
    [max[0], max[1], min[2]],
    [min[0], min[1], max[2]],
    [max[0], min[1], max[2]],
    [min[0], max[1], max[2]],
    [max[0], max[1], max[2]],
  ];

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const corner of corners) {
    const [cx, cy, , cw] = transformPoint(viewProj, corner);
    if (cw <= 1e-6) {
      // カメラの後ろ・至近距離。画面いっぱいとして最優先扱いにする。
      return canvasWidth + canvasHeight;
    }
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    const px = ((ndcX + 1) / 2) * canvasWidth;
    const py = ((1 - ndcY) / 2) * canvasHeight;
    minX = Math.min(minX, px);
    maxX = Math.max(maxX, px);
    minY = Math.min(minY, py);
    maxY = Math.max(maxY, py);
  }

  return Math.hypot(maxX - minX, maxY - minY);
}

/**
 * ノードの「誤差」= 画面上の大きさ ÷ 点密度。大きいほど優先度が高い
 * （画面上で大きく見えているのに点がまばら＝粗い、ということ）。
 */
export function screenSpaceError(
  viewProj: Mat4,
  boundsMin: readonly [number, number, number],
  boundsMax: readonly [number, number, number],
  pointCount: number,
  canvasWidth: number,
  canvasHeight: number,
): number {
  const sizePixels = projectedBoundsDiagonalPixels(viewProj, boundsMin, boundsMax, canvasWidth, canvasHeight);

  const dx = Math.max(boundsMax[0] - boundsMin[0], 1e-6);
  const dy = Math.max(boundsMax[1] - boundsMin[1], 1e-6);
  const dz = Math.max(boundsMax[2] - boundsMin[2], 1e-6);
  const volume = dx * dy * dz;
  const density = Math.max(pointCount, 1) / volume;

  return sizePixels / density;
}
