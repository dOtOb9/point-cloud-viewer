import { describe, expect, it } from "vitest";
import { ELEVATION_INTENSITY_RAMP, rampToWgslFunction } from "../colormap";
import edlWgsl from "./edl.wgsl?raw";
import pointsWgsl from "./points.wgsl?raw";

describe("shader files that the TypeScript side completes", () => {
  it("points.wgsl calls the elevation and intensity ramp that gpu-resources.ts generates from ELEVATION_INTENSITY_RAMP", () => {
    const generated = rampToWgslFunction("elevationOrIntensityRampColor", ELEVATION_INTENSITY_RAMP);
    expect(generated).toContain("fn elevationOrIntensityRampColor(");
    expect(pointsWgsl).toContain("elevationOrIntensityRampColor(t)");
    expect(pointsWgsl).not.toContain("fn elevationOrIntensityRampColor(");
  });

  it("edl.wgsl uses EDL_MIN_SHADE and EDL_RESPONSE_SCALE but leaves their values to edl.ts", () => {
    expect(edlWgsl).toContain("EDL_MIN_SHADE");
    expect(edlWgsl).toContain("EDL_RESPONSE_SCALE");
    expect(edlWgsl).not.toMatch(/const EDL_/);
  });

  it("no shader file keeps two blank lines in a row where a comment or a template value was removed", () => {
    const shaders = import.meta.glob<string>("./*.wgsl", { query: "?raw", import: "default", eager: true });
    const doubleBlankLines = Object.entries(shaders)
      .filter(([, text]) => /\r?\n[ \t]*\r?\n[ \t]*\r?\n/.test(text))
      .map(([path]) => path);
    expect(Object.keys(shaders).length).toBe(5);
    expect(doubleBlankLines).toEqual([]);
  });
});
