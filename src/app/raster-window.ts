// The Rasterize window (G1-R3), as plain functions (no class, no React): `openRasterWindow`, `changeRasterSettings`,
// `exportRaster`, `closeRasterWindow`. Plan: TaskSheets/G1-raster-and-dtm.md section 13, TaskSheets/G1-T11-raster-window.md.
// The result is NOT a layer: the window draws a live preview from thinned points that Rust keeps while it is open, and
// "書き出す" reads every point once and gives a GeoTIFF (desktop: save dialog, Web: download).
// Everything the functions read or change comes in through `RasterContext`, built by src/state/useRasterWindow.ts.
// Rule: nothing in src/app/ imports React or a `use*` hook (TaskSheets/ADR-0021-thin-react.md).
import {
  chooseGeoTiffDestination,
  closeRasterPreview as tauriCloseRasterPreview,
  exportRasterGeoTiff as tauriExportRasterGeoTiff,
  openRasterPreview as tauriOpenRasterPreview,
  renderRasterPreview as tauriRenderRasterPreview,
  saveToolFile,
} from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import type { DataSource } from "../datasource/DataSource";
import {
  exportRangeOf,
  type RasterExportResult,
  type RasterPreviewImage,
  type RasterPreviewSession,
  type RasterRequest,
} from "../datasource/raster";
import { findLayer, isMeasureLayer, type ViewerLayer } from "../state/layers";
import { displayLengthToFile } from "../state/tool-math";
import { lengthUnitsFor, type DisplayUnit } from "../state/units";
import { CLOSED_RASTER_WINDOW, DEFAULT_RASTER_SETTINGS, type RasterSettings, type RasterWindowState } from "../state/raster-window";
import { cancelTool, type PointCloudToolsContext } from "./point-cloud-tools";
import { startDownload } from "./download";

export { cancelTool };

/** Everything the Rasterize window functions read or change. */
export interface RasterContext {
  tools: PointCloudToolsContext;
  /** The newest state (a ref in the hook), read after an await to drop a stale answer. */
  getState: () => RasterWindowState;
  /** Replaces the whole state. */
  setState: (next: RasterWindowState) => void;
  getDisplayUnit: () => DisplayUnit;
}

/** The cell size in the file's unit, from the text typed in the display unit. Null when the text is not a positive number. */
export function fileCellSizeOf(layer: ViewerLayer, settings: RasterSettings, display: DisplayUnit): number | null {
  const typed = Number(settings.cellSizeText);
  if (settings.cellSizeText.trim() === "" || !Number.isFinite(typed) || typed <= 0) return null;
  const units = lengthUnitsFor(layer.info.crs, display);
  return displayLengthToFile(typed, units.horizontalToMeter, display);
}

