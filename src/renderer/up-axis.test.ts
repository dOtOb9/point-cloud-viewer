// up-axis.ts のテスト（M2-0b 段階1）。
//
// ここで担保したいこと:
// - up=[0,1,0]（従来のY-up）のとき、horizontalBasisがorbit-camera.tsの旧来の式
//   （[cosP*sin(yaw), sinP, cosP*cos(yaw)]）と代数的に一致する基底を返すこと
//   （リファクタで見た目が変わっていないことの直接証拠）
// - up=[0,0,1]（M2-0b 段階3で既定にするZ-up）でも、right/forwardが単位直交系になり、
//   upとも直交すること（軸を変えても数式が壊れないこと）

import { describe, expect, it } from "vitest";
import { horizontalBasis } from "./up-axis";

function dot(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function len(a: readonly [number, number, number]): number {
  return Math.hypot(a[0], a[1], a[2]);
}

describe("horizontalBasis", () => {
  it("up=[0,1,0]のとき、right=[1,0,0], forward=[0,0,1]になる（orbit-camera.tsの旧式と一致）", () => {
    const { right, forward } = horizontalBasis([0, 1, 0]);
    expect(right[0]).toBeCloseTo(1, 9);
    expect(right[1]).toBeCloseTo(0, 9);
    expect(right[2]).toBeCloseTo(0, 9);
    expect(forward[0]).toBeCloseTo(0, 9);
    expect(forward[1]).toBeCloseTo(0, 9);
    expect(forward[2]).toBeCloseTo(1, 9);
  });

  it("任意のupに対して、right/forward/upが互いに直交する単位ベクトルになる", () => {
    const ups: [number, number, number][] = [
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
      [0, -1, 0],
    ];
    for (const up of ups) {
      const { right, forward } = horizontalBasis(up);
      expect(len(right)).toBeCloseTo(1, 9);
      expect(len(forward)).toBeCloseTo(1, 9);
      expect(dot(right, forward)).toBeCloseTo(0, 9);
      expect(dot(right, up)).toBeCloseTo(0, 9);
      expect(dot(forward, up)).toBeCloseTo(0, 9);
    }
  });
});
