// G2-3: the steps of the 2D cross-section panel, as plain functions (no class, no React): open the panel for a section
// layer (read its points as `(s, z)`), close it, resize, zoom with the wheel, and the pointer input (mouse and touch).
// Everything they read or change comes in through `SectionViewContext`, built by src/state/useSectionView.ts. The state
// itself lives in React; these functions change it only through the setters in the context.
// The arithmetic (screen <-> section, zoom about a point, gesture classification) is in src/app/section-math.ts.
// Called by: the section tool (`openSectionPanel`, through src/app/point-cloud-tools.ts) and src/ui/section/SectionPanel.tsx.
// Rule: nothing in src/app/ imports React or a `use*` hook (TaskSheets/ADR-0021-thin-react.md).
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

/** Pixels kept free around the points when the view is fitted to all of them. */
export const FIT_PADDING_PX = 40;

/** The values the panel shows. */
export interface SectionViewState {
  /** The cross-section layer whose panel is open, or null (panel closed). */
  openLayerId: string | null;
  points: SectionPoints;
  loading: boolean;
  /** null = "fit all points in the panel" (see `effectiveSectionView`). */
  view: SectionView | null;
  /** Size of the drawing area in CSS pixels; 0 x 0 until the panel has been laid out. */
  panelSize: Size;
  /** `s` under the mouse pointer in the panel, or null when it is not over the panel (G2-8: shown as a dot in 3D too). */
  cursorS: number | null;
  /** The GL and slope read by the last right click / long press (G2-6), or null. Shown in the panel and in 3D. */
  groundLevel: GroundLevelReading | null;
  /** G2-5: the path being traced right now (the preview line), or null when nothing is being traced. */
  trace: ProfilePoint[] | null;
}

/** One pointer (a mouse button press or a finger) that is down. */
interface TrackedPointer {
  type: string;
  button: number;
  startX: number;
  startY: number;
  startTimeMs: number;
  x: number;
  y: number;
  /** Largest distance from the press position so far. */
  movedPx: number;
  /** Where the last pan step ended; the next step moves the view by the distance from here. */
  anchorX: number;
  anchorY: number;
}

/** The pointers currently down. Changes at pointer speed, so it is a plain object, not React state. */
export interface SectionGesture {
  pointers: Map<number, TrackedPointer>;
  /** Two fingers have been down since the last time no finger was: lifting one is not a tap or a long press. */
  multiTouch: boolean;
  /** G2-5: the trace in progress (which pointer draws it, and the `(s, z)` points so far), or null. */
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
  /** G2-5: store a new edit history for the section line of a layer (the layers state lives in React). */
  setSectionLineHistory: (layerId: string, history: History<SectionGroundLine>) => void;
  /** Counts opens/closes: a read that finishes after a newer open or a close is dropped. */
  token: { generation: number };
  gesture: SectionGesture;
}

// ---------------------------------------------------------------------------------------------
// Open and close
// ---------------------------------------------------------------------------------------------

/**
 * Open the panel for a layer made by the cross-section tool: read its points as `(s, z)` and show them.
 * The context may be from an earlier render (the tool finishes long after it started), so this reads only the getters,
 * the setters and the token from it, never the state values. A failure goes to the error log and the panel closes.
 */
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
    if (ctx.token.generation !== generation) return; // closed or replaced while reading
    ctx.setPoints(points);
    ctx.setLoading(false);
  } catch (e) {
    if (ctx.token.generation !== generation) return;
    ctx.reportError(`断面図の点を読めませんでした: ${e instanceof Error ? e.message : String(e)}`, "tool");
    ctx.setOpenLayerId(null);
    ctx.setLoading(false);
  }
}

export function closeSectionPanel(ctx: SectionViewContext): void {
  ctx.token.generation += 1; // drop a read that is still running
  ctx.gesture.pointers.clear();
  ctx.gesture.multiTouch = false;
  ctx.gesture.trace = null;
  ctx.setTrace(null);
  ctx.setOpenLayerId(null);
  ctx.setCursorS(null);
  ctx.setGroundLevel(null);
  ctx.setPoints(NO_SECTION_POINTS);
  ctx.setView(null);
  ctx.setLoading(false);
}

// ---------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------

/** The view to draw with: the user's view, or all points fitted into the panel while the user has not moved it. */
export function effectiveSectionView(state: Pick<SectionViewState, "view" | "panelSize" | "points">): SectionView {
  if (state.view) return state.view;
  return fitView(state.panelSize, state.points.sRange, state.points.zRange, FIT_PADDING_PX);
}

