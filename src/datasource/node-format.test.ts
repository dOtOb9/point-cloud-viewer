// node-format.ts のテスト。M2-2で追加した`computeIntensityRange`を検証する
// （強度カラーマップのレンジを実データから動的に決めるための下請け関数、
// src/renderer/colormap.tsの`extendRange`と組み合わせて使う）。

import { describe, expect, it } from "vitest";
import { computeIntensityRange, NODE_POINT_STRIDE, type ParsedNode } from "./node-format";

/**
 * テスト用に、指定したintensity列を持つ`pointsBytes`を組み立てる。
 * position/color/classificationは着色レンジの計算に無関係なのでダミー値でよい。
 */
function makeNode(intensities: readonly number[]): ParsedNode {
  const bytes = new Uint8Array(intensities.length * NODE_POINT_STRIDE);
  const view = new DataView(bytes.buffer);
  intensities.forEach((intensity, i) => {
    const offset = i * NODE_POINT_STRIDE;
    // position(12B)・color(4B)は0埋めのままでよい。
    view.setUint16(offset + 16, intensity, true);
    view.setUint8(offset + 18, 0); // classification
    view.setUint8(offset + 19, 0); // padding
  });
  return {
    pointCount: intensities.length,
    origin: [0, 0, 0],
    flags: 0,
    hasColor: false,
    pointsBytes: bytes,
  };
}

describe("computeIntensityRange", () => {
  it("複数点のintensityから最小・最大を求める", () => {
    const node = makeNode([100, 5000, 42, 65535, 0]);
    expect(computeIntensityRange(node)).toEqual({ min: 0, max: 65535 });
  });

  it("点が1つだけならmin=maxになる", () => {
    const node = makeNode([777]);
    expect(computeIntensityRange(node)).toEqual({ min: 777, max: 777 });
  });

  it("点が0個のノードはnullを返す(レンジが定義できない)", () => {
    const node = makeNode([]);
    expect(computeIntensityRange(node)).toBeNull();
  });

  it("先頭以外のバイトオフセットにあるバッファでも正しく読む(byteOffset != 0)", () => {
    // pointsBytesが常にArrayBufferの先頭から始まるとは限らない
    // (parseNodeBufferはヘッダ32Bの後ろをスライスして返す)ことを想定した確認。
    const inner = makeNode([10, 20, 30]);
    const padded = new Uint8Array(8 + inner.pointsBytes.byteLength);
    padded.set(inner.pointsBytes, 8);
    const nodeWithOffset: ParsedNode = {
      ...inner,
      pointsBytes: new Uint8Array(padded.buffer, 8, inner.pointsBytes.byteLength),
    };
    expect(computeIntensityRange(nodeWithOffset)).toEqual({ min: 10, max: 30 });
  });
});
