// L2-C: types for the functions the point-cloud tools (point selection, cross
// section, multi-layer) call to "create a new point cloud from a chosen layer".
// Same shape on desktop (tauri.ts) and Web (web.ts). Coordinates are always the
// file's real coordinates (f64, i.e. with the rendering origin shift undone).
// The matching Rust type is ExtractFilter in `crates/pcv-core/src/extract.rs`.

/** A polygon on screen. Points that project inside it and are in front of the camera
 *  (w > 0) are selected. Depth does not matter. */
export interface ScreenPolygonFilter {
  kind: "screenPolygon";
  /** World (the file's real coordinates) to clip coordinates; 16 elements, column-major. */
  viewProj: number[];
  /** Vertices in NDC (x and y in -1..1). At least 3; need not be closed. */
  polygonNdc: [number, number][];
}

/** An oriented box (the slab of a cross section). */
export interface OrientedBoxFilter {
  kind: "orientedBox";
  center: [number, number, number];
  /** Three orthonormal axes (unit length). */
  axes: [[number, number, number], [number, number, number], [number, number, number]];
  /** Half the length along each axis (0 or more). */
  halfExtents: [number, number, number];
}

export type ExtractFilter = ScreenPolygonFilter | OrientedBoxFilter;

/** Result of an extraction or merge. `outputPath` can be passed straight to
 *  `DataSource.open()` (a temp-folder path on desktop, a registered file key
 *  "file:N" on Web). */
export interface ToolResult {
  outputPath: string;
  pointCount: number;
  /** Warnings for the error log (ADR-0011), e.g. files without a CRS were let
   *  through. Empty when there are none. */
  warnings: string[];
  /** Only the Rasterize tool sets this (G1): what to show about the raster on the new layer. */
  raster?: RasterLayerInfo;
}

/** Progress of the read phase. `totalPoints` is the number of points that will be read. */
export interface ToolProgress {
  pointsRead: number;
  totalPoints: number;
}

export interface ToolOptions {
  onProgress?: (progress: ToolProgress) => void;
  /** Temp folder chosen in settings. Desktop only. */
  tempDir?: string | null;
}

// --- G1: rasterize ---
// The Rasterize tool (plan `TaskSheets/G1-raster-and-dtm.md`, 2.1). Rust types: `RasterOptions` and
// `RasterValue` in `crates/pcv-core/src/raster/`.

/** What each cell of the raster holds. RGB is offered only when the layer has colour. */
export type RasterValueKind = "zMin" | "zMax" | "zMean" | "count" | "intensityMean" | "rgbMean";

/** The user's choices. `cellSize` is in the file's horizontal unit (the dialog converts from m / ft). */
export interface RasterRequest {
  cellSize: number;
  value: RasterValueKind;
  /** Count only points classified as ground (2). */
  groundOnly: boolean;
}

/** The GeoTIFF as the UI needs it: a file on disk (desktop) or a download (Web). */
export interface RasterGeoTiff {
  /** Desktop: the file in the temp folder. The "保存" button copies it where the user chooses. */
  path: string | null;
  /** Web: an object URL and the suggested file name. */
  download: { url: string; fileName: string } | null;
}

/** What is left on the display layer of a raster (shown in the layer info). */
export interface RasterLayerInfo extends RasterRequest {
  width: number;
  height: number;
  geotiff: RasterGeoTiff;
}
