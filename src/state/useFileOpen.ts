// Opening files: `openFile` (one path or File), `openFiles` (several LAS/LAZ merged into one COPC), and
// `addOpenedLayer` (open a COPC with the DataSource and add it to the renderer and the layer list).
// Flow: a COPC is opened at once. A raw LAS/LAZ/PCD first goes to conversion (useConversionSession.ts owns the
// progress and the "done" event); when the conversion finishes, the event calls `openFile(output, true)` again.
// Used by: useCopcViewer.ts (exposes openFile/openFiles); usePointCloudTools.ts uses `addOpenedLayer` for tool results.
// Entry: `useFileOpen(deps)`. Errors are put in `setStatus({ kind: "error", message })` (and the banner when long).
import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { TauriSource, reportToBackendConsole, startLasConversion, startMultiLasConversion } from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import { isCopcFile } from "../datasource/copc-header";
import { describeInsufficientSpaceWeb, multiDisplayNameFor } from "../datasource/opfs";
import { NOT_YET_CONVERTIBLE_ON_WEB, detectSourceFormatByName } from "../datasource/source-format";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { DEFAULT_POINT_SIZE_PX } from "../renderer/layer-focus";
import { addLayerToState, initialColorModeFor, type LayersState } from "./layers";
import { basenameOfPath, describeInsufficientSpaceDesktop } from "./open-file-text";
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
  openFile: (pathOrFile: string | File, isConversionContinuation?: boolean) => Promise<void>;
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

  const openFile = useCallback(
    async (pathOrFile: string | File, isConversionContinuation = false) => {
      const renderer = rendererRef.current;
      const source = sourceRef.current;
      if (!renderer || !source) return;

      setStatus({ kind: "opening" });
      clearConversionProgress();
      try {
        // On the Web, a local file arrives as a `File`. `DataSource.open()` takes only strings, so it is
        // turned into a key by `WebSource.registerFile()` first (TauriSource has no way to take a File;
        // the file picker is shown only on the Web, so the source is a WebSource here).
        let path: string;
        if (typeof pathOrFile === "string") {
          path = pathOrFile;
        } else if (source instanceof WebSource) {
          // M4-6b: decide by the header, not the extension (`copc-header.ts`, same idea as Rust
          // `copc_detect.rs`). A COPC opens as it is; raw LAS/LAZ is converted in OPFS on the Web too.
          if (await isCopcFile(pathOrFile)) {
            path = source.registerFile(pathOrFile);
          } else {
            // M4-9: decide the format first, then the conversion route. (A real-device bug: every non-COPC
            // file used to go to the LAS/LAZ route, so PCD was wrongly judged "not enough space".)
            // PLY/E57 have no Web conversion yet (M4-import-and-conversion.md, M4-9/M4-6), so say so here
            // instead of running a misleading space check.
            const format = detectSourceFormatByName(pathOrFile.name);
            if (NOT_YET_CONVERTIBLE_ON_WEB.includes(format)) {
              setStatus({
                kind: "error",
                message:
                  `このファイル形式(${format.toUpperCase()})はWeb版ではまだ変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。`,
              });
              return;
            }
            // M4-12: remember the source file name; the done handler registered once at mount reads it.
            rememberConvertingSource(pathOrFile.name);
            const outcome =
              format === "pcd"
                ? await source.startPcdConversion(pathOrFile, deviceProfileDefaults.isMobile)
                : await source.startConversion(pathOrFile, deviceProfileDefaults.isMobile);
            switch (outcome.kind) {
              case "alreadyCopc":
                // startConversion never returns this (isCopcFile was checked before); kept for exhaustiveness.
                path = outcome.path;
                break;
              case "cached":
                path = outcome.outputPath;
                break;
              case "opfsUnavailable":
                setStatus({
                  kind: "error",
                  message:
                    "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でCOPC(.copc.laz)に変換してから開いてください。",
                });
                return;
              case "insufficientSpace":
                // `ConversionOutcome` is shared with the desktop build, but WebSource always returns
                // "insufficientSpaceWeb" below (see `checkInsufficientSpace` in web.ts). This branch exists
                // for exhaustiveness and should not be reached.
                setStatus({ kind: "error", message: "空き容量が足りません" });
                return;
              // M4-6: the Web build returns "insufficientSpaceWeb" (different contents from the desktop one).
              case "insufficientSpaceWeb": {
                reportError(
                  describeInsufficientSpaceWeb({
                    requiredBytes: outcome.requiredBytes,
                    quotaBytes: outcome.quotaBytes,
                    usageBytes: outcome.usageBytes,
                    persisted: outcome.persisted,
                    reclaimableBytes: outcome.reclaimableBytes,
                  }),
                  "conversion",
                );
                setStatus({ kind: "error", message: "空き容量が足りません" });
                // Reflect the current usage before the settings page (delete / allow persistence) is shown.
                void refreshOpfsStorageInfo();
                return;
              }
              case "converting":
                // The "done" event handler (useConversionSession.ts) continues and opens the result.
                setStatus({ kind: "converting" });
                return;
            }
          }
        } else {
          throw new Error("ローカルファイルの選択はWeb版でのみサポートしています");
        }

        // M4-3: the desktop build (and Android) always goes through start_las_conversion first. A COPC
        // returns `alreadyCopc` after reading only the header. A raw LAS/LAZ checks the converted cache
        // (`cached`), then free space, then starts converting (`converting`: return here; the
        // `onConversionDone` handler continues through `openFileRef`).
        if (source instanceof TauriSource) {
          // M4-12: same reason as the Web branch.
          rememberConvertingSource(basenameOfPath(path));
          const outcome = await startLasConversion(path, tempDir);
          switch (outcome.kind) {
            case "alreadyCopc":
              path = outcome.path;
              break;
            case "cached":
              path = outcome.outputPath;
              break;
            case "insufficientSpace":
              reportError(describeInsufficientSpaceDesktop(outcome.requiredBytes, outcome.availableBytes), "conversion");
              setStatus({ kind: "error", message: "空き容量が足りません" });
              return;
            case "converting":
              // The onConversionDone handler continues.
              setStatus({ kind: "converting" });
              return;
          }
        }

        // Name in the layer list: for a conversion result, the name of the pending result (taken inside
        // addOpenedLayer); for a desktop path or a Web URL, the part after the last separator; for a picked File, its name.
        const opened = await addOpenedLayer(
          path,
          typeof pathOrFile === "string" ? basenameOfPath(pathOrFile) : pathOrFile.name,
          isConversionContinuation,
        );
        setStatus({ kind: "ready" });

        const label = typeof pathOrFile === "string" ? pathOrFile : pathOrFile.name;
        const summary = `[M1] opened ${label}: points=${opened.pointCount} nodes=${opened.nodeCount}`;
        console.log(summary);
        await reportToBackendConsole(summary);
      } catch (e) {
        setStatus({ kind: "error", message: String(e) });
      }
    },
    [
      rendererRef,
      sourceRef,
      setStatus,
      clearConversionProgress,
      rememberConvertingSource,
      reportError,
      tempDir,
      addOpenedLayer,
      deviceProfileDefaults.isMobile,
      refreshOpfsStorageInfo,
    ],
  );

  /**
   * M4-14: entry for a multiple selection. Almost the same decisions as `openFile` (cache, not enough
   * space, start conversion), simpler because the target is always several LAS/LAZ (the "already COPC" check
   * and the PCD/E57 branches exist only in the single-file `openFile`).
   */
  const openFiles = useCallback(
    async (pathsOrFiles: string[] | File[]) => {
      if (pathsOrFiles.length === 0) return;
      if (pathsOrFiles.length === 1) {
        await openFileRef.current(pathsOrFiles[0]);
        return;
      }

      const renderer = rendererRef.current;
      const source = sourceRef.current;
      if (!renderer || !source) return;

      setStatus({ kind: "opening" });
      clearConversionProgress();

      const isFileArray = typeof pathsOrFiles[0] !== "string";
      const names = isFileArray
        ? (pathsOrFiles as File[]).map((f) => f.name)
        : (pathsOrFiles as string[]).map(basenameOfPath);

      // Acceptance condition: LAS/LAZ may be mixed; if PLY/PCD/E57 is among them, say so before converting
      // (naming the files).
      const nonLasNames = names.filter((n) => detectSourceFormatByName(n) !== "lasLaz");
      if (nonLasNames.length > 0) {
        setStatus({
          kind: "error",
          message:
            `複数ファイルの選択はLAS/LAZのみ対応しています。次のファイルは対象外です: ${nonLasNames.join("、")}`,
        });
        return;
      }

      // Same reason as M4-12 in `openFile`: remember the display name before converting. Sorted so the
      // name does not depend on the selection order (e.g. "09LD2626 ほか54ファイル").
      rememberConvertingSource(multiDisplayNameFor([...names].sort()));

      try {
        const outcome =
          isFileArray && source instanceof WebSource
            ? await source.startMultiConversion(pathsOrFiles as File[], deviceProfileDefaults.isMobile)
            : !isFileArray && source instanceof TauriSource
              ? await startMultiLasConversion(pathsOrFiles as string[], tempDir)
              : null;
        if (outcome === null) {
          throw new Error("複数ファイルの選択はこの環境では対応していません");
        }

        switch (outcome.kind) {
          case "cached":
            void openFileRef.current(outcome.outputPath, true);
            return;
          case "converting":
            setStatus({ kind: "converting" });
            return;
          case "opfsUnavailable":
            setStatus({
              kind: "error",
              message:
                "お使いのブラウザはOPFS(File System Access API)に対応していないため、Web版では変換できません。デスクトップ版でまとめてCOPC(.copc.laz)に変換してから開いてください。",
            });
            return;
          case "insufficientSpace":
            reportError(describeInsufficientSpaceDesktop(outcome.requiredBytes, outcome.availableBytes), "conversion");
            setStatus({ kind: "error", message: "空き容量が足りません" });
            return;
          case "insufficientSpaceWeb":
            reportError(
              describeInsufficientSpaceWeb({
                requiredBytes: outcome.requiredBytes,
                quotaBytes: outcome.quotaBytes,
                usageBytes: outcome.usageBytes,
                persisted: outcome.persisted,
                reclaimableBytes: outcome.reclaimableBytes,
              }),
              "conversion",
            );
            setStatus({ kind: "error", message: "空き容量が足りません" });
            void refreshOpfsStorageInfo();
            return;
          case "alreadyCopc":
            // The merge route never returns this (it always makes a new COPC). Kept for exhaustiveness.
            void openFileRef.current(outcome.path, true);
            return;
        }
      } catch (e) {
        setStatus({ kind: "error", message: String(e) });
      }
    },
    [
      rendererRef,
      sourceRef,
      openFileRef,
      setStatus,
      clearConversionProgress,
      rememberConvertingSource,
      reportError,
      tempDir,
      deviceProfileDefaults.isMobile,
      refreshOpfsStorageInfo,
    ],
  );

  // Keep `openFileRef` at the latest `openFile` after every render, so the event handlers registered once
  // (useConversionSession.ts) always call the one that closes over the latest `tempDir`.
  useEffect(() => {
    openFileRef.current = openFile;
  });

  return { openFile, openFiles, addOpenedLayer };
}
