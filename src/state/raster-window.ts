import type { RasterExportResult, RasterPreviewImage, RasterPreviewSession, RasterValueKind, TiffKind } from "../datasource/raster";

export interface RasterSettings {
  value: RasterValueKind;
  groundOnly: boolean;
  cellSizeText: string;
  tiff: TiffKind;
}

export const DEFAULT_RASTER_SETTINGS: RasterSettings = {
  value: "zMean",
  groundOnly: false,
  cellSizeText: "1",
  tiff: "colored",
};

export interface RasterWindowState {
  open: boolean;
  layerId: string | null;
  session: RasterPreviewSession | null;
  settings: RasterSettings;
  image: RasterPreviewImage | null;
  busy: "opening" | "rendering" | null;
  error: string | null;
  exported: RasterExportResult | null;
}

export const CLOSED_RASTER_WINDOW: RasterWindowState = {
  open: false,
  layerId: null,
  session: null,
  settings: DEFAULT_RASTER_SETTINGS,
  image: null,
  busy: null,
  error: null,
  exported: null,
};
