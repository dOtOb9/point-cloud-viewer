import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import type { ColorMode } from "../renderer/colormap";
import type { PointShape } from "../renderer/device-profile";
import {
  EMPTY_LAYERS,
  addLayerToState,
  findLayer,
  isMeasureLayer,
  makeMeasureLayer,
  removeLayerFromState,
  resolveLayerColorMode,
  selectLayerInState,
  setLayerColorModeInList,
  setLayerPointShapeInList,
  setLayerPointSizeInList,
  setLayerVisibleInList,
  type LayersState,
  type ViewerLayer,
} from "./layers";
import { MEASURE_KIND_NAME, type Measurement } from "./measure";
import { effectiveSelectedIds, rangeSelectedIds, toggleSelectedId } from "./layer-selection";
import type { ViewerStatus } from "./viewer-status";

export interface LayersDeps {
  rendererRef: RefObject<PointCloudRenderer | null>;
  sourceRef: RefObject<DataSource | null>;
  setStatus: Dispatch<SetStateAction<ViewerStatus>>;
  reportError: (message: string, source?: GpuErrorSource) => void;
}

export interface Layers {
  layers: ViewerLayer[];
  selectedLayerId: string | null;
  selectedLayer: ViewerLayer | null;
  selectedLayerIds: string[];
  extraSelectedIds: string[];
  layersStateRef: RefObject<LayersState>;
  commitLayers: (next: LayersState) => void;
  nextLayerId: () => string;
  selectLayer: (id: string) => void;
  toggleLayerSelection: (id: string) => void;
  selectLayerRange: (id: string) => void;
  setLayerVisible: (id: string, visible: boolean) => void;
  setLayerColorMode: (id: string, mode: ColorMode) => void;
  setLayerPointShape: (id: string, shape: PointShape) => void;
  setLayerPointSize: (id: string, px: number) => void;
  focusLayer: (id: string, orientation?: { yaw: number; pitch: number }) => void;
  removeLayer: (id: string) => void;
  addMeasurement: (measurement: Measurement) => void;
}

