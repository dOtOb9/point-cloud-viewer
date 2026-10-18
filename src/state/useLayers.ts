// Layer list and selection: the list (`layers.ts` pure functions do the list edits), the primary
// selection plus the Ctrl/Shift extra selection (`layer-selection.ts`), and the per-layer actions that
// also tell the renderer (visible, coloring, point shape/size, focus, remove) and add measurement layers.
// Rule: the list is held twice, as React state (to re-render) and as a ref (so callbacks read the latest);
// only `commitLayers` writes them. The renderer / DataSource side is updated by the caller (the actions below,
// `addOpenedLayer` in src/app/open-files.ts).
// Used by: useCopcViewer.ts; useCopcViewer.ts (for openFiles) and usePointCloudTools.ts use `layersStateRef`, `commitLayers`, `nextLayerId`.
// Entry: `useLayers({ rendererRef, sourceRef, setStatus, reportError })`.
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
  /**
   * Open layers, in the order they were added. Opening always appends (never replaces).
   * Name, point-cloud info, point count, coloring, visibility, conversion breakdown and download link are per layer.
   */
  layers: ViewerLayer[];
  /** Id of the selected layer, or null if there is none. A newly added layer becomes the selection. */
  selectedLayerId: string | null;
  /** The selected entry of `layers` (null if none). Layer info, the coloring dialog and the CRS display read it. */
  selectedLayer: ViewerLayer | null;
  /** Ids selected together (Ctrl/Shift click), including the primary one. The action buttons act on `selectedLayerId`, the last chosen. */
  selectedLayerIds: string[];
  /** Ids selected by Ctrl/Shift click besides the primary (usePointCloudTools reads this for "merge"). */
  extraSelectedIds: string[];
  /** Latest list, for callbacks. Read only; write through `commitLayers`. */
  layersStateRef: RefObject<LayersState>;
  commitLayers: (next: LayersState) => void;
  /** A new layer id ("layer-N"). N never repeats, even after a layer is removed (avoids key clashes in the renderer). */
  nextLayerId: () => string;
  selectLayer: (id: string) => void;
  /** Ctrl/Cmd click: add the layer to the selection, or remove it. */
  toggleLayerSelection: (id: string) => void;
  /** Shift click: select the rows between `selectedLayerId` and this one. */
  selectLayerRange: (id: string) => void;
  setLayerVisible: (id: string, visible: boolean) => void;
  /** Change the coloring of the layer. Choosing "rgb" on a layer without RGB falls back to elevation. */
  setLayerColorMode: (id: string, mode: ColorMode) => void;
  /** Point shape (round / square) of the layer. */
  setLayerPointShape: (id: string, shape: PointShape) => void;
  /** Point size of the layer in px (diameter, rounded into 1 to 32). */
  setLayerPointSize: (id: string, px: number) => void;
  /** Move the camera to the layer (immediately when animation is off). */
  focusLayer: (id: string, orientation?: { yaw: number; pitch: number }) => void;
  /** Remove the layer: take it out of the renderer and close its DataSource file. */
  removeLayer: (id: string) => void;
  /** Add a finished measurement as a new "measurement" layer (it becomes the selection). */
  addMeasurement: (measurement: Measurement) => void;
}

export function useLayers({ rendererRef, sourceRef, setStatus, reportError }: LayersDeps): Layers {
  const [layersState, setLayersState] = useState<LayersState>(EMPTY_LAYERS);
  const layersStateRef = useRef<LayersState>(EMPTY_LAYERS);
  const commitLayers = useCallback((next: LayersState) => {
    layersStateRef.current = next;
    setLayersState(next);
  }, []);
  // L2-F: ids selected with Ctrl/Shift click (see layer-selection.ts; trusted only while it contains the primary).
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
      // The primary stays the anchor, unless nothing was selected yet.
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
      // A layer without RGB falls back to elevation when "rgb" is asked (acceptance condition). The coloring
      // dialog already disables "rgb" for such layers, so this is a second safety (see colormap.ts).
      const resolved = resolveLayerColorMode(current.layers, id, mode);
      const target = findLayer(current.layers, id);
      if (resolved === null || !target || isMeasureLayer(target)) return; // measurement layers have no coloring
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
        // A measurement layer is not in the renderer: move to the box around its points (L2-F).
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
      // Order: take it out of the renderer (frees GPU buffers) -> remove from the list -> close the DataSource file.
      rendererRef.current?.removeLayer(id);
      if (layer.download) URL.revokeObjectURL(layer.download.url);
      const next = removeLayerFromState(current, id);
      commitLayers(next);
      if (next.layers.length === 0) {
        setStatus((prev) => (prev.kind === "ready" ? { kind: "idle" } : prev));
      }
      // Measurement layers have no DataSource file.
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
      // Source point-cloud layer (ADR-0018: made from the chosen layer): the selection if it is a point cloud,
      // otherwise the first point-cloud layer. Used only to inherit the coordinate system (unit).
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
