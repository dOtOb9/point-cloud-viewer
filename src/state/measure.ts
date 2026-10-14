// L2-D: 計測（距離・高さ・面積）の数値計算と、計測レイヤーに描く線・ラベルの決定。
// React にも WebGPU にも依存しない純粋関数だけを置く。単体テストは `measure.test.ts`。
//
// 座標はピックで取ったワールド座標（f64）。大きな実座標（60万台）でも精度が落ちないよう、
// 面積は重心を引いてから計算する。
// 「水平」「鉛直」はカメラの上方向（`up`、既定は Z）で決める。PLY/PCD のように上が Z でない
// データでも、見ている向きの上下で測れるようにするため（renderer/up-axis.ts と同じ考え方）。

import type { CrsInfo } from "../datasource/DataSource";
import { horizontalBasis } from "../renderer/up-axis";

export type Vec3 = readonly [number, number, number];

export type MeasureKind = "distance" | "height" | "area";

/** 計測1件。ADR-0018 の「計測レイヤー」の中身。点は確定済みで、書き換えない。 */
export interface Measurement {
  kind: MeasureKind;
  /** 距離・高さは2点、面積は3点以上（順番に結ぶ多角形）。 */
  points: Vec3[];
  /** 計測したときのカメラの上方向（単位ベクトル）。水平・鉛直の分解に使う。 */
  up: Vec3;
}

/** 計測の種類ごとに必要な最少の点数。 */
export const MIN_POINTS: Record<MeasureKind, number> = { distance: 2, height: 2, area: 3 };

/** 距離・高さは、この点数がそろったら自動で確定する。面積は閉じる操作を待つ。 */
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
  /** 3次元の距離。 */
  distance: number;
  /** 水平面に投影した距離。 */
  horizontal: number;
  /** 鉛直の差（b - a。上が正）。 */
  vertical: number;
}

/** 2点の距離。水平距離と高さの差も返す（distance² = horizontal² + vertical²）。 */
export function distanceStats(a: Vec3, b: Vec3, up: Vec3): DistanceStats {
  const d = sub(b, a);
  const u = normalize(up);
  const vertical = dot(d, u);
  const distance = Math.hypot(d[0], d[1], d[2]);
  // 差の大きさから鉛直成分を引く（hypot の二乗の引き算より、水平成分を直接作るほうが桁落ちしない）。
  const h = [d[0] - u[0] * vertical, d[1] - u[1] * vertical, d[2] - u[2] * vertical] as const;
  return { distance, horizontal: Math.hypot(h[0], h[1], h[2]), vertical };
}

export interface PolygonStats {
  /** 水平面に投影した多角形の面積（頂点の並びが自己交差していなければ、ふつうの面積）。 */
  area: number;
  /** 水平面に投影した周長（最後の頂点から最初の頂点へ戻る辺を含む）。 */
  perimeter: number;
}

/**
 * 多角形を水平面（`up` に垂直な面）へ投影した面積と周長。
 * 面積は靴ひも公式。重心を引いてから計算する（座標が60万台でも二乗の桁が大きくなりすぎない）。
 * 3点未満なら 0。
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

// ---- 単位 ----

/**
 * CRS から長さの単位の表示名を決める。CRS に単位の項目は無いので、名前から判断する:
 *  - 名前に ft / feet / foot / US survey があれば「ft」
 *  - 日本の平面直角座標・UTM は m（定義上 m）
 *  - それ以外・不明は「座標の単位」（m だとは言い切らない）
 * 当てずっぽうで「m」と書くと、フィート系のファイルで数値が3割ずれるのに気づけないため。
 */
export function lengthUnitLabel(crs: CrsInfo | null | undefined): string {
  if (!crs || crs.error || crs.kind === "none") return "座標の単位";
  if (/\b(ft|feet|foot)\b|ftUS|us[ -]?survey/i.test(crs.name)) return "ft";
  if (crs.kind === "plane-rectangular" || crs.kind === "utm") return "m";
  return "座標の単位";
}

// ---- ラベル・線 ----

function fmt(value: number, digits = 2): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 面積の単位は長さの単位の二乗。「座標の単位」のときは「座標の単位²」。 */
function areaUnit(unit: string): string {
  return `${unit}²`;
}

/** 計測の結果をラベルの行にする（上から順に表示）。 */
export function measurementLabelLines(m: Measurement, unit: string): string[] {
  if (m.kind === "distance" && m.points.length >= 2) {
    const s = distanceStats(m.points[0], m.points[1], m.up);
    return [
      `距離 ${fmt(s.distance)} ${unit}`,
      `水平 ${fmt(s.horizontal)} ${unit} / 高さ差 ${fmt(Math.abs(s.vertical))} ${unit}`,
    ];
  }
  if (m.kind === "height" && m.points.length >= 2) {
    const s = distanceStats(m.points[0], m.points[1], m.up);
    return [`高さ ${fmt(Math.abs(s.vertical))} ${unit}`];
  }
  if (m.kind === "area" && m.points.length >= 3) {
    const s = polygonStats(m.points, m.up);
    return [`面積 ${fmt(s.area)} ${areaUnit(unit)}`, `周長 ${fmt(s.perimeter)} ${unit}`];
  }
  return [];
}

/** 画面に描く線分1本。`dashed` は補助線（高さの水平部分・面積の閉じる辺）。 */
export interface MeasureSegment {
  a: Vec3;
  b: Vec3;
  dashed: boolean;
}

/**
 * 計測の線。距離は a-b、高さは a から鉛直に上がる線（実線）と b へ水平に戻る補助線（破線）、
 * 面積は頂点を順に結び、最後に最初へ戻る辺。
 * `closed=false` は面積を入力している途中の表示（まだ閉じない）。
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

/** ラベルを置く3次元の位置。距離は中点、高さは鉛直線の中点、面積は頂点の平均。 */
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

/** 点の外接箱（レイヤーの範囲として CloudInfo.min/max に入れる）。 */
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
