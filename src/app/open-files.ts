// Opening files, as plain functions (no class, no React): `openFiles` (one or several files; several LAS/LAZ are
// merged into one COPC), `addOpenedLayer` (open a COPC with the DataSource and add it to the renderer and the layer
// list) and `cancelConversion`. Everything they read or change comes in through `OpenFilesContext`.
// Flow: `openFiles` awaits `source.prepareToOpen` once. The DataSource decides: a COPC is ready at once; a raw
// LAS/LAZ/PCD/PLY/E57 is converted inside the call and the promise resolves when the conversion is done (or has
// failed or been cancelled). Progress goes out through `ctx.setConversionProgress`.
// Called by: the open button and the drop handler directly (F12 on `openFiles` lands here);
// usePointCloudTools.ts calls `addOpenedLayer` for tool results. The context is built by src/state/useFileOpen.ts.
// Rule: nothing in src/app/ imports React or a `use*` hook, and these are plain functions (TaskSheets/R13-open-files-as-functions.md).
// Errors are put in `setStatus({ kind: "error", message })` and the error log (`reportError`).
import { reportToBackendConsole } from "../datasource/tauri";
import { multiDisplayNameFor } from "../datasource/opfs";
import { basenameOfPath } from "../datasource/file-name";
import { formatConversionBreakdown } from "../datasource/conversion-breakdown";
import { detectSourceFormatByName } from "../datasource/source-format";
import type { ConversionProgress } from "../datasource/conversion-dto";
import type { DataSource } from "../datasource/DataSource";
import type { PointCloudRenderer } from "../renderer/point-cloud-renderer";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import type { PointShape } from "../renderer/device-profile";
import { DEFAULT_POINT_SIZE_PX } from "../renderer/layer-focus";
import { initialColorModeFor, type LayerDownload, type ViewerLayer } from "../state/layers";
import { currentDeviceMeta } from "../state/device-meta";
import type { ViewerStatus } from "../state/viewer-status";

/** What a finished conversion leaves on the layer it made (the breakdown text and the Web download link). */
export interface ConversionAttachment {
  breakdownText: string;
  download: LayerDownload | null;
}

/**
 * Everything opening a file reads or changes. Built by the bridge hook (src/state/useFileOpen.ts) on each render.
 * Plain values (`tempDir`, `isMobile`, `pointShape`) are those of the moment an open starts. The getters read refs
 * that are filled after the first render, so they are called when needed.
 */
export interface OpenFilesContext {
  getSource: () => DataSource | null;
  getRenderer: () => PointCloudRenderer | null;
  setStatus: (status: ViewerStatus) => void;
  reportError: (message: string, source?: GpuErrorSource) => void;
  /**
   * Progress of a running conversion of raw LAS/LAZ, or null. Reading reports
   * `{phase: "reading", pointsRead, totalPoints, elapsedSecs}` (an exact ratio); after that (octree build,
   * writing) it switches to `{phase: "postProcessing", elapsedSecs}` (no ratio; see `src-tauri/src/conversion.rs`).
   * Not part of the `converting` status: Web progress ("preparing") may arrive before the status turns
   * "converting", and it must not be lost (R5).
   */
  setConversionProgress: (progress: ConversionProgress | null) => void;
  /**
   * Name of the file converted last, for the conversion dialog. Not in the `converting` status: the dialog still
   * shows it after the conversion finished (status "ready"), and it is set while the status is still "opening" (R5).
   */
  setConvertingFileName: (name: string) => void;
  /** Adds the finished layer record to the layer list (React state). */
  addLayerToList: (layer: ViewerLayer) => void;
  nextLayerId: () => string;
  tempDir: string | null;
  isMobile: boolean;
  pointShape: PointShape;
  /** True while a point-cloud tool runs: its desktop progress must not show as conversion progress. */
  isToolRunning: () => boolean;
  refreshOpfsStorageInfo: () => Promise<void>;
  /**
   * Shared "an open is running" flag: one object for the app's lifetime. `openFiles` sets `busy` while it runs and
   * refuses to start while it is set. It is a plain object, not the status, because two drops can arrive before
   * React re-renders with the new status.
   */
  openLock: { busy: boolean };
}

