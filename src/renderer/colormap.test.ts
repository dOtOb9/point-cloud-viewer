// colormap.ts のテスト（M2-2）。
//
// GPUに依存しない純粋関数だけを担保する（edl.test.tsと同じ方針）。WGSL側への
// 結線・実際の描画結果はGUIを持たないこの環境では検証できない。

import { describe, expect, it } from "vitest";
import {
  ELEVATION_RAMP,
  INTENSITY_RAMP,
  UNKNOWN_CLASSIFICATION_COLOR,
  classificationToColor,
  elevationToColor,
  extendRange,
  intensityToColor,
  normalizeValue,
  resolveColorMode,
  sampleRamp,
  type RGB,
} from "./colormap";

describe("normalizeValue", () => {
  const range = { min: 10, max: 20 };

  it("レンジの下端で0、上端で1になる", () => {
    expect(normalizeValue(10, range)).toBe(0);
    expect(normalizeValue(20, range)).toBe(1);
  });

  it("中間値は線形に正規化される", () => {
    expect(normalizeValue(15, range)).toBeCloseTo(0.5, 10);
  });

  it("範囲外はクランプされる（下も上も）", () => {
    expect(normalizeValue(0, range)).toBe(0);
    expect(normalizeValue(1000, range)).toBe(1);
  });

  it("縮退したレンジ(max<=min)では0を返す(0除算・NaNを避ける)", () => {
    expect(normalizeValue(5, { min: 3, max: 3 })).toBe(0);
    expect(normalizeValue(5, { min: 5, max: 1 })).toBe(0);
  });
});

describe("extendRange", () => {
  it("nullから始めると、その値自体がmin=maxのレンジになる", () => {
    expect(extendRange(null, 42)).toEqual({ min: 42, max: 42 });
  });

  it("観測した値でレンジが広がる（狭まらない）", () => {
    let range = extendRange(null, 10);
    range = extendRange(range, 20);
    expect(range).toEqual({ min: 10, max: 20 });

    // 内側の値を渡してもレンジは変わらない。
    range = extendRange(range, 15);
    expect(range).toEqual({ min: 10, max: 20 });

    // 下にも上にも広がる。
    range = extendRange(range, 5);
    range = extendRange(range, 25);
    expect(range).toEqual({ min: 5, max: 25 });
  });
});

describe("sampleRamp", () => {
  const ramp = [
    { t: 0, color: [0, 0, 0] as RGB },
    { t: 1, color: [1, 1, 1] as RGB },
  ];

  it("両端のtで、ちょうどその制御点の色になる", () => {
    expect(sampleRamp(ramp, 0)).toEqual([0, 0, 0]);
    expect(sampleRamp(ramp, 1)).toEqual([1, 1, 1]);
  });

  it("範囲外のtはクランプされる", () => {
    expect(sampleRamp(ramp, -1)).toEqual([0, 0, 0]);
    expect(sampleRamp(ramp, 2)).toEqual([1, 1, 1]);
  });

  it("中間のtは線形補間される", () => {
    const [r, g, b] = sampleRamp(ramp, 0.25);
    expect(r).toBeCloseTo(0.25, 10);
    expect(g).toBeCloseTo(0.25, 10);
    expect(b).toBeCloseTo(0.25, 10);
  });

  it("3制御点以上でも、該当する区間だけを補間する", () => {
    const threeStops = [
      { t: 0, color: [0, 0, 0] as RGB },
      { t: 0.5, color: [1, 0, 0] as RGB },
      { t: 1, color: [1, 1, 0] as RGB },
    ];
    // t=0.25は最初の区間(0→0.5)の中点。
    expect(sampleRamp(threeStops, 0.25)).toEqual([0.5, 0, 0]);
    // t=0.75は2番目の区間(0.5→1)の中点。
    expect(sampleRamp(threeStops, 0.75)).toEqual([1, 0.5, 0]);
  });

  it("空のランプはエラーにする", () => {
    expect(() => sampleRamp([], 0.5)).toThrow();
  });
});

/** 相対輝度（知覚的な明るさ）の簡易近似。単調性の検証だけが目的なので、
 *  厳密な色空間変換(sRGB→線形化)はせず、係数付きの加重和で十分とする。 */
function relativeLuma([r, g, b]: RGB): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe("ELEVATION_RAMP / INTENSITY_RAMP: 明度の単調性", () => {
  // タスクシートの必須要件:「配色は明度が単調に変化するものを選ぶこと。虹色(jet)は
  // 明度が非単調で、実際には無い構造が見えてしまう」。制御点を順に見て、
  // 明度が後戻りしない(単調非減少)ことを機械的に確認する。
  it.each([
    ["ELEVATION_RAMP", ELEVATION_RAMP],
    ["INTENSITY_RAMP", INTENSITY_RAMP],
  ])("%sの明度は制御点順に単調非減少", (_name, ramp) => {
    const lumas = ramp.map((stop) => relativeLuma(stop.color));
    for (let i = 1; i < lumas.length; i++) {
      expect(lumas[i]).toBeGreaterThanOrEqual(lumas[i - 1] - 1e-9);
    }
  });
});

describe("elevationToColor", () => {
  it("レンジの下端・上端でELEVATION_RAMPの最初・最後の色になる", () => {
    const range = { min: 0, max: 100 };
    expect(elevationToColor(0, range)).toEqual(ELEVATION_RAMP[0].color);
    expect(elevationToColor(100, range)).toEqual(ELEVATION_RAMP[ELEVATION_RAMP.length - 1].color);
  });
});

describe("intensityToColor", () => {
  it("レンジの下端は暗い色、上端は白になる（純黒にはしない。ファイル冒頭コメント参照）", () => {
    const range = { min: 0, max: 65535 };
    const dark = intensityToColor(0, range);
    const bright = intensityToColor(65535, range);
    expect(dark).toEqual(INTENSITY_RAMP[0].color);
    expect(bright).toEqual([1, 1, 1]);
    // 純黒(0,0,0)ではないことを明示的に確認する。
    expect(dark.some((c) => c > 0)).toBe(true);
  });
});

describe("classificationToColor", () => {
  it("地表(2)など、既知のASPRS標準コードに色が割り当てられている", () => {
    const ground = classificationToColor(2);
    expect(ground).not.toEqual(UNKNOWN_CLASSIFICATION_COLOR);
  });

  it("未知のコードはUNKNOWN_CLASSIFICATION_COLORにフォールバックする", () => {
    expect(classificationToColor(250)).toEqual(UNKNOWN_CLASSIFICATION_COLOR);
    expect(classificationToColor(-1)).toEqual(UNKNOWN_CLASSIFICATION_COLOR);
  });

  it("既知のコードはどれも互いに異なる色を持つ(表の重複が無いことの確認)", () => {
    const codes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
    const colors = codes.map((c) => classificationToColor(c).join(","));
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe("resolveColorMode", () => {
  it("RGBを持つファイルでは、要求したモードがそのまま使われる", () => {
    expect(resolveColorMode("rgb", true)).toBe("rgb");
    expect(resolveColorMode("elevation", true)).toBe("elevation");
  });

  it("RGBを持たないファイルで'rgb'を要求すると、標高にフォールバックする", () => {
    expect(resolveColorMode("rgb", false)).toBe("elevation");
  });

  it("RGBを持たないファイルでも、rgb以外の要求はそのまま通る", () => {
    expect(resolveColorMode("intensity", false)).toBe("intensity");
    expect(resolveColorMode("classification", false)).toBe("classification");
    expect(resolveColorMode("elevation", false)).toBe("elevation");
  });
});
