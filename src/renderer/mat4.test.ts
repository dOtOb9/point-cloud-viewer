// mat4.ts のテスト。M1-5でinvert()を追加した際に、既存の行列演算と組み合わせて
// 正しく逆行列になっているか（m * invert(m) が単位行列に戻るか）を確認する。

import { describe, expect, it } from "vitest";
import { identity, invert, lookAt, multiply, perspective, type Mat4 } from "./mat4";

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
