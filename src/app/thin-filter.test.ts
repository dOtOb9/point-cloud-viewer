import { describe, expect, it } from "vitest";
import type { CloudInfo } from "../datasource/DataSource";
import type { LengthUnits } from "../state/units";
import {
  THIN_FILTER_PRESETS,
  defaultSorSearchRadius,
  estimatePointSpacing,
  filterRequestFor,
  presetLengthInDisplay,
  thinRequestFor,
} from "./thin-filter";

const METRES: LengthUnits = { display: "meter", horizontalToMeter: 1, verticalToMeter: 1 };
/** A file in international feet, shown in feet (Autzen). */
const FEET_IN_FEET: LengthUnits = { display: "foot", horizontalToMeter: 0.3048, verticalToMeter: 0.3048 };
/** A file in feet, shown in metres. */
const FEET_IN_METRES: LengthUnits = { display: "meter", horizontalToMeter: 0.3048, verticalToMeter: 0.3048 };
const UNKNOWN: LengthUnits = { display: "meter", horizontalToMeter: null, verticalToMeter: null };

function info(pointCount: number, width: number, height: number): CloudInfo {
  return { pointCount, min: [0, 0, 0], max: [width, height, 10] } as unknown as CloudInfo;
}

describe("estimatePointSpacing", () => {
  it("is sqrt(area / points)", () => {
    expect(estimatePointSpacing(info(10_000, 100, 100))).toBeCloseTo(1, 12);
    expect(estimatePointSpacing(info(400, 100, 100))).toBeCloseTo(5, 12);
  });

  it("is null when there is no area or no points", () => {
    expect(estimatePointSpacing(info(0, 100, 100))).toBeNull();
    expect(estimatePointSpacing(info(10, 100, 0))).toBeNull();
    expect(estimatePointSpacing(info(10, Infinity, 5))).toBeNull();
  });
});

describe("defaultSorSearchRadius", () => {
  it("is ten times the spacing, shown in the display unit", () => {
    // Spacing 1 file unit: 10 file units; 10 ft shown in metres is 3.048 m.
    expect(defaultSorSearchRadius(info(10_000, 100, 100), METRES)).toBeCloseTo(10, 12);
    expect(defaultSorSearchRadius(info(10_000, 100, 100), FEET_IN_METRES)).toBeCloseTo(3.048, 12);
    expect(defaultSorSearchRadius(info(10_000, 100, 100), FEET_IN_FEET)).toBeCloseTo(10, 9);
  });

  it("falls back to a fixed value when the spacing or the unit is unknown", () => {
    const fallbackMetres = THIN_FILTER_PRESETS.ror.radiusMeters * 10;
    expect(defaultSorSearchRadius(info(0, 100, 100), METRES)).toBe(fallbackMetres);
    expect(defaultSorSearchRadius(info(10_000, 100, 100), UNKNOWN)).toBe(fallbackMetres);
    expect(defaultSorSearchRadius(info(0, 100, 100), FEET_IN_FEET)).toBeCloseTo(presetLengthInDisplay(fallbackMetres, "foot"), 12);
  });
});

describe("the requests sent to Rust are in the file's unit", () => {
  it("keeps the values as they are when display and file units agree", () => {
    expect(thinRequestFor({ method: "grid", size: 0.1, keep: "lowest" }, METRES)).toEqual({ kind: "grid", size: 0.1, keep: "lowest" });
    expect(thinRequestFor({ method: "voxel", size: 2, keep: "lowest" }, METRES)).toEqual({ kind: "voxel", size: 2 });
  });

  it("converts a typed length to the file's unit (display m, file ft)", () => {
    const thin = thinRequestFor({ method: "grid", size: 0.3048, keep: "nearestCentre" }, FEET_IN_METRES);
    expect(thin).toEqual({ kind: "grid", size: 1, keep: "nearestCentre" });
    const ror = filterRequestFor(
      { method: "ror", radius: 0.6096, minNeighbors: 4, k: 8, nSigma: 2, searchRadius: 99 },
      FEET_IN_METRES,
    );
    expect(ror).toEqual({ kind: "ror", radius: 2, minNeighbors: 4 });
  });

  it("an ft display of an ft file is the identity", () => {
    const sor = filterRequestFor({ method: "sor", radius: 1, minNeighbors: 4, k: 8, nSigma: 2, searchRadius: 15 }, FEET_IN_FEET);
    expect(sor.kind).toBe("sor");
    if (sor.kind === "sor") {
      expect(sor.searchRadius).toBeCloseTo(15, 12);
      expect(sor.k).toBe(8);
      expect(sor.nSigma).toBe(2);
    }
  });

  it("takes the number as the file's unit when the unit is unknown", () => {
    expect(thinRequestFor({ method: "voxel", size: 3, keep: "lowest" }, UNKNOWN)).toEqual({ kind: "voxel", size: 3 });
  });
});
