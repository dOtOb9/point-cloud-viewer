import { useEffect, useState, type RefObject } from "react";
import type { CopcViewerState } from "../state/useCopcViewer";
import type { MeasureToolState } from "../state/useMeasureTool";
import { isMeasureLayer } from "../state/layers";
import {
  labelAnchor,

  measurementLabelLines,
  measurementSegments,
  MEASURE_KIND_NAME,
  type Measurement,
} from "../state/measure";
import { labelShifts, projectPoint, projectSegment } from "../renderer/screen-project";
import { lengthUnitsFor, type LengthUnits } from "../state/units";
import { useDisplayUnit } from "../state/useDisplayUnit";
import { glassSurfaceClass } from "./common/glass";

// L2-D: an SVG laid over the 3D view that draws measurement lines, vertices and labels.
//
// Drawing choice (recorded in TaskSheets/L2-layer-tools.md, "L2-D record"):
//  - Draw with DOM SVG instead of adding a WebGPU pipeline. Labels (numbers) need the DOM
//    anyway, and drawing only the lines with WebGPU would make two systems. A measurement
//    has a few lines, so updating a few dozen elements per frame is cheap. It also avoids
//    touching the renderer (L2-B was working there).
//  - The cost: lines cannot be hidden by the point cloud (always drawn on top). For
//    measuring, not losing them matters more, so this is accepted.
//  - Every frame, 3D points are projected again with the renderer's latest viewProj (f64).
//    While the camera is still the viewProj does not change, so nothing is re-rendered.

const STROKE = "#fbbf24";
const STROKE_SELECTED = "#f97316";

interface Frame {
  viewProj: number[];
  up: readonly [number, number, number];
  width: number;
  height: number;
}

function sameFrame(a: Frame | null, b: Frame): boolean {
  if (!a || a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < 16; i++) if (a.viewProj[i] !== b.viewProj[i]) return false;
  return true;
}

function labelAnchorOnScreen(measurement: Measurement, frame: Frame) {
  return projectPoint(frame.viewProj, labelAnchor(measurement), frame.width, frame.height);
}

