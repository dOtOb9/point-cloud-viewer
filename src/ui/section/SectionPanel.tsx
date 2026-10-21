import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  effectiveSectionView,
  redoSectionLine,
  resetSectionLineToComputed,
  resetSectionView,
  undoSectionLine,
  sectionPointerCancel,
  sectionPointerLeave,
  sectionPointerDown,
  sectionPointerMove,
  sectionPointerUp,
  setSectionPanelSize,
  toggleSectionEnlarged,
  zoomSectionWheel,
  type SectionPointer,
} from "../../app/section-view";
import { groundLevelLabel, groundLineToProfile, type GroundLevelReading } from "../../app/section-3d";
import {
  canRedo,
  canUndo,
  interpolateZ,
  sectionToScreen,
  type ProfileLine,
  type ProfilePoint,
  type SectionView,
} from "../../app/section-math";
import { drawSection } from "../../renderer/section-2d";
import { convertLength, lengthUnitsFor, unitSymbol, UNKNOWN_UNIT_NOTE } from "../../state/units";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "../common/glass";

// G2-3: the 2D cross-section panel (bottom right; full width at the bottom on narrow screens).
// It only shows the state in `viewer.sectionView` and passes the mouse / touch / wheel input to the functions of
// src/app/section-view.ts. The drawing is src/renderer/section-2d.ts.
// G2-5: left-drag (mouse) or one-finger trace (touch) edits the section line; the three buttons undo, redo and go back
// to the computed line. The path being traced is drawn by `SectionMarks`.

/** Small text buttons of the panel header, in the tertiary grey (no ✕ icon: UI rule). */
const TEXT_BUTTON_CLASS = "min-h-9 rounded bg-tertiary px-3 text-xs text-on-tertiary hover:opacity-90";

function toSectionPointer(e: ReactPointerEvent<HTMLElement>): SectionPointer {
  const rect = e.currentTarget.getBoundingClientRect();
  return {
    pointerId: e.pointerId,
    pointerType: e.pointerType,
    button: e.button,
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
    timeMs: e.timeStamp,
  };
}

