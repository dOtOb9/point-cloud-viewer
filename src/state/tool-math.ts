import type { OrientedBoxFilter } from "../datasource/tools";
import { transformPoint, type Mat4 } from "../renderer/mat4";
import { INTERNATIONAL_FOOT_IN_METERS, type DisplayUnit } from "./units";

export type Vec3 = readonly [number, number, number];

export function displayLengthToFile(value: number, toMeter: number | null, display: DisplayUnit): number {
  if (toMeter === null) return value;
  const meters = display === "foot" ? value * INTERNATIONAL_FOOT_IN_METERS : value;
  return meters / toMeter;
}

export function pixelToNdc(x: number, y: number, width: number, height: number): [number, number] {
  return [(x / width) * 2 - 1, 1 - (y / height) * 2];
}

export function projectToNdc(viewProj: Mat4, p: Vec3): [number, number] | null {
  const c = transformPoint(viewProj, p);
  if (!(c[3] > 0)) return null;
  return [c[0] / c[3], c[1] / c[3]];
}

function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): [number, number, number] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function scale(a: Vec3, k: number): [number, number, number] {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function normalize(a: Vec3): [number, number, number] {
  const len = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / len, a[1] / len, a[2] / len];
}

export function heightRange(min: Vec3, max: Vec3, up: Vec3): { min: number; max: number } {
  const u = normalize(up);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < 8; i++) {
    const corner: Vec3 = [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]];
    const h = dot(corner, u);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  return { min: lo, max: hi };
}

export interface SectionBox {
  filter: OrientedBoxFilter;
  normal: [number, number, number];
}

export function sectionAlong(
  a: Vec3,
  b: Vec3,
  up: Vec3,
): { u: [number, number, number]; along: [number, number, number]; length: number } | null {
  const u = normalize(up);
  const ab = sub(b, a);
  const horizontal = sub(ab, scale(u, dot(ab, u)));
  const length = Math.hypot(horizontal[0], horizontal[1], horizontal[2]);
  if (!(length > 1e-9)) return null;
  return { u, along: scale(horizontal, 1 / length), length };
}

export function sectionBox(a: Vec3, b: Vec3, up: Vec3, thickness: number, heightMin: number, heightMax: number): SectionBox | null {
  const axes = sectionAlong(a, b, up);
  if (axes === null) return null;
  const { u, along, length } = axes;
  const normal = cross(u, along);
  const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const shift = (heightMin + heightMax) / 2 - dot(mid, u);
  const center: [number, number, number] = [mid[0] + u[0] * shift, mid[1] + u[1] * shift, mid[2] + u[2] * shift];
  return {
    filter: {
      kind: "orientedBox",
      center,
      axes: [along, normal, u],
      halfExtents: [length / 2, Math.max(0, thickness) / 2, Math.max(0, heightMax - heightMin) / 2],
    },
    normal,
  };
}

export function sectionYaw(normal: Vec3, right: Vec3, forward: Vec3): number {
  return Math.atan2(dot(normal, right), dot(normal, forward));
}
