import { describe, expect, it } from "vitest";
import { decodePreviewImage, exportRangeOf, PREVIEW_HEADER_BYTES } from "./raster";

/** Builds the buffer the way `PreviewImage::to_bytes` in Rust lays it out (the Rust test `to_bytes_has_the_documented_layout` pins that side). */
function buffer(width: number, height: number, range: [number, number] | null, pixels: number[]): ArrayBuffer {
  const out = new ArrayBuffer(PREVIEW_HEADER_BYTES + pixels.length);
  const view = new DataView(out);
  view.setUint32(0, width, true);
  view.setUint32(4, height, true);
  view.setUint32(8, range ? 1 : 0, true);
  view.setFloat32(12, range?.[0] ?? 0, true);
  view.setFloat32(16, range?.[1] ?? 0, true);
  view.setFloat32(20, 2.5, true);
  view.setUint32(24, 7, true);
  view.setUint32(28, 1, true);
  new Uint8Array(out, PREVIEW_HEADER_BYTES).set(pixels);
  return out;
}

describe("decodePreviewImage", () => {
  it("reads the header and the pixels", () => {
    const image = decodePreviewImage(buffer(2, 1, [1.5, 9], [1, 2, 3, 255, 0, 0, 0, 0]));
    expect([image.width, image.height]).toEqual([2, 1]);
    expect(image.range).toEqual({ min: 1.5, max: 9 });
    expect(image.cellSize).toBe(2.5);
    expect([image.points, image.filledCells]).toEqual([7, 1]);
    expect(Array.from(image.rgba)).toEqual([1, 2, 3, 255, 0, 0, 0, 0]);
  });

  it("has no range for RGB", () => {
    expect(decodePreviewImage(buffer(1, 1, null, [9, 9, 9, 255])).range).toBeNull();
  });

  it("refuses a buffer whose size does not match", () => {
    expect(() => decodePreviewImage(buffer(2, 2, null, [0, 0, 0, 0]))).toThrow("プレビューの大きさが合いません");
    expect(() => decodePreviewImage(new ArrayBuffer(4))).toThrow("プレビューの形式が正しくありません");
  });
});

describe("exportRangeOf", () => {
  it("hands the preview's range to the export", () => {
    const image = decodePreviewImage(buffer(1, 1, [3, 8], [0, 0, 0, 255]));
    expect(exportRangeOf(image)).toEqual([3, 8]);
    expect(exportRangeOf(null)).toBeNull();
    expect(exportRangeOf(decodePreviewImage(buffer(1, 1, null, [0, 0, 0, 255])))).toBeNull();
  });
});
