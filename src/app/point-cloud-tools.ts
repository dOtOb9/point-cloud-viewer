import {
  extractToCopc as tauriExtractToCopc,
  mergeCopcs as tauriMergeCopcs,
  computeSectionLine as tauriComputeSectionLine,
  cancelLasConversion,
  thinCopc as tauriThinCopc,
  filterCopc as tauriFilterCopc,
  dtmCopc as tauriDtmCopc,
  chooseGeoTiffDestination,
  chooseLandXmlDestination,
  saveToolFile,
} from "../datasource/tauri";
import { WebSource } from "../datasource/web";
import type { DataSource } from "../datasource/DataSource";
import type { ExtractFilter, ToolOptions, ToolResult } from "../datasource/tools";
import type { FilterRequest, ThinRequest } from "../datasource/thin-filter";
import type { DtmFile, DtmInfo, DtmRequest } from "../datasource/dtm";
import type { ColorMode } from "../renderer/colormap";
import type { GpuErrorSource } from "../renderer/gpu-error-log";
import { horizontalBasis } from "../renderer/up-axis";
import type { SectionGroundLine } from "../datasource/section-line";
import { findLayer, isMeasureLayer, type LayersState, type SectionInfo } from "../state/layers";
import { effectiveSelectedIds, toolSourceLayers } from "../state/layer-selection";
import { sectionYaw } from "../state/tool-math";
import { lengthUnitsFor } from "../state/units";
import { sectionLineRequestFor } from "./csf-params";
import type { ViewerStatus } from "../state/viewer-status";

export interface ToolProgressState {
  title: string;
  pointsRead: number;
  totalPoints: number;
  showAsPercent?: boolean;
}

export interface PointCloudToolsContext {
  getSource: () => DataSource | null;
  getLayersState: () => LayersState;
  getViewUp: () => readonly [number, number, number];
  extraSelectedIds: string[];
  tempDir: string | null;
  isMobile: boolean;
  addOpenedLayer: (path: string, name: string, section?: SectionInfo) => Promise<{ layerId: string }>;
  setSectionLine: (layerId: string, line: SectionGroundLine) => void;
  setLayerDtm: (layerId: string, dtm: DtmInfo) => void;
  setLayerColorMode: (id: string, mode: ColorMode) => void;
  focusLayer: (id: string, orientation?: { yaw: number; pitch: number }) => void;
  setLayerVisible: (id: string, visible: boolean) => void;
  setStatus: (status: ViewerStatus) => void;
  setToolProgress: (progress: ToolProgressState | null) => void;
  reportError: (message: string, source?: GpuErrorSource) => void;
  toolLock: { running: boolean };
}

function reportToolMessage(ctx: PointCloudToolsContext, message: string): void {
  ctx.reportError(message, "tool");
}

export function hideSourceLayers(ctx: PointCloudToolsContext, sourceLayerIds: readonly string[]): void {
  for (const id of sourceLayerIds) ctx.setLayerVisible(id, false);
}

async function runTool(
  ctx: PointCloudToolsContext,
  title: string,
  resultName: string,
  sourceLayerIds: readonly string[],
  run: (source: DataSource, options: ToolOptions) => Promise<ToolResult>,
  viewNormal?: readonly [number, number, number],
  section?: SectionInfo,
  showAsPercent = false,
): Promise<string | null> {
  const source = ctx.getSource();
  if (!source) return null;
  if (ctx.toolLock.running) {
    reportToolMessage(ctx, "別の点群ツールを実行中です。終わってからやり直してください");
    return null;
  }
  ctx.toolLock.running = true;
  ctx.setToolProgress({ title, pointsRead: 0, totalPoints: 0, ...(showAsPercent ? { showAsPercent } : {}) });
  try {
    const result = await run(source, {
      tempDir: ctx.tempDir,
      onProgress: (p) =>
        ctx.setToolProgress({ title, pointsRead: p.pointsRead, totalPoints: p.totalPoints, ...(showAsPercent ? { showAsPercent } : {}) }),
    });
    for (const warning of result.warnings) reportToolMessage(ctx, warning);
    const { layerId } = await ctx.addOpenedLayer(result.outputPath, resultName, section);
    ctx.setStatus({ kind: "ready" });
    hideSourceLayers(ctx, sourceLayerIds);
    if (viewNormal) {
      const { right, forward } = horizontalBasis(ctx.getViewUp());
      ctx.focusLayer(layerId, { yaw: sectionYaw(viewNormal, right, forward), pitch: 0 });
    }
    return layerId;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportToolMessage(ctx, message.includes("キャンセル") ? `${title}をキャンセルしました` : message);
    return null;
  } finally {
    ctx.toolLock.running = false;
    ctx.setToolProgress(null);
  }
}

export async function extractFromLayer(
  ctx: PointCloudToolsContext,
  layerId: string,
  filter: ExtractFilter,
  label: "カット" | "断面",
  viewNormal?: readonly [number, number, number],
  section?: SectionInfo,
): Promise<void> {
  const layer = findLayer(ctx.getLayersState().layers, layerId);
  if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
    reportToolMessage(ctx, "点群のレイヤーを選んでください");
    return;
  }
  const path = layer.sourcePath;
  const newLayerId = await runTool(
    ctx,
    `${label}（${layer.name}）`,
    `${label} - ${layer.name}`,
    [layer.id],
    (source, options) =>
      source instanceof WebSource ? source.extractToCopc(path, filter, options) : tauriExtractToCopc(path, filter, options),
    viewNormal,
    section,
  );
  if (section && newLayerId !== null) await computeSectionLine(ctx, newLayerId, section);
}

