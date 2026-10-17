// Opening files: `openFile` (one path or File), `openFiles` (several LAS/LAZ merged into one COPC), and
// `addOpenedLayer` (open a COPC with the DataSource and add it to the renderer and the layer list).
// Flow: both go through `source.prepareToOpen` (the DataSource decides: a COPC is ready at once; a raw
// LAS/LAZ/PCD/PLY/E57 is converted, useConversionSession.ts owns the progress and the "done" event); when the
// conversion finishes, the event calls `openFile(output, true)` again.
// Used by: useCopcViewer.ts (exposes openFile/openFiles); usePointCloudTools.ts uses `addOpenedLayer` for tool results.
// Entry: `useFileOpen(deps)`. Errors are put in `setStatus({ kind: "error", message })` (and the banner when long).
import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { reportToBackendConsole } from "../datasource/tauri";
import { multiDisplayNameFor } from "../datasource/opfs";
import { detectSourceFormatByName } from "../datasource/source-format";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { DEFAULT_POINT_SIZE_PX } from "../renderer/layer-focus";
import { addLayerToState, initialColorModeFor, type LayersState } from "./layers";
import { basenameOfPath } from "./open-file-text";
import type { ConversionSession } from "./useConversionSession";
import type { DisplaySettings } from "./useDisplaySettings";
import type { ViewerStatus } from "./viewer-status";

export interface FileOpenDeps {
  rendererRef: RefObject<PointCloudRenderer | null>;
  sourceRef: RefObject<DataSource | null>;
  setStatus: Dispatch<SetStateAction<ViewerStatus>>;
  reportError: (message: string, source?: GpuErrorSource) => void;
  conversion: ConversionSession;
  /** Only `deviceProfileDefaults` is used (isMobile and the point shape of a new layer). */
  display: Pick<DisplaySettings, "deviceProfileDefaults">;
  layersStateRef: RefObject<LayersState>;
  commitLayers: (next: LayersState) => void;
  nextLayerId: () => string;
  tempDir: string | null;
  refreshOpfsStorageInfo: () => Promise<void>;
}

export interface FileOpen {
  /**
   * Open one file (same path as `openFiles([item])`). Desktop: a path string. Web: a `File` from a drop or the file
   * picker, or a string that is an OPFS key (only from the conversion continuation, `isConversionContinuation`).
   */
  openFile: (pathOrFile: string | File, isConversionContinuation?: boolean) => Promise<void>;
  /**
   * Open the chosen files: `DataSource.prepareToOpen` makes them ready (one COPC opens as it is; anything else is
   * converted; several LAS/LAZ are merged into one COPC), then the layer is added, or the conversion runs and the
   * "done" event continues. If PLY/PCD/E57 are mixed into several files, a clear error is shown before any
   * conversion is tried (a mix of LAS/LAZ only is fine).
   */
  openFiles: (pathsOrFiles: string[] | File[]) => Promise<void>;
  addOpenedLayer: (
    path: string,
    fallbackName: string,
    isConversionContinuation: boolean,
  ) => Promise<{ layerId: string; pointCount: number; nodeCount: number }>;
}

