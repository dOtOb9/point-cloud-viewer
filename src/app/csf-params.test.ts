import { describe, expect, it } from "vitest";
import {
  CSF_PRESETS_METRES,
  csfParamsInFileUnits,
  sectionLineRequestFor,
  UNKNOWN_UNIT_CSF_WARNING,
} from "./csf-params";

describe("csfParamsInFileUnits", () => {
  it("leaves metre files as they are, with no warning", () => {
    const r = csfParamsInFileUnits(CSF_PRESETS_METRES.standard, { horizontalToMeter: 1, verticalToMeter: 1 });
    expect(r.params).toEqual(CSF_PRESETS_METRES.standard);
    expect(r.warning).toBeNull();
  });

  it("converts a foot file: spacing by the horizontal factor, heights by the vertical factor", () => {
    const r = csfParamsInFileUnits(CSF_PRESETS_METRES.standard, { horizontalToMeter: 0.3048, verticalToMeter: 0.3048006096 });
    expect(r.params.clothResolution).toBeCloseTo(0.5 / 0.3048, 9);
    expect(r.params.classThresholdUpper).toBeCloseTo(0.1 / 0.3048006096, 9);
    expect(r.params.classThresholdLower).toBeCloseTo(1 / 0.3048006096, 9);
    expect(r.params.hdiff).toBeCloseTo(0.3 / 0.3048006096, 9);
    expect(r.params.convergenceThreshold).toBeCloseTo(0.005 / 0.3048006096, 9);
    // Not lengths: unchanged.
    expect(r.params.rigidness).toBe(3);
    expect(r.params.iterations).toBe(500);
    expect(r.params.timeStep).toBe(0.65);
    expect(r.warning).toBeNull();
  });

  it("uses different factors for the two axes", () => {
    const r = csfParamsInFileUnits(CSF_PRESETS_METRES.steep, { horizontalToMeter: 0.5, verticalToMeter: 2 });
    expect(r.params.clothResolution).toBe(1);
    expect(r.params.classThresholdLower).toBe(0.5);
    expect(r.params.rigidness).toBe(1);
    expect(r.params.iterations).toBe(1500);
  });

  it("leaves the numbers as they are and warns when a unit is unknown", () => {
    const both = csfParamsInFileUnits(CSF_PRESETS_METRES.standard, { horizontalToMeter: null, verticalToMeter: null });
    expect(both.params).toEqual(CSF_PRESETS_METRES.standard);
    expect(both.warning).toBe(UNKNOWN_UNIT_CSF_WARNING);
    const vOnly = csfParamsInFileUnits(CSF_PRESETS_METRES.standard, { horizontalToMeter: 0.3048, verticalToMeter: null });
    expect(vOnly.params.clothResolution).toBeCloseTo(0.5 / 0.3048, 9);
    expect(vOnly.params.classThresholdLower).toBe(1);
    expect(vOnly.warning).toBe(UNKNOWN_UNIT_CSF_WARNING);
  });
});

describe("sectionLineRequestFor", () => {
  it("gives the 20 m corridor and the converted preset in the file's unit", () => {
    const { request, warning } = sectionLineRequestFor("steep", { horizontalToMeter: 0.3048, verticalToMeter: 0.3048 });
    expect(request.corridorHalfWidth).toBeCloseTo(20 / 0.3048, 9);
    expect(request.csf.clothResolution).toBeCloseTo(0.5 / 0.3048, 9);
    expect(request.csf.rigidness).toBe(1);
    expect(warning).toBeNull();
  });

  it("keeps 20 as it is for an unknown unit and warns", () => {
    const { request, warning } = sectionLineRequestFor("standard", { horizontalToMeter: null, verticalToMeter: null });
    expect(request.corridorHalfWidth).toBe(20);
    expect(warning).toBe(UNKNOWN_UNIT_CSF_WARNING);
  });
});