/** The panel was laid out or resized. A view the user has set keeps its scale and offset. */
export function setSectionPanelSize(ctx: SectionViewContext, size: Size): void {
  if (size.width === ctx.panelSize.width && size.height === ctx.panelSize.height) return;
  ctx.setPanelSize(size);
}

/** Back to "all points fitted into the panel". */
export function resetSectionView(ctx: SectionViewContext): void {
  ctx.setView(null);
}

/** Zoom factor of one wheel event: scrolling up (negative `deltaY`) zooms in, about 10% per usual notch (100 px). */
export function wheelZoomFactor(deltaY: number, deltaMode: number): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY; // lines / pages / pixels
  return Math.exp(-pixels * 0.001);
}

/** Wheel: zoom about the cursor. */
export function zoomSectionWheel(ctx: SectionViewContext, cursor: ScreenPoint, deltaY: number, deltaMode: number): void {
  ctx.setView(zoomAt(effectiveSectionView(ctx), cursor, wheelZoomFactor(deltaY, deltaMode)));
}

// ---------------------------------------------------------------------------------------------
// Pointer input (mouse and touch)
// ---------------------------------------------------------------------------------------------

/** A pointer event reduced to numbers: `x`, `y` are in the panel's CSS pixels, `timeMs` is the event's time. */
export interface SectionPointer {
  pointerId: number;
  /** "mouse", "touch" or "pen". */
  pointerType: string;
  /** Which button went down or up (0 left, 2 right). */
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
    // A second finger means zoom / pan: the trace of the first finger is thrown away (G2-5).
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
    // One finger that moved: trace the line (G2-5), unless a second finger has been down in this gesture.
    if (touches.length === 1 && !ctx.gesture.multiTouch) {
      if (classifyOneFinger({ durationMs: p.timeMs - tracked.startTimeMs, movedPx: tracked.movedPx }) === "trace") {
        extendTrace(ctx, p.pointerId, tracked);
      }
      return;
    }
    // Two fingers: pinch (zoom about the midpoint) and drag (pan), together.
    if (touches.length !== 2) return;
    const step = twoFingerStep([before[0], before[1]], [
      { x: touches[0].x, y: touches[0].y },
      { x: touches[1].x, y: touches[1].y },
    ]);
    const zoomed = zoomAt(effectiveSectionView(ctx), step.center, step.zoomFactor);
    ctx.setView(panBy(zoomed, step.dx, step.dy));
    return;
  }

  // Mouse: the left button traces the line (G2-5) once it has moved beyond the drag threshold.
  if (tracked.button === LEFT_BUTTON) {
    if (tracked.movedPx > DRAG_THRESHOLD_PX) extendTrace(ctx, p.pointerId, tracked);
    return;
  }
  // The right button pans once it is a drag or a long press.
  if (tracked.button !== RIGHT_BUTTON) return;
  const kind = classifyRightPress({ durationMs: p.timeMs - tracked.startTimeMs, movedPx: tracked.movedPx });
  if (kind !== "pan") return;
  // The movement made before the press became a pan is included, because the anchor is still the press position.
  ctx.setView(panBy(effectiveSectionView(ctx), p.x - tracked.anchorX, p.y - tracked.anchorY));
  tracked.anchorX = p.x;
  tracked.anchorY = p.y;
}

export function sectionPointerUp(ctx: SectionViewContext, p: SectionPointer): void {
  const tracked = ctx.gesture.pointers.get(p.pointerId);
  if (!tracked) return;
  ctx.gesture.pointers.delete(p.pointerId);
  // Finish a trace this pointer was drawing (a touch trace only if no second finger came in meanwhile).
  if (ctx.gesture.trace?.pointerId === p.pointerId) {
    if (tracked.type !== "touch" || !ctx.gesture.multiTouch) commitTrace(ctx);
    else discardTrace(ctx);
  }
  const press = { durationMs: p.timeMs - tracked.startTimeMs, movedPx: tracked.movedPx };
  if (tracked.type === "touch") {
    // A long press of one finger that did not move shows the ground level (G2-6). Not after a two-finger gesture.
    if (!ctx.gesture.multiTouch && classifyOneFinger(press) === "longpress") {
      showGroundLevelAt(ctx, p.x);
    }
  } else if (tracked.button === RIGHT_BUTTON && classifyRightPress(press) === "click") {
    showGroundLevelAt(ctx, p.x);
  }
  if (ctx.gesture.pointers.size === 0) ctx.gesture.multiTouch = false;
}

