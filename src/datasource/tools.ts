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
}

/** Progress of the read phase. `totalPoints` is the number of points that will be read. */
export interface ToolProgress {
  pointsRead: number;
  totalPoints: number;
}

/** Error text for zero points (same wording as Rust). Shown on screen as is. */
export const EMPTY_SELECTION_MESSAGE = "選んだ範囲に点がありません";

export interface ToolOptions {
  onProgress?: (progress: ToolProgress) => void;
  /** Temp folder chosen in settings. Desktop only. */
  tempDir?: string | null;
}
