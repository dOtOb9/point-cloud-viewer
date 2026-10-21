// The viewer state the UI sees: `useCopcViewer()` returns [canvasRef, CopcViewerState].
// This file only assembles. Each group of fields is made by one hook, one file per concern (TaskSheets/R1-state-refactor.md):
//
//   viewer-types.ts          CopcViewerState, built with Pick from the hooks' interfaces below (types only; no field is declared twice)
//   useRendererLifecycle.ts  create / dispose the renderer and the data source (rendererRef, sourceRef)
//   useErrorLog.ts           gpuErrors, errorHistory, reportError, dismissGpuError
//   useDisplaySettings.ts    point budget, background, grid, EDL, animation, render scale, shape, center priority, stats
//   useLayers.ts             layer list, selection, per-layer actions, measurement layers
//   useFileOpen.ts           conversion progress / file name state + the OpenFilesContext for src/app/open-files.ts
//   usePointCloudTools.ts    tool progress state + the PointCloudToolsContext for src/app/point-cloud-tools.ts
//   useOpfsStorage.ts        Web storage usage and cleanup (settings page)
//   useTempDir.ts            desktop temp folder setting
//
// `status` (the ViewerStatus union, which holds the error message) stays here because almost every hook above writes it.
// The mouse tools on the 3D view (useLayerTool.ts, useMeasureTool.ts) and the unit setting (useDisplayUnit.ts)
// are separate hooks that take this state as input; they are not part of it.
// The type re-exports below exist because src/ui must reach the renderer / datasource types through state (ARCHITECTURE.md rule 3).
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { addOpenedLayer } from "../app/open-files";
import { followSelectedLayer } from "../app/section-view";
import { isTauriEnvironment } from "../datasource/environment";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import { useDisplaySettings } from "./useDisplaySettings";
import { addLayerToState, setLayerSectionLineHistoryInList, setLayerSectionLineInList } from "./layers";
import { useErrorLog } from "./useErrorLog";
import { useFileOpen } from "./useFileOpen";
import { useLayers } from "./useLayers";
import { useOpfsStorage } from "./useOpfsStorage";
import { usePointCloudTools } from "./usePointCloudTools";
import { useRendererLifecycle } from "./useRendererLifecycle";
import { useSectionView } from "./useSectionView";
import { useTempDir } from "./useTempDir";
import type { CopcViewerState } from "./viewer-types";
import type { ViewerStatus } from "./viewer-status";

export type {
  BackgroundMode,
  ColorMode,
  ConversionProgress,
  CopcViewerState,
  GpuErrorEntry,
  OpfsStorageInfo,
  PointShape,
  ToolProgressState,
  ViewerLayer,
} from "./viewer-types";

/**
 * M1-4: state of the COPC viewer. It binds src/renderer and src/datasource and shows only this hook to
 * src/ui (rule 3: the UI does not touch the renderer directly). The whole octree hierarchy is given to the
 * renderer, which selects the LOD by screen-space error.
 */