export function SectionPanel({ viewer, glassEnabled }: { viewer: CopcViewerState; glassEnabled: boolean }) {
  const narrow = useNarrowViewport();
  const [display] = useDisplayUnit();
  const areaRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctx = viewer.sectionContext;
  const state = viewer.sectionView;
  const layer = state.openLayerId === null ? undefined : viewer.layers.find((l) => l.id === state.openLayerId);

  // Tell the app the size of the drawing area, now and whenever it changes.
  const open = layer !== undefined;
  useEffect(() => {
    const area = areaRef.current;
    if (!open || !area) return;
    const report = () => setSectionPanelSize(ctx, { width: area.clientWidth, height: area.clientHeight });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(area);
    return () => observer.disconnect();
  }, [open, ctx]);

  // The wheel needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const area = areaRef.current;
    if (!open || !area) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = area.getBoundingClientRect();
      zoomSectionWheel(ctx, { x: e.clientX - rect.left, y: e.clientY - rect.top }, e.deltaY, e.deltaMode);
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel);
  }, [open, ctx]);

  // Units of the axis labels: the file's unit shown as m / ft like the measurements.
  const units = lengthUnitsFor(layer?.info.crs, display);
  const horizontalUnitScale = convertLength(1, units.horizontalToMeter, display);
  const verticalUnitScale = convertLength(1, units.verticalToMeter, display);
  const unitKnown = horizontalUnitScale !== null && verticalUnitScale !== null;
  const unitLabel = unitKnown ? unitSymbol(display) : UNKNOWN_UNIT_NOTE;

  // Draw again whenever anything that changes the picture changes.
  const { points, panelSize } = state;
  const drawView = effectiveSectionView(state);
  const { scale, offsetX, offsetY } = drawView;
  // G2-4: the ground line of the layer (absent until computed, and when computing failed).
  const groundLine = layer?.section?.line?.history.present.points ?? null;
  const groundProfile = (groundLine ? groundLineToProfile(groundLine) : null);
  const lineState = layer?.section?.line;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!open || !canvas || panelSize.width === 0 || panelSize.height === 0) return;
    const result = drawSection(canvas, panelSize.width, panelSize.height, points, { scale, offsetX, offsetY }, {
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      horizontalUnitScale: horizontalUnitScale ?? 1,
      verticalUnitScale: verticalUnitScale ?? 1,
      unitLabel,
      line: groundLine,
    });
    // The last draw time, for measuring on a real screen (read it from the DOM; see TaskSheets/G2-T8-section-panel.md).
    canvas.dataset.drawMs = result.totalMs.toFixed(1);
    canvas.dataset.fillMs = result.fillMs.toFixed(1);
    canvas.dataset.lineSamples = String((groundLine?.length ?? 0) / 2);
  }, [open, points, panelSize, scale, offsetX, offsetY, horizontalUnitScale, verticalUnitScale, unitLabel, groundLine]);

  if (!layer) return null;

  // Narrow: sit above the layer drawer's toggle button (bottom-16, 44 px tall, so its top is at 6.75rem) and below the
  // drawer itself (z-10), so both stay usable. The wide panel has no such neighbour.
  // Enlarged: centred and large on any screen, above the drawer (z-10), its toggle and the toolbars, below the progress
  // overlay (z-30) and the dialogs (z-40, z-50).
  const placement = state.enlarged
    ? "left-1/2 top-1/2 z-[25] h-[85%] w-[90%] -translate-x-1/2 -translate-y-1/2 rounded-xl"
    : narrow
      ? "inset-x-2 bottom-28 z-[5] h-[38vh] rounded-xl"
      : "bottom-14 right-3 z-20 h-[340px] w-[min(640px,calc(100%-1.5rem))] rounded-xl";
  return (
    <div
      data-testid="section-panel"
      className={`absolute flex flex-col overflow-hidden ${placement} ${glassSurfaceClass(glassEnabled)} shadow-xl`}
    >
      <div className="flex items-center gap-2 px-3 py-1.5">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title={layer.name}>
          {layer.name}
        </h2>
        {lineState && (
          <>
            <button
              type="button"
              onClick={() => undoSectionLine(ctx)}
              disabled={!canUndo(lineState.history)}
              className={`${TEXT_BUTTON_CLASS} disabled:opacity-40`}
              data-testid="section-undo"
            >
              元に戻す
            </button>
            <button
              type="button"
              onClick={() => redoSectionLine(ctx)}
              disabled={!canRedo(lineState.history)}
              className={`${TEXT_BUTTON_CLASS} disabled:opacity-40`}
              data-testid="section-redo"
            >
              やり直す
            </button>
            <button
              type="button"
              onClick={() => resetSectionLineToComputed(ctx)}
              disabled={lineState.history.present === lineState.original}
              className={`${TEXT_BUTTON_CLASS} disabled:opacity-40`}
              data-testid="section-reset-line"
            >
              計算した線に戻す
            </button>
          </>
        )}
        <button type="button" onClick={() => resetSectionView(ctx)} className={TEXT_BUTTON_CLASS}>
          全体を表示
        </button>
        <button type="button" onClick={() => toggleSectionEnlarged(ctx)} className={TEXT_BUTTON_CLASS} data-testid="section-panel-enlarge">
          {state.enlarged ? "縮小" : "拡大"}
        </button>
      </div>
      <div
        ref={areaRef}
        className="relative min-h-0 flex-1 touch-none select-none"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          sectionPointerDown(ctx, toSectionPointer(e));
        }}
        onPointerMove={(e) => sectionPointerMove(ctx, toSectionPointer(e))}
        onPointerUp={(e) => sectionPointerUp(ctx, toSectionPointer(e))}
        onPointerCancel={(e) => sectionPointerCancel(ctx, toSectionPointer(e))}
        onPointerLeave={() => sectionPointerLeave(ctx)}
        onContextMenu={(e) => e.preventDefault()}
      >
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" data-testid="section-canvas" />
        {groundProfile && (
          <SectionMarks
            width={panelSize.width}
            height={panelSize.height}
            view={drawView}
            line={groundProfile}
            cursorS={state.cursorS}
            reading={state.groundLevel}
            trace={state.trace}
            label={state.groundLevel ? groundLevelLabel(state.groundLevel, units) : null}
          />
        )}
        {groundProfile && (
          <p className="absolute left-2 top-1 text-[11px] opacity-70" data-testid="section-gl-hint">
            左ドラッグ（1本指）でなぞって線を直す／右クリック（長押し）で GL と傾斜角
          </p>
        )}
        {state.loading && <p className="absolute left-3 top-2 text-xs opacity-70">断面の点を読み込み中…</p>}
        {!state.loading && points.count === 0 && <p className="absolute left-3 top-2 text-xs opacity-70">断面に点がありません</p>}
        {points.thinned && (
          <p className="absolute bottom-5 right-2 rounded bg-black/30 px-1.5 text-[11px] text-white">
            点が多いので間引いて表示（{points.count.toLocaleString("en-US")} 点）
          </p>
        )}
      </div>
    </div>
  );
}