/** Called from the cancel button while converting. */
export function cancelConversion(ctx: OpenFilesContext): void {
  ctx.getSource()?.cancelConversion();
}

/**
 * Open the chosen files (desktop: path strings; Web: `File`s from a drop or the file picker):
 * 0. If another open is running, refuse (see `ctx.openLock`); the running one keeps its status.
 * 1. Several items must all be LAS/LAZ (checked here, before anything is converted).
 * 2. `source.prepareToOpen` makes the item(s) ready and returns when that is done: a COPC opens as it is,
 *    anything else is converted first (progress and "converting" come through the callbacks).
 *    What differs between the Web and the desktop build lives in the DataSource, not here.
 * 3. `ready` -> add the layer (with the breakdown and the download if it was converted);
 *    `failed` / `cancelled` -> show the texts.
 */
export async function openFiles(ctx: OpenFilesContext, items: string[] | File[]): Promise<void> {
  if (items.length === 0) return;
  const source = ctx.getSource();
  if (!ctx.getRenderer() || !source) return;

  // On desktop a second conversion would overwrite the backend's cancel flag, so the first could no longer be cancelled.
  if (ctx.openLock.busy) {
    ctx.reportError(
      "ファイルを開いている途中・変換中は、新しいファイルを開けません。終わってからもう一度開いてください",
      "conversion",
    );
    return;
  }
  ctx.openLock.busy = true;
  try {
    await runOpen(ctx, source, items);
  } finally {
    ctx.openLock.busy = false;
  }
}

async function runOpen(ctx: OpenFilesContext, source: DataSource, items: string[] | File[]): Promise<void> {
  ctx.setStatus({ kind: "opening" });
  ctx.setConversionProgress(null);

  const names = items.map((item) => (typeof item === "string" ? basenameOfPath(item) : item.name));

  // LAS/LAZ may be mixed; if PLY/PCD/E57 is among several files, say so before converting (naming the files).
  if (items.length > 1) {
    const nonLasNames = names.filter((n) => detectSourceFormatByName(n) !== "lasLaz");
    if (nonLasNames.length > 0) {
      failOpen(ctx, `複数ファイルの選択はLAS/LAZのみ対応しています。次のファイルは対象外です: ${nonLasNames.join("、")}`);
      return;
    }
  }

  // M4-12: remember the source name for the conversion dialog and the breakdown text ("file" row).
  // Several files: sorted, so the name does not depend on the selection order (e.g. "09LD2626 ほか54ファイル").
  const displayName = items.length > 1 ? multiDisplayNameFor([...names].sort()) : names[0];
  ctx.setConvertingFileName(displayName);

  try {
    const outcome = await source.prepareToOpen(items, {
      tempDir: ctx.tempDir,
      isMobile: ctx.isMobile,
      onConverting: () => ctx.setStatus({ kind: "converting" }),
      onProgress: (progress) => {
        // A point-cloud tool also emits the desktop progress event (L2-C). Its progress goes to the tool dialog.
        if (!ctx.isToolRunning()) ctx.setConversionProgress(progress);
      },
    });
    // The conversion (if there was one) is over, whatever the outcome.
    ctx.setConversionProgress(null);

    if (outcome.kind === "failed") {
      failOpen(ctx, outcome.summary, outcome.details);
      // Reflect the current usage before the settings page (delete / allow persistence) is shown.
      // (Does nothing on the desktop build: useOpfsStorage.ts.)
      void ctx.refreshOpfsStorageInfo();
      return;
    }
    if (outcome.kind === "cancelled") {
      // Shown in the error banner too (ADR-0011/0013): without it the progress just disappears and it
      // looks as if nothing happened.
      ctx.setStatus({ kind: "idle" });
      ctx.reportError("変換をキャンセルしました", "conversion");
      return;
    }

    // Name in the layer list: the converted file's name for a conversion result, else the chosen file's name.
    const result = outcome.conversion;
    // Backend warnings (e.g. files without a CRS were let through) go to the error log, not away.
    for (const warning of result?.warnings ?? []) ctx.reportError(warning, "conversion");
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
      opened = await addOpenedLayer(ctx, outcome.path, result?.outputName ?? displayName, attachment);
    } catch (e) {
      // The layer was not made, so nothing will ever use the download URL: let it go.
      if (result?.download) URL.revokeObjectURL(result.download.url);
      throw e;
    }
    ctx.setStatus({ kind: "ready" });

    const label = typeof items[0] === "string" && items.length === 1 ? items[0] : displayName;
    const summary = `[M1] opened ${label}: points=${opened.pointCount} nodes=${opened.nodeCount}`;
    console.log(summary);
    await reportToBackendConsole(summary);
  } catch (e) {
    ctx.setConversionProgress(null);
    failOpen(ctx, String(e));
  }
}

