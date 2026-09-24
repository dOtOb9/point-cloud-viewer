// render-scale.tsのテスト（M3-8、受け入れ条件「レンダースケールのキャンバス
// サイズ計算に単体テストがある(端数の丸め、最小1pxなど)」に対応）。

import { describe, expect, it } from "vitest";
import { computeCanvasBackingSize } from "./render-scale";

describe("computeCanvasBackingSize", () => {
  it("devicePixelRatio=1・renderScale=1.0(デスクトップの既定)では表示サイズと一致する", () => {
    const size = computeCanvasBackingSize(1920, 1080, 1, 1.0);
    expect(size).toEqual({ width: 1920, height: 1080 });
  });

  it("devicePixelRatioを掛ける(高DPRディスプレイ)", () => {
    const size = computeCanvasBackingSize(800, 600, 2, 1.0);
    expect(size).toEqual({ width: 1600, height: 1200 });
  });

  it("renderScale=0.5(モバイルの既定)では半分の解像度になる", () => {
    const size = computeCanvasBackingSize(800, 600, 1, 0.5);
    expect(size).toEqual({ width: 400, height: 300 });
  });

  it("devicePixelRatioとrenderScaleの両方を掛け合わせる", () => {
    const size = computeCanvasBackingSize(1000, 500, 3, 0.5);
    // 1000*3*0.5 = 1500, 500*3*0.5 = 750
    expect(size).toEqual({ width: 1500, height: 750 });
  });

  it("端数は四捨五入する(切り捨て・切り上げのどちらにも一貫して偏らない)", () => {
    // 111 * 1 * 0.335 = 37.185 → 37
    expect(computeCanvasBackingSize(111, 111, 1, 0.335).width).toBe(37);
    // 111 * 1 * 0.339 = 37.629 → 38
    expect(computeCanvasBackingSize(111, 111, 1, 0.339).width).toBe(38);
  });

  it("結果が0以下になる入力でも最小1pxを返す", () => {
    expect(computeCanvasBackingSize(0, 0, 1, 1.0)).toEqual({ width: 1, height: 1 });
    expect(computeCanvasBackingSize(10, 10, 1, 0)).toEqual({ width: 1, height: 1 });
    expect(computeCanvasBackingSize(-5, -5, 1, 1.0)).toEqual({ width: 1, height: 1 });
  });

  it("幅と高さを独立に計算する(縦横比が保たれる)", () => {
    const size = computeCanvasBackingSize(1600, 900, 1.5, 0.75);
    expect(size.width).toBe(Math.round(1600 * 1.5 * 0.75));
    expect(size.height).toBe(Math.round(900 * 1.5 * 0.75));
  });
});
