import { describe, expect, it } from "vitest";
import {
  groundLevelAt,
  groundLevelLabel,
  groundLineToProfile,
  groundLineToWorld,
  profileToGroundLine,
  sectionAxes,
  sectionToWorld,
} from "./section-3d";
import type { ProfileLine } from "./section-math";

describe("sectionToWorld", () => {
  it("goes along A->B in x and up in z", () => {
    const axes = sectionAxes([10, 20, 5], [110, 20, 5], [0, 0, 1])!;
    expect(sectionToWorld(axes, 0, 5)).toEqual([10, 20, 5]);
    expect(sectionToWorld(axes, 40, 12)).toEqual([50, 20, 12]);
  });

  it("follows a diagonal line and ignores the height of B", () => {
    const axes = sectionAxes([0, 0, 0], [30, 40, 99], [0, 0, 1])!;
    const p = sectionToWorld(axes, 50, 7);
    expect(p[0]).toBeCloseTo(30);
    expect(p[1]).toBeCloseTo(40);
    expect(p[2]).toBeCloseTo(7);
  });

  it("round-trips with the panel's own (s, z) definition", () => {
    const a: [number, number, number] = [100, 200, 30];
    const axes = sectionAxes(a, [160, 280, 35], [0, 0, 1])!;
    const w = sectionToWorld(axes, 42, 77);
    const s = (w[0] - a[0]) * axes.along[0] + (w[1] - a[1]) * axes.along[1] + (w[2] - a[2]) * axes.along[2];
    expect(s).toBeCloseTo(42);
    expect(w[2]).toBeCloseTo(77);
  });

  it("works with y-up", () => {
    const axes = sectionAxes([0, 0, 0], [10, 3, 0], [0, 1, 0])!;
    expect(axes.along[1]).toBeCloseTo(0);
    expect(sectionToWorld(axes, 10, 4)[1]).toBeCloseTo(4);
  });

  it("returns null for A and B on one vertical line, or a zero up", () => {
    expect(sectionAxes([0, 0, 0], [0, 0, 9], [0, 0, 1])).toBeNull();
    expect(sectionAxes([0, 0, 0], [1, 0, 0], [0, 0, 0])).toBeNull();
    expect(sectionAxes([0, NaN, 0], [1, 0, 0], [0, 0, 1])).toBeNull();
  });

  it("converts a whole line", () => {
    const axes = sectionAxes([0, 0, 0], [10, 0, 0], [0, 0, 1])!;
    expect(groundLineToWorld(axes, new Float32Array([0, 1, 5, 2, 10, 3]))).toEqual([
      [0, 0, 1],
      [5, 0, 2],
      [10, 0, 3],
    ]);
  });
});

const RAMP: ProfileLine = [
  { s: 0, z: 10 },
  { s: 10, z: 10 },
  { s: 20, z: 20 },
];

describe("groundLevelAt", () => {
  it("interpolates GL", () => {
    expect(groundLevelAt(RAMP, 15, 1)!.z).toBeCloseTo(15);
  });

  it("measures the slope over +-window", () => {
    const r = groundLevelAt(RAMP, 15, 1)!;
    expect(r.slopeDegrees).toBeCloseTo(45);
    expect(r.slopePercent).toBeCloseTo(100);
  });

  it("averages across a bend", () => {
    // At s = 10: s-1 -> z 10, s+1 -> z 11, so the slope is 1 / 2.
    expect(groundLevelAt(RAMP, 10, 1)!.slopePercent).toBeCloseTo(50);
  });

  it("clamps the window at the ends", () => {
    expect(groundLevelAt(RAMP, 0, 1)!.slopeDegrees).toBeCloseTo(0); // window [0, 1], flat
    expect(groundLevelAt(RAMP, 20, 1)!.slopePercent).toBeCloseTo(100); // window [19, 20], rising
  });

  it("is null outside the line or for a short line", () => {
    expect(groundLevelAt(RAMP, -0.1, 1)).toBeNull();
    expect(groundLevelAt(RAMP, 20.1, 1)).toBeNull();
    expect(groundLevelAt([{ s: 0, z: 1 }], 0, 1)).toBeNull();
  });

  it("works in feet (window of 1 m = 1 / 0.3048 ft) and converts a rise in another unit", () => {
    const feet: ProfileLine = [
      { s: 0, z: 0 },
      { s: 100, z: 100 },
    ];
    expect(groundLevelAt(feet, 50, 1 / 0.3048)!.slopeDegrees).toBeCloseTo(45);
    expect(groundLevelAt(feet, 50, 1, 0.3048)!.slopePercent).toBeCloseTo(30.48);
  });
});

describe("groundLevelLabel", () => {
  it("shows metres and feet", () => {
    const reading = { s: 0, z: 35.4234, slopeDegrees: 12.34, slopePercent: 21.9 };
    expect(groundLevelLabel(reading, { horizontalToMeter: 1, verticalToMeter: 1, display: "meter" })).toEqual([
      "GL 35.42 m",
      "傾斜 +12.3° (+21.9%)",
    ]);
    expect(groundLevelLabel(reading, { horizontalToMeter: 1, verticalToMeter: 1, display: "foot" })[0]).toContain("ft");
  });
});

describe("profileToGroundLine (G2-5)", () => {
  it("(g) goes back and forth without changing a value, and marks the line as edited", () => {
    const base = { points: new Float32Array([0, 10.5, 12.25, -3, 100, 60.125]), groundPoints: 7, cells: 9 };
    const back = profileToGroundLine(groundLineToProfile(base.points), base);
    expect([...back.points]).toEqual([...base.points]);
    expect(back.points).toBeInstanceOf(Float32Array);
    expect(back.groundPoints).toBe(7);
    expect(back.cells).toBe(9);
    expect(back.edited).toBe(true);
    expect(base).not.toHaveProperty("edited");
    expect(groundLineToProfile(back.points)).toEqual(groundLineToProfile(base.points));
  });

  it("(g) an empty profile gives an empty line", () => {
    expect(profileToGroundLine([], { points: new Float32Array(0), groundPoints: 0, cells: 0 }).points).toHaveLength(0);
  });
});
