import { describe, expect, it } from "vitest";
import {
  DEFAULT_DTM_OUTPUT,
  DTM_OUTPUT_STORAGE_KEY,
  describeDtmOutput,
  parseDtmOutput,
  readStoredDtmOutput,
  storeDtmOutput,
} from "./dtm-setting";

function fakeStorage(initial: Record<string, string> = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("DTM の出力形式の設定", () => {
  it("nothing stored: GeoTIFF, coloured", () => {
    expect(readStoredDtmOutput(fakeStorage())).toEqual({ format: "geotiff", tiff: "colored" });
    expect(DEFAULT_DTM_OUTPUT).toEqual({ format: "geotiff", tiff: "colored" });
  });

  it("a saved setting comes back", () => {
    const s = fakeStorage();
    storeDtmOutput(s, { format: "both", tiff: "values" });
    expect(s.data[DTM_OUTPUT_STORAGE_KEY]).toBe('{"format":"both","tiff":"values"}');
    expect(readStoredDtmOutput(s)).toEqual({ format: "both", tiff: "values" });
    storeDtmOutput(s, { format: "landxml", tiff: "colored" });
    expect(readStoredDtmOutput(s)).toEqual({ format: "landxml", tiff: "colored" });
  });

  it("a wrong or broken value falls back to the default for that field", () => {
    expect(parseDtmOutput("not json")).toEqual(DEFAULT_DTM_OUTPUT);
    expect(parseDtmOutput("null")).toEqual(DEFAULT_DTM_OUTPUT);
    expect(parseDtmOutput('{"format":"shapefile","tiff":"values"}')).toEqual({ format: "geotiff", tiff: "values" });
    expect(parseDtmOutput('{"format":"both","tiff":42}')).toEqual({ format: "both", tiff: "colored" });
  });

  it("storage that throws does not break reading or writing", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readStoredDtmOutput(broken)).toEqual(DEFAULT_DTM_OUTPUT);
    expect(() => storeDtmOutput(broken, DEFAULT_DTM_OUTPUT)).not.toThrow();
    expect(readStoredDtmOutput(undefined)).toEqual(DEFAULT_DTM_OUTPUT);
  });

  it("says what will be made", () => {
    expect(describeDtmOutput({ format: "geotiff", tiff: "colored" })).toBe("GeoTIFF（色付き）");
    expect(describeDtmOutput({ format: "geotiff", tiff: "values" })).toBe("GeoTIFF（値のまま）");
    expect(describeDtmOutput({ format: "landxml", tiff: "values" })).toBe("LandXML");
    expect(describeDtmOutput({ format: "both", tiff: "colored" })).toBe("GeoTIFF（色付き） と LandXML");
  });
});
