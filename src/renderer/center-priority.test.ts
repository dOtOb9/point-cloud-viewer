import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import { centerPriorityWeight, DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "./center-priority";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

function realisticViewProj(): Mat4 {
  const proj = perspective(Math.PI / 3, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
  const view = lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
  return multiply(proj, view);
}

function axisAlignedTestViewProj(): Mat4 {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 1,
    0, 0, 0, 0,
  ];
}

function cubeBoundsAt(
  center: readonly [number, number, number],
  half: number,
): [[number, number, number], [number, number, number]] {
  return [
    [center[0] - half, center[1] - half, center[2] - half],
    [center[0] + half, center[1] + half, center[2] + half],
  ];
}

describe("centerPriorityWeight", () => {
  it("strength<=0のとき、画面中央からの距離に関わらず常に1になる(=今までの優先度と一致する)", () => {
    const viewProj = realisticViewProj();
    const [edgeMin, edgeMax] = cubeBoundsAt([7, 0, 0], 0.5);
    const [centerMin, centerMax] = cubeBoundsAt([0, 0, 0], 0.5);

    expect(centerPriorityWeight(viewProj, edgeMin, edgeMax, CANVAS_WIDTH, CANVAS_HEIGHT, 0)).toBe(1);
    expect(centerPriorityWeight(viewProj, centerMin, centerMax, CANVAS_WIDTH, CANVAS_HEIGHT, 0)).toBe(1);
    expect(centerPriorityWeight(viewProj, edgeMin, edgeMax, CANVAS_WIDTH, CANVAS_HEIGHT, -1)).toBe(1);
  });

  it("画面中央に近いノードほど重みが大きい", () => {
    const viewProj = realisticViewProj();
    const [centerMin, centerMax] = cubeBoundsAt([0, 0, 0], 0.5);
    const [edgeMin, edgeMax] = cubeBoundsAt([7, 0, 0], 0.5);

    const strength = 2;
    const centerWeight = centerPriorityWeight(viewProj, centerMin, centerMax, CANVAS_WIDTH, CANVAS_HEIGHT, strength);
    const edgeWeight = centerPriorityWeight(viewProj, edgeMin, edgeMax, CANVAS_WIDTH, CANVAS_HEIGHT, strength);

    expect(centerWeight).toBeGreaterThan(edgeWeight);
    expect(centerWeight).toBeGreaterThan(0.99);
  });

  it("重みはDEFAULT_MIN_CENTER_PRIORITY_WEIGHTより小さくならない(端のノードの飢餓防止)", () => {
    const viewProj = realisticViewProj();
    const [edgeMin, edgeMax] = cubeBoundsAt([7.6, 0, 0], 0.3);

    for (const strength of [10, 100, 10000]) {
      const weight = centerPriorityWeight(viewProj, edgeMin, edgeMax, CANVAS_WIDTH, CANVAS_HEIGHT, strength);
      expect(weight).toBeGreaterThanOrEqual(DEFAULT_MIN_CENTER_PRIORITY_WEIGHT - 1e-9);
      expect(weight).toBeLessThan(DEFAULT_MIN_CENTER_PRIORITY_WEIGHT + 0.05);
    }
  });

  it("カメラがノードの範囲の中に入っているとき(ニアプレーンを跨ぐとき)、重みは最大(1)になる", () => {
    const viewProj = axisAlignedTestViewProj();
    const [min, max] = cubeBoundsAt([50, 0, 0], 5);

    const weight = centerPriorityWeight(viewProj, min, max, CANVAS_WIDTH, CANVAS_HEIGHT, 1000);
    expect(weight).toBe(1);
  });
});
