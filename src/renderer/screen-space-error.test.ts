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

describe("screenSpaceError: 新しい式（点間隔×ピクセル/ワールド単位）", () => {
  // 2026-09-23の診断: 旧式 `sizePixels / density`（density = 点数/体積）は
  // 「まばらさ」を体積÷点数（点間隔の3乗）で測っており、次元が合っていなかった。
  // 1レベル下がるごとに体積が1/8・点数はほぼ一定（sofi.copc.lazの実測でも
  // レベルによらず約25,000点/ノードだった）なので、旧式では誤差が
  // 1/8 × sizePixelsの1/2 = 約1/16に落ちてしまい、深いノードが事実上
  // 読み込まれなくなっていた（TaskSheets/M1-point-rendering.md M1-4参照）。
  //
  // 新式は「点間隔(ワールド) × ピクセル/ワールド単位」。点間隔は体積÷点数の
  // 3乗根（1次元）なので、1レベル下がる（体積1/8）と点間隔はちょうど1/2になる。
  // ピクセル/ワールド単位は距離が同じなら変わらないので、誤差もちょうど1/2に
  // なるはず。

  /** カメラを (0,0,distance) に置き、原点方向を見るテスト用viewProj。 */
  function cameraAt(distance: number): Mat4 {
    const view = lookAt([0, 0, distance], [0, 0, 0], [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1e7);
    return multiply(proj, view);
  }

  /** 原点中心、一辺sideの立方体のBBOX。 */
  function cubeBounds(side: number): [[number, number, number], [number, number, number]] {
    const h = side / 2;
    return [
      [-h, -h, -h],
      [h, h, h],
    ];
  }

  it("親ノードと子ノード（体積1/8・点数同じ・同じカメラ距離）の誤差比は約1/2になる", () => {
    // 親: 一辺10、子: 一辺5（体積は (5/10)^3 = 1/8）。どちらもカメラから
    // 距離100（一辺よりずっと遠いので、投影の非線形性がほぼ効かない）に置く。
    // 点数は同じ25,000（sofi.copc.lazの実測でレベルによらずほぼ一定だった値）。
    const viewProj = cameraAt(100);
    const pointCount = 25000;

    const [parentMin, parentMax] = cubeBounds(10);
    const [childMin, childMax] = cubeBounds(5);

    const parentError = screenSpaceError(viewProj, parentMin, parentMax, pointCount, CANVAS_WIDTH, CANVAS_HEIGHT);
    const childError = screenSpaceError(viewProj, childMin, childMax, pointCount, CANVAS_WIDTH, CANVAS_HEIGHT);

    const ratio = childError / parentError;
    // 実測(npx tsxでの手計算確認): ratio ≈ 0.4872。
    // 直す前の式（体積÷点数を使う版）だとこの比は約1/16（0.0625付近）に
    // なり、この範囲には入らない。
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  it("レベル差3（誤差比 約1/8）でも、距離が約1/8近い深いノードのほうが優先度が高くなる", () => {
    // 浅いノード: 一辺80、距離850。
    // 深いノード: 3レベル分細かい（一辺 80/8 = 10。体積は (1/8)^3 = 1/512、
    // 点間隔の比は cbrt(1/512) = 1/8）。距離は100（850分の100 ≈ 0.1176 ≈ 1/8.5、
    // 「約1/8」）。
    //
    // 距離をちょうど1/8（=106.25）にすると、点間隔由来の1/8と、8倍近づいたことに
        // よるピクセル/ワールド単位の8倍がちょうど相殺し、理論上ぴったり同点になる
    // ことを`npx tsx`での手計算で確認した（これは新しい式が「距離1/2 ≒ レベル1つ」
    // という設計どおりに機能していることの裏付けでもある）。ここでは「深い側が
    // 優先度で勝つ」ことを数値で示したいので、それよりわずかに近い距離100を使う。
    //
    // 対して旧式（体積÷点数を使う版）では、点数が同じ場合 誤差∝sizePixels×体積。
    // 体積比は(1/8)^3=1/512、sizePixelsは距離が8.5倍近いことでせいぜい
    // 8.5倍程度にしかならないため、深いノードの誤差は浅いノードの1/60程度にしか
    // ならず、勝てない（旧式のままだと本テストは失敗する）。
    const shallowSide = 80;
    const shallowDistance = 850;
    const deepSide = 10; // shallowSide / 8
    const deepDistance = 100; // shallowDistance / 8.5 ≈ 「約1/8」
    const pointCount = 25000; // 両ノードとも同じ点数（実測で確認済みの前提）

    const shallowError = screenSpaceError(
      cameraAt(shallowDistance),
      ...cubeBounds(shallowSide),
      pointCount,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
    );
    const deepError = screenSpaceError(
      cameraAt(deepDistance),
      ...cubeBounds(deepSide),
      pointCount,
      CANVAS_WIDTH,
      CANVAS_HEIGHT,
    );

    // 実測(npx tsxでの手計算確認): shallowError ≈ 2.579, deepError ≈ 2.749
    // (比 ≈ 1.066。約6.6%深い側が高い)。
    expect(deepError).toBeGreaterThan(shallowError);
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
