// render-scale.tsのテスト（M3-8、受け入れ条件「レンダースケールのキャンバス
// サイズ計算に単体テストがある(端数の丸め、最小1pxなど)」に対応）。
//
// 2026-09-24追記: devicePixelRatioを計算から外す修正（コーディネーターの
// 指摘。render-scale.tsファイル冒頭のコメント参照）に伴い、
// 「倍率1.0ならCSSサイズと完全に一致する(変更前と同じ)」ことを確認する
// テストを必須項目として追加した。

import { describe, expect, it } from "vitest";
import { computeCanvasBackingSize } from "./render-scale";

describe("computeCanvasBackingSize", () => {
  it("renderScale=1.0(デスクトップの既定)では、devicePixelRatioに関わらずCSSサイズと完全に一致する(変更前と同じ挙動)", () => {
    expect(computeCanvasBackingSize(1920, 1080, 1.0)).toEqual({ width: 1920, height: 1080 });
    // 高DPR環境(例: 表示スケール150%、devicePixelRatio=1.5)でも、
    // renderScale=1.0であればCSSサイズのまま変わらないことを確認する
    // (以前の実装ではdevicePixelRatioを掛けており、ここが変わってしまっていた)。
    expect(computeCanvasBackingSize(800, 600, 1.0)).toEqual({ width: 800, height: 600 });
  });

  it("renderScale=0.5(モバイルの既定)では、CSSサイズの半分の解像度になる", () => {
    const size = computeCanvasBackingSize(800, 600, 0.5);
    expect(size).toEqual({ width: 400, height: 300 });
  });

  it("端数は四捨五入する(切り捨て・切り上げのどちらにも一貫して偏らない)", () => {
    // 111 * 0.335 = 37.185 → 37
    expect(computeCanvasBackingSize(111, 111, 0.335).width).toBe(37);
    // 111 * 0.339 = 37.629 → 38
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
