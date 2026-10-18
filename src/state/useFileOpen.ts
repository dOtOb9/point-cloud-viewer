// Opening files: `openFiles` (one or several files; several LAS/LAZ are merged into one COPC), and
// `addOpenedLayer` (open a COPC with the DataSource and add it to the renderer and the layer list).
// Flow: `openFiles` awaits `source.prepareToOpen` once. The DataSource decides: a COPC is ready at once; a raw
// LAS/LAZ/PCD/PLY/E57 is converted inside the call and the promise resolves when the conversion is done (or has
// failed or been cancelled). Progress comes back through callbacks; useConversionSession.ts holds it for the UI.
// Used by: useCopcViewer.ts (exposes openFiles); usePointCloudTools.ts uses `addOpenedLayer` for tool results.
// Entry: `useFileOpen(deps)`. Errors are put in `setStatus({ kind: "error", message })` and the error log.
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { reportToBackendConsole } from "../datasource/tauri";
import { multiDisplayNameFor } from "../datasource/opfs";
import { basenameOfPath } from "../datasource/file-name";
import { formatConversionBreakdown } from "../datasource/conversion-breakdown";
import { detectSourceFormatByName } from "../datasource/source-format";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { DEFAULT_POINT_SIZE_PX } from "../renderer/layer-focus";
import { addLayerToState, initialColorModeFor, type LayerDownload, type LayersState } from "./layers";
import { currentDeviceMeta, type ConversionSession } from "./useConversionSession";
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

/** What a finished conversion leaves on the layer it made (the breakdown text and the Web download link). */
export interface ConversionAttachment {
  breakdownText: string;
  download: LayerDownload | null;
}

export interface FileOpen {
  /**
   * Open the chosen files (desktop: path strings; Web: `File`s from a drop or the file picker):
   * `DataSource.prepareToOpen` makes them ready (one COPC opens as it is; anything else is converted, and this
   * waits for it; several LAS/LAZ are merged into one COPC), then the layer is added. If PLY/PCD/E57 are mixed
   * into several files, a clear error is shown before any conversion is tried (a mix of LAS/LAZ only is fine).
   */
  openFiles: (pathsOrFiles: string[] | File[]) => Promise<void>;
  /**
   * `conversion`: attach the breakdown and the download to the new layer (a layer made by a conversion), or null.
   */
  addOpenedLayer: (
    path: string,
    name: string,
    conversion: ConversionAttachment | null,
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
  const { rememberConvertingSource, reportConversionProgress, clearConversionProgress } = conversion;
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
   * `conversion`: the breakdown and the download to attach to this layer when it is a conversion result.
   */
  const addOpenedLayer = useCallback(
    async (path: string, name: string, conversion: ConversionAttachment | null) => {
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
          name,
          info: opened.info,
          nodeCount: opened.nodes.length,
          visible: true,
          colorMode,
          pointShape: deviceProfileDefaults.pointShape,
          pointSize: DEFAULT_POINT_SIZE_PX,
          cloudId: opened.cloudId,
          sourcePath: path,
          conversionBreakdownText: conversion?.breakdownText ?? null,
          download: conversion?.download ?? null,
        }),
      );
      // A CRS read failure does not stop the file from opening (ADR-0015). The text goes to the error log.
      if (opened.info.crs.error) {
        reportError(`座標系(CRS)を読み取れませんでした: ${opened.info.crs.error}`, "crs");
      }
      return { layerId, pointCount: opened.info.pointCount, nodeCount: opened.nodes.length };
    },
    [rendererRef, sourceRef, nextLayerId, commitLayers, layersStateRef, reportError, deviceProfileDefaults.pointShape],
  );

  /**
   * The one path for every open (`openFiles`).
   * 1. Several items must all be LAS/LAZ (checked here, before anything is converted).
   * 2. `source.prepareToOpen` makes the item(s) ready and returns when that is done: a COPC opens as it is,
   *    anything else is converted first (progress and "converting" come through the callbacks).
   *    What differs between the Web and the desktop build lives in the DataSource, not here.
   * 3. `ready` -> add the layer (with the breakdown and the download if it was converted);
   *    `failed` / `cancelled` -> show the texts.
   */
  const openFiles = useCallback(
    async (items: string[] | File[]) => {
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

      // M4-12: remember the source name for the conversion dialog and the breakdown text ("file" row).
      // Several files: sorted, so the name does not depend on the selection order (e.g. "09LD2626 ほか54ファイル").
      const displayName = items.length > 1 ? multiDisplayNameFor([...names].sort()) : names[0];
      rememberConvertingSource(displayName);

      try {
        const outcome = await source.prepareToOpen(items, {
          tempDir,
          isMobile: deviceProfileDefaults.isMobile,
          onConverting: () => setStatus({ kind: "converting" }),
          onProgress: reportConversionProgress,
        });
        // The conversion (if there was one) is over, whatever the outcome.
        clearConversionProgress();

        if (outcome.kind === "failed") {
          failOpen(outcome.summary, outcome.details);
          // Reflect the current usage before the settings page (delete / allow persistence) is shown.
          // (Does nothing on the desktop build: useOpfsStorage.ts.)
          void refreshOpfsStorageInfo();
          return;
        }
        if (outcome.kind === "cancelled") {
          // Shown in the error banner too (ADR-0011/0013): without it the progress just disappears and it
          // looks as if nothing happened.
          setStatus({ kind: "idle" });
          reportError("変換をキャンセルしました", "conversion");
          return;
        }

        // Name in the layer list: the converted file's name for a conversion result, else the chosen file's name.
        const result = outcome.conversion;
        // Backend warnings (e.g. files without a CRS were let through) go to the error log, not away.
        for (const warning of result?.warnings ?? []) reportError(warning, "conversion");
        const attachment: ConversionAttachment | null = result && {
          breakdownText: formatConversionBreakdown(result.stageTimings, {
            platform: result.platform,
            format: result.sourceFormat,
            fileName: displayName,
            ...currentDeviceMeta(),
          }),
          download: result.download,
        };

        let opened;
        try {
          opened = await addOpenedLayer(outcome.path, result?.outputName ?? displayName, attachment);
        } catch (e) {
          // The layer was not made, so nothing will ever use the download URL: let it go.
          if (result?.download) URL.revokeObjectURL(result.download.url);
          throw e;
        }
        setStatus({ kind: "ready" });

        const label = typeof items[0] === "string" && items.length === 1 ? items[0] : displayName;
        const summary = `[M1] opened ${label}: points=${opened.pointCount} nodes=${opened.nodeCount}`;
        console.log(summary);
        await reportToBackendConsole(summary);
      } catch (e) {
        clearConversionProgress();
        failOpen(String(e));
      }
    },
    [
      rendererRef,
      sourceRef,
      setStatus,
      clearConversionProgress,
      reportConversionProgress,
      rememberConvertingSource,
      failOpen,
      reportError,
      tempDir,
      deviceProfileDefaults.isMobile,
      refreshOpfsStorageInfo,
      addOpenedLayer,
    ],
  );

  return { openFiles, addOpenedLayer };
}