function Label({ lines, x, y }: { lines: string[]; x: number; y: number }) {
  return (
    <text
      x={x + 8}
      y={y - 8}
      fontSize={12}
      fontWeight={600}
      fill="#fff"
      stroke="#000"
      strokeWidth={3}
      strokeLinejoin="round"
      paintOrder="stroke"
      data-testid="measure-label"
    >
      {lines.map((line, i) => (
        <tspan key={i} x={x + 8} dy={i === 0 ? 0 : 15}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

function MeasurementShape({
  measurement,
  units,
  frame,
  selected,
  closed,
  withLabel,
  labelShiftY = 0,
}: {
  measurement: Measurement;
  units: LengthUnits;
  frame: Frame;
  selected: boolean;
  closed: boolean;
  withLabel: boolean;
  /** Move the label down by this many px so it does not sit on another measurement's label (L2-F). */
  labelShiftY?: number;
}) {
  const stroke = selected ? STROKE_SELECTED : STROKE;
  const lines = measurementSegments(measurement, closed).map((seg, i) => {
    const s = projectSegment(frame.viewProj, seg.a, seg.b, frame.width, frame.height);
    if (!s) return null;
    return (
      <line
        key={i}
        x1={s[0].x}
        y1={s[0].y}
        x2={s[1].x}
        y2={s[1].y}
        stroke={stroke}
        strokeWidth={selected ? 3 : 2}
        strokeDasharray={seg.dashed ? "6 5" : undefined}
        strokeLinecap="round"
      />
    );
  });
  const dots = measurement.points.map((p, i) => {
    const s = projectPoint(frame.viewProj, p, frame.width, frame.height);
    return s ? <circle key={i} cx={s.x} cy={s.y} r={4} fill={stroke} stroke="#000" strokeWidth={1.5} /> : null;
  });
  const anchor = withLabel ? labelAnchorOnScreen(measurement, frame) : null;
  const text = withLabel ? measurementLabelLines(measurement, units) : [];
  return (
    <g>
      {lines}
      {dots}
      {anchor && text.length > 0 && <Label lines={text} x={anchor.x} y={anchor.y + labelShiftY} />}
    </g>
  );
}

/** Guide shown while measuring: what is measured, what to do next, and how to stop. */
export function MeasureHud({ measure, glassEnabled }: { measure: MeasureToolState; glassEnabled: boolean }) {
  if (measure.mode === null) return null;
  const n = measure.points.length;
  const kindName = MEASURE_KIND_NAME[measure.mode];
  let guide: string;
  if (measure.mode === "area") {
    guide = n < 3 ? `頂点をクリック（${n}点）` : `頂点をクリック（${n}点）。ダブルクリックか Enter で閉じる`;
  } else {
    guide = n === 0 ? "1点目をクリック" : "2点目をクリック";
  }
  return (
    <div
      data-testid="measure-hud"
      className={`pointer-events-auto absolute bottom-14 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-xl ${glassSurfaceClass(glassEnabled)} px-3 py-2 text-sm shadow-xl`}
    >
      <span className="font-semibold">{kindName}を計測中</span>
      <span>{measure.notice ?? guide}</span>
      {measure.mode === "area" && (
        <button
          type="button"
          onClick={measure.finish}
          disabled={n < 3}
          className="min-h-9 rounded-md bg-primary px-3 text-on-primary disabled:opacity-40"
        >
          閉じる
        </button>
      )}
      <button
        type="button"
        onClick={measure.stop}
        title="Esc でもやめられます"
        className="min-h-9 rounded-md border border-current/30 px-3 hover:bg-black/5 dark:hover:bg-white/10"
      >
        やめる
      </button>
    </div>
  );
}

export function MeasureOverlay({
  viewer,
  measure,
  canvasRef,
}: {
  viewer: CopcViewerState;
  measure: MeasureToolState;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const measureLayers = viewer.layers.filter((l) => isMeasureLayer(l) && l.visible);
  const active = measureLayers.length > 0 || measure.mode !== null;
  const [frame, setFrame] = useState<Frame | null>(null);
  const getViewSnapshot = viewer.getViewSnapshot;
  const [displayUnit] = useDisplayUnit();

  // Only while a measurement is on screen, read viewProj every frame. Update state only when it changed.
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const snapshot = getViewSnapshot();
      const el = canvasRef.current;
      if (snapshot && el) {
        const next: Frame = { viewProj: snapshot.viewProj, up: snapshot.up, width: el.clientWidth, height: el.clientHeight };
        setFrame((prev) => (sameFrame(prev, next) ? prev : next));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active, getViewSnapshot, canvasRef]);

  if (!active || !frame) return null;

  const draft: Measurement | null = measure.mode !== null && measure.points.length > 0 ? { kind: measure.mode, points: [...measure.points], up: frame.up } : null;
  const draftUnits = lengthUnitsFor((viewer.selectedLayer ?? viewer.layers[0])?.info.crs, displayUnit);

  // Labels that would overlap on screen are moved down (L2-F).
  const shifts = labelShifts(
    measureLayers.map((l) => (l.measurement ? labelAnchorOnScreen(l.measurement, frame) : null)),
    measureLayers.map((l) => (l.measurement ? measurementLabelLines(l.measurement, lengthUnitsFor(l.info.crs, displayUnit)).length : 0)),
  );

  return (
    <svg
      data-testid="measure-overlay"
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
      width={frame.width}
      height={frame.height}
    >
      {measureLayers.map((layer, i) =>
        layer.measurement ? (
          <MeasurementShape
            key={layer.id}
            measurement={layer.measurement}
            units={lengthUnitsFor(layer.info.crs, displayUnit)}
            frame={frame}
            selected={layer.id === viewer.selectedLayerId}
            closed
            withLabel
            labelShiftY={shifts[i]}
          />
        ) : null,
      )}
      {draft && <MeasurementShape measurement={draft} units={draftUnits} frame={frame} selected={false} closed={false} withLabel={false} />}
    </svg>
  );
}
