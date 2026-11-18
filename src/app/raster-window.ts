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

export interface RasterContext {
  tools: PointCloudToolsContext;
  getState: () => RasterWindowState;
  setState: (next: RasterWindowState) => void;
  getDisplayUnit: () => DisplayUnit;
}

export function fileCellSizeOf(layer: ViewerLayer, settings: RasterSettings, display: DisplayUnit): number | null {
  const typed = Number(settings.cellSizeText);
  if (settings.cellSizeText.trim() === "" || !Number.isFinite(typed) || typed <= 0) return null;
  const units = lengthUnitsFor(layer.info.crs, display);
  return displayLengthToFile(typed, units.horizontalToMeter, display);
}

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

export async function openRasterWindow(ctx: RasterContext, layerId: string): Promise<void> {
  const layer = pointCloudLayer(ctx, layerId);
  const source = ctx.tools.getSource();
  if (!layer || layer.sourcePath === undefined || !source) {
    ctx.tools.reportError("点群のレイヤーを選んでください", "tool");
    return;
  }
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
    await closePreview(source, session.id);
    return;
  }
  ctx.setState({ ...now, session, busy: null });
  await redrawRasterPreview(ctx);
}

async function redrawRasterPreview(ctx: RasterContext): Promise<void> {
  const started = ctx.getState();
  const layer = pointCloudLayer(ctx, started.layerId);
  const source = ctx.tools.getSource();
  if (!started.open || !started.session || !layer || !source) return;
  const request = rasterRequestOf(layer, started.settings, ctx.getDisplayUnit());
  if (request === null) return;
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

export async function changeRasterSettings(ctx: RasterContext, settings: RasterSettings): Promise<void> {
  const now = ctx.getState();
  const valueChanged = now.settings.value !== settings.value || now.settings.groundOnly !== settings.groundOnly || now.settings.cellSizeText !== settings.cellSizeText;
  ctx.setState({ ...now, settings });
  if (valueChanged) await redrawRasterPreview(ctx);
}

export async function closeRasterWindow(ctx: RasterContext): Promise<void> {
  const state = ctx.getState();
  if (state.exported?.download) URL.revokeObjectURL(state.exported.download.url);
  ctx.setState(CLOSED_RASTER_WINDOW);
  if (state.session) await closePreview(ctx.tools.getSource(), state.session.id);
}

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
    if (destination === null) return;
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