/** The pointer was taken away (the system cancelled it): forget it without a click. */
export function sectionPointerCancel(ctx: SectionViewContext, p: SectionPointer): void {
  ctx.gesture.pointers.delete(p.pointerId);
  if (ctx.gesture.trace?.pointerId === p.pointerId) discardTrace(ctx);
  if (ctx.gesture.pointers.size === 0) ctx.gesture.multiTouch = false;
}

// ---------------------------------------------------------------------------------------------
// Tracing the section line (G2-5), and its buttons
// ---------------------------------------------------------------------------------------------

/** The section line of the open layer with its history, or null when no panel is open or the layer has no line. */
function openLineState(ctx: SectionViewContext) {
  if (ctx.openLayerId === null) return null;
  const layer = findLayer(ctx.getLayersState().layers, ctx.openLayerId);
  const line = layer?.section?.line;
  if (!layer || !line) return null;
  return { layerId: layer.id, line };
}

/** Add the pointer's position to the trace (starting it with the press position), and show the preview. */
function extendTrace(ctx: SectionViewContext, pointerId: number, tracked: TrackedPointer): void {
  const gesture = ctx.gesture;
  if (gesture.trace && gesture.trace.pointerId !== pointerId) return; // another pointer is tracing
  if (!gesture.trace) {
    if (!openLineState(ctx)) return; // no line (still computing, or failed): nothing to edit
    const view = effectiveSectionView(ctx);
    gesture.trace = { pointerId, points: [screenToSection(view, tracked.startX, tracked.startY)] };
  }
  gesture.trace.points.push(screenToSection(effectiveSectionView(ctx), tracked.x, tracked.y));
  ctx.setTrace([...gesture.trace.points]);
}

/** Throw the trace in progress away (a second finger came, or the pointer was cancelled). */
function discardTrace(ctx: SectionViewContext): void {
  if (!ctx.gesture.trace) return;
  ctx.gesture.trace = null;
  ctx.setTrace(null);
}

/** The pointer was lifted: replace the covered part of the line with the trace and put the result in the history. */
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

/** "Undo" button: back one edit. Does nothing without a line or without an edit to undo. */
export function undoSectionLine(ctx: SectionViewContext): void {
  const found = openLineState(ctx);
  if (!found || !canUndo(found.line.history)) return;
  ctx.setSectionLineHistory(found.layerId, undo(found.line.history));
}

/** "Redo" button: forward one edit. */
export function redoSectionLine(ctx: SectionViewContext): void {
  const found = openLineState(ctx);
  if (!found || !canRedo(found.line.history)) return;
  ctx.setSectionLineHistory(found.layerId, redo(found.line.history));
}

/** "Back to the computed line" button: the original line becomes the present, as an edit (so it can be undone). */
export function resetSectionLineToComputed(ctx: SectionViewContext): void {
  const found = openLineState(ctx);
  if (!found || found.line.history.present === found.line.original) return;
  ctx.setSectionLineHistory(found.layerId, pushEdit(found.line.history, found.line.original));
}

function touchPointers(gesture: SectionGesture): TrackedPointer[] {
  return [...gesture.pointers.values()].filter((t) => t.type === "touch");
}

/** The mouse left the panel: the cursor dot in 3D goes away. */
export function sectionPointerLeave(ctx: SectionViewContext): void {
  ctx.setCursorS(null);
}

/** The mouse is at panel x `x` (CSS px): remember the `s` under it. The height does not matter here. */
function setCursorFromScreen(ctx: SectionViewContext, x: number): void {
  ctx.setCursorS(screenToSection(effectiveSectionView(ctx), x, 0).s);
}

/**
 * The ground line of the open section layer as it is now, read from the layers state (so edits and undo of G2-5 show up
 * without a copy), with the layer's CRS. null when no panel is open or the layer has no line.
 */
function openGroundLine(ctx: SectionViewContext) {
  if (ctx.openLayerId === null) return null;
  const layer = findLayer(ctx.getLayersState().layers, ctx.openLayerId);
  const pairs = layer?.section?.line?.history.present.points;
  if (!layer || !pairs) return null;
  return { line: groundLineToProfile(pairs), crs: layer.info.crs };
}

/**
 * Right click (mouse) or long press (touch) at panel x `x`: read the ground level (GL) and the slope of the section
 * line at that `s` and keep it in the state; both views draw it. Outside the line, or with no line, the old reading is
 * cleared (the panel keeps showing its hint).
 * The slope window is `SLOPE_HALF_WINDOW_M` metres on each side, converted to the file's horizontal unit with the layer's
 * CRS factors like src/app/csf-params.ts does (an unknown unit is used as it is).
 */
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
