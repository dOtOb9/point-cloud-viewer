import { describe, expect, it } from "vitest";
import { peekLasPointCount, peekPcdPointCount, peekPlyPointCount } from "./point-count-estimate";

/** 最小限のLASヘッダーバイト列を組み立てる(テスト専用。`copc-header.test.ts`
 *  が組み立てるヘッダーと同じ考え方で、見る場所(VLRではなく点数)が違う)。 */
function buildLasHeader(options: {
  minorVersion: number;
  headerSize: number;
  legacyPointCount: number;
  extendedPointCount?: bigint;
}): Uint8Array {
  const totalLength = Math.max(options.headerSize, 255);
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  bytes[25] = options.minorVersion;
  view.setUint16(94, options.headerSize, true);
  view.setUint32(107, options.legacyPointCount, true);
  if (options.extendedPointCount !== undefined) {
    view.setBigUint64(247, options.extendedPointCount, true);
  }
  return bytes;
}

describe("peekLasPointCount", () => {
  it("LAS 1.2(レガシーフィールドのみ)の点数を読む", () => {
    const bytes = buildLasHeader({ minorVersion: 2, headerSize: 227, legacyPointCount: 12_345 });
    expect(peekLasPointCount(bytes)).toBe(12_345);
  });

  it("LAS 1.4で拡張フィールド(64bit)が0でなければそちらを優先する", () => {
    const bytes = buildLasHeader({
      minorVersion: 4,
      headerSize: 375,
      legacyPointCount: 0, // 1.4かつpoint format 6-10等で0になりうる
      extendedPointCount: 364_384_576n,
    });
    expect(peekLasPointCount(bytes)).toBe(364_384_576);
  });

  it("LAS 1.4でも拡張フィールドが0ならレガシーフィールドにフォールバックする", () => {
    const bytes = buildLasHeader({
      minorVersion: 4,
      headerSize: 375,
      legacyPointCount: 999,
      extendedPointCount: 0n,
    });
    expect(peekLasPointCount(bytes)).toBe(999);
  });

  it("短すぎるバイト列はnullを返す", () => {
    expect(peekLasPointCount(new Uint8Array(10))).toBeNull();
  });
});

describe("peekPcdPointCount", () => {
  it("POINTSフィールドをそのまま読む", () => {
    const header = [
      "# .PCD v0.7",
      "VERSION 0.7",
      "FIELDS x y z",
      "SIZE 4 4 4",
      "TYPE F F F",
      "COUNT 1 1 1",
      "WIDTH 213",
      "HEIGHT 1",
      "VIEWPOINT 0 0 0 1 0 0 0",
      "POINTS 213",
      "DATA ascii",
    ].join("\n");
    expect(peekPcdPointCount(header)).toBe(213);
  });

  it("POINTSが無ければWIDTH×HEIGHTで計算する", () => {
    const header = ["WIDTH 100", "HEIGHT 5", "DATA binary"].join("\n");
    expect(peekPcdPointCount(header)).toBe(500);
  });

  it("どちらも無ければnullを返す", () => {
    expect(peekPcdPointCount("VERSION 0.7\nDATA ascii")).toBeNull();
  });
});

describe("peekPlyPointCount", () => {
  it("element vertex行から点数を読む(ASCII形式)", () => {
    const header = [
      "ply",
      "format ascii 1.0",
      "comment created by test",
      "element vertex 1000",
      "property float x",
      "property float y",
      "property float z",
      "end_header",
    ].join("\n");
    expect(peekPlyPointCount(header)).toBe(1000);
  });

  it("binary形式でもヘッダー自体はASCIIなので読める", () => {
    const header = [
      "ply",
      "format binary_little_endian 1.0",
      "element vertex 42",
      "property float x",
      "end_header",
    ].join("\n");
    expect(peekPlyPointCount(header)).toBe(42);
  });

  it("faceなど他のelementがあっても、vertexを正しく選ぶ", () => {
    const header = [
      "ply",
      "format ascii 1.0",
      "element vertex 5",
      "property float x",
      "element face 2",
      "property list uchar int vertex_indices",
      "end_header",
    ].join("\n");
    expect(peekPlyPointCount(header)).toBe(5);
  });

  it("element vertex行が無ければnullを返す", () => {
    expect(peekPlyPointCount("ply\nformat ascii 1.0\nend_header")).toBeNull();
  });
});
