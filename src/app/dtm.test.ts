import { describe, expect, it } from "vitest";
import { CSF_PRESETS_METRES } from "./csf-params";
import {
  DTM_DEFAULT_CELL_SIZE_M,
  csfPresetInDisplay,
  dtmOutputOptionsFor,
  dtmRequestFor,
  landXmlUnitFor,
  presetOf,
} from "./dtm";
import { INTERNATIONAL_FOOT_IN_METERS, type LengthUnits } from "../state/units";

const METRES: LengthUnits = { horizontalToMeter: 1, verticalToMeter: 1, display: "meter" };
const OUTPUT = { format: "geotiff", tiff: "colored" } as const;

describe("csfPresetInDisplay", () => {
  it("is the preset itself in metres", () => {
    expect(csfPresetInDisplay("standard", "meter")).toEqual(CSF_PRESETS_METRES.standard);
    expect(csfPresetInDisplay("steep", "meter")).toEqual(CSF_PRESETS_METRES.steep);
  });

  it("shows the lengths in feet and nothing else changes", () => {
    const feet = csfPresetInDisplay("standard", "foot");
    expect(feet.clothResolution).toBeCloseTo(0.5 / INTERNATIONAL_FOOT_IN_METERS, 9);
    expect(feet.classThresholdLower).toBeCloseTo(1 / INTERNATIONAL_FOOT_IN_METERS, 9);
    expect(feet.rigidness).toBe(3);
    expect(feet.iterations).toBe(500);
  });
});

describe("presetOf", () => {
  it("knows the presets in either unit, and calls any other value custom", () => {
    for (const display of ["meter", "foot"] as const) {
      expect(presetOf(csfPresetInDisplay("standard", display), display)).toBe("standard");
      expect(presetOf(csfPresetInDisplay("steep", display), display)).toBe("steep");
      expect(presetOf({ ...csfPresetInDisplay("standard", display), rigidness: 5 }, display)).toBe("custom");
      expect(presetOf({ ...csfPresetInDisplay("standard", display), slopeSmooth: false }, display)).toBe("custom");
    }
  });
});

describe("dtmRequestFor", () => {
  it("in metres with metre files the request is the preset and the cell size as they are", () => {
    const { request, warning } = dtmRequestFor(
      { csf: csfPresetInDisplay("standard", "meter"), cellSize: DTM_DEFAULT_CELL_SIZE_M },
      METRES,
      OUTPUT,
    );
    expect(warning).toBeNull();
    expect(request.csf).toEqual(CSF_PRESETS_METRES.standard);
    expect(request.cellSize).toBe(0.5);
    expect(request.output).toEqual({ geotiff: true, landxml: false, tiff: "colored", unit: "meter" });
    expect(request.displayUnit).toEqual({ symbol: "m", fileUnitsPerDisplayUnit: 1 });
  });

  it("names the display unit: feet on screen over metre files is 0.3048 file units per ft", () => {
    const { request } = dtmRequestFor({ csf: csfPresetInDisplay("standard", "foot"), cellSize: 2 }, { ...METRES, display: "foot" }, OUTPUT);
    expect(request.displayUnit.symbol).toBe("ft");
    expect(request.displayUnit.fileUnitsPerDisplayUnit).toBeCloseTo(INTERNATIONAL_FOOT_IN_METERS, 12);
  });

  it("metres on screen over foot files is 1 / 0.3048 file units per m", () => {
    const feetFile: LengthUnits = { horizontalToMeter: INTERNATIONAL_FOOT_IN_METERS, verticalToMeter: INTERNATIONAL_FOOT_IN_METERS, display: "meter" };
    const { request } = dtmRequestFor({ csf: csfPresetInDisplay("standard", "meter"), cellSize: 1 }, feetFile, OUTPUT);
    expect(request.displayUnit.symbol).toBe("m");
    expect(request.displayUnit.fileUnitsPerDisplayUnit).toBeCloseTo(1 / INTERNATIONAL_FOOT_IN_METERS, 9);
  });

  it("converts through the display unit to the file's unit (feet files shown in metres)", () => {
    const feetFile: LengthUnits = { horizontalToMeter: INTERNATIONAL_FOOT_IN_METERS, verticalToMeter: INTERNATIONAL_FOOT_IN_METERS, display: "meter" };
    const { request } = dtmRequestFor({ csf: csfPresetInDisplay("standard", "meter"), cellSize: 1 }, feetFile, OUTPUT);
    expect(request.cellSize).toBeCloseTo(1 / INTERNATIONAL_FOOT_IN_METERS, 9);
    expect(request.csf.clothResolution).toBeCloseTo(0.5 / INTERNATIONAL_FOOT_IN_METERS, 9);
    expect(request.csf.classThresholdUpper).toBeCloseTo(0.1 / INTERNATIONAL_FOOT_IN_METERS, 9);
    expect(request.output.unit).toBe("foot");
  });

  it("feet on screen and metre files give the same request as metres on screen", () => {
    const fromFeet = dtmRequestFor(
      { csf: csfPresetInDisplay("steep", "foot"), cellSize: 0.5 / INTERNATIONAL_FOOT_IN_METERS },
      { ...METRES, display: "foot" },
      OUTPUT,
    ).request;
    const fromMetres = dtmRequestFor({ csf: csfPresetInDisplay("steep", "meter"), cellSize: 0.5 }, METRES, OUTPUT).request;
    expect(fromFeet.cellSize).toBeCloseTo(fromMetres.cellSize, 9);
    expect(fromFeet.csf.clothResolution).toBeCloseTo(fromMetres.csf.clothResolution, 9);
    expect(fromFeet.csf.hdiff).toBeCloseTo(fromMetres.csf.hdiff, 9);
    expect(fromFeet.csf.iterations).toBe(1500);
  });

  it("an unknown unit leaves the values as they are and warns", () => {
    const unknown: LengthUnits = { horizontalToMeter: null, verticalToMeter: null, display: "meter" };
    const { request, warning } = dtmRequestFor({ csf: csfPresetInDisplay("standard", "meter"), cellSize: 0.5 }, unknown, OUTPUT);
    expect(warning).not.toBeNull();
    expect(request.cellSize).toBe(0.5);
    expect(request.csf.clothResolution).toBe(0.5);
    expect(request.output.unit).toBe("unknown");
    expect(request.displayUnit).toEqual({ symbol: "m", fileUnitsPerDisplayUnit: null });
  });
});

describe("dtmOutputOptionsFor and landXmlUnitFor", () => {
  it("maps the setting to the files", () => {
    expect(dtmOutputOptionsFor({ format: "geotiff", tiff: "values" }, METRES)).toMatchObject({ geotiff: true, landxml: false, tiff: "values" });
    expect(dtmOutputOptionsFor({ format: "landxml", tiff: "colored" }, METRES)).toMatchObject({ geotiff: false, landxml: true });
    expect(dtmOutputOptionsFor({ format: "both", tiff: "colored" }, METRES)).toMatchObject({ geotiff: true, landxml: true });
  });

  it("names the unit of the file", () => {
    expect(landXmlUnitFor(1)).toBe("meter");
    expect(landXmlUnitFor(0.3048)).toBe("foot");
    expect(landXmlUnitFor(1200 / 3937)).toBe("usSurveyFoot");
    expect(landXmlUnitFor(null)).toBe("unknown");
    expect(landXmlUnitFor(0.5)).toBe("unknown");
  });
});
