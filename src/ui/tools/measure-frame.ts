import { labelAnchor, type Measurement } from "../../state/measure";
import { projectPoint } from "../../renderer/screen-project";

// The camera/canvas snapshot that one frame of the measurement overlay is drawn with,
// and two small helpers on it. Shared by MeasureOverlay.tsx and MeasurementShape.tsx.

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
