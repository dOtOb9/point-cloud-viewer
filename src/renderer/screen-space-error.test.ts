// screen-space-error.ts のテスト。
//
// 直した不具合: `projectedBoundsDiagonalPixels` は、AABBの8頂点のうち1つでも
// ニアプレーンの後ろに回ると、他の頂点を見ずに「画面いっぱい」相当の固定値
// （canvasWidth + canvasHeight）を即座に返していた。ズームインしてカメラが
// ノードのBBOXに近づく・入り込むと、ほとんどのノードでこれが起きる。結果、
// 優先度がすべて同じ値になり、優先度による選別（=読み込むノードを絞る）が
// 機能しなくなっていた。
//
// 直した後は、ニアプレーンでAABBをクリップしてから画面上の大きさを求める。
// ここでは「クリップしても値が頂点ごとに違う（＝全ノードが最大優先度で
// 頭打ちにならない）」ことを確認する。

import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import { projectedBoundsDiagonalPixels, screenSpaceError } from "./screen-space-error";

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const MAX_PRIORITY = CANVAS_WIDTH + CANVAS_HEIGHT;

/**
 * テスト用の単純なviewProj行列。`transformPoint`は行列とワールド座標の内積でしか
 * 使われないので、実際のカメラ由来である必要はない。ここでは
 *   cx = x, cy = y, cw = z
 * となる行列を組み、「z座標がそのままクリップ空間のw」という分かりやすい対応にする
 * （z <= 0 の頂点が「カメラの後ろ」に相当する）。
 */
function axisAlignedTestViewProj(): Mat4 {
  // 列優先。列0=X基底、列1=Y基底、列2=Z基底、列3=平行移動。
  // 3行目（インデックス3,7,11,15）が transformPoint の戻り値の4番目=wを決める。
  // prettier-ignore
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 1, // z列: cz=z, cw=z
    0, 0, 0, 0,
  ];
}

describe("projectedBoundsDiagonalPixels", () => {
  it("箱がすべてニアプレーンより手前なら、通常どおり有限のサイズを返す（回帰確認）", () => {
    const viewProj = axisAlignedTestViewProj();
    const size = projectedBoundsDiagonalPixels(viewProj, [-1, -1, 5], [1, 1, 10], CANVAS_WIDTH, CANVAS_HEIGHT);

    expect(Number.isFinite(size)).toBe(true);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(MAX_PRIORITY);
  });

  it("箱がすべてニアプレーンの後ろなら、従来どおり画面いっぱい相当の値を返す", () => {
    const viewProj = axisAlignedTestViewProj();
    const size = projectedBoundsDiagonalPixels(viewProj, [-1, -1, -10], [1, 1, -5], CANVAS_WIDTH, CANVAS_HEIGHT);

    expect(size).toBe(MAX_PRIORITY);
  });

  it("箱がニアプレーンを跨ぐとき、クリップ後の値は箱の大きさによって変わる（＝一律の最大値に潰れない）", () => {
    const viewProj = axisAlignedTestViewProj();

    // 大きさの違う2つの箱を、どちらも z=0（ニアプレーン相当）を跨ぐように置く。
    const small = projectedBoundsDiagonalPixels(viewProj, [-1, -1, -1], [1, 1, 1], CANVAS_WIDTH, CANVAS_HEIGHT);
    const large = projectedBoundsDiagonalPixels(viewProj, [-5, -5, -1], [5, 5, 1], CANVAS_WIDTH, CANVAS_HEIGHT);

    expect(Number.isFinite(small)).toBe(true);
    expect(Number.isFinite(large)).toBe(true);
    // 直した後の実装では、大きい箱と小さい箱で異なる値になる。
    // 直す前は両方とも同じ MAX_PRIORITY に潰れていた。
    expect(small).not.toBe(MAX_PRIORITY);
    expect(large).not.toBe(MAX_PRIORITY);
    expect(small).not.toBe(large);
  });
});

describe("screenSpaceError: ズームインしたカメラで全ノードが最大優先度に潰れない", () => {
  it("カメラの近くに複数のノードがあっても、優先度が全部同じ最大値にならない", () => {
    // 原点付近を見る、ズームインした状態のカメラ。
    const view = lookAt([0, 0, 0.05], [0, 0, -1], [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
    const viewProj = multiply(proj, view);

    // 3x3x3のoctreeライクなノード群。カメラ(0,0,0.05)のすぐ近くに複数のノードのBBOXが
    // かかっており、その一部がニアプレーンの後ろに回る（ズームインの再現）。
    const nodeSize = 0.2;
    const priorities: number[] = [];
    for (let ix = -1; ix <= 1; ix++) {
      for (let iy = -1; iy <= 1; iy++) {
        for (let iz = -1; iz <= 1; iz++) {
          const center: [number, number, number] = [ix * nodeSize, iy * nodeSize, iz * nodeSize];
          const half = nodeSize / 2;
          const min: [number, number, number] = [center[0] - half, center[1] - half, center[2] - half];
          const max: [number, number, number] = [center[0] + half, center[1] + half, center[2] + half];
          const priority = screenSpaceError(viewProj, min, max, 1000, CANVAS_WIDTH, CANVAS_HEIGHT);
          priorities.push(priority);
        }
      }
    }

    // 直す前は、ニアプレーンに触れたノードが軒並み同一の最大値（画面いっぱい相当）に
    // 潰れていた。直した後は値がノードごとに異なるはず。
    const distinctPriorities = new Set(priorities.map((p) => Math.round(p)));
    expect(distinctPriorities.size).toBeGreaterThan(1);
  });
});
