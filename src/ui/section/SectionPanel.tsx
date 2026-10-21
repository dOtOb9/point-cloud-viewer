import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import {
  closeSectionPanel,
  effectiveSectionView,
  resetSectionView,
  sectionPointerCancel,
  sectionPointerLeave,
  sectionPointerDown,
  sectionPointerMove,
  sectionPointerUp,
  setSectionPanelSize,
  zoomSectionWheel,
  type SectionPointer,
} from "../../app/section-view";
import { groundLevelLabel, groundLineToProfile, type GroundLevelReading } from "../../app/section-3d";
import { interpolateZ, sectionToScreen, type ProfileLine, type SectionView } from "../../app/section-math";
import { drawSection } from "../../renderer/section-2d";
import { convertLength, lengthUnitsFor, unitSymbol, UNKNOWN_UNIT_NOTE } from "../../state/units";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { useNarrowViewport } from "../../state/useNarrowViewport";
import { glassSurfaceClass } from "../common/glass";

// G2-3: the 2D cross-section panel (bottom right; full width at the bottom on narrow screens).
// It only shows the state in `viewer.sectionView` and passes the mouse / touch / wheel input to the functions of
// src/app/section-view.ts. The drawing is src/renderer/section-2d.ts.
// Not here yet: editing the section line (G2-5), the ground level and slope (G2-6).

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
  const groundLine = layer?.section?.line?.current.points ?? null;
  const groundProfile = (groundLine ? groundLineToProfile(groundLine) : null);
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
  const placement = narrow
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
        <button type="button" onClick={() => resetSectionView(ctx)} className={TEXT_BUTTON_CLASS}>
          全体表示
        </button>
        <button type="button" onClick={() => closeSectionPanel(ctx)} className={TEXT_BUTTON_CLASS} data-testid="section-panel-close">
          閉じる
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
            label={state.groundLevel ? groundLevelLabel(state.groundLevel, units) : null}
          />
        )}
        {groundProfile && (
          <p className="absolute left-2 top-1 text-[11px] opacity-70" data-testid="section-gl-hint">
            右クリック（長押し）で GL と傾斜角
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

/** G2-6 / G2-8: the mouse cursor's `s` (a thin line and a dot on the ground line) and the GL / slope reading, as SVG over the canvas. */
function SectionMarks({
  width,
  height,
  view,
  line,
  cursorS,
  reading,
  label,
}: {
  width: number;
  height: number;
  view: SectionView;
  line: ProfileLine;
  cursorS: number | null;
  reading: GroundLevelReading | null;
  label: string | null;
}) {
  const cursorZ = cursorS === null ? null : interpolateZ(line, cursorS);
  const cursor = cursorS !== null && cursorZ !== null ? sectionToScreen(view, cursorS, cursorZ) : null;
  const gl = reading ? sectionToScreen(view, reading.s, reading.z) : null;
  // Keep the text inside the panel: right-align it when the marker is near the right edge.
  const alignEnd = gl !== null && gl.x > width - 230;
  return (
    <svg className="pointer-events-none absolute inset-0 h-full w-full" width={width} height={height}>
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
            x={alignEnd ? gl.x - 9 : gl.x + 9}
            y={Math.max(14, gl.y - 9)}
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
            {label}
          </text>
        </g>
      )}
    </svg>
  );
}
