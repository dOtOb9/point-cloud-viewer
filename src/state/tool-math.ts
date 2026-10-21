// L2-F: the arithmetic behind the point-cloud tools (select by polygon, cross section). Pure functions.
//
// All coordinates are the file's real coordinates in f64. The renderer's `viewProj` already maps those
// to clip space (the rendering origin shift is applied per node, in f32, and never enters this matrix),
// so it can be sent to Rust as it is.

import type { OrientedBoxFilter } from "../datasource/tools";
import {
  DEFAULT_CLOTH_RESOLUTION_M,
  DEFAULT_CORRIDOR_HALF_WIDTH_M,
  type SectionLinePreset,
  type SectionLineRequest,
} from "../datasource/section-line";
import { transformPoint, type Mat4 } from "../renderer/mat4";
import { INTERNATIONAL_FOOT_IN_METERS, type DisplayUnit } from "./units";

export type Vec3 = readonly [number, number, number];

/**
 * A length typed in the display unit (m or ft) -> the file's unit. `toMeter` is the file unit in meters
 * (null when unknown: the number is taken as it is, in the file's unit, never guessed).
 */
export function displayLengthToFile(value: number, toMeter: number | null, display: DisplayUnit): number {
  if (toMeter === null) return value;
  const meters = display === "foot" ? value * INTERNATIONAL_FOOT_IN_METERS : value;
  return meters / toMeter;
}

/** Canvas CSS pixels (y down) -> NDC (x right, y up, both -1..1). */
export function pixelToNdc(x: number, y: number, width: number, height: number): [number, number] {
  return [(x / width) * 2 - 1, 1 - (y / height) * 2];
}

/** Project a point to NDC the way the Rust side does. null when it is behind the camera (w <= 0). */
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

/** Range of the "height" (the coordinate along `up`) over a layer's bounding box. */
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
  /** Horizontal unit vector perpendicular to the line. The camera looks at the slab face-on from this side (see `sectionYaw`). */
  normal: [number, number, number];
}

/**
 * The vertical slab of a cross section: along the line a-b (horizontal part only), `thickness` wide
 * (total, split evenly on both sides of the line), and from `heightMin` to `heightMax` along `up`.
 * Returns null when a and b are on the same vertical line (no direction).
 */
export function sectionBox(a: Vec3, b: Vec3, up: Vec3, thickness: number, heightMin: number, heightMax: number): SectionBox | null {
  const u = normalize(up);
  const ab = sub(b, a);
  const horizontal = sub(ab, scale(u, dot(ab, u)));
  const length = Math.hypot(horizontal[0], horizontal[1], horizontal[2]);
  if (!(length > 1e-9)) return null;
  const along = scale(horizontal, 1 / length);
  const normal = cross(u, along); // horizontal and perpendicular to the line (unit, because u and along are perpendicular units)
  const mid: [number, number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  // Move the centre along `up` to the middle of the height range.
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

/**
 * The orbit camera's yaw that puts the eye on the `normal` side of the slab at pitch 0, i.e. looking at the
 * face of the slab. Mirrors `OrbitCamera.eye()`: the horizontal direction is `forward*cos(yaw) + right*sin(yaw)`.
 */
export function sectionYaw(normal: Vec3, right: Vec3, forward: Vec3): number {
  return Math.atan2(dot(normal, right), dot(normal, forward));
}

// --- G2: section line ---
/**
 * What the section line computation is asked for, in the file's unit: the preset the user picked, the corridor half
 * width (20 m) and the cloth resolution (0.5 m). `toMeter` is the file's horizontal unit in metres (null when unknown:
 * the numbers are then taken as the file's unit, never guessed, like every other length in the tools).
 */
export function sectionLineRequestFor(preset: SectionLinePreset, toMeter: number | null): SectionLineRequest {
  return {
    preset,
    corridorHalfWidth: displayLengthToFile(DEFAULT_CORRIDOR_HALF_WIDTH_M, toMeter, "meter"),
    clothResolution: displayLengthToFile(DEFAULT_CLOTH_RESOLUTION_M, toMeter, "meter"),
  };
}
