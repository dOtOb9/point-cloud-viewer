import { labelAnchor, measurementLabelLines, measurementSegments, type Measurement } from "../../state/measure";
import { projectPoint, projectSegment } from "../../renderer/screen-project";
import type { LengthUnits } from "../../state/units";

// Draws one measurement (lines, vertices, label) as SVG elements inside MeasureOverlay's <svg>.
// Also holds `Frame` (the camera/canvas snapshot one frame is drawn with) and its helpers,
// because both this file and MeasureOverlay need them.

const STROKE = "#fbbf24";
const STROKE_SELECTED = "#f97316";

export interface Frame {
  viewProj: number[];
  up: readonly [number, number, number];
  width: number;
  height: number;
}

export function sameFrame(a: Frame | null, b: Frame): boolean {
  if (!a || a.width !== b.width || a.height !== b.height) return false;
  for (let i = 0; i < 16; i++) if (a.viewProj[i] !== b.viewProj[i]) return false;
  return true;
}

export function labelAnchorOnScreen(measurement: Measurement, frame: Frame) {
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

export function MeasurementShape({
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