export function useCopcViewer(): [RefObject<HTMLCanvasElement | null>, CopcViewerState] {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PointCloudRenderer | null>(null);
  const sourceRef = useRef<DataSource | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ kind: "idle" });
  // A renderer init failure is shown like an open failure (R5). Stable, because an effect depends on it.
  const setInitError = useCallback((message: string) => setStatus({ kind: "error", message }), []);
  // Shared by openFiles (to ignore tool progress) and the tool functions (set it). One object for the app's lifetime.
  const [toolLock] = useState(() => ({ running: false }));

  const errorLog = useErrorLog();
  const display = useDisplaySettings(rendererRef);
  useRendererLifecycle(
    { canvasRef, rendererRef, sourceRef },
    { onStats: display.onStats, reportError: errorLog.reportError, setError: setInitError },
  );
  const layers = useLayers({ rendererRef, sourceRef, setStatus, reportError: errorLog.reportError });
  const opfs = useOpfsStorage();
  const tempDirSetting = useTempDir();
  const fileOpen = useFileOpen({
    rendererRef,
    sourceRef,
    toolLock,
    setStatus,
    reportError: errorLog.reportError,
    addLayerToList: (layer) => layers.commitLayers(addLayerToState(layers.layersStateRef.current, layer)),
    nextLayerId: layers.nextLayerId,
    tempDir: tempDirSetting.tempDir,
    isMobile: display.deviceProfileDefaults.isMobile,
    pointShape: display.deviceProfileDefaults.pointShape,
    refreshOpfsStorageInfo: opfs.refreshOpfsStorageInfo,
  });
  // M4-12: copy the breakdown text of the selected layer. Where `navigator.clipboard` is missing
  // (non-HTTPS etc.) the screen must not break, so a failure is only logged.
  const selectedBreakdownText = layers.selectedLayer?.conversionBreakdownText ?? null;
  const copyConversionBreakdownText = useCallback(async (): Promise<boolean> => {
    if (selectedBreakdownText === null) return false;
    try {
      await navigator.clipboard.writeText(selectedBreakdownText);
      return true;
    } catch (e: unknown) {
      console.error("copyConversionBreakdownText failed", e);
      return false;
    }
  }, [selectedBreakdownText]);
  // --- G2: cross-section view --- the 2D panel's state; the section tool opens it when it has made a layer.
  const sectionViewHook = useSectionView({ sourceRef, layersStateRef: layers.layersStateRef, reportError: errorLog.reportError,
    // G2-5: the edit history of a section line lives in the layers state.
    setSectionLineHistory: (layerId, history) => {
      const current = layers.layersStateRef.current;
      layers.commitLayers({ ...current, layers: setLayerSectionLineHistoryInList(current.layers, layerId, history) });
    },
  });
  // G2-T14: the section panel follows the selected layer. Only the selection is watched; the steps are in section-view.ts.
  const sectionContext = sectionViewHook.sectionContext;
  useEffect(() => {
    followSelectedLayer(sectionContext, layers.selectedLayerId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run when the selection changes, not on every render
  }, [layers.selectedLayerId]);
  const tools = usePointCloudTools({
    rendererRef,
    sourceRef,
    toolLock,
    layersStateRef: layers.layersStateRef,
    extraSelectedIds: layers.extraSelectedIds,
    tempDir: tempDirSetting.tempDir,
    isMobile: display.deviceProfileDefaults.isMobile,
    addOpenedLayer: (path, name, section) => addOpenedLayer(fileOpen.fileOpenContext, path, name, null, section),
    // --- G2: section line ---
    setSectionLine: (layerId, line) => {
      const current = layers.layersStateRef.current;
      layers.commitLayers({ ...current, layers: setLayerSectionLineInList(current.layers, layerId, line) });
    },
    focusLayer: layers.focusLayer,
    setLayerVisible: layers.setLayerVisible,
    setStatus,
    reportError: errorLog.reportError,
  });

  // L2-D measurement: picking and fetching the view pass straight through to the renderer.
  // The measurement operation itself (collecting points, finishing) is in useMeasureTool.ts; a finished one
  // is added as a layer by `layers.addMeasurement`.
  const { reportError } = errorLog;
  const pickPoint = useCallback(
    async (cssX: number, cssY: number) => {
      try {
        return (await rendererRef.current?.pickPoint(cssX, cssY)) ?? null;
      } catch (e) {
        // If reading the depth back fails, send the message as-is to the existing error display (ADR-0011). Never swallow it.
        reportError(`計測の点を取れませんでした: ${String(e)}`);
        return null;
      }
    },
    [reportError],
  );
  const getViewSnapshot = useCallback(() => rendererRef.current?.getViewSnapshot() ?? null, []);

  const state: CopcViewerState = {
    status,
    layers: layers.layers,
    selectedLayerId: layers.selectedLayerId,
    selectedLayer: layers.selectedLayer,
    selectLayer: layers.selectLayer,
    setLayerVisible: layers.setLayerVisible,
    setLayerColorMode: layers.setLayerColorMode,
    setLayerPointShape: layers.setLayerPointShape,
    setLayerPointSize: layers.setLayerPointSize,
    focusLayer: layers.focusLayer,
    selectedLayerIds: layers.selectedLayerIds,
    toggleLayerSelection: layers.toggleLayerSelection,
    selectLayerRange: layers.selectLayerRange,
    toolProgress: tools.toolProgress,
    toolContext: tools.toolContext,
    sectionView: sectionViewHook.sectionView, // G2
    sectionContext: sectionViewHook.sectionContext, // G2
    removeLayer: layers.removeLayer,
    pickPoint,
    getViewSnapshot,
    addMeasurement: layers.addMeasurement,
    pointBudget: display.pointBudget,
    autoPointBudgetEnabled: display.autoPointBudgetEnabled,
    stats: display.stats,
    backgroundMode: display.backgroundMode,
    gridEnabled: display.gridEnabled,
    edlEnabled: display.edlEnabled,
    animationEnabled: display.animationEnabled,
    renderScale: display.renderScale,
    centerPriorityStrength: display.centerPriorityStrength,
    minCenterPriorityWeight: display.minCenterPriorityWeight,
    gpuErrors: errorLog.gpuErrors,
    errorHistory: errorLog.errorHistory,
    convertingFileName: fileOpen.convertingFileName,
    isBrowser: !isTauriEnvironment(),
    reportError: errorLog.reportError,
    fileOpenContext: fileOpen.fileOpenContext,
    conversionProgress: fileOpen.conversionProgress,
    copyConversionBreakdownText,
    opfsStorageInfo: opfs.opfsStorageInfo,
    refreshOpfsStorageInfo: opfs.refreshOpfsStorageInfo,
    requestOpfsPersistentStorage: opfs.requestOpfsPersistentStorage,
    removeOpfsCachedConversion: opfs.removeOpfsCachedConversion,
    clearOpfsCachedConversions: opfs.clearOpfsCachedConversions,
    removeOpfsScratchDir: opfs.removeOpfsScratchDir,
    clearOpfsScratchDirs: opfs.clearOpfsScratchDirs,
    tempDir: tempDirSetting.tempDir,
    supportsCustomTempDir: tempDirSetting.supportsCustomTempDir,
    pickAndSetTempDir: tempDirSetting.pickAndSetTempDir,
    clearTempDir: tempDirSetting.clearTempDir,
    setPointBudget: display.setPointBudget,
    setAutoPointBudgetEnabled: display.setAutoPointBudgetEnabled,
    setBackgroundMode: display.setBackgroundMode,
    setGridEnabled: display.setGridEnabled,
    setEdlEnabled: display.setEdlEnabled,
    setAnimationEnabled: display.setAnimationEnabled,
    setRenderScale: display.setRenderScale,
    setCenterPriorityStrength: display.setCenterPriorityStrength,
    setMinCenterPriorityWeight: display.setMinCenterPriorityWeight,
    dismissGpuError: errorLog.dismissGpuError,
  };
  return [canvasRef, state];
}