/** The request Rust takes, or null while the settings are not valid yet. */
export function rasterRequestOf(layer: ViewerLayer, settings: RasterSettings, display: DisplayUnit): RasterRequest | null {
  const cellSize = fileCellSizeOf(layer, settings, display);
  if (cellSize === null) return null;
  return { cellSize, value: settings.value, groundOnly: settings.groundOnly };
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pointCloudLayer(ctx: RasterContext, layerId: string | null): ViewerLayer | null {
  if (layerId === null) return null;
  const layer = findLayer(ctx.tools.getLayersState().layers, layerId);
  return layer && !isMeasureLayer(layer) && layer.sourcePath !== undefined ? layer : null;
}

// Desktop (Tauri command) or Web (Worker): the same three calls.
function openPreview(source: DataSource, path: string): Promise<RasterPreviewSession> {
  return source instanceof WebSource ? source.openRasterPreview(path) : tauriOpenRasterPreview(path);
}

function renderPreview(source: DataSource, sessionId: number, request: RasterRequest): Promise<RasterPreviewImage> {
  return source instanceof WebSource ? source.renderRasterPreview(sessionId, request) : tauriRenderRasterPreview(sessionId, request);
}

function closePreview(source: DataSource | null, sessionId: number): Promise<void> {
  if (source === null) return Promise.resolve();
  return source instanceof WebSource ? source.closeRasterPreview(sessionId) : tauriCloseRasterPreview(sessionId);
}

/**
 * Open the window for the point-cloud layer `layerId`: read the upper levels once (a second or two on a big cloud),
 * then draw the first preview. Failures are shown in the window and sent to the error log.
 */
export async function openRasterWindow(ctx: RasterContext, layerId: string): Promise<void> {
  const layer = pointCloudLayer(ctx, layerId);
  const source = ctx.tools.getSource();
  if (!layer || layer.sourcePath === undefined || !source) {
    ctx.tools.reportError("点群のレイヤーを選んでください", "tool");
    return;
  }
  // A layer with colour starts with its colours; one without starts with the height.
  const settings: RasterSettings = { ...DEFAULT_RASTER_SETTINGS, value: layer.info.hasColor ? "rgbMean" : "zMean" };
  ctx.setState({ ...CLOSED_RASTER_WINDOW, open: true, layerId, settings, busy: "opening" });
  let session: RasterPreviewSession;
  try {
    session = await openPreview(source, layer.sourcePath);
  } catch (e) {
    ctx.tools.reportError(message(e), "tool");
    ctx.setState({ ...ctx.getState(), busy: null, error: message(e) });
    return;
  }
  const now = ctx.getState();
  if (!now.open || now.layerId !== layerId) {
    // Closed (or reopened for another layer) while the points were being read.
    await closePreview(source, session.id);
    return;
  }
  ctx.setState({ ...now, session, busy: null });
  await redrawRasterPreview(ctx);
}

/** Draw the picture for the current settings. A newer change wins: an answer for older settings is dropped. */
async function redrawRasterPreview(ctx: RasterContext): Promise<void> {
  const started = ctx.getState();
  const layer = pointCloudLayer(ctx, started.layerId);
  const source = ctx.tools.getSource();
  if (!started.open || !started.session || !layer || !source) return;
  const request = rasterRequestOf(layer, started.settings, ctx.getDisplayUnit());
  if (request === null) return; // the cell size text is not a number yet: keep the last picture
  ctx.setState({ ...started, busy: "rendering", error: null });
  try {
    const image = await renderPreview(source, started.session.id, request);
    const now = ctx.getState();
    if (!now.open || now.settings !== started.settings) return;
    ctx.setState({ ...now, image, busy: null, error: null });
  } catch (e) {
    const now = ctx.getState();
    if (!now.open || now.settings !== started.settings) return;
    ctx.setState({ ...now, image: null, busy: null, error: message(e) });
  }
}

/** A setting changed: store it and draw the preview again from the kept points. */
export async function changeRasterSettings(ctx: RasterContext, settings: RasterSettings): Promise<void> {
  const now = ctx.getState();
  const valueChanged = now.settings.value !== settings.value || now.settings.groundOnly !== settings.groundOnly || now.settings.cellSizeText !== settings.cellSizeText;
  ctx.setState({ ...now, settings });
  // The TIFF kind only matters for the export.
  if (valueChanged) await redrawRasterPreview(ctx);
}

/** Close the window and free the points Rust kept for it. */
export async function closeRasterWindow(ctx: RasterContext): Promise<void> {
  const state = ctx.getState();
  if (state.exported?.download) URL.revokeObjectURL(state.exported.download.url);
  ctx.setState(CLOSED_RASTER_WINDOW);
  if (state.session) await closePreview(ctx.tools.getSource(), state.session.id);
}

/**
 * Export: read every point at the chosen cell size and write the GeoTIFF the TIFF buttons say. Desktop asks where to
 * save first (so the long read is not followed by a surprise dialog), Web downloads. Progress and cancel use the
 * tool progress dialog. The colours of a colored file use the range of the preview the user looked at.
 */
export async function exportRaster(ctx: RasterContext): Promise<void> {
  const tools = ctx.tools;
  const state = ctx.getState();
  const layer = pointCloudLayer(ctx, state.layerId);
  const source = tools.getSource();
  if (!layer || layer.sourcePath === undefined || !source) return;
  const request = rasterRequestOf(layer, state.settings, ctx.getDisplayUnit());
  if (request === null) {
    tools.reportError("セルの大きさは0より大きい数にしてください", "tool");
    return;
  }
  if (tools.toolLock.running) {
    tools.reportError("別の点群ツールを実行中です。終わってからやり直してください", "tool");
    return;
  }
  const exportRequest = { ...request, tiff: state.settings.tiff, range: exportRangeOf(state.image) };
  const baseName = layer.name.replace(/(\.copc)?\.laz$/i, "");

  let destination: string | null = null;
  if (!(source instanceof WebSource)) {
    destination = await chooseGeoTiffDestination(`${baseName}-raster.tif`);
    if (destination === null) return; // the user closed the dialog
  }

  const title = `ラスタ化の書き出し（${layer.name}）`;
  tools.toolLock.running = true;
  tools.setToolProgress({ title, pointsRead: 0, totalPoints: 0 });
  try {
    const options = {
      tempDir: tools.tempDir,
      onProgress: (p: { pointsRead: number; totalPoints: number }) =>
        tools.setToolProgress({ title, pointsRead: p.pointsRead, totalPoints: p.totalPoints }),
    };
    let result: RasterExportResult;
    if (source instanceof WebSource) {
      result = await source.exportRasterGeoTiff(layer.sourcePath, exportRequest, options);
      if (result.download) startDownload(result.download.url, result.download.fileName);
    } else {
      result = await tauriExportRasterGeoTiff(layer.sourcePath, exportRequest, options);
      if (result.path && destination) await saveToolFile(result.path, destination);
    }
    for (const warning of result.warnings) tools.reportError(warning, "tool");
    const now = ctx.getState();
    if (now.exported?.download) URL.revokeObjectURL(now.exported.download.url);
    ctx.setState({ ...now, exported: result });
  } catch (e) {
    const text = message(e);
    tools.reportError(text.includes("キャンセル") ? `${title}をキャンセルしました` : text, "tool");
  } finally {
    tools.toolLock.running = false;
    tools.setToolProgress(null);
  }
}