export function useLayers({ rendererRef, sourceRef, setStatus, reportError }: LayersDeps): Layers {
  const [layersState, setLayersState] = useState<LayersState>(EMPTY_LAYERS);
  const layersStateRef = useRef<LayersState>(EMPTY_LAYERS);
  const commitLayers = useCallback((next: LayersState) => {
    layersStateRef.current = next;
    setLayersState(next);
  }, []);
  const [extraSelectedIds, setExtraSelectedIds] = useState<string[]>([]);
  const nextLayerNumberRef = useRef(1);
  const nextLayerId = useCallback(() => `layer-${nextLayerNumberRef.current++}`, []);
  const measureCountersRef = useRef({ distance: 0, height: 0, area: 0 });

  const selectLayer = useCallback(
    (id: string) => {
      setExtraSelectedIds([]);
      commitLayers(selectLayerInState(layersStateRef.current, id));
    },
    [commitLayers],
  );

  const selectedLayerIds = effectiveSelectedIds(layersState.layers, layersState.selectedLayerId, extraSelectedIds);

  const toggleLayerSelection = useCallback(
    (id: string) => {
      const current = layersStateRef.current;
      const next = toggleSelectedId(current.layers, current.selectedLayerId, extraSelectedIds, id);
      setExtraSelectedIds(next.ids);
      commitLayers({ ...current, selectedLayerId: next.primaryId });
    },
    [commitLayers, extraSelectedIds],
  );

  const selectLayerRange = useCallback(
    (id: string) => {
      const current = layersStateRef.current;
      setExtraSelectedIds(rangeSelectedIds(current.layers, current.selectedLayerId, id));
      commitLayers(selectLayerInState(current, current.selectedLayerId ?? id));
    },
    [commitLayers],
  );

  const setLayerVisible = useCallback(
    (id: string, visible: boolean) => {
      const current = layersStateRef.current;
      if (!findLayer(current.layers, id)) return;
      rendererRef.current?.setLayerVisible(id, visible);
      commitLayers({ ...current, layers: setLayerVisibleInList(current.layers, id, visible) });
    },
    [commitLayers, rendererRef],
  );

  const setLayerColorMode = useCallback(
    (id: string, mode: ColorMode) => {
      const current = layersStateRef.current;
      const resolved = resolveLayerColorMode(current.layers, id, mode);
      const target = findLayer(current.layers, id);
      if (resolved === null || !target || isMeasureLayer(target)) return;
      rendererRef.current?.setLayerColorMode(id, resolved);
      commitLayers({ ...current, layers: setLayerColorModeInList(current.layers, id, mode) });
    },
    [commitLayers, rendererRef],
  );

  const setLayerPointShape = useCallback(
    (id: string, shape: PointShape) => {
      const current = layersStateRef.current;
      if (!findLayer(current.layers, id)) return;
      rendererRef.current?.setLayerPointShape(id, shape);
      commitLayers({ ...current, layers: setLayerPointShapeInList(current.layers, id, shape) });
    },
    [commitLayers, rendererRef],
  );

  const setLayerPointSize = useCallback(
    (id: string, px: number) => {
      const current = layersStateRef.current;
      if (!findLayer(current.layers, id)) return;
      rendererRef.current?.setLayerPointSize(id, px);
      commitLayers({ ...current, layers: setLayerPointSizeInList(current.layers, id, px) });
    },
    [commitLayers, rendererRef],
  );

  const focusLayer = useCallback(
    (id: string, orientation?: { yaw: number; pitch: number }) => {
      const layer = findLayer(layersStateRef.current.layers, id);
      if (layer?.measurement) {
        rendererRef.current?.focusBox(layer.info.min, layer.info.max);
        return;
      }
      rendererRef.current?.focusLayer(id, orientation);
    },
    [rendererRef],
  );

  const removeLayer = useCallback(
    (id: string) => {
      const current = layersStateRef.current;
      const layer = findLayer(current.layers, id);
      if (!layer) return;
      rendererRef.current?.removeLayer(id);
      if (layer.download) URL.revokeObjectURL(layer.download.url);
      const next = removeLayerFromState(current, id);
      commitLayers(next);
      if (next.layers.length === 0) {
        setStatus((prev) => (prev.kind === "ready" ? { kind: "idle" } : prev));
      }
      if (isMeasureLayer(layer)) return;
      sourceRef.current?.close(layer.cloudId).catch((e: unknown) => {
        reportError(`ファイルを閉じられませんでした: ${String(e)}`, "node-read");
      });
    },
    [commitLayers, rendererRef, sourceRef, setStatus, reportError],
  );

  const addMeasurement = useCallback(
    (measurement: Measurement) => {
      const current = layersStateRef.current;
      const selected = findLayer(current.layers, current.selectedLayerId);
      const source = selected && !isMeasureLayer(selected) ? selected : (current.layers.find((l) => !isMeasureLayer(l)) ?? null);
      const counters = measureCountersRef.current;
      counters[measurement.kind] += 1;
      const name = `${MEASURE_KIND_NAME[measurement.kind]} ${counters[measurement.kind]}`;
      commitLayers(addLayerToState(current, makeMeasureLayer(nextLayerId(), name, measurement, source)));
    },
    [commitLayers, nextLayerId],
  );

  return {
    layers: layersState.layers,
    selectedLayerId: layersState.selectedLayerId,
    selectedLayer: findLayer(layersState.layers, layersState.selectedLayerId),
    selectedLayerIds,
    extraSelectedIds,
    layersStateRef,
    commitLayers,
    nextLayerId,
    selectLayer,
    toggleLayerSelection,
    selectLayerRange,
    setLayerVisible,
    setLayerColorMode,
    setLayerPointShape,
    setLayerPointSize,
    focusLayer,
    removeLayer,
    addMeasurement,
  };
}
