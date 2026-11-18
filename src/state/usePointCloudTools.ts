import { useState, type RefObject } from "react";
import type { PointCloudToolsContext, ToolProgressState } from "../app/point-cloud-tools";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { LayersState } from "./layers";

export type PointCloudToolsInputs = Pick<
  PointCloudToolsContext,
  "extraSelectedIds" | "tempDir" | "isMobile" | "addOpenedLayer" | "focusLayer" | "setLayerVisible" | "setStatus" | "reportError" | "toolLock" | "setSectionLine" | "setLayerDtm" | "setLayerColorMode"
> & {
  rendererRef: RefObject<PointCloudRenderer | null>;
  sourceRef: RefObject<DataSource | null>;
  layersStateRef: RefObject<LayersState>;
};

export interface PointCloudTools {
  toolProgress: ToolProgressState | null;
  toolContext: PointCloudToolsContext;
}

export function usePointCloudTools(inputs: PointCloudToolsInputs): PointCloudTools {
  const [toolProgress, setToolProgress] = useState<ToolProgressState | null>(null);
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
    setSectionLine: inputs.setSectionLine,
    setLayerDtm: inputs.setLayerDtm,
    setLayerColorMode: inputs.setLayerColorMode,
  };
  return { toolProgress, toolContext };
}
