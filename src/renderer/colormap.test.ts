// colormap.ts のテスト（M2-2）。
//
// GPUに依存しない純粋関数だけを担保する（edl.test.tsと同じ方針）。WGSL側への
// 結線・実際の描画結果はGUIを持たないこの環境では検証できない。

import { describe, expect, it } from "vitest";
import {
  ELEVATION_INTENSITY_RAMP,
  UNKNOWN_CLASSIFICATION_COLOR,
  classificationToColor,
  elevationToColor,
  extendRange,
  intensityToColor,
  normalizeValue,
  rampToWgslFunction,
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

describe("ELEVATION_INTENSITY_RAMP: CloudCompare風の青→緑→黄→赤", () => {
  // 所有者の要望「CloudCompareのように、青→緑→赤で標高とIntensityは表示しよう」。
  // 緑→赤を直接つなぐと濁ったオリーブ色になるため(colormap.tsファイル冒頭の
  // コメント参照)、CloudCompareと同じく黄色を挟んだ4点になっている。
  it("両端は青と赤、途中に緑と黄が来る", () => {
    expect(ELEVATION_INTENSITY_RAMP[0].color).toEqual([0, 0, 1]); // 青
    expect(ELEVATION_INTENSITY_RAMP[ELEVATION_INTENSITY_RAMP.length - 1].color).toEqual([1, 0, 0]); // 赤

    const middleColors = ELEVATION_INTENSITY_RAMP.slice(1, -1).map((stop) => stop.color);
    expect(middleColors).toContainEqual([0, 1, 0]); // 緑
    expect(middleColors).toContainEqual([1, 1, 0]); // 黄
  });

  it("制御点のtは0から1まで昇順である(sampleRampの前提)", () => {
    const ts = ELEVATION_INTENSITY_RAMP.map((stop) => stop.t);
    expect(ts[0]).toBe(0);
    expect(ts[ts.length - 1]).toBe(1);
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    }
  });
});

describe("elevationToColor", () => {
  it("レンジの下端・上端でELEVATION_INTENSITY_RAMPの最初・最後の色になる", () => {
    const range = { min: 0, max: 100 };
    expect(elevationToColor(0, range)).toEqual(ELEVATION_INTENSITY_RAMP[0].color);
    expect(elevationToColor(100, range)).toEqual(
      ELEVATION_INTENSITY_RAMP[ELEVATION_INTENSITY_RAMP.length - 1].color,
    );
  });
});

describe("intensityToColor", () => {
  it("レンジの下端・上端でELEVATION_INTENSITY_RAMPの最初・最後の色になる", () => {
    const range = { min: 0, max: 65535 };
    expect(intensityToColor(0, range)).toEqual(ELEVATION_INTENSITY_RAMP[0].color);
    expect(intensityToColor(65535, range)).toEqual(
      ELEVATION_INTENSITY_RAMP[ELEVATION_INTENSITY_RAMP.length - 1].color,
    );
  });

  it("標高(elevationToColor)と全く同じ色を返す(所有者の要望: 標高とIntensityを同じランプにする)", () => {
    const range = { min: 0, max: 100 };
    for (const v of [0, 10, 25, 50, 75, 90, 100]) {
      expect(intensityToColor(v, range)).toEqual(elevationToColor(v, range));
    }
  });
});

describe("rampToWgslFunction", () => {
  it("2制御点から、両端の色と1つのif文を持つWGSL関数を生成する", () => {
    const src = rampToWgslFunction("testRamp", [
      { t: 0, color: [0, 0, 0] },
      { t: 1, color: [1, 1, 1] },
    ]);
    expect(src).toContain("fn testRamp(t: f32) -> vec3<f32>");
    expect(src).toContain("vec3<f32>(0.0, 0.0, 0.0)");
    expect(src).toContain("vec3<f32>(1.0, 1.0, 1.0)");
    expect((src.match(/if \(/g) ?? []).length).toBe(1);
  });

  it("ELEVATION_INTENSITY_RAMP(4制御点)の4色すべてを、生成したWGSLの中に見つけられる" +
    "(TS側の値がそのままWGSLへ埋め込まれていることの確認)", () => {
    const src = rampToWgslFunction("elevationOrIntensityRampColor", ELEVATION_INTENSITY_RAMP);
    expect(src).toContain("vec3<f32>(0.0, 0.0, 1.0)"); // 青
    expect(src).toContain("vec3<f32>(0.0, 1.0, 0.0)"); // 緑
    expect(src).toContain("vec3<f32>(1.0, 1.0, 0.0)"); // 黄
    expect(src).toContain("vec3<f32>(1.0, 0.0, 0.0)"); // 赤
    // 4制御点なら区間は3つ、つまりif文は3つになるはず(sampleRampのロジックと対応)。
    expect((src.match(/if \(/g) ?? []).length).toBe(3);
  });

  it("制御点が1つ以下だとエラーにする", () => {
    expect(() => rampToWgslFunction("bad", [{ t: 0, color: [0, 0, 0] }])).toThrow();
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
