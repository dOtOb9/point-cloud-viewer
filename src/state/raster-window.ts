// The shape of the Rasterize window's state (G1-R3) and its starting values. Plain types and constants, no React:
// src/app/raster-window.ts (the steps) and src/state/useRasterWindow.ts (the holder) both import them.
import type { RasterExportResult, RasterPreviewImage, RasterPreviewSession, RasterValueKind, TiffKind } from "../datasource/raster";

/** What the user chose in the window. The cell size is text in the display unit (m / ft). */
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
  /** The layer the window works on. */
  layerId: string | null;
  /** The kept thinned points (null until they are read). */
  session: RasterPreviewSession | null;
  settings: RasterSettings;
  /** The last picture, or null (not drawn yet, or the last attempt failed: see `error`). */
  image: RasterPreviewImage | null;
  /** "opening": reading the upper levels. "rendering": drawing a picture. */
  busy: "opening" | "rendering" | null;
  /** The text of the last preview failure, shown in the window. */
  error: string | null;
  /** The last export (Web: the download link). */
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
