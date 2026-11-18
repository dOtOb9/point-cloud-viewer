import { transformPoint, type Mat4 } from "./mat4";

export interface ScreenPoint {
  x: number;
  y: number;
}

type Clip = [number, number, number, number];

function toScreen(c: Clip, width: number, height: number): ScreenPoint {
  return { x: ((c[0] / c[3] + 1) / 2) * width, y: ((1 - c[1] / c[3]) / 2) * height };
}

export function projectPoint(
  viewProj: Mat4,
  p: readonly [number, number, number],
  width: number,
  height: number,
): ScreenPoint | null {
  const c = transformPoint(viewProj, p);
  if (!(c[3] > 0) || c[2] < 0) return null;
  return toScreen(c, width, height);
}

const LABEL_WIDTH_PX = 190;
const LABEL_LINE_PX = 15;

export function labelShifts(anchors: readonly (ScreenPoint | null)[], lineCounts: readonly number[]): number[] {
  const placed: { x: number; y: number; h: number }[] = [];
  return anchors.map((anchor, i) => {
    if (!anchor) return 0;
    const h = Math.max(1, lineCounts[i] ?? 1) * LABEL_LINE_PX;
    let shift = 0;
    for (let step = 0; step <= placed.length; step++) {
      const y = anchor.y + shift;
      const hit = placed.some((p) => Math.abs(p.x - anchor.x) < LABEL_WIDTH_PX && y < p.y + p.h && p.y < y + h);
      if (!hit) break;
      shift += h;
    }
    placed.push({ x: anchor.x, y: anchor.y + shift, h });
    return shift;
  });
}

export function projectSegment(
  viewProj: Mat4,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  width: number,
  height: number,
): [ScreenPoint, ScreenPoint] | null {
  const ca = transformPoint(viewProj, a);
  const cb = transformPoint(viewProj, b);
  const inA = ca[3] > 0 && ca[2] >= 0;
  const inB = cb[3] > 0 && cb[2] >= 0;
  if (!inA && !inB) return null;
  let start: Clip = ca;
  let end: Clip = cb;
  if (!inA || !inB) {
    const t = ca[2] / (ca[2] - cb[2]);
    const cut: Clip = [
      ca[0] + (cb[0] - ca[0]) * t,
      ca[1] + (cb[1] - ca[1]) * t,
      0,
      ca[3] + (cb[3] - ca[3]) * t,
    ];
    if (!(cut[3] > 0)) return null;
    if (!inA) start = cut;
    else end = cut;
  }
  return [toScreen(start, width, height), toScreen(end, width, height)];
}
