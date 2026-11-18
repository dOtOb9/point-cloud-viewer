export type RasterValueKind = "zMin" | "zMax" | "zMean" | "count" | "intensityMean" | "rgbMean";

export interface RasterRequest {
  cellSize: number;
  value: RasterValueKind;
  groundOnly: boolean;
}

export type TiffKind = "colored" | "values";

export interface RasterExportRequest extends RasterRequest {
  tiff: TiffKind;
  range: [number, number] | null;
}

export interface RasterPreviewInfo {
  heldPoints: number;
  depth: number;
  truncated: boolean;
}

export interface RasterPreviewSession {
  id: number;
  info: RasterPreviewInfo;
}

export interface RasterPreviewImage {
  width: number;
  height: number;
  range: { min: number; max: number } | null;
  cellSize: number;
  points: number;
  filledCells: number;
  rgba: Uint8ClampedArray<ArrayBuffer>;
}

export interface RasterExportResult {
  width: number;
  height: number;
  warnings: string[];
  path: string | null;
  download: { url: string; fileName: string } | null;
}

export const PREVIEW_HEADER_BYTES = 32;

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

export function exportRangeOf(image: RasterPreviewImage | null): [number, number] | null {
  return image?.range ? [image.range.min, image.range.max] : null;
}
