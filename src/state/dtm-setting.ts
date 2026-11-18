import type { TiffKind } from "../datasource/raster";
import { saveSettingIfStorageAllows } from "./setting-storage";

export type DtmFormat = "geotiff" | "landxml" | "both";

export interface DtmOutputSetting {
  format: DtmFormat;
  tiff: TiffKind;
}

export const DTM_OUTPUT_STORAGE_KEY = "pcv-dtm-output";

export const DEFAULT_DTM_OUTPUT: DtmOutputSetting = { format: "geotiff", tiff: "colored" };

const FORMATS: readonly DtmFormat[] = ["geotiff", "landxml", "both"];
const TIFF_KINDS: readonly TiffKind[] = ["colored", "values"];

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

export function storeDtmOutput(storage: Pick<Storage, "setItem"> | undefined, setting: DtmOutputSetting): void {
  saveSettingIfStorageAllows(() => storage?.setItem(DTM_OUTPUT_STORAGE_KEY, JSON.stringify(setting)));
}

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
