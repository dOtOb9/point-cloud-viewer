import { useEffect, useState, type RefObject } from "react";
import { groundLevelLabel, groundLineToProfile, groundLineToWorld, sectionAxes, sectionToWorld } from "../../app/section-3d";
import { interpolateZ } from "../../app/section-math";
import { projectPoint } from "../../renderer/screen-project";
import { lengthUnitsFor } from "../../state/units";
import type { CopcViewerState } from "../../state/useCopcViewer";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { sameFrame, type Frame } from "../tools/measure-frame";

const LINE_STYLE = { stroke: "var(--secondary)" };

export function SectionLineOverlay({
  viewer,
  canvasRef,
}: {
  viewer: CopcViewerState;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const state = viewer.sectionView;
  const layer = state.openLayerId === null ? undefined : viewer.layers.find((l) => l.id === state.openLayerId);
  const section = layer?.section;
  const pairs = section?.line?.history.present.points ?? null;
  const active = layer !== undefined && layer.visible && pairs !== null && section !== undefined;
  const [frame, setFrame] = useState<Frame | null>(null);
  const [displayUnit] = useDisplayUnit();
  const getViewSnapshot = viewer.getViewSnapshot;

  const axes = (section ? sectionAxes(section.a, section.b, section.up) : null);
  const world = (axes && pairs ? groundLineToWorld(axes, pairs) : []);
  const profile = (pairs ? groundLineToProfile(pairs) : []);

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

  if (!active || !axes || !frame || world.length < 2) return null;

  const runs: string[] = [];
  let run: string[] = [];
  for (const p of world) {
    const q = projectPoint(frame.viewProj, p, frame.width, frame.height);
    if (q) run.push(`${q.x.toFixed(1)},${q.y.toFixed(1)}`);
    else if (run.length > 0) {
      runs.push(run.join(" "));
      run = [];
    }
  }
  if (run.length > 0) runs.push(run.join(" "));

  const cursorZ = state.cursorS === null ? null : interpolateZ(profile, state.cursorS);
  const cursor =
    state.cursorS !== null && cursorZ !== null
      ? projectPoint(frame.viewProj, sectionToWorld(axes, state.cursorS, cursorZ), frame.width, frame.height)
      : null;
  const reading = state.groundLevel;
  const gl = reading ? projectPoint(frame.viewProj, sectionToWorld(axes, reading.s, reading.z), frame.width, frame.height) : null;
  const label = reading ? groundLevelLabel(reading, lengthUnitsFor(layer.info.crs, displayUnit)) : null;

  return (
    <svg
      data-testid="section-line-overlay"
      className="pointer-events-none absolute inset-0 z-10 h-full w-full"
      width={frame.width}
      height={frame.height}
    >
      {runs.map((points, i) => (
        <polyline key={i} points={points} fill="none" style={LINE_STYLE} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {cursor && <circle data-testid="section-line-cursor" cx={cursor.x} cy={cursor.y} r={5} fill="#fff" style={LINE_STYLE} strokeWidth={2.5} />}
      {gl && label && (
        <g>
          <circle cx={gl.x} cy={gl.y} r={6} fill="#facc15" stroke="#000" strokeWidth={1.5} />
          <text
            x={gl.x + 10}
            y={gl.y - 10 - 15}
            fontSize={12}
            fontWeight={600}
            fill="#fff"
            stroke="#000"
            strokeWidth={3}
            strokeLinejoin="round"
            paintOrder="stroke"
            data-testid="section-line-gl-label"
          >
            <tspan x={gl.x + 10}>{label[0]}</tspan>
            <tspan x={gl.x + 10} dy={15}>
              {label[1]}
            </tspan>
          </text>
        </g>
      )}
    </svg>
  );
}
