import { describe, expect, it } from "vitest";
import {
  UNKNOWN_UNIT_NOTE,
  convertArea,
  convertLength,
  coordinateUnitLabel,
  formatArea,
  formatCoordinate,
  formatDistance3d,
  formatLength,
  lengthUnitsFor,
  metersToDisplay,
  parseDisplayUnit,
  type LengthUnits,
} from "./units";

const FOOT = 0.3048;
const US_FOOT = 0.304800609601219;
const AUTZEN: LengthUnits = { horizontalToMeter: FOOT, verticalToMeter: US_FOOT, display: "meter" };

describe("convert", () => {
  it("feet in the file become meters (autzen width about 3426 ft is about 1044 m)", () => {
    expect(convertLength(3426, FOOT, "meter")).toBeCloseTo(1044.2448, 3);
  });
  it("meters to international feet and back", () => {
    expect(metersToDisplay(0.3048, "foot")).toBeCloseTo(1, 12);
    expect(convertLength(100, 1, "foot")).toBeCloseTo(328.084, 3);
  });
  it("unknown factor is not converted", () => {
    expect(convertLength(5, null, "meter")).toBeNull();
    expect(convertArea(5, null, "foot")).toBeNull();
  });
  it("area uses the square of the factor", () => {
    expect(convertArea(100, FOOT, "meter")).toBeCloseTo(100 * FOOT * FOOT, 9);
    expect(convertArea(1, 1, "foot")).toBeCloseTo(10.7639, 3);
  });
});

describe("format", () => {
  it("known unit: converted with a symbol", () => {
    expect(formatLength(1000, FOOT, "meter")).toBe("304.80 m");
    expect(formatLength(1000, FOOT, "foot")).toBe("1,000.00 ft");
    expect(formatArea(10, 1, "meter")).toBe("10.00 m²");
  });
  it("unknown unit: raw number with the note, never labeled m", () => {
    expect(formatLength(1000, null, "meter")).toBe(`1,000.00 ${UNKNOWN_UNIT_NOTE}`);
    expect(formatArea(10, null, "meter")).toBe(`10.00 ${UNKNOWN_UNIT_NOTE}²`);
  });
  it("3D distance combines horizontal and vertical after converting each unit", () => {
    // horizontal 3000 ft, vertical 4000 US ft -> 914.4 m and 1219.2024 m -> 1524.0 m (approximately)
    const text = formatDistance3d(3000, 4000, AUTZEN);
    const expected = Math.hypot(3000 * FOOT, 4000 * US_FOOT);
    expect(text).toBe(`${expected.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`);
  });
  it("3D distance with an unknown vertical unit is not converted", () => {
    const units: LengthUnits = { horizontalToMeter: FOOT, verticalToMeter: null, display: "meter" };
    expect(formatDistance3d(3, 4, units)).toBe(`5.00 ${UNKNOWN_UNIT_NOTE}`);
  });
  it("coordinate triple uses the horizontal factor for x/y and the vertical one for z", () => {
    // 1000 ft = 304.80 m, 2000 ft = 609.60 m, 3000 US ft = 914.40 m (to 2 decimals)
    expect(formatCoordinate([1000, 2000, 3000], AUTZEN)).toBe("[304.80, 609.60, 914.40]");
    expect(coordinateUnitLabel(AUTZEN)).toBe("m");
    expect(coordinateUnitLabel({ ...AUTZEN, verticalToMeter: null })).toBe(UNKNOWN_UNIT_NOTE);
  });
});

describe("lengthUnitsFor and parseDisplayUnit", () => {
  it("reads the factors from the CRS; missing means unknown", () => {
    expect(lengthUnitsFor({ name: "x", kind: "other", horizontalUnitToMeter: FOOT, verticalUnitToMeter: US_FOOT }, "foot")).toEqual({
      horizontalToMeter: FOOT,
      verticalToMeter: US_FOOT,
      display: "foot",
    });
    expect(lengthUnitsFor({ name: "x", kind: "other" }, "meter")).toEqual({ horizontalToMeter: null, verticalToMeter: null, display: "meter" });
    expect(lengthUnitsFor(null, "meter").horizontalToMeter).toBeNull();
  });
  it("defaults to meters for anything unexpected", () => {
    expect(parseDisplayUnit("foot")).toBe("foot");
    expect(parseDisplayUnit("meter")).toBe("meter");
    expect(parseDisplayUnit(null)).toBe("meter");
    expect(parseDisplayUnit("yard")).toBe("meter");
  });
});
