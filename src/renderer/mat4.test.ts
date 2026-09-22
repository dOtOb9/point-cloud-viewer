// mat4.ts のテスト。M1-5でinvert()を追加した際に、既存の行列演算と組み合わせて
// 正しく逆行列になっているか（m * invert(m) が単位行列に戻るか）を確認する。

import { describe, expect, it } from "vitest";
import { cameraBasis, identity, invert, lookAt, multiply, perspective, type Mat4 } from "./mat4";
import { ndcPointToWorldRay } from "./raycast";

function expectApproxIdentity(m: Mat4, epsilon = 1e-6): void {
  const id = identity();
  for (let i = 0; i < 16; i++) {
    expect(m[i]).toBeCloseTo(id[i], 5);
  }
  void epsilon;
}

describe("invert", () => {
  it("単位行列の逆行列は単位行列", () => {
    const inv = invert(identity());
    expect(inv).not.toBeNull();
    expectApproxIdentity(inv!);
  });

  it("viewProj（perspective * lookAt）の逆行列を掛けると単位行列に戻る", () => {
    const proj = perspective((60 * Math.PI) / 180, 16 / 9, 0.1, 1000);
    const view = lookAt([3, 4, 5], [0, 0, 0], [0, 1, 0]);
    const viewProj = multiply(proj, view);

    const inv = invert(viewProj);
    expect(inv).not.toBeNull();

    const roundTrip = multiply(inv!, viewProj);
    expectApproxIdentity(roundTrip);
  });

  it("特異行列（行列式が0）はnullを返す", () => {
    // prettier-ignore
    const singular: Mat4 = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 0, // z列がすべて0 → 行列式0
      0, 0, 0, 1,
    ];
    expect(invert(singular)).toBeNull();
  });
});

describe("cameraBasis", () => {
  it("forward/right/upは互いに直交する単位ベクトル", () => {
    const { forward, right, up } = cameraBasis([3, 4, 5], [0, 0, 0], [0, 1, 0]);
    for (const v of [forward, right, up]) {
      expect(Math.hypot(...v)).toBeCloseTo(1, 9);
    }
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(forward, right)).toBeCloseTo(0, 9);
    expect(dot(forward, up)).toBeCloseTo(0, 9);
    expect(dot(right, up)).toBeCloseTo(0, 9);
  });

  it("forwardはeye->targetの正規化方向", () => {
    const { forward } = cameraBasis([0, 0, 10], [0, 0, 0], [0, 1, 0]);
    expect(forward[0]).toBeCloseTo(0, 9);
    expect(forward[1]).toBeCloseTo(0, 9);
    expect(forward[2]).toBeCloseTo(-1, 9);
  });

  // 2回目の実機不具合の回帰テスト（「空やグリッドを入れると画面が真っ黒になる」。
  // TaskSheets/M2-shading-and-ui.md M2-0c参照）。1回目の修正で採用した「全画面
  // 三角形の3頂点のレイ方向を線形補間する」方式は、NDCが画面中心から70度以上
  // 離れる三角形の頂点(NDC=3など)では弦を取ることになって長さが縮み、
  // 「NaNは出ない」が「値は真値から大きくずれる/条件によってはNaNになる」という
  // 形で壊れていた。前回の診断スクリプトはNaNの有無しか見ておらずこれを
  // 見逃した反省を踏まえ、ここでは**基底から画素ごとに直接組み立てる新方式が、
  // f64の真値（invert(viewProj)から直接求めた方向）と数値的に一致することを
  // assertする**（「NaNが出ない」ではなく「値が正しい」を担保する）。
  it("基底(forward/rightScaled/upScaled)から組み立てたレイ方向は、NDCが±1に近い隅や中心でも真値(invert(viewProj))と一致する", () => {
    // autzenの実座標・実際のFOV(60°)・NEAR/FAR(0.01/1e7)・アスペクト16:9で検証。
    const target: [number, number, number] = [637290.8, 851209.9, 510.7];
    const eye: [number, number, number] = [637290.8, 855031.2, 1692.8];
    const upAxis: [number, number, number] = [0, 0, 1];
    const fovY = Math.PI / 3;
    const aspect = 1600 / 900;

    const view = lookAt(eye, target, upAxis);
    const proj = perspective(fovY, aspect, 0.01, 1e7);
    const viewProj = multiply(proj, view);

    const { forward, right, up } = cameraBasis(eye, target, upAxis);
    const tanHalfFovY = Math.tan(fovY / 2);
    const rightScaled: [number, number, number] = [
      right[0] * aspect * tanHalfFovY,
      right[1] * aspect * tanHalfFovY,
      right[2] * aspect * tanHalfFovY,
    ];
    const upScaled: [number, number, number] = [up[0] * tanHalfFovY, up[1] * tanHalfFovY, up[2] * tanHalfFovY];

    // 中心・上下端・4隅（NDCが±1に近い、視野の端に一番近い場所）。
    const points: readonly [number, number][] = [
      [0, 0],
      [0, 1],
      [0, -1],
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ];

    for (const [nx, ny] of points) {
      const dx = forward[0] + nx * rightScaled[0] + ny * upScaled[0];
      const dy = forward[1] + nx * rightScaled[1] + ny * upScaled[1];
      const dz = forward[2] + nx * rightScaled[2] + ny * upScaled[2];
      const len = Math.hypot(dx, dy, dz);
      const reconstructed: [number, number, number] = [dx / len, dy / len, dz / len];

      const truth = ndcPointToWorldRay(viewProj, nx, ny);
      expect(truth).not.toBeNull();

      // f64での基底方式の誤差は実測で~1e-8程度（丸め誤差そのもの）。
      // 1e-6（toBeCloseTo(x, 6)は差が0.5e-6未満であることを要求）は十分な余裕を
      // 持って厳しく、かつ壊れていた補間方式の誤差(最大0.16程度、3〜4桁大きい)
      // とは明確に区別できる閾値。
      expect(reconstructed[0]).toBeCloseTo(truth!.direction[0], 6);
      expect(reconstructed[1]).toBeCloseTo(truth!.direction[1], 6);
      expect(reconstructed[2]).toBeCloseTo(truth!.direction[2], 6);
    }
  });
});
