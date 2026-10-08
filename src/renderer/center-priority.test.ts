// center-priority.ts のテスト。ADR-0010追記: LOD優先度に画面中央からの距離で
// 掛ける重み(`centerPriorityWeight`)が、所有者の受け入れ条件
// (TaskSheets/ADR-0010-lod-priority-and-point-budget.md参照)を満たすことを
// 純粋関数のレベルで確認する。WebGPU・Reactのどちらも要らない。

import { describe, expect, it } from "vitest";
import { lookAt, multiply, perspective, type Mat4 } from "./mat4";
import { centerPriorityWeight, DEFAULT_MIN_CENTER_PRIORITY_WEIGHT } from "./center-priority";

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

/** node-selection.test.tsと同じ、実際のカメラに近いviewProj(回転なし、+z側から原点を見る)。 */
function realisticViewProj(): Mat4 {
  const proj = perspective(Math.PI / 3, CANVAS_WIDTH / CANVAS_HEIGHT, 0.1, 1000);
  const view = lookAt([0, 0, 10], [0, 0, 0], [0, 1, 0]);
  return multiply(proj, view);
}

/**
 * screen-space-error.test.tsのaxisAlignedTestViewProjと同じ、テスト専用の単純な
 * viewProj(cx=x, cy=y, cw=z)。「カメラがノードの範囲の中に入っている」ケースを、
 * z=0(ニアプレーン相当)を跨ぐ箱で再現するために使う。
 */
function axisAlignedTestViewProj(): Mat4 {
  // prettier-ignore
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
    // setCenterPriorityStrength()側でMath.max(0, strength)しているが、この純粋関数
    // 自体も不正な負の値を安全側(1=効果なし)に倒しておく。
    expect(centerPriorityWeight(viewProj, edgeMin, edgeMax, CANVAS_WIDTH, CANVAS_HEIGHT, -1)).toBe(1);
  });

  it("画面中央に近いノードほど重みが大きい", () => {
    const viewProj = realisticViewProj();
    const [centerMin, centerMax] = cubeBoundsAt([0, 0, 0], 0.5);
    // fovY=60度・距離10・aspect 800/600 なので、z=0平面での可視半幅は約7.7
    // (10*tan(30°)*(800/600)≈7.698)。x=7は視錐台の中だが画面の端に近い。
    const [edgeMin, edgeMax] = cubeBoundsAt([7, 0, 0], 0.5);

    const strength = 2;
    const centerWeight = centerPriorityWeight(viewProj, centerMin, centerMax, CANVAS_WIDTH, CANVAS_HEIGHT, strength);
    const edgeWeight = centerPriorityWeight(viewProj, edgeMin, edgeMax, CANVAS_WIDTH, CANVAS_HEIGHT, strength);

    expect(centerWeight).toBeGreaterThan(edgeWeight);
    // 中央は投影が画面中央にほぼ一致する(正規化距離≈0)ので、ガウス項もほぼ1。
    expect(centerWeight).toBeGreaterThan(0.99);
  });

  it("重みはDEFAULT_MIN_CENTER_PRIORITY_WEIGHTより小さくならない(端のノードの飢餓防止)", () => {
    const viewProj = realisticViewProj();
    // 視錐台の端ぎりぎりに、非常に強いstrengthを与えても下限を割らないことを確認する。
    const [edgeMin, edgeMax] = cubeBoundsAt([7.6, 0, 0], 0.3);

    for (const strength of [10, 100, 10000]) {
      const weight = centerPriorityWeight(viewProj, edgeMin, edgeMax, CANVAS_WIDTH, CANVAS_HEIGHT, strength);
      expect(weight).toBeGreaterThanOrEqual(DEFAULT_MIN_CENTER_PRIORITY_WEIGHT - 1e-9);
      // strengthが大きいほど下限に近づいていくはず(下限に張り付いて動かないだけ、ではないことの確認)。
      expect(weight).toBeLessThan(DEFAULT_MIN_CENTER_PRIORITY_WEIGHT + 0.05);
    }
  });

  it("カメラがノードの範囲の中に入っているとき(ニアプレーンを跨ぐとき)、重みは最大(1)になる", () => {
    const viewProj = axisAlignedTestViewProj();
    // z: -5..5 がちょうどニアプレーン相当(z=0)を跨ぐ箱。画面中央から離れた
    //位置(x=50)に置いても、「カメラがノードの中にいる」ことが中央優先の
    // 距離減衰より常に勝つはず。
    const [min, max] = cubeBoundsAt([50, 0, 0], 5);

    const weight = centerPriorityWeight(viewProj, min, max, CANVAS_WIDTH, CANVAS_HEIGHT, 1000);
    expect(weight).toBe(1);
  });
});
