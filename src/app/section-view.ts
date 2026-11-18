import { readSectionProfile as tauriReadSectionProfile } from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import type { DataSource } from "../datasource/DataSource";
import {
  DEFAULT_SECTION_POINT_CAP,
  NO_SECTION_POINTS,
  type SectionLineInput,
  type SectionPoints,
} from "../datasource/section-profile";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { findLayer, type LayersState } from "../state/layers";
import type { SectionGroundLine } from "../datasource/section-line";
import {
  groundLevelAt,
  groundLineToProfile,
  profileToGroundLine,
  SLOPE_HALF_WINDOW_M,
  type GroundLevelReading,
} from "./section-3d";
import {
  canRedo,
  canUndo,
  classifyOneFinger,
  classifyRightPress,
  DRAG_THRESHOLD_PX,
  fitView,
  panBy,
  pushEdit,
  redo,
  replaceRange,
  screenToSection,
  twoFingerStep,
  undo,
  zoomAt,
  type History,
  type ProfilePoint,
  type ScreenPoint,
  type SectionView,
  type Size,
} from "./section-math";

export const FIT_PADDING_PX = 40;

export interface SectionViewState {
  openLayerId: string | null;
  points: SectionPoints;
  loading: boolean;
  view: SectionView | null;
  panelSize: Size;
  cursorS: number | null;
  groundLevel: GroundLevelReading | null;
  trace: ProfilePoint[] | null;
  enlarged: boolean;
}

interface TrackedPointer {
  type: string;
  button: number;
  startX: number;
  startY: number;
  startTimeMs: number;
  x: number;
  y: number;
  movedPx: number;
  anchorX: number;
  anchorY: number;
}

export interface SectionGesture {
  pointers: Map<number, TrackedPointer>;
  multiTouch: boolean;
  trace: { pointerId: number; points: ProfilePoint[] } | null;
}

export function newSectionGesture(): SectionGesture {
  return { pointers: new Map(), multiTouch: false, trace: null };
}

export interface SectionViewContext extends SectionViewState {
  getSource: () => DataSource | null;
  getLayersState: () => LayersState;
  reportError: (message: string, source?: GpuErrorSource) => void;
  setOpenLayerId: (id: string | null) => void;
  setPoints: (points: SectionPoints) => void;
  setLoading: (loading: boolean) => void;
  setView: (view: SectionView | null) => void;
  setPanelSize: (size: Size) => void;
  setCursorS: (s: number | null) => void;
  setGroundLevel: (reading: GroundLevelReading | null) => void;
  setTrace: (points: ProfilePoint[] | null) => void;
  setEnlarged: (enlarged: boolean) => void;
  setSectionLineHistory: (layerId: string, history: History<SectionGroundLine>) => void;
  token: { generation: number };
  gesture: SectionGesture;
}

export async function openSectionPanel(ctx: SectionViewContext, layerId: string): Promise<void> {
  const layer = findLayer(ctx.getLayersState().layers, layerId);
  const source = ctx.getSource();
  if (!layer || !layer.section || !source) {
    ctx.reportError("断面の情報が無いレイヤーなので、断面図を出せません", "tool");
    return;
  }
  const generation = ++ctx.token.generation;
  ctx.setOpenLayerId(layerId);
  ctx.setCursorS(null);
  ctx.setGroundLevel(null);
  ctx.setPoints(NO_SECTION_POINTS);
  ctx.setView(null);
  ctx.setLoading(true);
  try {
    const line: SectionLineInput = { a: layer.section.a, b: layer.section.b, up: layer.section.up };
    const points =
      source instanceof WebSource
        ? await source.readSectionProfile(layer.cloudId, line, DEFAULT_SECTION_POINT_CAP)
        : await tauriReadSectionProfile(layer.cloudId, line, DEFAULT_SECTION_POINT_CAP);
    if (ctx.token.generation !== generation) return;
    ctx.setPoints(points);
    ctx.setLoading(false);
  } catch (e) {
    if (ctx.token.generation !== generation) return;
    ctx.reportError(`断面図の点を読めませんでした: ${e instanceof Error ? e.message : String(e)}`, "tool");
    ctx.setOpenLayerId(null);
    ctx.setLoading(false);
  }
}

export function followSelectedLayer(ctx: SectionViewContext, selectedLayerId: string | null): void {
  const layer = selectedLayerId === null ? undefined : findLayer(ctx.getLayersState().layers, selectedLayerId);
  if (!layer || !layer.section) {
    if (ctx.openLayerId !== null) closeSectionPanel(ctx);
    return;
  }
  if (ctx.openLayerId === layer.id) return;
  void openSectionPanel(ctx, layer.id);
}

export function toggleSectionEnlarged(ctx: SectionViewContext): void {
  ctx.setEnlarged(!ctx.enlarged);
}

