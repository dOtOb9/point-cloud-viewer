import { useEffect, useState, type RefObject } from "react";
import type { CopcViewerState } from "../../state/useCopcViewer";
import type { MeasureToolState } from "../../state/useMeasureTool";
import { isMeasureLayer } from "../../state/layers";
import { measurementLabelLines, type Measurement } from "../../state/measure";
import { labelShifts } from "../../renderer/screen-project";
import { lengthUnitsFor } from "../../state/units";
import { useDisplayUnit } from "../../state/useDisplayUnit";
import { labelAnchorOnScreen, sameFrame, type Frame } from "./measure-frame";
import { MeasurementShape } from "./MeasurementShape";

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