export function useFileOpen({
  rendererRef,
  sourceRef,
  setStatus,
  reportError,
  conversion,
  display,
  layersStateRef,
  commitLayers,
  nextLayerId,
  tempDir,
  refreshOpfsStorageInfo,
}: FileOpenDeps): FileOpen {
  const { openFileRef, takePendingConversion, rememberConvertingSource, clearConversionProgress } = conversion;
  const { deviceProfileDefaults } = display;

  /**
   * An open failed: show `summary` in the panel (status) and keep `details` in the error log, so the text is
   * still in the banner / history after the panel text goes away (the panel is cleared when a later tool succeeds).
   * Most failures have one text for both (`details` defaults to `summary`).
   */
  const failOpen = useCallback(
    (summary: string, details: string = summary) => {
      reportError(details, "conversion");
      setStatus({ kind: "error", message: summary });
    },
    [reportError, setStatus],
  );

  /**
   * Open `path` with the DataSource and add it to the renderer and the list as a new layer (the new layer
   * becomes the selection). Shared by `openFile` and by the tool results (L2-F). Returns the layer id.
   * `isConversionContinuation`: attach the pending conversion result (name, breakdown, download) to this layer.
   */
  const addOpenedLayer = useCallback(
    async (path: string, fallbackName: string, isConversionContinuation: boolean) => {
      const renderer = rendererRef.current;
      const source = sourceRef.current;
      if (!renderer || !source) throw new Error("ビューアが初期化されていません");
      const opened = await source.open(path);
      // L1-D: what is opened is always added as a new layer (never replaces one).
      // Initial coloring is "rgb" if the file has RGB, otherwise elevation (colormap.ts `resolveColorMode`).
      // The renderer does not know `resolveColorMode`; it uses the value as given.
      // The renderer does not know cloudId: each layer gets a readNode that closes over its own cloudId.
      // The elevation range is CloudInfo.min/max (real data range), not the node bounds (which are cubes).
      const layerId = nextLayerId();
      const colorMode = initialColorModeFor(opened.info);
      // Only when continuing from a conversion, attach the pending breakdown and download to this layer.
      const pending = isConversionContinuation ? takePendingConversion() : null;
      renderer.addLayer(layerId, {
        hierarchy: opened.nodes,
        readNode: (key) => source.readNode(opened.cloudId, key),
        boundsMin: opened.info.min,
        boundsMax: opened.info.max,
        colorMode,
        visible: true,
        pointShape: deviceProfileDefaults.pointShape,
        pointSizePx: DEFAULT_POINT_SIZE_PX,
      });
      commitLayers(
        addLayerToState(layersStateRef.current, {
          id: layerId,
          name: pending?.name ?? fallbackName,
          info: opened.info,
          nodeCount: opened.nodes.length,
          visible: true,
          colorMode,
          pointShape: deviceProfileDefaults.pointShape,
          pointSize: DEFAULT_POINT_SIZE_PX,
          cloudId: opened.cloudId,
          sourcePath: path,
          conversionBreakdownText: pending?.breakdownText ?? null,
          download: pending?.download ?? null,
        }),
      );
      // A CRS read failure does not stop the file from opening (ADR-0015). The text goes to the error log.
      if (opened.info.crs.error) {
        reportError(`座標系(CRS)を読み取れませんでした: ${opened.info.crs.error}`, "crs");
      }
      return { layerId, pointCount: opened.info.pointCount, nodeCount: opened.nodes.length };
    },
    [rendererRef, sourceRef, nextLayerId, takePendingConversion, commitLayers, layersStateRef, reportError, deviceProfileDefaults.pointShape],
  );

  /**
   * The one path for every open: `openFile` and `openFiles` both end up here.
   * 1. Several items must all be LAS/LAZ (checked here, before anything is converted).
   * 2. `source.prepareToOpen` makes the item(s) ready: a COPC opens as it is, anything else is converted.
   *    What differs between the Web and the desktop build lives in the DataSource, not here.
   * 3. `ready` -> add the layer; `converting` -> wait for the "done" event; `failed` -> show the texts.
   */
  const openItems = useCallback(
    async (items: string[] | File[], isConversionContinuation: boolean) => {
      if (items.length === 0) return;
      const renderer = rendererRef.current;
      const source = sourceRef.current;
      if (!renderer || !source) return;

      setStatus({ kind: "opening" });
      clearConversionProgress();

      const names = items.map((item) => (typeof item === "string" ? basenameOfPath(item) : item.name));

      // LAS/LAZ may be mixed; if PLY/PCD/E57 is among several files, say so before converting (naming the files).
      if (items.length > 1) {
        const nonLasNames = names.filter((n) => detectSourceFormatByName(n) !== "lasLaz");
        if (nonLasNames.length > 0) {
          failOpen(`複数ファイルの選択はLAS/LAZのみ対応しています。次のファイルは対象外です: ${nonLasNames.join("、")}`);
          return;
        }
      }

      // M4-12: remember the source name before converting; the "done" handler (useConversionSession.ts) reads it.
      // Several files: sorted, so the name does not depend on the selection order (e.g. "09LD2626 ほか54ファイル").
      const displayName = items.length > 1 ? multiDisplayNameFor([...names].sort()) : names[0];
      rememberConvertingSource(displayName);

      try {
        const outcome = await source.prepareToOpen(items, { tempDir, isMobile: deviceProfileDefaults.isMobile });
        if (outcome.kind === "failed") {
          failOpen(outcome.summary, outcome.details);
          // Reflect the current usage before the settings page (delete / allow persistence) is shown.
          // (Does nothing on the desktop build: useOpfsStorage.ts.)
          void refreshOpfsStorageInfo();
          return;
        }
        if (outcome.kind === "converting") {
          // The "done" event handler (useConversionSession.ts) continues and opens the result.
          setStatus({ kind: "converting" });
          return;
        }

        // Name in the layer list: for a conversion result, the name of the pending result (taken inside
        // addOpenedLayer); otherwise the chosen file's name.
        const opened = await addOpenedLayer(outcome.path, displayName, isConversionContinuation);
        setStatus({ kind: "ready" });

        const label = typeof items[0] === "string" && items.length === 1 ? items[0] : displayName;
        const summary = `[M1] opened ${label}: points=${opened.pointCount} nodes=${opened.nodeCount}`;
        console.log(summary);
        await reportToBackendConsole(summary);
      } catch (e) {
        failOpen(String(e));
      }
    },
    [
      rendererRef,
      sourceRef,
      setStatus,
      clearConversionProgress,
      rememberConvertingSource,
      failOpen,
      tempDir,
      deviceProfileDefaults.isMobile,
      refreshOpfsStorageInfo,
      addOpenedLayer,
    ],
  );

  const openFile = useCallback(
    (pathOrFile: string | File, isConversionContinuation = false) =>
      openItems([pathOrFile] as string[] | File[], isConversionContinuation),
    [openItems],
  );

  const openFiles = useCallback(
    (pathsOrFiles: string[] | File[]) => openItems(pathsOrFiles, false),
    [openItems],
  );

  // Keep `openFileRef` at the latest `openFile` after every render, so the event handlers registered once
  // (useConversionSession.ts) always call the one that closes over the latest `tempDir`.
  useEffect(() => {
    openFileRef.current = openFile;
  });

  return { openFile, openFiles, addOpenedLayer };
}
