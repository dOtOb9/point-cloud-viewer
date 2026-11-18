import { formatArea, formatDistance3d, formatLength, type LengthUnits } from "./units";
import { horizontalBasis } from "../renderer/up-axis";

export type Vec3 = readonly [number, number, number];

export type MeasureKind = "distance" | "height" | "area";

export interface Measurement {
  kind: MeasureKind;
  points: Vec3[];
  up: Vec3;
}

export const MIN_POINTS: Record<MeasureKind, number> = { distance: 2, height: 2, area: 3 };

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
  distance: number;
  horizontal: number;
  vertical: number;
}

export function distanceStats(a: Vec3, b: Vec3, up: Vec3): DistanceStats {
  const d = sub(b, a);
  const u = normalize(up);
  const vertical = dot(d, u);
  const distance = Math.hypot(d[0], d[1], d[2]);
  const h = [d[0] - u[0] * vertical, d[1] - u[1] * vertical, d[2] - u[2] * vertical] as const;
  return { distance, horizontal: Math.hypot(h[0], h[1], h[2]), vertical };
}

export interface PolygonStats {
  area: number;
  perimeter: number;
}

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

export interface MeasureSegment {
  a: Vec3;
  b: Vec3;
  dashed: boolean;
}

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