/** Line height (px) of the two-line GL / slope label. */
const LABEL_LINE_HEIGHT = 15;

/** G2-6 / G2-8: the mouse cursor's `s` (a thin line and a dot on the ground line) and the GL / slope reading, as SVG over the canvas. */
function SectionMarks({
  width,
  height,
  view,
  line,
  cursorS,
  reading,
  trace,
  label,
}: {
  width: number;
  height: number;
  view: SectionView;
  line: ProfileLine;
  cursorS: number | null;
  reading: GroundLevelReading | null;
  trace: ProfilePoint[] | null;
  label: [string, string] | null;
}) {
  const cursorZ = cursorS === null ? null : interpolateZ(line, cursorS);
  const cursor = cursorS !== null && cursorZ !== null ? sectionToScreen(view, cursorS, cursorZ) : null;
  const gl = reading ? sectionToScreen(view, reading.s, reading.z) : null;
  // Keep the text inside the panel: right-align it when the marker is near the right edge.
  const alignEnd = gl !== null && gl.x > width - 230;
  const labelX = gl === null ? 0 : alignEnd ? gl.x - 9 : gl.x + 9;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" width={width} height={height}>
      {trace && trace.length >= 2 && (
        <polyline
          data-testid="section-trace"
          points={trace.map((p) => {
            const q = sectionToScreen(view, p.s, p.z);
            return `${q.x},${q.y}`;
          }).join(" ")}
          fill="none"
          stroke="#facc15"
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
      {cursor && (
        <g data-testid="section-cursor-mark">
          <line x1={cursor.x} x2={cursor.x} y1={0} y2={height} style={{ stroke: "var(--secondary)" }} strokeWidth={1} strokeDasharray="4 4" opacity={0.6} />
          <circle cx={cursor.x} cy={cursor.y} r={4} style={{ stroke: "var(--secondary)" }} fill="#fff" strokeWidth={2} />
        </g>
      )}
      {gl && label && (
        <g data-testid="section-gl-mark">
          <circle cx={gl.x} cy={gl.y} r={5} fill="#facc15" stroke="#000" strokeWidth={1.5} />
          <text
            x={labelX}
            // Two lines (GL, then slope): the second line ends just above the marker.
            y={Math.max(14, gl.y - 9 - LABEL_LINE_HEIGHT)}
            textAnchor={alignEnd ? "end" : "start"}
            fontSize={12}
            fontWeight={600}
            fill="#fff"
            stroke="#000"
            strokeWidth={3}
            strokeLinejoin="round"
            paintOrder="stroke"
            data-testid="section-gl-label"
          >
            <tspan x={labelX}>{label[0]}</tspan>
            <tspan x={labelX} dy={LABEL_LINE_HEIGHT}>
              {label[1]}
            </tspan>
          </text>
        </g>
      )}
    </svg>
  );
}
