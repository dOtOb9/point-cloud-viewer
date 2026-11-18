import type { SectionGroundLine } from "../datasource/section-line";
import { formatLength, type LengthUnits } from "../state/units";
import { interpolateZ, type ProfileLine } from "./section-math";

type Vec3 = readonly [number, number, number];

export const SLOPE_HALF_WINDOW_M = 1;

export interface SectionAxes {
  origin: Vec3;
  along: Vec3;
  up: Vec3;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

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

export function sectionToWorld(axes: SectionAxes, s: number, z: number): [number, number, number] {
  const h = z - dot(axes.origin, axes.up);
  return [
    axes.origin[0] + axes.along[0] * s + axes.up[0] * h,
    axes.origin[1] + axes.along[1] * s + axes.up[1] * h,
    axes.origin[2] + axes.along[2] * s + axes.up[2] * h,
  ];
}

export function groundLineToWorld(axes: SectionAxes, pairs: Float32Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) out.push(sectionToWorld(axes, pairs[i], pairs[i + 1]));
  return out;
}

export function groundLineToProfile(pairs: Float32Array): ProfileLine {
  const out: { s: number; z: number }[] = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) out.push({ s: pairs[i], z: pairs[i + 1] });
  return out;
}

export function profileToGroundLine(profile: ProfileLine, base: SectionGroundLine): SectionGroundLine {
  const points = new Float32Array(profile.length * 2);
  profile.forEach((p, i) => {
    points[i * 2] = p.s;
    points[i * 2 + 1] = p.z;
  });
  return { points, groundPoints: base.groundPoints, cells: base.cells, edited: true };
}

export interface GroundLevelReading {
  s: number;
  z: number;
  slopeDegrees: number;
  slopePercent: number;
}

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

export function groundLevelLabel(reading: GroundLevelReading, units: LengthUnits): [string, string] {
  const gl = formatLength(reading.z, units.verticalToMeter, units.display);
  const sign = reading.slopeDegrees > 0 ? "+" : "";
  return [`GL ${gl}`, `傾斜 ${sign}${reading.slopeDegrees.toFixed(1)}° (${sign}${reading.slopePercent.toFixed(1)}%)`];
}
