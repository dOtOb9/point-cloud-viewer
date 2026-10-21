// G2-8 / G2-6: the section ground line in 3D, and the ground level (GL) and slope angle read from it.
// Pure functions, no React (TaskSheets/ADR-0021-thin-react.md). Tests: src/app/section-3d.test.ts.
// `sectionAxes` is the TypeScript twin of `SectionAxes` in crates/pcv-core/src/profile.rs (and of `sectionBox` in
// src/state/tool-math.ts): the same construction, so `(s, z)` of the panel and the 3D coordinates agree.
import type { SectionGroundLine } from "../datasource/section-line";
import { formatLength, type LengthUnits } from "../state/units";
import { interpolateZ, type ProfileLine } from "./section-math";

type Vec3 = readonly [number, number, number];

/** Half width, in metres, of the window the slope angle is measured over (the line at `s - 1 m` and `s + 1 m`). */
export const SLOPE_HALF_WINDOW_M = 1;

/** Origin A, the horizontal unit vector towards B, and the unit vector of the height axis. */
export interface SectionAxes {
  origin: Vec3;
  along: Vec3;
  up: Vec3;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** null when a value is not finite, `up` has no length, or A and B are on the same vertical line. */
export function sectionAxes(a: Vec3, b: Vec3, up: Vec3): SectionAxes | null {
  if (![...a, ...b, ...up].every(Number.isFinite)) return null;
  const upLength = Math.sqrt(dot(up, up));
  if (!(upLength > 1e-12)) return null;
  const u: Vec3 = [up[0] / upLength, up[1] / upLength, up[2] / upLength];
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const abUp = dot(ab, u);
  const horizontal: Vec3 = [ab[0] - u[0] * abUp, ab[1] - u[1] * abUp, ab[2] - u[2] * abUp];
  const length = Math.sqrt(dot(horizontal, horizontal));
  if (!(length > 1e-9)) return null;
  return { origin: a, along: [horizontal[0] / length, horizontal[1] / length, horizontal[2] / length], up: u };
}

/**
 * `(s, z)` of the panel -> a point in file coordinates. `z` is the height along `up` measured from the world origin
 * (as in Rust: `dot(p, up)`), so the height above A is `z - dot(A, up)`.
 */
export function sectionToWorld(axes: SectionAxes, s: number, z: number): [number, number, number] {
  const h = z - dot(axes.origin, axes.up);
  return [
    axes.origin[0] + axes.along[0] * s + axes.up[0] * h,
    axes.origin[1] + axes.along[1] * s + axes.up[1] * h,
    axes.origin[2] + axes.along[2] * s + axes.up[2] * h,
  ];
}

/** The ground line (`s, z` pairs, as stored on the layer) as a list of 3D points. */
export function groundLineToWorld(axes: SectionAxes, pairs: Float32Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) out.push(sectionToWorld(axes, pairs[i], pairs[i + 1]));
  return out;
}

/** The ground line as `ProfilePoint`s, for the interpolation of section-math.ts. */
export function groundLineToProfile(pairs: Float32Array): ProfileLine {
  const out: { s: number; z: number }[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) out.push({ s: pairs[i], z: pairs[i + 1] });
  return out;
}

/**
 * The reverse of `groundLineToProfile`, for a line the user edited (G2-5). `base` is the line it came from: its
 * `groundPoints` and `cells` (facts about the computation) are kept, and the result is marked `edited`.
 */
export function profileToGroundLine(profile: ProfileLine, base: SectionGroundLine): SectionGroundLine {
  const points = new Float32Array(profile.length * 2);
  profile.forEach((p, i) => {
    points[i * 2] = p.s;
    points[i * 2 + 1] = p.z;
  });
  return { points, groundPoints: base.groundPoints, cells: base.cells, edited: true };
}

/** What a right click (long press) at `s` reads from the ground line. Lengths are in the file's units. */
export interface GroundLevelReading {
  s: number;
  /** Height of the line at `s`. */
  z: number;
  /** Slope between the line at `s - window` and `s + window` (clamped to the ends); positive = rising towards B. */
  slopeDegrees: number;
  slopePercent: number;
}

/**
 * GL and slope at `s`. The window is `halfWindow` (file horizontal units) on each side; where it would go past an end of
 * the line it stops at the end, so near the ends the slope is measured over a shorter run. `verticalPerHorizontal`
 * converts a rise in the vertical file unit to the horizontal one (`verticalToMeter / horizontalToMeter`; 1 when a unit
 * is unknown) so the angle is a real angle.
 * null when `s` is outside the line or the line has fewer than 2 points.
 */
export function groundLevelAt(
  line: ProfileLine,
  s: number,
  halfWindow: number,
  verticalPerHorizontal = 1,
): GroundLevelReading | null {
  const z = interpolateZ(line, s);
  if (z === null) return null;
  const s0 = Math.max(line[0].s, s - halfWindow);
  const s1 = Math.min(line[line.length - 1].s, s + halfWindow);
  const z0 = interpolateZ(line, s0);
  const z1 = interpolateZ(line, s1);
  if (z0 === null || z1 === null || !(s1 > s0)) return null;
  const ratio = ((z1 - z0) * verticalPerHorizontal) / (s1 - s0);
  return { s, z, slopeDegrees: (Math.atan(ratio) * 180) / Math.PI, slopePercent: ratio * 100 };
}

/** The text shown with the reading in both views, as two lines: ["GL 35.42 m", "傾斜 +12.3° (+21.9%)"]. */
export function groundLevelLabel(reading: GroundLevelReading, units: LengthUnits): [string, string] {
  const gl = formatLength(reading.z, units.verticalToMeter, units.display);
  const sign = reading.slopeDegrees > 0 ? "+" : "";
  return [`GL ${gl}`, `傾斜 ${sign}${reading.slopeDegrees.toFixed(1)}° (${sign}${reading.slopePercent.toFixed(1)}%)`];
}
