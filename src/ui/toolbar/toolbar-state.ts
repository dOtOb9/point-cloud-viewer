import type { CopcViewerState } from "../../state/useCopcViewer";
import { toolSourceLayers } from "../../state/layer-selection";
import { isMeasureLayer, type ViewerLayer } from "../../state/layers";
import { hasPointCloudLayer } from "../../app/view";

export function hasPointCloud(viewer: CopcViewerState): boolean {
  return hasPointCloudLayer(viewer.layers);
}

export function selectedPointCloudCount(viewer: CopcViewerState): number {
  return toolSourceLayers(viewer.layers, viewer.selectedLayerIds).length;
}

export function selectedPointCloudLayer(viewer: CopcViewerState): ViewerLayer | null {
  const layer = viewer.selectedLayer;
  return layer && !isMeasureLayer(layer) ? layer : null;
}

export function isToolRunning(viewer: CopcViewerState): boolean {
  return viewer.toolProgress !== null;
}
