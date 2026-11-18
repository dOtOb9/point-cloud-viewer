import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import { projectedBoundsDiagonalPixels, screenSpaceError } from "./screen-space-error";

const CANVAS_WIDTH = 1920;
const CANVAS_HEIGHT = 1080;
const MAX_PRIORITY = CANVAS_WIDTH + CANVAS_HEIGHT;

function axisAlignedTestViewProj(): Mat4 {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 1,
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

    const small = projectedBoundsDiagonalPixels(viewProj, [-1, -1, -1], [1, 1, 1], CANVAS_WIDTH, CANVAS_HEIGHT);
    const large = projectedBoundsDiagonalPixels(viewProj, [-5, -5, -1], [5, 5, 1], CANVAS_WIDTH, CANVAS_HEIGHT);

    expect(Number.isFinite(small)).toBe(true);
    expect(Number.isFinite(large)).toBe(true);
    expect(small).not.toBe(MAX_PRIORITY);
    expect(large).not.toBe(MAX_PRIORITY);
    expect(small).not.toBe(large);
  });
});

describe("screenSpaceError: 新しい式（点間隔×ピクセル/ワールド単位）", () => {
  function cameraAt(distance: number): Mat4 {
    const view = lookAt([0, 0, distance], [0, 0, 0], [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1e7);
    return multiply(proj, view);
  }

  function cubeBounds(side: number): [[number, number, number], [number, number, number]] {
    const h = side / 2;
    return [
      [-h, -h, -h],
      [h, h, h],
    ];
  }

  it("親ノードと子ノード（体積1/8・点数同じ・同じカメラ距離）の誤差比は約1/2になる", () => {
    const viewProj = cameraAt(100);
    const pointCount = 25000;

    const [parentMin, parentMax] = cubeBounds(10);
    const [childMin, childMax] = cubeBounds(5);

    const parentError = screenSpaceError(viewProj, parentMin, parentMax, pointCount, CANVAS_WIDTH, CANVAS_HEIGHT);
    const childError = screenSpaceError(viewProj, childMin, childMax, pointCount, CANVAS_WIDTH, CANVAS_HEIGHT);

    const ratio = childError / parentError;
    expect(ratio).toBeGreaterThan(0.45);
    expect(ratio).toBeLessThan(0.55);
  });

  it("レベル差3（誤差比 約1/8）でも、距離が約1/8近い深いノードのほうが優先度が高くなる", () => {
    const shallowSide = 80;
    const shallowDistance = 850;
    const deepSide = 10;
    const deepDistance = 100;
    const pointCount = 25000;

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

    expect(deepError).toBeGreaterThan(shallowError);
  });
});

describe("screenSpaceError: ズームインしたカメラで全ノードが最大優先度に潰れない", () => {
  it("カメラの近くに複数のノードがあっても、優先度が全部同じ最大値にならない", () => {
    const view = lookAt([0, 0, 0.05], [0, 0, -1], [0, 1, 0]);
    const proj = perspective((60 * Math.PI) / 180, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
    const viewProj = multiply(proj, view);

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

    const distinctPriorities = new Set(priorities.map((p) => Math.round(p)));
    expect(distinctPriorities.size).toBeGreaterThan(1);
  });
});
