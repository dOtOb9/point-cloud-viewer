// G1-R2: types and the decoder for the Rasterize window (plan `TaskSheets/G1-raster-and-dtm.md`, section 13).
// Rust types: `RasterOptions`, `PreviewOptions`, `PreviewOpenInfo` and `PreviewImage::to_bytes`
// in `crates/pcv-core/src/raster/`. Desktop and Web both hand the preview over as one buffer, decoded here.

/** What each cell of the raster holds. RGB is offered only when the layer has colour. */
export type RasterValueKind = "zMin" | "zMax" | "zMean" | "count" | "intensityMean" | "rgbMean";

/** The window's settings. `cellSize` is in the file's horizontal unit (the window converts from m / ft). */
export interface RasterRequest {
  cellSize: number;
  value: RasterValueKind;
  /** Count only points classified as ground (2). */
  groundOnly: boolean;
}

/** Which GeoTIFF to export: the picture as seen (8-bit RGBA) or the raw values. */
export type TiffKind = "colored" | "values";

/** The export: the settings, the kind of file, and the colour range of the preview (so the colours match). */
export interface RasterExportRequest extends RasterRequest {
  tiff: TiffKind;
  /** `[min, max]` of the preview's values, or null (RGB, or no preview yet). */
  range: [number, number] | null;
}

/** What the window learns when the thinned points are ready (`PreviewOpenInfo` in Rust). */
export interface RasterPreviewInfo {
  heldPoints: number;
  /** The deepest COPC level that was read. */
  depth: number;
  /** The cap was reached before the selected levels were read completely. */
  truncated: boolean;
}

/** An open preview: the id of the kept points (Rust side) and what was read. */
export interface RasterPreviewSession {
  id: number;
  info: RasterPreviewInfo;
}

/** A rendered preview. `rgba` is row 0 = north, alpha 0 = empty cell. */
export interface RasterPreviewImage {
  width: number;
  height: number;
  /** The colour range of the values; null for RGB. The legend shows it and the export gets it back. */
  range: { min: number; max: number } | null;
  /** The cell size the preview really used (it can be coarser than the one asked for), in the file's unit. */
  cellSize: number;
  /** Held points that were added (after the class filter). */
  points: number;
  filledCells: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

/** The GeoTIFF as the UI needs it: a file on disk (desktop) or a download (Web). */
export interface RasterExportResult {
  width: number;
  height: number;
  warnings: string[];
  /** Desktop: the file in the temp folder (copy it with `saveToolFile`). */
  path: string | null;
  /** Web: an object URL and the suggested file name. */
  download: { url: string; fileName: string } | null;
}

/** Bytes in front of the pixels (`PREVIEW_HEADER_BYTES` in Rust). */
export const PREVIEW_HEADER_BYTES = 32;

/**
 * Reads the buffer `PreviewImage::to_bytes` makes (little-endian):
 * u32 width | u32 height | u32 flags (bit 0: range) | f32 min | f32 max | f32 cell size | u32 points | u32 filled cells,
 * then width * height * 4 bytes of RGBA.
 */
export function decodePreviewImage(buffer: ArrayBuffer): RasterPreviewImage {
  if (buffer.byteLength < PREVIEW_HEADER_BYTES) throw new Error("プレビューの形式が正しくありません");
  const view = new DataView(buffer);
  const width = view.getUint32(0, true);
  const height = view.getUint32(4, true);
  const flags = view.getUint32(8, true);
  const pixelBytes = width * height * 4;
  if (buffer.byteLength !== PREVIEW_HEADER_BYTES + pixelBytes) throw new Error("プレビューの大きさが合いません");
  return {
    width,
    height,
    range: (flags & 1) !== 0 ? { min: view.getFloat32(12, true), max: view.getFloat32(16, true) } : null,
    cellSize: view.getFloat32(20, true),
    points: view.getUint32(24, true),
    filledCells: view.getUint32(28, true),
    rgba: new Uint8ClampedArray(buffer.slice(PREVIEW_HEADER_BYTES)),
  };
}

/** The `range` the export wants, from a preview. */
export function exportRangeOf(image: RasterPreviewImage | null): [number, number] | null {
  return image?.range ? [image.range.min, image.range.max] : null;
}