export async function computeSectionLine(ctx: PointCloudToolsContext, sectionLayerId: string, section: SectionInfo): Promise<void> {
  const source = ctx.getSource();
  if (!source) return;
  const sourceLayer = findLayer(ctx.getLayersState().layers, section.sourceLayerId);
  if (!sourceLayer || isMeasureLayer(sourceLayer)) {
    reportToolMessage(ctx, "断面線の元になるレイヤーが見つからないため、断面線は作れませんでした");
    return;
  }
  if (ctx.toolLock.running) {
    reportToolMessage(ctx, "別の点群ツールを実行中です。終わってからやり直してください");
    return;
  }
  const title = `断面線の計算（${sourceLayer.name}）`;
  ctx.toolLock.running = true;
  ctx.setToolProgress({ title, pointsRead: 0, totalPoints: 0, showAsPercent: true });
  try {
    const line = { a: section.a, b: section.b, up: section.up };
    const { request, warning } = sectionLineRequestFor(section.linePreset, lengthUnitsFor(sourceLayer.info.crs, "meter"));
    if (warning) reportToolMessage(ctx, warning);
    const options: ToolOptions = {
      tempDir: ctx.tempDir,
      onProgress: (p) => ctx.setToolProgress({ title, pointsRead: p.pointsRead, totalPoints: p.totalPoints, showAsPercent: true }),
    };
    const result =
      source instanceof WebSource
        ? await source.computeSectionLine(sourceLayer.cloudId, line, request, options)
        : await tauriComputeSectionLine(sourceLayer.cloudId, line, request, options);
    ctx.setSectionLine(sectionLayerId, result);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    reportToolMessage(ctx, message.includes("キャンセル") ? `${title}をキャンセルしました` : message);
  } finally {
    ctx.toolLock.running = false;
    ctx.setToolProgress(null);
  }
}

export async function mergeSelectedLayers(ctx: PointCloudToolsContext): Promise<void> {
  const current = ctx.getLayersState();
  const sources = toolSourceLayers(
    current.layers,
    effectiveSelectedIds(current.layers, current.selectedLayerId, ctx.extraSelectedIds),
  );
  if (sources.length < 2) {
    reportToolMessage(ctx, "合成するには点群のレイヤーを2つ以上選んでください（Ctrl か Shift を押しながらクリック）");
    return;
  }
  const paths = sources.map((l) => l.sourcePath as string);
  await runTool(
    ctx,
    `合成（${sources.length}レイヤー）`,
    `合成 (${sources.length})`,
    sources.map((l) => l.id),
    (source, options) =>
      source instanceof WebSource ? source.mergeCopcs(paths, { ...options, isMobile: ctx.isMobile }) : tauriMergeCopcs(paths, options),
  );
}

export function cancelTool(ctx: PointCloudToolsContext): void {
  const source = ctx.getSource();
  if (source instanceof WebSource) {
    source.cancelConversion();
    return;
  }
  cancelLasConversion().catch((e: unknown) => console.error("cancelLasConversion failed", e));
}

export async function thinLayer(ctx: PointCloudToolsContext, layerId: string, request: ThinRequest): Promise<void> {
  const layer = findLayer(ctx.getLayersState().layers, layerId);
  if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
    reportToolMessage(ctx, "点群のレイヤーを選んでください");
    return;
  }
  const path = layer.sourcePath;
  await runTool(
    ctx,
    `間引き（${layer.name}）`,
    `間引き - ${layer.name}`,
    [layer.id],
    (source, options) =>
      source instanceof WebSource ? source.thinCopc(path, request, options) : tauriThinCopc(path, request, options),
  );
}

export async function filterLayer(ctx: PointCloudToolsContext, layerId: string, request: FilterRequest): Promise<void> {
  const layer = findLayer(ctx.getLayersState().layers, layerId);
  if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
    reportToolMessage(ctx, "点群のレイヤーを選んでください");
    return;
  }
  const path = layer.sourcePath;
  await runTool(
    ctx,
    `フィルタ（${layer.name}）`,
    `フィルタ - ${layer.name}`,
    [layer.id],
    (source, options) =>
      source instanceof WebSource ? source.filterCopc(path, request, options) : tauriFilterCopc(path, request, options),
  );
}

export async function makeDtm(ctx: PointCloudToolsContext, layerId: string, request: DtmRequest): Promise<void> {
  const layer = findLayer(ctx.getLayersState().layers, layerId);
  if (!layer || isMeasureLayer(layer) || layer.sourcePath === undefined) {
    reportToolMessage(ctx, "点群のレイヤーを選んでください");
    return;
  }
  const path = layer.sourcePath;
  const made: { dtm: DtmInfo | null } = { dtm: null };
  const newLayerId = await runTool(
    ctx,
    `DTM（${layer.name}）`,
    `地表 - ${layer.name}`,
    [layer.id],
    async (source, options) => {
      const result = source instanceof WebSource ? await source.dtmCopc(path, request, options) : await tauriDtmCopc(path, request, options);
      made.dtm = result.dtm;
      return result;
    },
    undefined,
    undefined,
    true,
  );
  if (newLayerId === null || made.dtm === null) return;
  ctx.setLayerDtm(newLayerId, made.dtm);
  ctx.setLayerColorMode(newLayerId, "classification");
}

export async function saveDtmFile(ctx: PointCloudToolsContext, file: DtmFile, kind: "geotiff" | "landxml"): Promise<void> {
  if (file.path === null) return;
  try {
    const destination = kind === "geotiff" ? await chooseGeoTiffDestination(file.fileName) : await chooseLandXmlDestination(file.fileName);
    if (destination === null) return;
    await saveToolFile(file.path, destination);
  } catch (e) {
    reportToolMessage(ctx, e instanceof Error ? e.message : String(e));
  }
}
