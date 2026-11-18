import { describe, expect, it } from "vitest";
import { computeCanvasBackingSize } from "./render-scale";

describe("computeCanvasBackingSize", () => {
  it("renderScale=1.0(デスクトップの既定)では、devicePixelRatioに関わらずCSSサイズと完全に一致する(変更前と同じ挙動)", () => {
    expect(computeCanvasBackingSize(1920, 1080, 1.0)).toEqual({ width: 1920, height: 1080 });
    expect(computeCanvasBackingSize(800, 600, 1.0)).toEqual({ width: 800, height: 600 });
  });

  it("renderScale=0.5(モバイルの既定)では、CSSサイズの半分の解像度になる", () => {
    const size = computeCanvasBackingSize(800, 600, 0.5);
    expect(size).toEqual({ width: 400, height: 300 });
  });

  it("端数は四捨五入する(切り捨て・切り上げのどちらにも一貫して偏らない)", () => {
    expect(computeCanvasBackingSize(111, 111, 0.335).width).toBe(37);
    expect(computeCanvasBackingSize(111, 111, 0.339).width).toBe(38);
  });

  it("結果が0以下になる入力でも最小1pxを返す", () => {
    expect(computeCanvasBackingSize(0, 0, 1.0)).toEqual({ width: 1, height: 1 });
    expect(computeCanvasBackingSize(10, 10, 0)).toEqual({ width: 1, height: 1 });
    expect(computeCanvasBackingSize(-5, -5, 1.0)).toEqual({ width: 1, height: 1 });
  });

  it("幅と高さを独立に計算する(縦横比が保たれる)", () => {
    const size = computeCanvasBackingSize(1600, 900, 0.75);
    expect(size.width).toBe(Math.round(1600 * 0.75));
    expect(size.height).toBe(Math.round(900 * 0.75));
  });
});
