// copc-header.ts のテスト。手組みの最小LASヘッダー+VLRバイト列で、
// `isCopcHeader`がCOPC info VLR(user_id="copc", record_id=1)の有無を
// 正しく判定できることを確認する。

import { describe, expect, it } from "vitest";
import { isCopcHeader } from "./copc-header";

/** ヘッダーサイズ(オフセット94)を書き込んだ、最小限のバイト列を作る。 */
function makeHeaderBytes(headerSize: number, totalLength: number): Uint8Array {
  const bytes = new Uint8Array(totalLength);
  const view = new DataView(bytes.buffer);
  view.setUint16(94, headerSize, true);
  return bytes;
}

/** `vlrStart`の位置に、指定したuser_id(ヌル終端)・record_idのVLRヘッダーを書く。 */
function writeVlrHeader(bytes: Uint8Array, vlrStart: number, userId: string, recordId: number): void {
  const view = new DataView(bytes.buffer);
  const userIdBytes = new TextEncoder().encode(userId);
  bytes.set(userIdBytes, vlrStart + 2);
  view.setUint16(vlrStart + 18, recordId, true);
}

describe("isCopcHeader", () => {
  it("COPC info VLR(user_id=copc, record_id=1)があればtrue", () => {
    const headerSize = 375;
    const bytes = makeHeaderBytes(headerSize, headerSize + 64);
    writeVlrHeader(bytes, headerSize, "copc", 1);

    expect(isCopcHeader(bytes)).toBe(true);
  });

  it("user_idが違えばfalse", () => {
    const headerSize = 375;
    const bytes = makeHeaderBytes(headerSize, headerSize + 64);
    writeVlrHeader(bytes, headerSize, "LASF_Projection", 34735);

    expect(isCopcHeader(bytes)).toBe(false);
  });

  it("user_idはcopcだがrecord_idが違えばfalse", () => {
    const headerSize = 375;
    const bytes = makeHeaderBytes(headerSize, headerSize + 64);
    writeVlrHeader(bytes, headerSize, "copc", 1000); // COPC hierarchy EVLR相当

    expect(isCopcHeader(bytes)).toBe(false);
  });

  it("バイト列が短すぎる場合はfalse(例外を投げない)", () => {
    expect(isCopcHeader(new Uint8Array(10))).toBe(false);
    expect(isCopcHeader(makeHeaderBytes(375, 380))).toBe(false); // VLRヘッダー分が足りない
  });
});
