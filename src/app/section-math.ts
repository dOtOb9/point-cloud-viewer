// G2-2: the arithmetic behind the 2D cross-section view. Pure functions, no DOM, no React.
//
// Section coordinates: `s` = horizontal distance from A along A->B, `z` = height, both in the file's unit.
// Screen coordinates: CSS pixels of the panel, x right, y down.
// The view has ONE scale for both axes (no vertical exaggeration; owner decision Q12).
// Everything is immutable: functions return new objects and never change their arguments.

// ---------------------------------------------------------------------------------------------
// View (section <-> screen)
// ---------------------------------------------------------------------------------------------

/** screenX = offsetX + s * scale, screenY = offsetY - z * scale. `scale` is pixels per file unit. */
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

/** Limits of `scale` in pixels per file unit. */
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

/**
 * A view that shows the whole `sRange` x `zRange` inside the panel, centred, with `padding` pixels on every side.
 * A zero-size range (one point, a flat line) is widened so the scale stays finite.
 */
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

/**
 * Zoom by `factor` (> 1 zooms in) keeping the section point under `screen` where it is.
 * The same function serves the mouse wheel (cursor) and the pinch (midpoint of the two fingers).
 * If the scale hits a limit the factor is reduced, so the point still stays fixed.
 */
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

// ---------------------------------------------------------------------------------------------
// Profile line (a function of s)
// ---------------------------------------------------------------------------------------------

export interface ProfilePoint {
  readonly s: number;
  readonly z: number;
}

/** Points sorted by strictly increasing `s`: one height per `s`. */
export type ProfileLine = readonly ProfilePoint[];

/** Index i of the segment [line[i].s, line[i+1].s] that contains `s` (the last segment includes its right end). */
function segmentIndexAt(line: ProfileLine, s: number): number | null {
  if (line.length < 2) return null;
  if (!(s >= line[0].s) || !(s <= line[line.length - 1].s)) return null;
  // Binary search for the last vertex with vertex.s <= s.
  let lo = 0;
  let hi = line.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (line[mid].s <= s) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, line.length - 2);
}

/** Height of the line at `s` by linear interpolation. null outside the line (or when it has fewer than 2 points). */
export function interpolateZ(line: ProfileLine, s: number): number | null {
  const i = segmentIndexAt(line, s);
  if (i === null) return null;
  const a = line[i];
  const b = line[i + 1];
  const t = (s - a.s) / (b.s - a.s);
  return a.z + t * (b.z - a.z);
}

export interface Slope {
  readonly degrees: number; // positive = rising toward B
  readonly percent: number; // 100 * dz / ds
}

/**
 * Slope of the segment that contains `s`.
 * - Exactly on a vertex: the segment to the right of it (the segment that starts there); on the last vertex,
 *   the last segment. So the answer is never an average of two segments.
 * - Outside the line, or a line with fewer than 2 points: null.
 */
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
  readonly s: number; // the s that was used (clamped to the line)
  readonly z: number;
}

/**
 * Place the GL marker for a click at section coordinate `s`: the point on the line at that `s`,
 * with `s` clamped into the line's range. null for a line with fewer than 2 points.
 */
export function nearestOnLine(line: ProfileLine, s: number): LineHit | null {
  if (line.length < 2) return null;
  const clamped = Math.min(line[line.length - 1].s, Math.max(line[0].s, s));
  const z = interpolateZ(line, clamped);
  return z === null ? null : { s: clamped, z };
}

// ---------------------------------------------------------------------------------------------
// Trace editing
// ---------------------------------------------------------------------------------------------

/**
 * Turn a raw pointer path (drawing order, may go back and forth) into a function of s:
 * stable sort by `s`, then among points with exactly the same `s` keep the one drawn LAST.
 * Points with a non-finite coordinate are dropped.
 * This keeps every drawn point; a path that goes back over itself ends up as the union of both passes sorted by s
 * (no smoothing, no averaging: simple and predictable).
 */
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

/**
 * Replace the part of `line` covered by `trace` with the trace.
 * The covered range is [min s, max s] of the trace, ends included. Line points inside it are removed,
 * the trace (as a function of s) is inserted. The rest of the line is kept as it is,
 * so the trace may extend beyond either end of the line (the line grows) or sit inside one segment.
 * An empty (or all non-finite) trace returns the line unchanged.
 */
