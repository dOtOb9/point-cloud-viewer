// The hook between React and the point-cloud tool functions (src/app/point-cloud-tools.ts): owns the tool progress
// state and builds the `PointCloudToolsContext` the functions are called with.
// Not to be confused with useLayerTool.ts / useMeasureTool.ts: those handle the mouse input on the 3D view
// and call `extractFromLayer` (src/app/point-cloud-tools.ts) / `addMeasurement` (useLayers.ts).
// Used by: useCopcViewer.ts. Entry: `usePointCloudTools(inputs)`.
import { useState, type RefObject } from "react";
import type { PointCloudToolsContext } from "../app/point-cloud-tools";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { LayersState } from "./layers";
import type { ToolProgressState } from "./viewer-types";

/** What the context is made of: the newest React values (refs are stable, the rest may change every render). */
export type PointCloudToolsInputs = Pick<
  PointCloudToolsContext,
  "extraSelectedIds" | "tempDir" | "isMobile" | "addOpenedLayer" | "focusLayer" | "setLayerVisible" | "setStatus" | "reportError" | "toolLock" | "setSectionLine"
> & {
  rendererRef: RefObject<PointCloudRenderer | null>;
  sourceRef: RefObject<DataSource | null>;
  layersStateRef: RefObject<LayersState>;
};

export interface PointCloudTools {
  /** Progress of the running point-cloud tool, or null. */
  toolProgress: ToolProgressState | null;
  /** Pass this to the functions of src/app/point-cloud-tools.ts. */
  toolContext: PointCloudToolsContext;
}

export function usePointCloudTools(inputs: PointCloudToolsInputs): PointCloudTools {
  const [toolProgress, setToolProgress] = useState<ToolProgressState | null>(null);
  // Rebuilt on every render, so plain values (tempDir, isMobile, extraSelectedIds) are current when a caller picks the
  // context up in an event handler. The ref getters are read when called, because the refs are filled after the first render.
  const toolContext: PointCloudToolsContext = {
    getSource: () => inputs.sourceRef.current,
    getLayersState: () => inputs.layersStateRef.current,
    getViewUp: () => inputs.rendererRef.current?.getViewSnapshot()?.up ?? [0, 0, 1],
    extraSelectedIds: inputs.extraSelectedIds,
    tempDir: inputs.tempDir,
    isMobile: inputs.isMobile,
    addOpenedLayer: inputs.addOpenedLayer,
    focusLayer: inputs.focusLayer,
    setLayerVisible: inputs.setLayerVisible,
    setStatus: inputs.setStatus,
    setToolProgress,
    reportError: inputs.reportError,
    toolLock: inputs.toolLock,
    setSectionLine: inputs.setSectionLine, // G2
  };
  return { toolProgress, toolContext };
}
