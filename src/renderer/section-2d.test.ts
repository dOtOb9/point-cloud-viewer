import { describe, expect, it } from "vitest";
import type { SectionPoints } from "../datasource/section-profile";
import { classificationPalette, fillSectionPixels, formatTick, niceStep, niceTicks, SMALL_DOT_MAX_POINTS } from "./section-2d";

/** Points laid out like the Rust buffer: three 32-bit words per point (s, z as floats, packed r|g<<8|b<<16|class<<24). */
function makePoints(list: { s: number; z: number; r?: number; g?: number; b?: number; cls?: number }[], hasColor: boolean): SectionPoints {
  const buffer = new ArrayBuffer(list.length * 12);
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  list.forEach((p, i) => {
    floats[i * 3] = p.s;
    floats[i * 3 + 1] = p.z;
    words[i * 3 + 2] = ((p.r ?? 0) | ((p.g ?? 0) << 8) | ((p.b ?? 0) << 16) | ((p.cls ?? 0) << 24)) >>> 0;
  });
  return {
    count: list.length,
    thinned: false,
    hasColor,
    sRange: { min: 0, max: 0 },
    zRange: { min: 0, max: 0 },
    floats,
    words,
  };
}

const IDENTITY = { scale: 1, offsetX: 0, offsetY: 10 };
const rgba = (r: number, g: number, b: number) => ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0;

describe("fillSectionPixels", () => {
  it("puts a coloured point at the pixel the view maps it to, as a 2x2 dot for a small section", () => {
    const pixels = new Uint32Array(10 * 10);
    const points = makePoints([{ s: 3, z: 4, r: 200, g: 100, b: 50 }], true);
    const drawn = fillSectionPixels(pixels, 10, 10, points, IDENTITY, classificationPalette());
    expect(drawn).toBe(1);
    // x = 3, y = 10 - 4 = 6
    for (const [x, y] of [[3, 6], [4, 6], [3, 7], [4, 7]]) expect(pixels[y * 10 + x]).toBe(rgba(200, 100, 50));
    expect(pixels.filter((v) => v !== 0)).toHaveLength(4);
  });

  it("colours by classification when the cloud has no colour", () => {
    const pixels = new Uint32Array(10 * 10);
    const palette = classificationPalette();
    fillSectionPixels(pixels, 10, 10, makePoints([{ s: 1, z: 3, cls: 2 }], false), IDENTITY, palette);
    expect(pixels[7 * 10 + 1]).toBe(palette[2]);
    expect(palette[2]).toBe(rgba(Math.round(0.55 * 255), Math.round(0.4 * 255), Math.round(0.22 * 255)));
  });

  it("skips points outside the pixel buffer, including the edge where a 2x2 dot would not fit", () => {
    const pixels = new Uint32Array(10 * 10);
    const points = makePoints(
      [
        { s: -1, z: 5, r: 255 },
        { s: 5, z: -1, r: 255 },
        { s: 9, z: 5, r: 255 }, // x = 9: the right pixel of a 2x2 dot would be outside
        { s: Number.NaN, z: 5, r: 255 },
      ],
      true,
    );
    expect(fillSectionPixels(pixels, 10, 10, points, IDENTITY, classificationPalette())).toBe(0);
    expect(pixels.every((v) => v === 0)).toBe(true);
  });

  it("uses one pixel per point above the small-section limit", () => {
    const list = Array.from({ length: SMALL_DOT_MAX_POINTS + 1 }, () => ({ s: 2, z: 2, r: 9 }));
    const pixels = new Uint32Array(10 * 10);
    fillSectionPixels(pixels, 10, 10, makePoints(list, true), IDENTITY, classificationPalette());
    expect(pixels.filter((v) => v !== 0)).toHaveLength(1);
  });

  it("fills 2,000,000 points (draw-time benchmark; the number is printed, not asserted)", () => {
    const count = 2_000_000;
    const buffer = new ArrayBuffer(count * 12);
    const floats = new Float32Array(buffer);
    const words = new Uint32Array(buffer);
    // A pseudo-random scatter over a 1200 x 800 panel (a fixed generator, so every run draws the same thing).
    let seed = 12345;
    const next = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < count; i++) {
      floats[i * 3] = next() * 1200;
      floats[i * 3 + 1] = next() * 800;
      words[i * 3 + 2] = (0xff000000 | (next() * 0xffffff)) >>> 0;
    }
    const points: SectionPoints = { ...makePoints([], true), count, floats, words };
    const pixels = new Uint32Array(1200 * 800);
    const palette = classificationPalette();
    const view = { scale: 1, offsetX: 0, offsetY: 800 };
    const times: number[] = [];
    let drawn = 0;
    for (let run = 0; run < 5; run++) {
      const t0 = performance.now();
      drawn = fillSectionPixels(pixels, 1200, 800, points, view, palette);
      times.push(performance.now() - t0);
    }
    console.log(`fillSectionPixels 2,000,000 points into 1200x800: ${times.map((t) => t.toFixed(1)).join(", ")} ms`);
    expect(drawn).toBeGreaterThan(count * 0.99);
  });
});

describe("axes", () => {
  it("picks 1, 2 or 5 times a power of ten", () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(7, 5)).toBe(2);
    expect(niceStep(0.3, 5)).toBeCloseTo(0.1);
    expect(niceStep(0, 5)).toBe(1);
  });

  it("lists the multiples of the step inside the range", () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(-3, 3, 3)).toEqual([-2, 0, 2]);
    expect(niceTicks(5, 5, 3)).toEqual([]);
    expect(niceTicks(Number.NaN, 3, 3)).toEqual([]);
  });

  it("shows as many decimals as the step needs and never '-0'", () => {
    expect(formatTick(1200, 100)).toBe("1,200");
    expect(formatTick(0.25, 0.05)).toBe("0.25");
    expect(formatTick(-0, 1)).toBe("0");
  });
});
