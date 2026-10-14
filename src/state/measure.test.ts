import { describe, expect, it } from "vitest";
import {
  distanceStats,
  labelAnchor,
  measurementLabelLines,
  measurementSegments,
  pointsBounds,
  polygonStats,
  type Measurement,
  type Vec3,
} from "./measure";
import type { LengthUnits } from "./units";

const UP: Vec3 = [0, 0, 1];
const M: LengthUnits = { horizontalToMeter: 1, verticalToMeter: 1, display: "meter" };
const UNKNOWN: LengthUnits = { horizontalToMeter: null, verticalToMeter: null, display: "meter" };
const BASE: Vec3 = [637000, 850000, 500];
const at = (dx: number, dy: number, dz: number): Vec3 => [BASE[0] + dx, BASE[1] + dy, BASE[2] + dz];

describe("distanceStats", () => {
  it("3-4-12 の直方体の対角は 13。水平 5・高さ差 12", () => {
    const s = distanceStats(at(0, 0, 0), at(3, 4, 12), UP);
    expect(s.distance).toBeCloseTo(13, 9);
    expect(s.horizontal).toBeCloseTo(5, 9);
    expect(s.vertical).toBeCloseTo(12, 9);
  });
  it("下向きは vertical が負", () => {
    expect(distanceStats(at(0, 0, 10), at(0, 0, 4), UP).vertical).toBeCloseTo(-6, 9);
  });
  it("up が Y のデータでは Y を鉛直として分解する", () => {
    const s = distanceStats([0, 0, 0], [3, 12, 4], [0, 1, 0]);
    expect(s.vertical).toBeCloseTo(12, 9);
    expect(s.horizontal).toBeCloseTo(5, 9);
  });
  it("同じ点は 0", () => {
    expect(distanceStats(BASE, BASE, UP)).toEqual({ distance: 0, horizontal: 0, vertical: 0 });
  });
});

describe("polygonStats", () => {
  it("10×20 の長方形（大きな実座標・高さがばらばら）の面積 200・周長 60", () => {
    const s = polygonStats([at(0, 0, 0), at(10, 0, 5), at(10, 20, 1), at(0, 20, 9)], UP);
    expect(s.area).toBeCloseTo(200, 6);
    expect(s.perimeter).toBeCloseTo(60, 6);
  });
  it("頂点の並びが逆でも面積は正", () => {
    const s = polygonStats([at(0, 20, 0), at(10, 20, 0), at(10, 0, 0), at(0, 0, 0)], UP);
    expect(s.area).toBeCloseTo(200, 6);
  });
  it("直角三角形 3-4-5 は 面積 6・周長 12", () => {
    const s = polygonStats([at(0, 0, 0), at(3, 0, 0), at(0, 4, 0)], UP);
    expect(s.area).toBeCloseTo(6, 9);
    expect(s.perimeter).toBeCloseTo(12, 9);
  });
  it("傾いた面でも、水平に投影した面積（斜面の実面積ではない）", () => {
    // slope: rises 10 over 10 in x; horizontally 10x10 = 100
    const s = polygonStats([at(0, 0, 0), at(10, 0, 10), at(10, 10, 10), at(0, 10, 0)], UP);
    expect(s.area).toBeCloseTo(100, 6);
  });
  it("3点未満は 0", () => {
    expect(polygonStats([at(0, 0, 0), at(1, 1, 1)], UP)).toEqual({ area: 0, perimeter: 0 });
  });
});

describe("units in labels (autzen: horizontal foot, vertical US survey foot)", () => {
  const autzen: LengthUnits = { horizontalToMeter: 0.3048, verticalToMeter: 0.304800609601219, display: "meter" };
  const dist: Measurement = { kind: "distance", points: [at(0, 0, 0), at(3000, 4000, 100)], up: UP };
  it("converts horizontal and vertical with their own factors", () => {
    const horizontal = 5000 * 0.3048;
    const vertical = 100 * 0.304800609601219;
    const lines = measurementLabelLines(dist, autzen);
    expect(lines[0]).toBe(`距離 ${Math.hypot(horizontal, vertical).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} m`);
    expect(lines[1]).toContain("水平 1,524.00 m");
    expect(lines[1]).toContain("高さ差 30.48 m");
  });
  it("shows feet when chosen, unconverted-with-note when unknown", () => {
    expect(measurementLabelLines(dist, { ...autzen, display: "foot" })[1]).toContain("水平 5,000.00 ft");
    expect(measurementLabelLines(dist, UNKNOWN)[0]).toContain("座標の単位（m かどうか不明）");
  });
});

describe("ラベル・線", () => {
  const dist: Measurement = { kind: "distance", points: [at(0, 0, 0), at(3, 4, 12)], up: UP };
  const height: Measurement = { kind: "height", points: [at(0, 0, 0), at(3, 4, 12)], up: UP };
  const area: Measurement = { kind: "area", points: [at(0, 0, 0), at(10, 0, 0), at(10, 20, 0), at(0, 20, 0)], up: UP };

  it("距離のラベルは距離・水平・高さ差を含む", () => {
    expect(measurementLabelLines(dist, M)).toEqual(["距離 13.00 m", "水平 5.00 m / 高さ差 12.00 m"]);
  });
  it("高さのラベルは鉛直差の絶対値", () => {
    expect(measurementLabelLines(height, { ...M, display: "foot" })).toEqual(["高さ 39.37 ft"]);
  });
  it("面積のラベルは単位の二乗と周長", () => {
    expect(measurementLabelLines(area, M)).toEqual(["面積 200.00 m²", "周長 60.00 m"]);
    expect(measurementLabelLines(area, UNKNOWN)[0]).toBe("面積 200.00 座標の単位（m かどうか不明）²");
  });
  it("点が足りなければラベル無し", () => {
    expect(measurementLabelLines({ kind: "area", points: [BASE, BASE], up: UP }, M)).toEqual([]);
  });
  it("線: 距離は1本、高さは鉛直の実線+水平の破線、面積は閉じる辺つき", () => {
    expect(measurementSegments(dist)).toHaveLength(1);
    const h = measurementSegments(height);
    expect(h).toHaveLength(2);
    expect(h[0].dashed).toBe(false);
    expect(h[0].b[2]).toBeCloseTo(BASE[2] + 12, 9);
    expect(h[0].b[0]).toBeCloseTo(BASE[0], 9);
    expect(h[1].dashed).toBe(true);
    expect(measurementSegments(area)).toHaveLength(4);
    expect(measurementSegments(area, false)).toHaveLength(3);
  });
  it("ラベルの位置: 距離は中点、高さは鉛直線の中点", () => {
    expect(labelAnchor(dist)).toEqual([BASE[0] + 1.5, BASE[1] + 2, BASE[2] + 6]);
    const a = labelAnchor(height);
    expect(a[0]).toBeCloseTo(BASE[0], 9);
    expect(a[2]).toBeCloseTo(BASE[2] + 6, 9);
  });
  it("pointsBounds", () => {
    expect(pointsBounds([at(1, 2, 3), at(-1, 5, 0)])).toEqual({ min: at(-1, 2, 0), max: at(1, 5, 3) });
  });
});
