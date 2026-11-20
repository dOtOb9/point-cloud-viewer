import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { addOpenedLayer } from "../app/open-files";
import { followSelectedLayer } from "../app/section-view";
import { isTauriEnvironment } from "../datasource/environment";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import { useDisplaySettings } from "./useDisplaySettings";
import { addLayerToState, setLayerDtmInList, setLayerSectionLineHistoryInList, setLayerSectionLineInList } from "./layers";
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

export type { CopcViewerState } from "./viewer-types";

export function useCopcViewer(): [RefObject<HTMLCanvasElement | null>, CopcViewerState] {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PointCloudRenderer | null>(null);
  const sourceRef = useRef<DataSource | null>(null);
  const [status, setStatus] = useState<ViewerStatus>({ kind: "idle" });
  const setInitError = useCallback((message: string) => setStatus({ kind: "error", message }), []);
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
  const sectionViewHook = useSectionView({ sourceRef, layersStateRef: layers.layersStateRef, reportError: errorLog.reportError,
    setSectionLineHistory: (layerId, history) => {
      const current = layers.layersStateRef.current;
      layers.commitLayers({ ...current, layers: setLayerSectionLineHistoryInList(current.layers, layerId, history) });
    },
  });
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
    setSectionLine: (layerId, line) => {
      const current = layers.layersStateRef.current;
      layers.commitLayers({ ...current, layers: setLayerSectionLineInList(current.layers, layerId, line) });
    },
    setLayerColorMode: layers.setLayerColorMode,
    setLayerDtm: (layerId, dtm) => {
      const current = layers.layersStateRef.current;
      layers.commitLayers({ ...current, layers: setLayerDtmInList(current.layers, layerId, dtm) });
    },
    focusLayer: layers.focusLayer,
    setLayerVisible: layers.setLayerVisible,
    setStatus,
    reportError: errorLog.reportError,
  });

  const { reportError } = errorLog;
  const pickPoint = useCallback(
    async (cssX: number, cssY: number) => {
      try {
        return (await rendererRef.current?.pickPoint(cssX, cssY)) ?? null;
      } catch (e) {
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
    sectionView: sectionViewHook.sectionView,
    sectionContext: sectionViewHook.sectionContext,
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
    scratchCleanupContext: opfs.scratchCleanupContext,
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