export function replaceRange(line: ProfileLine, trace: readonly ProfilePoint[]): ProfileLine {
  const inserted = traceToFunction(trace);
  if (inserted.length === 0) return line;
  const sMin = inserted[0].s;
  const sMax = inserted[inserted.length - 1].s;
  const before = line.filter((p) => p.s < sMin);
  const after = line.filter((p) => p.s > sMax);
  return [...before, ...inserted, ...after];
}

// ---------------------------------------------------------------------------------------------
// History (undo / redo buttons). Whole-line snapshots: lines are small, so no diffs.
// ---------------------------------------------------------------------------------------------

export interface History<T> {
  readonly past: readonly T[]; // oldest first
  readonly present: T;
  readonly future: readonly T[]; // next redo first
}

export function newHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

/** Make `next` the present; the old present goes to the past, and redo is cleared. */
export function pushEdit<T>(history: History<T>, next: T): History<T> {
  return { past: [...history.past, history.present], present: next, future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

/** Go one step back. Returns the same object when there is nothing to undo. */
export function undo<T>(history: History<T>): History<T> {
  if (!canUndo(history)) return history;
  const past = history.past.slice(0, -1);
  return { past, present: history.past[history.past.length - 1], future: [history.present, ...history.future] };
}

/** Go one step forward. Returns the same object when there is nothing to redo. */
export function redo<T>(history: History<T>): History<T> {
  if (!canRedo(history)) return history;
  const [next, ...future] = history.future;
  return { past: [...history.past, history.present], present: next, future };
}

// ---------------------------------------------------------------------------------------------
// Gesture classification (numbers only)
// ---------------------------------------------------------------------------------------------

/** A right-button press held at least this long (ms) becomes a pan. */
export const LONG_PRESS_MS = 300;
/** Movement (px) beyond this turns a press into a drag. */
export const DRAG_THRESHOLD_PX = 5;
/** A finger held still this long (ms) is the GL / slope gesture. A little longer than the mouse, to avoid accidents. */
export const TOUCH_LONG_PRESS_MS = 500;

export interface PressInfo {
  readonly durationMs: number; // time since the press began
  readonly movedPx: number; // largest distance from the press position so far
}

export type RightPressKind = "click" | "pan";

/**
 * Right button: a short press without movement is a "click" (show GL and slope);
 * moving, or holding for LONG_PRESS_MS, is a "pan" (long press then drag, or drag at once).
 * The context menu of the browser is never shown (the UI's job).
 */
export function classifyRightPress(press: PressInfo): RightPressKind {
  if (press.movedPx > DRAG_THRESHOLD_PX) return "pan";
  if (press.durationMs >= LONG_PRESS_MS) return "pan";
  return "click";
}

export type OneFingerKind = "pending" | "longpress" | "trace";

/**
 * One finger: moving beyond DRAG_THRESHOLD_PX is a "trace" (edit the line), at any time.
 * Still for TOUCH_LONG_PRESS_MS is a "longpress" (GL / slope). Before either: "pending".
 * A finger lifted while still "pending" is a plain tap: nothing happens.
 */
export function classifyOneFinger(press: PressInfo): OneFingerKind {
  if (press.movedPx > DRAG_THRESHOLD_PX) return "trace";
  if (press.durationMs >= TOUCH_LONG_PRESS_MS) return "longpress";
  return "pending";
}

export interface TwoFingerStep {
  readonly center: ScreenPoint; // current midpoint: the zoom centre
  readonly zoomFactor: number; // current distance / previous distance
  readonly dx: number; // midpoint movement
  readonly dy: number;
}

type FingerPair = readonly [ScreenPoint, ScreenPoint];

function midpoint(pair: FingerPair): ScreenPoint {
  return { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
}

function distance(pair: FingerPair): number {
  return Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
}

/**
 * Two fingers, one move event: the pan (midpoint movement) and the pinch (distance ratio).
 * Apply with `zoomAt(view, center, zoomFactor)` then `panBy(view, dx, dy)`.
 * The factor is 1 when the previous distance is 0.
 */
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