export function closeSectionPanel(ctx: SectionViewContext): void {
  ctx.token.generation += 1;
  ctx.gesture.pointers.clear();
  ctx.gesture.multiTouch = false;
  ctx.gesture.trace = null;
  ctx.setTrace(null);
  ctx.setEnlarged(false);
  ctx.setOpenLayerId(null);
  ctx.setCursorS(null);
  ctx.setGroundLevel(null);
  ctx.setPoints(NO_SECTION_POINTS);
  ctx.setView(null);
  ctx.setLoading(false);
}

export function effectiveSectionView(state: Pick<SectionViewState, "view" | "panelSize" | "points">): SectionView {
  if (state.view) return state.view;
  return fitView(state.panelSize, state.points.sRange, state.points.zRange, FIT_PADDING_PX);
}

export function setSectionPanelSize(ctx: SectionViewContext, size: Size): void {
  if (size.width === ctx.panelSize.width && size.height === ctx.panelSize.height) return;
  ctx.setPanelSize(size);
}

export function resetSectionView(ctx: SectionViewContext): void {
  ctx.setView(null);
}

const WHEEL_DELTA_MODE_LINE = 1;
const WHEEL_DELTA_MODE_PAGE = 2;
const PIXELS_PER_WHEEL_LINE = 16;
const PIXELS_PER_WHEEL_PAGE = 400;

export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels =
    deltaMode === WHEEL_DELTA_MODE_LINE
      ? deltaY * PIXELS_PER_WHEEL_LINE
      : deltaMode === WHEEL_DELTA_MODE_PAGE
        ? deltaY * PIXELS_PER_WHEEL_PAGE
        : deltaY;
  return Math.exp(-pixels * 0.001);
}

export function zoomSectionWheel(ctx: SectionViewContext, cursor: ScreenPoint, deltaY: number, deltaMode: number): void {
  ctx.setView(zoomAt(effectiveSectionView(ctx), cursor, wheelZoomFactor(deltaY, deltaMode)));
}

export interface SectionPointer {
  pointerId: number;
  pointerType: string;
  button: number;
  x: number;
  y: number;
  timeMs: number;
}

const LEFT_BUTTON = 0;
const RIGHT_BUTTON = 2;

export function sectionPointerDown(ctx: SectionViewContext, p: SectionPointer): void {
  const gesture = ctx.gesture;
  gesture.pointers.set(p.pointerId, {
    type: p.pointerType,
    button: p.button,
    startX: p.x,
    startY: p.y,
    startTimeMs: p.timeMs,
    x: p.x,
    y: p.y,
    movedPx: 0,
    anchorX: p.x,
    anchorY: p.y,
  });
  if (touchPointers(gesture).length >= 2) {
    gesture.multiTouch = true;
    discardTrace(ctx);
  }
}

export function sectionPointerMove(ctx: SectionViewContext, p: SectionPointer): void {
  if (p.pointerType !== "touch") setCursorFromScreen(ctx, p.x);
  const tracked = ctx.gesture.pointers.get(p.pointerId);
  if (!tracked) return;
  const touches = touchPointers(ctx.gesture);
  const before = touches.map((t) => ({ x: t.x, y: t.y }));
  tracked.x = p.x;
  tracked.y = p.y;
  tracked.movedPx = Math.max(tracked.movedPx, Math.hypot(p.x - tracked.startX, p.y - tracked.startY));

  if (tracked.type === "touch") {
    if (touches.length === 1 && !ctx.gesture.multiTouch) {
      if (classifyOneFinger({ durationMs: p.timeMs - tracked.startTimeMs, movedPx: tracked.movedPx }) === "trace") {
        extendTrace(ctx, p.pointerId, tracked);
      }
      return;
    }
    if (touches.length !== 2) return;
    const step = twoFingerStep([before[0], before[1]], [
      { x: touches[0].x, y: touches[0].y },
      { x: touches[1].x, y: touches[1].y },
    ]);
    const zoomed = zoomAt(effectiveSectionView(ctx), step.center, step.zoomFactor);
    ctx.setView(panBy(zoomed, step.dx, step.dy));
    return;
  }

  if (tracked.button === LEFT_BUTTON) {
    if (tracked.movedPx > DRAG_THRESHOLD_PX) extendTrace(ctx, p.pointerId, tracked);
    return;
  }
  if (tracked.button !== RIGHT_BUTTON) return;
  const kind = classifyRightPress({ durationMs: p.timeMs - tracked.startTimeMs, movedPx: tracked.movedPx });
  if (kind !== "pan") return;
  ctx.setView(panBy(effectiveSectionView(ctx), p.x - tracked.anchorX, p.y - tracked.anchorY));
  tracked.anchorX = p.x;
  tracked.anchorY = p.y;
}

