// L2-D: measurement math (distance, height, area) and the choice of lines/labels drawn for
// a measurement layer. Only pure functions that depend on neither React nor WebGPU.
// Unit tests are in `measure.test.ts`.
//
// Coordinates are the world coordinates (f64) obtained by picking. To keep precision with
// large real-world coordinates (600k range), the area is computed after subtracting the centroid.
// "Horizontal" and "vertical" follow the camera's up axis (`up`, default Z). This lets data
// whose up is not Z (PLY/PCD) be measured along the viewed up/down (same idea as renderer/up-axis.ts).

import { formatArea, formatDistance3d, formatLength, type LengthUnits } from "./units";
import { horizontalBasis } from "../renderer/up-axis";

export type Vec3 = readonly [number, number, number];

export type MeasureKind = "distance" | "height" | "area";

/** One measurement. This is the content of a measurement layer (ADR-0018). Points are final and never edited. */
export interface Measurement {
  kind: MeasureKind;
  /** Two points for distance and height, three or more for area (a polygon joined in order). */
  points: Vec3[];
  /** Camera up axis (unit vector) at measuring time. Used to split into horizontal and vertical. */
  up: Vec3;
}

/** Minimum number of points per kind. */
export const MIN_POINTS: Record<MeasureKind, number> = { distance: 2, height: 2, area: 3 };

/** Distance and height finish automatically at this many points. Area waits for the close action. */
export function autoFinishCount(kind: MeasureKind): number | null {
  return kind === "area" ? null : 2;
}

