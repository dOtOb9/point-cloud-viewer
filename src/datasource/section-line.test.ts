import { describe, expect, it } from "vitest";
import { buildSectionLineStartRequest } from "./web-protocol";
import { decodeSectionLine } from "./section-line";
import type { SectionLineInput } from "./section-profile";

/** Build a buffer in the layout `crates/pcv-core/src/section_line.rs` writes. */
function build(samples: [number, number][], groundPoints: number, cells: number): ArrayBuffer {
  const buffer = new ArrayBuffer(16 + samples.length * 8);
  const view = new DataView(buffer);
  view.setUint32(0, samples.length, true);
  view.setUint32(4, 0, true);
  view.setUint32(8, groundPoints, true);
  view.setUint32(12, cells, true);
  samples.forEach(([s, z], i) => {
    view.setFloat32(16 + i * 8, s, true);
    view.setFloat32(16 + i * 8 + 4, z, true);
  });
  return buffer;
}

describe("decodeSectionLine", () => {
  it("reads the header and the (s, z) pairs", () => {
    const line = decodeSectionLine(
      build(
        [
          [0, 1.5],
          [0.5, 2.25],
          [1, -3],
        ],
        120,
        400,
      ),
    );
    expect(Array.from(line.points)).toEqual([0, 1.5, 0.5, 2.25, 1, -3]);
    expect(line.groundPoints).toBe(120);
    expect(line.cells).toBe(400);
  });

  it("accepts an empty line", () => {
    expect(decodeSectionLine(build([], 0, 0)).points.length).toBe(0);
  });

  it("throws for a buffer that is too short or whose size does not match", () => {
    expect(() => decodeSectionLine(new ArrayBuffer(8))).toThrow("短すぎ");
    const cut = build([[0, 0]], 1, 1).slice(0, 20);
    expect(() => decodeSectionLine(cut)).toThrow("合いません");
  });
});

describe("buildSectionLineStartRequest", () => {
  it("carries the layer, the line and the request", () => {
    const request = { preset: "steep", corridorHalfWidth: 20, clothResolution: 0.5 } as const;
    const line: SectionLineInput = { a: [0, 0, 0], b: [10, 0, 0], up: [0, 0, 1] };
    expect(buildSectionLineStartRequest(5, 3, line, request)).toEqual({
      type: "sectionLineStart",
      id: 5,
      cloudId: 3,
      line,
      request,
    });
  });
});
