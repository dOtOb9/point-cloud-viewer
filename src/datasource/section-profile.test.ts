import { describe, expect, it } from "vitest";
import { decodeSectionProfile } from "./section-profile";

/** Build a buffer in the layout `crates/pcv-core/src/profile.rs` writes. */
function build(points: { s: number; z: number; rgbc: [number, number, number, number] }[], flags: number): ArrayBuffer {
  const buffer = new ArrayBuffer(24 + points.length * 12);
  const view = new DataView(buffer);
  view.setUint32(0, points.length, true);
  view.setUint32(4, flags, true);
  view.setFloat32(8, Math.min(...points.map((p) => p.s)), true);
  view.setFloat32(12, Math.max(...points.map((p) => p.s)), true);
  view.setFloat32(16, Math.min(...points.map((p) => p.z)), true);
  view.setFloat32(20, Math.max(...points.map((p) => p.z)), true);
  points.forEach((p, i) => {
    const o = 24 + i * 12;
    view.setFloat32(o, p.s, true);
    view.setFloat32(o + 4, p.z, true);
    p.rgbc.forEach((v, k) => view.setUint8(o + 8 + k, v));
  });
  return buffer;
}

describe("decodeSectionProfile", () => {
  it("reads the header and the interleaved records", () => {
    const decoded = decodeSectionProfile(
      build(
        [
          { s: 1.5, z: 10, rgbc: [1, 2, 3, 6] },
          { s: 4, z: -2, rgbc: [255, 0, 0, 2] },
        ],
        3,
      ),
    );
    expect(decoded.count).toBe(2);
    expect(decoded.thinned).toBe(true);
    expect(decoded.hasColor).toBe(true);
    expect(decoded.sRange).toEqual({ min: 1.5, max: 4 });
    expect(decoded.zRange).toEqual({ min: -2, max: 10 });
    expect([decoded.floats[0], decoded.floats[1]]).toEqual([1.5, 10]);
    expect([decoded.floats[3], decoded.floats[4]]).toEqual([4, -2]);
    // Little endian: r | g << 8 | b << 16 | classification << 24.
    expect(decoded.words[2]).toBe((1 | (2 << 8) | (3 << 16) | (6 << 24)) >>> 0);
    expect(decoded.words[5] >>> 24).toBe(2);
  });

  it("reads the flags separately", () => {
    const decoded = decodeSectionProfile(build([{ s: 0, z: 0, rgbc: [0, 0, 0, 0] }], 0));
    expect(decoded.thinned).toBe(false);
    expect(decoded.hasColor).toBe(false);
  });

  it("rejects a buffer whose size does not match its header", () => {
    expect(() => decodeSectionProfile(new ArrayBuffer(10))).toThrow();
    const cut = build([{ s: 0, z: 0, rgbc: [0, 0, 0, 0] }], 0).slice(0, 30);
    expect(() => decodeSectionProfile(cut)).toThrow();
  });
});
