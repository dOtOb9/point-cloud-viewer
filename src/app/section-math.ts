export interface SectionView {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Range {
  readonly min: number;
  readonly max: number;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export const MIN_SCALE = 1e-5;
export const MAX_SCALE = 1e5;

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function sectionToScreen(view: SectionView, s: number, z: number): ScreenPoint {
  return { x: view.offsetX + s * view.scale, y: view.offsetY - z * view.scale };
}

export function screenToSection(view: SectionView, x: number, y: number): { s: number; z: number } {
  return { s: (x - view.offsetX) / view.scale, z: (view.offsetY - y) / view.scale };
}

export function fitView(panel: Size, sRange: Range, zRange: Range, padding: number): SectionView {
  const availableW = Math.max(1, panel.width - 2 * padding);
  const availableH = Math.max(1, panel.height - 2 * padding);
  const sSpan = Math.max(sRange.max - sRange.min, 1e-9);
  const zSpan = Math.max(zRange.max - zRange.min, 1e-9);
  const scale = clampScale(Math.min(availableW / sSpan, availableH / zSpan));
  const centerS = (sRange.min + sRange.max) / 2;
  const centerZ = (zRange.min + zRange.max) / 2;
  return {
    scale,
    offsetX: panel.width / 2 - centerS * scale,
    offsetY: panel.height / 2 + centerZ * scale,
  };
}

export function zoomAt(view: SectionView, screen: ScreenPoint, factor: number): SectionView {
  const scale = clampScale(view.scale * factor);
  const real = scale / view.scale;
  return {
    scale,
    offsetX: screen.x - (screen.x - view.offsetX) * real,
    offsetY: screen.y - (screen.y - view.offsetY) * real,
  };
}

export function panBy(view: SectionView, dx: number, dy: number): SectionView {
  return { scale: view.scale, offsetX: view.offsetX + dx, offsetY: view.offsetY + dy };
}

export interface ProfilePoint {
  readonly s: number;
  readonly z: number;
}

export type ProfileLine = readonly ProfilePoint[];

function segmentIndexAt(line: ProfileLine, s: number): number | null {
  if (line.length < 2) return null;
  if (!(s >= line[0].s) || !(s <= line[line.length - 1].s)) return null;
  let lo = 0;
  let hi = line.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (line[mid].s <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, line.length - 2);
}

export function interpolateZ(line: ProfileLine, s: number): number | null {
  const i = segmentIndexAt(line, s);
  if (i === null) return null;
  const a = line[i];
  const b = line[i + 1];
  const t = (s - a.s) / (b.s - a.s);
  return a.z + t * (b.z - a.z);
}

export interface Slope {
  readonly degrees: number;
  readonly percent: number;
}

export function slopeAt(line: ProfileLine, s: number): Slope | null {
  const i = segmentIndexAt(line, s);
  if (i === null) return null;
  const a = line[i];
  const b = line[i + 1];
  const dz = b.z - a.z;
  const ds = b.s - a.s;
  return { degrees: (Math.atan2(dz, ds) * 180) / Math.PI, percent: (dz / ds) * 100 };
}

export interface LineHit {
  readonly s: number;
  readonly z: number;
}

export function nearestOnLine(line: ProfileLine, s: number): LineHit | null {
  if (line.length < 2) return null;
  const clamped = Math.min(line[line.length - 1].s, Math.max(line[0].s, s));
  const z = interpolateZ(line, clamped);
  return z === null ? null : { s: clamped, z };
}

export function traceToFunction(trace: readonly ProfilePoint[]): ProfilePoint[] {
  const valid = trace.filter((p) => Number.isFinite(p.s) && Number.isFinite(p.z));
  const indexed = valid.map((p, order) => ({ p, order }));
  indexed.sort((a, b) => a.p.s - b.p.s || a.order - b.order);
  const result: ProfilePoint[] = [];
  for (const { p } of indexed) {
    const last = result[result.length - 1];
    if (last !== undefined && last.s === p.s) result[result.length - 1] = p;
    else result.push(p);
  }
  return result;
}

export function replaceRange(line: ProfileLine, trace: readonly ProfilePoint[]): ProfileLine {
  const inserted = traceToFunction(trace);
  if (inserted.length === 0) return line;
  const sMin = inserted[0].s;
  const sMax = inserted[inserted.length - 1].s;
  const before = line.filter((p) => p.s < sMin);
  const after = line.filter((p) => p.s > sMax);
  return [...before, ...inserted, ...after];
}

export interface History<T> {
  readonly past: readonly T[];
  readonly present: T;
  readonly future: readonly T[];
}

export function newHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export function pushEdit<T>(history: History<T>, next: T): History<T> {
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  if (!canUndo(history)) return history;
  const past = history.past.slice(0, -1);
  return { past, present: history.past[history.past.length - 1], future: [history.present, ...history.future] };
}

export function redo<T>(history: History<T>): History<T> {
  if (!canRedo(history)) return history;
  const [next, ...future] = history.future;
  return { past: [...history.past, history.present], present: next, future };
}

export const LONG_PRESS_MS = 300;
export const DRAG_THRESHOLD_PX = 5;
export const TOUCH_LONG_PRESS_MS = 500;

export interface PressInfo {
  readonly durationMs: number;
  readonly movedPx: number;
}

export type RightPressKind = "click" | "pan";

export function classifyRightPress(press: PressInfo): RightPressKind {
  if (press.movedPx > DRAG_THRESHOLD_PX) return "pan";
  if (press.durationMs >= LONG_PRESS_MS) return "pan";
  return "click";
}

export type OneFingerKind = "pending" | "longpress" | "trace";

export function classifyOneFinger(press: PressInfo): OneFingerKind {
  if (press.movedPx > DRAG_THRESHOLD_PX) return "trace";
  if (press.durationMs >= TOUCH_LONG_PRESS_MS) return "longpress";
  return "pending";
}

export interface TwoFingerStep {
  readonly center: ScreenPoint;
  readonly zoomFactor: number;
  readonly dx: number;
  readonly dy: number;
}

type FingerPair = readonly [ScreenPoint, ScreenPoint];

function midpoint(pair: FingerPair): ScreenPoint {
  return { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
}

function distance(pair: FingerPair): number {
  return Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
}

export function twoFingerStep(prev: FingerPair, cur: FingerPair): TwoFingerStep {
  const prevMid = midpoint(prev);
  const center = midpoint(cur);
  const prevDist = distance(prev);
  return {
    center,
    zoomFactor: prevDist > 0 ? distance(cur) / prevDist : 1,
    dx: center.x - prevMid.x,
    dy: center.y - prevMid.y,
  };
}