export function sectionPointerUp(ctx: SectionViewContext, p: SectionPointer): void {
  const tracked = ctx.gesture.pointers.get(p.pointerId);
  if (!tracked) return;
  ctx.gesture.pointers.delete(p.pointerId);
  if (ctx.gesture.trace?.pointerId === p.pointerId) {
    if (tracked.type !== "touch" || !ctx.gesture.multiTouch) commitTrace(ctx);
    else discardTrace(ctx);
  }
  const press = { durationMs: p.timeMs - tracked.startTimeMs, movedPx: tracked.movedPx };
  if (tracked.type === "touch") {
    if (!ctx.gesture.multiTouch && classifyOneFinger(press) === "longpress") {
      showGroundLevelAt(ctx, p.x);
    }
  } else if (tracked.button === RIGHT_BUTTON && classifyRightPress(press) === "click") {
    showGroundLevelAt(ctx, p.x);
  }
  if (ctx.gesture.pointers.size === 0) ctx.gesture.multiTouch = false;
}

export function sectionPointerCancel(ctx: SectionViewContext, p: SectionPointer): void {
  ctx.gesture.pointers.delete(p.pointerId);
  if (ctx.gesture.trace?.pointerId === p.pointerId) discardTrace(ctx);
  if (ctx.gesture.pointers.size === 0) ctx.gesture.multiTouch = false;
}

function openLineState(ctx: SectionViewContext) {
  if (ctx.openLayerId === null) return null;
  const layer = findLayer(ctx.getLayersState().layers, ctx.openLayerId);
  const line = layer?.section?.line;
  if (!layer || !line) return null;
  return { layerId: layer.id, line };
}

function extendTrace(ctx: SectionViewContext, pointerId: number, tracked: TrackedPointer): void {
  const gesture = ctx.gesture;
  if (gesture.trace && gesture.trace.pointerId !== pointerId) return;
  if (!gesture.trace) {
    if (!openLineState(ctx)) return;
    const view = effectiveSectionView(ctx);
    gesture.trace = { pointerId, points: [screenToSection(view, tracked.startX, tracked.startY)] };
  }
  gesture.trace.points.push(screenToSection(effectiveSectionView(ctx), tracked.x, tracked.y));
  ctx.setTrace([...gesture.trace.points]);
}

function discardTrace(ctx: SectionViewContext): void {
  if (!ctx.gesture.trace) return;
  ctx.gesture.trace = null;
  ctx.setTrace(null);
}

function commitTrace(ctx: SectionViewContext): void {
  const trace = ctx.gesture.trace;
  ctx.gesture.trace = null;
  ctx.setTrace(null);
  const found = openLineState(ctx);
  if (!trace || !found) return;
  const present = found.line.history.present;
  const replaced = replaceRange(groundLineToProfile(present.points), trace.points);
  const next = profileToGroundLine(replaced, present);
  ctx.setSectionLineHistory(found.layerId, pushEdit(found.line.history, next));
}

export function undoSectionLine(ctx: SectionViewContext): void {
  const found = openLineState(ctx);
  if (!found || !canUndo(found.line.history)) return;
  ctx.setSectionLineHistory(found.layerId, undo(found.line.history));
}

export function redoSectionLine(ctx: SectionViewContext): void {
  const found = openLineState(ctx);
  if (!found || !canRedo(found.line.history)) return;
  ctx.setSectionLineHistory(found.layerId, redo(found.line.history));
}

export function resetSectionLineToComputed(ctx: SectionViewContext): void {
  const found = openLineState(ctx);
  if (!found || found.line.history.present === found.line.original) return;
  ctx.setSectionLineHistory(found.layerId, pushEdit(found.line.history, found.line.original));
}

function touchPointers(gesture: SectionGesture): TrackedPointer[] {
  return [...gesture.pointers.values()].filter((t) => t.type === "touch");
}

export function sectionPointerLeave(ctx: SectionViewContext): void {
  ctx.setCursorS(null);
}

function setCursorFromScreen(ctx: SectionViewContext, x: number): void {
  ctx.setCursorS(screenToSection(effectiveSectionView(ctx), x, 0).s);
}

function openGroundLine(ctx: SectionViewContext) {
  if (ctx.openLayerId === null) return null;
  const layer = findLayer(ctx.getLayersState().layers, ctx.openLayerId);
  const pairs = layer?.section?.line?.history.present.points;
  if (!layer || !pairs) return null;
  return { line: groundLineToProfile(pairs), crs: layer.info.crs };
}

export function showGroundLevelAt(ctx: SectionViewContext, x: number): void {
  const found = openGroundLine(ctx);
  if (!found) {
    ctx.setGroundLevel(null);
    return;
  }
  const horizontal = found.crs?.horizontalUnitToMeter ?? null;
  const vertical = found.crs?.verticalUnitToMeter ?? null;
  const halfWindow = horizontal === null ? SLOPE_HALF_WINDOW_M : SLOPE_HALF_WINDOW_M / horizontal;
  const verticalPerHorizontal = horizontal === null || vertical === null ? 1 : vertical / horizontal;
  const s = screenToSection(effectiveSectionView(ctx), x, 0).s;
  ctx.setGroundLevel(groundLevelAt(found.line, s, halfWindow, verticalPerHorizontal));
}