/**
 * Open `path` with the DataSource and add it to the renderer and the list as a new layer (the new layer
 * becomes the selection). Shared by `openFiles` and by the tool results (L2-F). Returns the layer id.
 * `attachment`: the breakdown and the download to attach to this layer when it is a conversion result.
 * Tool runs call this without taking `ctx.openLock`.
 */
export async function addOpenedLayer(
  ctx: OpenFilesContext,
  path: string,
  name: string,
  attachment: ConversionAttachment | null,
): Promise<{ layerId: string; pointCount: number; nodeCount: number }> {
  const renderer = ctx.getRenderer();
  const source = ctx.getSource();
  if (!renderer || !source) throw new Error("ビューアが初期化されていません");
  const opened = await source.open(path);
  // L1-D: what is opened is always added as a new layer (never replaces one).
  // Initial coloring is "rgb" if the file has RGB, otherwise elevation (colormap.ts `resolveColorMode`).
  // The renderer does not know `resolveColorMode`; it uses the value as given.
  // The renderer does not know cloudId: each layer gets a readNode that closes over its own cloudId.
  // The elevation range is CloudInfo.min/max (real data range), not the node bounds (which are cubes).
  const layerId = ctx.nextLayerId();
  const colorMode = initialColorModeFor(opened.info);
  renderer.addLayer(layerId, {
    hierarchy: opened.nodes,
    readNode: (key) => source.readNode(opened.cloudId, key),
    boundsMin: opened.info.min,
    boundsMax: opened.info.max,
    colorMode,
    visible: true,
    pointShape: ctx.pointShape,
    pointSizePx: DEFAULT_POINT_SIZE_PX,
  });
  ctx.addLayerToList({
    id: layerId,
    name,
    info: opened.info,
    nodeCount: opened.nodes.length,
    visible: true,
    colorMode,
    pointShape: ctx.pointShape,
    pointSize: DEFAULT_POINT_SIZE_PX,
    cloudId: opened.cloudId,
    sourcePath: path,
    conversionBreakdownText: attachment?.breakdownText ?? null,
    download: attachment?.download ?? null,
  });
  // A CRS read failure does not stop the file from opening (ADR-0015). The text goes to the error log.
  if (opened.info.crs.error) {
    ctx.reportError(`座標系(CRS)を読み取れませんでした: ${opened.info.crs.error}`, "crs");
  }
  return { layerId, pointCount: opened.info.pointCount, nodeCount: opened.nodes.length };
}

/**
 * An open failed: show `summary` in the panel (status) and keep `details` in the error log, so the text is
 * still in the banner / history after the panel text goes away (the panel is cleared when a later tool succeeds).
 * Most failures have one text for both (`details` defaults to `summary`).
 */
function failOpen(ctx: OpenFilesContext, summary: string, details: string = summary): void {
  ctx.reportError(details, "conversion");
  ctx.setStatus({ kind: "error", message: summary });
}
