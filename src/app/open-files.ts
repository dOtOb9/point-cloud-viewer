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
import { initialColorModeFor, type LayerDownload, type SectionInfo, type ViewerLayer } from "../state/layers";
import { currentDeviceMeta } from "../state/device-meta";
import type { ViewerStatus } from "../state/viewer-status";

export interface ConversionAttachment {
  breakdownText: string;
  download: LayerDownload | null;
}

export interface OpenFilesContext {
  getSource: () => DataSource | null;
  getRenderer: () => PointCloudRenderer | null;
  setStatus: (status: ViewerStatus) => void;
  reportError: (message: string, source?: GpuErrorSource) => void;
  setConversionProgress: (progress: ConversionProgress | null) => void;
  setConvertingFileName: (name: string) => void;
  addLayerToList: (layer: ViewerLayer) => void;
  nextLayerId: () => string;
  tempDir: string | null;
  isMobile: boolean;
  pointShape: PointShape;
  isToolRunning: () => boolean;
  refreshOpfsStorageInfo: () => Promise<void>;
  openLock: { busy: boolean };
}

export function cancelConversion(ctx: OpenFilesContext): void {
  ctx.getSource()?.cancelConversion();
}

export async function openFiles(ctx: OpenFilesContext, items: string[] | File[]): Promise<void> {
  if (items.length === 0) return;
  const source = ctx.getSource();
  if (!ctx.getRenderer() || !source) return;

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

  if (items.length > 1) {
    const unknownNames = names.filter((n) => detectSourceFormatByName(n) === "unknown");
    if (unknownNames.length > 0) {
      failOpen(ctx, `対応していない形式のファイルが含まれています: ${unknownNames.join("、")}`);
      return;
    }
  }

  const displayName = items.length > 1 ? multiDisplayNameFor([...names].sort()) : names[0];
  ctx.setConvertingFileName(displayName);

  try {
    const outcome = await source.prepareToOpen(items, {
      tempDir: ctx.tempDir,
      isMobile: ctx.isMobile,
      onConverting: () => ctx.setStatus({ kind: "converting" }),
      onProgress: (progress) => {
        if (!ctx.isToolRunning()) ctx.setConversionProgress(progress);
      },
    });
    ctx.setConversionProgress(null);

    if (outcome.kind === "failed") {
      failOpen(ctx, outcome.summary, outcome.details);
      void ctx.refreshOpfsStorageInfo();
      return;
    }
    if (outcome.kind === "cancelled") {
      ctx.setStatus({ kind: "idle" });
      ctx.reportError("変換をキャンセルしました", "conversion");
      return;
    }

    const result = outcome.conversion;
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

export async function addOpenedLayer(
  ctx: OpenFilesContext,
  path: string,
  name: string,
  attachment: ConversionAttachment | null,
  section?: SectionInfo,
): Promise<{ layerId: string; pointCount: number; nodeCount: number }> {
  const renderer = ctx.getRenderer();
  const source = ctx.getSource();
  if (!renderer || !source) throw new Error("ビューアが初期化されていません");
  const opened = await source.open(path);
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
    ...(section ? { section } : {}),
  });
  if (opened.info.crs.error) {
    ctx.reportError(`座標系(CRS)を読み取れませんでした: ${opened.info.crs.error}`, "crs");
  }
  return { layerId, pointCount: opened.info.pointCount, nodeCount: opened.nodes.length };
}

function failOpen(ctx: OpenFilesContext, summary: string, details: string = summary): void {
  ctx.reportError(details, "conversion");
  ctx.setStatus({ kind: "error", message: summary });
}
