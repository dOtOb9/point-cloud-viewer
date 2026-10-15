import { useEffect, useState, type RefObject } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import type { MeasureToolState } from "../../state/useMeasureTool";
import { isMeasureLayer } from "../../state/layers";
import { measurementLabelLines, type Measurement } from "../../state/measure";
import { labelShifts } from "../../renderer/screen-project";
import { lengthUnitsFor } from "../../state/units";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { labelAnchorOnScreen, MeasurementShape, sameFrame, type Frame } from "./MeasurementShape";

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
