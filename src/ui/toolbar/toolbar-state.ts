// Small questions the tool buttons ask about the viewer state. Kept here so that
// each button file reads the same way and the rules are written once.
import type { CopcViewerState } from "../../state/useCopcViewer";
import { toolSourceLayers } from "../../state/layer-selection";
import { isMeasureLayer, type ViewerLayer } from "../../state/layers";

/** True when there is at least one point-cloud layer (measurement layers do not count). */
export function hasPointCloud(viewer: CopcViewerState): boolean {
  return viewer.layers.some((l) => !isMeasureLayer(l));
}

/** L2-F: how many point-cloud layers are selected together (Ctrl/Shift click in the layer list). */
export function selectedPointCloudCount(viewer: CopcViewerState): number {
  return toolSourceLayers(viewer.layers, viewer.selectedLayerIds).length;
}

/** G1: the selected layer when it is a point-cloud layer (not a measurement), else null. */
export function selectedPointCloudLayer(viewer: CopcViewerState): ViewerLayer | null {
  const layer = viewer.selectedLayer;
  return layer && !isMeasureLayer(layer) ? layer : null;
}

/** A point-cloud tool is running (the tool buttons wait for it to finish). */
export function isToolRunning(viewer: CopcViewerState): boolean {
  return viewer.toolProgress !== null;
}
