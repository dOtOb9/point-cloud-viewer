// G1-T15: the setting "DTM の出力形式" (owner's answer Q18: the format is chosen in the settings, not in the DTM dialog).
// Pure functions for reading and writing it with `localStorage`, like src/state/motion-setting.ts. The React store that
// shares the value is src/state/useDtmOutput.ts.
import type { TiffKind } from "../datasource/raster";

/** Which DTM files to make. */
export type DtmFormat = "geotiff" | "landxml" | "both";

export interface DtmOutputSetting {
  format: DtmFormat;
  /** The kind of GeoTIFF (when one is made): the picture as seen (RGBA 8 bit) or the raw float32 values. */
  tiff: TiffKind;
}

export const DTM_OUTPUT_STORAGE_KEY = "pcv-dtm-output";

/** GeoTIFF, coloured. */
export const DEFAULT_DTM_OUTPUT: DtmOutputSetting = { format: "geotiff", tiff: "colored" };

const FORMATS: readonly DtmFormat[] = ["geotiff", "landxml", "both"];
const TIFF_KINDS: readonly TiffKind[] = ["colored", "values"];

/** Reads the stored setting. Anything missing or wrong falls back to the default for that field. */
export function parseDtmOutput(stored: string | null | undefined): DtmOutputSetting {
  if (!stored) return DEFAULT_DTM_OUTPUT;
  try {
    const value: unknown = JSON.parse(stored);
    if (typeof value !== "object" || value === null) return DEFAULT_DTM_OUTPUT;
    const { format, tiff } = value as { format?: unknown; tiff?: unknown };
    return {
      format: FORMATS.find((f) => f === format) ?? DEFAULT_DTM_OUTPUT.format,
      tiff: TIFF_KINDS.find((k) => k === tiff) ?? DEFAULT_DTM_OUTPUT.tiff,
    };
  } catch {
    return DEFAULT_DTM_OUTPUT;
  }
}

export function readStoredDtmOutput(storage: Pick<Storage, "getItem"> | undefined): DtmOutputSetting {
  try {
    return parseDtmOutput(storage?.getItem(DTM_OUTPUT_STORAGE_KEY));
  } catch {
    return DEFAULT_DTM_OUTPUT;
  }
}

/** Saves the setting. If it cannot be saved the choice still applies until the page is reloaded. */
export function storeDtmOutput(storage: Pick<Storage, "setItem"> | undefined, setting: DtmOutputSetting): void {
  try {
    storage?.setItem(DTM_OUTPUT_STORAGE_KEY, JSON.stringify(setting));
  } catch {
    // Not saved.
  }
}

/** The line shown in the DTM dialog: what will be made, in words. */
export function describeDtmOutput(setting: DtmOutputSetting): string {
  const tiff = setting.tiff === "colored" ? "GeoTIFF（色付き）" : "GeoTIFF（値のまま）";
  switch (setting.format) {
    case "geotiff":
      return tiff;
    case "landxml":
      return "LandXML";
    case "both":
      return `${tiff} と LandXML`;
  }
}
