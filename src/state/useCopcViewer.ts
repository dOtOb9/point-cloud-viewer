// The viewer state the UI sees: `useCopcViewer()` returns [canvasRef, CopcViewerState].
// This file only assembles. Each group of fields is made by one hook, one file per concern (TaskSheets/R1-state-refactor.md):
//
//   viewer-types.ts          the shape of CopcViewerState (types only)
//   useRendererLifecycle.ts  create / dispose the renderer and the data source (rendererRef, sourceRef)
//   useErrorLog.ts           gpuErrors, errorHistory, reportError, dismissGpuError
//   useDisplaySettings.ts    point budget, background, grid, EDL, animation, render scale, shape, center priority, stats
//   useLayers.ts             layer list, selection, per-layer actions, measurement layers
//   useFileOpen.ts           openFile / openFiles / addOpenedLayer
//   useConversionSession.ts  conversion progress, done/failed events, cancel, breakdown copy
//   usePointCloudTools.ts    extract / cross section / merge as new layers
//   useOpfsStorage.ts        Web storage usage and cleanup (settings page)
//   useTempDir.ts            desktop temp folder setting
//
// `status` and `error` stay here because almost every hook above writes them.
// The mouse tools on the 3D view (useLayerTool.ts, useMeasureTool.ts) and the unit setting (useDisplayUnit.ts)
// are separate hooks that take this state as input; they are not part of it.
// The type re-exports below exist because src/ui must reach the renderer / datasource types through state (ARCHITECTURE.md rule 3).
import { useCallback, useRef, useState, type RefObject } from "react";
import { isTauriEnvironment } from "../datasource/environment";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import { useConversionSession } from "./useConversionSession";
import { useDisplaySettings } from "./useDisplaySettings";
import { useErrorLog } from "./useErrorLog";
import { useFileOpen } from "./useFileOpen";
import { useLayers } from "./useLayers";
import { useOpfsStorage } from "./useOpfsStorage";
import { usePointCloudTools } from "./usePointCloudTools";
import { useRendererLifecycle } from "./useRendererLifecycle";
import { useTempDir } from "./useTempDir";
import type { CopcViewerState, ViewerStatus } from "./viewer-types";

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
  ViewerStatus,
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
  const [status, setStatus] = useState<ViewerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  // Shared by useConversionSession (to ignore tool progress) and usePointCloudTools (sets it).
  const toolRunningRef = useRef(false);

  // The order of the calls matters in one place: useRendererLifecycle fills `sourceRef` in its effect, and
  // the effect of useConversionSession reads it, so lifecycle comes first (effects run in call order).
  const errorLog = useErrorLog();
  const display = useDisplaySettings(rendererRef);
  useRendererLifecycle(
    { canvasRef, rendererRef, sourceRef },
    { onStats: display.onStats, reportError: errorLog.reportError, setError },
  );
  const layers = useLayers({ rendererRef, sourceRef, setStatus, reportError: errorLog.reportError });
  const opfs = useOpfsStorage();
  const tempDirSetting = useTempDir();
  const selectedBreakdownText = layers.selectedLayer?.conversionBreakdownText ?? null;
  const conversion = useConversionSession({
    sourceRef,
    toolRunningRef,
    setStatus,
    setError,
    reportError: errorLog.reportError,
    selectedBreakdownText,
  });
  const fileOpen = useFileOpen({
    rendererRef,
    sourceRef,
    setStatus,
    setError,
    reportError: errorLog.reportError,
    conversion,
    display,
    layersStateRef: layers.layersStateRef,
    commitLayers: layers.commitLayers,
    nextLayerId: layers.nextLayerId,
    tempDir: tempDirSetting.tempDir,
    refreshOpfsStorageInfo: opfs.refreshOpfsStorageInfo,
  });
  const tools = usePointCloudTools({
    rendererRef,
    sourceRef,
    toolRunningRef,
    layersStateRef: layers.layersStateRef,
    extraSelectedIds: layers.extraSelectedIds,
    tempDir: tempDirSetting.tempDir,
    isMobile: display.deviceProfileDefaults.isMobile,
    addOpenedLayer: fileOpen.addOpenedLayer,
    focusLayer: layers.focusLayer,
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
    error,
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
    cancelTool: tools.cancelTool,
    extractFromLayer: tools.extractFromLayer,
    mergeSelectedLayers: tools.mergeSelectedLayers,
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
    pointShape: display.pointShape,
    centerPriorityStrength: display.centerPriorityStrength,
    minCenterPriorityWeight: display.minCenterPriorityWeight,
    gpuErrors: errorLog.gpuErrors,
    errorHistory: errorLog.errorHistory,
    convertingFileName: conversion.convertingFileName,
    openFile: fileOpen.openFile,
    openFiles: fileOpen.openFiles,
    isBrowser: !isTauriEnvironment(),
    conversionProgress: conversion.conversionProgress,
    cancelConversion: conversion.cancelConversion,
    copyConversionBreakdownText: conversion.copyConversionBreakdownText,
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
    resetView: layers.resetView,
    setRenderScale: display.setRenderScale,
    setPointShape: display.setPointShape,
    setCenterPriorityStrength: display.setCenterPriorityStrength,
    setMinCenterPriorityWeight: display.setMinCenterPriorityWeight,
    dismissGpuError: errorLog.dismissGpuError,
  };
  return [canvasRef, state];
}