function sub(a: Vec3, b: Vec3): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(v: Vec3): [number, number, number] {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export interface DistanceStats {
  /** 3D distance. */
  distance: number;
  /** Distance projected onto the horizontal plane. */
  horizontal: number;
  /** Vertical difference (b - a, up is positive). */
  vertical: number;
}

/** Distance between two points, with the horizontal distance and the height difference (distance^2 = horizontal^2 + vertical^2). */
export function distanceStats(a: Vec3, b: Vec3, up: Vec3): DistanceStats {
  const d = sub(b, a);
  const u = normalize(up);
  const vertical = dot(d, u);
  const distance = Math.hypot(d[0], d[1], d[2]);
  // Build the horizontal component directly (less cancellation than subtracting squares).
  const h = [d[0] - u[0] * vertical, d[1] - u[1] * vertical, d[2] - u[2] * vertical] as const;
  return { distance, horizontal: Math.hypot(h[0], h[1], h[2]), vertical };
}

export interface PolygonStats {
  /** Area of the polygon projected onto the horizontal plane (the usual area when the vertex order does not self-intersect). */
  area: number;
  /** Perimeter projected onto the horizontal plane (includes the edge from the last vertex back to the first). */
  perimeter: number;
}

/**
 * Area and perimeter of a polygon projected onto the horizontal plane (perpendicular to `up`).
 * The area uses the shoelace formula, computed after subtracting the centroid (so squares
 * do not get huge with coordinates in the 600k range). 0 for fewer than 3 points.
 */
export function polygonStats(points: readonly Vec3[], up: Vec3): PolygonStats {
  if (points.length < 3) return { area: 0, perimeter: 0 };
  const { right, forward } = horizontalBasis(up);
  const cx = points.reduce((s, p) => s + p[0], 0) / points.length;
  const cy = points.reduce((s, p) => s + p[1], 0) / points.length;
  const cz = points.reduce((s, p) => s + p[2], 0) / points.length;
  const flat = points.map((p) => {
    const d: Vec3 = [p[0] - cx, p[1] - cy, p[2] - cz];
    return [dot(d, right), dot(d, forward)] as const;
  });
  let twiceArea = 0;
  let perimeter = 0;
  for (let i = 0; i < flat.length; i++) {
    const p = flat[i];
    const q = flat[(i + 1) % flat.length];
    twiceArea += p[0] * q[1] - q[0] * p[1];
    perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return { area: Math.abs(twiceArea) / 2, perimeter };
}

// ---- Labels ----

/**
 * The measurement result as label lines (shown top to bottom), in the display unit of `units`
 * (meters by default). The raw numbers are in file units; each quantity is converted with the
 * factor of its axis (horizontal quantities with the horizontal factor, vertical ones with the
 * vertical factor; they can differ). An unknown factor leaves the number unconverted and
 * annotated (see units.ts).
 */
export function measurementLabelLines(m: Measurement, units: LengthUnits): string[] {
  const { horizontalToMeter: h, verticalToMeter: v, display } = units;
  if (m.kind === "distance" && m.points.length >= 2) {
    const s = distanceStats(m.points[0], m.points[1], m.up);
    return [
      `距離 ${formatDistance3d(s.horizontal, s.vertical, units)}`,
      `水平 ${formatLength(s.horizontal, h, display)} / 高さ差 ${formatLength(Math.abs(s.vertical), v, display)}`,
    ];
  }
  if (m.kind === "height" && m.points.length >= 2) {
    const s = distanceStats(m.points[0], m.points[1], m.up);
    return [`高さ ${formatLength(Math.abs(s.vertical), v, display)}`];
  }
  if (m.kind === "area" && m.points.length >= 3) {
    const s = polygonStats(m.points, m.up);
    return [`面積 ${formatArea(s.area, h, display)}`, `周長 ${formatLength(s.perimeter, h, display)}`];
  }
  return [];
}

/** One segment drawn on screen. `dashed` marks helper lines (the horizontal part of a height, the closing edge of an area). */
export interface MeasureSegment {
  a: Vec3;
  b: Vec3;
  dashed: boolean;
}

/**
 * The lines of a measurement. Distance is a-b. Height is a solid line rising vertically from a
 * plus a dashed helper line going horizontally to b. Area joins the vertices in order and
 * returns to the first. `closed=false` is the display while an area is still being entered.
 */
export function measurementSegments(m: Measurement, closed = true): MeasureSegment[] {
  const pts = m.points;
  if (m.kind === "height" && pts.length >= 2) {
    const u = normalize(m.up);
    const v = dot(sub(pts[1], pts[0]), u);
    const corner: Vec3 = [pts[0][0] + u[0] * v, pts[0][1] + u[1] * v, pts[0][2] + u[2] * v];
    return [
      { a: pts[0], b: corner, dashed: false },
      { a: corner, b: pts[1], dashed: true },
    ];
  }
  const segments: MeasureSegment[] = [];
  for (let i = 0; i + 1 < pts.length; i++) segments.push({ a: pts[i], b: pts[i + 1], dashed: false });
  if (m.kind === "area" && closed && pts.length >= 3) {
    segments.push({ a: pts[pts.length - 1], b: pts[0], dashed: false });
  }
  return segments;
}

/** 3D position of the label: the midpoint for distance, the middle of the vertical line for height, the vertex average for area. */
export function labelAnchor(m: Measurement): Vec3 {
  const pts = m.points;
  if (pts.length === 0) return [0, 0, 0];
  if (m.kind === "height" && pts.length >= 2) {
    const u = normalize(m.up);
    const v = dot(sub(pts[1], pts[0]), u);
    return [pts[0][0] + (u[0] * v) / 2, pts[0][1] + (u[1] * v) / 2, pts[0][2] + (u[2] * v) / 2];
  }
  if (m.kind === "distance" && pts.length >= 2) {
    return [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, (pts[0][2] + pts[1][2]) / 2];
  }
  const n = pts.length;
  return [
    pts.reduce((s, p) => s + p[0], 0) / n,
    pts.reduce((s, p) => s + p[1], 0) / n,
    pts.reduce((s, p) => s + p[2], 0) / n,
  ];
}

/** Bounding box of the points (stored as CloudInfo.min/max, the layer's extent). */
export function pointsBounds(points: readonly Vec3[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points) {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i];
      if (p[i] > max[i]) max[i] = p[i];
    }
  }
  return { min, max };
}

export const MEASURE_KIND_NAME: Record<MeasureKind, string> = { distance: "距離", height: "高さ", area: "面積" };
